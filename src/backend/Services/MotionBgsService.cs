using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Services;

// The motionbgs Browse source. A search's later pages depend on what its first page was: the search's own pages, or a
// tag's pages when the site redirected the query to a tag (MotionBgsScraper). Each query's answer is remembered, so page 2
// of any query the backend has searched follows the right list; a query it hasn't (the backend restarted under an open
// page) asks page 1 again first to find out.
public sealed class MotionBgsService() : WebSource("MotionBgs")
{
    // query → the tag path it redirected to, "" = a plain search
    private readonly ConcurrentDictionary<string, string> _listOf = new();

    public override Task<List<WallpaperResult>> GetLatestAsync(int page) => MotionBgsScraper.LatestAsync(page);

    public override async Task<List<WallpaperResult>> SearchAsync(string query, int page)
    {
        if (page <= 1 || !_listOf.TryGetValue(query, out var tagPath))
        {
            var (cards, tag) = await MotionBgsScraper.SearchFirstAsync(query);
            if (_listOf.Count > 200) _listOf.Clear();
            _listOf[query] = tagPath = tag ?? "";
            if (page <= 1) return cards;
        }
        return tagPath.Length > 0
            ? await MotionBgsScraper.TagPageAsync(tagPath, page)
            : await MotionBgsScraper.SearchPageAsync(query, page);
    }

    public override Task<WallpaperDetail> GetDetailAsync(WallpaperResult result) => MotionBgsScraper.DetailAsync(result);
}
