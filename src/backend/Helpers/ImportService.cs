using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

// Imports a user-provided video, gif or picture into imported/<name>/ (a copy of the file, or a link to it), or a Wallpaper
// Engine item folder as imported/<name> itself (a copy of the folder, or a link to it); generates a video's or picture's
// thumbnail with ffmpeg and records the source in the index (SourceUrl "import:<path>") so a re-import is the same item.
// A link is the user's own file seen in place: deleting the item removes only the link (LibraryService.Delete), never the
// file. Guard: scripts/test-item-actions.sh § import, scripts/test-folder-import.sh
public static class ImportService
{
    // Serialize the filename-selection + copy/move + index-write critical
    // section so two concurrent imports can't both pick the same safeTitle
    // (TOCTOU between File.Exists and the rename) and clobber each other.
    // The UI's import guard already blocks re-entry, but defending
    // inside the helper itself makes the contract self-contained.
    private static readonly SemaphoreSlim _importLock = new(1, 1);

    public static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

    private static bool IsImage(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path).ToLowerInvariant());

    // `link`: the item's media is a link to the source instead of a copy (a picture that isn't a png is still converted: the
    // library finds a still as <key>.png). A re-import keeps the form the item has (a copy stays a copy). `meta` sets more of
    // the item's index entry in the same write (a watched folder's mark).
    public static async Task<LibraryItem?> ImportAsync(string sourcePath, string title, bool link = false, Action<LibMeta>? meta = null)
    {
        if (!File.Exists(sourcePath)) return null;
        sourcePath = Path.GetFullPath(sourcePath);
        var importedDir = LibraryStore.SourceDir(LibraryStore.Imported);
        Directory.CreateDirectory(importedDir);

        var baseTitle = SanitizeName(title);
        if (string.IsNullOrEmpty(baseTitle)) baseTitle = "imported";
        var sourceId = "import:" + sourcePath;

        bool isImage = IsImage(sourcePath);
        // a still becomes a png; a video or gif keeps its own extension, so everything that tells a format by its name (the
        // card's gif vs video preview, /media's content type, "open in your default app"'s check of the file's magic)
        // sees what the file really is. An extension the library doesn't list (LibraryService.ImportedMediaExts) is stored as
        // .mp4, which the player plays whatever the container: under any other name the library wouldn't find the item.
        // Guard: scripts/test-item-actions.sh § import.
        string srcExt = Path.GetExtension(sourcePath).ToLowerInvariant();
        string mediaExt = isImage ? ".png" : LibraryService.ImportedMediaExts.Contains(srcExt) ? srcExt : ".mp4";

        string key, itemDir, videoPath, thumbPath;
        await _importLock.WaitAsync();
        try
        {
            // reuse the folder if this exact source was already imported (index SourceUrl match), else unique key
            var idx = LibraryStore.LoadIndex(LibraryStore.Imported);
            key = idx.FirstOrDefault(kv => kv.Value.SourceUrl == sourceId).Key
                  ?? UniqueImportedKey(importedDir, baseTitle);
            itemDir = Path.Combine(importedDir, key);
            Directory.CreateDirectory(itemDir);
            videoPath = Path.Combine(itemDir, key + mediaExt);
            thumbPath = Path.Combine(itemDir, key + ".jpg");

            bool needsConvert = isImage && Path.GetExtension(sourcePath).ToLowerInvariant() != ".png";
            bool samePath = Path.GetFullPath(sourcePath) == Path.GetFullPath(videoPath);
            if (!samePath && needsConvert)
            {
                var tmp = $"{videoPath}.{Guid.NewGuid():N}.tmp.png";
                try { var ok = await RunFfmpegAsync("-y", "-i", sourcePath, "-frames:v", "1", tmp); if (!ok || !File.Exists(tmp)) throw new Exception("image conversion failed"); File.Move(tmp, videoPath, overwrite: true); }
                catch { try { File.Delete(tmp); } catch { } throw; }
            }
            else if (!samePath && (File.Exists(videoPath) ? LibraryService.IsSymlink(videoPath) : link))
            {
                var tmp = $"{videoPath}.{Guid.NewGuid():N}.tmp";
                try { File.CreateSymbolicLink(tmp, sourcePath); File.Move(tmp, videoPath, overwrite: true); }
                catch { try { File.Delete(tmp); } catch { } throw; }
            }
            else if (!samePath)
            {
                var tmp = $"{videoPath}.{Guid.NewGuid():N}.tmp";
                try { await Task.Run(() => File.Copy(sourcePath, tmp, overwrite: true)); File.Move(tmp, videoPath, overwrite: true); }
                catch { try { File.Delete(tmp); } catch { } throw; }
            }
            // write the index entry before the slow thumbnail extraction so a concurrent LoadAll sees it
            LibraryStore.SetMeta(videoPath, m => { m.Title = key; m.SourceUrl = sourceId; meta?.Invoke(m); });
        }
        finally { _importLock.Release(); }

        await TryExtractThumbnailAsync(videoPath, thumbPath, isImage);

        return new LibraryItem
        {
            Title = key,
            VideoPath = videoPath,
            ThumbnailPath = File.Exists(thumbPath) ? thumbPath : null,
            SourceId = sourceId,
        };
    }

    // A Wallpaper Engine item folder (a scene, or a video with its project.json) → imported/<key>: a link to the folder, or a
    // copy made in a staging folder under the trash (purged at start and close) and swapped in, so a copy cut short never
    // shows. A re-import keeps the form the item has; a copy is made again (the folder changed). null when the folder is no
    // such item any more.
    public static async Task<LibraryItem?> ImportFolderAsync(FolderScanner.Found f, bool link, Action<LibMeta>? meta = null)
    {
        if (!f.Folder || !Directory.Exists(f.Path)) return null;
        var src = Path.GetFullPath(f.Path);
        var sourceId = FolderScanner.ImportPrefix + src;
        var importedDir = LibraryStore.SourceDir(LibraryStore.Imported);
        Directory.CreateDirectory(importedDir);
        string key;
        await _importLock.WaitAsync();
        try
        {
            var idx = LibraryStore.LoadIndex(LibraryStore.Imported);
            key = idx.FirstOrDefault(kv => kv.Value.SourceUrl == sourceId).Key
                  ?? UniqueImportedKey(importedDir, SanitizeName(f.Title) is { Length: > 0 } t ? t : "imported");
            var dest = Path.Combine(importedDir, key);
            bool exists = Directory.Exists(dest) || File.Exists(dest);
            if (exists ? LibraryService.IsSymlink(dest) : link)
            {
                if (!exists) File.CreateSymbolicLink(dest, src);
            }
            else
            {
                var stage = Path.Combine(LibraryService.TrashPath, "import-" + Guid.NewGuid().ToString("N")[..8]);
                Directory.CreateDirectory(LibraryService.TrashPath);
                try { await Task.Run(() => LibraryService.CopyTree(src, stage)); }
                catch { LibraryService.TryDeleteDir(stage); throw; }
                if (exists)
                {
                    var old = stage + "-old";
                    Directory.Move(dest, old);
                    try { Directory.Move(stage, dest); } catch { Directory.Move(old, dest); LibraryService.TryDeleteDir(stage); throw; }
                    LibraryService.TryDeleteDir(old);
                }
                else Directory.Move(stage, dest);
            }
            bool scene = f.Kind == "scene";
            LibraryStore.UpdateIndex(LibraryStore.Imported, i =>
            {
                var m = i.GetValueOrDefault(key) ?? new LibMeta();
                m.Title = f.Title; m.SourceUrl = sourceId; m.IsScene = scene; m.WorkshopId = f.WorkshopId;
                meta?.Invoke(m);
                i[key] = m;
                return true;
            });
        }
        finally { _importLock.Release(); }
        return LibraryService.LoadOne(LibraryStore.Imported, key);
    }

    private static string UniqueImportedKey(string importedDir, string baseTitle)
    {
        for (int i = 0; i < 10000; i++)
        {
            string k = i == 0 ? baseTitle : $"{baseTitle} ({i})";
            if (!Directory.Exists(Path.Combine(importedDir, k))) return k;
        }
        return baseTitle + "_" + Guid.NewGuid().ToString("N");
    }

    private static async Task<bool> TryExtractThumbnailAsync(string mediaPath, string outputPath, bool isImage)
    {
        if (isImage)
            return await RunFfmpegAsync("-y", "-i", mediaPath, "-frames:v", "1", "-vf", "scale=320:-1", outputPath) && File.Exists(outputPath);

        // Skip black/white frames via YAVG signalstats (30–225 range).
        const string signalFilter = "signalstats,metadata=select:key=lavfi.signalstats.YAVG:value=30:function=greater,metadata=select:key=lavfi.signalstats.YAVG:value=225:function=less,scale=320:-1";
        if (await RunFfmpegAsync("-y", "-i", mediaPath, "-vf", signalFilter, "-frames:v", "1", outputPath) && File.Exists(outputPath))
            return true;

        File.Delete(outputPath);
        if (await RunFfmpegAsync("-y", "-ss", "00:00:01", "-i", mediaPath, "-frames:v", "1", "-vf", "scale=320:-1", outputPath) && File.Exists(outputPath))
            return true;

        File.Delete(outputPath);
        return await RunFfmpegAsync("-y", "-i", mediaPath, "-frames:v", "1", "-vf", "scale=320:-1", outputPath) && File.Exists(outputPath);
    }

    // Conversion ffmpeg invocations run inside _importLock, so a stuck
    // process would block every subsequent import. Cap the wait and kill
    // on timeout instead of holding the lock indefinitely.
    private static readonly TimeSpan FfmpegTimeout = TimeSpan.FromSeconds(60);

    private static async Task<bool> RunFfmpegAsync(params string[] args)
    {
        var psi = new ProcessStartInfo("ffmpeg")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        try
        {
            using var proc = Process.Start(psi);
            if (proc == null) return false;
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            using var cts = new CancellationTokenSource(FfmpegTimeout);
            try
            {
                await proc.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                // Reap the killed process so it doesn't linger as a zombie
                // and so the using-block's Dispose runs against an exited
                // proc. WaitForExitAsync without a token can't itself hang
                // here because Kill is already in flight.
                try { await proc.WaitForExitAsync(); } catch { }
                return false;
            }
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static string SanitizeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray()).Trim();
    }
}
