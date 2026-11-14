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
// LIASCAPE_STEAM_CM_FIXTURE=<file.json> (tests): GetDetailsAsync answers from that file instead of Steam — `{"<id>": {"tags":
// [...], "youtube": "<id>"|null}}`, an id not in it = no such public item, no file = Steam unreachable; each request is
// logged with its ids.
public static class SteamWorkshopDetails
{
    public const uint AppId = 431960;
    // DetailsBatch: the largest batch measured (1000 ids: every one answered, 574 ms). BatchGapMs: a library over 1000 items
    // asks at most once every ~1.6 s (a 0.6 s request + the gap) — Steam publishes no CM rate limit; 11 requests 3 s apart
    // on one session drew no refusal. RequestTimeoutSeconds: ~30× a measured request.
    private const int DetailsBatch = 1000, BatchGapMs = 1000, RequestTimeoutSeconds = 20;

    // per item: Found = Steam answered for it (result 1); Youtube = its first YouTube preview id (null = none); Tags = its
    // Workshop tags, Steam's names; Creator = its creator's Steam ID (0 = unknown). An item Steam couldn't answer for
    // (removed, private: result ≠ 1) is Found=false, no tags.
    public readonly record struct Details(bool Found, string? Youtube, string[] Tags, ulong Creator = 0);

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
                    { includetags = true, includeadditionalpreviews = true, short_description = true, appid = AppId };
                req.publishedfileids.AddRange(batch);
                var resp = await pub.GetDetails(req); // an AsyncJob (no ConfigureAwait)
                if (resp.Result != EResult.OK) return null;
                return resp.Body.publishedfiledetails.ToDictionary((d) => d.publishedfileid, (d) => d.result == (int)EResult.OK
                    ? new Details(true, YoutubeOf(d), d.tags.Select((t) => t.tag).Where((t) => !string.IsNullOrEmpty(t)).Distinct().ToArray(), d.creator)
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
                        e.TryGetProperty("creator", out var cr) && ulong.TryParse(cr.ToString(), out var crId) ? crId : 0)
                    : new Details(false, null, []));
        }
        catch { return null; } // no fixture file = Steam unreachable
    }

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
        var req = new CPublishedFile_QueryFiles_Request
        {
            appid = AppId, query_type = QueryType(filter.Sort), page = (uint)Math.Max(1, page), numperpage = (uint)Math.Clamp(perPage, 1, 100),
            return_tags = true, return_previews = true, return_metadata = true,
            // the full description (it's persisted on a download and shown in the sidebar); measured no slower
            // than the short one — a page's descriptions are a few KB
            return_short_description = false,
        };
        if (req.query_type == 3) req.days = (uint)Math.Max(1, filter.TrendDays);
        if (!string.IsNullOrWhiteSpace(search)) req.search_text = search.Trim();
        foreach (var g in plan.TagGroups)
        {
            var tg = new CPublishedFile_QueryFiles_Request.TagGroup();
            tg.tags.AddRange(g);
            req.taggroups.Add(tg);
        }
        req.excludedtags.AddRange(plan.Excluded);
        return SteamAnonymous.UseAsync(async (pub) =>
        {
            var resp = await pub.QueryFiles(req); // an AsyncJob (no ConfigureAwait)
            if (resp.Result != EResult.OK) return null;
            return resp.Body.publishedfiledetails.Where((d) => d.result == (int)EResult.OK).Select(ToDetail).ToList();
        }, timeout, ct);
    }

    // A user's Workshop files for Wallpaper Engine — `type` "myfiles" (what they made) or "myfavorites" (their favourites,
    // when their profile shows them) — one page (1-based) of up to 100, in Steam's order for `sort`: "lastupdated" (newest
    // first) or "score" (top rated). Measured on an anonymous session: both types answer for a public profile, another
    // account's favourites can come back empty (a private profile), every other sort name tried gave the default order, and
    // the request has no text search; its tag fields aren't relied on (the caller matches tags itself).
    // null = Steam's servers unreachable / refused / timed out.
    public sealed record UserFilesPage(List<PublishedFileDetail> Items, uint Total);

    public static async Task<UserFilesPage?> UserFilesAsync(ulong steamId, string type, string sort, int page, int perPage, TimeSpan timeout, CancellationToken ct = default)
    {
        var req = new CPublishedFile_GetUserFiles_Request
        {
            steamid = steamId, appid = AppId, type = type, sortmethod = sort, page = (uint)Math.Max(1, page),
            numperpage = (uint)Math.Clamp(perPage, 1, 100), return_tags = true, return_previews = true, return_metadata = true,
            return_short_description = false,
        };
        if (Fixture is { } fx)
        {
            var r = UserFilesFromFixture(fx, req);
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

    // the fixture's `"@userfiles": {"<steamid>:<type>": [ {publishedfileid, title, tags, subscriptions, lifetime_subscriptions, …} ]}`
    // (the client protocol's own field names): built into Steam's own reply objects, so the mapping below is the one tested
    private static UserFilesPage? UserFilesFromFixture(string file, CPublishedFile_GetUserFiles_Request req)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(file));
            if (!doc.RootElement.TryGetProperty("@userfiles", out var all)) return new UserFilesPage([], 0);
            if (!all.TryGetProperty($"{req.steamid}:{req.type}", out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array)
                return new UserFilesPage([], 0);
            var items = arr.EnumerateArray().Select(FixtureDetails).ToList();
            if (req.sortmethod == "score") items = items.OrderByDescending((d) => d.vote_data?.score ?? 0).ToList();
            var page = items.Skip((int)((req.page - 1) * req.numperpage)).Take((int)req.numperpage).Select(ToDetail).ToList();
            return new UserFilesPage(page, (uint)items.Count);
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
            file_size = U("file_size"), file_description = S("file_description"), time_updated = (uint)U("time_updated"),
            subscriptions = (uint)U("subscriptions"), lifetime_subscriptions = (uint)U("lifetime_subscriptions"),
            favorited = (uint)U("favorited"), lifetime_favorited = (uint)U("lifetime_favorited"),
        };
        if (e.TryGetProperty("score", out var sc) && sc.TryGetSingle(out var score)) d.vote_data = new PublishedFileDetails.VoteData { score = score };
        if (e.TryGetProperty("tags", out var ts) && ts.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var t in ts.EnumerateArray()) d.tags.Add(new PublishedFileDetails.Tag { tag = t.GetString() ?? "" });
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
        // the current counts (Steam's own page shows these): the lifetime ones also count everyone who has since left
        Subscriptions = (long)d.subscriptions,
        Favorites = (long)d.favorited,
        Tags = d.tags.Select((t) => t.tag).Where((t) => !string.IsNullOrEmpty(t)).ToArray(),
        TrailerKnown = true,
        YoutubeId = YoutubeOf(d),
    };
}
