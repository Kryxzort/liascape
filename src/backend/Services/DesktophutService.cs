using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

public class DesktophutService : IBgsProvider
{
    public string Name => "Desktophut";
    public bool SupportsSearch => true;
    public bool SupportsPagination => true;
    public bool SupportsSorting => false;

    public Task<List<WallpaperResult>> GetLatestAsync(int page = 1)
        => DesktophutScraper.GetLatestAsync(page);

    public Task<List<WallpaperResult>> SearchAsync(string query, int page = 1)
        => DesktophutScraper.SearchAsync(query, page);

    public Task<WallpaperDetail> GetDetailAsync(WallpaperResult result)
        => DesktophutScraper.GetDetailAsync(result);
}
