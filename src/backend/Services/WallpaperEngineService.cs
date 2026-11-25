using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

// The "Wallpaper Engine (Local)" Browse source: the Workshop folder's items already on disk (WallpaperEngineScraper), one
// page of them, sortable. Every /browse and /detail sets the folder and what may be listed from the live settings
// (ServerHost.ConfigureProvider). A detail is the card itself: its file or folder is what a download imports.
public sealed class WallpaperEngineService : IBrowseSource
{
    public string WorkshopPath { get; set; } = "";
    public bool AllowScenes { get; set; }
    // presets list as their own cards: scene support on (ServerHost.ConfigureProvider), as the Workshop's AllowPresets
    public bool AllowPresets { get; set; }
    public int SortIndex { get; set; } // WallpaperEngineScraper.ListAsync's sortIndex

    public string Name => "Wallpaper Engine (Local)";
    // the first page is the whole folder (the UI asks for no other)
    public bool SupportsPagination => false;
    public bool SupportsSorting => true;

    public Task<List<WallpaperResult>> GetLatestAsync(int page) => ListAsync(null);
    public Task<List<WallpaperResult>> SearchAsync(string query, int page) => ListAsync(query);

    private Task<List<WallpaperResult>> ListAsync(string? query) =>
        WallpaperEngineScraper.ListAsync(WorkshopPath, AllowScenes, AllowPresets, query, SortIndex);

    public Task<WallpaperDetail> GetDetailAsync(WallpaperResult result) => Task.FromResult(new WallpaperDetail
    {
        Title = result.Title,
        PreviewUrl = result.ThumbnailUrl,
        DownloadUrl = result.PageUrl,
        IsScene = result.IsScene,
        WorkshopId = result.WorkshopId,
    });
}
