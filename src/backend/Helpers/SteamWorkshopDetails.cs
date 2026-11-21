using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;
using SteamKit2;
using SteamKit2.Internal;
using static Liascape.Scrapers.SteamWorkshopScraper;

namespace Liascape.Helpers;

// Workshop data over Steam's own client connection (the CM protocol the Steam client — and so Wallpaper Engine — talks),
// ANONYMOUSLY: no account, no Web API key, no web page. All of it rides SteamAnonymous' one shared session.
//   - GetDetailsAsync: `PublishedFile.GetDetails` — each item's tags and YouTube preview ids (`includeadditionalpreviews`),
//     DetailsBatch items a request. Measured on an anonymous session, real public ids: 100 / 200 / 500 / 1000 ids a request
//     all came back (one entry per id; a removed or private item answers with its own result code), each request in
//     574–600 ms (62 KB / 130 KB / 299 KB / 547 KB): a request's time doesn't grow with its size, so a whole library goes
//     in one. The web API's `IPublishedFileService/GetDetails` needs a key or a signed-in token, the keyless
//     `GetPublishedFileDetails` has no previews (and, by third-party reports, stops at ~213–220 ids, its URL length);
//     reading Workshop pages trips steamcommunity.com's per-IP limit.
//   - QueryAsync: the Workshop Browse source — `PublishedFile.QueryFiles`, one page of up to 100 items with tags, previews
//     (YouTube ids) and descriptions inline (measured: 1.1–1.8 s a page; any page number answers directly, no cursor
//     walk; search_text works with every sort). Preferred over scraping steamcommunity.com's browse page (rate-limited per IP,
//     30 items a page, AND-only tags) — that stays only as the fallback (SteamWorkshopService).
// Both return null when Steam's servers can't be reached / refuse (the caller falls back to page reading).
//   - QueryChildrenAsync: the items that name a given item as theirs ("Required items": a preset names its base scene) —
//     QueryFiles with `child_publishedfileid`, checked again against each result's own children.
// LIASCAPE_STEAM_CM_FIXTURE=<file.json> (tests): GetDetailsAsync answers from that file instead of Steam — `{"<id>": {"tags":
// [...], "youtube": "<id>"|null, "creator", "subscriptions", "favorited", "title", "children": ["<id>"], "time_created",
// "time_updated", "preview_url", "score"}}` (all but tags optional), an id not in it = no
// such public item, no file = Steam unreachable; each request is logged with its ids. QueryAsync (Browse's Workshop
// pages) answers from its "@query" list and the user files calls from "@userfiles" the same way, so a test's Browse never
// opens a session to Steam.
public static class SteamWorkshopDetails
{
    public const uint AppId = 431960;
    // DetailsBatch: the largest batch measured (1000 ids: every one answered, 574 ms). BatchGapMs: a library over 1000 items
    // asks at most once every ~1.6 s (a 0.6 s request + the gap) — Steam publishes no CM rate limit; 11 requests 3 s apart
    // on one session drew no refusal. RequestTimeoutSeconds: ~30× a measured request.
    private const int DetailsBatch = 1000, BatchGapMs = 1000, RequestTimeoutSeconds = 20;

    // per item: Found = Steam answered for it (result 1); Youtube = its first YouTube preview id (null = none); Tags = its
    // Workshop tags, Steam's names; Creator = its creator's Steam ID (0 = unknown); Subscriptions / Favorites = Steam's
    // CURRENT counts (`subscriptions` / `favorited`, never the lifetime ones, which also count everyone who has left);
    // Children = the items it requires (a preset: its base); File = the whole answer as the browse mapping takes it (its
    // created time, score, preview; Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "details: File carries
    // created / preview"). An item Steam couldn't answer for (removed, private: result ≠ 1) is Found=false, no tags.
    public readonly record struct Details(bool Found, string? Youtube, string[] Tags, ulong Creator = 0, long Subscriptions = 0, long Favorites = 0, string? Title = null, ulong[]? Children = null, PublishedFileDetail? File = null);

    private static string? Fixture => Environment.GetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE") is { Length: > 0 } f ? f : null;

    // null = Steam's servers unreachable / refused before any batch answered; after a later batch fails, what came back.
    public static async Task<Dictionary<ulong, Details>?> GetDetailsAsync(IReadOnlyList<ulong> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return [];
        var all = new Dictionary<ulong, Details>();
        for (int i = 0; i < ids.Count; i += DetailsBatch)
        {
            if (i > 0) await Task.Delay(BatchGapMs, ct).ConfigureAwait(false);
            var batch = ids.Skip(i).Take(DetailsBatch).ToList();
            var t0 = Environment.TickCount64;
            // one request per UseAsync: a Browse page waiting for the session goes between two batches
            var got = Fixture is { } fx ? FromFixture(fx, batch) : await SteamAnonymous.UseAsync(async (pub) =>
            {
                var req = new CPublishedFile_GetDetails_Request
                    { includetags = true, includeadditionalpreviews = true, includechildren = true, includevotes = true, short_description = true, appid = AppId };
                req.publishedfileids.AddRange(batch);
                var resp = await pub.GetDetails(req); // an AsyncJob (no ConfigureAwait)
                if (resp.Result != EResult.OK) return null;
                return resp.Body.publishedfiledetails.ToDictionary((d) => d.publishedfileid, (d) => d.result == (int)EResult.OK
                    ? new Details(true, YoutubeOf(d), d.tags.Select((t) => t.tag).Where((t) => !string.IsNullOrEmpty(t)).Distinct().ToArray(), d.creator,
                        d.subscriptions, d.favorited, d.title, ChildrenOf(d), ToDetail(d))
                    : new Details(false, null, []));
            }, TimeSpan.FromSeconds(RequestTimeoutSeconds), ct).ConfigureAwait(false);
            Console.WriteLine(got == null ? $"steam-cm: GetDetails of {batch.Count} id(s) — no answer"
                : $"steam-cm: GetDetails of {batch.Count} id(s) — {got.Values.Count((d) => d.Found)} found, in {Environment.TickCount64 - t0} ms"
                  + (Fixture != null ? $" (fixture: {string.Join(",", batch)})" : ""));
            if (got == null) return all.Count > 0 ? all : null;
            foreach (var (k, v) in got) all[k] = v;
        }
        return all;
    }

    private static Dictionary<ulong, Details>? FromFixture(string file, List<ulong> batch)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(file));
            return batch.Distinct().ToDictionary((id) => id, (id) =>
                doc.RootElement.TryGetProperty(id.ToString(), out var e) && e.ValueKind == System.Text.Json.JsonValueKind.Object
                    ? new Details(true,
                        e.TryGetProperty("youtube", out var y) && y.ValueKind == System.Text.Json.JsonValueKind.String ? y.GetString() : null,
                        e.TryGetProperty("tags", out var ts) && ts.ValueKind == System.Text.Json.JsonValueKind.Array
                            ? ts.EnumerateArray().Select((t) => t.GetString() ?? "").Where((t) => t.Length > 0).ToArray() : [],
                        e.TryGetProperty("creator", out var cr) && ulong.TryParse(cr.ToString(), out var crId) ? crId : 0,
                        e.TryGetProperty("subscriptions", out var su) && su.TryGetInt64(out var suN) ? suN : 0,
                        e.TryGetProperty("favorited", out var fa) && fa.TryGetInt64(out var faN) ? faN : 0,
                        e.TryGetProperty("title", out var ti) && ti.ValueKind == System.Text.Json.JsonValueKind.String ? ti.GetString() : null,
                        FixtureChildren(e), ToDetail(FixtureDetails(e)) with { Id = id.ToString() })
                    : new Details(false, null, []));
        }
        catch { return null; } // no fixture file = Steam unreachable
    }

    private static ulong[] ChildrenOf(PublishedFileDetails d) => d.children.Select((c) => c.publishedfileid).Where((id) => id > 0).Distinct().ToArray();

    private static ulong[] FixtureChildren(System.Text.Json.JsonElement e) =>
        e.TryGetProperty("children", out var cs) && cs.ValueKind == System.Text.Json.JsonValueKind.Array
            ? cs.EnumerateArray().Select((c) => ulong.TryParse(c.ToString(), out var id) ? id : 0).Where((id) => id > 0).ToArray() : [];

    private static string? YoutubeOf(PublishedFileDetails d) =>
        d.previews.FirstOrDefault((p) => !string.IsNullOrEmpty(p.youtubevideoid))?.youtubevideoid;

    // Browse sort → QueryFiles query_type (EPublishedFileQueryType): the browse page's `browsesort` names, kept as the API.
    private static uint QueryType(string sort) => sort switch
    {
        "mostrecent" => 1,              // RankedByPublicationDate
        "lastupdated" => 21,            // RankedByLastUpdatedDate
        "totaluniquesubscribers" => 9,  // RankedByTotalUniqueSubscriptions
        "toprated" => 0,                // RankedByVote
        _ => 3,                         // RankedByTrend (+ days)
    };

    // One QueryFiles page (1-based) of `perPage` (≤ 100: Steam's cap — asked for 200 or 500, it returns 100) items for the plan, in Steam's order, as the details the browse
    // mapping takes (MapToResults). null = Steam's servers unreachable / refused / timed out (→ the caller's fallback).
    public static Task<List<PublishedFileDetail>?> QueryAsync(WorkshopFilter filter, WorkshopTags.Plan plan, string? search, int page, int perPage, TimeSpan timeout, CancellationToken ct = default)
    {
        var req = QueryRequest(plan, filter.Sort, page, perPage);
        if (req.query_type == 3) req.days = (uint)Math.Max(1, filter.TrendDays);
        if (!string.IsNullOrWhiteSpace(search)) req.search_text = search.Trim();
        return SendQuery(req, $"QueryFiles page {req.page}", timeout, ct);
    }

    // One page (1-based) of the items that require `parentId` (a scene's presets), for the plan (WorkshopTags.ForPresets),
    // sorted by `sort` (the list's own keys: "lastupdated", "toprated"). Each result is kept only when its own children
    // name the parent, so a Steam that ignored the child filter can't pass the whole Workshop off as the scene's presets.
    // null = Steam's servers unreachable / refused / timed out. Guard: steam-selftest "presets of a scene", test-workshop-social § 5.
    public static async Task<List<PublishedFileDetail>?> QueryChildrenAsync(ulong parentId, WorkshopTags.Plan plan, string sort, int page, int perPage, TimeSpan timeout, CancellationToken ct = default)
    {
        var req = QueryRequest(plan, sort == "toprated" ? "toprated" : "lastupdated", page, perPage);
        req.child_publishedfileid = parentId;
        req.return_children = true;
        var got = await SendQuery(req, $"QueryFiles children of {parentId} query_type={req.query_type} page {req.page}", timeout, ct).ConfigureAwait(false);
        return got?.Where((d) => d.Children.Contains(parentId)).ToList();
    }

    private static CPublishedFile_QueryFiles_Request QueryRequest(WorkshopTags.Plan plan, string sort, int page, int perPage)
    {
        var req = new CPublishedFile_QueryFiles_Request
        {
            appid = AppId, query_type = QueryType(sort), page = (uint)Math.Max(1, page), numperpage = (uint)Math.Clamp(perPage, 1, 100),
            return_tags = true, return_previews = true, return_metadata = true,
            // the full description (it's persisted on a download and shown in the sidebar); measured no slower
            // than the short one — a page's descriptions are a few KB
            return_short_description = false,
        };
        foreach (var g in plan.TagGroups)
        {
            var tg = new CPublishedFile_QueryFiles_Request.TagGroup();
            tg.tags.AddRange(g);
            req.taggroups.Add(tg);
        }
        req.excludedtags.AddRange(plan.Excluded);
        return req;
    }

    private static Task<List<PublishedFileDetail>?> SendQuery(CPublishedFile_QueryFiles_Request req, string what, TimeSpan timeout, CancellationToken ct)
    {
        if (Fixture is { } fx)
        {
            var r = QueryFromFixture(fx, req);
            Console.WriteLine($"steam-cm: {what} — " + (r == null ? "no answer" : $"{r.Count} item(s) (fixture)"));
            return Task.FromResult(r);
        }
        return SteamAnonymous.UseAsync(async (pub) =>
        {
            var resp = await pub.QueryFiles(req); // an AsyncJob (no ConfigureAwait)
            if (resp.Result != EResult.OK) return null;
            var got = resp.Body.publishedfiledetails.Where((d) => d.result == (int)EResult.OK).Select(ToDetail).ToList();
            if (req.child_publishedfileid != 0) Console.WriteLine($"steam-cm: {what} — {got.Count} item(s) of {resp.Body.total}");
            return got;
        }, timeout, ct);
    }

    // A user's Workshop files for Wallpaper Engine — `type` "myfiles" (what they made) or "myfavorites" (their favourites,
    // when their profile shows them) — one page (1-based) of up to 100, in Steam's order for `sort`: "lastupdated" (newest
    // first) or "score" (top rated). Measured on an anonymous session: both types answer for a public profile, another
    // account's favourites can come back empty (a private profile), every other sort name tried gave the default order, and
    // the request has no text search; its tag fields aren't relied on (the caller matches tags itself). Each item carries its
    // created time, score (`return_vote_data`) and children (`return_children`). Also measured on an anonymous session:
    // `ids_only` answers the whole list as bare ids in the `lastupdated` order, up to IdsPageSize a page (asked for 2000, it
    // returns 1000; without `ids_only` the cap stays 100); `totalonly` answers `total` with no items.
    // null = Steam's servers unreachable / refused / timed out. Guard (created / score / children): steam-selftest
    // (scripts/test-steam-signin.sh § 1) "user files: created / score / children".
    public sealed record UserFilesPage(List<PublishedFileDetail> Items, uint Total);

    public static async Task<UserFilesPage?> UserFilesAsync(ulong steamId, string type, string sort, int page, int perPage, TimeSpan timeout, CancellationToken ct = default)
    {
        var req = new CPublishedFile_GetUserFiles_Request
        {
            steamid = steamId, appid = AppId, type = type, sortmethod = sort, page = (uint)Math.Max(1, page),
            numperpage = (uint)Math.Clamp(perPage, 1, 100), return_tags = true, return_previews = true, return_metadata = true,
            return_short_description = false, return_vote_data = true, return_children = true,
        };
        if (Fixture is { } fx)
        {
            var r = UserFilesFromFixture(fx, req) is { } f ? new UserFilesPage(f.Items.Select(ToDetail).ToList(), f.Total) : null;
            Console.WriteLine($"steam-cm: GetUserFiles {type} sort={sort} page {req.page} — " + (r == null ? "no answer" : $"{r.Items.Count} of {r.Total} (fixture)"));
            return r;
        }
        return await SteamAnonymous.UseAsync(async (pub) =>
        {
            var resp = await pub.GetUserFiles(req); // an AsyncJob (no ConfigureAwait)
            if (resp.Result != EResult.OK) return null;
            return new UserFilesPage(resp.Body.publishedfiledetails.Where((d) => d.result == (int)EResult.OK).Select(ToDetail).ToList(), resp.Body.total);
        }, timeout, ct).ConfigureAwait(false);
    }

    private const int IdsPageSize = 1000;

    // The whole list's ids in Steam's `lastupdated` order, a page of IdsPageSize a request (the favourites cache's cheap
    // check of membership and order). null = Steam unreachable, or a page failed partway (a partial list would read as
    // items removed). Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "user files: ids only = the whole list in
    // Steam's order".
    public static async Task<List<ulong>?> UserFileIdsAsync(ulong steamId, string type, TimeSpan timeout, CancellationToken ct = default)
    {
        var all = new List<ulong>();
        for (uint page = 1; ; page++)
        {
            var req = new CPublishedFile_GetUserFiles_Request
                { steamid = steamId, appid = AppId, type = type, sortmethod = "lastupdated", page = page, numperpage = IdsPageSize, ids_only = true };
            var got = await SendUserFiles(req, timeout, ct).ConfigureAwait(false);
            Console.WriteLine($"steam-cm: GetUserFiles {type} ids-only page {page} — " + (got == null ? "no answer" : $"{got.Ids.Count} of {got.Total}")
                + (Fixture != null ? " (fixture)" : ""));
            if (got == null) return null;
            all.AddRange(got.Ids);
            if (got.Ids.Count == 0 || all.Count >= got.Total) return all;
        }
    }

    // The list's size alone (`totalonly`: no items). null = Steam unreachable.
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "user files: total only".
    public static async Task<uint?> UserFilesTotalAsync(ulong steamId, string type, TimeSpan timeout, CancellationToken ct = default)
    {
        var req = new CPublishedFile_GetUserFiles_Request
            { steamid = steamId, appid = AppId, type = type, sortmethod = "lastupdated", page = 1, numperpage = 1, totalonly = true };
        var got = await SendUserFiles(req, timeout, ct).ConfigureAwait(false);
        Console.WriteLine($"steam-cm: GetUserFiles {type} total-only — " + (got == null ? "no answer" : $"{got.Total}") + (Fixture != null ? " (fixture)" : ""));
        return got?.Total;
    }

    // An ids-only / total-only request's answer: the ids in Steam's order and the list's total
    private sealed record IdsAnswer(List<ulong> Ids, uint Total);

    private static async Task<IdsAnswer?> SendUserFiles(CPublishedFile_GetUserFiles_Request req, TimeSpan timeout, CancellationToken ct)
    {
        if (Fixture is { } fx)
        {
            var r = UserFilesFromFixture(fx, req);
            return r is { } f ? new IdsAnswer(f.Items.Select((d) => d.publishedfileid).ToList(), f.Total) : null;
        }
        return await SteamAnonymous.UseAsync(async (pub) =>
        {
            var resp = await pub.GetUserFiles(req); // an AsyncJob (no ConfigureAwait)
            if (resp.Result != EResult.OK) return null;
            return new IdsAnswer(resp.Body.publishedfiledetails.Select((d) => d.publishedfileid).Where((id) => id > 0).ToList(), resp.Body.total);
        }, timeout, ct).ConfigureAwait(false);
    }

    // the fixture's `"@userfiles": {"<steamid>:<type>": [ {publishedfileid, title, tags, subscriptions, lifetime_subscriptions, …} ]}`
    // (the client protocol's own field names): built into Steam's own reply objects, so the mapping below is the one tested.
    // As Steam answers: `ids_only` items carry only their id (pages up to IdsPageSize, else 100), `totalonly` no items.
    // Guard: steam-selftest (scripts/test-steam-signin.sh § 1) "user files: ids only = the whole list in Steam's order",
    // "user files: total only".
    private static (List<PublishedFileDetails> Items, uint Total)? UserFilesFromFixture(string file, CPublishedFile_GetUserFiles_Request req)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(file));
            if (!doc.RootElement.TryGetProperty("@userfiles", out var all)) return ([], 0);
            if (!all.TryGetProperty($"{req.steamid}:{req.type}", out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array)
                return ([], 0);
            var items = arr.EnumerateArray().Select(FixtureDetails).ToList();
            if (req.totalonly) return ([], (uint)items.Count);
            if (req.sortmethod == "score") items = items.OrderByDescending((d) => d.vote_data?.score ?? 0).ToList();
            int perPage = (int)Math.Min(req.numperpage, req.ids_only ? IdsPageSize : 100);
            var page = items.Skip((int)(req.page - 1) * perPage).Take(perPage);
            if (req.ids_only) page = page.Select((d) => new PublishedFileDetails { publishedfileid = d.publishedfileid });
            return (page.ToList(), (uint)items.Count);
        }
        catch { return null; } // no fixture file = Steam unreachable
    }

    // the fixture's `"@query": [ {publishedfileid, title, tags, …} ]` (the user files' item shape): the whole Workshop as
    // Browse lists it, in that order; Steam's own matching done roughly here (the search text in the title, one tag of each
    // tag group, no excluded tag, the child filter by each item's "children") so a filter or a search still narrows the list.
    // No "@query" = an empty Workshop.
    private static List<PublishedFileDetail>? QueryFromFixture(string file, CPublishedFile_QueryFiles_Request req)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(file));
            if (!doc.RootElement.TryGetProperty("@query", out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array) return [];
            bool Has(PublishedFileDetails d, string t) => d.tags.Any((x) => string.Equals(x.tag, t, StringComparison.OrdinalIgnoreCase));
            return arr.EnumerateArray().Select(FixtureDetails)
                .Where((d) => string.IsNullOrEmpty(req.search_text) || d.title.Contains(req.search_text, StringComparison.OrdinalIgnoreCase))
                .Where((d) => req.taggroups.All((g) => g.tags.Any((t) => Has(d, t))) && !req.excludedtags.Any((t) => Has(d, t)))
                .Where((d) => req.child_publishedfileid == 0 || d.children.Any((c) => c.publishedfileid == req.child_publishedfileid))
                .Skip((int)((req.page - 1) * req.numperpage)).Take((int)req.numperpage).Select(ToDetail).ToList();
        }
        catch { return null; } // no fixture file = Steam unreachable
    }

    private static PublishedFileDetails FixtureDetails(System.Text.Json.JsonElement e)
    {
        ulong U(string n) => e.TryGetProperty(n, out var v) && ulong.TryParse(v.ToString(), out var x) ? x : 0;
        string S(string n) => e.TryGetProperty(n, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() ?? "" : "";
        var d = new PublishedFileDetails
        {
            result = 1, publishedfileid = U("publishedfileid"), title = S("title"), preview_url = S("preview_url"), creator = U("creator"),
            file_size = U("file_size"), file_description = S("file_description"), time_updated = (uint)U("time_updated"), time_created = (uint)U("time_created"),
            subscriptions = (uint)U("subscriptions"), lifetime_subscriptions = (uint)U("lifetime_subscriptions"),
            favorited = (uint)U("favorited"), lifetime_favorited = (uint)U("lifetime_favorited"),
        };
        if (e.TryGetProperty("score", out var sc) && sc.TryGetSingle(out var score)) d.vote_data = new PublishedFileDetails.VoteData { score = score };
        if (e.TryGetProperty("tags", out var ts) && ts.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var t in ts.EnumerateArray()) d.tags.Add(new PublishedFileDetails.Tag { tag = t.GetString() ?? "" });
        foreach (var c in FixtureChildren(e)) d.children.Add(new PublishedFileDetails.Child { publishedfileid = c });
        return d;
    }

    private static PublishedFileDetail ToDetail(PublishedFileDetails d) => new()
    {
        Id = d.publishedfileid.ToString(),
        Title = d.title ?? "",
        Description = !string.IsNullOrEmpty(d.file_description) ? d.file_description : d.short_description ?? "",
        PreviewUrl = d.preview_url ?? "",
        FileSizeBytes = (long)d.file_size,
        CreatorId = d.creator.ToString(),
        TimeUpdated = d.time_updated > 0 ? DateTimeOffset.FromUnixTimeSeconds(d.time_updated).UtcDateTime : DateTime.MinValue,
        TimeCreated = d.time_created > 0 ? DateTimeOffset.FromUnixTimeSeconds(d.time_created).UtcDateTime : DateTime.MinValue,
        VoteScore = d.vote_data is { } v ? v.score : null,
        // the current counts (Steam's own page shows these): the lifetime ones also count everyone who has since left
        Subscriptions = (long)d.subscriptions,
        Favorites = (long)d.favorited,
        Tags = d.tags.Select((t) => t.tag).Where((t) => !string.IsNullOrEmpty(t)).ToArray(),
        Children = ChildrenOf(d),
        TrailerKnown = true,
        YoutubeId = YoutubeOf(d),
    };
}
