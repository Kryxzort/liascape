using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using static Liascape.Scrapers.SteamWorkshopScraper;

namespace Liascape.Helpers;

// Every Workshop item's details the app has seen, kept on disk across runs so a list of many items (favourites shown as a
// filter, sorted locally) costs Steam one GetDetails for only the items never seen before. The serve process is its one
// writer: the file is a cache, not shared state, so nothing else reads or merges it. Counts in it age; a Library sidebar's
// fresh ask refreshes a cached copy (Refresh), and the caller decides when something must be current.
// Guard: scripts/test-workshop-social.sh § 6
public static class WorkshopDetailsCache
{
    static readonly object _lock = new();
    static Dictionary<string, PublishedFileDetail>? _items;
    // Steam answered and has no public item with this id: not asked again this run, never saved (it may be published later)
    // Guard: scripts/test-workshop-social.sh § 6 "a second ask … sends nothing", "after a restart: an id Steam had no public item for is asked again"
    static readonly HashSet<string> _missing = [];
    static bool _saveQueued, _exitHooked;

    // Guard: scripts/test-workshop-social.sh § 6 "kept on disk"
    static string FilePath => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } x ? x
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"),
        "liascape", "workshop", "details.json");

    // read once, lazily: an unreadable file is an empty cache (it only costs asking Steam again)
    // Guard: scripts/test-workshop-social.sh § 6 "after a restart: the same ask sends nothing"
    static Dictionary<string, PublishedFileDetail> Items()
    {
        if (_items != null) return _items;
        try { _items = AtomicFile.ReadJson<Dictionary<string, PublishedFileDetail>>(FilePath); }
        catch (Exception e) { Console.WriteLine($"workshop-details: unreadable cache file, starting empty ({e.GetType().Name})"); }
        _items ??= [];
        return _items;
    }

    // The cached details of `ids` at once, the missing ones asked of Steam in ONE GetDetailsAsync call (it batches by
    // Steam's own limit). Steam unreachable → only what's cached. Ids Steam has no public item for are left out.
    // Guard: scripts/test-workshop-social.sh § 6 "one GetDetails for the missing ids", "Steam unreachable"
    public static async Task<Dictionary<string, PublishedFileDetail>> GetAsync(IReadOnlyCollection<string> ids, CancellationToken ct)
    {
        var found = new Dictionary<string, PublishedFileDetail>();
        var ask = new List<ulong>();
        lock (_lock)
        {
            var items = Items();
            foreach (var id in ids.Distinct())
            {
                if (items.TryGetValue(id, out var d)) found[id] = d;
                else if (!_missing.Contains(id) && ulong.TryParse(id, out var n)) ask.Add(n);
            }
        }
        if (ask.Count == 0) return found;
        var got = await SteamWorkshopDetails.GetDetailsAsync(ask, ct).ConfigureAwait(false);
        if (got == null) return found;
        var fresh = new List<PublishedFileDetail>();
        lock (_lock)
            foreach (var n in ask)
            {
                if (!got.TryGetValue(n, out var d)) continue; // a later batch that failed: asked again next time
                if (d.Found && d.File is { } f) { fresh.Add(f with { Id = n.ToString() }); found[n.ToString()] = fresh[^1]; }
                else if (!d.Found) _missing.Add(n.ToString());
            }
        Put(fresh);
        return found;
    }

    // Guard: scripts/test-workshop-social.sh § 6 "kept on disk"
    public static void Put(IEnumerable<PublishedFileDetail> details)
    {
        bool any = false;
        lock (_lock)
        {
            var items = Items();
            foreach (var d in details)
            {
                if (string.IsNullOrEmpty(d.Id)) continue;
                items[d.Id] = d;
                _missing.Remove(d.Id);
                any = true;
            }
        }
        if (any) QueueSave();
    }

    // Only an item already cached: the sidebars ask about items one at a time, and caching each of those would grow the
    // file with items no list asked for.
    // Guard: scripts/test-workshop-social.sh § 6 "a Library sidebar's counts refresh the cached copy", "a sidebar's counts of an uncached item don't add it"
    public static void Refresh(PublishedFileDetail d)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(d.Id) || !Items().ContainsKey(d.Id)) return;
            Items()[d.Id] = d;
        }
        QueueSave();
    }

    // the cached copy alone, never a request: a list read often (the favourites) shows what is cached
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the list, web left out (248 in Steam's order, with created
    // times)", "after a backend restart: the same items, no Steam call"
    public static bool TryGet(string id, out PublishedFileDetail d)
    {
        lock (_lock)
        {
            if (Items().TryGetValue(id, out var got)) { d = got; return true; }
            d = null!;
            return false;
        }
    }

    // At most one write a second: a list's many Puts land as one save. A stopping process saves what's still queued.
    // Guard: scripts/test-workshop-social.sh § 6 "three asks in a row saved at most once a second"
    static void QueueSave()
    {
        lock (_lock)
        {
            if (!_exitHooked) { _exitHooked = true; AppDomain.CurrentDomain.ProcessExit += (_, _) => Save(); }
            if (_saveQueued) return;
            _saveQueued = true;
        }
        _ = Task.Delay(1000).ContinueWith((_) => Save(), TaskScheduler.Default);
    }

    static void Save()
    {
        string json;
        int n;
        lock (_lock)
        {
            if (!_saveQueued || _items == null) return;
            _saveQueued = false;
            json = JsonSerializer.Serialize(_items);
            n = _items.Count;
        }
        try
        {
            AtomicFile.WriteAllText(FilePath, json);
            Console.WriteLine($"workshop-details: saved {n} item(s)");
        }
        catch (Exception e) { Console.WriteLine($"workshop-details: couldn't save the cache ({e.GetType().Name}: {e.Message})"); }
    }
}
