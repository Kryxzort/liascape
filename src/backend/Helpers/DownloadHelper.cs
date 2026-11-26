using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

// What a download makes of a wallpaper Browse found (AppOps.DownloadAsync: POST /download, a preset's base scene).
// Guard: liascape-backend scraper-selftest "download: …" cases, scripts/test-steam-signin.sh
public static class DownloadHelper
{
    // One download of a detail. `SourceId` is what the index keeps as the item's source (a web item's page: "already in your
    // library"). `Library` is the web source's library folder (LibraryStore.MotionBgs, …); null = imported/.
    public sealed record Request(WallpaperDetail Detail, string? SourceId)
    {
        public string? ThumbnailUrl { get; init; }
        public string? AnimatedUrl { get; init; }
        public string? Library { get; init; }
        // "Copy files instead of linking": a file on this PC is copied, not linked
        public bool CopyLocalFiles { get; init; }
        // "Download without subscribing": a Workshop item becomes the library's own workshop/<id> copy even from the
        // Wallpaper Engine folder (Steam's folder of a one-off isn't a subscription and goes away)
        public bool OwnCopy { get; init; }
    }

    private static readonly string[] VideoExts = [".mp4", ".webm", ".mov", ".mkv", ".avi"];
    private static readonly string[] AnimatedExts = [".gif", ".webp", ".apng"];
    private static readonly object KeyGate = new();

    public static Task<LibraryItem> DownloadAsync(Request r, IProgress<double>? progress, CancellationToken ct) =>
        r.Detail.WorkshopId is { Length: > 0 } id ? Task.FromResult(FromWorkshopFolder(r, id, progress)) : FetchAsync(r, progress, ct);

    // A Workshop item already on disk (the Wallpaper Engine folder, or the folder Steam just filled): DownloadUrl is a
    // scene's folder or a video's file in it. Inside the Wallpaper Engine folder it stays Steam's — local/<id>, a link to
    // it — unless OwnCopy; anywhere else it becomes the library's own copy, workshop/<id>. An item already there is kept.
    // Inside means by real paths: Steam reports an item's real folder while the setting may name it through a symlink, and
    // compared as text that "outside" would make a second, owned copy of the whole item.
    private static LibraryItem FromWorkshopFolder(Request r, string id, IProgress<double>? progress)
    {
        var d = r.Detail;
        string? folder = d.IsScene ? (Directory.Exists(d.DownloadUrl) ? d.DownloadUrl : null) : Path.GetDirectoryName(d.DownloadUrl);
        if (folder == null || !Directory.Exists(folder)) throw new DirectoryNotFoundException($"the Workshop item's folder isn't there ({d.DownloadUrl})");
        string weFolder = SettingsService.Load().WorkshopFolder;
        bool steams = !r.OwnCopy && weFolder.Length > 0 && Within(RealPath(folder), RealPath(weFolder));
        string source = steams ? LibraryStore.Local : LibraryStore.Workshop;
        string item = Path.Combine(Directory.CreateDirectory(LibraryStore.SourceDir(source)).FullName, id);
        if (!Directory.Exists(item) && !File.Exists(item))
        {
            try
            {
                if (steams) File.CreateSymbolicLink(item, folder);
                else CopyIn(folder, item);
            }
            // another download of the same item made it meanwhile (a preset's base fetch beside the user's own): that one stands
            catch (IOException) when (Directory.Exists(item) || File.Exists(item)) { }
        }
        Record(source, id, d, sourceUrl: null);
        progress?.Report(1.0);
        string? still = FirstThere(item, "preview.jpg", "preview.png"), moving = FirstThere(item, "preview.gif", "preview.webp");
        if (d.IsScene) return Item(d, r.SourceId, item, still, moving, copiedScene: steams ? null : item);
        string media = Path.Combine(item, Path.GetFileName(d.DownloadUrl));
        if (!File.Exists(media)) media = Directory.EnumerateFiles(item).FirstOrDefault(IsVideo) ?? media;
        return Item(d, r.SourceId, media, still, moving);
    }

    // The library's own copy of a Workshop folder, made in the library's trash (purged at start and close) and moved in whole:
    // a copy cut short never stands as the item, which every later download of it would keep
    private static void CopyIn(string folder, string item)
    {
        string stage = Path.Combine(Directory.CreateDirectory(LibraryService.TrashPath).FullName, $"copy-{Guid.NewGuid():N}");
        try
        {
            LibraryService.CopyTree(folder, stage);
            Directory.Move(stage, item);
        }
        catch
        {
            LibraryService.TryDeleteDir(stage);
            throw;
        }
    }

    // A web source's file (fetched with its Referer) or a file on this PC (linked, or copied) → <library>/<title>/<title>.<ext>
    // with its thumbnail and its animated preview beside it; a title already taken there gets " (n)". A download that fails
    // leaves nothing: its new folder goes with it.
    private static async Task<LibraryItem> FetchAsync(Request r, IProgress<double>? progress, CancellationToken ct)
    {
        var d = r.Detail;
        string source = r.Library ?? LibraryStore.Imported;
        string key, folder;
        lock (KeyGate)
        {
            string dir = LibraryStore.SourceDir(source);
            string name = LibraryService.SanitizeName(d.Title);
            key = Enumerable.Range(0, int.MaxValue).Select((n) => n == 0 ? name : $"{name} ({n})")
                .First((k) => !Directory.Exists(Path.Combine(dir, k)) && !File.Exists(Path.Combine(dir, k)));
            folder = Directory.CreateDirectory(Path.Combine(dir, key)).FullName;
        }
        try
        {
            string ext = Path.GetExtension(d.DownloadUrl).ToLowerInvariant() is var e && VideoExts.Contains(e) ? e : ".mp4";
            string media = Path.Combine(folder, key + ext);
            await BringAsync(d.DownloadUrl, media, r.CopyLocalFiles, d.Referrer, progress, ct);
            string? still = await AssetAsync(r.ThumbnailUrl, folder, key, ".jpg", r.CopyLocalFiles, ct);
            // only an animated format is the animated preview; a still there is none (the card plays the video instead)
            string? moving = AnimatedExts.Contains(UrlExt(r.AnimatedUrl)) ? await AssetAsync(r.AnimatedUrl, folder, key, null, r.CopyLocalFiles, ct) : null;
            Record(source, key, d, sourceUrl: r.SourceId);
            return Item(d, r.SourceId, media, still, moving);
        }
        catch
        {
            LibraryService.TryDeleteDir(folder);
            throw;
        }
    }

    // `from` (a URL, or a file on this PC) → `to`. A local file is linked unless `copy`; a URL is fetched with the shared
    // client and the Firefox User-Agent (.claude/rules/backend/sources-steam.md § Scrapers), `referer` when the site needs it.
    private static async Task BringAsync(string from, string to, bool copy, string? referer, IProgress<double>? progress, CancellationToken ct)
    {
        if (File.Exists(from))
        {
            if (copy) await Task.Run(() => File.Copy(from, to), ct);
            else File.CreateSymbolicLink(to, from);
            progress?.Report(1.0);
            return;
        }
        using var ask = new HttpRequestMessage(HttpMethod.Get, from);
        ask.Headers.UserAgent.ParseAdd(HttpClientProvider.UserAgent);
        if (!string.IsNullOrEmpty(referer)) ask.Headers.Referrer = new Uri(referer);
        // headers first: the body streams into the file as it arrives, never held whole in memory
        using var answer = await HttpClientProvider.Client.SendAsync(ask, HttpCompletionOption.ResponseHeadersRead, ct);
        answer.EnsureSuccessStatusCode();
        await using var file = new ProgressStream(new FileStream(to, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true),
            answer.Content.Headers.ContentLength, progress);
        await answer.Content.CopyToAsync(file, ct);
    }

    // A picture beside the media as <key><its extension> (`fallbackExt` when the URL has none); null when there is none or it
    // couldn't be had (the card does without it)
    private static async Task<string?> AssetAsync(string? url, string folder, string key, string? fallbackExt, bool copy, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(url)) return null;
        string ext = Path.GetExtension(Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.AbsolutePath : url);
        string to = Path.Combine(folder, key + (ext.Length > 0 ? ext : fallbackExt));
        try
        {
            await BringAsync(url, to, copy, referer: null, progress: null, ct);
            return to;
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
    }

    // The item's index entry: everything the detail knows
    private static void Record(string source, string key, WallpaperDetail d, string? sourceUrl) =>
        LibraryStore.UpdateIndex(source, (index) =>
        {
            var m = index.GetValueOrDefault(key) ?? new LibMeta();
            m.Title = d.Title;
            m.IsScene = d.IsScene;
            m.WorkshopId = d.WorkshopId;
            m.SourceUrl = sourceUrl;
            m.PageUrl = d.PageUrl;
            m.Resolution = d.Resolution;
            m.AgeRating = d.AgeRating;
            m.YoutubeUrl = d.YoutubeUrl;
            m.AuthorName = d.AuthorName;
            m.Description = d.Description;
            m.FileSizeBytes = d.FileSizeBytes;
            m.Subscriptions = d.Subscriptions;
            m.Favorites = d.Favorites;
            m.Tags = d.Tags;
            index[key] = m;
            return true;
        });

    private static LibraryItem Item(WallpaperDetail d, string? sourceId, string path, string? still, string? moving, string? copiedScene = null) => new()
    {
        Title = d.Title,
        VideoPath = path,
        ThumbnailPath = still,
        AnimatedThumbnailPath = moving,
        SourceId = sourceId,
        IsScene = d.IsScene,
        WorkshopId = d.WorkshopId,
        CopiedSceneDir = copiedScene,
        AddedAt = DateTime.Now,
        PageUrl = d.PageUrl,
        Resolution = d.Resolution,
        AgeRating = d.AgeRating,
        YoutubeUrl = d.YoutubeUrl,
        AuthorName = d.AuthorName,
        Description = d.Description,
        FileSizeBytes = d.FileSizeBytes,
        Subscriptions = d.Subscriptions,
        Favorites = d.Favorites,
        Tags = d.Tags,
    };

    private static bool IsVideo(string path) => VideoExts.Contains(Path.GetExtension(path).ToLowerInvariant());

    private static string UrlExt(string? url) => string.IsNullOrEmpty(url) ? ""
        : Path.GetExtension(Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.AbsolutePath : url).ToLowerInvariant();

    private static string? FirstThere(string folder, params string[] names) =>
        names.Select((n) => Path.Combine(folder, n)).FirstOrDefault(File.Exists);

    // `path` is `folder` or inside it, by whole names (…/4319600 is not inside …/431960)
    private static bool Within(string path, string folder)
    {
        folder = Path.TrimEndingDirectorySeparator(folder);
        return path == folder || path.StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    // realpath(3): every link on the way resolved, its target's own links too (at most 40 hops, as the kernel allows); a
    // name that isn't there, or can't be read, is kept as written
    internal static string RealPath(string path)
    {
        string at = Path.DirectorySeparatorChar.ToString();
        int hops = 0;
        foreach (var name in Path.GetFullPath(path).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            string next = Path.Combine(at, name);
            FileSystemInfo? target = null;
            try { target = new FileInfo(next).ResolveLinkTarget(returnFinalTarget: true); } catch { }
            at = target != null && hops++ < 40 ? Path.GetFullPath(target.FullName) : next;
        }
        return Path.TrimEndingDirectorySeparator(at);
    }
}
