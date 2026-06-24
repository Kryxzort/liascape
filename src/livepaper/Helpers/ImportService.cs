using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Models;

namespace livepaper.Helpers;

// Imports a user-provided video into imported/<name>/: copies the file, generates a thumbnail
// with ffmpeg, and records it in the source index so re-imports dedupe.
public static class ImportService
{
    // Serialize the filename-selection + copy/move + index-write critical
    // section so two concurrent imports can't both pick the same safeTitle
    // (TOCTOU between File.Exists and the rename) and clobber each other.
    // The UI's import guard already blocks re-entry, but defending
    // inside the helper itself makes the contract self-contained.
    private static readonly SemaphoreSlim _importLock = new(1, 1);

    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

    private static bool IsImage(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path).ToLowerInvariant());

    public static async Task<LibraryItem?> ImportAsync(string sourcePath, string title)
    {
        if (!File.Exists(sourcePath)) return null;
        var importedDir = LibraryStore.SourceDir(LibraryStore.Imported);
        Directory.CreateDirectory(importedDir);

        var baseTitle = SanitizeName(title);
        if (string.IsNullOrEmpty(baseTitle)) baseTitle = "imported";
        var sourceId = "import:" + sourcePath;

        bool isImage = IsImage(sourcePath);
        string mediaExt = isImage ? ".png" : ".mp4";

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
            else if (!samePath)
            {
                var tmp = $"{videoPath}.{Guid.NewGuid():N}.tmp";
                try { await Task.Run(() => File.Copy(sourcePath, tmp, overwrite: true)); File.Move(tmp, videoPath, overwrite: true); }
                catch { try { File.Delete(tmp); } catch { } throw; }
            }
            // write the index entry before the slow thumbnail extraction so a concurrent LoadAll sees it
            LibraryStore.SetMeta(videoPath, m => { m.Title = key; m.SourceUrl = sourceId; });
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
