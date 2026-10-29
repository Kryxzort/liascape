using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Web;

// The background scene-loudness queue (web-backend.md § Scene loudness; docs/TODO.md "Offline scene loudness →
// integration"): ONE `liascape-player scene-loudness` child at a time under `nice -n 19 ionice -c3`
// (SceneLoudnessPlanner), never on a request thread, never touching playback. Fed by an import (a WE local import,
// a Workshop download, the auto-add sync + `/library/sync` — every library scene still without an estimate, so a
// half-downloaded one is retried by the next sync), the startup pass (what has no estimate for its current
// configuration), and Settings → Audio → "Scene loudness" (`POST /library/scene-loudness/estimate {paths?, force?}`).
// Cancel-safe: a scene's result is written to its index entry atomically (`SetMeta`) only when its child succeeded;
// cancel kills the running child and drops the queue. Progress → WS `scene-loudness-progress {done, total,
// currentId, finished?, cancelled?}`; each stored scene → WS `library-item-changed {path, loudness…}`.
public static class SceneLoudnessOps
{
    private static readonly object _lock = new();
    private static readonly List<(string Path, bool Force)> _queue = new();
    private static readonly HashSet<string> _queued = new(StringComparer.Ordinal);
    private static readonly List<(string Path, string Error)> _failed = new();
    private static int _done, _total;
    private static string? _current;
    private static bool _running;
    private static CancellationTokenSource _cts = new();
    private static long _startedAt;

    // Every library scene (its play path = its item folder).
    private static IEnumerable<string> AllScenes() =>
        LibraryService.LoadAll().Where(i => i.IsScene).Select(i => i.VideoPath);

    // Queue `paths` (null = every library scene); without `force` a scene already estimated for its current
    // configuration is skipped. Returns how many were queued (a path already queued counts once).
    public static int Enqueue(IEnumerable<string>? paths, bool force, string why)
    {
        var list = (paths ?? AllScenes()).Where(PlayerHelper.IsScenePath).Distinct().ToList();
        if (!force) list = list.Where(p => !SceneLoudnessPlanner.HasEstimate(LibraryStore.GetMeta(p))).ToList();
        int added = 0;
        bool start = false;
        lock (_lock)
        {
            if (!_running) { _done = 0; _total = 0; _failed.Clear(); }
            foreach (var p in list)
            {
                var full = LiascapePlayerMedia.FullPath(p);
                if (!_queued.Add(full))
                {
                    if (force) { int i = _queue.FindIndex(q => q.Path == full); if (i >= 0) _queue[i] = (full, true); }
                    continue;
                }
                _queue.Add((full, force));
                added++;
            }
            _total += added;
            if (added > 0 && !_running) { _running = true; start = true; _cts = new CancellationTokenSource(); _startedAt = Stopwatch.GetTimestamp(); }
        }
        if (added > 0) LiascapePlayerClient.Log($"scene loudness: queued {added} scene(s) ({why}{(force ? ", force" : "")})");
        if (start) _ = Task.Run(Run);
        return added;
    }

    // After an import / a sync: every library scene still without an estimate (a new one, or one whose folder was
    // incomplete last time). No-op without a liascape-player binary (the estimator is its subcommand).
    public static void AfterImport(string why)
    {
        if (PlayerEngine.ResolveBinary() == null) return;
        _ = Task.Run(() => { try { Enqueue(null, false, why); } catch (Exception e) { LiascapePlayerClient.Log($"scene loudness: {why} failed: {e.Message}"); } });
    }

    // One imported item (a WE local import, a Workshop download): queued when it's a scene.
    public static void Imported(LibraryItem? item, string why)
    {
        if (item is not { IsScene: true } || PlayerEngine.ResolveBinary() == null) return;
        _ = Task.Run(() => { try { Enqueue([item.VideoPath], false, why); } catch (Exception e) { LiascapePlayerClient.Log($"scene loudness: {why} failed: {e.Message}"); } });
    }

    public static bool Cancel()
    {
        lock (_lock)
        {
            if (!_running) return false;
            _queue.Clear();
            _queued.Clear();
            _cts.Cancel();
            return true;
        }
    }

    public static object Status()
    {
        lock (_lock)
            return new
            {
                running = _running,
                done = _done,
                total = _total,
                current = _current,
                failed = _failed.Select(f => new { path = f.Path, error = f.Error }).ToList(),
            };
    }

    private static string IdOf(string path) => System.IO.Path.GetFileName(path.TrimEnd('/'));

    private static void Progress(bool finished = false, bool cancelled = false)
    {
        int done, total; string? cur;
        lock (_lock) { done = _done; total = _total; cur = _current; }
        if (finished)
            EventBus.Broadcast("scene-loudness-progress", new { done, total, currentId = "", finished = true, cancelled });
        else
            EventBus.Broadcast("scene-loudness-progress", new { done, total, currentId = cur == null ? "" : IdOf(cur) });
    }

    private static void Run()
    {
        CancellationToken ct;
        lock (_lock) ct = _cts.Token;
        int stored = 0;
        try
        {
            while (true)
            {
                (string Path, bool Force) next;
                lock (_lock)
                {
                    if (_queue.Count == 0 || ct.IsCancellationRequested) break;
                    next = _queue[0];
                    _queue.RemoveAt(0);
                    _current = next.Path;
                }
                Progress();
                string? error = null;
                try
                {
                    // re-checked here: estimated meanwhile (a property change re-planned it) → skipped
                    if (!next.Force && SceneLoudnessPlanner.HasEstimate(LibraryStore.GetMeta(next.Path))) { }
                    else if (SceneLoudnessPlanner.Estimate(next.Path, background: true, ct, out error) is { } plan && !ct.IsCancellationRequested)
                    {
                        var (ok, applied, fpChanged) = SceneLoudnessPlanner.Store(next.Path, plan);
                        if (ok) { stored++; OnStored(next.Path, applied, fpChanged); }
                    }
                }
                catch (Exception e) { error = e.Message; }
                lock (_lock)
                {
                    _queued.Remove(next.Path);
                    if (ct.IsCancellationRequested) break;
                    _done++;
                    if (error != null) _failed.Add((next.Path, error));
                }
                if (error != null) LiascapePlayerClient.Log($"scene loudness: {IdOf(next.Path)} not estimated — {error}");
            }
        }
        finally
        {
            bool cancelled, again;
            int done, failed;
            double s = Stopwatch.GetElapsedTime(_startedAt).TotalSeconds;
            lock (_lock)
            {
                cancelled = ct.IsCancellationRequested;
                done = _done; failed = _failed.Count;
                _current = null;
                // queued after a cancel, before this run ended: a new run takes them (else they'd be lost)
                again = cancelled && _queue.Count > 0;
                if (again) { _cts = new CancellationTokenSource(); _done = 0; _total = _queue.Count; _failed.Clear(); _startedAt = Stopwatch.GetTimestamp(); }
                else { _running = false; _queue.Clear(); _queued.Clear(); }
            }
            LiascapePlayerClient.Log($"scene loudness: {(cancelled ? "cancelled" : "finished")} — {done} done, {stored} stored, {failed} failed in {s:0.0} s");
            Progress(finished: true, cancelled: cancelled);
            if (again) _ = Task.Run(Run);
        }
    }

    // A scene's estimate landed: the card's loudness line updates (WS), and when the item plays, its sources take the
    // configuration's key (+ its seed) and the applied value (`gain.normalize`, ramped) — LiascapePlayerMedia.
    public static void OnStored(string path, bool applied, bool fpChanged)
    {
        BroadcastItem(path);
        if ((applied || fpChanged) && PlayerEngine.IsLiascapePlayer) LiascapePlayerMedia.ApplySceneLoudness(path);
    }

    public static void BroadcastItem(string path)
    {
        var i = LibraryService.SceneLoudnessInfoOf(LibraryStore.GetMeta(path));
        EventBus.Broadcast("library-item-changed", new
        {
            path,
            loudnessLufs = i.Lufs, loudnessEstimated = i.Estimated, loudnessSeconds = i.Seconds,
            loudnessConfidence = i.Confidence, loudnessNote = i.Note,
        });
    }
}
