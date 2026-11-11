using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using HtmlAgilityPack;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Scrapers;

public static class SteamWorkshopScraper
{
    private static readonly Regex _idRegex = new(@"filedetails/\?id=(\d+)", RegexOptions.Compiled);
    private static readonly Regex _resolutionRegex = new(@"^\d+ x \d+$", RegexOptions.Compiled);
    private static readonly Regex _youtubeRegex = new(@"YOUTUBE_VIDEO_ID:\s*""([A-Za-z0-9_-]{11})""", RegexOptions.Compiled);

    // Returns the YouTube trailer URL for a workshop item if its Steam page has one, else null (also when the page
    // couldn't be read). The item page exposes it as a JS var `YOUTUBE_VIDEO_ID: "<id>"`.
    public static async Task<string?> GetYoutubeUrlAsync(string workshopId) => (await CheckYoutubeAsync(workshopId, SteamGate.Kind.Interactive).ConfigureAwait(false)).Url;

    public enum PageCheck { Ok, Failed, RateLimited }

    // The same, telling "checked: no trailer" (Ok, Url null) from "couldn't check" (!Ok — offline, Steam down, an error
    // page, a removed item): the trailer cache (Web/TrailerOps) stores the first and retries the second. `Ok` needs the
    // page to BE an item page (its title block), not just a 200 — Steam answers some errors with a 200 page. `RateLimited`
    // = Steam's 429 (it limits page reads: ~100+ quick reads in a row trip it) — wait and retry, it isn't "offline".
    // Through SteamGate (every steamcommunity request is): a cooldown → RateLimited without sending anything.
    public static async Task<(PageCheck Result, string? Url)> CheckYoutubeAsync(string workshopId, SteamGate.Kind kind)
    {
        try
        {
            using var req = new HttpRequestMessage(
                HttpMethod.Get, $"https://steamcommunity.com/sharedfiles/filedetails/?id={workshopId}");
            req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
            using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var resp = await SteamGate.SendAsync(req, kind, cts.Token).ConfigureAwait(false);
            if ((int)resp.StatusCode == 429) return (PageCheck.RateLimited, null);
            if (!resp.IsSuccessStatusCode) return (PageCheck.Failed, null);
            var html = await resp.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
            if (!html.Contains("workshopItemTitle")) return (PageCheck.Failed, null);
            var m = _youtubeRegex.Match(html);
            return (PageCheck.Ok, m.Success ? $"https://www.youtube.com/watch?v={m.Groups[1].Value}" : null);
        }
        catch (SteamCooldownException) { return (PageCheck.RateLimited, null); }
        catch { return (PageCheck.Failed, null); }
    }

    // The FALLBACK Browse path (the client protocol — SteamWorkshopDetails.QueryAsync — is the first): reads one
    // steamcommunity.com browse page (30 items; rate-limited per IP, so through SteamGate). The page only ANDs
    // `requiredtags[]`, so it gets the plan's single-tag groups (a group with one allowed tag, every ticked feature) and
    // the rest of the plan — OR groups, excludes, the age rule — is checked here on each result's tags (WorkshopTags.Matches).
    public static async Task<List<WallpaperResult>> BrowseAsync(WorkshopFilter filter, WorkshopTags.Plan plan, string? query, int page, bool allowScenes)
    {
        var url = BuildUrl(filter, plan, query, page);
        string html;
        using (var req = new HttpRequestMessage(HttpMethod.Get, url))
        {
            req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
            // through SteamGate: spaced with every other Steam Community request; a cooldown throws SteamCooldownException
            // ("try again in N min") before anything is sent
            using var resp = await SteamGate.SendAsync(req, SteamGate.Kind.Interactive).ConfigureAwait(false);
            if ((int)resp.StatusCode == 429) throw new SteamCooldownException(SteamGate.CooldownRemaining);
            resp.EnsureSuccessStatusCode();
            html = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        }

        // HtmlAgilityPack parsing is CPU-bound — keep it off the UI thread
        var ids = await Task.Run(() => ExtractIds(html)).ConfigureAwait(false);
        if (ids.Count == 0) return [];

        var details = await GetDetailsBatchAsync(ids).ConfigureAwait(false);
        return await Task.Run(() => MapToResults(ids, details, allowScenes)
            .Where((r) => WorkshopTags.Matches(plan, r.Tags ?? [])).ToList()).ConfigureAwait(false);
    }

    private static string BuildUrl(WorkshopFilter filter, WorkshopTags.Plan plan, string? query, int page)
    {
        var sb = new StringBuilder(
            "https://steamcommunity.com/workshop/browse/?appid=431960&section=readytouseitems&numperpage=30");

        string sort = filter.Sort switch
        {
            "mostrecent" => "mostrecent",
            "lastupdated" => "lastupdated",
            "totaluniquesubscribers" => "totaluniquesubscribers",
            "toprated" => "toprated",
            _ => "trend"
        };
        sb.Append($"&browsesort={sort}");
        if (sort == "trend" && filter.TrendDays > 0)
            sb.Append($"&days={filter.TrendDays}");

        if (page > 1)
            sb.Append($"&p={page}");

        if (!string.IsNullOrWhiteSpace(query))
            sb.Append($"&searchtext={Uri.EscapeDataString(query.Trim())}");

        foreach (var tag in plan.RequiredTags)
            sb.Append($"&requiredtags%5B%5D={Uri.EscapeDataString(tag)}");

        return sb.ToString();
    }

    private static List<string> ExtractIds(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var seen = new HashSet<string>();
        var ids = new List<string>();

        var nodes = doc.DocumentNode
            .SelectNodes("//a[contains(@href,'filedetails/?id=')]");

        if (nodes == null) return ids;

        foreach (var node in nodes)
        {
            var href = node.GetAttributeValue("href", "");
            var m = _idRegex.Match(href);
            if (m.Success && seen.Add(m.Groups[1].Value))
                ids.Add(m.Groups[1].Value);
        }

        return ids;
    }

    public static async Task<Dictionary<string, PublishedFileDetail>> GetDetailsBatchAsync(IReadOnlyList<string> ids)
    {
        if (ids.Count == 0) return new Dictionary<string, PublishedFileDetail>();

        var formData = new List<KeyValuePair<string, string>>
        {
            new("itemcount", ids.Count.ToString())
        };
        for (int i = 0; i < ids.Count; i++)
            formData.Add(new($"publishedfileids[{i}]", ids[i]));

        using var req = new HttpRequestMessage(
            HttpMethod.Post,
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/")
        {
            Content = new FormUrlEncodedContent(formData)
        };
        req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);

        using var resp = await HttpClientProvider.Client.SendAsync(req).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        var doc = JsonDocument.Parse(json);
        var result = new Dictionary<string, PublishedFileDetail>();

        if (!doc.RootElement.TryGetProperty("response", out var response)) return result;
        if (!response.TryGetProperty("publishedfiledetails", out var fileDetails)) return result;

        foreach (var item in fileDetails.EnumerateArray())
        {
            if (!item.TryGetProperty("publishedfileid", out var idProp)) continue;
            if (!item.TryGetProperty("result", out var resultProp) || resultProp.GetInt32() != 1) continue;

            var id = idProp.GetString() ?? "";
            var tags = new List<string>();
            if (item.TryGetProperty("tags", out var tagArray))
                foreach (var t in tagArray.EnumerateArray())
                    if (t.TryGetProperty("tag", out var tagVal))
                        tags.Add(tagVal.GetString() ?? "");

            long fileSize = 0;
            if (item.TryGetProperty("file_size", out var fs))
            {
                if (fs.ValueKind == JsonValueKind.String)
                    long.TryParse(fs.GetString(), out fileSize);
                else if (fs.ValueKind == JsonValueKind.Number)
                    fileSize = fs.GetInt64();
            }

            result[id] = new PublishedFileDetail
            {
                Id = id,
                Title = item.TryGetProperty("title", out var title) ? title.GetString() ?? "" : "",
                Description = item.TryGetProperty("description", out var desc) ? desc.GetString() ?? "" : "",
                PreviewUrl = item.TryGetProperty("preview_url", out var prev) ? prev.GetString() ?? "" : "",
                FileSizeBytes = fileSize,
                CreatorId = item.TryGetProperty("creator", out var creator) ? creator.GetString() ?? "" : "",
                TimeUpdated = item.TryGetProperty("time_updated", out var tu)
                    ? DateTimeOffset.FromUnixTimeSeconds(tu.GetInt64()).UtcDateTime
                    : DateTime.MinValue,
                Subscriptions = item.TryGetProperty("lifetime_subscriptions", out var subs) ? subs.GetInt64() : 0,
                Favorites = item.TryGetProperty("lifetime_favorited", out var fav) ? fav.GetInt64() : 0,
                Views = item.TryGetProperty("views", out var views) ? views.GetInt64() : 0,
                Tags = tags.ToArray()
            };
        }

        return result;
    }

    // Shared by both Browse paths (the client protocol's QueryFiles results and the fallback's GetPublishedFileDetails).
    public static List<WallpaperResult> MapToResults(
        IReadOnlyList<string> orderedIds,
        Dictionary<string, PublishedFileDetail> details,
        bool allowScenes)
    {
        var results = new List<WallpaperResult>();

        foreach (var id in orderedIds)
        {
            if (!details.TryGetValue(id, out var d)) continue;

            bool isScene = d.Tags.Contains("Scene", StringComparer.OrdinalIgnoreCase);
            bool isVideo = d.Tags.Contains("Video", StringComparer.OrdinalIgnoreCase);

            bool isUnplayable = d.Tags.Any(t =>
                string.Equals(t, "Web", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(t, "Application", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(t, "Preset", StringComparison.OrdinalIgnoreCase));
            if (isUnplayable) continue;

            if (isScene && !allowScenes) continue;
            if (!isScene && !isVideo) continue;

            string? resolution = d.Tags.FirstOrDefault(t => _resolutionRegex.IsMatch(t));

            string rawPreviewUrl = d.PreviewUrl;
            string thumbUrl = rawPreviewUrl;
            if (!string.IsNullOrEmpty(thumbUrl) && !thumbUrl.Contains('?'))
                thumbUrl += "?imw=384&imh=216&letterbox=true";

            // Pass raw URL as AnimatedThumbnailUrl so the card tries animated loading on hover.
            // Steam serves GIF/WebP animated previews at the raw URL; JPEG items fail silently.
            string? animatedUrl = string.IsNullOrEmpty(rawPreviewUrl) ? null : rawPreviewUrl;

            results.Add(new WallpaperResult
            {
                Title = d.Title,
                ThumbnailUrl = thumbUrl,
                AnimatedThumbnailUrl = animatedUrl,
                PageUrl = $"https://steamcommunity.com/sharedfiles/filedetails/?id={id}",
                IsScene = isScene,
                WorkshopId = id,
                Resolution = resolution,
                AddedAt = d.TimeUpdated != DateTime.MinValue ? d.TimeUpdated : null,
                Description = d.Description,
                AuthorId = d.CreatorId,
                FileSizeBytes = d.FileSizeBytes > 0 ? d.FileSizeBytes : null,
                Subscriptions = d.Subscriptions,
                Favorites = d.Favorites,
                Views = d.Views,
                Tags = d.Tags,
                // QueryFiles carries the previews: the detail then needs no page read for the trailer
                TrailerKnown = d.TrailerKnown,
                YoutubeUrl = d.YoutubeId is { } y ? $"https://www.youtube.com/watch?v={y}" : null,
            });
        }

        return results;
    }

    public record PublishedFileDetail
    {
        public string Id { get; init; } = "";
        public string Title { get; init; } = "";
        public string Description { get; init; } = "";
        public string PreviewUrl { get; init; } = "";
        public long FileSizeBytes { get; init; }
        public string CreatorId { get; init; } = "";
        public DateTime TimeUpdated { get; init; }
        public long Subscriptions { get; init; }
        public long Favorites { get; init; }
        public long Views { get; init; }
        public string[] Tags { get; init; } = [];
        // set by the client-protocol path (its previews are inline): the YouTube id is known, null = no trailer
        public bool TrailerKnown { get; init; }
        public string? YoutubeId { get; init; }
    }
}
