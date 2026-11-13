using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Liascape.Web;

// The library's long background operations, for the progress line on the top bar's bottom edge
// (app/ui/src/components/LibraryOpsLine.tsx): each with its count while it runs.
//   clips  ClipStore's background queue, one operation for all of it: the sweep to the chosen "Video preview quality" and
//          the cards' own clips (phase: low | mid | high from a quality change to the queue's end; else make, the cards'
//          first clips once two items wait at once)
//   facts  LibraryFactsOps: Steam's tags (phase steam), trailer pages (trailers), frame sizes (sizes)
//   scene-loudness  SceneLoudnessOps' queue (phase measure)
//   video-loudness  LibraryService.BackfillLoudnessAsync, the library's videos not yet measured (phase measure)
// WS `library-ops {ops: [{id, phase, done, total}]}` carries the whole list on every change: a start, a phase change and an
// end at once, a count at most every EVERY (a frame-size pass reads dozens of files a second). GET /library/ops: the same
// list, for a page that (re)connects mid-operation (store.resync). Guard: scripts/test-clip-sweep.sh, --probe probe-libops.js.
public static class LibraryOps
{
    public sealed record Op(string Id, string Phase, int Done, int Total);
    private static readonly TimeSpan EVERY = TimeSpan.FromMilliseconds(250);
    private static readonly object _lock = new();
    private static readonly List<Op> _ops = new();
    private static DateTime _sentAt;
    private static bool _trailing;

    public static object Snapshot() { lock (_lock) return Shape(); }
    private static object Shape() => new { ops = _ops.Select(o => new { id = o.Id, phase = o.Phase, done = o.Done, total = o.Total }).ToList() };

    public static void Set(string id, string phase, int done, int total)
    {
        lock (_lock)
        {
            var op = new Op(id, phase, Math.Clamp(done, 0, Math.Max(total, 0)), Math.Max(total, 0));
            int i = _ops.FindIndex(o => o.Id == id);
            if (i >= 0 && _ops[i] == op) return;
            bool now = i < 0 || _ops[i].Phase != phase || op.Done >= op.Total;
            // a start and an end go to the log too: an op shorter than a poll still leaves a trace (the tests grep it)
            if (i < 0) { _ops.Add(op); Console.WriteLine($"library-ops: {id} started ({phase}, {total})"); } else _ops[i] = op;
            SendLocked(now);
        }
    }

    public static void End(string id)
    {
        lock (_lock) { if (_ops.RemoveAll(o => o.Id == id) > 0) { Console.WriteLine($"library-ops: {id} ended"); SendLocked(true); } }
    }

    // under _lock: the order the UI sees is the order of the changes
    private static void SendLocked(bool now)
    {
        var wait = EVERY - (DateTime.UtcNow - _sentAt);
        if (!now && wait > TimeSpan.Zero)
        {
            if (_trailing) return;
            _trailing = true;
            _ = Task.Delay(wait).ContinueWith(_ => { lock (_lock) { _trailing = false; SendLocked(true); } });
            return;
        }
        _sentAt = DateTime.UtcNow;
        EventBus.Broadcast("library-ops", Shape());
    }
}
