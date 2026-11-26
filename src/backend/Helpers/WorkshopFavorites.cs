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
// Nothing refreshes it on a timer: the page asks for an id diff (Sync) when it shows the list, and for a cheap count check
// (Check) about once a minute while it stays on screen; a star set in Liascape changes the list at once (Apply).
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
    // Steam may answer from its own cache for a while after a star (GetUserFiles' answers are cached server-side), so a
    // diff that starts after a Liascape edit can still lack it: the edit holds this long against a disagreeing Steam
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "favourites merge: a later diff without the star keeps it
    // for 10 min", "favourites merge: after 10 min Steam wins"
    static readonly TimeSpan EditHold = TimeSpan.FromMinutes(10);
    // the page checks about once a minute while Browse shows; 50 s lets each of its ticks through but collapses two pages'
    // (or two windows') ticks into one ask
    // Guard: scripts/test-workshop-social.sh § 7 "sync=check twice in a row (and once after): one total-only ask; …"
    static readonly TimeSpan CheckEvery = TimeSpan.FromSeconds(50);
    // A private profile's whole list costs one gated community page per 30 favourites, and Browse asks for the diff on every
    // visit: within this long of the last whole read, a visit gets the page-1 check instead (a public list's diff is one
    // ids-only ask, never held)
    // Guard: scripts/test-workshop-social.sh § 7 "private profile: two quick sync=open after a whole read → no community
    // page asked again (the page-1 check instead, held by its 50 s)"
    static readonly TimeSpan PageDiffEvery = TimeSpan.FromMinutes(10);

    // A star (Favorite) or an unstar set in Liascape. Stamp orders it against the diffs (one app-wide counter: an edit
    // newer than a diff's start has a larger stamp); At is when it was set.
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "favourites merge: …"
    public readonly record struct Edit(bool Favorite, long Stamp, DateTime At);

    // Guard: scripts/test-workshop-social.sh § 7 "another account: none of the first account's favourites, …"
    sealed class Account
    {
        // the list shown: Steam's with Liascape's edits merged in (Merge)
        public List<string> Ids = [];
        // Steam's own list as last read: a private profile's check compares its first page
        public List<string> Steam = [];
        public bool ViaPage;
        public int? Total;
        // the file was there (or this run completed a load): the list is whole
        public bool Complete;
        public Progress? Loading;
        public string? Error;
        // one Steam read at a time per account: the first load, a diff or a count check
        public Task? Running;
        // the edits set in Liascape that a diff hasn't confirmed yet (in memory: a restart's first diff takes Steam's word)
        public Dictionary<string, Edit> Edits = [];
        // when the last count check started (Environment.TickCount64)
        public long? LastCheck;
        // when Steam's whole list was last read to the end, a first load or a diff (Environment.TickCount64)
        public long? LastRead;
    }

    // the file's shape: the whole list, whether it came from the community page (a private profile), Steam's total
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})",
    // "private profile: the list kept on disk as viaPage"
    sealed record Saved(List<string> Ids, bool ViaPage, int? Total);

    // Guard: scripts/test-workshop-social.sh § 7 "another account: none of the first account's favourites, …"
    static readonly object _lock = new();
    static readonly Dictionary<ulong, Account> _accounts = [];
    // one app-wide counter: a page that saw version N re-reads on any later one, whichever account changed. It starts at
    // the clock's milliseconds so a restarted backend still counts above what an open page holds (the page drops a read
    // older than its copy).
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the events carry a rising version and the progress, no ids",
    // "after a backend restart: the version read is above the one read before it"
    static long _version = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    // orders edits against diffs (Edit.Stamp, a diff's start), under _lock
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "favourites merge: a star newer than the diff stays"
    static long _stamp;
    // one file write at a time, each from the state as it is then: a diff's write and a star's can't land out of order
    // Guard: scripts/test-workshop-social.sh § 7 "a star set in Liascape: a later diff whose Steam answer lacks it keeps it"
    static readonly object _fileLock = new();
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
            { a.Ids = s.Ids; a.Steam = s.Ids.ToList(); a.ViaPage = s.ViaPage; a.Total = s.Total; a.Complete = true; }
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

    // Single-flight, in the background: the first load when the account has no whole list yet (a failed one is tried
    // again by the next Sync), else the id diff; a private profile read whole within PageDiffEvery gets the count check
    // instead. The page asks for it when it shows the list, not on a timer.
    // Guard: scripts/test-workshop-social.sh § 7 "sync=open with a cached list: one ids-only ask, only the new id's
    // details (one GetDetails of 1 id), the list in Steam's new order, kept on disk", "private profile: two quick
    // sync=open after a whole read → …"
    public static void Sync(ulong steamId)
    {
        lock (_lock)
        {
            var a = Of(steamId);
            if (a.Running != null) return;
            if (!(a.Complete && a.ViaPage && a.LastRead is { } read && Environment.TickCount64 - read < (long)PageDiffEvery.TotalMilliseconds))
            {
                var started = ++_stamp;
                if (a.Complete) { a.Running = Task.Run(() => DiffAsync(steamId, a, started)); return; }
                a.Error = null;
                a.Loading = new Progress(0, null);
                Bump(a);
                a.Running = Task.Run(() => FirstLoadAsync(steamId, a, started));
                return;
            }
        }
        Console.WriteLine("workshop-favorites: sync=open: the community pages were read lately, the page-1 check instead");
        Check(steamId);
    }

    // The cheap check whether Steam's list changed, at most once per CheckEvery per account, only for a whole list (the
    // first load is Sync's: the user's own Browse page, at its pace) and never beside another read. A public list: Steam's
    // total alone (`totalonly`) against the one the last read saw. A private profile: its community page 1 against the
    // first page of the list as Steam last gave it (the page's "of N" isn't the list's size: SteamCommunity.FavoritesPage),
    // so a change past page 1 waits for the next diff. A change → the id diff, at once.
    // Guard: scripts/test-workshop-social.sh § 7 "sync=check with no whole list: nothing asked, no load started", "sync=check,
    // Steam's count unchanged: one total-only ask, no diff", "sync=check twice in a row (and once after): …", "private
    // profile: sync=check reads page 1 only (one myworkshopfiles request), no change", "private profile: a grown page 1 → …"
    public static void Check(ulong steamId)
    {
        lock (_lock)
        {
            var a = Of(steamId);
            if (!a.Complete || a.Running != null) return;
            var now = Environment.TickCount64;
            if (a.LastCheck is { } last && now - last < (long)CheckEvery.TotalMilliseconds) return;
            a.LastCheck = now;
            var started = ++_stamp;
            a.Running = Task.Run(() => CheckAsync(steamId, a, started));
        }
    }

    // A star or unstar the user just set in Liascape (Steam took it): the list changes at once (a new star first) and is
    // written, and the edit is kept until a diff that started after it agrees, or EditHold passes (Merge). A new item's
    // details come in the background, with another broadcast when they land, only for a whole list: the details cache
    // keeps what a list shows, never a sidebar's star alone (a first load still to come asks for it then, Heal).
    // Guard: scripts/test-workshop-social.sh § 7 "a star set in Liascape: first in the list at once (on disk, a
    // workshop-favorites event), its details in the background (another event), read with no Steam call", "an unstar set
    // in Liascape: gone at once (an event), …"
    public static void Apply(ulong steamId, string workshopId, bool favorite)
    {
        Account a;
        bool whole;
        lock (_lock) { a = Of(steamId); whole = a.Complete; }
        Commit(steamId, a, () =>
        {
            a.Edits[workshopId] = new Edit(favorite, ++_stamp, DateTime.UtcNow);
            bool listed = a.Ids.Contains(workshopId);
            if (favorite && !listed) a.Ids.Insert(0, workshopId);
            else if (!favorite && listed) a.Ids.Remove(workshopId);
            return true;
        });
        if (!favorite || !whole || WorkshopDetailsCache.TryGet(workshopId, out _)) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var got = await WorkshopDetailsCache.GetAsync([workshopId], CancellationToken.None).ConfigureAwait(false);
                if (got.ContainsKey(workshopId)) lock (_lock) Bump(a);
            }
            catch (Exception e) { Console.WriteLine($"workshop-favorites: a new favourite's details didn't come ({e.GetType().Name})"); }
        });
    }

    // Steam's list with the edits set in Liascape: Steam's ids in Steam's order, except that an edit wins while it is newer
    // than the diff (`Stamp > diffStarted`: Steam's answer may predate it) or younger than EditHold (Steam may still serve
    // an older cached answer): a star Steam lacks goes first (the newest first), an unstarred id is left out. Where Steam
    // agrees the edit changes nothing.
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "favourites merge: a star newer than the diff stays", "…: a
    // later diff without the star keeps it for 10 min", "…: after 10 min Steam wins", "…: an unstar newer than the diff
    // stays", "…: a star Steam already lists keeps Steam's place", "…: two new stars, the newest first", "…: an unstar after
    // 10 min, Steam still listing it, wins back"
    internal static List<string> Merge(IReadOnlyList<string> fromSteam, IReadOnlyDictionary<string, Edit> edits, long diffStarted, DateTime now)
    {
        bool Wins(Edit e) => e.Stamp > diffStarted || now - e.At < EditHold;
        var onSteam = fromSteam.ToHashSet();
        var unstarred = edits.Where((kv) => !kv.Value.Favorite && Wins(kv.Value)).Select((kv) => kv.Key).ToHashSet();
        var starred = edits.Where((kv) => kv.Value.Favorite && Wins(kv.Value) && !onSteam.Contains(kv.Key))
            .OrderByDescending((kv) => kv.Value.Stamp).Select((kv) => kv.Key);
        return starred.Concat(fromSteam.Where((id) => !unstarred.Contains(id))).ToList();
    }

    // An edit a diff has settled, so the caller drops it: the diff started after it and Steam agrees, or it is EditHold old
    // (Steam's word from then on). An edit newer than the diff always stays. A known limit: once an edit is dropped, a later
    // diff that gets an older cached answer from Steam takes it as Steam's word, so a settled unstar can come back (a
    // settled star go) until Steam's answers catch up; keeping edits longer would hide a change made on Steam itself.
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "favourites merge: a star dropped once a diff that started
    // after it agrees", "…: a star newer than the diff kept, even when it agrees", "…: a star a later diff lacks kept inside
    // 10 min", "…: an edit dropped after 10 min"
    internal static bool Settled(Edit e, bool onSteam, long diffStarted, DateTime now) =>
        e.Stamp < diffStarted && (onSteam == e.Favorite || now - e.At >= EditHold);

    // Steam's whole list read: the list shown becomes Steam's with the edits merged in, the settled edits go (under _lock)
    // Guard: scripts/test-workshop-social.sh § 7 "a star set in Liascape: a later diff whose Steam answer lacks it keeps
    // it", "an unstar set in Liascape: …, and a later diff whose Steam answer still lists it keeps it gone"
    static void TakeSteam(Account a, List<string> fromSteam, long started)
    {
        var now = DateTime.UtcNow;
        var on = fromSteam.ToHashSet();
        a.Steam = fromSteam;
        a.Ids = Merge(fromSteam, a.Edits, started, now);
        foreach (var (id, e) in a.Edits.ToList()) if (Settled(e, on.Contains(id), started, now)) a.Edits.Remove(id);
    }

    // The details of every id the list will show that the details cache lacks, in one ask: Steam's new ids, a star set in
    // Liascape that Steam doesn't list yet, and any id an earlier failed fetch left out (it would otherwise stay hidden,
    // since the list shows only items with details). true = some came (the page should re-read).
    // Guard: scripts/test-workshop-social.sh § 7 "private profile: the diff asks the details of every listed id still
    // missing them (the new one and pfav-5, one GetDetails of 2)", "sync=open with a cached list: one ids-only ask, only the
    // new id's details (one GetDetails of 1 id), …"
    static async Task<bool> HealAsync(Account a, List<string> fromSteam, long started)
    {
        List<string> shown;
        lock (_lock) shown = Merge(fromSteam, a.Edits, started, DateTime.UtcNow);
        var missing = shown.Where((id) => !WorkshopDetailsCache.TryGet(id, out _)).ToList();
        if (missing.Count == 0) return false;
        return (await WorkshopDetailsCache.GetAsync(missing, CancellationToken.None).ConfigureAwait(false)).Count > 0;
    }

    // A change to an account's state: `mutate` (under _lock) says whether the page should re-read; a whole list is then
    // written from the state as it is at that moment, and only then broadcast, so a page that reads on the event finds the
    // file too.
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})", "a star
    // set in Liascape: first in the list at once (on disk, …)"
    static void Commit(ulong steamId, Account a, Func<bool> mutate)
    {
        lock (_fileLock)
        {
            bool bump;
            Saved? saved;
            lock (_lock)
            {
                bump = mutate();
                saved = a.Complete ? new Saved(a.Ids.ToList(), a.ViaPage, a.Total) : null;
            }
            if (saved != null)
            {
                // the user's alone (0600, like settings.json): its name holds the Steam ID and the list may be a private one
                // Guard: scripts/test-workshop-social.sh § 7 "first load: the list's file is the user's alone (0600)"
                try { AtomicFile.WritePrivate(FilePath(steamId), JsonSerializer.Serialize(saved, Json)); }
                // the type only: an IO error's message names the file, and its name holds the Steam ID
                catch (Exception e) { Console.WriteLine($"workshop-favorites: couldn't save the list ({e.GetType().Name})"); }
            }
            if (bump) lock (_lock) Bump(a);
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
    static void Show(Account a, List<string> ids, Progress p, long started)
    {
        lock (_lock)
        {
            var shown = Merge(ids, a.Edits, started, DateTime.UtcNow);
            if (shown.Count >= a.Ids.Count) a.Ids = shown;
            a.Loading = p;
            Bump(a);
        }
    }

    // Written only once the list is whole: a partial one would read as items taken out of the favourites.
    // Guard: scripts/test-workshop-social.sh § 7 "first load: the whole list kept on disk ({ids, viaPage, total})", "first
    // load cut off by Steam mid-load: …"
    static async Task FirstLoadAsync(ulong steamId, Account a, long started)
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
                if (got == null) { Fail(a, ids, started, "the client protocol didn't answer"); return; }
                // Steam's client protocol sees no favourites of a private profile (nor of a public one with none): its
                // community page, with the sign-in's cookie, is the only other way to the list
                if (page == 1 && got.Total == 0) { viaPage = true; break; }
                total = (int)got.Total;
                WorkshopDetailsCache.Put(got.Items);
                foreach (var d in got.Items) if (seen.Add(d.Id)) ids.Add(d.Id);
                if (got.Items.Count == 0) break;
                Show(a, ids, new Progress(ids.Count, total), started);
                if (ids.Count >= total) break;
            }
            if (viaPage) await PrivateAsync(steamId, a, ids, started).ConfigureAwait(false);
            await HealAsync(a, ids, started).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            Fail(a, ids, started, e.GetType().Name);
            return;
        }
        Commit(steamId, a, () =>
        {
            TakeSteam(a, ids, started);
            a.ViaPage = viaPage; a.Total = viaPage ? null : total; a.Complete = true;
            a.Loading = null; a.Error = null; a.Running = null; a.LastRead = Environment.TickCount64;
            return true;
        });
        Console.WriteLine($"workshop-favorites: first load done — {ids.Count} item(s) ({(viaPage ? "the community page" : "client protocol")})");
    }

    // A private profile: the community pages (Interactive: the user is waiting for this list) until a page adds no new id
    // or is short (the last one), then the items' details through the details cache, a chunk at a time. Each page is
    // asked for this account only (`account:`), checked against the very sign-in its request carries: a sign-in switched
    // between two pages throws there, with nothing sent as the other account and nothing written.
    // Guard: scripts/test-workshop-social.sh § 7 "private profile: 3 community pages with the cookie, …", "private
    // profile: progress 'so far' while paging, then of 65 for the details", "a sign-in switched mid-load: no page asked
    // as the other account, none of its favourites in this account's list, nothing written"
    static async Task PrivateAsync(ulong steamId, Account a, List<string> ids, long started)
    {
        // no list kept yet, so a page 1 with no paging line may be an empty favourites list (a login page instead self-heals:
        // the next count check finds page 1 changed)
        await CommunityIdsAsync(steamId, SteamGate.Kind.Interactive, ids, null, emptyOk: true, () => Show(a, ids, new Progress(ids.Count, null), started)).ConfigureAwait(false);
        int done = 0;
        for (int i = 0; i < ids.Count; i += DetailsChunk)
        {
            var chunk = ids.Skip(i).Take(DetailsChunk).ToList();
            await WorkshopDetailsCache.GetAsync(chunk, CancellationToken.None).ConfigureAwait(false);
            done += chunk.Count;
            Show(a, ids, new Progress(done, ids.Count), started);
        }
    }

    // The signed-in account's community favourites pages into `ids`, from page 1 (`page1`: already read) until the paging
    // line says the last page, a page is short or adds no new id; `onPage` after each page that added some. A page that
    // isn't a favourites listing (SteamCommunity.FavoritesPage.Listing: a login page, a blank one) throws — no answer,
    // never the list's end — except a page 1 that is the account's own empty favourites page (FavoritesPage.Empty: every
    // favourite removed), or any empty page 1 when `emptyOk` (no list kept yet, nothing to lose). Each page is asked for
    // this account only (`account:`): a sign-in switched to another account throws before anything is sent as it.
    // Guard: scripts/test-workshop-social.sh § 7 "every favourite removed on Steam, private profile: …", "every favourite
    // removed on Steam, public profile: …"
    // Guard: scripts/test-workshop-social.sh § 7 "private profile: 3 community pages with the cookie, …", "private
    // profile: a grown page 1 → the community pages again (page 1 not asked twice), …", "private profile: a 200 login page
    // as a diff's page 1 → the list kept, nothing written", "private profile: a blank 200 page 2 in a diff → not the list's
    // end: …", "private profile: the pages answering again → the next diff reads all three and keeps the same 66"
    static async Task CommunityIdsAsync(ulong steamId, SteamGate.Kind kind, List<string> ids, SteamCommunity.FavoritesPage? page1, bool emptyOk, Action? onPage)
    {
        var seen = new HashSet<string>(ids);
        for (int page = 1; ; page++)
        {
            var got = page == 1 && page1 != null ? page1
                : await SteamCommunity.MyFavoritesPageAsync(page, kind, account: steamId).ConfigureAwait(false);
            if (!got.Listing)
            {
                if (page == 1 && (got.Empty || emptyOk && got.Ids.Count == 0)) break;
                throw new InvalidOperationException("Steam answered with a page that isn't the favourites list");
            }
            int added = 0;
            foreach (var id in got.Ids) if (seen.Add(id)) { ids.Add(id); added++; }
            if (added == 0) break;
            onPage?.Invoke();
            if (got.Last == true || got.Ids.Count < CommunityPageSize) break;
        }
    }

    // The count check (Check), then the diff when Steam's list changed. Steam unreachable → nothing changes.
    // Guard: scripts/test-workshop-social.sh § 7 "sync=check, Steam's count unchanged: one total-only ask, no diff", "private
    // profile: sync=check reads page 1 only (one myworkshopfiles request), no change"
    static async Task CheckAsync(ulong steamId, Account a, long started)
    {
        try
        {
            bool viaPage;
            int? known;
            List<string> first;
            lock (_lock) { viaPage = a.ViaPage; known = a.Total; first = a.Steam.Take(CommunityPageSize).ToList(); }
            SteamCommunity.FavoritesPage? page1 = null;
            bool changed;
            if (!viaPage)
            {
                var total = await SteamWorkshopDetails.UserFilesTotalAsync(steamId, "myfavorites", PageTimeout).ConfigureAwait(false);
                if (total == null) { Console.WriteLine("workshop-favorites: count check: Steam didn't answer"); return; }
                changed = total != known;
            }
            else
            {
                // Background: a check the user didn't ask for waits its turn behind their own Steam requests
                page1 = await SteamCommunity.MyFavoritesPageAsync(1, SteamGate.Kind.Background, account: steamId).ConfigureAwait(false);
                // a login page (an expired sign-in) or a blank one lists nothing: no answer, not an emptied list; the
                // account's own empty favourites page (Empty) is a change, which the diff takes
                // Guard: scripts/test-workshop-social.sh § 7 "private profile: a 200 login page as page 1 → the count check
                // keeps the list (no diff, nothing written)", "every favourite removed on Steam, private profile: …"
                if (!page1.Listing && !page1.Empty && !(page1.Ids.Count == 0 && first.Count == 0))
                { Console.WriteLine("workshop-favorites: count check: not the favourites page, the list kept"); return; }
                changed = !page1.Ids.SequenceEqual(first);
            }
            Console.WriteLine($"workshop-favorites: count check: {(changed ? "changed, the ids follow" : "no change")}");
            if (changed) await DiffCoreAsync(steamId, a, started, page1).ConfigureAwait(false);
        }
        catch (Exception e) { Console.WriteLine($"workshop-favorites: count check stopped ({e.GetType().Name})"); }
        finally { lock (_lock) a.Running = null; }
    }

    // Guard: scripts/test-workshop-social.sh § 7 "sync=open with a cached list: …"
    static async Task DiffAsync(ulong steamId, Account a, long started)
    {
        try { await DiffCoreAsync(steamId, a, started, null).ConfigureAwait(false); }
        catch (Exception e) { Console.WriteLine($"workshop-favorites: the id diff stopped, the list kept ({e.GetType().Name})"); }
        finally { lock (_lock) a.Running = null; }
    }

    // The id diff: Steam's whole list again as ids — a public list in one `ids_only` ask (bare ids, in the first load's
    // `lastupdated` order), a private profile's through its community pages (Background: the user didn't click for this)
    // — then the details of every id to show that the details cache lacks (Heal), then Merge with the edits. A public
    // list that comes back empty takes the first load's rule: the community page (the profile turned private, or holds
    // none). The list empties only on the account's own empty favourites page (FavoritesPage.Empty); Steam unreachable or
    // rate-limited, a page that isn't the favourites list, or a sign-in switched → nothing changes.
    // Guard: scripts/test-workshop-social.sh § 7 "every favourite removed on Steam, …" (private and public, each after a
    // failed read that kept the list)
    // Guard: scripts/test-workshop-social.sh § 7 "sync=open with a cached list: …", "private profile: a grown page 1 → …",
    // "private profile: the diff asks the details of every listed id still missing them (the new one and pfav-5, one
    // GetDetails of 2)", "private profile: a 200 login page as a diff's page 1 → …", "private profile: a blank 200 page 2
    // in a diff → …"
    static async Task DiffCoreAsync(ulong steamId, Account a, long started, SteamCommunity.FavoritesPage? page1)
    {
        bool wasViaPage, emptyOk;
        lock (_lock) { wasViaPage = a.ViaPage; emptyOk = a.Steam.Count == 0; }
        var fromSteam = new List<string>();
        bool viaPage = wasViaPage;
        uint? total = null;
        if (!wasViaPage)
        {
            var got = await SteamWorkshopDetails.UserFileIdsAsync(steamId, "myfavorites", PageTimeout).ConfigureAwait(false);
            if (got == null) { Console.WriteLine("workshop-favorites: the id diff: Steam didn't answer, the list kept"); return; }
            if (got.Ids.Count > 0) { fromSteam = got.Ids.Select((id) => id.ToString()).ToList(); total = got.Total; }
            else viaPage = true;
        }
        // a kept list empties only on the account's own empty favourites page, never on another page that lists nothing
        // (emptyOk only while there's nothing to lose)
        if (viaPage) await CommunityIdsAsync(steamId, SteamGate.Kind.Background, fromSteam, page1, emptyOk, null).ConfigureAwait(false);
        bool detailsMissing = await HealAsync(a, fromSteam, started).ConfigureAwait(false);
        int added = 0, removed = 0;
        Commit(steamId, a, () =>
        {
            var before = a.Steam.ToHashSet();
            added = fromSteam.Count((id) => !before.Contains(id));
            removed = before.Count - fromSteam.Count((id) => before.Contains(id));
            var shown = a.Ids;
            TakeSteam(a, fromSteam, started);
            a.ViaPage = viaPage;
            // Steam's own total, the one the count check's `totalonly` answers
            // Guard: scripts/test-workshop-social.sh § 7 "a diff keeps Steam's own total: …"
            a.Total = viaPage ? null : (int?)total;
            a.LastRead = Environment.TickCount64;
            return detailsMissing || !shown.SequenceEqual(a.Ids);
        });
        Console.WriteLine($"workshop-favorites: id diff done — {fromSteam.Count} item(s), {added} added, {removed} removed ({(viaPage ? "the community page" : "client protocol")})");
    }

    // What came so far stays shown with the error; nothing is written (a partial list would read as unfavourited items)
    // Guard: scripts/test-workshop-social.sh § 7 "first load cut off by Steam mid-load: the error line, page 1's items
    // kept, no favorites-<id>.json written"
    static void Fail(Account a, List<string> ids, long started, string why)
    {
        lock (_lock)
        {
            var shown = Merge(ids, a.Edits, started, DateTime.UtcNow);
            if (shown.Count >= a.Ids.Count) a.Ids = shown;
            a.Loading = null;
            a.Error = LoadError;
            a.Running = null;
            Bump(a);
        }
        Console.WriteLine($"workshop-favorites: the first load stopped after {ids.Count} item(s) ({why})");
    }
}
