using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

// A file or a Wallpaper Engine item folder from this PC into imported/<key> (POST /library/import, a folder import, a
// watched folder). The source stays where it is and is never written: the item holds a copy of it or a link to it, and a
// link is unlinked on delete (LibraryService.TryDeleteDir), never deleted through. The index names the source
// (SourceUrl "import:<path>"), so importing it again is the same item at the same key, in the form it already has.
// Guard: scripts/test-item-actions.sh § import, scripts/test-folder-import.sh
public static class ImportService
{
    public static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

    // One import at a time picks a key and fills it: two imports titled alike would otherwise both find the same key free.
    private static readonly SemaphoreSlim Gate = new(1, 1);

    // ffmpeg runs inside Gate; one that hangs must not stop every later import
    private static readonly TimeSpan FfmpegLimit = TimeSpan.FromSeconds(60);

    private static string Ext(string path) => Path.GetExtension(path).ToLowerInvariant();

    // A video, gif or picture → imported/<key>/<key>.<ext> and its <key>.jpg thumbnail. A video or gif keeps its own
    // extension, so whatever tells a format by its name (the card's gif-or-video choice, /media's type, the "open in your
    // default app" check) sees what the file is; one the library doesn't look for (LibraryService.ImportedMediaExts) is
    // stored as .mp4, which the player plays whatever the container. A picture is stored as a png (the library finds a still
    // as <key>.png): a png as it is, any other converted, even when `link` asks for a link. `meta` adds to the item's index
    // entry in the same write (a watched folder's mark). null when the file isn't there.
    public static async Task<LibraryItem?> ImportAsync(string sourcePath, string title, bool link = false, Action<LibMeta>? meta = null)
    {
        if (!File.Exists(sourcePath)) return null;
        string src = Path.GetFullPath(sourcePath);
        string sourceId = FolderScanner.ImportPrefix + src;
        bool picture = ImageExtensions.Contains(Ext(src));
        string ext = picture ? ".png" : LibraryService.ImportedMediaExts.Contains(Ext(src)) ? Ext(src) : ".mp4";

        string media, thumb, key;
        await Gate.WaitAsync();
        try
        {
            key = KeyFor(sourceId, title);
            string dir = Directory.CreateDirectory(Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key)).FullName;
            media = Path.Combine(dir, key + ext);
            thumb = Path.Combine(dir, key + ".jpg");
            if (media != src)
            {
                if (picture && Ext(src) != ".png") await ConvertToPngAsync(src, media);
                // a re-import keeps the item's form: a link stays a link, a copy is copied again
                else if (File.Exists(media) ? LibraryService.IsSymlink(media) : link) await PlaceAsync(media, (part) => { File.CreateSymbolicLink(part, src); return Task.CompletedTask; });
                else await PlaceAsync(media, (part) => Task.Run(() => File.Copy(src, part)));
            }
            // in the index before the slow thumbnail, so a /library meanwhile lists it
            LibraryStore.SetMeta(media, (m) => { m.Title = key; m.SourceUrl = sourceId; meta?.Invoke(m); });
        }
        finally { Gate.Release(); }

        await ThumbnailAsync(media, thumb, picture);
        return new LibraryItem
        {
            Title = key,
            VideoPath = media,
            ThumbnailPath = File.Exists(thumb) ? thumb : null,
            SourceId = sourceId,
        };
    }

    // A Wallpaper Engine item folder (a scene, a preset, or a video beside its project.json) → imported/<key> itself: a link
    // to the folder, or a copy built in a staging folder under the library's trash (purged at start and close) and moved in
    // whole, so a copy cut short never shows as the item. A re-import keeps the item's form and copies a copy again (the
    // folder changed). null when the folder is gone or isn't an item folder.
    public static async Task<LibraryItem?> ImportFolderAsync(FolderScanner.Found f, bool link, Action<LibMeta>? meta = null)
    {
        if (!f.Folder || !Directory.Exists(f.Path)) return null;
        string src = Path.GetFullPath(f.Path);
        string sourceId = FolderScanner.ImportPrefix + src;
        string key;
        await Gate.WaitAsync();
        try
        {
            key = KeyFor(sourceId, f.Title);
            string item = Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key);
            bool there = Directory.Exists(item) || File.Exists(item);
            if (there ? LibraryService.IsSymlink(item) : link)
            {
                if (!there) File.CreateSymbolicLink(item, src);
            }
            else await CopyFolderInAsync(src, item);
            LibraryStore.UpdateIndex(LibraryStore.Imported, (index) =>
            {
                var m = index.GetValueOrDefault(key) ?? new LibMeta();
                m.Title = f.Title;
                m.SourceUrl = sourceId;
                m.IsScene = f.Kind == "scene";
                m.WorkshopId = f.WorkshopId;
                meta?.Invoke(m);
                index[key] = m;
                return true;
            });
        }
        finally { Gate.Release(); }
        return LibraryService.LoadOne(LibraryStore.Imported, key);
    }

    // The key this source already has, else the title's name made free with " (n)" (the way a file manager names a copy).
    // Under Gate.
    private static string KeyFor(string sourceId, string title)
    {
        foreach (var (key, m) in LibraryStore.LoadIndex(LibraryStore.Imported))
            if (m.SourceUrl == sourceId) return key;
        string name = LibraryService.SanitizeName(title) is { Length: > 0 } n ? n : "imported";
        string dir = LibraryStore.SourceDir(LibraryStore.Imported);
        for (int i = 1; ; i++)
        {
            string candidate = i == 1 ? name : $"{name} ({i - 1})";
            if (!Directory.Exists(Path.Combine(dir, candidate)) && !File.Exists(Path.Combine(dir, candidate))) return candidate;
        }
    }

    // `dest` appears whole or not at all: written as a side file (its own extension last, for ffmpeg), then renamed over it
    private static async Task PlaceAsync(string dest, Func<string, Task> write)
    {
        string part = $"{dest}.{Guid.NewGuid():N}.part{Path.GetExtension(dest)}";
        try
        {
            await write(part);
            File.Move(part, dest, overwrite: true);
        }
        catch
        {
            try { File.Delete(part); } catch { }
            throw;
        }
    }

    private static Task ConvertToPngAsync(string src, string dest) => PlaceAsync(dest, async (part) =>
    {
        if (!await FfmpegAsync("-y", "-i", src, "-frames:v", "1", part) || !File.Exists(part))
            throw new InvalidDataException($"ffmpeg couldn't turn {Path.GetFileName(src)} into a png");
    });

    private static async Task CopyFolderInAsync(string src, string item)
    {
        Directory.CreateDirectory(LibraryService.TrashPath);
        string stage = Path.Combine(LibraryService.TrashPath, $"import-{Guid.NewGuid():N}"[..15]);
        try { await Task.Run(() => LibraryService.CopyTree(src, stage)); }
        catch { LibraryService.TryDeleteDir(stage); throw; }
        if (!Directory.Exists(item)) { Directory.Move(stage, item); return; }
        string previous = stage + "-old";
        Directory.Move(item, previous);
        try { Directory.Move(stage, item); }
        catch
        {
            Directory.Move(previous, item);
            LibraryService.TryDeleteDir(stage);
            throw;
        }
        LibraryService.TryDeleteDir(previous);
    }

    // A picture's thumbnail is the picture scaled down. A video's is its first frame that is neither near-black nor near-white
    // (signalstats' mean luma between 30 and 225: a fade-in's black frame tells nothing), else the frame at 1 s, else the
    // first frame.
    private static async Task ThumbnailAsync(string media, string thumb, bool picture)
    {
        const string scale = "scale=320:-1";
        const string notBlankFrame = "signalstats,metadata=select:key=lavfi.signalstats.YAVG:value=30:function=greater,"
            + "metadata=select:key=lavfi.signalstats.YAVG:value=225:function=less," + scale;
        var tries = new List<string[]>();
        if (!picture)
        {
            tries.Add(["-i", media, "-vf", notBlankFrame]);
            tries.Add(["-ss", "1", "-i", media, "-vf", scale]);
        }
        tries.Add(["-i", media, "-vf", scale]);
        foreach (var input in tries)
        {
            try { File.Delete(thumb); } catch { }
            if (await FfmpegAsync(["-y", .. input, "-frames:v", "1", thumb]) && File.Exists(thumb)) return;
        }
    }

    // ffmpeg with `args`: true when it exited 0 within FfmpegLimit (past it, killed with its children and reaped)
    private static async Task<bool> FfmpegAsync(params string[] args)
    {
        var start = new ProcessStartInfo("ffmpeg") { RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("-nostdin");
        foreach (var a in args) start.ArgumentList.Add(a);
        Process? ffmpeg;
        try { ffmpeg = Process.Start(start); }
        catch { return false; }
        if (ffmpeg == null) return false;
        using (ffmpeg)
        {
            // drained, or a chatty ffmpeg blocks on a full pipe
            _ = ffmpeg.StandardOutput.ReadToEndAsync();
            _ = ffmpeg.StandardError.ReadToEndAsync();
            using var limit = new CancellationTokenSource(FfmpegLimit);
            try { await ffmpeg.WaitForExitAsync(limit.Token); }
            catch (OperationCanceledException)
            {
                try { ffmpeg.Kill(entireProcessTree: true); } catch { }
                await ffmpeg.WaitForExitAsync();
                return false;
            }
            return ffmpeg.ExitCode == 0;
        }
    }
}
