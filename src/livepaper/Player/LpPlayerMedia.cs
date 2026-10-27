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
// a switch is ONE `transition` request (a cut when transitions are off); every setting reaches the live
// sources through ONE resolver (`ResolveNow`, "the effective-settings resolver" below): each live source
// — on screen, either side of an effect, a pending B — gets ITS OWN item's effective value, diffed
// against what it runs; layer settings (fit) go to `lay:*:main`.
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
        if ((outcome == null && kind != "transition.started") || !e.TryGetProperty("corr", out var c) || c.ValueKind != JsonValueKind.String) return;
        var corr = c.GetString()!;
        if (outcome == null) { Started(corr); return; }
        Interlocked.Increment(ref _eventOutcomes);
        Record(corr, outcome);
        // our latest switch FAILED (a file mpv can't play): A stays on screen, but every client was told B when it was
        // requested (wallpaper-changed) — the UI marked a wallpaper playing that never showed (matrix apply:broken).
        // Tell them what's really there; off this callback, which must never block on a request.
        if (kind == "transition.failed" && corr == _lastCorr)
            _ = Task.Run(() => PlayerHelper.OnWallpaperChanged?.Invoke(CurrentPath()));
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
        _startedAt.Clear();
        _onStarted.Clear();
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

    // R81: put every current effective setting back onto the live graph — the resolver's full pass
    // (every live source its own value of every setting, the layer fit; diffed against a fresh `state`)
    // — through the SAME ordered queue as every other mutation (so this can never race or reorder
    // against a concurrent switch/set). Not the player-level pause (I3, below).
    // Coalescible: it reads every value when it runs, so one pending reapply covers any number.
    public static void ReapplyAll() => QueueSet("reapply", ReapplyAllNow);

    private static void ReapplyAllNow()
    {
        var client = C;
        if (!client.SocketExists) return;
        Interlocked.Increment(ref _reapplyCount);
        ResolveNow(new Req { Fresh = true });
        var cur = CurrentPath();
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

    // `transition.started` = Running: the effect animates and `cur:*` already names B — from here a new
    // request COMMITS it (→ handoff) and a cancel snaps back to A. An aligned switch is the session's
    // current item from here (DoVideoEndWait's `onStarted`), not only from its handoff. The event can beat
    // the request's reply (different connections), so it's remembered by corr.
    private static readonly ConcurrentDictionary<string, long> _startedAt = new();
    private static readonly ConcurrentDictionary<string, Action> _onStarted = new();

    private static void Started(string corr)
    {
        long now = Environment.TickCount64;
        _startedAt[corr] = now;
        if (_startedAt.Count > 256)
            foreach (var (k, at) in _startedAt) if (now - at > 120_000) _startedAt.TryRemove(k, out _);
        if (_onStarted.TryRemove(corr, out var cb)) _ = Task.Run(cb); // off the event thread: it takes PlayerHelper's _lock
    }

    private static void WhenStarted(string corr, Action cb)
    {
        _onStarted[corr] = cb;
        if (_startedAt.ContainsKey(corr) && _onStarted.TryRemove(corr, out var already)) _ = Task.Run(already);
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

    // B's create props: everything the legacy launch/loadfile carried, as live properties — the
    // resolver's own per-source computation (`Desired`, every resolved prop) + path, kind and loop.
    public static Dictionary<string, object?> SourceProps(string path, AppSettings s)
    {
        var props = new Dictionary<string, object?>
        {
            ["path"] = path,
            ["kind"] = ImageExt.Contains(Path.GetExtension(path).ToLowerInvariant()) ? "image" : "video",
            ["loop"] = s.Loop,
        };
        foreach (var (k, v) in Desired(path, () => s, PlayerHelper.IsMuted, null, item: false)) props[k] = v;
        return props;
    }

    private static string HwDec(AppSettings s) => string.IsNullOrWhiteSpace(s.HwDec) ? "no" : s.HwDec.Trim();

    // Loudness normalization for `path` under `s` (mirrors PlayerHelper.NormalizeAf): unmeasured →
    // no filter now + a background measure for next time.
    private static string? NormalizeAf(string path, AppSettings s)
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
    // handed off). align:end waits as long as A plays. `onStarted` runs once (on the thread pool) if the
    // switch reaches Running — never for one cancelled / superseded / failed before that; a missed
    // `transition.started` event (a reconnect gap) → just the terminal outcome, as without it.
    public static async Task<string> SwitchAndWait(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd, CancellationToken ct,
        Action? onStarted = null)
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
        if (onStarted == null) return await WaitSwitch(client, corr, alignEnd, remaining, lastPos, ct).ConfigureAwait(false);
        WhenStarted(corr, onStarted);
        try { return await WaitSwitch(client, corr, alignEnd, remaining, lastPos, ct).ConfigureAwait(false); }
        finally { _onStarted.TryRemove(corr, out _); }
    }

    private static async Task<string> WaitSwitch(LpPlayerClient client, string corr, bool alignEnd, double? remaining, double? lastPos, CancellationToken ct)
    {
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

    // ---- the effective-settings resolver (player-adapter.md § Targeting) ---------------------------
    // ONE function decides which live source runs which value of every setting; every path that puts a
    // setting on the player goes through it (`ResolveNow`). Before, each path picked its own targets and
    // values, and they disagreed: normalization reached `cur:*` only, a `srcs:*` broadcast put the
    // playing item's volume/speed on the other side of an effect for a round trip, the volume key pushed
    // the new global over a playing override.
    //
    // INPUTS — all read when the pass RUNS (a coalesced pass applies the newest state, never a value
    // captured when it was queued):
    //   • the live sources: the source map (full item path → source ids — every live media source: on
    //     screen, either side of an effect, a pending B, a parked one; no colour/snapshot) + what each runs
    //     (its graph values) + every main layer's `fit`;
    //   • the settings (`SettingsService.Load()`), each item's overrides + loudness (its `index.json`
    //     entry), the mute (`PlayerHelper.IsMuted`, user + auto combined);
    //   • the request (`Req`): `Items` (+ `PlayingItem` = the item `cur:*` shows, resolved when it runs) —
    //     the items its transient values belong to, and with `OnlyItems` the only sources it touches;
    //     transient values (`ItemGainDb`/`ItemSpeed` for those items, `GlobalGainDb`/`GlobalSpeed` for the
    //     global — a drag preview's or an mpv literal's, never persisted); `Props` (only these; null = all);
    //     `Fresh` (diff against a new `state` read, else the cached values); `Force` (send even if equal).
    // OUTPUT per source (`Desired` — the same computation `SourceProps` gives a NEW source):
    //   gain.user = VolumeDb(transient item ?? its override ?? transient global ?? Volume)
    //   speed     = clamp(transient item ?? its override ?? transient global ?? Speed, 0.1, 4)
    //   af        = its OWN item's loudnorm at the target ("" off / NoAudio / unmeasured — kicks a measure)
    //   no_audio, hwdec, fps_cap, cache, demuxer_max_mib, demuxer_back_mib = the global settings
    //   gain.mute = −96 when muted, else 0
    //   + the layer: lay:*:main.fit = VideoScale (Fresh passes only; one `set` if any main layer differs)
    //   Not resolved: `loop` (the recipe owns A's loop under rotation — `SetLoop`, single wallpaper only)
    //   and `player.paused` (the player is its authority, I3).
    // DIFF: each desired value against what the source runs — the graph values of a `state` read (Fresh)
    //   or the value cache (the last read + every `set` made since, dropped with the map). Numbers within
    //   1e-4, strings/bools exact; only a differing value is sent: `set <id>.<prop>`, one per source —
    //   never a broadcast — and gain.mute as `animate` over 30 ms (never a step; a setting slot, so it
    //   lands while paused too). A gain.mute mid-ramp can read as its old value, so a mute CHANGE always
    //   sends (`Force`). A source gone meanwhile (`no_such_node`) → the map is re-read once; no answer →
    //   the pass gives up (R81 re-applies when the player answers again).
    // CALLERS — queue key → what they pass (every one coalescible: the newest pass per key wins):
    //   /settings (`PlayerHelper.ApplyEffectiveLive`), the volume key on the global, normalization, a
    //     loudness measurement landing → `ApplyEffective()`: "resolve", every source, every prop, Fresh.
    //   R81 (a restart / the stall breaker closing) → `ReapplyAll()`: "reapply", the same + log + count.
    //   /library/volume|speed, the volume key on an item's own volume (`ApplyOverrideLive`) →
    //     `ApplyOverride(path)`: "override:<path>", that item's sources only, gain.user + speed, cached.
    //   /preview {paths} (the modal's drag) → `Preview`: "preview:<prop>:<paths>", only those items'
    //     sources, the dragged prop, the dragged value as their transient, cached — ONE `set` per source
    //     per value, nothing persisted (no paths → the playing item).
    //   /preview {global} (the Settings page's drag) → `PreviewGlobal`: "preview-global:<prop>", every
    //     source, the dragged prop, the dragged value as the transient GLOBAL (an overridden item keeps
    //     its own), cached.
    //   an mpv volume/speed literal (`/volume {value}`) → `Mpv`: "set:<prop>", every source, that prop,
    //     the literal as the PLAYING item's transient (every other source its own), cached.
    //   a mute change (SetMute / SetUserMute → mpv `mute`) → `Mpv`: "set:gain.mute", every source,
    //     gain.mute, Force, cached map.
    //   a new source (`Switch`) → `SourceProps(path)` = `Desired(path)` + path, kind, loop.
    private sealed record Req
    {
        public IReadOnlyCollection<string>? Items { get; init; } // item paths the transient values belong to
        public bool PlayingItem { get; init; }                    // …or the playing item (cur:*), when it runs
        public bool OnlyItems { get; init; }                      // touch only those items' sources
        public double? ItemGainDb { get; init; }
        public double? ItemSpeed { get; init; }
        public double? GlobalGainDb { get; init; }
        public double? GlobalSpeed { get; init; }
        public IReadOnlySet<string>? Props { get; init; }         // null = every resolved prop (+ fit)
        public bool Fresh { get; init; }                          // diff against a new `state` read
        public bool Force { get; init; }                          // send even when the source already runs it
    }

    private static readonly IReadOnlySet<string> GainUser = new HashSet<string> { "gain.user" };
    private static readonly IReadOnlySet<string> SpeedOnly = new HashSet<string> { "speed" };
    private static readonly IReadOnlySet<string> PerItem = new HashSet<string> { "gain.user", "speed" };
    private static readonly IReadOnlySet<string> MuteOnly = new HashSet<string> { "gain.mute" };

    // Every setting the resolver owns, live, from the settings as they are now — /settings, the volume key
    // on the global, normalization, a loudness measurement landing.
    public static void ApplyEffective() => QueueSet("resolve", () => ResolveNow(new Req { Fresh = true }));

    // `path`'s own volume/speed (its override ?? the global) onto its source(s) — wherever they are (on
    // screen, either side of an effect, a pending B). `onPlayingSpeed` gets its effective speed when it is
    // what `cur:*` shows (the timed tick's speed factor). Coalescible per item: it re-reads the override.
    public static void ApplyOverride(string path, Action<double>? onPlayingSpeed = null) =>
        QueueSet("override:" + FullPath(path), () =>
        {
            if (ResolveNow(new Req { Items = [path], OnlyItems = true, Props = PerItem }) == 0 || onPlayingSpeed == null) return;
            if (SamePath(CurrentPath(), path))
                onPlayingSpeed(Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? SettingsService.Load().Speed, 0.1, 4.0));
        });

    // /preview (drag twin, no persist), literal values → the source(s) of `paths` — the item(s) the modal
    // edits, wherever they are: on screen, the outgoing A or incoming B of an effect, a pending B. No
    // paths → the playing item (`cur:*`, which mid-transition is the incoming side: a drag on A used to
    // land on B there and stay, since the persist that follows targets A by path).
    // Coalescible per edited selection + property: a drag's newest value replaces a still-pending one.
    public static void Preview(int? volume, double? speed, IReadOnlyCollection<string>? paths = null)
    {
        bool playing = paths is not { Count: > 0 };
        string who = playing ? "<playing>" // resolved when it runs (a switch in between is a barrier)
            : string.Join("\n", paths!.Select(FullPath).Order(StringComparer.Ordinal));
        if (volume is int v)
            QueueSet("preview:gain.user:" + who, () => ResolveNow(new Req
            { Items = paths, PlayingItem = playing, OnlyItems = true, Props = GainUser, ItemGainDb = MpvPropertyMap.VolumeDb(v) }));
        if (speed is double sp)
            QueueSet("preview:speed:" + who, () => ResolveNow(new Req
            { Items = paths, PlayingItem = playing, OnlyItems = true, Props = SpeedOnly, ItemSpeed = sp }));
    }

    // The Settings page's global Volume/Speed drag (`/preview {global:true}`): the dragged value is the
    // transient GLOBAL — each live source whose item has no override for that field takes it, an
    // overridden one keeps its own (override ?? global, R61). Only the dragged prop (a volume drag keeps
    // a speed the previous drag left). Coalescible per property; no `state` read while the map is cached,
    // no settings write (the UI's debounced /settings persists).
    public static void PreviewGlobal(int? volume, double? speed)
    {
        if (volume is int v) QueueSet("preview-global:gain.user", () => ResolveNow(new Req { Props = GainUser, GlobalGainDb = MpvPropertyMap.VolumeDb(v) }));
        if (speed is double sp) QueueSet("preview-global:speed", () => ResolveNow(new Req { Props = SpeedOnly, GlobalSpeed = sp }));
    }

    // ApplyPlaybackSettingsLive's Loop (the legacy guard — a single, non-timed video only: during rotation
    // the recipe owns A's loop, align:end turns it off until the switch; new sources take Loop at creation).
    public static void SetLoop(bool loop) => QueueSet("set:loop", () => Set("loop", loop));

    // The coalescing key of a per-item command on `path` (same file → same key, like SamePath).
    public static string FullPath(string path)
    {
        try { return Path.GetFullPath(path); } catch { return path; }
    }

    // ONE source's desired values (`r` = the pass's request, null for a new source; `item` = the source
    // belongs to one of the request's items, so their transient values apply). Only the request's props,
    // and only what they need (`settings` is loaded once, on first use): a drag preview reads neither the
    // settings nor the index, nor kicks a loudness measure.
    private static Dictionary<string, object> Desired(string path, Func<AppSettings> settings, bool muted, Req? r, bool item)
    {
        var props = r?.Props;
        bool Want(string p) => props == null || props.Contains(p);
        LibMeta? meta = null; bool metaRead = false;
        LibMeta? Meta() { if (!metaRead) { meta = LibraryStore.GetMeta(path); metaRead = true; } return meta; }
        var d = new Dictionary<string, object>();
        if (Want("gain.user"))
            d["gain.user"] = (item ? r!.ItemGainDb : null)
                ?? (Meta()?.Volume is int ov ? MpvPropertyMap.VolumeDb(ov) : (double?)null)
                ?? r?.GlobalGainDb ?? MpvPropertyMap.VolumeDb(settings().Volume);
        if (Want("speed"))
            d["speed"] = Math.Clamp((item ? r!.ItemSpeed : null) ?? Meta()?.Speed ?? r?.GlobalSpeed ?? settings().Speed, 0.1, 4.0);
        if (Want("af")) d["af"] = NormalizeAf(path, settings()) ?? "";
        if (Want("no_audio")) d["no_audio"] = settings().NoAudio;
        if (Want("hwdec")) d["hwdec"] = HwDec(settings());
        if (Want("fps_cap")) d["fps_cap"] = (double)Math.Max(0, settings().VideoFps);
        if (Want("cache")) d["cache"] = !settings().DisableCache;
        if (Want("demuxer_max_mib")) d["demuxer_max_mib"] = (double)Math.Max(0, settings().DemuxerMaxBytes);
        if (Want("demuxer_back_mib")) d["demuxer_back_mib"] = (double)Math.Max(0, settings().DemuxerMaxBackBytes);
        if (Want("gain.mute")) d["gain.mute"] = muted ? MpvPropertyMap.SilentDb : 0.0;
        return d;
    }

    private enum Sent { Ok, Gone, Failed, Stalled }

    // One pass (on the queue's worker — every pass and every map reader runs there). Returns how many
    // sources it covered (0 = none of the request's items is live, or no answer).
    private static int ResolveNow(Req r)
    {
        var client = C;
        if (!client.SocketExists) return 0; // nothing plays → nothing to set (sources take settings at creation)
        var items = r.Items?.Select(FullPath).ToHashSet();
        for (int attempt = 0; attempt < 2; attempt++)
        {
            if ((r.Fresh ? ReadLive(client) : CachedLive(client)) is not { } live) return 0;
            AppSettings? loaded = null;
            AppSettings S() => loaded ??= SettingsService.Load(); // only when a value needs it (not a drag preview)
            bool muted = PlayerHelper.IsMuted;
            string? playing = r.PlayingItem && CurrentPath() is string cp ? FullPath(cp) : null; // null (no output shows one): no item
            int covered = 0;
            bool stale = false;
            foreach (var (path, ids) in live.Map)
            {
                bool item = (items?.Contains(path) ?? false) || (playing != null && path == playing);
                if (r.OnlyItems && !item) continue;
                covered += ids.Count;
                var want = Desired(path, S, muted, r, item);
                foreach (var id in ids)
                {
                    if (!live.Values.TryGetValue(id, out var have)) live.Values[id] = have = [];
                    foreach (var (prop, v) in want)
                    {
                        if (!r.Force && have.TryGetValue(prop, out var h) && Same(h, v)) continue;
                        var sent = Send(client, id, prop, v);
                        if (sent == Sent.Ok) have[prop] = v;
                        else if (sent == Sent.Stalled) return covered; // the rest would fail fast too; R81 catches up
                        else if (sent == Sent.Gone) { stale = true; break; } // retired meanwhile: its other props too
                    }
                }
            }
            if (r.Fresh && (r.Props == null || r.Props.Contains("fit")) && live.LayerFit.Any(f => f != Fit(S())))
                client.TryCall("set", new Dictionary<string, object?> { ["path"] = "lay:*:main.fit", ["value"] = Fit(S()) }, LpPlayerClient.QuickMs);
            if (!stale) return covered;
            InvalidateSources(); // a source went (a switch meanwhile): new ones may have come — once more, re-read
        }
        return 0;
    }

    // `set <id>.<prop>` (gain.mute: `animate` over 30 ms — never a step). item 6: QuickMs, never the
    // 2000 ms default — a queued property set.
    private static Sent Send(LpPlayerClient client, string id, string prop, object v)
    {
        try
        {
            if (prop == "gain.mute")
                client.Call("animate", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["to"] = v, ["duration_ms"] = 30 }, LpPlayerClient.QuickMs);
            else
                client.Call("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = v }, LpPlayerClient.QuickMs);
            return Sent.Ok;
        }
        catch (LpPlayerException e) when (e.Code == "no_such_node") { return Sent.Gone; }
        catch (LpPlayerException e) when (e.Code is "timeout" or "io")
        {
            LpPlayerClient.Log($"set {id}.{prop} failed — {e} (rest of this pass skipped; R81 re-applies)");
            return Sent.Stalled;
        }
        catch (LpPlayerException e) { LpPlayerClient.Log($"set {id}.{prop}={v} failed — {e}"); return Sent.Failed; }
    }

    private static bool Same(object? have, object want) => (have, want) switch
    {
        (double a, double b) => Math.Abs(a - b) <= 1e-4,
        (null, _) => false,
        _ => have.Equals(want),
    };

    // A property OUTSIDE the resolver: a layer prop → `lay:*:main`; mpv's `pause` → the player-level
    // pause (M7, R75 — never a node's own `paused`); anything else (`loop`, a decode/buffer literal no path
    // sends any more) → `srcs:*` (on-screen sources + an in-flight transition's pending B, R61).
    // item 6: QuickMs — a queued property set, never the 2000 ms default.
    private static List<string> Set(string prop, object value)
    {
        var client = C;
        if (!client.SocketExists) return []; // nothing plays → nothing to set (sources take settings at creation)
        string path = prop is "fit" or "viewport" or "opacity" ? $"lay:*:main.{prop}"
            : prop == "player.paused" ? "player.paused"
            : $"srcs:*.{prop}";
        try { return Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = path, ["value"] = value }, LpPlayerClient.QuickMs)); }
        catch (LpPlayerException e) { LpPlayerClient.Log($"set {prop}={value} failed — {e}"); return []; }
    }

    // The mpv IPC args PlayerHelper.SendCommand/TrySendCommand still build. Property sets go through
    // MpvPropertyMap: a volume/speed literal (`/volume {value}`) is the PLAYING item's transient value in
    // a resolver pass (every other source keeps its own — never a `srcs:*` broadcast); a mute change is a
    // forced resolver pass from PlayerHelper.IsMuted (SetMute / SetUserMute send exactly that); anything
    // else → `Set`. `cycle pause` toggles; mpv-playlist plumbing (loadfile/playlist-*/loop-file/
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
        // property wins over a still-pending one
        Action run = t.prop switch
        {
            "gain.user" => () => ResolveNow(new Req { PlayingItem = true, Props = GainUser, ItemGainDb = (double)t.value }),
            "speed" => () => ResolveNow(new Req { PlayingItem = true, Props = SpeedOnly, ItemSpeed = (double)t.value }),
            "gain.mute" => () => ResolveNow(new Req { Props = MuteOnly, Force = true }),
            _ => () => Set(t.prop, t.value),
        };
        QueueSet("set:" + t.prop, run);
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

    // ---- the live sources, cached (speed storm: a /preview cost `state` + the `set`s every time) -----
    // One `state` read → `Live`: full item path → source ids for every live media source (no
    // snapshot/colour), what each source runs (its graph values, `gain.<slot>` flattened), and every main
    // layer's `fit`. A source's id and path never change while it lives, and the player never reuses an
    // id (`src<N>`, monotonic per process), so the map changes only when sources come or go: a switch
    // (ours or another client's — `transition.scheduled` creates the B), a handoff (A goes), a
    // cancel/failure (B goes), a stop, an output's sources retired, a new player process (Generation).
    // Every one of those invalidates it: our own Switch/Stop/cancel/upgrade synchronously (they run on the
    // queue's worker, like every reader), the player's own changes through the subscribed events
    // (LpPlayerClient.Topics), a restart through Generation + OnRestarted. It is only trusted while the
    // event connection is live (a reconnect gap loses events → `Subscribed` invalidates), a read while an
    // invalidation happened is never stored (epoch), and a pass that finds a cached id gone
    // (`no_such_node`) invalidates and re-reads once. The VALUES are the resolver's diff for a cached pass
    // (a preview): the read's, then every value a pass `set` since (only on success). So a drag costs one
    // `set` per source; a Fresh pass reads `state` again anyway and refreshes the whole cache.
    private sealed class Live
    {
        public Dictionary<string, List<string>> Map { get; } = new();                  // full path → ids
        public Dictionary<string, Dictionary<string, object?>> Values { get; } = new(); // id → prop → value
        public List<string> LayerFit { get; } = [];                                     // every main layer's fit
    }

    private static readonly object _srcLock = new();
    private static Live? _live;
    private static int _liveGen = -1;
    private static int _srcEpoch;
    private static int _srcMapReads;
    // `state` reads made to (re)build the map — self-test evidence of the cache
    public static int SourceMapReads => Volatile.Read(ref _srcMapReads);
    // bumped by every invalidation — self-test evidence that an event reached the map
    public static int SourceEpoch { get { lock (_srcLock) return _srcEpoch; } }

    public static void InvalidateSources()
    {
        lock (_srcLock) { _srcEpoch++; _live = null; }
    }

    // the cached live sources, else one `state` read
    private static Live? CachedLive(LpPlayerClient client)
    {
        client.StartEvents(); // idempotent; the map is cached only once events flow
        lock (_srcLock)
            if (_live != null && _liveGen == client.Generation && client.EventsLive) return _live;
        return ReadLive(client);
    }

    // one `state` read (null = no answer); stored as the cache unless something invalidated it meanwhile
    private static Live? ReadLive(LpPlayerClient client)
    {
        client.StartEvents();
        int epoch;
        lock (_srcLock) epoch = _srcEpoch;
        int gen = client.Generation;
        Interlocked.Increment(ref _srcMapReads);
        if (Graph(client) is not { ValueKind: JsonValueKind.Object } g) return null;
        var live = new Live();
        foreach (var n in g.EnumerateObject())
        {
            var v = n.Value;
            if (n.Name.StartsWith("lay:", StringComparison.Ordinal) && n.Name.EndsWith(":main", StringComparison.Ordinal))
            { live.LayerFit.Add(Str(v, "fit")); continue; }
            if (!v.TryGetProperty("gain_effective_db", out _) || Str(v, "kind") is "snapshot" or "color") continue; // sources only
            var sp = Str(v, "path");
            if (sp.Length == 0) continue;
            var key = FullPath(sp);
            if (!live.Map.TryGetValue(key, out var l)) live.Map[key] = l = [];
            l.Add(n.Name);
            live.Values[n.Name] = ValuesOf(v);
        }
        lock (_srcLock)
            if (epoch == _srcEpoch && gen == client.Generation && client.EventsLive) { _live = live; _liveGen = gen; }
        return live;
    }

    // a source node's graph values: numbers as double, strings, bools; `gain: {slot: dB}` → `gain.<slot>`
    private static Dictionary<string, object?> ValuesOf(JsonElement node)
    {
        var d = new Dictionary<string, object?>();
        foreach (var p in node.EnumerateObject())
        {
            if (p.Name == "gain" && p.Value.ValueKind == JsonValueKind.Object)
            {
                foreach (var slot in p.Value.EnumerateObject())
                    if (slot.Value.ValueKind == JsonValueKind.Number) d["gain." + slot.Name] = slot.Value.GetDouble();
                continue;
            }
            d[p.Name] = p.Value.ValueKind switch
            {
                JsonValueKind.Number => p.Value.GetDouble(),
                JsonValueKind.String => p.Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };
        }
        return d;
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
