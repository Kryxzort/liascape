using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

// The desktophut Browse source: its animated-wallpapers category and its search share one page layout (DesktophutScraper)
public sealed class DesktophutService() : WebSource("Desktophut", LibraryStore.Desktophut)
{
    public override Task<List<WallpaperResult>> GetLatestAsync(int page) => DesktophutScraper.ListAsync(page, null);
    public override Task<List<WallpaperResult>> SearchAsync(string query, int page) => DesktophutScraper.ListAsync(page, query);
    public override Task<WallpaperDetail> GetDetailAsync(WallpaperResult result) => DesktophutScraper.DetailAsync(result);
}
