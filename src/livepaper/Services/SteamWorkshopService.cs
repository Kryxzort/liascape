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

    public WorkshopFilter Filter { get; set; } = new();
    public bool AllowScenes { get; set; } = false;
    public string WorkshopBasePath { get; set; } = "";

    public Task<List<WallpaperResult>> GetLatestAsync(int page = 1)
        => FetchPagesAsync(null, page);

    public Task<List<WallpaperResult>> SearchAsync(string query, int page = 1)
        => FetchPagesAsync(query, page);

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

    public Task<WallpaperDetail> GetDetailAsync(WallpaperResult result)
        => Task.FromResult(new WallpaperDetail
        {
            Title = result.Title,
            PreviewUrl = result.ThumbnailUrl,
            DownloadUrl = result.PageUrl,
            NeedsReferrer = false,
            IsScene = result.IsScene,
            WorkshopId = result.WorkshopId,
            IsWorkshopAcquire = true
        });
}
