using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Player;

// The media primitives PlayerHelper dispatches to under PlayerEngine=liascape-player
// (.claude/rules/player-adapter.md). Everything is "the same wallpaper on every output" (out:*):
// a switch is ONE `transition` request (a cut when transitions are off); every setting reaches the live
// sources through ONE resolver (`ResolveNow`, "the effective-settings resolver" below): each live source
// — on screen, either side of an effect, a pending B — gets ITS OWN item's effective value, diffed
// against what it runs; layer settings (fit) go to `lay:*:main`.
public static class LiascapePlayerMedia
{
    private static LiascapePlayerClient? _hooked;
    private static readonly object _hookLock = new();

    private static LiascapePlayerClient C
    {
        get
        {
            var c = LiascapePlayerClient.Shared;
            lock (_hookLock)
            {
                if (!ReferenceEquals(c, _hooked))
                {
                    c.Event += OnEvent;
                    c.Restarted += OnRestarted;
                    c.Recovered += OnRecovered;
                    c.Subscribed += () => InvalidateSources(); // events in the reconnect gap are lost (bar the outbox's)
                    c.OutboxEvent += OnOutboxEvent;
                    _hooked = c;
                }
            }
            return c;
        }
    }

    // The event handlers on the shared client — before anything subscribes it (LiascapePlayerProgram.Sync at serve start):
    // an event or an outbox drain with no handler would be lost.
    internal static void Hook() => _ = C;

    // ---- the command queue: every liascape-player MUTATION from PlayerHelper runs here ------------------
    // PlayerHelper calls its primitives while holding its _lock; nothing under that lock may wait on the
    // player (a stalled one would stall volume/speed/pause/tick). So switches, stop and property sets
    // are queued — one ordered worker, FIFO, off every caller's thread — and return at once. Queries stay
    // synchronous with LiascapePlayerClient.QuickMs (≤ 300 ms, then the stall breaker fails them fast). Every
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
        catch (Exception e) { LiascapePlayerClient.Log($"queued liascape-player command threw: {e.GetBaseException().Message}"); onThrow(); }
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
                LiascapePlayerClient.Log($"liascape-player command queue at its cap ({MaxQueueDepth}, a stalled/overloaded player) — dropping a queued command");
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

    // ---- scene fps per monitor (Phase 2 Task 11) ---------------------------------------------------
    // `SceneMonitors[].Fps` → `out:<name>.scene_fps` (the frame rate scenes shown there render at; live —
    // under liascape-player it is no longer the launch-only exception). `/settings` diffs prev → cur: a new or
    // changed entry sets its fps, a removed one goes back to the player's default (30, D5). Coalescible
    // per output. Every entry is (re)asserted once per player process (`Switch`, R81's reapply), so a
    // fresh or restarted player runs them too. `IsPrimary` has no liascape-player meaning (one worker per scene,
    // every output shows it; its audio is one stream on the bus) — the UI hides it there.
    public const double DefaultSceneFps = 30;

    public static void ApplySceneFps(IReadOnlyList<SceneMonitor>? prev, IReadOnlyList<SceneMonitor> cur)
    {
        var want = SceneFpsMap(cur);
        var had = prev == null ? null : SceneFpsMap(prev);
        foreach (var (name, fps) in want)
            if (had == null || !had.TryGetValue(name, out var f) || f != fps) QueueSceneFps(name, fps);
        if (had != null)
            foreach (var name in had.Keys)
                if (!want.ContainsKey(name)) QueueSceneFps(name, DefaultSceneFps);
    }

    // `SceneMonitors` names are compositor connector names; liascape-player names its outputs the same, with
    // `.`/`:`/`*`/whitespace → `-` (wl.rs `output_name`).
    private static Dictionary<string, double> SceneFpsMap(IEnumerable<SceneMonitor> monitors) =>
        monitors.Where(m => !string.IsNullOrWhiteSpace(m.Name))
            .GroupBy(m => OutputName(m.Name))
            .ToDictionary(g => g.Key, g => Math.Clamp((double)g.Last().Fps, 0, 480));

    private static string OutputName(string n) =>
        new(n.Trim().Select(c => c is '.' or ':' or '*' || char.IsWhiteSpace(c) ? '-' : c).ToArray());

    private static void QueueSceneFps(string output, double fps) =>
        QueueSet("scene_fps:" + output, () => SetSceneFps(C, output, fps));

    private static void SetSceneFps(LiascapePlayerClient client, string output, double fps)
    {
        if (!client.SocketExists) return; // a new player gets them at its first switch
        client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"out:{output}.scene_fps", ["value"] = fps }, LiascapePlayerClient.QuickMs);
    }

    private static int _sceneFpsGen = -1;

    // every SceneMonitors entry onto this player process (a monitor not plugged in: logged, harmless), and the
    // player-level GPU / VRAM settings (a fresh player starts at its own defaults)
    private static void AssertSceneFps(LiascapePlayerClient client, AppSettings s)
    {
        foreach (var (name, fps) in SceneFpsMap(s.SceneMonitors)) SetSceneFps(client, name, fps);
        foreach (var (prop, v) in GpuProps(s)) SetPlayerProp(client, prop, v);
        _sceneFpsGen = client.Generation;
    }

    // ---- scene GPU budget + VRAM (Phase 2 Task 8) ---------------------------------------------------
    // Three player-level props, all live (player-core.md § Scene worker → "GPU budget and VRAM"):
    // `player.scene_throttle` ← AutoThrottleScenes, `player.scene_vram_limit_mib` ← SceneVramLimitMib while
    // LimitVramPerScene (else 0 = off), `player.vram_low_mode` ← VramLowMode. `/settings` diffs prev → cur
    // (coalescible per prop, `player:<prop>`); a new player process gets every one (`AssertSceneFps`).
    public static IReadOnlyList<(string prop, object value)> GpuProps(AppSettings s) =>
    [
        ("scene_throttle", s.AutoThrottleScenes),
        ("scene_vram_limit_mib", s.LimitVramPerScene ? (double)s.SceneVramLimitMib : 0.0),
        ("vram_low_mode", s.VramLowMode),
    ];

    public static void ApplyGpuSettings(AppSettings prev, AppSettings cur)
    {
        var had = GpuProps(prev);
        foreach (var (prop, v) in GpuProps(cur))
            if (!Equals(had.First(h => h.prop == prop).value, v)) QueuePlayerProp(prop, v);
    }

    private static void QueuePlayerProp(string prop, object v) =>
        QueueSet("player:" + prop, () => SetPlayerProp(C, prop, v));

    private static void SetPlayerProp(LiascapePlayerClient client, string prop, object v)
    {
        if (!client.SocketExists) return; // a new player gets them at its first switch / reapply
        client.TryCall("set", new Dictionary<string, object?> { ["path"] = $"player.{prop}", ["value"] = v }, LiascapePlayerClient.QuickMs);
    }

    // ---- transition outcomes, by corr (events + a log-poll safety net) ------------------------
    private static readonly ConcurrentDictionary<string, TaskCompletionSource<string>> _waiters = new();
    private static readonly ConcurrentDictionary<string, (string outcome, long at)> _recent = new();
    private static volatile string? _lastCorr;
    // corr of the most recent switch this process requested (the handoff gate for the next aligned one)
    public static string? LastCorr => _lastCorr;

    private static void OnEvent(string kind, JsonElement e)
    {
        if (kind.StartsWith("program.", StringComparison.Ordinal))
        {
            // the player's rotation (Task 7): the mirror + what the UI is told — no source changed
            LiascapePlayerProgram.OnEvent(kind, e);
            return;
        }
        if (kind == "scene.loudness")
        {
            // a scene's loudness report (the first after ~60 s of audible play, then refined) — no source changed;
            // store + apply off this callback
            StoreLive(e, "OnSceneLoudness", () => { if (SceneLoudnessOf(e) is { } r) OnSceneLoudness(r.Path, r.Key, r.Lufs, r.Peak, r.Seconds, r.Complete, r.State); });
            return;
        }
        // every subscribed kind (LiascapePlayerClient.Topics) may change which sources show which file
        InvalidateSources();
        if (kind == "source.broken")
        {
            // a scene's worker crashed past its restart budget: mark it crashed (skipped unless
            // whitelisted, D6), tell the UI, advance a rotation playing it — off this callback
            var broken = Str(e, "path");
            LiascapePlayerClient.Log($"scene {Path.GetFileName(broken)} is broken ({Str(e, "reason")}; record {Str(e, "record")})");
            StoreLive(e, "OnSceneBroken", () => { if (broken.Length > 0) PlayerHelper.OnSceneBroken(broken); });
            return;
        }
        if (kind == "scene.vram_exceeded")
        {
            // the VRAM guard stopped a scene's worker (Task 8): like a broken scene for playback (a rotation
            // advances), but never marked crashed — the UI says why
            var stopped = Str(e, "path");
            double used = e.TryGetProperty("used_mib", out var u) && u.ValueKind == JsonValueKind.Number ? u.GetDouble() : 0;
            double limit = e.TryGetProperty("limit_mib", out var l) && l.ValueKind == JsonValueKind.Number ? l.GetDouble() : 0;
            LiascapePlayerClient.Log($"scene {Path.GetFileName(stopped)} stopped by the VRAM guard ({used:0} MiB > {limit:0} MiB)");
            StoreLive(e, "OnSceneVramStopped", () => { if (stopped.Length > 0) PlayerHelper.OnSceneVramStopped(stopped, used, limit); });
            return;
        }
        TrackIntent(kind, e);
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

    // A live outbox fact (Phase 3 Task 9): stored off the event thread, its `outbox_seq` acked only once that returned.
    private static void StoreLive(JsonElement e, string what, Action store) =>
        _ = Task.Run(() =>
        {
            try { store(); C.OutboxHandled(e); }
            catch (Exception ex) { LiascapePlayerClient.Log($"{what} threw: {ex.Message}"); }
        });

    // a `scene.loudness` report's fields (live or from the outbox); null = not a usable one
    private sealed record LoudnessReport(string Path, string Key, double Lufs, double? Peak, double Seconds, bool Complete, JsonElement? State);
    private static LoudnessReport? SceneLoudnessOf(JsonElement e)
    {
        var lp = Str(e, "path");
        double? Num(string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
        if (lp.Length == 0 || Num("lufs") is not double lufs || Num("seconds") is not double secs) return null;
        bool complete = e.TryGetProperty("complete", out var cv) && cv.ValueKind == JsonValueKind.True;
        JsonElement? state = e.TryGetProperty("state", out var sv) && sv.ValueKind == JsonValueKind.Object ? sv.Clone() : null;
        // `key`: the source's `loudness_key` (its audio configuration; "" = none)
        return new LoudnessReport(lp, Str(e, "key"), lufs, Num("peak_dbfs"), secs, complete, state);
    }

    // Phase 3 Task 9: an entry of the player's outbox — a fact it recorded while no backend listened (or one this backend
    // also saw live: every handler here is idempotent), drained on (re)subscribing, on the drain's thread. It is acked
    // once this returns, so it stores synchronously. The player already did what playback needed (a rotation advanced);
    // only what the library keeps is done here: `source.broken` → marked crashed (+ the UI told, the program's item
    // skipped) unless it already is; `scene.loudness` → the index (MergeSceneLoudness keeps the longest measurement) and
    // the live normalization; `scene.vram_exceeded` → logged only (UI text of a moment that has passed).
    private static void OnOutboxEvent(string kind, JsonElement f)
    {
        var path = Str(f, "path");
        switch (kind)
        {
            case "source.broken":
                if (path.Length == 0 || LibraryStore.GetMeta(path)?.Crashed == true) return;
                LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} broke while the backend was away ({Str(f, "reason")}) — marking it crashed");
                PlayerHelper.OnSceneBroken(path);
                return;
            case "scene.loudness":
                if (SceneLoudnessOf(f) is { } r) OnSceneLoudness(r.Path, r.Key, r.Lufs, r.Peak, r.Seconds, r.Complete, r.State);
                return;
            case "scene.vram_exceeded":
                double Num(string k) => f.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
                LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} was stopped by the VRAM guard while the backend was away ({Num("used_mib"):0} MiB > {Num("limit_mib"):0} MiB)");
                return;
        }
    }

    // `scene.loudness`: store it under its configuration (`key`; the measurement covering the most audible play wins —
    // MergeSceneLoudness) and, when the applied value moved (≥ 0.5 LU) with normalization on, ramp every live source of
    // that scene to its new `gain.normalize` — the same worker keeps playing.
    private static void OnSceneLoudness(string path, string key, double lufs, double? peak, double seconds, bool complete, JsonElement? state)
    {
        var (stored, applied) = LibraryService.StoreSceneLoudness(path, key, lufs, peak, seconds, complete, state);
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} loudness {lufs.ToString("0.0", inv)} LUFS over {seconds.ToString("0.0", inv)} s"
            + (key.Length > 0 ? $" [{key}]" : "")
            + (complete ? "" : " (partial)") + (!stored ? " — kept the stored one" : applied ? " — stored, applied" : " — stored (< 0.5 LU: not applied)"));
        if (stored) Liascape.Web.SceneLoudnessOps.BroadcastItem(path);
        if (stored) LiascapePlayerProgram.PushItem(path); // its next source continues this measurement (`loudness_seed`)
        if (applied) PlayerHelper.OnLoudnessMeasured(path);
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
    // (inside LiascapePlayerClient.Call's lock for the request-connection case), so it must never block —
    // Queue(...) returns at once; ReapplyAllNow runs later, on the thread pool.
    // The wallpaper too (`ReconcileShown`): queued FIRST — before the waits fail, so an aligned switch
    // the backend re-arms (DoVideoEndWait, "failed:player restarted") is requested after it.
    private static void OnRestarted()
    {
        LiascapePlayerClient.Log("liascape-player restarted (new pid) — pending switch waits end as failed");
        InvalidateSources();
        _recent.Clear();
        _startedAt.Clear();
        _onStarted.Clear();
        _lastCorr = null;
        _alignedCorrs.Clear();
        if (_intent is { } it) _intent = it with { Corr = null }; // corr ids start over in the new process
        QueueEssential(ReconcileShown);
        foreach (var (k, w) in _waiters) { _waiters.TryRemove(k, out _); w.TrySetResult("failed:player restarted"); }
        ReapplyAll();
        LiascapePlayerProgram.OnRestarted();
    }

    // ---- what the screen should show: the backend's model of it (R81 for the wallpaper) ----------
    // A restarted player shows what its snapshot holds, and that can be behind the backend: every write is
    // fsync'ed (2.4 s under I/O load once), so a crash right after a switch brought back the wallpaper
    // BEFORE it — and R81 only re-applied settings, so the screen kept it while the backend and every UI
    // said otherwise. The player can't close that window itself (a switch's reply can't wait for an
    // fsync), so the backend, the one authority on WHAT plays, puts it back.
    // `_intent` = what this backend last put on screen: an align:now switch's B from its request (it
    // shows within ms, or its switch fails), an aligned switch's B from its effect's start (until then A
    // shows and the switch is only armed — DoVideoEndWait re-arms it after a restart), nothing after our
    // `stop`. Unknown (null) when another client switched (a `transition.scheduled` for a path we didn't
    // request — a second backend, `ctl`), our switch failed, or before our first switch: then the
    // player's own state stands.
    private sealed record Intent(string? Path, string? Corr);
    private static volatile Intent? _intent;
    private static volatile string? _requesting; // the path of the `transition` request in flight (its events can beat the reply)
    private static readonly ConcurrentDictionary<string, string> _alignedCorrs = new(); // our armed aligned switches: corr → B's path

    private static void TrackIntent(string kind, JsonElement e)
    {
        var corr = e.TryGetProperty("corr", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
        switch (kind)
        {
            case "transition.scheduled":
                var path = Str(e, "path");
                if (path.Length > 0 && path != _requesting && path != _intent?.Path && !_alignedCorrs.Values.Contains(path))
                    _intent = null; // another client's switch: what shows is theirs
                break;
            case "transition.started" or "transition.handoff" when corr != null && _alignedCorrs.TryGetValue(corr, out var b):
                _intent = new Intent(b, corr); // our aligned switch's effect runs: B shows from here
                if (kind == "transition.handoff") _alignedCorrs.TryRemove(corr, out _);
                break;
            case "transition.cancelled" or "transition.failed" when corr != null:
                _alignedCorrs.TryRemove(corr, out _);
                if (_intent?.Corr == corr) _intent = null; // ours didn't show (failed / taken over): the player's state stands
                break;
        }
    }

    // Queued by OnRestarted, so ordered with every switch and stop: the screen shows `_intent` again. A
    // live transition to it (requested since the restart), or it shown on any layer / parked → nothing.
    // Else a cut to it (or a stop, after our own stop). Any transition settings would do — what matters
    // is that the screen and the backend agree again.
    private static void ReconcileShown()
    {
        var intent = _intent;
        var client = C;
        if (intent == null || !client.SocketExists) return;
        // a rotation: the player owns what shows (its program restored with the snapshot, R81 re-loads one it lost —
        // LiascapePlayerProgram.Reapply); a backend switch from before the program must not be put back
        if (LiascapePlayerProgram.Owns) return;
        var shown = ShownOrIncoming(client, parked: true);
        if (shown == null) return; // no answer: R81's reapply logs it; the next switch catches up anyway
        if (intent.Path == null)
        {
            if (shown.Count == 0) return;
            LiascapePlayerClient.Log($"liascape-player restarted showing {string.Join(", ", shown.Select(Path.GetFileName))} after the backend stopped — stopping it");
            Stop();
            return;
        }
        if (shown.Contains(intent.Path)) return;
        LiascapePlayerClient.Log($"liascape-player restarted showing {(shown.Count > 0 ? string.Join(", ", shown.Select(Path.GetFileName)) : "nothing")}"
            + $" (its snapshot was behind) — the backend last switched to {Path.GetFileName(intent.Path)}: switching back (cut)");
        Interlocked.Increment(ref _reconciles);
        Switch(intent.Path, SettingsService.Load(), null, alignEnd: false);
    }

    private static int _reconciles;
    // how many times a restart's screen was put back to the backend's last switch — self-test/IT evidence
    public static int Reconciles => Volatile.Read(ref _reconciles);

    // R81, the other half: a mutation made while the stall breaker was open is dropped, not queued
    // (LiascapePlayerClient.QuickMs + the breaker — see the "Threading" section of player-adapter.md) and
    // never replayed on its own. The breaker closing (the player answered again) is exactly the moment
    // to catch up — same fire-and-forget Queue, same reasoning as OnRestarted above.
    private static void OnRecovered()
    {
        LiascapePlayerClient.Log("liascape-player answered again after a stall — re-applying settings (R81)");
        ReapplyAll();
        LiascapePlayerProgram.Reapply();
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
        AssertSceneFps(client, SettingsService.Load());
        var cur = CurrentPath();
        // I3 (final review): pause is NOT re-asserted. Its one authority is the player itself
        // (`player.paused`, persisted in its snapshot and restored with it): a keybind toggle runs
        // in a separate one-shot CLI process, and a restarted backend has no memory of it, so any
        // copy kept here goes stale and flipped the pause on its own after a crash/stall.
        bool? paused = null;
        try { paused = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LiascapePlayerClient.QuickMs).GetProperty("value").ValueKind == JsonValueKind.True; }
        catch (LiascapePlayerException) { }
        LiascapePlayerClient.Log("liascape-player: re-applied effective settings" + (cur != null ? $" for {Path.GetFileName(cur)}" : " (nothing playing)")
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

    private static string? Poll(LiascapePlayerClient client, string corr, int gen0)
    {
        try
        {
            var logs = client.Call("logs", new Dictionary<string, object?> { ["corr"] = corr, ["kind_prefix"] = "transition." });
            if (client.Generation != gen0) return "failed:player restarted";
            foreach (var ev in logs.GetProperty("events").EnumerateArray())
                if (OutcomeOf(Str(ev, "kind"), ev) is { } o) return o;
            return null;
        }
        catch (LiascapePlayerException e) when (e.Code == "io") { return client.SocketExists ? null : "failed:player gone"; }
        catch (LiascapePlayerException) { return null; }
    }

    // ---- switches --------------------------------------------------------------------------------
    private static readonly string[] ImageExt = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".avif", ".jxl", ".tif", ".tiff"];
    // a still image the player shows (`kind: image`) — it never ends (PlayerHelper.PlayKindOf, the rotation's rules)
    public static bool IsImagePath(string path) => ImageExt.Contains(Path.GetExtension(path).ToLowerInvariant());

    // B's create props: everything the legacy launch/loadfile carried, as live properties — the
    // resolver's own per-source computation (`Desired`, every resolved prop) + path, kind and loop.
    public static Dictionary<string, object?> SourceProps(string path, AppSettings s)
    {
        bool scene = PlayerHelper.IsScenePath(path); // a scene's play path is its item folder (library.md)
        var props = new Dictionary<string, object?>
        {
            ["path"] = path,
            ["kind"] = scene ? "scene" : IsImagePath(path) ? "image" : "video",
            ["loop"] = s.Loop,
        };
        // Phase 2: what the player shows while no worker frame exists (a crash before the first frame,
        // a broken scene — player-core.md § Scene worker); the video-only props are stored, no effect
        if (scene && LibraryService.PreviewImageOf(path) is string preview) props["preview"] = preview;
        // the scene's loudness measured over its earlier plays of its current audio configuration (`loudness_key`, a
        // resolver value), else that configuration's estimate (10 s of play): this source continues it (create only —
        // never a resolver value: a live source already holds that measurement plus its own play since; a key change
        // sends the new configuration's with it — ResolveNow)
        if (scene && LibraryService.SceneLoudnessSeed(path) is JsonElement seed) props["loudness_seed"] = seed;
        foreach (var (k, v) in Desired(path, () => s, PlayerHelper.IsMuted, null, item: false)) props[k] = v;
        return props;
    }

    // A program's `defaults` (plan 2026-10-29 Task 7, designer call 2): what every new B of a rotation runs unless its
    // item says otherwise — the resolver's values with no item (the globals: volume, speed, decode/buffer settings, the
    // mute; no `af` — loudnorm is per item) + kind `video` and the Loop setting. `DesiredItem(path)` = what a new source
    // of `path` gets (SourceProps minus `path`); the program carries only the entries that differ from these.
    public static Dictionary<string, object?> DesiredGlobal(AppSettings s)
    {
        var d = new Dictionary<string, object?> { ["kind"] = "video", ["loop"] = s.Loop };
        foreach (var (k, v) in Desired(null, () => s, PlayerHelper.IsMuted, null, item: false)) d[k] = v;
        return d;
    }

    public static Dictionary<string, object?> DesiredItem(string path, AppSettings s)
    {
        var d = SourceProps(path, s);
        d.Remove("path");
        return d;
    }

    private static string HwDec(AppSettings s) => string.IsNullOrWhiteSpace(s.HwDec) ? "no" : s.HwDec.Trim();

    // A scene's `gain.normalize` (dB) under `s`: its learned loudness (LibMeta.LoudnessI, the player's
    // `scene.loudness`) brought to NormalizeTargetLufs — like the video loudnorm's linear mode, never boosted past
    // −1.5 dBFS at its sample peak (a plain gain has no limiter), clamped to −60…+24 dB. 0 = off / not learned
    // yet. NoAudio doesn't zero it: the stream is silent anyway, and un-muting then comes back at the right level.
    public const double NormalizePeakCeilingDb = -1.5;
    public static double SceneNormalizeDb(LibMeta? meta, AppSettings s)
    {
        if (!s.NormalizeAudio || meta?.LoudnessI is not double i || !double.IsFinite(i)) return 0.0;
        double g = s.NormalizeTargetLufs - i;
        if (meta.LoudnessTP is double peak && double.IsFinite(peak)) g = Math.Min(g, NormalizePeakCeilingDb - peak);
        return Math.Round(Math.Clamp(g, -60.0, 24.0), 3);
    }

    // `gain.normalize` changes as a ramp, never a step (a loudness landing mid-play, a target change) — long
    // enough to be inaudible as a jump, short enough to read as "applied at once".
    public const int NormalizeRampMs = 500;

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
    // (LiascapePlayerClient.UpgradeInPlace): before every switch (Switch above), and from this 10 s check
    // while nothing is switching — never across an armed align:end switch (the restart would drop it
    // and the rotation would switch early, failure path), so an advance-on-end playlist upgrades at
    // its next switch. Queued: ordered with switches, so one queued before the check runs first.
    private static System.Threading.Timer? _upgradeWatch;
    public static void StartUpgradeWatch() => _upgradeWatch ??= new System.Threading.Timer(_ => UpgradeWatchTick(), null, 10_000, 10_000);

    private static void UpgradeWatchTick()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
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

    // Phase 3 Task 7: a rotation program switches inside the player, and under advance-on-end its next end-of-video
    // switch is armed right after each handoff — the 10 s check never finds a quiet moment. So at each program commit
    // (`program.current`): once its effect handed off — only an ARMED switch left, which the program's snapshot re-arms
    // for A's end after the restart (player-core.md § Programs, Persistence) — a stale player is upgraded.
    private static int _upgradeAtCommit;
    public static void UpgradeAfterCommit()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        var client = C;
        if (client.StaleReason() == null || Interlocked.Exchange(ref _upgradeAtCommit, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                for (int i = 0; i < 150 && Running(client); i++) await Task.Delay(100).ConfigureAwait(false);
                await QueueEssential(() =>
                {
                    if (client.StaleReason() is not string why || Running(client)) return;
                    client.UpgradeInPlace(why + " — at a rotation's switch");
                    InvalidateSources();
                }).ConfigureAwait(false);
            }
            finally { Interlocked.Exchange(ref _upgradeAtCommit, 0); }
        });
    }

    // a transition past its arming and not done (scheduled / waiting_ready / running / handoff); unknown → yes
    private static bool Running(LiascapePlayerClient client)
    {
        try
        {
            var st = client.Call("state", null, LiascapePlayerClient.QuickMs);
            return st.TryGetProperty("transitions", out var t) && t.ValueKind == JsonValueKind.Array
                && t.EnumerateArray().Any(x => Str(x, "phase") is not ("waiting_start" or "done"));
        }
        catch (LiascapePlayerException) { return true; }
    }

    // any transition not yet done (armed, waiting, running, handing off); unknown → treated as yes
    private static bool Switching(LiascapePlayerClient client)
    {
        try
        {
            var st = client.Call("state", null, LiascapePlayerClient.QuickMs);
            return st.TryGetProperty("transitions", out var t) && t.ValueKind == JsonValueKind.Array
                && t.EnumerateArray().Any(x => Str(x, "phase") != "done");
        }
        catch (LiascapePlayerException) { return true; }
    }

    // `transition {outputs:"out:*", to:{path, props}, effect from Pick(tcfg) or null (cut), method, align}`.
    // Returns the corr (or null when the player can't be reached / refused — logged with its hint).
    public static string? Switch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)
    {
        try { return SwitchCore(path, s, tcfg, alignEnd); }
        finally { InvalidateSources(); } // a new B (and maybe an upgraded player): re-read the map next time
    }

    // Before anything that puts a wallpaper on screen (our switch, a program load — on the queue's worker): a running,
    // current player (an older build is upgraded in place first: A comes back as it was), its events subscribed, the
    // layer fit and the per-monitor scene fps asserted. null = no player could be started.
    internal static LiascapePlayerClient? Ready(AppSettings s)
    {
        var client = C;
        if (!client.EnsureRunning()) return null;
        if (client.StaleReason() is string why) client.UpgradeInPlace(why); // A comes back as it was, then switches
        client.StartEvents();
        // VideoScale is a layer property; (re)assert it so a hotplugged output or an engine switch
        // matches. item 6: QuickMs — a plain property set, not worth the 2000 ms default.
        client.TryCall("set", new Dictionary<string, object?> { ["path"] = "lay:*:main.fit", ["value"] = Fit(s) }, LiascapePlayerClient.QuickMs);
        if (_sceneFpsGen != client.Generation) AssertSceneFps(client, s); // once per player process
        return client;
    }

    // A program (LiascapePlayerProgram) owns what shows from here: no backend switch to put back after a restart.
    internal static void ForgetIntent()
    {
        _intent = null;
        _alignedCorrs.Clear();
    }

    private static string? SwitchCore(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)
    {
        if (Ready(s) is not { } client) return null;
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
        _requesting = path; // its `transition.scheduled` is ours, even when it beats the reply
        try { return Requested(client.Call("transition", req), path, alignEnd); }
        catch (LiascapePlayerException e) when (e.Code == "no_such_effect" && pick != null)
        {
            LiascapePlayerClient.Log($"effect {pick.Value.effectId} not in liascape-player's catalogue ({e.Hint}) → cut");
            req["effect_id"] = null;
            req.Remove("params"); req.Remove("duration_ms"); req.Remove("method");
            try { return Requested(client.Call("transition", req), path, alignEnd); }
            catch (LiascapePlayerException e2) { LiascapePlayerClient.Log($"transition to {Path.GetFileName(path)} failed — {e2}"); return null; }
        }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"transition to {Path.GetFileName(path)} failed — {e}"); return null; }
        finally { _requesting = null; }
    }

    private static string? Requested(JsonElement res, string path, bool alignEnd)
    {
        var corr = Str(res, "corr");
        if (corr.Length == 0) return null;
        _lastCorr = corr;
        if (alignEnd) _alignedCorrs[corr] = path; // shows from its effect's start (TrackIntent)
        else _intent = new Intent(path, corr);
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

    private static async Task<string> WaitSwitch(LiascapePlayerClient client, string corr, bool alignEnd, double? remaining, double? lastPos, CancellationToken ct)
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
            LiascapePlayerClient.Log($"aligned switch {corr} not handed off within {bound} ms — cancelling it (the caller switches now)");
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LiascapePlayerException) { } // already handed off / superseded meanwhile
            InvalidateSources();
        }
        if (outcome == "caller-cancelled")
        {
            try { client.Call("cancel", new Dictionary<string, object?> { ["corr"] = corr }); }
            catch (LiascapePlayerException e) when (e.Code is "no_such_node" or "unsupported") { } // superseded / already handed off
            catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"cancel {corr} failed — {e}"); }
            InvalidateSources();
        }
        return outcome;
    }

    // Seconds past A's remaining play time an aligned switch is waited for (M2) — behind the
    // player's own 10 s `align_fallback`, so the player normally resolves it first.
    // LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC shortens it for scripts/test-liascape-player-adapter.sh only.
    public static readonly double AlignBackstopSlackSec =
        double.TryParse(Environment.GetEnvironmentVariable("LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC"),
            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var slack) && slack > 0
            ? slack : 15;

    private static int BackstopMs(double? remainingSec) =>
        (int)Math.Min(int.MaxValue - 1, ((remainingSec ?? 0) + AlignBackstopSlackSec) * 1000);

    // An aligned switch's backstop expired: may it keep waiting, and how long until the next check?
    // No output (I4: the player holds the switch until one shows it) or the player paused (its clock
    // and the switch stand still) → yes. Otherwise only while A (what `cur:*` shows) still plays on,
    // for its remaining time at its current speed + slack; A not moving since the last check (a
    // stall), or no answer → give up (cancel, the caller switches now).
    private static (bool wait, int boundMs, double? pos) AlignedWaitCheck(LiascapePlayerClient client, double? lastPos)
    {
        if (!HasOutputs(client)) return (true, BackstopMs(0), lastPos);
        try
        {
            if (client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LiascapePlayerClient.QuickMs)
                    .GetProperty("value").ValueKind == JsonValueKind.True)
                return (true, BackstopMs(0), lastPos);
        }
        catch (LiascapePlayerException) { return (false, 0, lastPos); }
        if (Query("time_pos") is not double pos || TimeRemaining() is not double rem) return (false, 0, lastPos);
        if (lastPos is double lp && Math.Abs(pos - lp) < 1e-3) return (false, 0, pos);
        return (true, BackstopMs(rem), pos);
    }

    // Whether the player has any output (false = R60 parked: monitors off / unplugged).
    private static bool HasOutputs(LiascapePlayerClient client)
    {
        try
        {
            var st = client.Call("state", null, LiascapePlayerClient.QuickMs);
            return st.TryGetProperty("outputs", out var o) && o.ValueKind == JsonValueKind.Array && o.GetArrayLength() > 0;
        }
        catch (LiascapePlayerException) { return true; } // unknown → treat as shown (don't wait forever)
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
        _intent = new Intent(null, null); // nothing shows from here (a restart's snapshot can't bring one back)
        _alignedCorrs.Clear();
        if (client.SocketExists) client.TryCall("stop", null, LiascapePlayerClient.QuickMs); // item 6
        InvalidateSources();
    }

    // Switching AWAY from liascape-player (synchronous, call it OUTSIDE PlayerHelper's _lock): whatever is
    // queued runs (bounded), playback stops, the process is gone (quit → SIGTERM → SIGKILL) — so the
    // other engine never starts while liascape-player still shows something.
    public static void StopAndQuit()
    {
        var client = C;
        try { Drain().Wait(3000); } catch { }
        if (client.SocketExists) { try { client.Call("stop", null, LiascapePlayerClient.QuickMs); } catch (LiascapePlayerException) { } }
        client.QuitOrKill();
        InvalidateSources();
        _lastCorr = null;
        _intent = null; // no player: nothing to put back
        _alignedCorrs.Clear();
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
    //   gain.normalize (scenes only) = SceneNormalizeDb(its learned loudness, the target) — 0 off / not
    //               learned yet; sent as `animate` over NormalizeRampMs (a landing mid-play ramps, never steps)
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
        public IReadOnlyDictionary<string, JsonElement>? ItemSceneProps { get; init; } // a scene-property drag (WE values)
        public IReadOnlySet<string>? Props { get; init; }         // null = every resolved prop (+ fit)
        public bool Fresh { get; init; }                          // diff against a new `state` read
        public bool Force { get; init; }                          // send even when the source already runs it
    }

    private static readonly IReadOnlySet<string> GainUser = new HashSet<string> { "gain.user" };
    private static readonly IReadOnlySet<string> SpeedOnly = new HashSet<string> { "speed" };
    private static readonly IReadOnlySet<string> PerItem = new HashSet<string> { "gain.user", "speed" };
    private static readonly IReadOnlySet<string> MuteOnly = new HashSet<string> { "gain.mute" };
    private static readonly IReadOnlySet<string> ScenePropsOnly = new HashSet<string> { "scene_props" };
    private static readonly IReadOnlySet<string> SceneConfig = new HashSet<string> { "scene_props", "loudness_key", "gain.normalize" };
    private static readonly IReadOnlySet<string> SceneLoudnessProps = new HashSet<string> { "loudness_key", "gain.normalize" };

    // A scene item's user properties (its index overrides, `SceneProperties.PlayerMap`) onto its source(s) —
    // on screen, either side of an effect, a pending B. `/library/scene-props` after the save. A property whose
    // override went (a reset) gets its default sent (LWE has no reset; `WithResets`). Property-aware loudness: the
    // scene's sound is re-planned first (`liascape-player scene-loudness --props`, a re-mix from the per-file cache:
    // ~1 ms + the spawn; off the request thread) → its configuration's fingerprint → the index (its estimate; the
    // current configuration) → ONE pass on the item's sources: `scene_props`, `loudness_key` + that configuration's
    // `loudness_seed` (its live measurement, else its estimate), `gain.normalize` ramped over 500 ms (its live value,
    // else its estimate). Coalescible per item: the pass re-reads the index when it runs; re-plans are serialized.
    // A drag preview (or another commit) of the item queued while this one re-planned already carried every saved
    // property (its pass reads the index too): this pass then leaves `scene_props` alone — sent after it, it would
    // revert the preview's live values (IT "preview color blue → live").
    private static readonly ConcurrentDictionary<string, long> _scenePropsSeq = new();
    private static long NextScenePropsSeq(string path) => _scenePropsSeq.AddOrUpdate(FullPath(path), 1, (_, n) => n + 1);
    public static void ApplySceneProps(string path)
    {
        long seq = NextScenePropsSeq(path);
        _ = Task.Run(() =>
        {
            try { Replan(path); }
            catch (Exception e) { LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} re-plan failed: {e.Message}"); }
            bool latest = _scenePropsSeq.TryGetValue(FullPath(path), out var now) && now == seq;
            QueueSet("sceneprops:" + FullPath(path), () =>
                ResolveNow(new Req { Items = [path], OnlyItems = true, Props = latest ? SceneConfig : SceneLoudnessProps }));
            LiascapePlayerProgram.PushItem(path);
        });
    }

    // The re-plan alone (the legacy engine: nothing live, the stored configuration still follows the props).
    public static void ReplanInBackground(string path)
    {
        if (PlayerEngine.ResolveBinary() == null || !PlayerHelper.IsScenePath(path)) return;
        _ = Task.Run(() => { try { Replan(path); } catch (Exception e) { LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} re-plan failed: {e.Message}"); } });
    }

    private static readonly object _replanLock = new();
    private static void Replan(string path)
    {
        lock (_replanLock)
        {
            var sw = Stopwatch.StartNew();
            if (SceneLoudnessPlanner.Estimate(path, background: false, CancellationToken.None, out var err) is not { } plan)
            {
                LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} not re-planned ({err}) — its loudness configuration stays");
                return;
            }
            long planMs = sw.ElapsedMilliseconds;
            var (stored, applied, fpChanged) = SceneLoudnessPlanner.Store(path, plan);
            LiascapePlayerClient.Log($"scene {Path.GetFileName(path)} re-planned in {sw.ElapsedMilliseconds} ms (estimate {planMs} ms): {plan.Fingerprint}"
                + (fpChanged ? " (new configuration)" : "") + (applied ? ", applied changed" : ""));
            if (stored) Liascape.Web.SceneLoudnessOps.BroadcastItem(path);
        }
    }

    // A scene's estimate landed (the background queue — Web/SceneLoudnessOps): its live source(s) take its current
    // configuration's `loudness_key` (+ seed) and `gain.normalize` (ramped). Coalescible per item.
    public static void ApplySceneLoudness(string path)
    {
        QueueSet("sceneloudness:" + FullPath(path), () =>
            ResolveNow(new Req { Items = [path], OnlyItems = true, Props = SceneLoudnessProps }));
        LiascapePlayerProgram.PushItem(path);
    }

    // `/library/scene-props/preview` (the modal's drag twin, nothing persisted): `values` over the saved overrides,
    // on that item's source(s) only. Coalescible per item + property set.
    public static void PreviewSceneProps(string path, IReadOnlyDictionary<string, JsonElement> values)
    {
        NextScenePropsSeq(path);
        QueueSet("preview:scene_props:" + FullPath(path) + ":" + string.Join(",", values.Keys.Order(StringComparer.Ordinal)), () =>
            ResolveNow(new Req { Items = [path], OnlyItems = true, Props = ScenePropsOnly, ItemSceneProps = values }));
    }

    // Every setting the resolver owns, live, from the settings as they are now — /settings, the volume key
    // on the global, normalization, a loudness measurement landing.
    // A rotation's next B gets the same values: the program's `defaults` (and every item's own, e.g. a loudness landed).
    public static void ApplyEffective()
    {
        QueueSet("resolve", () => ResolveNow(new Req { Fresh = true }));
        LiascapePlayerProgram.PushDefaults();
        LiascapePlayerProgram.PushItems();
    }

    // `path`'s own volume/speed (its override ?? the global) onto its source(s) — wherever they are (on
    // screen, either side of an effect, a pending B). `onPlayingSpeed` gets its effective speed when it is
    // what `cur:*` shows (the timed tick's speed factor). Coalescible per item: it re-reads the override.
    public static void ApplyOverride(string path, Action<double>? onPlayingSpeed = null)
    {
        QueueSet("override:" + FullPath(path), () =>
        {
            if (ResolveNow(new Req { Items = [path], OnlyItems = true, Props = PerItem }) == 0 || onPlayingSpeed == null) return;
            if (SamePath(CurrentPath(), path))
                onPlayingSpeed(Math.Clamp(LibraryService.ReadSpeedOverride(path) ?? SettingsService.Load().Speed, 0.1, 4.0));
        });
        LiascapePlayerProgram.PushItem(path); // a rotation's next B of it
    }

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
    // `path` null = no item: the globals' values (a program's `defaults` — DesiredGlobal), never an item's own.
    private static Dictionary<string, object> Desired(string? path, Func<AppSettings> settings, bool muted, Req? r, bool item)
    {
        var props = r?.Props;
        bool Want(string p) => props == null || props.Contains(p);
        bool scene = path != null && PlayerHelper.IsScenePath(path);
        LibMeta? meta = null; bool metaRead = path == null;
        LibMeta? Meta() { if (!metaRead) { meta = LibraryStore.GetMeta(path!); metaRead = true; } return meta; }
        var d = new Dictionary<string, object>();
        if (Want("gain.user"))
            d["gain.user"] = (item ? r!.ItemGainDb : null)
                ?? (Meta()?.Volume is int ov ? MpvPropertyMap.VolumeDb(ov) : (double?)null)
                ?? r?.GlobalGainDb ?? MpvPropertyMap.VolumeDb(settings().Volume);
        if (Want("speed"))
            d["speed"] = Math.Clamp((item ? r!.ItemSpeed : null) ?? Meta()?.Speed ?? r?.GlobalSpeed ?? settings().Speed, 0.1, 4.0);
        if (Want("af")) d["af"] = (path != null ? NormalizeAf(path, settings()) : null) ?? "";
        if (Want("no_audio")) d["no_audio"] = settings().NoAudio;
        if (Want("hwdec")) d["hwdec"] = HwDec(settings());
        if (Want("fps_cap")) d["fps_cap"] = (double)Math.Max(0, settings().VideoFpsCap);
        if (Want("cache")) d["cache"] = !settings().DisableCache;
        if (Want("demuxer_max_mib")) d["demuxer_max_mib"] = (double)Math.Max(0, settings().DemuxerMaxMib);
        if (Want("demuxer_back_mib")) d["demuxer_back_mib"] = (double)Math.Max(0, settings().DemuxerMaxBackMib);
        if (Want("gain.mute")) d["gain.mute"] = muted ? MpvPropertyMap.SilentDb : 0.0;
        // a scene's user properties: its overrides (+ a drag's transient values) — defaults aren't sent, LWE
        // loads them itself; `WithResets` adds the default of one the source still runs from an earlier override
        if (Want("scene_props") && scene)
            d["scene_props"] = JsonSerializer.SerializeToElement(
                SceneProperties.PlayerMap(path!, Meta()?.SceneProps, item ? r!.ItemSceneProps : null));
        // ordered after scene_props: the scene's audio configuration (the estimator's fingerprint of its props; "" =
        // never estimated) — the player keeps one measurement per (path, key); a change sends the new configuration's
        // seed right after it (ResolveNow)
        if (Want("loudness_key") && scene && C.Capabilities.Contains("scene_loudness_key"))
            d["loudness_key"] = Meta()?.SceneLoudnessFp ?? "";
        // a scene's loudness normalization: its current configuration's loudness (live, else estimated) → a plain
        // gain (0 until known / when off)
        if (Want("gain.normalize") && scene) d["gain.normalize"] = SceneNormalizeDb(Meta(), settings());
        return d;
    }

    // `want` (an item's scene_props map) + the default of every property `have` (what the source runs) still
    // carries and `want` doesn't: the player keeps a removed key's value until the next open, so a reset sends
    // the default explicitly. A name no editable property of the scene has any more is dropped.
    private static object WithResets(string path, JsonElement want, object? have)
    {
        if (have is not JsonElement { ValueKind: JsonValueKind.Object } h) return want;
        Dictionary<string, object?>? merged = null;
        foreach (var p in h.EnumerateObject())
        {
            if (want.TryGetProperty(p.Name, out _)) continue;
            if (SceneProperties.PlayerDefault(path, p.Name) is not { } def) continue;
            merged ??= want.EnumerateObject().ToDictionary(x => x.Name, x => (object?)x.Value);
            merged[p.Name] = def;
        }
        return merged == null ? want : JsonSerializer.SerializeToElement(new SortedDictionary<string, object?>(merged, StringComparer.Ordinal));
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
                    foreach (var (prop, v0) in want)
                    {
                        var v = prop == "scene_props" && v0 is JsonElement sp ? WithResets(path, sp, have.GetValueOrDefault(prop)) : v0;
                        if (!r.Force && have.TryGetValue(prop, out var h) && Same(h, v)) continue;
                        var sent = Send(client, id, prop, v);
                        if (sent == Sent.Ok) have[prop] = v;
                        // a new audio configuration: the source continues THAT configuration's measurement — its live
                        // state, else its estimate's 10 s seed ({} = nothing: the player's book may still hold some)
                        if (sent == Sent.Ok && prop == "loudness_key")
                        {
                            object seed = LibraryService.SceneLoudnessSeed(path) is JsonElement sd ? sd : new Dictionary<string, object>();
                            if (Send(client, id, "loudness_seed", seed) == Sent.Ok) have["loudness_seed"] = seed;
                        }
                        else if (sent == Sent.Stalled) return covered; // the rest would fail fast too; R81 catches up
                        else if (sent == Sent.Gone) { stale = true; break; } // retired meanwhile: its other props too
                    }
                }
            }
            if (r.Fresh && (r.Props == null || r.Props.Contains("fit")) && live.LayerFit.Any(f => f != Fit(S())))
                client.TryCall("set", new Dictionary<string, object?> { ["path"] = "lay:*:main.fit", ["value"] = Fit(S()) }, LiascapePlayerClient.QuickMs);
            if (!stale) return covered;
            InvalidateSources(); // a source went (a switch meanwhile): new ones may have come — once more, re-read
        }
        return 0;
    }

    // `set <id>.<prop>` (gain.mute: `animate` over 30 ms — never a step). item 6: QuickMs, never the
    // 2000 ms default — a queued property set.
    private static Sent Send(LiascapePlayerClient client, string id, string prop, object v)
    {
        try
        {
            if (prop == "gain.mute")
                client.Call("animate", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["to"] = v, ["duration_ms"] = 30 }, LiascapePlayerClient.QuickMs);
            else if (prop == "gain.normalize")
                client.Call("animate", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["to"] = v, ["duration_ms"] = NormalizeRampMs }, LiascapePlayerClient.QuickMs);
            else
                client.Call("set", new Dictionary<string, object?> { ["path"] = $"{id}.{prop}", ["value"] = v }, LiascapePlayerClient.QuickMs);
            return Sent.Ok;
        }
        catch (LiascapePlayerException e) when (e.Code == "no_such_node") { return Sent.Gone; }
        catch (LiascapePlayerException e) when (e.Code is "timeout" or "io")
        {
            LiascapePlayerClient.Log($"set {id}.{prop} failed — {e} (rest of this pass skipped; R81 re-applies)");
            return Sent.Stalled;
        }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"set {id}.{prop}={v} failed — {e}"); return Sent.Failed; }
    }

    private static bool Same(object? have, object want) => (have, want) switch
    {
        (JsonElement a, JsonElement b) => JsonSame(a, b),
        (double a, double b) => Math.Abs(a - b) <= 1e-4,
        (null, _) => false,
        _ => have.Equals(want),
    };

    // Two JSON values alike (a Map prop: what the player reports vs what we'd send) — numbers within 1e-6
    // (the player's f64s round-trip, a C# double prints differently from serde's), objects by key set.
    internal static bool JsonSame(JsonElement a, JsonElement b)
    {
        if (a.ValueKind == JsonValueKind.Number && b.ValueKind == JsonValueKind.Number) return Math.Abs(a.GetDouble() - b.GetDouble()) <= 1e-6;
        if (a.ValueKind != b.ValueKind) return false;
        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
                var ap = a.EnumerateObject().ToList();
                if (ap.Count != b.EnumerateObject().Count()) return false;
                foreach (var p in ap) if (!b.TryGetProperty(p.Name, out var bv) || !JsonSame(p.Value, bv)) return false;
                return true;
            case JsonValueKind.Array:
                if (a.GetArrayLength() != b.GetArrayLength()) return false;
                return a.EnumerateArray().Zip(b.EnumerateArray()).All(z => JsonSame(z.First, z.Second));
            case JsonValueKind.String: return a.GetString() == b.GetString();
            default: return true; // true/false/null: same kind = same value
        }
    }

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
        try { return Targets(client.Call("set", new Dictionary<string, object?> { ["path"] = path, ["value"] = value }, LiascapePlayerClient.QuickMs)); }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"set {prop}={value} failed — {e}"); return []; }
    }

    // The mpv IPC args PlayerHelper.SendCommand/TrySendCommand still build. Property sets go through
    // MpvPropertyMap: a volume/speed literal (`/volume {value}`) is the PLAYING item's transient value in
    // a resolver pass (every other source keeps its own — never a `srcs:*` broadcast); a mute change is a
    // forced resolver pass from PlayerHelper.IsMuted (SetMute / SetUserMute send exactly that); anything
    // else → `Set`. `cycle pause` toggles; mpv-playlist plumbing (loadfile/playlist-*/loop-file/
    // loop-playlist) has no liascape-player meaning — liascape's timed machinery owns rotation and the
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
        if (t.prop == "gain.mute") LiascapePlayerProgram.PushDefaults(); // a rotation's next B starts muted / unmuted too
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
        return client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = now }, LiascapePlayerClient.QuickMs) != null;
    }

    // `get player.paused` (null = no player / no answer). Synchronous but quick (QuickMs).
    public static bool IsPlayerPaused() => C is { SocketExists: true } client && PlayerPaused(client) == true;

    private static bool? PlayerPaused(LiascapePlayerClient client)
    {
        try
        {
            var v = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }, LiascapePlayerClient.QuickMs).GetProperty("value");
            return v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
        }
        catch (LiascapePlayerException) { return null; }
    }

    // I1 (final review): a NEW wallpaper session (Apply / ApplyPlaylist / a cold Launch) starts
    // playing, as with legacy (a fresh mpvpaper is never paused) — a pause belongs to the session
    // it was made in. Queued (callers hold PlayerHelper's _lock), ahead of the session's switch.
    // (`stop` clears the player's pause on its own.)
    public static void QueueNewSession() => QueueEssential(() =>
    {
        var client = C;
        if (client.SocketExists)
            client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = false }, LiascapePlayerClient.QuickMs);
    });

    // ---- queries -----------------------------------------------------------------------------------
    public static bool IsPlaying() => CurrentPath() != null;

    public static string? CurrentPath() =>
        GetCur("path") is JsonElement { ValueKind: JsonValueKind.String } v && v.GetString() is { Length: > 0 } s ? s : null;

    public static double? Query(string prop) =>
        GetCur(prop) is JsonElement { ValueKind: JsonValueKind.Number } v ? v.GetDouble() : null;

    // mpv property names the legacy queries use → liascape-player
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
        const int q = LiascapePlayerClient.QuickMs;
        try { return client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:*.{prop}" }, q).GetProperty("value"); }
        catch (LiascapePlayerException e) when (e.Code == "ambiguous")
        {
            try
            {
                var st = client.Call("state", null, q);
                var first = st.GetProperty("outputs").EnumerateArray().Select(o => Str(o, "name")).FirstOrDefault(n => n.Length > 0);
                if (first == null) return null;
                return client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:{first}.{prop}" }, q).GetProperty("value");
            }
            catch (LiascapePlayerException) { return null; }
        }
        catch (LiascapePlayerException) { return null; } // no_such_node = nothing shown; io = no player
    }

    private static JsonElement? Graph(LiascapePlayerClient client)
    {
        if (!client.SocketExists) return null;
        try { return client.Call("state", null, LiascapePlayerClient.QuickMs).GetProperty("graph"); } // item 6
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"state failed — {e}"); return null; }
    }

    // Paths on screen now or about to be: every layer's content (an effect's incoming side, never its
    // outgoing one — that is leaving anyway) plus the B of every requested switch that isn't an aligned
    // one still waiting for A's end (the rotation retargets those). `cur:*` alone misses a switch that
    // was requested but isn't running yet (trashing an item right after applying it kept it playing).
    // A still-queued switch is waited for (bounded) so it counts too.
    public static List<string> ShownOrIncomingPaths()
    {
        var client = C;
        if (!client.SocketExists) return [];
        try { Drain().Wait(1000); } catch { }
        return ShownOrIncoming(client, parked: false) ?? [];
    }

    // One `state` read (no drain — ReconcileShown runs ON the queue's worker): every layer's content (an
    // effect's `to`), each requested switch's B unless it's an aligned one waiting for A's end, and with
    // `parked` the parked wallpaper (no output: what the next one shows). null = no answer.
    private static List<string>? ShownOrIncoming(LiascapePlayerClient client, bool parked)
    {
        var paths = new List<string>();
        JsonElement st;
        try { st = client.Call("state", null, LiascapePlayerClient.QuickMs); }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"state failed — {e}"); return null; }
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
        if (parked && st.TryGetProperty("parked", out var pk) && pk.ValueKind == JsonValueKind.String) Add(PathOf(pk.GetString()!));
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
    // (LiascapePlayerClient.Topics), a restart through Generation + OnRestarted. It is only trusted while the
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
    private static Live? CachedLive(LiascapePlayerClient client)
    {
        client.StartEvents(); // idempotent; the map is cached only once events flow
        lock (_srcLock)
            if (_live != null && _liveGen == client.Generation && client.EventsLive) return _live;
        return ReadLive(client);
    }

    // one `state` read (null = no answer); stored as the cache unless something invalidated it meanwhile
    private static Live? ReadLive(LiascapePlayerClient client)
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
                JsonValueKind.Object => p.Value.Clone(), // a Map prop (`scene_props`), diffed by JsonSame
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
    // A `pactl list sink-inputs` block belongs to liascape-player when its process is the player (pid from
    // `hello`), its node is one of the player's (`liascape-player-bus*`, a scene worker's `liascape-player-scene.<id>`),
    // it targets the `liascape-player-bus` sink, or its application.name is `liascape-player` (the player's own mpv
    // streams and its scene workers' carry that too).
    public static bool IsOwnStream(string block, int? playerPid, string? busSinkIndex)
    {
        foreach (var raw in block.Split('\n'))
        {
            var t = raw.Trim();
            if (playerPid is int pid && Quoted(t, "application.process.id") == pid.ToString()) return true;
            // the bus (`liascape-player-bus*`) and, Phase 2, every scene worker's stream (`liascape-player-scene.<id>` —
            // its own process, so the pid check above misses it)
            if (Quoted(t, "node.name") is { } node && node.StartsWith("liascape-player-", StringComparison.Ordinal)) return true;
            if (Quoted(t, "target.object") == "liascape-player-bus") return true;
            if (Quoted(t, "application.name") == "liascape-player") return true;
            if (busSinkIndex != null && t.StartsWith("Sink: ", StringComparison.Ordinal) && t[6..].Trim() == busSinkIndex) return true;
        }
        return false;
    }

    private static string? Quoted(string line, string key)
    {
        var prefix = key + " = \"";
        return line.StartsWith(prefix, StringComparison.Ordinal) ? line[prefix.Length..].TrimEnd('"') : null;
    }

    // (player pid, index of the `liascape-player-bus` sink) for IsOwnStream — both optional.
    public static Func<string, bool> OwnStreamFilter()
    {
        var client = C;
        int? pid = client.PlayerPid;
        if (pid == null && client.SocketExists) { client.TryCall("hello", null, LiascapePlayerClient.QuickMs); pid = client.PlayerPid; }
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
                    if (cols.Length > 1 && cols[1].Trim() == "liascape-player-bus") { bus = cols[0].Trim(); break; }
                }
            }
        }
        catch { }
        return block => IsOwnStream(block, pid, bus);
    }
}
