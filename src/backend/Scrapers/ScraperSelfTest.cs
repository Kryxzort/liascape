using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Services;

namespace Liascape.Scrapers;

// hidden `liascape-backend scraper-selftest [<fixtures dir>] [--write]` (PASS/FAIL, exit 1 on a failure): Browse's sources
// against saved pages, never the sites. Each web source's service runs its own calls (latest, search and its later pages,
// a detail) with every page it asks for answered from `scripts/test-fixtures/scrapers/<site>/` — the trimmed elements its
// parser reads, captured from the site — and the URLs it asked for and what it returned must equal `expected.json`. The
// local Wallpaper Engine folder runs over a copy of `wallpaper-engine/` (fake items: video, scene, preset, the skipped kinds)
// under a private HOME (the GIF thumbnails' cache). `--write` rewrites `expected.json` from what the code returns now —
// only to pin a deliberate change, after reading the diff. A site that changed its markup: capture its page again, trim it
// the same way, and fix the parser until this passes.
public static class ScraperSelfTest
{
    // the selftest's stand-in for the sites: a URL → the page's HTML and the URL it ended at (a redirect); null outside it
    internal static Func<string, (string Html, string FinalUrl)>? Pages;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingDefault,
        WriteIndented = true,
    };

    private sealed class Site(string dir)
    {
        public readonly List<string> Asked = [];
        public readonly Dictionary<string, (string File, string? FinalUrl)> Map = new(StringComparer.Ordinal);

        public (string Html, string FinalUrl) Answer(string url)
        {
            Asked.Add(url);
            if (!Map.TryGetValue(url, out var page)) throw new InvalidOperationException($"no fixture page for {url}");
            return (File.ReadAllText(Path.Combine(dir, page.File)), page.FinalUrl ?? url);
        }
    }

    public static int Run(string[] args)
    {
        bool write = args.Contains("--write");
        string? dir = args.FirstOrDefault((a) => !a.StartsWith("--", StringComparison.Ordinal)) ?? FindFixtures();
        if (dir == null || !Directory.Exists(dir))
        {
            Console.Error.WriteLine("scraper-selftest: no fixtures — pass scripts/test-fixtures/scrapers (or run it from the repo)");
            return 2;
        }
        string tmp = Directory.CreateTempSubdirectory("liascape-scraper-selftest-").FullName;
        // the local folder's GIF thumbnails go to ~/.cache: a private HOME, never the user's
        Environment.SetEnvironmentVariable("HOME", Directory.CreateDirectory(Path.Combine(tmp, "home")).FullName);
        Environment.SetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK", "1");
        var got = new JsonObject();
        try
        {
            if (!WallpaperEngineScraper.GifThumbCacheDir.StartsWith(tmp, StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"scraper-selftest: refusing — the GIF thumbnail cache ({WallpaperEngineScraper.GifThumbCacheDir}) is not under the private HOME");
                return 2;
            }
            RunAll(dir, tmp, got).GetAwaiter().GetResult();
        }
        finally
        {
            Pages = null;
            try { Directory.Delete(tmp, recursive: true); } catch { }
        }

        string expectedFile = Path.Combine(dir, "expected.json");
        if (write)
        {
            File.WriteAllText(expectedFile, Canonical(got)!.ToJsonString(Json) + "\n");
            Console.WriteLine($"scraper-selftest: wrote {expectedFile} ({got.Count} cases)");
            return 0;
        }
        if (!File.Exists(expectedFile))
        {
            Console.Error.WriteLine($"scraper-selftest: {expectedFile} missing (--write makes it)");
            return 2;
        }
        var expected = JsonNode.Parse(File.ReadAllText(expectedFile))!.AsObject();
        int fails = 0, passes = 0;
        foreach (var name in expected.Select((kv) => kv.Key).Union(got.Select((kv) => kv.Key)))
        {
            string want = Canonical(expected[name])?.ToJsonString(Json) ?? "(no case)";
            string have = Canonical(got[name])?.ToJsonString(Json) ?? "(no case)";
            if (want == have) { passes++; Console.WriteLine($"PASS {name}"); continue; }
            fails++;
            Console.WriteLine($"FAIL {name}");
            var w = want.Split('\n'); var h = have.Split('\n');
            int i = 0;
            while (i < w.Length && i < h.Length && w[i] == h[i]) i++;
            Console.WriteLine($"     expected line {i + 1}: {(i < w.Length ? w[i].Trim() : "(end)")}");
            Console.WriteLine($"     got      line {i + 1}: {(i < h.Length ? h[i].Trim() : "(end)")}");
        }
        Console.WriteLine($"scraper-selftest: {passes} pass, {fails} fail");
        return fails == 0 ? 0 : 1;
    }

    private static string? FindFixtures()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            for (var d = new DirectoryInfo(start); d != null; d = d.Parent)
            {
                string f = Path.Combine(d.FullName, "scripts", "test-fixtures", "scrapers");
                if (Directory.Exists(f)) return f;
            }
        return null;
    }

    private static async Task RunAll(string dir, string tmp, JsonObject got)
    {
        got["providers"] = Node(new IBrowseSource[] { new MotionBgsService(), new MoewallsService(), new DesktophutService(), new WallpaperEngineService() }
            .Select((p) => new { p.Name, p.SupportsSearch, p.SupportsPagination, p.SupportsSorting, p.SupportsTagFilter, p.PageSizeHint }));

        // motionbgs: the latest list is the site's HTMX fragment; a search either lists matches or redirects to a tag's page
        // (a query that names a tag), and its later pages follow whichever it was
        var mb = new Site(Path.Combine(dir, "motionbgs"));
        mb.Map["https://www.motionbgs.com/hx2/latest/2/"] = ("latest.html", "https://motionbgs.com/hx2/latest/2/");
        mb.Map["https://www.motionbgs.com/search?q=girl%20rain&page=1"] = ("search.html", "https://motionbgs.com/search?q=girl%20rain&page=1");
        mb.Map["https://www.motionbgs.com/search?q=girl%20rain&page=2"] = ("search.html", null);
        mb.Map["https://www.motionbgs.com/search?q=car&page=1"] = ("tag.html", "https://motionbgs.com/tag:car/");
        mb.Map["https://www.motionbgs.com/tag:car/2/"] = ("tag.html", null);
        mb.Map["https://www.motionbgs.com/samurai-girl-rain-lantern"] = ("detail.html", null);
        mb.Map["https://www.motionbgs.com/no-video"] = ("latest.html", null);
        var mbs = new MotionBgsService();
        await Case(got, mb, "motionbgs latest p2", () => mbs.GetLatestAsync(2));
        await Case(got, mb, "motionbgs search", () => mbs.SearchAsync("girl rain", 1));
        await Case(got, mb, "motionbgs search p2", () => mbs.SearchAsync("girl rain", 2));
        await Case(got, mb, "motionbgs tag", () => mbs.SearchAsync("car", 1));
        await Case(got, mb, "motionbgs tag p2", () => mbs.SearchAsync("car", 2));
        await Case(got, mb, "motionbgs tag p1 again", () => mbs.SearchAsync("car", 1));
        // a later page of a query this backend never searched (it restarted under an open page): page 1 first, to learn
        // whether the query is a tag's
        await Case(got, mb, "motionbgs tag p2, query not seen", () => new MotionBgsService().SearchAsync("car", 2));
        await Case(got, mb, "motionbgs detail", () => mbs.GetDetailAsync(Result("Samurai Girl With Lantern", "https://www.motionbgs.com/samurai-girl-rain-lantern")));
        await Case(got, mb, "motionbgs detail without video", () => mbs.GetDetailAsync(Result("Broken", "https://www.motionbgs.com/no-video")));

        var mw = new Site(Path.Combine(dir, "moewalls"));
        mw.Map["https://moewalls.com/page/2"] = ("search.html", null);
        mw.Map["https://moewalls.com/page/1/?s=rain"] = ("search.html", null);
        mw.Map["https://moewalls.com/page/3/?s=black%20cat"] = ("search.html", null);
        mw.Map["https://moewalls.com/anime/gojo-and-black-cat-rainy-nights-in-tokyo-jujutsu-kaisen-live-wallpaper/"] = ("detail.html", null);
        mw.Map["https://moewalls.com/no-video/"] = ("search.html", null);
        var mws = new MoewallsService();
        await Case(got, mw, "moewalls latest p2", () => mws.GetLatestAsync(2));
        await Case(got, mw, "moewalls search", () => mws.SearchAsync("rain", 1));
        await Case(got, mw, "moewalls search p3", () => mws.SearchAsync("black cat", 3));
        await Case(got, mw, "moewalls detail", () => mws.GetDetailAsync(Result("Gojo And Black Cat",
            "https://moewalls.com/anime/gojo-and-black-cat-rainy-nights-in-tokyo-jujutsu-kaisen-live-wallpaper/")));
        await Case(got, mw, "moewalls detail without video", () => mws.GetDetailAsync(Result("Broken", "https://moewalls.com/no-video/")));

        var dh = new Site(Path.Combine(dir, "desktophut"));
        dh.Map["https://www.desktophut.com/category/Animated-Wallpapers?page=2"] = ("search.html", null);
        dh.Map["https://www.desktophut.com/search/rain?page=1"] = ("search.html", null);
        dh.Map["https://www.desktophut.com/search/spider%20man?page=2"] = ("search.html", null);
        dh.Map["https://www.desktophut.com/spider-man-rain-live-wallpaper-caeb"] = ("detail.html", null);
        dh.Map["https://www.desktophut.com/no-video"] = ("search.html", null);
        var dhs = new DesktophutService();
        await Case(got, dh, "desktophut latest p2", () => dhs.GetLatestAsync(2));
        await Case(got, dh, "desktophut search", () => dhs.SearchAsync("rain", 1));
        await Case(got, dh, "desktophut search p2", () => dhs.SearchAsync("spider man", 2));
        await Case(got, dh, "desktophut detail", () => dhs.GetDetailAsync(Result("Spider-Man Rain",
            "https://www.desktophut.com/spider-man-rain-live-wallpaper-caeb")));
        await Case(got, dh, "desktophut detail without video", () => dhs.GetDetailAsync(Result("Broken", "https://www.desktophut.com/no-video")));

        await LocalFolder(Path.Combine(dir, "wallpaper-engine"), tmp, got);
    }

    // the GIF still cache's files after `call`, which starts from an empty cache
    private static async Task<List<string>> CachedAfter(Func<Task> call)
    {
        string cache = WallpaperEngineScraper.GifThumbCacheDir;
        if (Directory.Exists(cache)) Directory.Delete(cache, recursive: true);
        await call();
        return Directory.Exists(cache) ? Directory.GetFiles(cache).Select((f) => Path.GetFileName(f)).Order(StringComparer.Ordinal).ToList() : [];
    }

    private static WallpaperResult Result(string title, string page) => new() { Title = title, ThumbnailUrl = "", PageUrl = page };

    private static async Task Case<T>(JsonObject got, Site site, string name, Func<Task<T>> call)
    {
        site.Asked.Clear();
        Pages = site.Answer;
        JsonNode? result;
        try { result = Node(await call()); }
        // a page without what the parser needs fails the call (the route answers it as an error), never an empty URL; a
        // URL no fixture answers is the source asking for the wrong page
        catch (Exception e) { result = JsonValue.Create(e.Message.StartsWith("no fixture page", StringComparison.Ordinal) ? e.Message : "error"); }
        finally { Pages = null; }
        got[name] = new JsonObject { ["asked"] = Node(site.Asked.ToList()), ["result"] = result };
    }

    private static JsonNode? Node<T>(T value) => JsonSerializer.SerializeToNode(value, Json);

    // a copy with every object's keys in name order: a result's fields are a set (the page reads them by name), so the
    // order the serializer writes them in is no part of what is pinned
    private static JsonNode? Canonical(JsonNode? node) => node switch
    {
        JsonObject o => new JsonObject(o.OrderBy((kv) => kv.Key, StringComparer.Ordinal)
            .Select((kv) => KeyValuePair.Create(kv.Key, Canonical(kv.Value)))),
        JsonArray a => new JsonArray(a.Select(Canonical).ToArray()),
        _ => node?.DeepClone(),
    };

    // The local Wallpaper Engine folder: a copy of the fixture's items, one at a time in name order (so "date added" sorts
    // them by name), each result's paths written relative to the copy.
    private static async Task LocalFolder(string fixture, string tmp, JsonObject got)
    {
        string ws = Path.Combine(tmp, "workshop");
        Directory.CreateDirectory(ws);
        foreach (var item in Directory.GetDirectories(fixture).OrderBy((d) => Path.GetFileName(d), StringComparer.Ordinal))
        {
            string to = Path.Combine(ws, Path.GetFileName(item));
            Directory.CreateDirectory(to);
            foreach (var f in Directory.GetFiles(item)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            Thread.Sleep(20);
        }
        string cache = WallpaperEngineScraper.GifThumbCacheDir;
        string Rel(string? p) => p == null ? "" : p.Replace(cache, "$CACHE").Replace(ws, "$WS");
        JsonNode Results(List<WallpaperResult> list, bool keepOrder) => Node((keepOrder ? list : list.OrderBy((r) => r.PageUrl, StringComparer.Ordinal).ToList())
            .Select((r) => new
            {
                r.Title, ThumbnailUrl = Rel(r.ThumbnailUrl), AnimatedThumbnailUrl = r.AnimatedThumbnailUrl == null ? null : Rel(r.AnimatedThumbnailUrl),
                PageUrl = Rel(r.PageUrl), r.IsScene, r.IsPreset, r.WorkshopId, HasAddedAt = r.AddedAt != null, r.Tags, r.AgeRating,
            }))!;
        List<string> Titles(List<WallpaperResult> list) => list.Select((r) => r.Title).ToList();

        // a search reads no picture for an item it leaves out: 1002 (a GIF and a preview.jpg, not matching) copies no still
        got["local search caches nothing for the items it leaves out"] = Node(await CachedAfter(
            () => new WallpaperEngineService { WorkshopPath = ws, AllowScenes = true, AllowPresets = true }.SearchAsync("rain", 1)));
        var we = new WallpaperEngineService { WorkshopPath = ws };
        got["local videos only"] = Results(await we.GetLatestAsync(1), keepOrder: false);
        we.AllowScenes = true;
        got["local with scenes"] = Results(await we.GetLatestAsync(1), keepOrder: false);
        we.AllowPresets = true;
        got["local with scenes and presets"] = Results(await we.GetLatestAsync(1), keepOrder: false);
        got["local search 'rain'"] = Results(await we.SearchAsync("rain", 1), keepOrder: false);
        got["local search 'RAIN' page 2"] = Results(await we.SearchAsync("RAIN", 2), keepOrder: false);
        for (int sort = 1; sort <= 6; sort++)
        {
            we.SortIndex = sort;
            got[$"local sort {sort}"] = Node(Titles(await we.GetLatestAsync(1)));
        }
        we.SortIndex = 99;
        got["local sort 99 (unknown)"] = Node(Titles(await we.GetLatestAsync(1)).Order(StringComparer.Ordinal).ToList());
        got["local gif cache"] = Node(Directory.Exists(cache)
            ? Directory.GetFiles(cache).Select((f) => Path.GetFileName(f)).Order(StringComparer.Ordinal).ToList() : []);
        got["local missing folder"] = Results(await new WallpaperEngineService { WorkshopPath = Path.Combine(tmp, "nowhere"), AllowScenes = true }.GetLatestAsync(1), keepOrder: true);

        var all = await we.GetLatestAsync(1);
        var details = new JsonObject();
        foreach (var r in all.OrderBy((r) => r.PageUrl, StringComparer.Ordinal))
        {
            var d = await we.GetDetailAsync(r);
            var node = Node(d)!.AsObject();
            foreach (var key in new[] { "previewUrl", "downloadUrl" })
                if (node[key] is JsonValue v) node[key] = Rel(v.GetValue<string>());
            details[r.WorkshopId ?? r.Title] = node;
        }
        got["local details"] = details;
    }
}
