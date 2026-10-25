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
                if (!ReferenceEquals(c, _hooked))
                {
                    c.Event += OnEvent;
                    c.Restarted += OnRestarted;
                    c.Recovered += OnRecovered;
                    _hooked = c;
                }
            }
            return c;
        }
    }

    // ---- the command queue: every lp-player MUTATION from PlayerHelper runs here ------------------
    // PlayerHelper calls its primitives while holding its _lock; nothing under that lock may wait on the
    // player (a stalled one would stall volume/speed/pause/tick). So switches, stop and property sets
    // are queued — one ordered worker, FIFO, off every caller's thread — and return at once. Queries stay
    // synchronous with LpPlayerClient.QuickMs (≤ 300 ms, then the stall breaker fails them fast). Every
    // queued command's OWN player.Call also uses QuickMs (item 6) — a queued set is a single property
    // write, not worth 2000 ms; keeping it quick means a backlog (a stalled player) drains fast instead
    // of each item eating the full default timeout one after another.
    private static readonly object _qLock = new();
    private static Task _tail = Task.CompletedTask;

    // item 6: a hard cap on how many commands may be in flight (queued + currently running) at once. A
    // stalled/overloaded player must never turn into unbounded memory growth here — once at the cap, a
    // NEW property set is logged and dropped outright (switch/stop are exempt — QueueEssential) (never enqueued, so the caller is never blocked and the
    // chain never grows past this). Simpler and safer than hunting the chain for "the oldest SET to the
    // same target" to evict instead; documented here and in player-adapter.md.
    public const int MaxQueueDepth = 256;
    private static int _queueDepth;
    public static int QueueDepth => Volatile.Read(ref _queueDepth);

    public static Task<T> Queue<T>(Func<T> f) => Enqueue(f, essential: false);

    // A switch or a stop is user intent, not a coalescible property write: it is never dropped at the
    // cap (it still counts toward the depth, so a flood of sets can't grow without bound behind it).
    public static Task QueueEssential(Action a) => Enqueue<bool>(() => { a(); return true; }, essential: true);

    private static Task<T> Enqueue<T>(Func<T> f, bool essential)
    {
        lock (_qLock)
        {
            if (!essential && Volatile.Read(ref _queueDepth) >= MaxQueueDepth)
            {
                LpPlayerClient.Log($"lp-player command queue at its cap ({MaxQueueDepth}, a stalled/overloaded player) — dropping a queued command");
                return Task.FromResult(default(T)!);
            }
            Interlocked.Increment(ref _queueDepth);
            // never faults: a throwing command is logged and yields default, so the chain (and any await) goes on
            var t = _tail.ContinueWith(_ =>
            {
                try { return f(); }
                catch (Exception e) { LpPlayerClient.Log($"queued lp-player command threw: {e.GetBaseException().Message}"); return default!; }
                finally { Interlocked.Decrement(ref _queueDepth); }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            _tail = t;
            return t;
        }
    }

    public static Task Queue(Action a) => Queue<bool>(() => { a(); return true; });

    // completes when everything queued so far has run
    public static Task Drain() { lock (_qLock) return _tail; }

    public static void QueueSwitch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd) =>
        QueueEssential(() => Switch(path, s, tcfg, alignEnd));

    public static void QueueStop() => QueueEssential(Stop);

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
    // R81: the new process's graph starts from its own snapshot (which may be stale — a save that
    // hadn't caught up before the crash — or, from the 4th restart in a 60 s window, not restored at
    // all, player-core.md § Supervisor "Budget") — never from what the backend's MODEL says should be
    // showing. Re-apply every current effective setting through the ordered queue so neither gap can
    // leave a stale value on screen. Fire-and-forget: this runs ON the client's event-reading callback
    // (inside LpPlayerClient.Call's lock for the request-connection case), so it must never block —
    // Queue(...) returns at once; ReapplyAllNow runs later, on the thread pool.
    private static void OnRestarted()
    {
        LpPlayerClient.Log("lp-player restarted (new pid) — pending switch waits end as failed");
        _recent.Clear();
        _lastCorr = null;
        foreach (var (k, w) in _waiters) { _waiters.TryRemove(k, out _); w.TrySetResult("failed:player restarted"); }
        ReapplyAll();
    }

    // R81, the other half: a mutation made while the stall breaker was open is dropped, not queued
    // (LpPlayerClient.QuickMs + the breaker — see the "Threading" section of player-adapter.md) and
    // never replayed on its own. The breaker closing (the player answered again) is exactly the moment
    // to catch up — same fire-and-forget Queue, same reasoning as OnRestarted above.
    private static void OnRecovered()
    {
        LpPlayerClient.Log("lp-player answered again after a stall — re-applying settings (R81)");
        ReapplyAll();
    }

    private static int _reapplyCount;
    // how many times ReapplyAllNow has actually run — self-test/IT evidence that R81 fired.
    public static int ReapplyCount => Volatile.Read(ref _reapplyCount);

    // R81: push every current effective setting onto the live graph — globals (→ srcs:*, with the
    // playing item's own override/global split the same way a live /settings change gets it), the
    // layer fit, and the player-level pause flag — through the SAME ordered queue as every other
    // mutation (so this can never race or reorder against a concurrent switch/set).
    public static void ReapplyAll() => Queue(ReapplyAllNow);

    private static void ReapplyAllNow()
    {
        var client = C;
        if (!client.SocketExists) return;
        Interlocked.Increment(ref _reapplyCount);
        var s = SettingsService.Load();
        var cur = CurrentPath();
        double vol = cur != null ? LibraryService.ReadVolumeOverride(cur) ?? s.Volume : s.Volume;
        double spd = cur != null ? LibraryService.ReadSpeedOverride(cur) ?? s.Speed : s.Speed;
        // Set() already fixes up any OTHER source (a pending B) to ITS own effective value for
        // gain.user/speed — same as a live /settings change (R61).
        Set("gain.user", MpvPropertyMap.VolumeDb(vol));
        Set("speed", Math.Clamp(spd, 0.1, 4.0));
        Set("no_audio", s.NoAudio);
        Set("hwdec", HwDec(s));
        Set("fps_cap", (double)Math.Max(0, s.VideoFps));
        Set("cache", !s.DisableCache);
        Set("demuxer_max_mib", (double)Math.Max(0, s.DemuxerMaxBytes));
        Set("demuxer_back_mib", (double)Math.Max(0, s.DemuxerMaxBackBytes));
        Set("gain.mute", PlayerHelper.IsMuted ? MpvPropertyMap.SilentDb : 0.0);
        Set("fit", Fit(s));
        if (cur != null) SetForPath(cur, "af", NormalizeAf(cur, s) ?? "");
        // I3 (final review): pause is NOT re-asserted. Its one authority is the player itself
        // (`player.paused`, persisted in its snapshot and restored with it): a keybind toggle runs
        // in a separate one-shot CLI process, and a restarted backend has no memory of it, so any
        // copy kept here goes stale and flipped the pause on its own after a crash/stall.
        bool? paused = null;
        try { paused = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LpPlayerClient.QuickMs).GetProperty("value").ValueKind == JsonValueKind.True; }
        catch (LpPlayerException) { }
        LpPlayerClient.Log("lp-player: re-applied effective settings" + (cur != null ? $" for {Path.GetFileName(cur)}" : " (nothing playing)")
            + $" (player.paused = {(paused is bool b ? b.ToString().ToLowerInvariant() : "?")}, kept)");
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
        // VideoScale is a layer property; (re)assert it so a hotplugged output or an engine switch
        // matches. item 6: QuickMs — a plain property set, not worth the 2000 ms default.
        client.TryCall("set", new Dictionary<string, object?> { ["path"] = "lay:*:main.fit", ["value"] = Fit(s) }, LpPlayerClient.QuickMs);
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
        // M2 (final review): an aligned wait is bounded too — A's remaining play time + slack (the
        // player's own fallback, `transition.align_fallback`, fires 10 s after A's end; ours is a
        // backstop behind it), re-derived each time it runs out (`AlignedWaitCheck`: A's speed may
        // have changed, the player may be paused). While no output exists (R60 parked) the player
        // holds an aligned switch until one shows it (I4) — then the backstop keeps waiting too.
        var remaining = alignEnd ? await Task.Run(TimeRemaining).ConfigureAwait(false) : null;
        double? lastPos = alignEnd ? await Task.Run(() => Query("time_pos")).ConfigureAwait(false) : null; // A when armed
        var corr = await Queue(() => Switch(path, s, tcfg, alignEnd)).ConfigureAwait(false); // ordered with queued stop/sets
        if (corr == null) return "failed:request refused";
        int bound = alignEnd ? BackstopMs(remaining) : 60_000;
        string outcome;
        while (true)
        {
            outcome = await WaitCorr(corr, ct, bound).ConfigureAwait(false);
            if (outcome != "timeout" || !alignEnd) break;
            // The bound is A's remaining time when the switch was armed — but A's end moves with
            // its CURRENT speed and stands still while the player is paused (the player re-derives
            // its own align deadline for both). Give up only when A stopped moving (a stall).
            var (keepWaiting, next, pos) = await Task.Run(() => AlignedWaitCheck(client, lastPos)).ConfigureAwait(false);
            if (!keepWaiting) break;
            bound = next; lastPos = pos;
        }
        if (outcome == "timeout")
        {
            LpPlayerClient.Log($"aligned switch {corr} not handed off within {bound} ms — cancelling it (the caller switches now)");
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LpPlayerException) { } // already handed off / superseded meanwhile
        }
        if (outcome == "caller-cancelled")
        {
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LpPlayerException e) when (e.Code is "no_such_node" or "unsupported") { } // superseded / already handed off
            catch (LpPlayerException e) { LpPlayerClient.Log($"cancel {corr} failed — {e}"); }
        }
        return outcome;
    }

    // Seconds past A's remaining play time an aligned switch is waited for (M2) — behind the
    // player's own 10 s `align_fallback`, so the player normally resolves it first.
    // LP_TEST_ALIGN_BACKSTOP_SLACK_SEC shortens it for scripts/test-lp-player-adapter.sh only.
    public static readonly double AlignBackstopSlackSec =
        double.TryParse(Environment.GetEnvironmentVariable("LP_TEST_ALIGN_BACKSTOP_SLACK_SEC"),
            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var slack) && slack > 0
            ? slack : 15;

    private static int BackstopMs(double? remainingSec) =>
        (int)Math.Min(int.MaxValue - 1, ((remainingSec ?? 0) + AlignBackstopSlackSec) * 1000);

    // An aligned switch's backstop expired: may it keep waiting, and how long until the next check?
    // No output (I4: the player holds the switch until one shows it) or the player paused (its clock
    // and the switch stand still) → yes. Otherwise only while A (what `cur:*` shows) still plays on,
    // for its remaining time at its current speed + slack; A not moving since the last check (a
    // stall), or no answer → give up (cancel, the caller switches now).
    private static (bool wait, int boundMs, double? pos) AlignedWaitCheck(LpPlayerClient client, double? lastPos)
    {
        if (!HasOutputs(client)) return (true, BackstopMs(0), lastPos);
        try
        {
            if (client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LpPlayerClient.QuickMs)
                    .GetProperty("value").ValueKind == JsonValueKind.True)
                return (true, BackstopMs(0), lastPos);
        }
        catch (LpPlayerException) { return (false, 0, lastPos); }
        if (Query("time_pos") is not double pos || TimeRemaining() is not double rem) return (false, 0, lastPos);
        if (lastPos is double lp && Math.Abs(pos - lp) < 1e-3) return (false, 0, pos);
        return (true, BackstopMs(rem), pos);
    }

    // Whether the player has any output (false = R60 parked: monitors off / unplugged).
    private static bool HasOutputs(LpPlayerClient client)
    {
        try
        {
            var st = client.Call("state", null, LpPlayerClient.QuickMs);
            return st.TryGetProperty("outputs", out var o) && o.ValueKind == JsonValueKind.Array && o.GetArrayLength() > 0;
        }
        catch (LpPlayerException) { return true; } // unknown → treat as shown (don't wait forever)
    }

    // I4 (final review): consecutive switches that didn't hand off (refused / failed / timed out)
    // back off 1 s, 2 s, 4 s … ≤ 30 s before the playlist advances — a player refusing for any
    // reason can never make rotation (and OnWallpaperChanged) spin. A handoff resets it.
    private static int _failStreak;
    public static int FailStreak => Volatile.Read(ref _failStreak);
    public static TimeSpan NextFailureBackoff()
    {
        int n = Interlocked.Increment(ref _failStreak);
        return TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, Math.Min(n - 1, 5))));
    }
    public static void ResetFailureBackoff() => Interlocked.Exchange(ref _failStreak, 0);

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
        if (client.SocketExists) client.TryCall("stop", null, LpPlayerClient.QuickMs); // item 6
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
    // item 6: every call here uses QuickMs — a queued property set, never the 2000 ms default.
    public static List<string> Set(string prop, object value)
    {
        var client = C;
        if (!client.SocketExists) return []; // nothing plays → nothing to set (sources take settings at creation)
        const int q = LpPlayerClient.QuickMs;
        try
        {
            if (prop is "fit" or "viewport" or "opacity")
                return Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = $"lay:*:main.{prop}", ["value"] = value }, q));
            // M7: mpv `pause` → the player-level pause (R75), never a node's own `paused`
            if (prop == "player.paused")
                return Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = value }, q));
            if (prop.StartsWith("gain.", StringComparison.Ordinal) && prop != "gain.user")
            {
                try
                {
                    return Targets(client.Call("animate", new Dictionary<string, object?>
                    { ["path"] = $"srcs:*.{prop}", ["to"] = value, ["duration_ms"] = 30 }, q));
                }
                catch (LpPlayerException e) when (e.Code == "no_such_node") { return []; } // no source right now
            }
            var t = Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = $"srcs:*.{prop}", ["value"] = value }, q));
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
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = v }, LpPlayerClient.QuickMs);
        }
    }

    // A per-item value → the source(s) showing that item (found by path in `state`; may be a pending B).
    public static List<string> SetForPath(string path, string prop, object value)
    {
        var client = C;
        var ids = SourcesFor(client, path);
        foreach (var id in ids)
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = value }, LpPlayerClient.QuickMs);
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

    // /preview (drag twin, no persist), literal values → the source(s) of `paths` — the item(s) the modal
    // edits, wherever they are: on screen, the outgoing A or incoming B of an effect, a pending B. No
    // paths → the playing item (`cur:*`, which mid-transition is the incoming side: a drag on A used to
    // land on B there and stay, since the persist that follows targets A by path).
    public static void Preview(int? volume, double? speed, IReadOnlyCollection<string>? paths = null) =>
        Queue(() => PreviewNow(volume, speed, paths));

    private static void PreviewNow(int? volume, double? speed, IReadOnlyCollection<string>? paths)
    {
        if (paths is not { Count: > 0 })
            paths = CurrentPath() is string cur ? [cur] : [];
        if (paths.Count == 0) return;
        var client = C;
        var ids = SourcesFor(client, paths);
        foreach (var id in ids)
        {
            if (volume is int v) client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.gain.user", ["value"] = MpvPropertyMap.VolumeDb(v) }, LpPlayerClient.QuickMs);
            if (speed is double sp) client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"{id}.speed", ["value"] = Math.Clamp(sp, 0.1, 4.0) }, LpPlayerClient.QuickMs);
        }
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

    // R75 (final): player-level pause. The Player node's `paused` (player-core.md § Graph & properties
    // "Player node paused") freezes every source's EFFECTIVE pause (`node.paused || player.paused`,
    // never the node's own raw value, so a recipe-held side like reveal/frozen's A stays exactly as the
    // recipe left it) AND the transition recipe's own clock (`Runtime::now()` excises paused time), so
    // one `set player.paused` now freezes a pending B and an in-flight effect too — the interim R75a
    // `srcs:*.paused` ruling (write every source directly, nothing recipe-aware) is gone.
    // I3: no copy of the pause state lives here — `get player.paused` is the truth (it survives
    // a player restart via its snapshot, and a toggle from any process).
    public static bool TogglePause()
    {
        var client = C;
        if (!client.SocketExists) return false;
        JsonElement v;
        try { v = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LpPlayerClient.QuickMs).GetProperty("value"); }
        catch (LpPlayerException) { return false; }
        if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        bool now = v.ValueKind != JsonValueKind.True;
        return client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = now }, LpPlayerClient.QuickMs) != null;
    }

    // I1 (final review): a NEW wallpaper session (Apply / ApplyPlaylist / a cold Launch) starts
    // playing, as with legacy (a fresh mpvpaper is never paused) — a pause belongs to the session
    // it was made in. Queued (callers hold PlayerHelper's _lock), ahead of the session's switch.
    // (`stop` clears the player's pause on its own.)
    public static void QueueNewSession() => QueueEssential(() =>
    {
        var client = C;
        if (client.SocketExists)
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = false }, LpPlayerClient.QuickMs);
    });

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
        try { return client.Call("state", null, LpPlayerClient.QuickMs).GetProperty("graph"); } // item 6
        catch (LpPlayerException e) { LpPlayerClient.Log($"state failed — {e}"); return null; }
    }

    // live media sources (not snapshots) whose path is `path`
    private static List<string> SourcesFor(LpPlayerClient client, string path) => SourcesFor(client, [path]);

    // …whose path is any of `paths` (one `state` read for a whole selection)
    private static List<string> SourcesFor(LpPlayerClient client, IReadOnlyCollection<string> paths)
    {
        var ids = new List<string>();
        if (Graph(client) is not { } g || g.ValueKind != JsonValueKind.Object) return ids;
        foreach (var n in g.EnumerateObject())
        {
            var v = n.Value;
            if (!v.TryGetProperty("gain_effective_db", out _) || Str(v, "kind") is "snapshot" or "color") continue; // sources only
            var sp = Str(v, "path");
            if (paths.Any(p => SamePath(sp, p))) ids.Add(n.Name);
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
