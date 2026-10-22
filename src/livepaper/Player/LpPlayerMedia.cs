using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Helpers;
using livepaper.Models;

namespace livepaper.Player;

// The media primitives PlayerHelper dispatches to under PlayerEngine=lp-player
// (.claude/rules/player-adapter.md). Everything is "the same wallpaper on every output" (out:*):
// a switch is ONE `transition` request (a cut when transitions are off); global settings go to
// `srcs:*` (on-screen sources + an in-flight transition's pending B, R61); per-item overrides go to
// the source(s) showing that item; layer settings (fit) go to `lay:*:main`.
public static class LpPlayerMedia
{
    private static LpPlayerClient? _hooked;
    private static readonly object _hookLock = new();

    private static LpPlayerClient C
    {
        get
        {
            var c = LpPlayerClient.Shared;
            lock (_hookLock)
            {
                if (!ReferenceEquals(c, _hooked)) { c.Event += OnEvent; c.Restarted += OnRestarted; _hooked = c; }
            }
            return c;
        }
    }

    // ---- the command queue: every lp-player MUTATION from PlayerHelper runs here ------------------
    // PlayerHelper calls its primitives while holding its _lock; nothing under that lock may wait on the
    // player (a stalled one would stall volume/speed/pause/tick). So switches, stop and property sets
    // are queued — one ordered worker, FIFO, off every caller's thread — and return at once. Queries stay
    // synchronous with LpPlayerClient.QuickMs (≤ 300 ms, then the stall breaker fails them fast).
    private static readonly object _qLock = new();
    private static Task _tail = Task.CompletedTask;

    public static Task<T> Queue<T>(Func<T> f)
    {
        lock (_qLock)
        {
            // never faults: a throwing command is logged and yields default, so the chain (and any await) goes on
            var t = _tail.ContinueWith(_ =>
            {
                try { return f(); }
                catch (Exception e) { LpPlayerClient.Log($"queued lp-player command threw: {e.GetBaseException().Message}"); return default!; }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            _tail = t;
            return t;
        }
    }

    public static Task Queue(Action a) => Queue<bool>(() => { a(); return true; });

    // completes when everything queued so far has run
    public static Task Drain() { lock (_qLock) return _tail; }

    public static void QueueSwitch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd) =>
        Queue(() => Switch(path, s, tcfg, alignEnd));

    public static void QueueStop() => Queue(Stop);

    // ---- transition outcomes, by corr (events + a log-poll safety net) ------------------------
    private static readonly ConcurrentDictionary<string, TaskCompletionSource<string>> _waiters = new();
    private static readonly ConcurrentDictionary<string, (string outcome, long at)> _recent = new();
    private static volatile string? _lastCorr;
    // corr of the most recent switch this process requested (the handoff gate for the next aligned one)
    public static string? LastCorr => _lastCorr;

    private static void OnEvent(string kind, JsonElement e)
    {
        var outcome = OutcomeOf(kind, e);
        if (outcome == null || !e.TryGetProperty("corr", out var c) || c.ValueKind != JsonValueKind.String) return;
        var corr = c.GetString()!;
        Interlocked.Increment(ref _eventOutcomes);
        Record(corr, outcome);
    }

    private static int _eventOutcomes;
    // terminal outcomes that arrived as subscribed events (vs the log poll) — self-test evidence
    public static int EventOutcomes => Volatile.Read(ref _eventOutcomes);

    // The player restarted: its corr counter starts over, so every recorded outcome and pending wait
    // belongs to the dead process → forget them (the waits end as failed → the caller's fallback).
    private static void OnRestarted()
    {
        LpPlayerClient.Log("lp-player restarted (new pid) — pending switch waits end as failed");
        _recent.Clear();
        _lastCorr = null;
        foreach (var (k, w) in _waiters) { _waiters.TryRemove(k, out _); w.TrySetResult("failed:player restarted"); }
    }

    private static void Record(string corr, string outcome)
    {
        long now = Environment.TickCount64;
        _recent[corr] = (outcome, now);
        if (_recent.Count > 256)
            foreach (var (k, v) in _recent) if (now - v.at > 120_000) _recent.TryRemove(k, out _);
        if (_waiters.Count > 256) // abandoned (timed-out) waits on corrs that never ended
            foreach (var (k, w) in _waiters) if (w.Task.IsCompleted) _waiters.TryRemove(k, out _);
        if (_waiters.TryRemove(corr, out var tcs)) tcs.TrySetResult(outcome);
    }

    // "handoff" | "cancelled:<reason>" | "failed:<reason>" | null (not a terminal-for-us event)
    private static string? OutcomeOf(string kind, JsonElement e) => kind switch
    {
        "transition.handoff" => "handoff",
        "transition.cancelled" => "cancelled:" + Str(e, "reason"),
        "transition.failed" => "failed:" + Str(e, "reason"),
        _ => null,
    };

    // Wait for a transition's terminal outcome. "caller-cancelled" when ct fires, "timeout" after
    // timeoutMs (< 0 = no limit). Every 2 s it also asks the player's log for that corr, so a missed
    // event (reconnect gap) can't hang a wait; a player restart (new pid) ends it as failed.
    public static async Task<string> WaitCorr(string corr, CancellationToken ct, int timeoutMs)
    {
        if (_recent.TryGetValue(corr, out var r)) return r.outcome;
        // several waiters on one corr (e.g. WaitLastHandoff + its SwitchAndWait) share one TCS;
        // Record removes it when the outcome lands
        var tcs = _waiters.GetOrAdd(corr, _ => new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously));
        if (_recent.TryGetValue(corr, out r)) { Record(corr, r.outcome); return r.outcome; }
        var client = C;
        int gen0 = client.Generation;
        var sw = Stopwatch.StartNew();
        while (true)
        {
            var done = await Task.WhenAny(tcs.Task, Task.Delay(2000, ct)).ConfigureAwait(false);
            if (done == tcs.Task) return await tcs.Task.ConfigureAwait(false);
            if (ct.IsCancellationRequested) return "caller-cancelled";
            if (timeoutMs >= 0 && sw.ElapsedMilliseconds >= timeoutMs) return "timeout";
            var polled = await Task.Run(() => Poll(client, corr, gen0)).ConfigureAwait(false);
            if (polled != null) { Record(corr, polled); return polled; }
        }
    }

    private static string? Poll(LpPlayerClient client, string corr, int gen0)
    {
        try
        {
            var logs = client.Call("logs", new Dictionary<string, object?> { ["corr"] = corr, ["kind_prefix"] = "transition." });
            if (client.Generation != gen0) return "failed:player restarted";
            foreach (var ev in logs.GetProperty("events").EnumerateArray())
                if (OutcomeOf(Str(ev, "kind"), ev) is { } o) return o;
            return null;
        }
        catch (LpPlayerException e) when (e.Code == "io") { return client.SocketExists ? null : "failed:player gone"; }
        catch (LpPlayerException) { return null; }
    }

    // ---- switches --------------------------------------------------------------------------------
    private static readonly string[] ImageExt = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".avif", ".jxl", ".tif", ".tiff"];

    // B's create props: everything the legacy launch/loadfile carried, as live properties.
    public static Dictionary<string, object?> SourceProps(string path, AppSettings s)
    {
        var props = new Dictionary<string, object?>
        {
            ["path"] = path,
            ["kind"] = ImageExt.Contains(Path.GetExtension(path).ToLowerInvariant()) ? "image" : "video",
            ["loop"] = s.Loop,
            ["speed"] = Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? s.Speed, 0.1, 4.0),
            ["gain.user"] = MpvPropertyMap.VolumeDb(LibraryService.ReadVolumeOverride(path) ?? s.Volume),
            ["gain.mute"] = PlayerHelper.IsMuted ? MpvPropertyMap.SilentDb : 0.0,
            ["no_audio"] = s.NoAudio,
            ["hwdec"] = HwDec(s),
            ["fps_cap"] = (double)Math.Max(0, s.VideoFps),
            ["cache"] = !s.DisableCache,
            ["demuxer_max_mib"] = (double)Math.Max(0, s.DemuxerMaxBytes),
            ["demuxer_back_mib"] = (double)Math.Max(0, s.DemuxerMaxBackBytes),
            ["af"] = NormalizeAf(path, s) ?? "",
        };
        return props;
    }

    private static string HwDec(AppSettings s) => string.IsNullOrWhiteSpace(s.HwDec) ? "no" : s.HwDec.Trim();

    // Loudness normalization for `path` under `s` (mirrors PlayerHelper.NormalizeAf): unmeasured →
    // no filter now + a background measure for next time.
    public static string? NormalizeAf(string path, AppSettings s)
    {
        if (!s.NormalizeAudio || s.NoAudio || PlayerHelper.IsScenePath(path)) return null;
        var af = LibraryService.LoudnormAf(path, s.NormalizeTargetLufs);
        if (af == null) _ = LibraryService.EnsureLoudnessAsync(path);
        return af;
    }

    // `transition {outputs:"out:*", to:{path, props}, effect from Pick(tcfg) or null (cut), method, align}`.
    // Returns the corr (or null when the player can't be reached / refused — logged with its hint).
    public static string? Switch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)
    {
        var client = C;
        if (!client.EnsureRunning()) return null;
        client.StartEvents();
        // VideoScale is a layer property; (re)assert it so a hotplugged output or an engine switch matches
        client.TryCall("set", new Dictionary<string, object?> { ["path"] = "lay:*:main.fit", ["value"] = Fit(s) });
        var req = new Dictionary<string, object?>
        {
            ["outputs"] = "out:*",
            ["to"] = SourceProps(path, s),
            ["align"] = alignEnd ? "end" : "now",
        };
        var pick = tcfg is { Enabled: true } ? TransitionService.Pick(tcfg) : null;
        if (pick is { } p)
        {
            req["effect_id"] = p.effectId;
            req["params"] = p.uniforms;
            req["duration_ms"] = p.durationMs;
            req["method"] = p.method;
        }
        else req["effect_id"] = null; // cut: 30 ms ramp A down, swap, 30 ms ramp B up
        try { return Requested(client.Call("transition", req)); }
        catch (LpPlayerException e) when (e.Code == "no_such_effect" && pick != null)
        {
            LpPlayerClient.Log($"effect {pick.Value.effectId} not in lp-player's catalogue ({e.Hint}) → cut");
            req["effect_id"] = null;
            req.Remove("params"); req.Remove("duration_ms"); req.Remove("method");
            try { return Requested(client.Call("transition", req)); }
            catch (LpPlayerException e2) { LpPlayerClient.Log($"transition to {Path.GetFileName(path)} failed — {e2}"); return null; }
        }
        catch (LpPlayerException e) { LpPlayerClient.Log($"transition to {Path.GetFileName(path)} failed — {e}"); return null; }
    }

    private static string? Requested(JsonElement res)
    {
        var corr = Str(res, "corr");
        if (corr.Length == 0) return null;
        _lastCorr = corr;
        return corr;
    }

    private static string Fit(AppSettings s) =>
        string.Equals(s.VideoScale, "fit", StringComparison.OrdinalIgnoreCase) ? "fit" : "fill";

    // Switch, then wait for ITS outcome: "handoff" | "cancelled:<why>" | "failed:<why>" | "unreachable"
    // | "caller-cancelled" (ct fired → `cancel {corr}` sent; an `unsupported` reply = it had already
    // handed off). align:end waits as long as A plays.
    public static async Task<string> SwitchAndWait(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd, CancellationToken ct)
    {
        var client = C;
        if (!await Task.Run(client.EnsureRunning).ConfigureAwait(false)) return "unreachable";
        client.StartEvents();
        client.WaitSubscribed(2000); // so the handoff event can't slip past before we listen (the poll covers it anyway)
        if (ct.IsCancellationRequested) return "caller-cancelled";
        var corr = await Queue(() => Switch(path, s, tcfg, alignEnd)).ConfigureAwait(false); // ordered with queued stop/sets
        if (corr == null) return "failed:request refused";
        var outcome = await WaitCorr(corr, ct, alignEnd ? -1 : 60_000).ConfigureAwait(false);
        if (outcome == "caller-cancelled")
        {
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LpPlayerException e) when (e.Code is "no_such_node" or "unsupported") { } // superseded / already handed off
            catch (LpPlayerException e) { LpPlayerClient.Log($"cancel {corr} failed — {e}"); }
        }
        return outcome;
    }

    // Completes on `transition.handoff` of this switch; false on cancel / failure.
    public static async Task<bool> SwitchAndWaitHandoff(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd, CancellationToken ct) =>
        await SwitchAndWait(path, s, tcfg, alignEnd, ct).ConfigureAwait(false) == "handoff";

    // The handoff gate (replaces the legacy `_lastSwitchTarget` settle gate): before an aligned switch
    // is requested, the previous one must have handed off — a new request would SUPERSEDE a pre-Running
    // one (its B would never show).
    public static async Task WaitLastHandoff(CancellationToken ct)
    {
        try { await Drain().WaitAsync(ct).ConfigureAwait(false); } // a still-queued switch counts
        catch (OperationCanceledException) { return; }
        var corr = _lastCorr;
        if (corr == null || !C.SocketExists) return;
        await WaitCorr(corr, ct, 30_000).ConfigureAwait(false);
    }

    public static void Stop()
    {
        var client = C;
        if (client.SocketExists) client.TryCall("stop", null);
    }

    // Switching AWAY from lp-player (synchronous, call it OUTSIDE PlayerHelper's _lock): whatever is
    // queued runs (bounded), playback stops, the process is gone (quit → SIGTERM → SIGKILL) — so the
    // other engine never starts while lp-player still shows something.
    public static void StopAndQuit()
    {
        var client = C;
        try { Drain().Wait(3000); } catch { }
        if (client.SocketExists) { try { client.Call("stop", null, LpPlayerClient.QuickMs); } catch (LpPlayerException) { } }
        client.QuitOrKill();
        _lastCorr = null;
    }

    // ---- properties --------------------------------------------------------------------------------
    // A global setting → `srcs:*` (layer props → `lay:*:main`; mute ramps over 30 ms, never a step).
    // gain.user / speed: `/settings` passes the effective value (override ?? global) of the PLAYING item;
    // any other source in srcs:* (an in-flight transition's other side) then gets ITS own effective value.
    public static List<string> Set(string prop, object value)
    {
        var client = C;
        if (!client.SocketExists) return []; // nothing plays → nothing to set (sources take settings at creation)
        try
        {
            if (prop is "fit" or "viewport" or "opacity")
                return Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = $"lay:*:main.{prop}", ["value"] = value }));
            if (prop.StartsWith("gain.", StringComparison.Ordinal) && prop != "gain.user")
            {
                try
                {
                    return Targets(client.Call("animate", new Dictionary<string, object?>
                    { ["path"] = $"srcs:*.{prop}", ["to"] = value, ["duration_ms"] = 30 }));
                }
                catch (LpPlayerException e) when (e.Code == "no_such_node") { return []; } // no source right now
            }
            var t = Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = $"srcs:*.{prop}", ["value"] = value }));
            if (prop is "gain.user" or "speed" && t.Count > 0) FixupPerItem(client, prop, t);
            return t;
        }
        catch (LpPlayerException e) { LpPlayerClient.Log($"set {prop}={value} failed — {e}"); return []; }
    }

    private static void FixupPerItem(LpPlayerClient client, string prop, List<string> targets)
    {
        var cur = CurrentPath();
        if (targets.Count == 1 && cur != null) return; // the only source is the one on screen → already right
        var graph = Graph(client);
        if (graph is not { } g) return;
        var s = SettingsService.Load();
        foreach (var id in targets)
        {
            if (!g.TryGetProperty(id, out var node)) continue;
            var path = Str(node, "path");
            if (path.Length == 0 || SamePath(path, cur)) continue;
            object v = prop == "gain.user"
                ? MpvPropertyMap.VolumeDb(LibraryService.ReadVolumeOverride(path) ?? s.Volume)
                : Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? s.Speed, 0.1, 4.0);
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = v });
        }
    }

    // A per-item value → the source(s) showing that item (found by path in `state`; may be a pending B).
    public static List<string> SetForPath(string path, string prop, object value)
    {
        var client = C;
        var ids = SourcesFor(client, path);
        foreach (var id in ids)
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = value });
        return ids;
    }

    // ApplyOverrideLive: re-apply `path`'s effective volume/speed to its source(s). Returns the speed
    // when `path` is what's on screen (the timed tick's speed factor), else null.
    public static double? ApplyOverride(string path)
    {
        var s = SettingsService.Load();
        double spd = Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? s.Speed, 0.1, 4.0);
        var ids = SetForPath(path, "gain.user", MpvPropertyMap.VolumeDb(LibraryService.ReadVolumeOverride(path) ?? s.Volume));
        if (ids.Count == 0) return null;
        SetForPath(path, "speed", spd);
        return SamePath(CurrentPath(), path) ? spd : null;
    }

    // /preview (drag twin, no persist): the playing item's source(s), literal values.
    public static void Preview(int? volume, double? speed) => Queue(() => PreviewNow(volume, speed));

    private static void PreviewNow(int? volume, double? speed)
    {
        var cur = CurrentPath();
        if (cur == null) return;
        if (volume is int v) SetForPath(cur, "gain.user", MpvPropertyMap.VolumeDb(v));
        if (speed is double sp) SetForPath(cur, "speed", Math.Clamp(sp, 0.1, 4.0));
    }

    // ApplyPlaybackSettingsLive's lp-player twin: every changed decode/buffer/audio setting, live.
    // Loop keeps the legacy guard (single, non-timed video only): during rotation the recipe owns A's
    // loop (align:end turns it off until the switch) and new sources take settings.Loop at creation.
    public static void ApplySettingsLive(AppSettings prev, AppSettings cur, bool loopAllowed) =>
        Queue(() => ApplySettingsNow(prev, cur, loopAllowed));

    private static void ApplySettingsNow(AppSettings prev, AppSettings cur, bool loopAllowed)
    {
        if (prev.NoAudio != cur.NoAudio) Set("no_audio", cur.NoAudio);
        if (loopAllowed && prev.Loop != cur.Loop) Set("loop", cur.Loop);
        if (prev.VideoFps != cur.VideoFps) Set("fps_cap", (double)Math.Max(0, cur.VideoFps));
        if (prev.DisableCache != cur.DisableCache) Set("cache", !cur.DisableCache);
        if (prev.DemuxerMaxBytes != cur.DemuxerMaxBytes) Set("demuxer_max_mib", (double)Math.Max(0, cur.DemuxerMaxBytes));
        if (prev.DemuxerMaxBackBytes != cur.DemuxerMaxBackBytes) Set("demuxer_back_mib", (double)Math.Max(0, cur.DemuxerMaxBackBytes));
        if (prev.HwDec != cur.HwDec) Set("hwdec", HwDec(cur));
    }

    // The mpv IPC args PlayerHelper.SendCommand/TrySendCommand still build. Property sets go through
    // MpvPropertyMap; `cycle pause` toggles; mpv-playlist plumbing (loadfile/playlist-*/loop-file/
    // loop-playlist) has no lp-player meaning — livepaper's timed machinery owns rotation and the
    // transition recipe owns A's loop — so it's acknowledged and dropped.
    public static bool Mpv(object[] args)
    {
        if (args.Length == 0) return false;
        var cmd = args[0] as string ?? args[0]?.ToString() ?? "";
        var name = args.Length > 1 ? args[1] as string ?? args[1]?.ToString() ?? "" : "";
        switch (cmd)
        {
            case "cycle" when name == "pause": Queue(() => TogglePause()); return true;
            case "loadfile" or "playlist-clear" or "playlist-next" or "playlist-prev" or "playlist-shuffle" or "playlist-unshuffle":
                return true;
            case "set" or "set_property" when name is "loop-file" or "loop-playlist":
                return true;
        }
        if (MpvPropertyMap.Translate(args) is not { } t) return false;
        Queue(() => Set(t.prop, t.value)); // ordered, never on the caller's thread (it may hold PlayerHelper's _lock)
        return true;
    }

    // Interim pause (controller ruling R75a): the direction comes from what's on screen (`cur:*.paused`),
    // the write goes to `srcs:*.paused`, so an in-flight transition's pending B is paused too.
    // TODO(lp-player: player-level pause): replace with a player-level `player.paused` that the Rust
    // recipe + SourceHost honour (freezing transitions as well) — a separate Rust task the controller
    // schedules after Task 17; then this becomes a single `set player.paused`.
    public static bool TogglePause()
    {
        if (GetCur("paused") is not JsonElement { ValueKind: JsonValueKind.True or JsonValueKind.False } p) return false;
        bool now = p.ValueKind != JsonValueKind.True;
        return C.TryCall("set", new Dictionary<string, object?> { ["path"] = "srcs:*.paused", ["value"] = now }) != null;
    }

    // ---- queries -----------------------------------------------------------------------------------
    public static bool IsPlaying() => CurrentPath() != null;

    public static string? CurrentPath() =>
        GetCur("path") is JsonElement { ValueKind: JsonValueKind.String } v && v.GetString() is { Length: > 0 } s ? s : null;

    public static double? Query(string prop) =>
        GetCur(prop) is JsonElement { ValueKind: JsonValueKind.Number } v ? v.GetDouble() : null;

    // mpv property names the legacy queries use → lp-player
    public static double? QueryMpv(string mpvProp) => mpvProp switch
    {
        "time-pos" => Query("time_pos"),
        "duration" => Query("duration"),
        "speed" => Query("speed"),
        "playtime-remaining" => TimeRemaining(),
        _ => null,
    };

    // wall-clock seconds left (mpv playtime-remaining = remaining / speed)
    public static double? TimeRemaining()
    {
        if (Query("duration") is not double d || d <= 0 || Query("time_pos") is not double t) return null;
        double sp = Query("speed") ?? 1.0;
        return Math.Max(0, d - t) / Math.Max(0.01, sp);
    }

    // `get cur:*.<prop>` (deduplicated across outputs); with different sources per output → the first
    // output's. Never spawns; null when nothing is on screen / no player.
    private static JsonElement? GetCur(string prop)
    {
        var client = C;
        if (!client.SocketExists) return null;
        const int q = LpPlayerClient.QuickMs;
        try { return client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:*.{prop}" }, q).GetProperty("value"); }
        catch (LpPlayerException e) when (e.Code == "ambiguous")
        {
            try
            {
                var st = client.Call("state", null, q);
                var first = st.GetProperty("outputs").EnumerateArray().Select(o => Str(o, "name")).FirstOrDefault(n => n.Length > 0);
                if (first == null) return null;
                return client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:{first}.{prop}" }, q).GetProperty("value");
            }
            catch (LpPlayerException) { return null; }
        }
        catch (LpPlayerException) { return null; } // no_such_node = nothing shown; io = no player
    }

    private static JsonElement? Graph(LpPlayerClient client)
    {
        if (!client.SocketExists) return null;
        try { return client.Call("state", null).GetProperty("graph"); }
        catch (LpPlayerException e) { LpPlayerClient.Log($"state failed — {e}"); return null; }
    }

    // live media sources (not snapshots) whose path is `path`
    private static List<string> SourcesFor(LpPlayerClient client, string path)
    {
        var ids = new List<string>();
        if (Graph(client) is not { } g || g.ValueKind != JsonValueKind.Object) return ids;
        foreach (var n in g.EnumerateObject())
        {
            var v = n.Value;
            if (!v.TryGetProperty("gain_effective_db", out _) || Str(v, "kind") is "snapshot" or "color") continue; // sources only
            if (SamePath(Str(v, "path"), path)) ids.Add(n.Name);
        }
        return ids;
    }

    private static bool SamePath(string? a, string? b)
    {
        if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
        try { return Path.GetFullPath(a) == Path.GetFullPath(b); } catch { return a == b; }
    }

    private static List<string> Targets(JsonElement res) =>
        res.ValueKind == JsonValueKind.Object && res.TryGetProperty("targets", out var t) && t.ValueKind == JsonValueKind.Array
            ? t.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
            : [];

    private static string Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    // ---- auto-mute ownership (R69) ----------------------------------------------------------------
    // A `pactl list sink-inputs` block belongs to lp-player when its process is the player (pid from
    // `hello`), its node is the bus (`lp-player-bus*`), it targets the `lp-player-bus` sink, or its
    // application.name is `lp-player` (the player's own mpv streams carry that too).
    public static bool IsOwnStream(string block, int? playerPid, string? busSinkIndex)
    {
        foreach (var raw in block.Split('\n'))
        {
            var t = raw.Trim();
            if (playerPid is int pid && Quoted(t, "application.process.id") == pid.ToString()) return true;
            if (Quoted(t, "node.name") is { } node && node.StartsWith("lp-player-bus", StringComparison.Ordinal)) return true;
            if (Quoted(t, "target.object") == "lp-player-bus") return true;
            if (Quoted(t, "application.name") == "lp-player") return true;
            if (busSinkIndex != null && t.StartsWith("Sink: ", StringComparison.Ordinal) && t[6..].Trim() == busSinkIndex) return true;
        }
        return false;
    }

    private static string? Quoted(string line, string key)
    {
        var prefix = key + " = \"";
        return line.StartsWith(prefix, StringComparison.Ordinal) ? line[prefix.Length..].TrimEnd('"') : null;
    }

    // (player pid, index of the `lp-player-bus` sink) for IsOwnStream — both optional.
    public static Func<string, bool> OwnStreamFilter()
    {
        var client = C;
        int? pid = client.PlayerPid;
        if (pid == null && client.SocketExists) { client.TryCall("hello", null, LpPlayerClient.QuickMs); pid = client.PlayerPid; }
        string? bus = null;
        try
        {
            var psi = new ProcessStartInfo("pactl") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            psi.ArgumentList.Add("list"); psi.ArgumentList.Add("short"); psi.ArgumentList.Add("sinks");
            using var p = Process.Start(psi);
            if (p != null)
            {
                var o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(2000);
                foreach (var line in o.Split('\n'))
                {
                    var cols = line.Split('\t');
                    if (cols.Length > 1 && cols[1].Trim() == "lp-player-bus") { bus = cols[0].Trim(); break; }
                }
            }
        }
        catch { }
        return block => IsOwnStream(block, pid, bus);
    }
}
