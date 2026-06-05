using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace livepaper.Helpers;

/// Durable queue for "Delete from Source" unsubscribes, persisted at
/// ~/.config/livepaper/workshop_unsub.json.
///
/// Holds ONLY ids not yet unsubscribed (still to do). Unsubscribing is an external, throttle-
/// sensitive action, and a bulk delete (200-300) can't be a fire-and-forget burst — the process may
/// exit mid-way. So delete-from-source only *enqueues*; the throttled drain processes ids and
/// removes each from the file the instant it succeeds (unsubscribe + folder delete). Force-quit just
/// resumes the remaining ids next launch.
///
/// AutoImport (SyncWallpaperEngine) skips queued ids so a still-on-disk folder can't be re-imported
/// before the drain deletes it.
public static class WorkshopUnsubQueue
{
    private static readonly object _gate = new();

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "livepaper", "workshop_unsub.json");

    private static List<string> Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<List<string>>(File.ReadAllText(FilePath)) ?? [];
        }
        catch { }
        return [];
    }

    private static void Save(List<string> ids)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(ids));
        }
        catch { }
    }

    public static void AddPending(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var list = Load();
            bool changed = false;
            foreach (var id in ids)
            {
                if (string.IsNullOrWhiteSpace(id) || list.Contains(id)) continue;
                list.Add(id);
                changed = true;
            }
            if (changed) Save(list);
        }
    }

    // Undo, or deliberate re-subscribe → pull ids back out (no unsubscribe ran for them).
    public static void Remove(IEnumerable<string> ids)
    {
        lock (_gate)
        {
            var list = Load();
            bool changed = false;
            foreach (var id in ids)
                changed |= list.Remove(id);
            if (changed) Save(list);
        }
    }

    public static void Remove(string id) => Remove([id]);

    public static List<string> Snapshot()
    {
        lock (_gate) { return Load(); }
    }

    public static bool HasPending()
    {
        lock (_gate) { return Load().Count > 0; }
    }

    public static bool IsBlocked(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return false;
        lock (_gate) { return Load().Contains(id); }
    }
}
