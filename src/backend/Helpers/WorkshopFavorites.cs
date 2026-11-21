using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Web;

namespace Liascape.Helpers;

// The signed-in account's Workshop favourites as an id list, kept per Steam account on disk, so showing them as a filter
// costs Steam nothing after the first load. The items' details live in the shared WorkshopDetailsCache; this list is only
// the ids in Steam's order. The serve process is its one writer: a cache, not shared state. Every change bumps one
// app-wide version and broadcasts `workshop-favorites {version, loading}` (never the ids: the page re-reads the list).
// Guard: scripts/test-workshop-social.sh § 7
public static class WorkshopFavorites
{
    // Done = ids (or, for a private profile's details, items) loaded so far; Total = the list's size, null = not known yet
    // Guard: scripts/test-workshop-social.sh § 7 "first load: progress streamed, rising to 250 of 250"
    public sealed record Progress(int Done, int? Total);
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the list, web left out (248 in Steam's order, with created times)"
    public sealed record View(long Version, Progress? Loading, string? Error, IReadOnlyList<string> Ids);

    // Guard: scripts/test-workshop-social.sh § 7 "first load cut off by Steam mid-load: the error line, …"
    public const string LoadError = "Couldn't load your favourites from Steam. Try again in a moment.";
    // the client protocol's page cap (QueryFiles / GetUserFiles answer at most 100), the details' chunk for a private
    // profile (one progress step each), the community page's size (SteamCommunity.MyFavoritesPageAsync)
    // Guard: scripts/test-workshop-social.sh § 7 "first load: progress streamed, rising to 250 of 250", "private profile:
    // 3 community pages with the cookie, …"
    const int PageSize = 100, DetailsChunk = 100, CommunityPageSize = 30;
    // ~20× a measured client-protocol page (1.1–1.8 s: SteamWorkshopDetails.QueryAsync)
    // Guard: scripts/test-workshop-social.sh § 7 "first load cut off by Steam mid-load: …"
    static readonly TimeSpan PageTimeout = TimeSpan.FromSeconds(30);

    // Guard: scripts/test-workshop-social.sh § 7 "another account: none of the first account's favourites, …"
    sealed class Account
    {
        public List<string> Ids = [];
        public bool ViaPage;
        public int? Total;
        // the file was there (or this run completed a load): the list is whole
        public bool Complete;
        public Progress? Loading;
        public string? Error;
        public Task? Running;
    }

    // the file's shape: the whole list, whether it came from the community page (a private profile), Steam's total
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})",
    // "private profile: the list kept on disk as viaPage"
    sealed record Saved(List<string> Ids, bool ViaPage, int? Total);

    // Guard: scripts/test-workshop-social.sh § 7 "another account: none of the first account's favourites, …"
    static readonly object _lock = new();
    static readonly Dictionary<ulong, Account> _accounts = [];
    // one app-wide counter: a page that saw version N re-reads on any later one, whichever account changed
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the events carry a rising version and the progress, no ids"
    static long _version;
    // the file's keys camelCase ({ids, viaPage, total}), like the API's
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})"
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})"
    static string FilePath(ulong steamId) => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } x ? x
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"),
        "liascape", "workshop", $"favorites-{steamId}.json");

    // That account's state, its file read once (under _lock). An unreadable file is no list: a first load rebuilds it.
    // Guard: scripts/test-workshop-social.sh § 7 "after a backend restart: the same items, no Steam call"
    static Account Of(ulong steamId)
    {
        if (_accounts.TryGetValue(steamId, out var a)) return a;
        a = new Account();
        try
        {
            if (AtomicFile.ReadJson<Saved>(FilePath(steamId), Json) is { Ids: not null } s)
            { a.Ids = s.Ids; a.ViaPage = s.ViaPage; a.Total = s.Total; a.Complete = true; }
        }
        catch (Exception e) { Console.WriteLine($"workshop-favorites: unreadable cache file, loading again ({e.GetType().Name})"); }
        return _accounts[steamId] = a;
    }

    // Each account's own list only: a sign-in as another account never sees this one's.
    // Guard: scripts/test-workshop-social.sh § 7 "another account: none of the first account's favourites, …"
    public static View Get(ulong steamId)
    {
        lock (_lock)
        {
            var a = Of(steamId);
            return new View(_version, a.Loading, a.Error, a.Ids.ToList());
        }
    }

    // Single-flight, in the background: the first load when the account has no whole list yet, else nothing. A failed
    // load is tried again by the next Sync.
    // Guard: scripts/test-workshop-social.sh § 7
    public static void Sync(ulong steamId)
    {
        lock (_lock)
        {
            var a = Of(steamId);
            if (a.Complete || a.Running != null) return;
            a.Error = null;
            a.Loading = new Progress(0, null);
            Bump(a);
            a.Running = Task.Run(() => FirstLoadAsync(steamId, a));
        }
    }

    // under _lock; the broadcast carries no ids
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the events carry a rising version and the progress, no ids"
    static void Bump(Account a)
    {
        var v = ++_version;
        var l = a.Loading;
        EventBus.Broadcast("workshop-favorites", new { version = v, loading = l == null ? null : new { done = l.Done, total = l.Total } });
    }

    // The list shown while a load runs: what it has so far, unless an earlier attempt that failed got further
    // Guard: scripts/test-workshop-social.sh § 7 "first load: progress streamed, rising to 250 of 250"
    static void Show(Account a, List<string> ids, Progress p)
    {
        lock (_lock)
        {
            if (ids.Count >= a.Ids.Count) a.Ids = ids.ToList();
            a.Loading = p;
            Bump(a);
        }
    }

    // Written only once the list is whole: a partial one would read as items taken out of the favourites.
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})", "first
    // load cut off by Steam mid-load: …"
    static async Task FirstLoadAsync(ulong steamId, Account a)
    {
        var ids = new List<string>();
        var seen = new HashSet<string>();
        bool viaPage = false;
        int? total = null;
        try
        {
            // the client protocol, whole pages: each page's details go straight into the details cache
            // Guard: scripts/test-workshop-social.sh § 7 "first load: progress streamed, rising to 250 of 250"
            for (int page = 1; ; page++)
            {
                var got = await SteamWorkshopDetails.UserFilesAsync(steamId, "myfavorites", "lastupdated", page, PageSize, PageTimeout).ConfigureAwait(false);
                if (got == null) { Fail(a, ids, "the client protocol didn't answer"); return; }
                // Steam's client protocol sees no favourites of a private profile (nor of a public one with none): its
                // community page, with the sign-in's cookie, is the only other way to the list
                if (page == 1 && got.Total == 0) { viaPage = true; break; }
                total = (int)got.Total;
                WorkshopDetailsCache.Put(got.Items);
                foreach (var d in got.Items) if (seen.Add(d.Id)) ids.Add(d.Id);
                if (got.Items.Count == 0) break;
                Show(a, ids, new Progress(ids.Count, total));
                if (ids.Count >= total) break;
            }
            if (viaPage && !await PrivateAsync(steamId, a, ids, seen).ConfigureAwait(false)) return;
        }
        catch (Exception e)
        {
            Fail(a, ids, e.GetType().Name);
            return;
        }
        var saved = new Saved(ids, viaPage, viaPage ? null : total);
        try { AtomicFile.WriteAllText(FilePath(steamId), JsonSerializer.Serialize(saved, Json)); }
        catch (Exception e) { Console.WriteLine($"workshop-favorites: couldn't save the list ({e.GetType().Name}: {e.Message})"); }
        lock (_lock)
        {
            a.Ids = ids; a.ViaPage = viaPage; a.Total = saved.Total; a.Complete = true;
            a.Loading = null; a.Error = null; a.Running = null;
            Bump(a);
        }
        Console.WriteLine($"workshop-favorites: first load done — {ids.Count} item(s) ({(viaPage ? "the community page" : "client protocol")})");
    }

    // A private profile: the community pages (Interactive: the user is waiting for this list) until a page adds no new id
    // or is short (the last one), then the items' details through the details cache, a chunk at a time. false = it
    // stopped (failed, or the sign-in is another account's now).
    // Guard: scripts/test-workshop-social.sh § 7 "private profile: 3 community pages with the cookie, …", "private
    // profile: progress 'so far' while paging, then of 65 for the details"
    static async Task<bool> PrivateAsync(ulong steamId, Account a, List<string> ids, HashSet<string> seen)
    {
        for (int page = 1; ; page++)
        {
            // the page is the signed-in account's own: one signed in as someone else now must not fill this list
            if (SteamCommunity.SignedInAccount() != steamId) { Fail(a, ids, "the sign-in changed"); return false; }
            var got = await SteamCommunity.MyFavoritesPageAsync(page, SteamGate.Kind.Interactive).ConfigureAwait(false);
            int added = 0;
            foreach (var id in got.Ids) if (seen.Add(id)) { ids.Add(id); added++; }
            if (added == 0) break;
            Show(a, ids, new Progress(ids.Count, null));
            if (got.Ids.Count < CommunityPageSize) break;
        }
        int done = 0;
        for (int i = 0; i < ids.Count; i += DetailsChunk)
        {
            var chunk = ids.Skip(i).Take(DetailsChunk).ToList();
            await WorkshopDetailsCache.GetAsync(chunk, CancellationToken.None).ConfigureAwait(false);
            done += chunk.Count;
            Show(a, ids, new Progress(done, ids.Count));
        }
        return true;
    }

    // What came so far stays shown with the error; nothing is written (a partial list would read as unfavourited items)
    // Guard: scripts/test-workshop-social.sh § 7 "first load cut off by Steam mid-load: the error line, page 1's items
    // kept, no favorites-<id>.json written"
    static void Fail(Account a, List<string> ids, string why)
    {
        lock (_lock)
        {
            if (ids.Count >= a.Ids.Count) a.Ids = ids.ToList();
            a.Loading = null;
            a.Error = LoadError;
            a.Running = null;
            Bump(a);
        }
        Console.WriteLine($"workshop-favorites: the first load stopped after {ids.Count} item(s) ({why})");
    }
}
