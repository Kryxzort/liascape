using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Services;

public interface IBgsProvider
{
    string Name { get; }
    bool SupportsSearch { get; }
    bool SupportsPagination { get; }
    bool SupportsSorting { get; }
    bool SupportsTagFilter => false;
    // Expected results per page — drives how many placeholder cards to show while fetching.
    int PageSizeHint => 30;
    Task<List<WallpaperResult>> GetLatestAsync(int page = 1);
    Task<List<WallpaperResult>> SearchAsync(string query, int page = 1);
    Task<WallpaperDetail> GetDetailAsync(WallpaperResult result);
}
