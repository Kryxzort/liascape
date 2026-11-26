using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Services;

// A Browse source that is a wallpaper website, read by its scraper (Scrapers/: motionbgs, moewalls, desktophut): it
// searches, pages, has no sort or tag filter, and under a hermetic test answers /browse from LIASCAPE_WEB_SOURCES_FIXTURE
// (Services/WebSourcesFixture.cs) instead of the site. Its downloads land in its own library folder (`Library`).
public abstract class WebSource(string name, string library) : IBrowseSource
{
    public string Name => name;
    public string Library => library;
    public abstract Task<List<WallpaperResult>> GetLatestAsync(int page);
    public abstract Task<List<WallpaperResult>> SearchAsync(string query, int page);
    public abstract Task<WallpaperDetail> GetDetailAsync(WallpaperResult result);
}
