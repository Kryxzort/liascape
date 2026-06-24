using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Models;

namespace livepaper.Helpers;

public static class DownloadHelper
{
    public static readonly string LibraryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "livepaper", "library");

    public static async Task<LibraryItem> DownloadAsync(WallpaperDetail detail, string? thumbnailUrl, string? sourceId = null, IProgress<double>? progress = null, bool copyLocalFiles = false, CancellationToken ct = default, string? animatedUrl = null)
    {
        Directory.CreateDirectory(LibraryPath);
        var settings = SettingsService.Load();

        // --- classify into a source + item key (folder name) ---
        // workshop item: the acquired Steam folder; if it lives UNDER the WE dir → local/ (symlink), else workshop/ (own copy).
        string source, key;
        string? weSteamDir = null;
        if (!string.IsNullOrEmpty(detail.WorkshopId))
        {
            key = detail.WorkshopId!;
            weSteamDir = detail.IsScene ? (Directory.Exists(detail.DownloadUrl) ? detail.DownloadUrl : null)
                                        : Path.GetDirectoryName(detail.DownloadUrl);
            bool underWeDir = weSteamDir != null && !string.IsNullOrEmpty(settings.WallpaperEnginePath)
                && Path.GetFullPath(weSteamDir).StartsWith(Path.GetFullPath(settings.WallpaperEnginePath), StringComparison.Ordinal);
            source = underWeDir ? LibraryStore.Local : LibraryStore.Workshop;
        }
        else
        {
            source = SourceFromUrl(sourceId ?? detail.PageUrl);
            key = UniqueKey(source, SanitizeName(detail.Title));
        }

        string sourceDir = LibraryStore.SourceDir(source);
        Directory.CreateDirectory(sourceDir);
        string itemDir = Path.Combine(sourceDir, key);

        void WriteIndex(bool isScene) => LibraryStore.SetMeta(Path.Combine(itemDir, "_"), m =>
        {
            m.Title = detail.Title; m.IsScene = isScene; m.WorkshopId = detail.WorkshopId;
            m.SourceUrl = string.IsNullOrEmpty(detail.WorkshopId) ? sourceId : null;
            m.Resolution = detail.Resolution; m.AgeRating = detail.AgeRating; m.YoutubeUrl = detail.YoutubeUrl;
            m.PageUrl = detail.PageUrl; m.AuthorName = detail.AuthorName; m.Description = detail.Description;
            m.FileSizeBytes = detail.FileSizeBytes; m.Subscriptions = detail.Subscriptions;
            m.Favorites = detail.Favorites; m.Views = detail.Views; m.Tags = detail.Tags;
        });

        LibraryItem Result(string videoPath, bool isScene, string? thumb, string? anim, string? copiedSceneDir = null) => new()
        {
            Title = detail.Title, VideoPath = videoPath, ThumbnailPath = thumb, AnimatedThumbnailPath = anim,
            SourceId = sourceId, IsScene = isScene, WorkshopId = detail.WorkshopId, CopiedSceneDir = copiedSceneDir,
            AddedAt = System.DateTime.Now,
            Resolution = detail.Resolution, AgeRating = detail.AgeRating, YoutubeUrl = detail.YoutubeUrl,
            PageUrl = detail.PageUrl, AuthorName = detail.AuthorName, Description = detail.Description,
            FileSizeBytes = detail.FileSizeBytes, Subscriptions = detail.Subscriptions,
            Favorites = detail.Favorites, Views = detail.Views, Tags = detail.Tags,
        };

        // ---- workshop / local (id-keyed Steam folder) ----
        if (!string.IsNullOrEmpty(detail.WorkshopId) && weSteamDir != null)
        {
            if (source == LibraryStore.Local)                                  // subscribe / WE-dir → symlink the folder
            { try { if (!Directory.Exists(itemDir) && !File.Exists(itemDir)) File.CreateSymbolicLink(itemDir, weSteamDir); } catch { } }
            else                                                               // steamcmd snapshot → own copy (Steam-mirror)
            { if (!Directory.Exists(itemDir)) await Task.Run(() => CopyDirectory(weSteamDir, itemDir)); }

            if (detail.IsScene)
            {
                WriteIndex(isScene: true);
                progress?.Report(1.0);
                // folder-based scene: VideoPath IS the item folder (local/ symlink, or owned workshop/ copy).
                // LWE launches a local item by id, an owned copy by dir path — PlayerHelper derives both.
                return Result(itemDir, true, FindInDir(itemDir, "preview.jpg", "preview.png"), FindInDir(itemDir, "preview.gif", "preview.webp"),
                    copiedSceneDir: source == LibraryStore.Workshop ? itemDir : null);
            }
            // workshop/local VIDEO: media file from project.json (already inside the folder)
            string videoFile = detail.IsScene ? detail.DownloadUrl : (Path.GetFileName(detail.DownloadUrl));
            string media = Path.Combine(itemDir, videoFile);
            if (!File.Exists(media)) media = Directory.EnumerateFiles(itemDir).FirstOrDefault(IsVideoExt) ?? media;
            WriteIndex(isScene: false);
            progress?.Report(1.0);
            return Result(media, false, FindInDir(itemDir, "preview.jpg", "preview.png"), FindInDir(itemDir, "preview.gif", "preview.webp"));
        }

        // ---- web / imported video → <source>/<key>/<key>.mp4 (+ thumb/anim) ----
        Directory.CreateDirectory(itemDir);
        string mediaExt = detail.IsScene ? ".mp4" : (Path.GetExtension(detail.DownloadUrl) is { Length: > 0 } e && IsVideoExt("x" + e) ? e : ".mp4");
        string videoDest = Path.Combine(itemDir, key + mediaExt);
        if (File.Exists(detail.DownloadUrl))
        {
            bool samePath = Path.GetFullPath(detail.DownloadUrl) == Path.GetFullPath(videoDest);
            if (!samePath && File.Exists(videoDest)) File.Delete(videoDest);
            if (!samePath) { if (copyLocalFiles) await Task.Run(() => File.Copy(detail.DownloadUrl, videoDest)); else File.CreateSymbolicLink(videoDest, detail.DownloadUrl); }
            progress?.Report(1.0);
        }
        else await DownloadFileAsync(detail.DownloadUrl, videoDest, detail.NeedsReferrer ? detail.Referrer : null, progress, ct);

        string? thumb = await SaveAssetAsync(thumbnailUrl, itemDir, key, ".jpg", copyLocalFiles);
        string? anim = await SaveAnimatedPreviewAsync(animatedUrl, itemDir, key, copyLocalFiles);
        WriteIndex(isScene: false);
        return Result(videoDest, false, thumb, anim);
    }

    private static readonly string[] VidExts = { ".mp4", ".webm", ".mov", ".mkv", ".avi" };
    private static bool IsVideoExt(string p) => VidExts.Contains(Path.GetExtension(p).ToLowerInvariant());
    private static string? FindInDir(string dir, params string[] names)
    { foreach (var n in names) { var p = Path.Combine(dir, n); if (File.Exists(p)) return p; } return null; }

    // web source folder from the page/source URL domain; unknown → imported
    private static string SourceFromUrl(string? url)
    {
        var u = (url ?? "").ToLowerInvariant();
        if (u.Contains("motionbgs")) return LibraryStore.MotionBgs;
        if (u.Contains("moewalls")) return LibraryStore.Moewalls;
        if (u.Contains("desktophut")) return LibraryStore.Desktophut;
        return LibraryStore.Imported;
    }

    private static string UniqueKey(string source, string baseName)
    {
        var dir = LibraryStore.SourceDir(source);
        for (int i = 0; i < 10000; i++)
        {
            string k = i == 0 ? baseName : $"{baseName} ({i})";
            if (!Directory.Exists(Path.Combine(dir, k))) return k;
        }
        return baseName + "_" + Guid.NewGuid().ToString("N");
    }

    // Persist the source's animated preview (gif/webp/apng) next to the media as <title>.<ext>.
    // Only animated formats are saved; a static or extensionless URL → null (UI uses the video fallback).
    // animated preview (gif/webp/apng only) → destDir/baseName.<ext>; static/extensionless URL → null
    private static async Task<string?> SaveAnimatedPreviewAsync(string? animatedUrl, string destDir, string baseName, bool copyLocalFiles)
    {
        if (string.IsNullOrEmpty(animatedUrl)) return null;
        string urlPath = Uri.TryCreate(animatedUrl, UriKind.Absolute, out var uri) ? uri.AbsolutePath : animatedUrl;
        string ext = Path.GetExtension(urlPath).ToLowerInvariant();
        if (ext != ".gif" && ext != ".webp" && ext != ".apng") return null;
        return await SaveAssetAsync(animatedUrl, destDir, baseName, ext, copyLocalFiles);
    }

    // copy/symlink/download a single asset into destDir/baseName.<ext> (ext from the URL, else defaultExt)
    private static async Task<string?> SaveAssetAsync(string? url, string destDir, string baseName, string defaultExt, bool copyLocalFiles)
    {
        if (string.IsNullOrEmpty(url)) return null;
        string urlPath = Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.AbsolutePath : url;
        string ext = Path.GetExtension(urlPath);
        if (string.IsNullOrEmpty(ext)) ext = defaultExt;
        string dest = Path.Combine(destDir, baseName + ext);
        try
        {
            Directory.CreateDirectory(destDir);
            if (File.Exists(url))
            {
                bool same = Path.GetFullPath(url) == Path.GetFullPath(dest);
                if (!same && File.Exists(dest)) File.Delete(dest);
                if (!same) { if (copyLocalFiles) await Task.Run(() => File.Copy(url, dest)); else File.CreateSymbolicLink(dest, url); }
            }
            else await DownloadFileAsync(url, dest, null);
            return dest;
        }
        catch { return null; }
    }

    private static async Task DownloadFileAsync(string url, string dest, string? referrer, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
        if (!string.IsNullOrEmpty(referrer))
            req.Headers.Referrer = new Uri(referrer);

        using var resp = await HttpClientProvider.Client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

        resp.EnsureSuccessStatusCode();

        long? total = resp.Content.Headers.ContentLength;
        using var src = await resp.Content.ReadAsStreamAsync(ct);
        using var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 81920);

        var buffer = new byte[81920];
        long bytesRead = 0;
        int read;
        while ((read = await src.ReadAsync(buffer, ct)) > 0)
        {
            await fs.WriteAsync(buffer.AsMemory(0, read), ct);
            bytesRead += read;
            if (total.HasValue)
                progress?.Report((double)bytesRead / total.Value);
        }
    }

    private static void CopyDirectory(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src))
            CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }

    // Name files the Wallpaper Engine way (LibraryService.SanitizeName): STRIP invalid chars rather than
    // replacing them with '_', so a directly-downloaded workshop item and its later WE-dir copy share a
    // name → the reconcile is a clean in-place backing swap, no rename/repoint.
    private static string SanitizeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray()).Trim();
    }
}
