using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

// The moewalls Browse source: its latest list and its search share one page layout (MoewallsScraper)
public sealed class MoewallsService() : WebSource("Moewalls", LibraryStore.Moewalls)
{
    public override Task<List<WallpaperResult>> GetLatestAsync(int page) => MoewallsScraper.ListAsync(page, null);
    public override Task<List<WallpaperResult>> SearchAsync(string query, int page) => MoewallsScraper.ListAsync(page, query);
    public override Task<WallpaperDetail> GetDetailAsync(WallpaperResult result) => MoewallsScraper.DetailAsync(result);
}
