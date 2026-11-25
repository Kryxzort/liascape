using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Services;

// One of Browse's sources, a source pill in the UI (ServerHost's Providers, in pill order). GET /sources lists each one's
// name and traits; POST /browse asks for a page — a search when the user typed one and the source searches, else its latest;
// POST /detail and /download ask for one result's detail, the result posted back exactly as /browse returned it.
public interface IBrowseSource
{
    // the pill's label, and the source's key in LIASCAPE_WEB_SOURCES_FIXTURE
    string Name { get; }
    bool SupportsSearch => true;
    bool SupportsPagination => true; // false: the first page holds everything, the UI asks for no more
    bool SupportsSorting => false; // the UI's sort menu (WallpaperEngineService.SortIndex)
    bool SupportsTagFilter => false; // the Workshop's tag filter column
    int PageSizeHint => 30; // the placeholder cards the UI shows while a page loads
    Task<List<WallpaperResult>> GetLatestAsync(int page); // page counts from 1
    Task<List<WallpaperResult>> SearchAsync(string query, int page);
    // what the sidebar previews and a download fetches; throws when the item's page lacks it
    Task<WallpaperDetail> GetDetailAsync(WallpaperResult result);
}
