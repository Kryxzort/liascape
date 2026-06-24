using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using livepaper.Models;
using livepaper.Scrapers;

namespace livepaper.Services;

public class SteamWorkshopService : IBgsProvider
{
    // Steam caps numperpage at 30, so fetch this many Steam pages per app page (concurrently) to
    // show ~3x the cards per load. Placeholder count tracks this via PageSizeHint.
    private const int PagesPerLoad = 3;
    private const int SteamPageSize = 30;

    public string Name => "Wallpaper Engine (Workshop)";
    public bool SupportsSearch => true;
    public bool SupportsPagination => true;
    public bool SupportsSorting => false;
    public bool SupportsTagFilter => true;
    public int PageSizeHint => PagesPerLoad * SteamPageSize;

    private WorkshopFilter _filter = new();
    private bool _allowScenes;
    private int _gen; // bumped when filter/scenes change → invalidates the prefetch

    public WorkshopFilter Filter { get => _filter; set { _filter = value; Invalidate(); } }
    public bool AllowScenes { get => _allowScenes; set { _allowScenes = value; Invalidate(); } }
    public string WorkshopBasePath { get; set; } = "";

    private void Invalidate() { _gen++; _prefetch = null; }

    // Background-fetched next page so a scroll-load is instant. Keyed by (gen, query, page).
    private (int gen, string? query, int page, Task<List<WallpaperResult>> task)? _prefetch;

    public Task<List<WallpaperResult>> GetLatestAsync(int page = 1) => GetWithPrefetch(null, page);
    public Task<List<WallpaperResult>> SearchAsync(string query, int page = 1) => GetWithPrefetch(query, page);

    // Return the requested page (reusing the prefetched task if it matches), and prime the NEXT page
    // in the background so the following scroll-load resolves immediately. Called on the UI thread.
    private Task<List<WallpaperResult>> GetWithPrefetch(string? query, int page)
    {
        Task<List<WallpaperResult>> task =
            _prefetch is { } p && p.gen == _gen && p.query == query && p.page == page
                ? p.task
                : FetchPagesAsync(query, page);

        var next = FetchPagesAsync(query, page + 1);
        next.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted); // observe faults
        _prefetch = (_gen, query, page + 1, next);
        return task;
    }

    // One app "page" = PagesPerLoad consecutive Steam pages, fetched in parallel and merged
    // (deduped by workshop id, order preserved).
    private async Task<List<WallpaperResult>> FetchPagesAsync(string? query, int appPage)
    {
        int basePage = (appPage - 1) * PagesPerLoad + 1;
        var tasks = Enumerable.Range(basePage, PagesPerLoad)
            .Select(p => Task.Run(() => SteamWorkshopScraper.BrowseAsync(Filter, query, p, AllowScenes)));
        var pages = await Task.WhenAll(tasks).ConfigureAwait(false);

        var merged = new List<WallpaperResult>();
        var seen = new HashSet<string>();
        foreach (var r in pages.SelectMany(p => p))
            if (r.WorkshopId == null || seen.Add(r.WorkshopId))
                merged.Add(r);
        return merged;
    }

    public async Task<WallpaperDetail> GetDetailAsync(WallpaperResult result)
    {
        // YouTube trailer (if any) is scraped from the item's Steam page; age rating is a tag.
        string? youtube = result.WorkshopId != null
            ? await SteamWorkshopScraper.GetYoutubeUrlAsync(result.WorkshopId).ConfigureAwait(false)
            : null;
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
