using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

// The "Wallpaper Engine (Workshop)" Browse source (docs/decisions.md § "Browse the Workshop over Steam's client protocol,
// anonymously"). A page comes from Steam's own client protocol,
// anonymously (SteamWorkshopDetails.QueryAsync — PublishedFile.QueryFiles over SteamAnonymous' shared session): one app
// page = one QueryFiles page of 100, tags / previews / descriptions inline, ~1 s, and include/exclude tag filtering Steam
// does server-side (WorkshopTags — OR within a group, the age rule, playable types only, so pages come back full).
// Scraping steamcommunity.com's browse page instead (30 items a page, AND-only tags, a GetPublishedFileDetails call per
// page, a page read per detail click for the trailer) hits a host Steam rate-limits per IP — a lock-out of 30+ min that
// takes the user's browser with it. Scraping stays as the FALLBACK, when Steam's
// servers can't be reached / refuse (FallbackPagesPerLoad pages, no prefetch, through SteamGate; its cooldown → 429).
// LIASCAPE_WORKSHOP_FALLBACK=1 forces the fallback (testing).
public class SteamWorkshopService : IBgsProvider
{
    private const int CmPageSize = 100; // QueryFiles' numperpage cap (measured: asked for 200 or 500, Steam returns 100)
    // the fallback: two 30-item pages per app page — two SteamGate-spaced requests a scroll on a per-IP-limited host
    private const int FallbackPagesPerLoad = 2;
    // Steam's servers' share of a Browse request's ~15 s budget, ~6× a measured page (1.1–1.8 s); the fallback gets the rest
    private static readonly TimeSpan CmTimeout = TimeSpan.FromSeconds(10);

    public string Name => "Wallpaper Engine (Workshop)";
    public bool SupportsSearch => true;
    public bool SupportsPagination => true;
    public bool SupportsSorting => false;
    public bool SupportsTagFilter => true;
    public int PageSizeHint => CmPageSize;

    private readonly object _lock = new();
    private WorkshopFilter _filter = new();
    private string _filterKey = new WorkshopFilter().Key();
    private bool _allowScenes;
    private int _gen; // bumped when filter/scenes change → invalidates the prefetch

    // Every /browse sets these (ConfigureProvider); only a real change drops the prefetched page — compared by value, or a
    // re-sent identical filter would invalidate it on every request.
    public WorkshopFilter Filter
    {
        get { lock (_lock) return _filter; }
        set { var k = (value ?? new()).Key(); lock (_lock) { _filter = value ?? new(); if (k != _filterKey) { _filterKey = k; Invalidate(); } } }
    }
    public bool AllowScenes
    {
        get { lock (_lock) return _allowScenes; }
        set { lock (_lock) { if (value != _allowScenes) { _allowScenes = value; Invalidate(); } } }
    }
    public string WorkshopBasePath { get; set; } = "";

    private void Invalidate() { _gen++; DropPrefetch(); }

    // Background-fetched next page so a scroll-load is instant. Keyed by (gen, query, page). A stale one (the filter
    // changed, another page was asked for) is CANCELLED: the session serves one request at a time, and the user's real
    // request would queue behind a useless prefetch (measured: ~2 s a page instead of ~1 s).
    private (int gen, string? query, int page, Task<List<WallpaperResult>> task, CancellationTokenSource cts)? _prefetch;

    private void DropPrefetch() { if (_prefetch is { } p) { try { p.cts.Cancel(); } catch { } } _prefetch = null; }

    private enum Path { None, Steam, Fallback }
    private static Path _served = Path.None;

    public Task<List<WallpaperResult>> GetLatestAsync(int page = 1) => GetWithPrefetch(null, page);
    public Task<List<WallpaperResult>> SearchAsync(string query, int page = 1) => GetWithPrefetch(query, page);

    // Return the requested page (reusing the prefetched task if it matches); once it has come from Steam's servers, prime
    // the NEXT page so the following scroll-load resolves immediately. Started after the page, not beside it: the session
    // serves one request at a time, and the fallback never prefetches (each page read costs rate-limit budget).
    private Task<List<WallpaperResult>> GetWithPrefetch(string? query, int page)
    {
        int gen; WorkshopFilter filter; bool scenes; Task<List<WallpaperResult>> task;
        lock (_lock)
        {
            (gen, filter, scenes) = (_gen, _filter, _allowScenes);
            if (_prefetch is { } p && p.gen == gen && p.query == query && p.page == page) task = p.task;
            else { DropPrefetch(); task = FetchAsync(filter, scenes, query, page, CancellationToken.None); }
        }
        _ = task.ContinueWith((t) =>
        {
            if (t.Status != TaskStatus.RanToCompletion || t.Result.Count == 0 || _served != Path.Steam) return;
            lock (_lock)
            {
                if (gen != _gen || _prefetch is { } q && q.gen == gen && q.query == query && q.page == page + 1) return;
                DropPrefetch();
                var cts = new CancellationTokenSource();
                var next = FetchAsync(filter, scenes, query, page + 1, cts.Token);
                next.ContinueWith((n) => _ = n.Exception, TaskContinuationOptions.OnlyOnFaulted); // observe faults
                _prefetch = (gen, query, page + 1, next, cts);
            }
        }, TaskScheduler.Default);
        return task;
    }

    private static bool ForceFallback => Environment.GetEnvironmentVariable("LIASCAPE_WORKSHOP_FALLBACK") == "1";

    private static async Task<List<WallpaperResult>> FetchAsync(WorkshopFilter filter, bool allowScenes, string? query, int appPage, CancellationToken ct)
    {
        var plan = WorkshopTags.Build(filter, allowScenes);
        if (plan.Empty) return []; // e.g. every age excluded: nothing can match, don't ask
        var sw = Stopwatch.StartNew();
        if (!ForceFallback)
        {
            var details = await SteamWorkshopDetails.QueryAsync(filter, plan, query, appPage, CmPageSize, CmTimeout, ct).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested(); // a dropped prefetch: null meant "cancelled", not "unreachable" — no fallback
            if (details != null)
            {
                Served(Path.Steam, $"Steam's client protocol (anonymous) — page {appPage}: {details.Count} item(s) in {sw.ElapsedMilliseconds} ms");
                var byId = new Dictionary<string, SteamWorkshopScraper.PublishedFileDetail>();
                foreach (var d in details) byId.TryAdd(d.Id, d);
                return SteamWorkshopScraper.MapToResults(details.Select((d) => d.Id).Distinct().ToList(), byId, allowScenes);
            }
        }

        // FALLBACK: the Workshop browse page, FallbackPagesPerLoad consecutive pages (parallel, SteamGate-spaced), merged
        // (deduped by workshop id, order preserved). A cooldown → SteamCooldownException → /browse answers 429.
        Served(Path.Fallback, ForceFallback ? "Workshop page reading (forced by LIASCAPE_WORKSHOP_FALLBACK=1)"
            : "Workshop page reading — Steam's servers unreachable (rate-limited host, SteamGate-paced)");
        int basePage = (appPage - 1) * FallbackPagesPerLoad + 1;
        var tasks = Enumerable.Range(basePage, FallbackPagesPerLoad)
            .Select(p => Task.Run(() => SteamWorkshopScraper.BrowseAsync(filter, plan, query, p, allowScenes)));
        var pages = await Task.WhenAll(tasks).ConfigureAwait(false);

        var merged = new List<WallpaperResult>();
        var seen = new HashSet<string>();
        foreach (var r in pages.SelectMany(p => p))
            if (r.WorkshopId == null || seen.Add(r.WorkshopId))
                merged.Add(r);
        return merged;
    }

    // adapter-style log, once per path change (not per page)
    private static void Served(Path path, string what)
    {
        if (_served == path) return;
        _served = path;
        Console.WriteLine($"browse: Workshop via {what}");
    }

    public async Task<WallpaperDetail> GetDetailAsync(WallpaperResult result)
    {
        // The YouTube trailer: a result from Steam's client protocol already has it (TrailerKnown). Otherwise (a fallback
        // result) ask the same servers for that one item (shared session, no page), and only then read the item's Steam
        // page (rate-gated — a steamcommunity.com hit per click was the old cost of every detail).
        string? youtube = result.YoutubeUrl;
        if (!result.TrailerKnown && result.WorkshopId is { } wid)
        {
            Dictionary<ulong, SteamWorkshopDetails.Details>? cm = null;
            if (ulong.TryParse(wid, out var n))
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                try { cm = await SteamWorkshopDetails.GetDetailsAsync([n], cts.Token).ConfigureAwait(false); } catch { }
            }
            youtube = cm != null && cm.TryGetValue(n, out var t) && t.Found
                ? t.Youtube is { } y ? $"https://www.youtube.com/watch?v={y}" : null
                : await SteamWorkshopScraper.GetYoutubeUrlAsync(wid).ConfigureAwait(false);
        }
        string? age = result.Tags?.FirstOrDefault(t => t is "Everyone" or "Questionable" or "Mature");
        return new WallpaperDetail
        {
            Title = result.Title,
            PreviewUrl = result.ThumbnailUrl,
            DownloadUrl = result.PageUrl,
            NeedsReferrer = false,
            IsScene = result.IsScene,
            WorkshopId = result.WorkshopId,
            IsWorkshopAcquire = true,
            // rich metadata → persisted at download + shown in the preview/settings modals
            Resolution = result.Resolution, AgeRating = age, YoutubeUrl = youtube,
            PageUrl = result.PageUrl, AuthorName = result.AuthorName, Description = result.Description,
            FileSizeBytes = result.FileSizeBytes, Subscriptions = result.Subscriptions,
            Favorites = result.Favorites, Views = result.Views, Tags = result.Tags,
        };
    }
}
