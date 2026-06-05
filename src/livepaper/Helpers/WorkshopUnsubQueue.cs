using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace livepaper.Helpers;

/// Durable state for "Delete from Source" unsubscribes, persisted at
/// ~/.config/livepaper/workshop_unsub.json.
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

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "livepaper", "workshop_unsub.json");

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
            File.WriteAllText(FilePath, JsonSerializer.Serialize(s));
        }
        catch { }
    }

    // Enqueue for unsubscribe AND block from AutoImport immediately — the block is durable from the
    // moment of deletion, independent of whether/when the unsubscribe POST runs. (pending = still
    // needs the POST; blocked = don't re-import. A deleted item is both at once.)
    public static void AddPending(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = false;
            foreach (var id in ids)
            {
                if (string.IsNullOrWhiteSpace(id)) continue;
                if (!s.Pending.Contains(id)) { s.Pending.Add(id); changed = true; }
                if (!s.Blocked.Contains(id)) { s.Blocked.Add(id); changed = true; }
            }
            if (changed) Save(s);
        }
    }

    // Undo → pull ids out of pending (no unsubscribe ran for them).
    public static void RemovePending(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = false;
            foreach (var id in ids) changed |= s.Pending.Remove(id);
            if (changed) Save(s);
        }
    }

    // Drain step succeeded: unsubscribed → block (Steam will delete the folder on its next sync).
    public static void MarkBlocked(string id)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = s.Pending.Remove(id);
            if (!s.Blocked.Contains(id)) { s.Blocked.Add(id); changed = true; }
            if (changed) Save(s);
        }
    }

    // Re-subscribe / re-add via WE Local → the item is wanted again, stop blocking it.
    public static void Unblock(string id)
    {
        lock (_gate)
        {
            var s = Load();
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
