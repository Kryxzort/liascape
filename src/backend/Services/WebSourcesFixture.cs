using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Services;

// LIASCAPE_WEB_SOURCES_FIXTURE=<file.json> (hermetic tests: the UI matrix): Browse's web sources (Services/WebSource.cs:
// motionbgs, moewalls, desktophut) answer /browse from this file instead of their sites — `{"<source name>": [<WallpaperResult
// as /browse returns it>, …]}`, one page of everything (page 2 on is empty, a query matches titles); a source not in it
// lists nothing. The page reads the first source at every load, so without it every test page would scrape a real site.
// The Workshop has its own (LIASCAPE_STEAM_CM_FIXTURE "@query", Helpers/SteamWorkshopDetails.cs) and the local WE folder
// is files already.
public static class WebSourcesFixture
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // null = no fixture (the source's own scraper answers)
    public static List<WallpaperResult>? Page(IBrowseSource p, int page, string? query)
    {
        if (p is not WebSource) return null;
        if (Environment.GetEnvironmentVariable("LIASCAPE_WEB_SOURCES_FIXTURE") is not { Length: > 0 } file) return null;
        List<WallpaperResult> all = [];
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            if (doc.RootElement.TryGetProperty(p.Name, out var arr) && arr.ValueKind == JsonValueKind.Array)
                all = arr.Deserialize<List<WallpaperResult>>(Json) ?? [];
        }
        catch (Exception e) { Console.WriteLine($"browse: LIASCAPE_WEB_SOURCES_FIXTURE unreadable ({e.GetType().Name}) — {p.Name} lists nothing"); }
        if (page > 1) return [];
        return string.IsNullOrWhiteSpace(query) ? all : all.Where((r) => r.Title.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
    }
}
