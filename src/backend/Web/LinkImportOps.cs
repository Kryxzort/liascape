using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;
using Microsoft.AspNetCore.Http;

namespace Liascape.Web;

// An import from a link: POST /library/link {url} says what the link names (the dialog shows it before anything lands),
// POST /library/import-link {url} imports it. The link is read by Helpers/LinkImport.cs, then the item comes by its own
// source's path, never a downloader of this file's own:
//  • a Workshop item and a web source's page: /download's (ServerHost.DownloadResultAsync) — the chosen download mode and
//    its fallback order, nothing else (.claude/rules/backend/sources-steam.md § Workshop downloads), the site's own detail
//    and file, the page's own name (SitePage.PageName);
//  • a file straight from a server: DownloadHelper's link fetch (public addresses only, redirects checked, capped), its
//    first bytes checked, then into imported/ like a file imported from this PC (ImportService, the address as its source);
//  • anything else: the answer decides — a video or picture is that file, a page is a site that isn't supported.
// Progress like a Browse card's: download-progress {id} (id = the resolve's `id`), and while any runs the library-ops
// operation "link" (the top bar's words). Nothing is logged but the host: an address can carry a token in its query.
// Guard: scripts/test-item-actions.sh § link, scraper-selftest "link: …", --probe probe-import.js import:link:*
public static class LinkImportOps
{
    // kind workshop | site | direct; id = the item's source id (Steam's item page, the site's page, the file's address);
    // media = video | gif | image | scene | preset (null: an unknown site's file not looked at yet); inLibrary = an item with
    // that source id (or Workshop id) is there. A Workshop download is never refused up front: its fallback order ends on the
    // item's Steam page (WorkshopDownloader.Blocked), and the dialog says which way it goes (components/subscribeMode.ts
    // downloadHint)
    public sealed record Resolved(string Kind, string Id, string Title, string Source, string? Media, bool InLibrary);

    private sealed record Plan(Resolved Shown, LinkImport.Target Target, int SourceIndex, WallpaperResult? Result);

    public static async Task<IResult> ResolveAsync(string? text, CancellationToken ct)
    {
        try { return Results.Json((await PlanAsync(text, look: true, ct)).Shown); }
        catch (DownloadHelper.LinkRefused e) { return Refused(e.Message); }
    }

    public static async Task<IResult> ImportAsync(string? text, CancellationToken ct)
    {
        Plan plan;
        try { plan = await PlanAsync(text, look: false, ct); }
        catch (DownloadHelper.LinkRefused e) { return Refused(e.Message); }
        var shown = plan.Shown;
        if (shown.InLibrary) return Results.Json(new { already = true, title = shown.Title });
        Console.WriteLine($"link: importing a {shown.Kind} link ({Host(shown.Id)})");
        Begin();
        try
        {
            if (plan.Result != null)
                try { return await ServerHost.DownloadResultAsync(plan.SourceIndex, plan.Result, apply: false, oneOff: false, ct); }
                // the page is there but holds no wallpaper (a site's other page, or its markup changed)
                catch (InvalidDataException) when (plan.Target.Kind == LinkImport.Kind.Site) { return Refused($"No wallpaper was found on that {shown.Source} page."); }
                catch (HttpRequestException e) when (plan.Target.Kind == LinkImport.Kind.Site && !ct.IsCancellationRequested)
                { return Refused($"{shown.Source} couldn't be reached ({e.Message})."); }
            return await DirectAsync(shown.Id, plan.Target.Kind, ct);
        }
        catch (DownloadHelper.LinkRefused e) { return Refused(e.Message); }
        finally { End(); }
    }

    // What the link names, with the item a download takes. `look`: an unknown site's address is asked for its answer's
    // headers (the dialog's preview); the import asks once, for the file itself.
    private static async Task<Plan> PlanAsync(string? text, bool look, CancellationToken ct)
    {
        var t = LinkImport.Map(text);
        var lib = LibraryService.LoadAll();
        bool Has(string id, string? wid = null) => lib.Any((i) => i.SourceId == id || (wid != null && i.WorkshopId == wid));
        switch (t.Kind)
        {
            case LinkImport.Kind.Refused:
                throw new DownloadHelper.LinkRefused(t.Error!);
            case LinkImport.Kind.Workshop:
            {
                var s = SettingsService.Load();
                string id = t.WorkshopId!;
                var got = await WorkshopDetailsCache.GetAsync([id], ct);
                if (!got.TryGetValue(id, out var d))
                    throw new DownloadHelper.LinkRefused("Steam has no public Workshop item with that id, or Steam couldn't be reached.");
                var r = SteamWorkshopScraper.MapToResults([id], got, s.AllowScenes, allowPresets: s.AllowScenes).FirstOrDefault();
                if (r == null)
                    throw new DownloadHelper.LinkRefused(WorkshopTags.IsUnplayable(d.Tags) ? "That Workshop item is a web or application wallpaper, which Liascape doesn't play."
                        : !s.AllowScenes && (WorkshopTags.IsPreset(d.Tags) || d.Tags.Contains("Scene", StringComparer.OrdinalIgnoreCase))
                            ? "That Workshop item is a scene: turn on Play scenes in Settings to import it."
                            : "That Workshop item isn't a video or a scene.");
                var shown = new Resolved("workshop", r.PageUrl, r.Title, ServerHost.Workshop.Name, r.IsPreset ? "preset" : r.IsScene ? "scene" : "video",
                    Has(r.PageUrl, id));
                return new(shown, t, ServerHost.SourceIndex(ServerHost.Workshop.Name), r);
            }
            case LinkImport.Kind.Site:
            {
                // the card the site's Browse would show, less what only its list knows: the detail reads the page's name
                var r = new WallpaperResult { Title = "", ThumbnailUrl = "", PageUrl = t.Url };
                return new(new Resolved("site", t.Url, LinkImport.SlugTitle(t.Url), SiteLabel(t.Source!), "video", Has(t.Url)),
                    t, ServerHost.SourceIndex(t.Source!), r);
            }
            default:
            {
                string? media = t.Media, title = LinkImport.TitleFor(t.Url, null);
                if (t.Kind == LinkImport.Kind.Unknown && look)
                {
                    using var answer = await DownloadHelper.OpenLinkAsync(t.Url, ct);
                    string ext = ExtOf(answer, t.Kind);
                    media = LinkImport.MediaOf("x" + ext);
                    title = LinkImport.TitleFor(t.Url, Disposition(answer));
                }
                return new(new Resolved("direct", t.Url, title, Host(t.Url), media, Has(t.Url)), t, -1, null);
            }
        }
    }

    // A file straight from a server → imported/<name>: fetched into the library's trash (purged at start and close), its first
    // bytes checked against the kind its answer named, then moved in by ImportService with the address as its source.
    private static async Task<IResult> DirectAsync(string url, LinkImport.Kind kind, CancellationToken ct)
    {
        var progress = new Progress<double>((v) => EventBus.Broadcast("download-progress", new { id = url, value = v }));
        string stage = Directory.CreateDirectory(Path.Combine(LibraryService.TrashPath, $"link-{Guid.NewGuid():N}")).FullName;
        try
        {
            string file, title;
            using (var answer = await DownloadHelper.OpenLinkAsync(url, ct))
            {
                string ext = ExtOf(answer, kind);
                title = LinkImport.TitleFor(url, Disposition(answer));
                file = Path.Combine(stage, "download" + ext);
                await DownloadHelper.SaveLinkAsync(answer, file, progress, ct);
            }
            bool picture = LinkImport.MediaOf(file) == "image" || Path.GetExtension(file) == ".gif";
            if (!ApiSecurity.HeadIsMedia(file, picture))
                return Refused(picture ? "The link's file isn't a picture." : "The link's file isn't a video.");
            LibraryItem? item;
            try { item = await ImportService.ImportAsync(file, title, take: true, sourceId: url, meta: (m) => m.PageUrl = url); }
            catch (InvalidDataException) { return Refused("The link's picture couldn't be read."); }
            if (item == null) return Refused("The downloaded file couldn't be imported.");
            LibraryFactsOps.Kick("link"); // its frame size
            PreviewBackfill.Kick("link"); // its card's previews
            EventBus.Broadcast("download-progress", new { id = url, value = 1.0, done = true });
            Console.WriteLine($"link: imported a file from {Host(url)}");
            return Results.Json(item);
        }
        finally { LibraryService.TryDeleteDir(stage); }
    }

    // the extension the answer's file is stored under; a page at an unknown site is that site not being supported
    private static string ExtOf(HttpResponseMessage answer, LinkImport.Kind kind)
    {
        string? type = answer.Content.Headers.ContentType?.MediaType;
        string at = answer.RequestMessage?.RequestUri?.AbsoluteUri ?? "";
        if (LinkImport.ExtFor(type, at, Disposition(answer)) is { } ext) return ext;
        bool page = type is "text/html" or "application/xhtml+xml";
        throw new DownloadHelper.LinkRefused(kind == LinkImport.Kind.Unknown && page ? LinkImport.NotSupported
            : page ? "That link leads to a web page, not a video or picture."
            : $"That link's file isn't a video or picture the library takes ({type ?? "no type given"}).");
    }

    private static string? Disposition(HttpResponseMessage answer) =>
        answer.Content.Headers.ContentDisposition is { } d ? (d.FileNameStar ?? d.FileName) : null;

    private static string Host(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "";

    // the sites' own spelling, as the dialog names them
    private static string SiteLabel(string source) => source switch { "Moewalls" => "MoeWalls", "Desktophut" => "DesktopHut", _ => source };

    private static IResult Refused(string why) => Results.Json(new { error = why }, statusCode: 400);

    // the library-ops "link" operation: how many links are importing (total) and how many of them ended (done), from the first
    // to start until the last ends
    private static readonly object _lock = new();
    private static int _running, _queued, _done;
    private static void Begin()
    {
        lock (_lock)
        {
            if (_running == 0) _queued = _done = 0;
            _running++; _queued++;
            LibraryOps.Set("link", "download", _done, _queued);
        }
    }
    private static void End()
    {
        lock (_lock)
        {
            _running--; _done++;
            if (_running == 0) LibraryOps.End("link"); else LibraryOps.Set("link", "download", _done, _queued);
        }
    }
}
