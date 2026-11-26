using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Services;

namespace Liascape.Scrapers;

// hidden `liascape-backend scraper-selftest [<fixtures dir>] [--write]` (PASS/FAIL, exit 1 on a failure): Browse's sources
// against saved pages, never the sites. Each web source's service runs its own calls (latest, search and its later pages,
// a detail) with every page it asks for answered from `scripts/test-fixtures/scrapers/<site>/` — the trimmed elements its
// parser reads, captured from the site — and the URLs it asked for and what it returned must equal `expected.json`. The
// local Wallpaper Engine folder runs over a copy of `wallpaper-engine/` (fake items: video, scene, preset, the skipped kinds)
// under a private HOME (the GIF thumbnails' cache), and downloads (DownloadHelper) land in a private library: a loopback
// server stands in for the site, beside files on this PC and the fake folder's items; ChildProcess (the GIF stills' and
// imports' ffmpeg) runs small shell commands. `--write` rewrites `expected.json`
// from what the code returns now — only to pin a deliberate change, after reading the diff. A site that changed its
// markup: capture its page again, trim it the same way, and fix the parser until this passes.
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
        // the local folder's GIF thumbnails go to ~/.cache, the downloads' library and settings to the XDG dirs: a private
        // HOME and XDG dirs, never the user's
        string home = Directory.CreateDirectory(Path.Combine(tmp, "home")).FullName;
        Environment.SetEnvironmentVariable("HOME", home);
        foreach (var (name, path) in new[] { ("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"), ("XDG_CACHE_HOME", ".cache") })
            Environment.SetEnvironmentVariable(name, Directory.CreateDirectory(Path.Combine(home, path)).FullName);
        Environment.SetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK", "1");
        var got = new JsonObject();
        try
        {
            if (!WallpaperEngineScraper.GifThumbCacheDir.StartsWith(tmp, StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"scraper-selftest: refusing — the GIF thumbnail cache ({WallpaperEngineScraper.GifThumbCacheDir}) is not under the private HOME");
                return 2;
            }
            if (!LibraryStore.SourceDir(LibraryStore.Imported).StartsWith(tmp, StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"scraper-selftest: refusing — the library ({LibraryStore.SourceDir(LibraryStore.Imported)}) is not under the private HOME");
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
        await Downloads(tmp, got);
        await ChildProcesses(tmp, got);
    }

    // ChildProcess, which runs the ffmpeg of a GIF still (WallpaperEngineScraper) and of an import: what a tool printed and
    // its exit code; one past its limit killed with its own children and reaped, quickly; one that exits leaving a child
    // that holds its pipe open, given up on at its limit; one that isn't installed; a cancelled caller.
    private static async Task ChildProcesses(string tmp, JsonObject got)
    {
        var answered = await ChildProcess.RunAsync("sh", ["-c", "echo out; echo err >&2; exit 3"], TimeSpan.FromSeconds(10));
        got["child process: what it printed and its exit"] = Node(answered);

        string pidFile = Path.Combine(tmp, "grandchild.pid");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var late = await ChildProcess.RunAsync("sh", ["-c", $"sleep 30 & echo $! > '{pidFile}'; wait"], TimeSpan.FromMilliseconds(500));
        long took = clock.ElapsedMilliseconds;
        // its own child (the sleep) went with it: gone, or a zombie waiting for init
        string? pid = File.Exists(pidFile) ? File.ReadAllText(pidFile).Trim() : null;
        string? state = null;
        for (int i = 0; pid != null && i < 20; i++)
        {
            state = File.Exists($"/proc/{pid}/stat") ? File.ReadAllText($"/proc/{pid}/stat").Split(") ").LastOrDefault()?[..1] : "gone";
            if (state is "gone" or "Z") break;
            await Task.Delay(50);
        }
        got["child process: past its limit"] = new JsonObject
        {
            ["result"] = Node(late),
            ["killed within 5 s"] = took < 5000,
            ["its child"] = pid == null ? "never started" : state is "gone" or "Z" ? "dead" : $"still running ({state})",
        };

        // a tool that exits at once but leaves a child holding its output pipe open: the pipe never ends while the child
        // lives, so the reads are bounded by the limit too
        string heldFile = Path.Combine(tmp, "pipe-holder.pid");
        clock.Restart();
        var held = await ChildProcess.RunAsync("sh", ["-c", $"sleep 30 & echo $! > '{heldFile}'; exit 0"], TimeSpan.FromMilliseconds(500));
        took = clock.ElapsedMilliseconds;
        // no longer the tool's child once the tool exited (nothing finds it as such), so the test ends it itself
        if (File.Exists(heldFile) && int.TryParse(File.ReadAllText(heldFile).Trim(), out int holder))
            try { System.Diagnostics.Process.GetProcessById(holder).Kill(); } catch (Exception e) when (e is ArgumentException or InvalidOperationException) { }
        got["child process: exits, its child holding the pipe"] = new JsonObject
        {
            ["result"] = Node(held),
            ["returned within 5 s"] = took < 5000,
        };

        got["child process: not installed"] = Node(await ChildProcess.RunAsync(Path.Combine(tmp, "no-such-tool"), [], TimeSpan.FromSeconds(10)));

        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        string outcome;
        clock.Restart();
        try { outcome = $"returned {(await ChildProcess.RunAsync("sleep", ["30"], TimeSpan.FromSeconds(60), cancel.Token)).Exit}"; }
        catch (OperationCanceledException) { outcome = clock.ElapsedMilliseconds < 5000 ? "cancelled" : "cancelled late"; }
        got["child process: its caller cancels"] = outcome;
    }

    // A download (DownloadHelper) as /download makes it — a web source's file from a loopback server standing in for the
    // site, a local file, a Wallpaper Engine folder item — into a private library: what was asked of the server (its
    // User-Agent and Referer), what lands in the library (files, links, the index), and the item handed back.
    private static async Task Downloads(string tmp, JsonObject got)
    {
        string ws = Path.Combine(tmp, "workshop"); // LocalFolder's copy of the fixture items
        string lib = Path.GetDirectoryName(LibraryStore.SourceDir(LibraryStore.Imported))!;
        string config = Path.GetDirectoryName(SettingsService.FilePath)!;
        Directory.CreateDirectory(config);
        File.WriteAllText(Path.Combine(config, "settings.json"), JsonSerializer.Serialize(new { WorkshopFolder = ws }));

        int port;
        using (var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0))
        { probe.Start(); port = ((System.Net.IPEndPoint)probe.LocalEndpoint).Port; }
        string site = $"http://127.0.0.1:{port}";
        var files = new Dictionary<string, string>
        {
            ["/files/neon.mp4"] = "neon video bytes", ["/files/clip.webm"] = "webm bytes",
            ["/thumbs/neon.jpg"] = "jpg", ["/thumbs/neon.gif"] = "gif", ["/thumbs/poster"] = "poster", ["/thumbs/still.jpg"] = "still",
        };
        var asked = new List<JsonNode>();
        using var server = new System.Net.HttpListener();
        server.Prefixes.Add(site + "/");
        server.Start();
        _ = Task.Run(async () =>
        {
            while (server.IsListening)
            {
                System.Net.HttpListenerContext c;
                try { c = await server.GetContextAsync(); } catch { return; }
                string path = c.Request.Url!.AbsolutePath;
                string? ua = c.Request.UserAgent;
                lock (asked) asked.Add(new JsonObject
                {
                    ["path"] = path, ["userAgent"] = ua == HttpClientProvider.UserAgent ? "$UA" : ua, ["referer"] = c.Request.Headers["Referer"],
                });
                if (files.TryGetValue(path, out var body))
                {
                    var bytes = System.Text.Encoding.UTF8.GetBytes(body);
                    c.Response.ContentLength64 = bytes.Length;
                    await c.Response.OutputStream.WriteAsync(bytes);
                }
                else c.Response.StatusCode = 404;
                c.Response.Close();
            }
        });

        // the library as it is: every entry under it (a link's target, a file's text, a source's index)
        string Rel(string? p) => p == null ? "" : p.Replace(lib, "$LIB").Replace(ws, "$WS").Replace(tmp, "$TMP").Replace(site, "$SITE");
        JsonObject Library()
        {
            var o = new JsonObject();
            if (!Directory.Exists(lib)) return o;
            foreach (var e in Directory.EnumerateFileSystemEntries(lib, "*", new EnumerationOptions { RecurseSubdirectories = true })
                         .Order(StringComparer.Ordinal))
            {
                var fi = new FileInfo(e);
                string key = Rel(e);
                if (fi.LinkTarget != null) o[key] = "-> " + Rel(fi.LinkTarget);
                else if (Directory.Exists(e)) o[key] = "dir";
                else if (Path.GetFileName(e) == "index.json") o[key] = JsonNode.Parse(Rel(File.ReadAllText(e)));
                else if (fi.Length < 64) o[key] = File.ReadAllText(e);
                else o[key] = $"{fi.Length} bytes";
            }
            return o;
        }

        async Task Download(string name, WallpaperDetail d, string thumb = "", string? anim = null, string? sourceId = null,
            bool copy = false, bool ownCopy = false, string? library = null)
        {
            lock (asked) asked.Clear();
            var before = Library();
            double last = -1;
            var progress = new SyncProgress((v) => last = v);
            JsonNode? item;
            try
            {
                var i = await DownloadHelper.DownloadAsync(new DownloadHelper.Request(d, sourceId)
                {
                    ThumbnailUrl = thumb, AnimatedUrl = anim, Library = library, CopyLocalFiles = copy, OwnCopy = ownCopy,
                }, progress, default);
                item = new JsonObject
                {
                    ["title"] = i.Title, ["videoPath"] = Rel(i.VideoPath), ["thumbnailPath"] = Rel(i.ThumbnailPath),
                    ["animatedThumbnailPath"] = Rel(i.AnimatedThumbnailPath), ["sourceId"] = Rel(i.SourceId), ["isScene"] = i.IsScene,
                    ["workshopId"] = i.WorkshopId, ["copiedSceneDir"] = Rel(i.CopiedSceneDir), ["pageUrl"] = i.PageUrl, ["resolution"] = i.Resolution,
                };
            }
            catch (Exception e) { item = JsonValue.Create("error: " + e.GetType().Name); }
            JsonArray requests;
            lock (asked) requests = new JsonArray(asked.Select((a) => a.DeepClone()).ToArray());
            // what the download added or changed
            var changed = new JsonObject();
            foreach (var (key, value) in Library())
                if (!JsonNode.DeepEquals(value, before[key])) changed[key] = value?.DeepClone();
            got[name] = new JsonObject { ["asked"] = requests, ["item"] = item, ["progress"] = last, ["library"] = changed };
        }

        await Download("download: a web source's video", new WallpaperDetail
        {
            Title = "Neon Rain", PreviewUrl = site + "/files/neon.mp4", DownloadUrl = site + "/files/neon.mp4",
            Referrer = "https://moewalls.com/neon-rain/", PageUrl = "https://moewalls.com/neon-rain/", Resolution = "4K",
        }, thumb: site + "/thumbs/neon.jpg", anim: site + "/thumbs/neon.gif", sourceId: "https://moewalls.com/neon-rain/", library: LibraryStore.Moewalls);
        await Download("download: the same title again", new WallpaperDetail
        {
            Title = "Neon Rain", PreviewUrl = "", DownloadUrl = site + "/files/neon.mp4", PageUrl = "https://moewalls.com/neon-rain-2/",
        }, sourceId: "https://moewalls.com/neon-rain-2/", library: LibraryStore.Moewalls);
        // a .webm keeps its extension; a still as the animated preview is none; a thumbnail URL without an extension is a .jpg
        await Download("download: a webm, a still for the gif, a poster without an extension", new WallpaperDetail
        {
            Title = "Clip / Cut", PreviewUrl = "", DownloadUrl = site + "/files/clip.webm",
        }, thumb: site + "/thumbs/poster", anim: site + "/thumbs/still.jpg", sourceId: "https://www.motionbgs.com/clip", library: LibraryStore.MotionBgs);
        await Download("download: the site refuses the file", new WallpaperDetail
        {
            Title = "Gone", PreviewUrl = "", DownloadUrl = site + "/files/gone.mp4",
        }, thumb: site + "/thumbs/neon.jpg", sourceId: "https://www.desktophut.com/gone", library: LibraryStore.Desktophut);
        // a file on this PC (no Workshop id): linked, or copied under "Copy files instead of linking"
        string own = Path.Combine(tmp, "own");
        Directory.CreateDirectory(own);
        File.WriteAllText(Path.Combine(own, "mine.mp4"), "my video");
        File.WriteAllText(Path.Combine(own, "mine.jpg"), "my still");
        await Download("download: a file on this PC, linked", new WallpaperDetail
        {
            Title = "Mine", PreviewUrl = "", DownloadUrl = Path.Combine(own, "mine.mp4"),
        }, thumb: Path.Combine(own, "mine.jpg"), sourceId: Path.Combine(own, "mine.mp4"));
        await Download("download: a file on this PC, copied", new WallpaperDetail
        {
            Title = "Mine Copied", PreviewUrl = "", DownloadUrl = Path.Combine(own, "mine.mp4"),
        }, thumb: Path.Combine(own, "mine.jpg"), sourceId: Path.Combine(own, "mine.mp4"), copy: true);
        // the Wallpaper Engine folder's items: linked as local/<id>; "Download without subscribing" (ownCopy) the library's own
        // workshop/<id> copy; a folder outside the Wallpaper Engine folder always a copy
        await Download("download: a Wallpaper Engine video", new WallpaperDetail
        {
            Title = "Rain Window", PreviewUrl = "", DownloadUrl = Path.Combine(ws, "1001", "rain.mp4"), WorkshopId = "1001",
        }, sourceId: Path.Combine(ws, "1001"));
        await Download("download: a Wallpaper Engine scene", new WallpaperDetail
        {
            Title = "Forest Scene", PreviewUrl = "", DownloadUrl = Path.Combine(ws, "1006"), WorkshopId = "1006", IsScene = true,
        }, sourceId: Path.Combine(ws, "1006"));
        await Download("download: a Wallpaper Engine scene, its own copy", new WallpaperDetail
        {
            Title = "Forest Scene", PreviewUrl = "", DownloadUrl = Path.Combine(ws, "1006"), WorkshopId = "1006", IsScene = true,
        }, sourceId: Path.Combine(ws, "1006"), ownCopy: true);
        string outside = Path.Combine(tmp, "steam-elsewhere", "1003");
        Directory.CreateDirectory(outside);
        foreach (var f in Directory.GetFiles(Path.Combine(ws, "1003"))) File.Copy(f, Path.Combine(outside, Path.GetFileName(f)));
        await Download("download: a Workshop video outside the Wallpaper Engine folder", new WallpaperDetail
        {
            Title = "Sea Rain Loop", PreviewUrl = "", DownloadUrl = Path.Combine(outside, "sea.mov"), WorkshopId = "1003",
        }, sourceId: "https://steamcommunity.com/sharedfiles/filedetails/?id=1003");
        // a copy that can't be made whole (a file it can't read) leaves no workshop/<id> a later download would keep
        string broken = Path.Combine(tmp, "steam-elsewhere", "1099");
        Directory.CreateDirectory(broken);
        File.WriteAllText(Path.Combine(broken, "project.json"), "{\"type\":\"scene\"}");
        File.WriteAllText(Path.Combine(broken, "scene.pkg"), "locked");
        File.SetUnixFileMode(Path.Combine(broken, "scene.pkg"), UnixFileMode.None);
        await Download("download: a Workshop folder that can't be copied whole", new WallpaperDetail
        {
            Title = "Locked Scene", PreviewUrl = "", DownloadUrl = broken, WorkshopId = "1099", IsScene = true,
        }, sourceId: "https://steamcommunity.com/sharedfiles/filedetails/?id=1099");
        File.SetUnixFileMode(Path.Combine(broken, "scene.pkg"), UnixFileMode.UserRead | UnixFileMode.UserWrite);
        // two downloads of one Workshop item at once (a preset's base fetch beside the user's own): both get the item
        foreach (var (name, ownCopy, made) in new[] { ("linked", false, LibraryStore.Local), ("own copy", true, LibraryStore.Workshop) })
        {
            int errors = 0;
            for (int round = 0; round < 20; round++)
            {
                LibraryService.TryDeleteDir(Path.Combine(LibraryStore.SourceDir(made), "1006"));
                using var start = new Barrier(2);
                var both = Enumerable.Range(0, 2).Select((_) => Task.Run(async () =>
                {
                    start.SignalAndWait();
                    try
                    {
                        await DownloadHelper.DownloadAsync(new DownloadHelper.Request(new WallpaperDetail
                        {
                            Title = "Forest Scene", PreviewUrl = "", DownloadUrl = Path.Combine(ws, "1006"), WorkshopId = "1006", IsScene = true,
                        }, Path.Combine(ws, "1006")) { OwnCopy = ownCopy }, null, default);
                    }
                    catch { Interlocked.Increment(ref errors); }
                })).ToArray();
                await Task.WhenAll(both);
            }
            string item = Path.Combine(LibraryStore.SourceDir(made), "1006");
            got[$"download: two downloads of one Workshop item at once, {name}"] = new JsonObject
            {
                ["errors"] = errors,
                ["item"] = new FileInfo(item).LinkTarget is { } to ? "-> " + Rel(to) : Directory.Exists(item) ? "dir" : "none",
                ["files"] = Directory.Exists(item) ? Directory.GetFiles(item).Length : 0,
            };
        }
        server.Stop();
    }

    // Progress<T> posts to the thread pool; a download's last report must be in before the case reads it
    private sealed class SyncProgress(Action<double> report) : IProgress<double>
    {
        public void Report(double value) => report(value);
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
