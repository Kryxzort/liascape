using System.Collections.Generic;
using System.Threading.Tasks;
using livepaper.Models;
using livepaper.Scrapers;

namespace livepaper.Services;

public class SteamWorkshopService : IBgsProvider
{
    public string Name => "Wallpaper Engine (Workshop)";
    public bool SupportsSearch => true;
    public bool SupportsPagination => true;
    public bool SupportsSorting => false;
    public bool SupportsTagFilter => true;

    public WorkshopFilter Filter { get; set; } = new();
    public bool AllowScenes { get; set; } = false;
    public string WorkshopBasePath { get; set; } = "";

    public Task<List<WallpaperResult>> GetLatestAsync(int page = 1)
        => Task.Run(() => SteamWorkshopScraper.BrowseAsync(Filter, null, page, AllowScenes));

    public Task<List<WallpaperResult>> SearchAsync(string query, int page = 1)
        => Task.Run(() => SteamWorkshopScraper.BrowseAsync(Filter, query, page, AllowScenes));

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
