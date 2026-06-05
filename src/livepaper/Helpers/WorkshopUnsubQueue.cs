using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace livepaper.Helpers;

/// Durable queue for "Delete from Source" unsubscribes, persisted at
/// ~/.config/livepaper/workshop_unsub.json.
///
/// Why a persisted queue: unsubscribing is an external, throttle-sensitive network action. A bulk
/// delete (200-300 items) can't be a fire-and-forget burst at shutdown — the process may exit
/// mid-way. So delete-from-source only *enqueues* ids; the drain (at close, with a progress modal,
/// or on next launch) processes them throttled and survives force-quit by resuming from disk.
///
/// - `pending`  — ids awaiting unsubscribe. Undo pulls them back out (no network happened yet).
/// - `removed`  — ids already unsubscribed + folder-deleted; kept so AutoImport never resurrects an
///                item whose Steam-side cleanup hasn't propagated. Self-prunes once the folder is gone.
///
/// AutoImport (SyncWallpaperEngine) skips anything in `pending ∪ removed`.
public static class WorkshopUnsubQueue
{
    private static readonly object _gate = new();

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "livepaper", "workshop_unsub.json");

    private sealed class State
    {
        public List<string> Pending { get; set; } = [];
        public List<string> Removed { get; set; } = [];
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

    public static void AddPending(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var s = Load();
            foreach (var id in ids)
            {
                if (string.IsNullOrWhiteSpace(id)) continue;
                s.Removed.Remove(id);            // re-deleting something previously removed
                if (!s.Pending.Contains(id)) s.Pending.Add(id);
            }
            Save(s);
        }
    }

    // Undo: an enqueued id is pulled back out before any unsubscribe happened.
    public static void RemovePending(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = false;
            foreach (var id in ids)
                changed |= s.Pending.Remove(id);
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

    // Drain step succeeded: unsubscribed + folder deleted → move pending → removed.
    public static void MarkRemoved(string id)
    {
        lock (_gate)
        {
            var s = Load();
            s.Pending.Remove(id);
            if (!s.Removed.Contains(id)) s.Removed.Add(id);
            Save(s);
        }
    }

    // Re-subscribe via the app: the item is wanted again → stop blocking it.
    public static void Unblock(string id)
    {
        lock (_gate)
        {
            var s = Load();
            bool changed = s.Pending.Remove(id) | s.Removed.Remove(id);
            if (changed) Save(s);
        }
    }

    public static bool IsBlocked(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return false;
        lock (_gate)
        {
            var s = Load();
            return s.Pending.Contains(id) || s.Removed.Contains(id);
        }
    }

    // Drop `removed` ids whose workshop folder is gone (Steam finished cleanup) — they no longer
    // need blocking. Keeps the file from growing without bound.
    public static void PruneRemoved(Func<string, bool> folderStillExists)
    {
        lock (_gate)
        {
            var s = Load();
            int before = s.Removed.Count;
            s.Removed = s.Removed.Where(folderStillExists).ToList();
            if (s.Removed.Count != before) Save(s);
        }
    }
}
