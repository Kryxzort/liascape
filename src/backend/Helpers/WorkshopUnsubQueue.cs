using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Liascape.Helpers;

/// Durable state for "Delete from Source" unsubscribes, persisted at
/// ~/.config/liascape/workshop_unsub.json.
///
/// Two lists:
/// - `pending` — ids enqueued by delete-from-source, awaiting the unsubscribe POST. Undo pulls them
///   back out (no network happened). The throttled drain processes them.
/// - `blocked` — ids already unsubscribed. We do NOT delete the workshop folder ourselves — Steam
///   removes it (folder + its appworkshop acf entry) on its next sync, which avoids leaving a stale
///   acf/folder mismatch. While the folder still lingers, `blocked` stops AutoImport from
///   re-importing it. Pruned once Steam has removed the folder.
///
/// AutoImport (SyncWallpaperEngine) skips ids in `pending ∪ blocked`. Re-subscribe (Browse) or
/// re-add via "Wallpaper Engine (Local)" unblocks the id.
public static class WorkshopUnsubQueue
{
    private static readonly object _gate = new();

    private static string FilePath => Path.Combine(AppDirs.Config, "workshop_unsub.json");

    private sealed class State
    {
        public List<string> Pending { get; set; } = [];
        public List<string> Blocked { get; set; } = [];
    }

    private static State Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<State>(File.ReadAllText(FilePath)) ?? new State();
        }
        catch { }
        return new State();
    }

    private static void Save(State s)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            AtomicFile.WriteAllText(FilePath, JsonSerializer.Serialize(s));
        }
        catch { }
    }

    // Enqueue for unsubscribe AND block from AutoImport immediately — the block is durable from the
    // moment of deletion, independent of whether/when the unsubscribe POST runs. (pending = still
    // needs the POST; blocked = don't re-import. A deleted item is both at once.)
    //
    // `quiet`: the unsubscribe is part of something else the user asked for (a "Download without subscribing" letting go of the
    // subscription that fetched it), not an unsubscribe of their own: the drain does it without any `unsub-progress` the UI shows
    // (SteamOps.StartDrain, WorkshopDownloader.DrainUnsubQueueAsync). An id queued again as the user's own is no longer quiet.
    //
    // `hold`: its Undo window, set in the same step: a drain running meanwhile (another item's) never finds it pending and due.
    public static void AddPending(IEnumerable<string> ids, bool quiet = false, TimeSpan? hold = null)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = false;
            var until = DateTime.UtcNow + (hold ?? TimeSpan.Zero);
            foreach (var id in ids)
            {
                if (string.IsNullOrWhiteSpace(id)) continue;
                if (quiet) _quiet.Add(id); else _quiet.Remove(id);
                if (hold != null) _holdUntil[id] = until;
                if (!s.Pending.Contains(id)) { s.Pending.Add(id); changed = true; }
                if (!s.Blocked.Contains(id)) { s.Blocked.Add(id); changed = true; }
            }
            if (changed) Save(s);
        }
    }

    // The Undo window: an id queued here reaches Steam only once its hold has passed (Web/SteamOps.DrainAfterUndoWindow); an
    // Undo inside it pulls the id out of pending, so Steam is never told. In memory only: after a backend restart the next
    // drain takes whatever it finds pending.
    private static readonly Dictionary<string, DateTime> _holdUntil = new(StringComparer.Ordinal);

    public static void Hold(IEnumerable<string> ids, TimeSpan d)
    {
        lock (_gate) { var until = DateTime.UtcNow + d; foreach (var id in ids) _holdUntil[id] = until; }
    }

    // the pending ids that are not the user's own unsubscribes (AddPending's `quiet`); in memory only, like the holds: after a
    // backend restart a leftover shows as an ordinary unsubscribe
    private static readonly HashSet<string> _quiet = new(StringComparer.Ordinal);

    public static HashSet<string> SnapshotQuiet()
    {
        lock (_gate) return new HashSet<string>(_quiet, StringComparer.Ordinal);
    }

    // the pending ids still inside their Undo window (Web/SteamOps.DropHeldUnsubscribes: a sign-out drops them)
    public static List<string> SnapshotHeld()
    {
        lock (_gate)
        {
            var now = DateTime.UtcNow;
            return Load().Pending.Where(id => _holdUntil.TryGetValue(id, out var t) && t > now).ToList();
        }
    }

    // an explicit drain (SteamOps.DrainNow) doesn't wait out the window
    public static void ReleaseHolds() { lock (_gate) _holdUntil.Clear(); }

    // the pending ids a drain may send now: past their Undo window
    public static List<string> SnapshotDue()
    {
        lock (_gate)
        {
            var now = DateTime.UtcNow;
            return Load().Pending.Where(id => !_holdUntil.TryGetValue(id, out var t) || t <= now).ToList();
        }
    }

    // The ids a drain is sending, from its claim until Steam answered (MarkBlocked) or the send ended without it (Release). The
    // claim and Undo's Withdraw take the same lock, so each id goes one way only: claimed first = it is sent and an Undo is
    // too late (it says so and changes nothing); withdrawn first = no claim finds it and Steam is never asked. A drain claims
    // an id right before it reaches Steam (after waiting its turn at the Steam client), never at its snapshot. In memory
    // only: a backend restart ends every send. Guard: test-steam-signin.sh § 3 i. "an Undo while the drain waits…",
    // "an Undo while the Steam client is unsubscribing it"
    private static readonly HashSet<string> _sending = new(StringComparer.Ordinal);

    // Claims the ids that are still pending (and, `dueOnly`, past their Undo window) and not already being sent; the caller
    // sends exactly these.
    public static List<string> Claim(IEnumerable<string> ids, bool dueOnly = true)
    {
        lock (_gate)
        {
            var pending = Load().Pending.ToHashSet(StringComparer.Ordinal);
            var now = DateTime.UtcNow;
            var got = new List<string>();
            foreach (var id in ids.Distinct(StringComparer.Ordinal))
            {
                if (!pending.Contains(id) || _sending.Contains(id)) continue;
                if (dueOnly && _holdUntil.TryGetValue(id, out var t) && t > now) continue;
                _sending.Add(id); got.Add(id);
            }
            return got;
        }
    }

    // a claimed id whose send ended without Steam's answer: back to plain pending (a later drain tries it again)
    public static void Release(IEnumerable<string> ids)
    {
        lock (_gate) foreach (var id in ids) _sending.Remove(id);
    }

    public sealed record Withdrawal(List<string> Sending, List<string> Unsubscribed);

    // Undo of a Delete from source, all of its ids at once: when a drain is sending any of them (Sending non-empty) it's too
    // late and nothing changes; else each leaves pending and blocked (wanted again), and Unsubscribed names the ones Steam had
    // already unsubscribed (blocked, no longer pending): the caller subscribes them again.
    public static Withdrawal Withdraw(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var list = ids.Distinct(StringComparer.Ordinal).ToList();
            var sending = list.Where(_sending.Contains).ToList();
            if (sending.Count > 0) return new(sending, []);
            var s = Load();
            var done = new List<string>();
            bool changed = false;
            foreach (var id in list)
            {
                if (s.Blocked.Contains(id) && !s.Pending.Contains(id)) done.Add(id);
                _holdUntil.Remove(id);
                _quiet.Remove(id);
                changed |= s.Pending.Remove(id) | s.Blocked.Remove(id);
            }
            if (changed) Save(s);
            return new([], done);
        }
    }

    // Drain step succeeded: unsubscribed → block (Steam will delete the folder on its next sync); the claim ends. False = it
    // wasn't pending any more: wanted again while it was being sent (a Subscribe: Unblock): nothing is blocked, the caller
    // re-subscribes it.
    public static bool MarkBlocked(string id)
    {
        lock (_gate)
        {
            _sending.Remove(id);
            var s = Load();
            if (!s.Pending.Remove(id)) return false;
            _quiet.Remove(id);
            if (!s.Blocked.Contains(id)) s.Blocked.Add(id);
            Save(s);
            return true;
        }
    }

    // An unsubscribe dropped like its Undo (AppOps.DropUnsubscribes: no usable sign-in): out of both lists. True = Steam had
    // ALREADY unsubscribed it (blocked, no longer pending). Undo itself goes through Withdraw.
    public static bool Restore(string id)
    {
        lock (_gate)
        {
            var s = Load();
            bool done = s.Blocked.Contains(id) && !s.Pending.Contains(id);
            _holdUntil.Remove(id);
            _quiet.Remove(id);
            if (s.Pending.Remove(id) | s.Blocked.Remove(id)) Save(s);
            return done;
        }
    }

    // Keeps a Steam folder that isn't a subscription out of auto-import (a one-off download's: WorkshopDownloader.AcquireOneOffAsync)
    // without queueing an unsubscribe; pruned like the rest once Steam removes the folder. True = it wasn't blocked before.
    public static bool Block(string id)
    {
        lock (_gate)
        {
            var s = Load();
            if (s.Blocked.Contains(id)) return false;
            s.Blocked.Add(id);
            Save(s);
            return true;
        }
    }

    // Undoes a Block whose fetch failed: off `blocked` only (a queued unsubscribe of it stays queued).
    public static void DropBlock(string id)
    {
        lock (_gate)
        {
            var s = Load();
            if (!s.Pending.Contains(id) && s.Blocked.Remove(id)) Save(s);
        }
    }

    // Re-subscribe / re-add via WE Local → the item is wanted again, stop blocking it.
    public static void Unblock(string id)
    {
        lock (_gate)
        {
            var s = Load();
            _quiet.Remove(id);
            bool changed = s.Pending.Remove(id) | s.Blocked.Remove(id);
            if (changed) Save(s);
        }
    }

    public static List<string> SnapshotPending()
    {
        lock (_gate) { return [.. Load().Pending]; }
    }

    public static bool HasPending()
    {
        lock (_gate) { return Load().Pending.Count > 0; }
    }

    // One read for a whole pass (AutoImport scan): pending ∪ blocked. Callers test against the set
    // instead of calling IsBlocked per item (which would re-read the file each time).
    public static HashSet<string> SnapshotBlockedSet()
    {
        lock (_gate)
        {
            var s = Load();
            var set = new HashSet<string>(s.Pending, StringComparer.Ordinal);
            set.UnionWith(s.Blocked);
            return set;
        }
    }

    // One read of both lists (the Browse sidebar's subscription state — Web/WorkshopSubOps.State).
    public static (HashSet<string> Pending, HashSet<string> Blocked) Snapshot()
    {
        lock (_gate)
        {
            var s = Load();
            return (new HashSet<string>(s.Pending, StringComparer.Ordinal), new HashSet<string>(s.Blocked, StringComparer.Ordinal));
        }
    }

    // Drop blocked ids whose workshop folder Steam has finished removing. `folderExists` is called
    // once per blocked id; the caller hoists any expensive lookup (e.g. libraryfolders.vdf parse).
    public static void PruneBlocked(Func<string, bool> folderExists)
    {
        lock (_gate)
        {
            var s = Load();
            int before = s.Blocked.Count;
            s.Blocked.RemoveAll(id => !folderExists(id));
            if (s.Blocked.Count != before) Save(s);
        }
    }
}
