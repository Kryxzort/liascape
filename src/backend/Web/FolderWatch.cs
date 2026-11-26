using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;

namespace Liascape.Web;

// The watched folders (AppSettings.WatchedFolders, edited through /library/watched): each gets a FileSystemWatcher (inotify)
// whose events, debounced, run one pass of FolderImportOps.WatchPassAsync over the whole folder (the scan is a listing, cheap
// next to an import). A periodic pass catches what the watcher can't hear (NTFS / network mounts deliver no events, inotify's
// watch limit, a folder that appears later). A pass that met a file still being written (its write time younger than
// STABLE) looks again after STABLE. One pass per folder at a time; a kick during a pass runs one more after it.
// Timings: LIASCAPE_WATCH_DEBOUNCE_MS (2000), LIASCAPE_WATCH_STABLE_MS (3000), LIASCAPE_WATCH_RESCAN_MS (60000) for tests;
// LIASCAPE_WATCH_NO_EVENTS=1 listens to nothing (a mount that delivers no events: only the periodic pass sees changes).
// The same watchers follow the folders holding the library's Workshop items (ItemFilesWatch: Steam's Workshop folder its
// local/<id> links point into, the library's own workshop/ copies), whose pass tells open pages an item whose files changed in
// place (Steam downloading it again, a Redownload). Guard: scripts/test-folder-import.sh § watch,
// scripts/test-item-actions.sh § files changed
public static class FolderWatch
{
    private static int Ms(string env, int def) => int.TryParse(Environment.GetEnvironmentVariable(env), out var v) && v > 0 ? v : def;
    private static readonly int Debounce = Ms("LIASCAPE_WATCH_DEBOUNCE_MS", 2000);
    private static readonly TimeSpan Stable = TimeSpan.FromMilliseconds(Ms("LIASCAPE_WATCH_STABLE_MS", 3000));
    private static readonly int Rescan = Ms("LIASCAPE_WATCH_RESCAN_MS", 60_000);

    private sealed class W
    {
        // a watched folder's (FolderImportOps) or an item folder's (ItemFilesWatch) pass; `Items` keys are "items:<root>"
        public required string Root;
        public bool Items;
        public FileSystemWatcher? Fsw;
        public Timer? Timer;
        public bool Running, Again;
    }
    private static readonly object _lock = new();
    private static readonly Dictionary<string, W> _w = new(StringComparer.Ordinal);
    private static Timer? _periodic;

    // serve's start: watch every listed folder (each gets a first pass) and the periodic pass
    public static void Start()
    {
        Reconcile();
        ReconcileItems();
        _periodic ??= new Timer(_ => { Reconcile(); ReconcileItems(); KickAll(); }, null, Rescan, Rescan);
    }

    public static void Stop()
    {
        lock (_lock)
        {
            _periodic?.Dispose(); _periodic = null;
            foreach (var w in _w.Values) { w.Fsw?.Dispose(); w.Timer?.Dispose(); }
            _w.Clear();
        }
    }

    // the settings' list → watchers: a new folder is watched and passed at once, a removed one forgotten, a folder that
    // couldn't be watched (missing, unmounted) is tried again
    public static void Reconcile()
    {
        var roots = SettingsService.Load().WatchedFolders.Select(f => FolderImportOps.Norm(f.Path)).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var kick = new List<string>();
        lock (_lock)
        {
            Sync(roots, items: false, kick);
        }
        foreach (var r in kick) Kick(r, 0);
    }

    // the folders the library's Workshop items live in (ItemFilesWatch.Roots) → watchers, as Reconcile does for the watched ones
    public static void ReconcileItems()
    {
        var roots = ItemFilesWatch.Roots().ToHashSet(StringComparer.Ordinal);
        var kick = new List<string>();
        lock (_lock) Sync(roots, items: true, kick);
        foreach (var k in kick) Kick(k, 0);
    }

    private static string KeyOf(string root, bool items) => items ? "items:" + root : root;
    // under _lock: one kind's watchers → `roots`, the keys to pass now into `kick`
    private static void Sync(HashSet<string> roots, bool items, List<string> kick)
    {
        foreach (var gone in _w.Where(e => e.Value.Items == items && !roots.Contains(e.Value.Root)).Select(e => e.Key).ToList())
        {
            _w[gone].Fsw?.Dispose(); _w[gone].Timer?.Dispose();
            _w.Remove(gone);
        }
        foreach (var root in roots)
        {
            var key = KeyOf(root, items);
            if (!_w.TryGetValue(key, out var w)) { _w[key] = w = new W { Root = root, Items = items }; kick.Add(key); }
            if (w.Fsw == null && Directory.Exists(root)) { w.Fsw = Listen(root, key); if (!kick.Contains(key)) kick.Add(key); }
        }
    }

    // every watched folder, now ("Play scenes" turned on: the scenes they hold come in)
    public static void KickAll() { List<string> all; lock (_lock) all = [.. _w.Keys]; foreach (var r in all) Kick(r, 0); }

    private static readonly bool NoEvents = Environment.GetEnvironmentVariable("LIASCAPE_WATCH_NO_EVENTS") == "1";
    private static FileSystemWatcher? Listen(string root, string key)
    {
        if (NoEvents) return null;
        try
        {
            var fsw = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            FileSystemEventHandler on = (_, _) => Kick(key, Debounce);
            fsw.Created += on; fsw.Changed += on; fsw.Deleted += on;
            fsw.Renamed += (_, _) => Kick(key, Debounce);
            // an overflow, the folder itself gone, the watch limit: drop the watcher (the periodic pass carries on and
            // Reconcile listens again once the folder is back), and look now
            fsw.Error += (_, e) =>
            {
                Console.WriteLine($"watch: {root}: {e.GetException().Message}");
                lock (_lock) if (_w.TryGetValue(key, out var w) && w.Fsw == fsw) { w.Fsw = null; fsw.Dispose(); }
                Kick(key, Debounce);
            };
            fsw.EnableRaisingEvents = true;
            return fsw;
        }
        catch (Exception e) { Console.WriteLine($"watch: {root}: can't listen ({e.Message}), looks every {Rescan / 1000} s"); return null; }
    }

    // a pass of the watcher `key` (a watched folder's path, or "items:<root>") after `delay` ms; a later kick moves it (the
    // debounce: a burst of events is one pass)
    public static void Kick(string key, int delay)
    {
        lock (_lock)
        {
            if (!_w.TryGetValue(key, out var w)) return;
            if (w.Running) { w.Again = true; return; }
            w.Timer?.Dispose();
            w.Timer = new Timer(_ => _ = PassAsync(key), null, delay, Timeout.Infinite);
        }
    }

    private static async Task PassAsync(string key)
    {
        string root; bool items;
        lock (_lock)
        {
            if (!_w.TryGetValue(key, out var w) || w.Running) return;
            w.Running = true; w.Again = false;
            root = w.Root; items = w.Items;
        }
        bool unsettled = false;
        try { unsettled = items ? ItemFilesWatch.Pass(Stable) : await FolderImportOps.WatchPassAsync(root, Stable); }
        catch (Exception e) { Console.WriteLine($"watch: {root}: pass failed: {e.Message}"); }
        bool again;
        lock (_lock)
        {
            if (!_w.TryGetValue(key, out var w)) return;
            w.Running = false; again = w.Again;
        }
        if (again) Kick(key, Debounce);
        else if (unsettled) Kick(key, (int)Stable.TotalMilliseconds);
    }
}
