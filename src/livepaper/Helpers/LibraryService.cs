using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using livepaper.Models;

namespace livepaper.Helpers;

public static class LibraryService
{
    private static string WeIndexPath => Path.Combine(DownloadHelper.LibraryPath, "we_ids.txt");

    private static HashSet<string> LoadWeIndex()
    {
        Directory.CreateDirectory(DownloadHelper.LibraryPath);
        if (!File.Exists(WeIndexPath))
        {
            var ids = CollectExistingWorkshopIds();
            SaveWeIndex(ids);
            return ids;
        }
        try
        {
            return new HashSet<string>(
                File.ReadLines(WeIndexPath).Select(l => l.Trim()).Where(l => l.Length > 0),
                StringComparer.Ordinal);
        }
        catch { return CollectExistingWorkshopIds(); }
    }

    private static void SaveWeIndex(HashSet<string> ids)
    {
        try { File.WriteAllLines(WeIndexPath, ids); } catch { }
    }

    private static void AppendToWeIndex(string workshopId)
    {
        try { File.AppendAllText(WeIndexPath, workshopId + "\n"); } catch { }
    }

    private static void RebuildWeIndex()
    {
        var ids = CollectExistingWorkshopIds();
        SaveWeIndex(ids);
    }

    // Headless WE workshop scan. Creates symlinks (or copies) for any workshop
    // item not already represented in the library by workshop ID. Returns the
    // newly added library media paths (.mp4 for videos, .scene for scenes).
    public static List<string> SyncWallpaperEngine(string workshopPath, bool allowScenes, bool weCopyFiles)
    {
        var added = new List<string>();
        if (string.IsNullOrEmpty(workshopPath) || !Directory.Exists(workshopPath)) return added;
        Directory.CreateDirectory(DownloadHelper.LibraryPath);

        var existingIds = LoadWeIndex();

        // Merge in IDs from URL-format .id files (Browse/Workshop downloads write the
        // Steam page URL as sourceId, not the bare numeric ID). LoadWeIndex only reads
        // we_ids.txt which lacks those entries — scanning .id files catches them so we
        // don't create duplicates for wallpapers the user already downloaded via the app.
        bool indexDirty = false;
        foreach (var id in CollectExistingWorkshopIds())
        {
            if (existingIds.Add(id)) indexDirty = true;
        }
        if (indexDirty) SaveWeIndex(existingIds);

        foreach (var dir in Directory.EnumerateDirectories(workshopPath))
        {
            string workshopId = Path.GetFileName(dir);
            if (existingIds.Contains(workshopId)) continue;

            string projectJson = Path.Combine(dir, "project.json");
            string? type = null, file = null, title = null;
            bool hasScenePkg = File.Exists(Path.Combine(dir, "scene.pkg"));

            if (File.Exists(projectJson))
            {
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(projectJson));
                    var root = doc.RootElement;
                    type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                    file = root.TryGetProperty("file", out var f) ? f.GetString() : null;
                    title = root.TryGetProperty("title", out var ti) ? ti.GetString() : null;
                }
                catch { continue; }
            }
            else if (!hasScenePkg) continue;

            string baseTitle = !string.IsNullOrEmpty(title) ? SanitizeName(title) : workshopId;
            if (string.IsNullOrEmpty(baseTitle)) baseTitle = workshopId;

            bool isVideo = string.Equals(type, "video", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(file);
            bool isScene = string.Equals(type, "scene", StringComparison.OrdinalIgnoreCase) || (type == null && hasScenePkg);

            if (isVideo)
            {
                string videoSrc = Path.Combine(dir, file!);
                if (!File.Exists(videoSrc)) continue;
                string destPath = ResolveUniqueName(baseTitle, ".mp4");
                try
                {
                    if (weCopyFiles) File.Copy(videoSrc, destPath);
                    else File.CreateSymbolicLink(destPath, videoSrc);
                }
                catch { continue; }

                LinkOrCopyThumbnail(Path.Combine(dir, "preview.jpg"), destPath, weCopyFiles);
                try { File.WriteAllText(Path.ChangeExtension(destPath, ".id"), workshopId); } catch { }
                existingIds.Add(workshopId);
                AppendToWeIndex(workshopId);
                added.Add(destPath);
            }
            else if (isScene && allowScenes)
            {
                string destPath = ResolveUniqueName(baseTitle, ".scene");
                string sceneContent = workshopId;
                if (weCopyFiles)
                {
                    string copiedDir = Path.Combine(DownloadHelper.LibraryPath,
                        $"{Path.GetFileNameWithoutExtension(destPath)}_{workshopId}");
                    try
                    {
                        CopyDirectory(dir, copiedDir);
                        sceneContent = copiedDir;
                    }
                    catch { continue; }
                }
                try { File.WriteAllText(destPath, sceneContent); } catch { continue; }
                LinkOrCopyThumbnail(Path.Combine(dir, "preview.jpg"), destPath, weCopyFiles);
                try { File.WriteAllText(Path.ChangeExtension(destPath, ".id"), workshopId); } catch { }
                existingIds.Add(workshopId);
                AppendToWeIndex(workshopId);
                added.Add(destPath);
            }
        }

        return added;
    }

    private static HashSet<string> CollectExistingWorkshopIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return ids;
        foreach (var idFile in Directory.EnumerateFiles(DownloadHelper.LibraryPath, "*.id"))
        {
            try
            {
                var raw = File.ReadAllText(idFile).Trim();
                if (string.IsNullOrEmpty(raw)) continue;
                if (long.TryParse(raw, out _)) { ids.Add(raw); continue; }

                // Browse downloads write the Steam page URL as the source ID.
                // Extract the numeric workshop ID from ?id= / &id= query param.
                if (raw.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                {
                    var idParam = ExtractSteamWorkshopId(raw);
                    if (idParam != null) ids.Add(idParam);
                    continue;
                }

                // Local path — extract numeric workshop ID from path segments
                var parts = raw.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    if ((parts[i] == "431960" || parts[i].Equals("workshop", StringComparison.OrdinalIgnoreCase))
                        && long.TryParse(parts[i + 1], out _))
                    {
                        ids.Add(parts[i + 1]);
                        break;
                    }
                }
            }
            catch { }
        }
        return ids;
    }

    // Extracts the numeric workshop item ID from a Steam community URL.
    // Handles both ?id=NNN and &id=NNN forms.
    private static string? ExtractSteamWorkshopId(string url)
    {
        int idx = url.IndexOf("?id=", StringComparison.Ordinal);
        if (idx < 0) idx = url.IndexOf("&id=", StringComparison.Ordinal);
        if (idx < 0) return null;
        int start = idx + 4;
        int end = start;
        while (end < url.Length && char.IsDigit(url[end])) end++;
        var candidate = url.Substring(start, end - start);
        return candidate.Length >= 8 && long.TryParse(candidate, out _) ? candidate : null;
    }

    private static string ResolveUniqueName(string baseTitle, string ext)
    {
        for (int attempt = 0; attempt < 10000; attempt++)
        {
            string name = attempt == 0 ? baseTitle : $"{baseTitle} ({attempt})";
            string candidate = Path.Combine(DownloadHelper.LibraryPath, name + ext);
            if (File.Exists(candidate)) continue;
            if (File.Exists(Path.Combine(DownloadHelper.LibraryPath, name + ".mp4"))) continue;
            if (File.Exists(Path.Combine(DownloadHelper.LibraryPath, name + ".png"))) continue;
            if (File.Exists(Path.Combine(DownloadHelper.LibraryPath, name + ".scene"))) continue;
            return candidate;
        }
        return Path.Combine(DownloadHelper.LibraryPath, baseTitle + "_" + Guid.NewGuid().ToString("N") + ext);
    }

    private static void LinkOrCopyThumbnail(string src, string mediaDest, bool copy)
    {
        if (!File.Exists(src)) return;
        string thumbDest = Path.ChangeExtension(mediaDest, ".jpg");
        try
        {
            if (copy) File.Copy(src, thumbDest);
            else File.CreateSymbolicLink(thumbDest, src);
        }
        catch { }
    }

    private static void CopyDirectory(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src))
            CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }

    private static string SanitizeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray()).Trim();
    }

    public static string TrashPath => Path.Combine(DownloadHelper.LibraryPath, ".trash");

    public static void Trash(LibraryItem item, string batchDir)
    {
        Directory.CreateDirectory(batchDir);
        MoveIfExists(item.VideoPath, batchDir);
        if (item.ThumbnailPath != null) MoveIfExists(item.ThumbnailPath, batchDir);
        foreach (var ext in new[] { ".jpg", ".png", ".gif", ".jpeg", ".id", ".crashed", ".whitelist", ".volume", ".speed" })
            MoveIfExists(Path.ChangeExtension(item.VideoPath, ext), batchDir);
        if (item.CopiedSceneDir != null && Directory.Exists(item.CopiedSceneDir))
            Directory.Move(item.CopiedSceneDir, Path.Combine(batchDir, Path.GetFileName(item.CopiedSceneDir)));
        if (item.WorkshopId != null) RebuildWeIndex();
    }

    public static void RestoreBatch(string batchDir)
    {
        if (!Directory.Exists(batchDir)) return;
        var fileMoves = Directory.GetFiles(batchDir)
            .Select(f => (Src: f, Dest: Path.Combine(DownloadHelper.LibraryPath, Path.GetFileName(f))))
            .ToList();
        var dirMoves = Directory.GetDirectories(batchDir)
            .Select(d => (Src: d, Dest: Path.Combine(DownloadHelper.LibraryPath, Path.GetFileName(d))))
            .ToList();
        // Bail if any destination already exists — avoids clobbering newly added items
        if (fileMoves.Any(m => File.Exists(m.Dest)) || dirMoves.Any(m => Directory.Exists(m.Dest)))
            return;
        foreach (var m in fileMoves) File.Move(m.Src, m.Dest);
        foreach (var m in dirMoves) Directory.Move(m.Src, m.Dest);
        try { Directory.Delete(batchDir); } catch { }
        RebuildWeIndex();
    }

    public static void PurgeBatch(string batchDir)
    {
        // Permanent delete: also remove any steamcmd-downloaded workshop content for items in this
        // batch (the "unsubscribe" on delete). Done at purge — not soft-delete — so Ctrl+Z undo can
        // still restore symlinks that point into the steamcmd cache.
        try { RemoveSteamCmdContentForBatch(batchDir); } catch { }
        try { Directory.Delete(batchDir, recursive: true); } catch { }
    }

    private static void RemoveSteamCmdContentForBatch(string batchDir)
    {
        if (!Directory.Exists(batchDir)) return;
        var settings = SettingsService.Load();
        foreach (var idFile in Directory.EnumerateFiles(batchDir, "*.id"))
        {
            try
            {
                var raw = File.ReadAllText(idFile).Trim();
                string? wsId = long.TryParse(raw, out _) ? raw
                    : raw.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? ExtractSteamWorkshopId(raw)
                    : null;
                if (wsId == null) continue;

                // steamcmd cache cleanup (harmless if not present).
                WorkshopDownloader.RemoveDownloadedItem(wsId);

                // Real unsubscribe if a Steam login cookie is configured — best-effort, fire-and-forget.
                if (!string.IsNullOrWhiteSpace(settings.SteamLoginSecure))
                    _ = WorkshopDownloader.SubscribeAsync(wsId, settings.SteamLoginSecure, subscribe: false);
            }
            catch { }
        }
    }

    public static void CleanTrash()
    {
        if (!Directory.Exists(TrashPath)) return;
        foreach (var dir in Directory.GetDirectories(TrashPath))
            PurgeBatch(dir);
    }

    private static void MoveIfExists(string src, string destDir)
    {
        if (File.Exists(src))
            File.Move(src, Path.Combine(destDir, Path.GetFileName(src)));
    }

    public static void DeleteAll()
    {
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return;
        foreach (var file in Directory.GetFiles(DownloadHelper.LibraryPath))
        {
            try { File.Delete(file); } catch { }
        }
        foreach (var dir in Directory.GetDirectories(DownloadHelper.LibraryPath))
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    public static void Delete(LibraryItem item)
    {
        if (File.Exists(item.VideoPath)) File.Delete(item.VideoPath);
        if (item.ThumbnailPath != null && File.Exists(item.ThumbnailPath)) File.Delete(item.ThumbnailPath);

        foreach (var ext in new[] { ".jpg", ".png", ".gif", ".jpeg" })
        {
            var f = Path.ChangeExtension(item.VideoPath, ext);
            if (File.Exists(f)) File.Delete(f);
        }

        foreach (var ext in new[] { ".id", ".crashed", ".whitelist", ".volume", ".speed" })
        {
            var f = Path.ChangeExtension(item.VideoPath, ext);
            if (File.Exists(f)) File.Delete(f);
        }

        if (item.CopiedSceneDir != null && Directory.Exists(item.CopiedSceneDir))
            Directory.Delete(item.CopiedSceneDir, recursive: true);
        if (item.WorkshopId != null) RebuildWeIndex();
    }

    public static void MarkCrashed(string videoPath)
    {
        try { File.WriteAllText(Path.ChangeExtension(videoPath, ".crashed"), ""); } catch { }
    }

    public static void SaveVolumeOverride(string videoPath, int? volume) =>
        SaveOrDeleteSidecar(videoPath, ".volume", volume.HasValue ? volume.Value.ToString() : null);

    public static void SaveSpeedOverride(string videoPath, double? speed) =>
        SaveOrDeleteSidecar(videoPath, ".speed", speed.HasValue ? speed.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : null);

    public static void SetWhitelisted(string videoPath, bool whitelisted) =>
        SaveOrDeleteSidecar(videoPath, ".whitelist", whitelisted ? "" : null);

    private static void SaveOrDeleteSidecar(string videoPath, string extension, string? content)
    {
        var path = Path.ChangeExtension(videoPath, extension);
        try
        {
            if (content != null) File.WriteAllText(path, content);
            else if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }

    public static List<LibraryItem> LoadAll()
    {
        var items = new List<LibraryItem>();
        if (!Directory.Exists(DownloadHelper.LibraryPath))
            return items;

        // Videos use .mp4; imported still images use .png. Both conventions
        // share the same .jpg-thumbnail / .id-sidecar layout.
        // Exclude .png files that have a sibling .scene — those are scene thumbnails, not wallpapers.
        var mediaFiles = Directory.GetFiles(DownloadHelper.LibraryPath, "*.mp4")
            .Concat(Directory.GetFiles(DownloadHelper.LibraryPath, "*.png")
                .Where(f => !File.Exists(Path.ChangeExtension(f, ".scene"))
                         && !File.Exists(Path.ChangeExtension(f, ".mp4"))));

        foreach (var media in mediaFiles)
        {
            // Dangling symlink (target was deleted, e.g., WE wallpaper
            // uninstalled from Steam). Sweep it and its sibling .jpg/.id.
            if (!File.Exists(media))
            {
                if (IsSymlink(media)) CleanOrphan(media);
                continue;
            }

            string title = Path.GetFileNameWithoutExtension(media);
            string idFile = Path.ChangeExtension(media, ".id");
            string? sourceId = File.Exists(idFile) ? File.ReadAllText(idFile).Trim() : null;
            string? workshopId = ParseWorkshopId(sourceId, media, idFile);
            bool hasCrashed = File.Exists(Path.ChangeExtension(media, ".crashed"));
            bool isWhitelisted = File.Exists(Path.ChangeExtension(media, ".whitelist"));
            int? volumeOverride = ReadVolumeOverride(media);
            double? speedOverride = ReadSpeedOverride(media);
            var fi = new FileInfo(media);

            items.Add(new LibraryItem
            {
                Title = title,
                VideoPath = media,
                ThumbnailPath = FindLibraryThumbnail(media),
                SourceId = sourceId,
                WorkshopId = workshopId,
                HasCrashed = hasCrashed,
                IsWhitelisted = isWhitelisted,
                VolumeOverride = volumeOverride,
                SpeedOverride = speedOverride,
                AddedAt = fi.CreationTime.Year <= 1970 ? fi.LastWriteTime : fi.CreationTime
            });
        }

        foreach (var scene in Directory.GetFiles(DownloadHelper.LibraryPath, "*.scene"))
        {
            string title = Path.GetFileNameWithoutExtension(scene);
            string? thumb = FindLibraryThumbnail(scene);
            string idFile = Path.ChangeExtension(scene, ".id");
            string? sourceId = File.Exists(idFile) ? File.ReadAllText(idFile).Trim() : null;
            string? workshopId = null;
            string? copiedSceneDir = null;
            try
            {
                var raw = File.ReadAllText(scene).Trim();
                if (Path.IsPathRooted(raw))
                {
                    copiedSceneDir = raw;
                    workshopId = ParseWorkshopId(sourceId, scene, Path.ChangeExtension(scene, ".id"));
                }
                else
                {
                    workshopId = raw;
                }
            }
            catch { }
            bool hasCrashed = File.Exists(Path.ChangeExtension(scene, ".crashed"));
            bool isWhitelisted = File.Exists(Path.ChangeExtension(scene, ".whitelist"));
            int? volumeOverride = ReadVolumeOverride(scene);
            double? speedOverride = ReadSpeedOverride(scene);
            var fi = new FileInfo(scene);

            items.Add(new LibraryItem
            {
                Title = title,
                VideoPath = scene,
                ThumbnailPath = thumb,
                SourceId = sourceId,
                IsScene = true,
                WorkshopId = workshopId,
                CopiedSceneDir = copiedSceneDir,
                HasCrashed = hasCrashed,
                IsWhitelisted = isWhitelisted,
                VolumeOverride = volumeOverride,
                SpeedOverride = speedOverride,
                AddedAt = fi.CreationTime.Year <= 1970 ? fi.LastWriteTime : fi.CreationTime
            });
        }

        return items;
    }

    private static string? FindLibraryThumbnail(string mediaPath)
    {
        string dir = Path.GetDirectoryName(mediaPath) ?? "";
        string name = Path.GetFileNameWithoutExtension(mediaPath);
        string fullMedia = Path.GetFullPath(mediaPath);
        foreach (var file in Directory.EnumerateFiles(dir, name + ".*"))
        {
            if (Path.GetFullPath(file) == fullMedia) continue;
            string ext = Path.GetExtension(file).ToLowerInvariant();
            if (ext == ".jpg" || ext == ".png" || ext == ".gif" || ext == ".jpeg")
                return file;
        }
        return null;
    }

    private static string? ParseWorkshopId(string? sourceId, string mp4, string idFile)
    {
        if (sourceId == null) return null;
        if (long.TryParse(sourceId, out _)) return sourceId;
        if (sourceId.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return null;

        // Local path — extract numeric workshop ID from path segments
        var parts = sourceId.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if ((parts[i] == "431960" || parts[i].Equals("workshop", StringComparison.OrdinalIgnoreCase))
                && long.TryParse(parts[i + 1], out _))
            {
                string id = parts[i + 1];
                try { File.WriteAllText(idFile, id); } catch { }
                return id;
            }
        }
        // Fallback: any purely numeric 8+ digit segment
        foreach (var part in parts)
        {
            if (part.Length >= 8 && long.TryParse(part, out _))
            {
                try { File.WriteAllText(idFile, part); } catch { }
                return part;
            }
        }
        return null;
    }

    public static int? ReadVolumeOverride(string mediaPath)
    {
        var path = Path.ChangeExtension(mediaPath, ".volume");
        if (!File.Exists(path)) return null;
        try { return int.TryParse(File.ReadAllText(path).Trim(), out int v) ? v : null; }
        catch { return null; }
    }

    public static double? ReadSpeedOverride(string mediaPath)
    {
        var path = Path.ChangeExtension(mediaPath, ".speed");
        if (!File.Exists(path)) return null;
        try { return double.TryParse(File.ReadAllText(path).Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double v) ? v : null; }
        catch { return null; }
    }

    internal static bool IsSymlink(string path)
    {
        try { return new FileInfo(path).LinkTarget != null; }
        catch { return false; }
    }

    internal static bool IsOrphanSymlink(string path) => !File.Exists(path) && IsSymlink(path);

    internal static void CleanOrphan(string mp4Path)
    {
        try { File.Delete(mp4Path); } catch { }
        foreach (var ext in new[] { ".jpg", ".png", ".gif", ".jpeg", ".id", ".scene", ".crashed", ".whitelist", ".volume", ".speed" })
            try { File.Delete(Path.ChangeExtension(mp4Path, ext)); } catch { }
    }
}
