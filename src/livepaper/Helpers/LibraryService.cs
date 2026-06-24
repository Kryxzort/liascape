using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using livepaper.Models;

namespace livepaper.Helpers;

// Per-source, per-item-folder library. Layout (see LibraryStore):
//   <source>/<key>/<key>.mp4|png (+ <key>.jpg/.gif)        web/imported video — folder named after the item
//   workshop/<id>/{file.mp4, preview.*, project.json}      direct-DL video (owned, Steam-mirror)
//   local/<id> -> symlink into the user's WE dir           subscribed/WE-local video
//   workshop/<id> | local/<id>                             SCENE — the item FOLDER itself is the play path.
//       PlayerHelper.IsScenePath = "no media extension"; LWE launches by id (local) or dir (owned).
//       Scene-ness comes from index .IsScene / project.json type / scene.pkg.
//   <source>/index.json                                    metadata (volume/speed/crashed/whitelist/source/…)
// Metadata + dedup live in the per-source index.json (see LibraryStore).
public static class LibraryService
{
    private static readonly string[] VideoExts = { ".mp4", ".webm", ".mov", ".mkv", ".avi" };
    private static bool IsVideoFile(string p) => VideoExts.Contains(Path.GetExtension(p).ToLowerInvariant());

    // ---------- read overrides / flags (now from the source index) ----------
    public static int? ReadVolumeOverride(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Volume;
    public static double? ReadSpeedOverride(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Speed;
    public static bool IsWhitelisted(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Whitelist ?? false;
    public static bool HasCrashed(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Crashed ?? false;

    // ---------- write overrides / flags (drop volume/speed when == global → "use global") ----------
    public static void SaveVolumeOverride(string mediaPath, int? volume)
    {
        if (volume.HasValue && volume.Value == SettingsService.Load().Volume) volume = null;
        LibraryStore.SetMeta(mediaPath, m => m.Volume = volume);
    }

    public static void SaveSpeedOverride(string mediaPath, double? speed)
    {
        if (speed.HasValue && Math.Abs(speed.Value - SettingsService.Load().Speed) < 1e-6) speed = null;
        LibraryStore.SetMeta(mediaPath, m => m.Speed = speed);
    }

    public static void SetWhitelisted(string mediaPath, bool whitelisted) =>
        LibraryStore.SetMeta(mediaPath, m => m.Whitelist = whitelisted);

    public static void MarkCrashed(string mediaPath) =>
        LibraryStore.SetMeta(mediaPath, m => m.Crashed = true);

    // ---------- LoadAll ----------
    public static List<LibraryItem> LoadAll()
    {
        var items = new List<LibraryItem>();
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return items;

        foreach (var source in LibraryStore.Sources)
        {
            var dir = LibraryStore.SourceDir(source);
            if (!Directory.Exists(dir)) continue;
            var idx = LibraryStore.LoadIndex(source);

            // Every item is a folder. SCENE = folder whose VideoPath IS the folder (no media file —
            // see PlayerHelper.IsScenePath); VIDEO/IMAGE = folder holding a media file. local/<id> is a
            // symlink, still a directory entry. Scene-ness: the index flag, else project.json type / scene.pkg.
            foreach (var itemDir in SafeDirs(dir))
            {
                var key = Path.GetFileName(itemDir);
                var m = idx.GetValueOrDefault(key);
                if ((m?.IsScene ?? false) || IsSceneFolder(itemDir))
                {
                    items.Add(Build(itemDir, key, m, isScene: true, assetDir: itemDir, workshopId: key,
                        copiedSceneDir: source == LibraryStore.Workshop ? itemDir : null));
                    continue;
                }
                var media = ResolveItemMedia(itemDir, key);
                if (media == null) continue;
                if (!File.Exists(media)) { if (m == null) TryDeleteDir(itemDir); continue; } // dangling symlink
                items.Add(Build(media, key, m, isScene: false, itemDir));
            }
        }
        return items;
    }

    // A workshop/local folder is a scene when project.json says type=scene (authoritative when present),
    // else when a compiled scene.pkg sits in it. Web/imported folders have neither → video/image.
    private static bool IsSceneFolder(string itemDir)
    {
        var pj = Path.Combine(itemDir, "project.json");
        if (File.Exists(pj))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                if (doc.RootElement.TryGetProperty("type", out var t))
                    return string.Equals(t.GetString(), "scene", StringComparison.OrdinalIgnoreCase);
            }
            catch { }
        }
        return File.Exists(Path.Combine(itemDir, "scene.pkg"));
    }

    // the playable media inside an item folder: web/imported = <key>.<videoext>|png; workshop/local = project.json "file"
    private static string? ResolveItemMedia(string itemDir, string key)
    {
        var pj = Path.Combine(itemDir, "project.json");
        if (File.Exists(pj))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                if (doc.RootElement.TryGetProperty("file", out var f) && f.GetString() is { Length: > 0 } file)
                    return Path.Combine(itemDir, file);
            }
            catch { }
        }
        foreach (var ext in VideoExts.Concat(new[] { ".png" }))
        {
            var p = Path.Combine(itemDir, key + ext);
            if (File.Exists(p)) return p;
        }
        // fall back to the first video file in the folder (workshop folder may name the file arbitrarily)
        return SafeFiles(itemDir, "*").FirstOrDefault(IsVideoFile);
    }

    private static LibraryItem Build(string media, string key, LibMeta? m, bool isScene,
        string? assetDir = null, string? workshopId = null, string? copiedSceneDir = null)
    {
        m ??= new LibMeta();
        string folder = assetDir ?? Path.GetDirectoryName(media) ?? "";
        DateTime added; try { var fi = new FileInfo(media); added = fi.CreationTime.Year <= 1970 ? fi.LastWriteTime : fi.CreationTime; } catch { added = DateTime.Now; }
        return new LibraryItem
        {
            Title = m.Title ?? key,
            VideoPath = media,
            ThumbnailPath = FindThumb(folder, key),
            AnimatedThumbnailPath = FindAnimated(folder, key),
            SourceId = m.SourceUrl ?? m.WorkshopId ?? workshopId,
            IsScene = isScene || m.IsScene,
            WorkshopId = m.WorkshopId ?? workshopId,
            CopiedSceneDir = copiedSceneDir,
            HasCrashed = m.Crashed,
            IsWhitelisted = m.Whitelist,
            VolumeOverride = m.Volume,
            SpeedOverride = m.Speed,
            AddedAt = added,
            Resolution = m.Resolution, AgeRating = m.AgeRating, YoutubeUrl = m.YoutubeUrl, PageUrl = m.PageUrl,
            AuthorName = m.AuthorName, Description = m.Description, FileSizeBytes = m.FileSizeBytes,
            Subscriptions = m.Subscriptions, Favorites = m.Favorites, Views = m.Views, Tags = m.Tags,
        };
    }

    // thumbnail in an item folder: <key>.jpg (web/imported) or preview.* (workshop/local Steam folder)
    private static string? FindThumb(string folder, string key)
    {
        foreach (var name in new[] { key + ".jpg", key + ".jpeg", key + ".png", "preview.jpg", "preview.png", "preview.jpeg" })
        {
            var p = Path.Combine(folder, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    private static string? FindAnimated(string folder, string key)
    {
        foreach (var name in new[] { key + ".gif", key + ".webp", "preview.gif", "preview.webp" })
        {
            var p = Path.Combine(folder, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // ---------- WE auto-import → local/<id> ----------
    public static List<string> SyncWallpaperEngine(string workshopPath, bool allowScenes, bool weCopyFiles)
    {
        var added = new List<string>();
        if (string.IsNullOrEmpty(workshopPath) || !Directory.Exists(workshopPath)) return added;
        var localDir = LibraryStore.SourceDir(LibraryStore.Local);
        Directory.CreateDirectory(localDir);
        var idx = LibraryStore.LoadIndex(LibraryStore.Local);
        var have = ExistingWorkshopIds();
        var blocked = WorkshopUnsubQueue.SnapshotBlockedSet();

        foreach (var dir in SafeDirs(workshopPath))
        {
            var id = Path.GetFileName(dir);
            if (have.Contains(id) || blocked.Contains(id)) continue;
            string? type = null, file = null, title = null;
            bool hasScenePkg = File.Exists(Path.Combine(dir, "scene.pkg"));
            var pj = Path.Combine(dir, "project.json");
            if (File.Exists(pj))
            {
                try { using var doc = JsonDocument.Parse(File.ReadAllText(pj)); var r = doc.RootElement;
                    type = r.TryGetProperty("type", out var t) ? t.GetString() : null;
                    file = r.TryGetProperty("file", out var f) ? f.GetString() : null;
                    title = r.TryGetProperty("title", out var ti) ? ti.GetString() : null; }
                catch { continue; }
            }
            else if (!hasScenePkg) continue;

            bool isVideo = string.Equals(type, "video", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(file);
            bool isScene = string.Equals(type, "scene", StringComparison.OrdinalIgnoreCase) || (type == null && hasScenePkg);

            if (isVideo)
            {
                if (!File.Exists(Path.Combine(dir, file!))) continue;
                var link = Path.Combine(localDir, id);
                try { if (!Directory.Exists(link) && !File.Exists(link)) File.CreateSymbolicLink(link, dir); } catch { continue; }
                idx[id] = new LibMeta { Title = SanitizeName(title) is { Length: > 0 } st ? st : id, WorkshopId = id };
                added.Add(Path.Combine(link, file!));
            }
            else if (isScene && allowScenes)
            {
                var link = Path.Combine(localDir, id);                          // local/<id> → WE dir; the folder IS the scene
                try { if (!Directory.Exists(link) && !File.Exists(link)) File.CreateSymbolicLink(link, dir); } catch { continue; }
                idx[id] = new LibMeta { Title = SanitizeName(title) is { Length: > 0 } st2 ? st2 : id, WorkshopId = id, IsScene = true };
                added.Add(link);
            }
        }
        LibraryStore.SaveIndex(LibraryStore.Local, idx);
        return added;
    }

    // workshop/ + local/ folder names = the set of workshop IDs already present
    private static HashSet<string> ExistingWorkshopIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var src in new[] { LibraryStore.Workshop, LibraryStore.Local })
            foreach (var d in SafeDirs(LibraryStore.SourceDir(src)))
                ids.Add(Path.GetFileName(d));
        return ids;
    }

    // ---------- replace a direct-DL with the WE-dir copy when it appears ----------
    public static void ReconcileDirectDownloads(string workshopPath, bool weCopyFiles)
    {
        if (string.IsNullOrEmpty(workshopPath) || !Directory.Exists(workshopPath)) return;
        var workshopLib = LibraryStore.SourceDir(LibraryStore.Workshop);
        if (!Directory.Exists(workshopLib)) return;
        var localDir = LibraryStore.SourceDir(LibraryStore.Local);
        Directory.CreateDirectory(localDir);
        var localIdx = LibraryStore.LoadIndex(LibraryStore.Local);
        var workshopIdx = LibraryStore.LoadIndex(LibraryStore.Workshop);
        bool changed = false, localChanged = false;
        foreach (var dir in SafeDirs(workshopLib).ToList())
        {
            var id = Path.GetFileName(dir);
            var weDir = Path.Combine(workshopPath, id);
            if (!Directory.Exists(weDir)) continue;            // the WE-dir copy hasn't appeared
            var link = Path.Combine(localDir, id);
            if (Directory.Exists(link) || File.Exists(link)) continue; // already represented under local/
            try
            {
                File.CreateSymbolicLink(link, weDir);          // local/<id> → WE dir (scene-ness rides in meta.IsScene)
                var meta = workshopIdx.GetValueOrDefault(id) ?? new LibMeta { WorkshopId = id };
                localIdx[id] = meta; localChanged = true;
                Directory.Delete(dir, recursive: true);        // drop the direct-DL copy (reclaim disk)
                workshopIdx.Remove(id); changed = true;
            }
            catch { try { if (File.Exists(link) || Directory.Exists(link)) File.Delete(link); } catch { } }
        }
        if (localChanged) LibraryStore.SaveIndex(LibraryStore.Local, localIdx);
        if (changed) LibraryStore.SaveIndex(LibraryStore.Workshop, workshopIdx);
    }

    // ---------- trash / delete / restore ----------
    public static string TrashPath => Path.Combine(DownloadHelper.LibraryPath, ".trash");

    public static void Trash(LibraryItem item, string batchDir)
    {
        var loc = LibraryStore.Locate(item.VideoPath);
        if (loc == null) return;
        var dest = Path.Combine(batchDir, loc.Value.Source);
        Directory.CreateDirectory(dest);
        // move the item's folder (scene → the folder IS VideoPath; video → its parent); record the index
        // entry so Restore can replay it. Directory.Move on a local/ symlink moves the link, not its target.
        var assetDir = item.IsScene ? item.VideoPath : Path.GetDirectoryName(item.VideoPath)!;
        var idx = LibraryStore.LoadIndex(loc.Value.Source);
        if (idx.TryGetValue(loc.Value.Key, out var meta))
        {
            try { File.WriteAllText(Path.Combine(dest, loc.Value.Key + ".meta.json"),
                JsonSerializer.Serialize(new TrashedEntry(loc.Value.Source, loc.Value.Key, item.IsScene, meta))); } catch { }
            idx.Remove(loc.Value.Key); LibraryStore.SaveIndex(loc.Value.Source, idx);
        }
        if (Directory.Exists(assetDir)) { try { Directory.Move(assetDir, Path.Combine(dest, loc.Value.Key)); } catch { } }
    }

    private sealed record TrashedEntry(string Source, string Key, bool IsScene, LibMeta Meta);

    public static void RestoreBatch(string batchDir)
    {
        if (!Directory.Exists(batchDir)) return;
        foreach (var sourceDir in Directory.GetDirectories(batchDir))
        {
            var source = Path.GetFileName(sourceDir);
            var idx = LibraryStore.LoadIndex(source);
            var target = LibraryStore.SourceDir(source);
            Directory.CreateDirectory(target);
            foreach (var entryFile in SafeFiles(sourceDir, "*.meta.json"))
            {
                try
                {
                    var e = JsonSerializer.Deserialize<TrashedEntry>(File.ReadAllText(entryFile));
                    if (e == null) continue;
                    var folderSrc = Path.Combine(sourceDir, e.Key);            // scene + video both restore the folder
                    if (Directory.Exists(folderSrc) && !Directory.Exists(Path.Combine(target, e.Key)))
                        Directory.Move(folderSrc, Path.Combine(target, e.Key));
                    idx[e.Key] = e.Meta;
                }
                catch { }
            }
            LibraryStore.SaveIndex(source, idx);
        }
        try { Directory.Delete(batchDir, recursive: true); } catch { }
    }

    public static void PurgeBatch(string batchDir) { try { Directory.Delete(batchDir, recursive: true); } catch { } }

    public static void CleanTrash()
    {
        if (!Directory.Exists(TrashPath)) return;
        foreach (var dir in Directory.GetDirectories(TrashPath)) PurgeBatch(dir);
    }

    public static void Delete(LibraryItem item)
    {
        var loc = LibraryStore.Locate(item.VideoPath);
        if (loc == null) return;
        // scene → the folder IS VideoPath; video → its parent. Directory.Delete unlinks a local/ symlink
        // without touching the WE target (verified on .NET 9: recursive delete of a symlinked dir unlinks).
        var assetDir = item.IsScene ? item.VideoPath : Path.GetDirectoryName(item.VideoPath)!;
        try { if (Directory.Exists(assetDir)) Directory.Delete(assetDir, recursive: true); } catch { }
        LibraryStore.Remove(item.VideoPath);
    }

    public static void DeleteAll()
    {
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return;
        foreach (var source in LibraryStore.Sources)
        {
            var d = LibraryStore.SourceDir(source);
            try { if (Directory.Exists(d)) Directory.Delete(d, recursive: true); } catch { }
        }
    }

    // ---------- helpers (preserved) ----------
    private static IEnumerable<string> SafeDirs(string dir)
    { try { return Directory.GetDirectories(dir); } catch { return Array.Empty<string>(); } }
    private static IEnumerable<string> SafeFiles(string dir, string pat)
    { try { return Directory.GetFiles(dir, pat); } catch { return Array.Empty<string>(); } }
    private static void TryDeleteDir(string dir) { try { Directory.Delete(dir, recursive: true); } catch { } }

    internal static bool IsSymlink(string path)
    { try { return new FileInfo(path).LinkTarget != null || new DirectoryInfo(path).LinkTarget != null; } catch { return false; } }

    public static string SanitizeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray()).Trim();
    }

    internal static void CopyDirectory(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src)) File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src)) CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }

    // Extracts the numeric workshop item ID from a Steam community URL (?id=NNN / &id=NNN).
    public static string? ExtractSteamWorkshopId(string url)
    {
        int idx = url.IndexOf("?id=", StringComparison.Ordinal);
        if (idx < 0) idx = url.IndexOf("&id=", StringComparison.Ordinal);
        if (idx < 0) return null;
        int start = idx + 4, end = start;
        while (end < url.Length && char.IsDigit(url[end])) end++;
        var c = url.Substring(start, end - start);
        return c.Length >= 8 && long.TryParse(c, out _) ? c : null;
    }
}
