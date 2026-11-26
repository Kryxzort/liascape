using System;
using System.Collections.Generic;
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
// Both kinds come in through AdmitAsync and answer with the item as /library lists it (LibraryService.LoadOne); a kind
// adds only how its source is placed and what its index entry says.
// Guard: scripts/test-item-actions.sh § import, scripts/test-folder-import.sh
public static class ImportService
{
    public static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".webp"];

    // One import at a time picks a key and fills it: two imports titled alike would otherwise both find the same key free.
    private static readonly SemaphoreSlim Gate = new(1, 1);

    // ffmpeg runs inside Gate (a png conversion); one that hangs must not stop every later import
    private static readonly TimeSpan FfmpegLimit = TimeSpan.FromSeconds(60);

    private static string Ext(string path) => Path.GetExtension(path).ToLowerInvariant();

    // A video, gif or picture → imported/<key>/<key>.<ext> and its <key>.jpg thumbnail. A video or gif keeps its own
    // extension, so whatever tells a format by its name (the card's gif-or-video choice, /media's type, the "open in your
    // default app" check) sees what the file is; one the library doesn't look for (LibraryService.ImportedMediaExts) is
    // stored as .mp4, which the player plays whatever the container. A picture is stored as a png (the library finds a still
    // as <key>.png): a png as it is, any other converted, even when `link` asks for a link. `meta` adds to the item's index
    // entry in the same write (a watched folder's mark). null when the file isn't there.
    // `sourceId`: what the index names as its source in place of "import:<path>" (an import from a link: its address, which
    // its re-import finds). `take`: the file is the import's own (a link's download in the library's trash): moved in, never
    // copied or linked.
    public static async Task<LibraryItem?> ImportAsync(string sourcePath, string title, bool link = false, Action<LibMeta>? meta = null,
        string? sourceId = null, bool take = false)
    {
        if (!File.Exists(sourcePath)) return null;
        string src = Path.GetFullPath(sourcePath);
        bool picture = ImageExtensions.Contains(Ext(src));
        string ext = picture ? ".png" : LibraryService.ImportedMediaExts.Contains(Ext(src)) ? Ext(src) : ".mp4";

        string key = await AdmitAsync(src, title, async (item, name) =>
        {
            string media = Path.Combine(Directory.CreateDirectory(item).FullName, name + ext);
            if (media == src) return;
            if (picture && Ext(src) != ".png") await ConvertToPngAsync(src, media);
            else if (take) await PlaceAsync(media, (part) => { File.Move(src, part); return Task.CompletedTask; });
            // a re-import keeps the item's form: a link stays a link, a copy is copied again
            else if (File.Exists(media) ? LibraryService.IsSymlink(media) : link) await PlaceAsync(media, (part) => { File.CreateSymbolicLink(part, src); return Task.CompletedTask; });
            else await PlaceAsync(media, (part) => Task.Run(() => File.Copy(src, part)));
        }, (m, name) => { m.Title = name; meta?.Invoke(m); }, sourceId);

        // outside the gate: a slow ffmpeg holds up no other import, and the item is listed (without its card picture) meanwhile
        string dir = Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key);
        await ThumbnailAsync(Path.Combine(dir, key + ext), Path.Combine(dir, key + ".jpg"), picture);
        return LibraryService.LoadOne(LibraryStore.Imported, key);
    }

    // A Wallpaper Engine item folder (a scene, a preset, or a video beside its project.json) → imported/<key> itself: a link
    // to the folder, or a copy built in a staging folder under the library's trash (purged at start and close) and moved in
    // whole, so a copy cut short never shows as the item. A re-import keeps the item's form and copies a copy again (the
    // folder changed). null when the folder is gone or isn't an item folder.
    public static async Task<LibraryItem?> ImportFolderAsync(FolderScanner.Found f, bool link, Action<LibMeta>? meta = null)
    {
        if (!f.Folder || !Directory.Exists(f.Path)) return null;
        string src = Path.GetFullPath(f.Path);
        string key = await AdmitAsync(src, f.Title, async (item, _) =>
        {
            bool there = Directory.Exists(item) || File.Exists(item);
            if (there ? LibraryService.IsSymlink(item) : link)
            {
                if (!there) File.CreateSymbolicLink(item, src);
            }
            else await CopyFolderInAsync(src, item);
        }, (m, _) =>
        {
            m.Title = f.Title;
            m.IsScene = f.Kind == "scene";
            m.WorkshopId = f.WorkshopId;
            meta?.Invoke(m);
        });
        return LibraryService.LoadOne(LibraryStore.Imported, key);
    }

    // An import's way in, all under Gate: its key, `place` putting the source at imported/<key> (the item's path and key
    // given), then its index entry (SourceUrl, and what `describe` adds). The order is forced, not chosen: a key is only
    // known free while Gate is held, and the entry is written once its file is whole, so /library never lists an item with
    // nothing behind it and a placement that throws leaves the index as it was. The key back.
    private static async Task<string> AdmitAsync(string src, string title, Func<string, string, Task> place, Action<LibMeta, string> describe,
        string? source = null)
    {
        string sourceId = source ?? FolderScanner.ImportPrefix + src;
        await Gate.WaitAsync();
        try
        {
            // a library no import has filled yet has no imported/ to place a link or a moved copy in
            Directory.CreateDirectory(LibraryStore.SourceDir(LibraryStore.Imported));
            string key = KeyFor(sourceId, title);
            await place(Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key), key);
            LibraryStore.UpdateIndex(LibraryStore.Imported, (index) =>
            {
                var m = index.GetValueOrDefault(key) ?? new LibMeta();
                m.SourceUrl = sourceId;
                describe(m, key);
                index[key] = m;
                return true;
            });
            return key;
        }
        finally { Gate.Release(); }
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
        if (!(await Ffmpeg("-y", "-i", src, "-frames:v", "1", part)).Ok || !File.Exists(part))
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
            if ((await Ffmpeg(["-y", .. input, "-frames:v", "1", thumb])).Ok && File.Exists(thumb)) return;
        }
    }

    private static Task<ChildProcess.Result> Ffmpeg(params string[] args) =>
        ChildProcess.RunAsync("ffmpeg", ["-nostdin", .. args], FfmpegLimit);
}
