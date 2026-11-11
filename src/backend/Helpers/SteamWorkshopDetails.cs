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
//   - GetTrailersAsync: `PublishedFile.GetDetails` with `includeadditionalpreviews` carries each item's YouTube preview ids,
//     100 items a request (measured: an anonymous session
//     returned all 6 known trailers in one 355 ms request; the web API's `IPublishedFileService/GetDetails` needs a key or a
//     signed-in token, the keyless `GetPublishedFileDetails` has no previews, and reading Workshop pages trips
//     steamcommunity.com's per-IP limit).
//   - QueryAsync: the Workshop Browse source — `PublishedFile.QueryFiles`, one page of up to 100 items with tags, previews
//     (YouTube ids) and descriptions inline (measured: ~1 s a page; any page number answers directly, no cursor
//     walk; search_text works with every sort). Preferred over scraping steamcommunity.com's browse page (rate-limited per IP,
//     30 items a page, AND-only tags) — that stays only as the fallback (SteamWorkshopService).
// Both return null when Steam's servers can't be reached / refuse (the caller falls back to page reading).
public static class SteamWorkshopDetails
{
    public const uint AppId = 431960;
    private const int BatchSize = 100, BatchGapMs = 1000, RequestTimeoutSeconds = 20;

    // per item: Found = Steam answered for it (result 1), Youtube = its first YouTube preview id (null = none).
    // An item Steam couldn't answer for (removed, private: result ≠ 1) is Found=false.
    public readonly record struct Trailer(bool Found, string? Youtube);

    public static async Task<Dictionary<ulong, Trailer>?> GetTrailersAsync(IReadOnlyList<ulong> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return [];
        var all = new Dictionary<ulong, Trailer>();
        for (int i = 0; i < ids.Count; i += BatchSize)
        {
            if (i > 0) await Task.Delay(BatchGapMs, ct).ConfigureAwait(false);
            var batch = ids.Skip(i).Take(BatchSize).ToList();
            // one request per UseAsync: a Browse page waiting for the session goes between two batches
            var got = await SteamAnonymous.UseAsync(async (pub) =>
            {
                var req = new CPublishedFile_GetDetails_Request { includeadditionalpreviews = true, appid = AppId };
                req.publishedfileids.AddRange(batch);
                var resp = await pub.GetDetails(req); // an AsyncJob (no ConfigureAwait)
                if (resp.Result != EResult.OK) return null;
                return resp.Body.publishedfiledetails.ToDictionary((d) => d.publishedfileid, (d) => d.result == (int)EResult.OK
                    ? new Trailer(true, YoutubeOf(d)) : new Trailer(false, null));
            }, TimeSpan.FromSeconds(RequestTimeoutSeconds), ct).ConfigureAwait(false);
            if (got == null) return all.Count > 0 ? all : null;
            foreach (var (k, v) in got) all[k] = v;
        }
        return all;
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

    // One QueryFiles page (1-based) of `perPage` (≤ 100) items for the plan, in Steam's order, as the details the browse
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

    private static PublishedFileDetail ToDetail(PublishedFileDetails d) => new()
    {
        Id = d.publishedfileid.ToString(),
        Title = d.title ?? "",
        Description = !string.IsNullOrEmpty(d.file_description) ? d.file_description : d.short_description ?? "",
        PreviewUrl = d.preview_url ?? "",
        FileSizeBytes = (long)d.file_size,
        CreatorId = d.creator.ToString(),
        TimeUpdated = d.time_updated > 0 ? DateTimeOffset.FromUnixTimeSeconds(d.time_updated).UtcDateTime : DateTime.MinValue,
        Subscriptions = (long)d.lifetime_subscriptions,
        Favorites = (long)d.lifetime_favorited,
        Views = (long)d.views,
        Tags = d.tags.Select((t) => t.tag).Where((t) => !string.IsNullOrEmpty(t)).ToArray(),
        TrailerKnown = true,
        YoutubeId = YoutubeOf(d),
    };
}
