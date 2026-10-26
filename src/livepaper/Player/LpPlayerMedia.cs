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
                    c.Subscribed += () => InvalidateSources(); // events in the reconnect gap are lost
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
    //
    // Three kinds of command (speed storm: a slider's newest value was dropped at the cap):
    // - ESSENTIAL (`QueueEssential`) — a switch, stop, new session, pause toggle, upgrade: user intent,
    //   never dropped, and a BARRIER: nothing is ever coalesced or reordered across one.
    // - COALESCIBLE (`QueueSet`, keyed by target + property, e.g. `set:gain.user`, `preview:speed:<paths>`)
    //   — a pure overwrite whose newest value is the one that matters (a slider, a global setting, a
    //   per-item override re-read at run time). A new one REMOVES a still-pending one with the same key
    //   enqueued since the last barrier and takes its place at the tail: the run keeps every other
    //   command in its order and only loses a write that a later write of the same targets overwrites
    //   anyway — so the final state is exactly what the full sequence would leave, and a burst holds ONE
    //   pending command per key, however long the player stalls. A coalesced command is admitted even at
    //   the cap (it doesn't grow the queue).
    // - anything else (`Queue`) — unknown semantics, so a barrier for coalescing, and refused at the cap.
    // The cap (item 6) still bounds memory: at MaxQueueDepth a command that can't coalesce and isn't
    // essential is logged and dropped. R81 re-applies settings when a stalled player answers again.
    private static readonly object _qLock = new();

    private sealed class QItem
    {
        public required Action Run;          // never throws (wrapped at enqueue)
        public string? Key;                  // non-null = coalescible
        public bool Essential;
        public readonly TaskCompletionSource Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<TaskCompletionSource>? Replaced; // completions of the pending items this one superseded
        public bool Barrier => Key == null;
    }

    private static readonly LinkedList<QItem> _pending = new();
    private static QItem? _running;   // the command the worker is executing now (null = idle)
    private static bool _worker;      // a worker loop is scheduled or running

    // item 6: a hard cap on how many commands may be in flight (queued + currently running) at once.
    public const int MaxQueueDepth = 256;
    public static int QueueDepth { get { lock (_qLock) return _pending.Count + (_running != null ? 1 : 0); } }
    private static int _coalesced;
    // how many pending commands a newer one with the same key replaced — self-test evidence
    public static int Coalesced => Volatile.Read(ref _coalesced);

    public static Task<T> Queue<T>(Func<T> f)
    {
        var res = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        return Enqueue(Wrap(() => res.TrySetResult(f()), () => res.TrySetResult(default!)), key: null, essential: false)
            ? res.Task : Task.FromResult(default(T)!);
    }

    public static Task Queue(Action a) => Queue<bool>(() => { a(); return true; });

    // A switch or a stop is user intent, not a coalescible property write: it is never dropped at the
    // cap (it still counts toward the depth) and nothing coalesces across it.
    public static Task QueueEssential(Action a) => QueueEssential<bool>(() => { a(); return true; });

    public static Task<T> QueueEssential<T>(Func<T> f)
    {
        var res = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Enqueue(Wrap(() => res.TrySetResult(f()), () => res.TrySetResult(default!)), key: null, essential: true);
        return res.Task;
    }

    // A coalescible overwrite, keyed by its target + property. Completes when it — or the newer
    // command with its key that replaced it — has run.
    public static Task QueueSet(string key, Action a)
    {
        var it = MakeItem(Wrap(a, () => { }), key, essential: false);
        return Admit(it) ? it.Done.Task : Task.CompletedTask;
    }

    private static Action Wrap(Action run, Action onThrow) => () =>
    {
        try { run(); }
        catch (Exception e) { LpPlayerClient.Log($"queued lp-player command threw: {e.GetBaseException().Message}"); onThrow(); }
    };

    private static QItem MakeItem(Action run, string? key, bool essential) => new() { Run = run, Key = key, Essential = essential };

    private static bool Enqueue(Action run, string? key, bool essential) => Admit(MakeItem(run, key, essential));

    private static bool Admit(QItem it)
    {
        lock (_qLock)
        {
            bool replaced = false;
            if (it.Key != null)
                for (var n = _pending.Last; n != null; n = n.Previous)
                {
                    if (n.Value.Barrier) break;              // never coalesce across a barrier
                    if (n.Value.Key != it.Key) continue;
                    _pending.Remove(n);
                    (it.Replaced ??= []).Add(n.Value.Done);
                    if (n.Value.Replaced != null) it.Replaced.AddRange(n.Value.Replaced);
                    replaced = true;
                    Interlocked.Increment(ref _coalesced);
                    break;                                   // at most one pending per key per run
                }
            if (!replaced && !it.Essential && _pending.Count + (_running != null ? 1 : 0) >= MaxQueueDepth)
            {
                LpPlayerClient.Log($"lp-player command queue at its cap ({MaxQueueDepth}, a stalled/overloaded player) — dropping a queued command");
                return false;
            }
            _pending.AddLast(it);
            if (!_worker) { _worker = true; ThreadPool.UnsafeQueueUserWorkItem(_ => Worker(), null); }
            return true;
        }
    }

    // ONE ordered worker: runs the pending commands in order, then exits (the next Admit starts it again).
    private static void Worker()
    {
        while (true)
        {
            QItem it;
            lock (_qLock)
            {
                if (_pending.First is not { } first) { _running = null; _worker = false; return; }
                _pending.RemoveFirst();
                it = first.Value;
                _running = it;
            }
            try { it.Run(); } catch { } // Run is wrapped; belt and braces — the worker must never die
            lock (_qLock) _running = null;
            it.Done.TrySetResult();
            if (it.Replaced != null) foreach (var r in it.Replaced) r.TrySetResult();
        }
    }

    // completes when everything queued so far has run (a pending command that gets replaced later
    // completes with its replacement — never earlier than its own place in the order)
    public static Task Drain()
    {
        lock (_qLock) return (_pending.Last?.Value ?? _running)?.Done.Task ?? Task.CompletedTask;
    }

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
        // every subscribed kind (LpPlayerClient.Topics) may change which sources show which file
        InvalidateSources();
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
        InvalidateSources();
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
    // Coalescible: it reads every value when it runs, so one pending reapply covers any number.
    public static void ReapplyAll() => QueueSet("reapply", ReapplyAllNow);

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
        ApplyNormalizationNow(); // every source's own af
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

    // Loudness normalization, live, on EVERY live media source — each by its own item (loudnorm is per
    // item): the playing one, the outgoing A of an effect, a pending B (armed for A's end: it would play
    // its whole clip with the old filter), and any source while no output shows one (no `cur:*`). It used
    // to reach `cur:*` only (UI matrix `set:normalize*`). Diffed against each source's current `af` (one
    // `state` read), so an unchanged one gets nothing — every /settings save calls this. Coalescible.
    public static void ApplyNormalizationAll() => QueueSet("af:*", ApplyNormalizationNow);

    private static void ApplyNormalizationNow()
    {
        var client = C;
        if (Graph(client) is not { ValueKind: JsonValueKind.Object } g) return;
        var s = SettingsService.Load();
        foreach (var n in g.EnumerateObject())
        {
            var v = n.Value;
            if (!v.TryGetProperty("gain_effective_db", out _) || Str(v, "kind") is "snapshot" or "color" or "image") continue; // media sources with audio
            var path = Str(v, "path");
            if (path.Length == 0) continue;
            var want = NormalizeAf(path, s) ?? "";
            if (Str(v, "af") == want) continue;
            try { client.Call("set", new Dictionary<string, object?> { ["path"] = $"{n.Name}.af", ["value"] = want }, LpPlayerClient.QuickMs); }
            catch (LpPlayerException e) when (e.Code == "no_such_node") { } // gone meanwhile
            catch (LpPlayerException e) { LpPlayerClient.Log($"set {n.Name}.af failed — {e}"); }
        }
    }

    // Loudness normalization for `path` under `s` (mirrors PlayerHelper.NormalizeAf): unmeasured →
    // no filter now + a background measure for next time.
    public static string? NormalizeAf(string path, AppSettings s)
    {
        if (!s.NormalizeAudio || s.NoAudio || PlayerHelper.IsScenePath(path)) return null;
        var af = LibraryService.LoudnormAf(path, s.NormalizeTargetLufs);
        if (af == null) _ = LibraryService.EnsureLoudnessAsync(path);
        return af;
    }

    // ---- in-place upgrade -----------------------------------------------------------------------
    // A player older than its binary (rebuilt, reinstalled) restarts onto it with its snapshot
    // (LpPlayerClient.UpgradeInPlace): before every switch (Switch above), and from this 10 s check
    // while nothing is switching — never across an armed align:end switch (the restart would drop it
    // and the rotation would switch early, failure path), so an advance-on-end playlist upgrades at
    // its next switch. Queued: ordered with switches, so one queued before the check runs first.
    private static System.Threading.Timer? _upgradeWatch;
    public static void StartUpgradeWatch() => _upgradeWatch ??= new System.Threading.Timer(_ => UpgradeWatchTick(), null, 10_000, 10_000);

    private static void UpgradeWatchTick()
    {
        if (!PlayerEngine.IsLpPlayer) return;
        var client = C;
        if (client.PlayerPid == null && !client.Reachable()) return; // a player started before this backend: learn its pid
        if (client.StaleReason() == null) return;
        QueueEssential(() =>
        {
            if (client.StaleReason() is not string why || Switching(client)) return;
            client.UpgradeInPlace(why);
            InvalidateSources();
        });
    }

    // any transition not yet done (armed, waiting, running, handing off); unknown → treated as yes
    private static bool Switching(LpPlayerClient client)
    {
        try
        {
            var st = client.Call("state", null, LpPlayerClient.QuickMs);
            return st.TryGetProperty("transitions", out var t) && t.ValueKind == JsonValueKind.Array
                && t.EnumerateArray().Any(x => Str(x, "phase") != "done");
        }
        catch (LpPlayerException) { return true; }
    }

    // `transition {outputs:"out:*", to:{path, props}, effect from Pick(tcfg) or null (cut), method, align}`.
    // Returns the corr (or null when the player can't be reached / refused — logged with its hint).
    public static string? Switch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)
    {
        try { return SwitchCore(path, s, tcfg, alignEnd); }
        finally { InvalidateSources(); } // a new B (and maybe an upgraded player): re-read the map next time
    }

    private static string? SwitchCore(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)
    {
        var client = C;
        if (!client.EnsureRunning()) return null;
        if (client.StaleReason() is string why) client.UpgradeInPlace(why); // A comes back as it was, then switches
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
        var corr = await QueueEssential(() => Switch(path, s, tcfg, alignEnd)).ConfigureAwait(false); // ordered with queued stop/sets; never dropped
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
            InvalidateSources();
        }
        if (outcome == "caller-cancelled")
        {
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LpPlayerException e) when (e.Code is "no_such_node" or "unsupported") { } // superseded / already handed off
            catch (LpPlayerException e) { LpPlayerClient.Log($"cancel {corr} failed — {e}"); }
            InvalidateSources();
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
        InvalidateSources();
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
        InvalidateSources();
        _lastCorr = null;
    }

    // ---- properties --------------------------------------------------------------------------------
    // A global setting → `srcs:*` (layer props → `lay:*:main`; mute ramps over 30 ms, never a step).
    // gain.user / speed: `/settings` passes the effective value (override ?? global) of the PLAYING item;
    // any other source (an in-flight transition's other side, a pending B) gets ITS own effective value —
    // set per source, never `srcs:*` first and fixed up after: that broadcast handed every other source
    // the playing item's volume + speed for one round trip on every settings save (a theme change mid-
    // effect blipped the outgoing wallpaper to the incoming one's volume — UI matrix `appear:*`).
    // item 6: every call here uses QuickMs — a queued property set, never the 2000 ms default.
    public static List<string> Set(string prop, object value)
    {
        var client = C;
        if (!client.SocketExists) return []; // nothing plays → nothing to set (sources take settings at creation)
        const int q = LpPlayerClient.QuickMs;
        if (prop is "gain.user" or "speed" && SetPerItem(client, prop, value) is { } done) return done;
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

    // gain.user / speed on every live media source, each with its own value: `value` for the playing item's
    // source(s), `override ?? global` for any other item's. From the cached source map; null = no map (no
    // answer) → the caller falls back to `srcs:*` + FixupPerItem. A source gone meanwhile → re-read once.
    private static List<string>? SetPerItem(LpPlayerClient client, string prop, object value)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            if (SourceMap(client) is not { } map) return null;
            var cur = CurrentPath(); // null (no output shows one): every source takes its own
            var s = SettingsService.Load();
            var done = new List<string>();
            bool stale = false;
            foreach (var (path, ids) in map)
            {
                object v = SamePath(path, cur) ? value
                    : prop == "gain.user" ? MpvPropertyMap.VolumeDb(LibraryService.ReadVolumeOverride(path) ?? s.Volume)
                    : Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? s.Speed, 0.1, 4.0);
                foreach (var id in ids)
                {
                    try { client.Call("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = v }, LpPlayerClient.QuickMs); done.Add(id); }
                    catch (LpPlayerException e) when (e.Code == "no_such_node") { stale = true; }
                    catch (LpPlayerException e) { LpPlayerClient.Log($"set {id}.{prop} failed — {e}"); }
                }
            }
            if (!stale) return done;
            InvalidateSources();
        }
        return null;
    }

    private static void FixupPerItem(LpPlayerClient client, string prop, List<string> targets)
    {
        var cur = CurrentPath();
        if (targets.Count == 1 && cur != null) return; // the only source is the one on screen → already right
        if (SourceMap(client) is not { } map) return;
        var pathOf = new Dictionary<string, string>();
        foreach (var (p, ids) in map) foreach (var id in ids) pathOf[id] = p;
        var s = SettingsService.Load();
        foreach (var id in targets)
        {
            if (!pathOf.TryGetValue(id, out var path) || SamePath(path, cur)) continue; // no path: colour/snapshot
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
        return client.SocketExists ? SetEach(client, [path], prop, value) : [];
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
    // Coalescible per edited selection + property: a drag's newest value replaces a still-pending one.
    public static void Preview(int? volume, double? speed, IReadOnlyCollection<string>? paths = null)
    {
        string who = paths is { Count: > 0 }
            ? string.Join("\n", paths.Select(FullPath).Order(StringComparer.Ordinal))
            : "<playing>"; // resolved when it runs (a switch in between is a barrier)
        if (volume is int v) QueueSet("preview:gain.user:" + who, () => PreviewNow(v, null, paths));
        if (speed is double sp) QueueSet("preview:speed:" + who, () => PreviewNow(null, sp, paths));
    }

    // The Settings page's global Volume/Speed drag (`/preview {global:true}`): each live media source
    // whose item has NO override for that field takes the dragged value (override ?? global, R61); an
    // overridden one keeps its own. Coalescible per property; one `set` per following source from the
    // cached map — no `state`, no `cur:*` read, no settings write (the UI's debounced /settings persists).
    public static void PreviewGlobal(int? volume, double? speed)
    {
        if (volume is int v) QueueSet("preview-global:gain.user", () => PreviewGlobalNow("gain.user", MpvPropertyMap.VolumeDb(v)));
        if (speed is double sp) QueueSet("preview-global:speed", () => PreviewGlobalNow("speed", Math.Clamp(sp, 0.1, 4.0)));
    }

    private static void PreviewGlobalNow(string prop, object value)
    {
        var client = C;
        if (!client.SocketExists || SourceMap(client) is not { } map) return;
        var follow = map.Keys.Where(p => prop == "gain.user"
            ? LibraryService.ReadVolumeOverride(p) == null
            : LibraryService.ReadSpeedOverride(p) == null).ToList();
        if (follow.Count > 0) SetEach(client, follow, prop, value);
    }

    // The coalescing key of a per-item command on `path` (same file → same key, like SamePath).
    public static string FullPath(string path)
    {
        try { return Path.GetFullPath(path); } catch { return path; }
    }

    private static void PreviewNow(int? volume, double? speed, IReadOnlyCollection<string>? paths)
    {
        if (paths is not { Count: > 0 })
            paths = CurrentPath() is string cur ? [cur] : [];
        if (paths.Count == 0) return;
        var client = C;
        if (!client.SocketExists) return;
        if (volume is int v) SetEach(client, paths, "gain.user", MpvPropertyMap.VolumeDb(v));
        if (speed is double sp) SetEach(client, paths, "speed", Math.Clamp(sp, 0.1, 4.0));
    }

    // ApplyPlaybackSettingsLive's lp-player twin: every changed decode/buffer/audio setting, live.
    // Loop keeps the legacy guard (single, non-timed video only): during rotation the recipe owns A's
    // loop (align:end turns it off until the switch) and new sources take settings.Loop at creation.
    // One coalescible set per CHANGED property (the same `set:<prop>` keys as Mpv()'s, so the newest
    // value of a property wins whichever path queued it); nothing changed → nothing queued.
    public static void ApplySettingsLive(AppSettings prev, AppSettings cur, bool loopAllowed)
    {
        static void S(string prop, object v) => QueueSet("set:" + prop, () => Set(prop, v));
        if (prev.NoAudio != cur.NoAudio) S("no_audio", cur.NoAudio);
        if (loopAllowed && prev.Loop != cur.Loop) S("loop", cur.Loop);
        if (prev.VideoFps != cur.VideoFps) S("fps_cap", (double)Math.Max(0, cur.VideoFps));
        if (prev.DisableCache != cur.DisableCache) S("cache", !cur.DisableCache);
        if (prev.DemuxerMaxBytes != cur.DemuxerMaxBytes) S("demuxer_max_mib", (double)Math.Max(0, cur.DemuxerMaxBytes));
        if (prev.DemuxerMaxBackBytes != cur.DemuxerMaxBackBytes) S("demuxer_back_mib", (double)Math.Max(0, cur.DemuxerMaxBackBytes));
        if (prev.HwDec != cur.HwDec) S("hwdec", HwDec(cur));
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
            case "cycle" when name == "pause": QueueEssential(() => TogglePause()); return true; // a toggle reads the state: never coalesced
            case "loadfile" or "playlist-clear" or "playlist-next" or "playlist-prev" or "playlist-shuffle" or "playlist-unshuffle":
                return true;
            case "set" or "set_property" when name is "loop-file" or "loop-playlist":
                return true;
        }
        if (MpvPropertyMap.Translate(args) is not { } t) return false;
        // ordered, never on the caller's thread (it may hold PlayerHelper's _lock); the newest value of a
        // property wins over a still-pending one (Set targets the same alias for a given prop)
        QueueSet("set:" + t.prop, () => Set(t.prop, t.value));
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
        if (PlayerPaused(client) is not bool paused) return false;
        bool now = !paused;
        return client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = now }, LpPlayerClient.QuickMs) != null;
    }

    // `get player.paused` (null = no player / no answer). Synchronous but quick (QuickMs).
    public static bool IsPlayerPaused() => C is { SocketExists: true } client && PlayerPaused(client) == true;

    private static bool? PlayerPaused(LpPlayerClient client)
    {
        try
        {
            var v = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LpPlayerClient.QuickMs).GetProperty("value");
            return v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
        }
        catch (LpPlayerException) { return null; }
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

    // Paths on screen now or about to be: every layer's content (an effect's incoming side, never its
    // outgoing one — that is leaving anyway) plus the B of every requested switch that isn't an aligned
    // one still waiting for A's end (the rotation retargets those). `cur:*` alone misses a switch that
    // was requested but isn't running yet (trashing an item right after applying it kept it playing).
    // A still-queued switch is waited for (bounded) so it counts too.
    public static List<string> ShownOrIncomingPaths()
    {
        var client = C;
        var paths = new List<string>();
        if (!client.SocketExists) return paths;
        try { Drain().Wait(1000); } catch { }
        JsonElement st;
        try { st = client.Call("state", null, LpPlayerClient.QuickMs); }
        catch (LpPlayerException e) { LpPlayerClient.Log($"state failed — {e}"); return paths; }
        if (!st.TryGetProperty("graph", out var g) || g.ValueKind != JsonValueKind.Object) return paths;
        string? PathOf(string id) =>
            id.Length > 0 && g.TryGetProperty(id, out var n) && Str(n, "kind") is not ("effect" or "layer") && Str(n, "path") is { Length: > 0 } p ? p : null;
        void Add(string? p) { if (p != null && !paths.Contains(p)) paths.Add(p); }
        foreach (var n in g.EnumerateObject())
        {
            if (Str(n.Value, "kind") != "layer") continue;
            var content = Str(n.Value, "content");
            Add(g.TryGetProperty(content, out var c) && Str(c, "kind") == "effect" ? PathOf(Str(c, "to")) : PathOf(content));
        }
        if (st.TryGetProperty("transitions", out var trs) && trs.ValueKind == JsonValueKind.Array)
            foreach (var t in trs.EnumerateArray())
                if (Str(t, "phase") is not ("waiting_start" or "done")) Add(PathOf(Str(t, "to")));
        return paths;
    }

    // live media sources (not snapshots) whose path is `path`
    private static List<string> SourcesFor(LpPlayerClient client, string path) => SourcesFor(client, [path]);

    // …whose path is any of `paths` (from the cached map below — one `state` read per graph change)
    private static List<string> SourcesFor(LpPlayerClient client, IReadOnlyCollection<string> paths)
    {
        var ids = new List<string>();
        if (SourceMap(client) is not { } map) return ids;
        foreach (var p in paths)
            if (map.TryGetValue(FullPath(p), out var l)) foreach (var id in l) if (!ids.Contains(id)) ids.Add(id);
        return ids;
    }

    // ---- path → source ids, cached (speed storm: a /preview cost `state` + the `set`s every time) ----
    // A source's id and path never change while it lives, and the player never reuses an id (`src<N>`,
    // monotonic per process), so the map changes only when sources come or go: a switch (ours or
    // another client's — `transition.scheduled` creates the B), a handoff (A goes), a cancel/failure
    // (B goes), a stop, an output's sources retired, a new player process (Generation). Every one of
    // those invalidates it: our own Switch/Stop/cancel/upgrade synchronously (they run on the queue's
    // worker, like every reader), the player's own changes through the subscribed events
    // (LpPlayerClient.Topics), a restart through Generation + OnRestarted. The map is only trusted
    // while the event connection is live (a reconnect gap loses events → `Subscribed` invalidates), a
    // map read while an invalidation happened is never stored (epoch), and a set that finds its cached
    // id gone (`no_such_node`) invalidates and re-reads once. So a drag costs one `set` per source.
    private static readonly object _srcLock = new();
    private static Dictionary<string, List<string>>? _srcMap;
    private static int _srcMapGen = -1;
    private static int _srcEpoch;
    private static int _srcMapReads;
    // `state` reads made to (re)build the map — self-test evidence of the cache
    public static int SourceMapReads => Volatile.Read(ref _srcMapReads);
    // bumped by every invalidation — self-test evidence that an event reached the map
    public static int SourceEpoch { get { lock (_srcLock) return _srcEpoch; } }

    public static void InvalidateSources()
    {
        lock (_srcLock) { _srcEpoch++; _srcMap = null; }
    }

    private static Dictionary<string, List<string>>? SourceMap(LpPlayerClient client)
    {
        client.StartEvents(); // idempotent; the map is cached only once events flow
        int epoch;
        lock (_srcLock)
        {
            if (_srcMap != null && _srcMapGen == client.Generation && client.EventsLive) return _srcMap;
            epoch = _srcEpoch;
        }
        int gen = client.Generation;
        Interlocked.Increment(ref _srcMapReads);
        if (Graph(client) is not { ValueKind: JsonValueKind.Object } g) return null;
        var map = new Dictionary<string, List<string>>();
        foreach (var n in g.EnumerateObject())
        {
            var v = n.Value;
            if (!v.TryGetProperty("gain_effective_db", out _) || Str(v, "kind") is "snapshot" or "color") continue; // sources only
            var sp = Str(v, "path");
            if (sp.Length == 0) continue;
            var key = FullPath(sp);
            if (!map.TryGetValue(key, out var l)) map[key] = l = [];
            l.Add(n.Name);
        }
        lock (_srcLock)
            if (epoch == _srcEpoch && gen == client.Generation && client.EventsLive) { _srcMap = map; _srcMapGen = gen; }
        return map;
    }

    // `set <id>.<prop>` on each of `ids` (cached); a vanished id → re-read the map once and set the
    // fresh ids for `paths`. Returns the ids it set.
    private static List<string> SetEach(LpPlayerClient client, IReadOnlyCollection<string> paths, string prop, object value)
    {
        var ids = SourcesFor(client, paths);
        for (int attempt = 0; attempt < 2; attempt++)
        {
            bool stale = false;
            foreach (var id in ids)
            {
                try { client.Call("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = value }, LpPlayerClient.QuickMs); }
                catch (LpPlayerException e) when (e.Code == "no_such_node") { stale = true; }
                catch (LpPlayerException e) { LpPlayerClient.Log($"set {id}.{prop} failed — {e}"); }
            }
            if (!stale) break;
            InvalidateSources();
            ids = SourcesFor(client, paths);
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
