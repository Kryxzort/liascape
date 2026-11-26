using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Web;

// A Workshop item whose files change in place: Steam downloading it again into the folder a local/<id> link points at, a
// Redownload swapping the library's own workshop/<id> copy. Its play path stays, so nothing else tells an open page: its card
// would keep the old picture (its media URLs carry LibraryItem.FilesVersion, which only a new item read brings) and an item
// that was "Download incomplete" would stay greyed until the next sync. FolderWatch's watchers on the folders those items live
// in (Roots) run Pass, which compares every Workshop item folder's direct entries (name, size, write time) with the last pass
// and sends each changed item's changed fields as library-item-changed; a running rotation's skip flag follows
// (LiascapePlayerProgram.PushItem). The first sight of a folder is only its reference. A folder with a file younger than
// `stable` (still being written) waits for the next pass. Guard: scripts/test-item-actions.sh § files changed,
// --probe probe-sidebar.js lib:thumbFollows
public static class ItemFilesWatch
{
    private static readonly object _lock = new();
    // item folder → its entries' signature, the item as it was then built, and whether the index had it
    private static readonly Dictionary<string, (string Sig, LibraryItem? Item, bool Indexed)> _seen = new(StringComparer.Ordinal);

    // the library's own Workshop copies (workshop/), and every folder a local/<id> link points into (Steam's Workshop folders)
    public static IEnumerable<string> Roots()
    {
        var roots = new HashSet<string>(StringComparer.Ordinal);
        var own = LibraryStore.SourceDir(LibraryStore.Workshop);
        if (Directory.Exists(own)) roots.Add(own);
        foreach (var link in Dirs(LibraryStore.SourceDir(LibraryStore.Local)))
        {
            try
            {
                if (new DirectoryInfo(link).ResolveLinkTarget(returnFinalTarget: true) is { } target
                    && Path.GetDirectoryName(target.FullName) is { } parent && Directory.Exists(parent))
                    roots.Add(parent);
            }
            catch { }
        }
        return roots;
    }

    // one pass over every Workshop item; true = a changed folder was still being written (look again after `stable`). A folder
    // the index has no entry for yet (a download or a sync placing it, whose own end tells the pages) is only its reference:
    // building an item without its entry drops a folder whose media is missing (LibraryService.BuildItem), and a pass a
    // filesystem event started is no moment to judge that.
    public static bool Pass(TimeSpan stable)
    {
        lock (_lock)
        {
            bool unsettled = false;
            var alive = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in new[] { LibraryStore.Workshop, LibraryStore.Local })
            {
                var idx = LibraryStore.LoadIndex(source);
                foreach (var dir in Dirs(LibraryStore.SourceDir(source)))
                {
                    alive.Add(dir);
                    var (sig, young) = SignatureOf(dir, stable);
                    if (sig == null) continue;
                    bool known = _seen.TryGetValue(dir, out var last);
                    if (known && last.Sig == sig) continue;
                    if (known && young) { unsettled = true; continue; }
                    var key = Path.GetFileName(dir);
                    if (!idx.ContainsKey(key)) { _seen[dir] = (sig, null, false); continue; }
                    var item = LibraryService.LoadOne(source, key);
                    _seen[dir] = (sig, item, true);
                    if (known && last.Indexed) Changed(last.Item, item);
                }
            }
            foreach (var gone in _seen.Keys.Where(k => !alive.Contains(k)).ToList()) _seen.Remove(gone);
            return unsettled;
        }
    }

    // what an open page hears: the fields that changed, or a whole re-read when the item's play path or kind changed. Only what
    // changed since the last accepted pass: the half-written states it skips are no page's either, as Steam fills an item in its
    // downloads/ folder and commits it to content/ at the end, and a Redownload swaps a finished copy in (RedownloadOps).
    static void Changed(LibraryItem? was, LibraryItem? now)
    {
        if (now == null) return; // not playable (its media gone): the next sync drops it
        if (was == null || was.VideoPath != now.VideoPath || was.IsScene != now.IsScene || was.IsPreset != now.IsPreset)
        {
            Console.WriteLine($"library: {now.VideoPath}: its files changed — every page reads the library again");
            EventBus.Broadcast("library-synced", new { count = 0 });
            LiascapePlayerProgram.PushItems();
            return;
        }
        var changed = new Dictionary<string, object?> { ["path"] = now.VideoPath };
        void Diff<T>(string name, T a, T b) { if (!EqualityComparer<T>.Default.Equals(a, b)) changed[name] = b; }
        Diff("filesVersion", was.FilesVersion, now.FilesVersion);
        Diff("downloadIncomplete", was.DownloadIncomplete, now.DownloadIncomplete);
        Diff("thumbnailPath", was.ThumbnailPath, now.ThumbnailPath);
        Diff("animatedThumbnailPath", was.AnimatedThumbnailPath, now.AnimatedThumbnailPath);
        Diff("presetReason", was.PresetReason, now.PresetReason);
        Diff("resolution", was.Resolution, now.Resolution);
        Diff("ageRating", was.AgeRating, now.AgeRating);
        if (!(was.Tags ?? []).SequenceEqual(now.Tags ?? [])) changed["tags"] = now.Tags;
        if (changed.Count == 1) return;
        Console.WriteLine($"library: {now.VideoPath}: its files changed ({string.Join(", ", changed.Keys.Skip(1))})");
        EventBus.Broadcast("library-item-changed", changed);
        if (was.DownloadIncomplete == now.DownloadIncomplete) return;
        // whole or empty now: its rotation skip flag follows, and so do the presets it is the base of (their reason is its
        // state: "Its base scene's download is incomplete"), wherever they live in the library
        if (now.IsScene && !now.IsPreset && now.WorkshopId is { } id)
        {
            foreach (var p in LibraryService.LoadAll().Where(i => i.IsPreset && i.BaseWorkshopId == id))
                EventBus.Broadcast("library-item-changed", new { path = p.VideoPath, presetReason = p.PresetReason });
            LiascapePlayerProgram.PushItems();
        }
        else LiascapePlayerProgram.PushItem(now.VideoPath);
    }

    // the folder's direct entries (through a local/<id> link) as one string; null = unreadable. `young`: one was written
    // within `stable`.
    static (string? Sig, bool Young) SignatureOf(string dir, TimeSpan stable)
    {
        try
        {
            var now = DateTime.UtcNow;
            bool young = false;
            var parts = new List<string>();
            foreach (var e in new DirectoryInfo(dir).EnumerateFileSystemInfos())
            {
                var t = e.LastWriteTimeUtc;
                if (now - t < stable) young = true;
                parts.Add($"{e.Name}\u0001{(e is FileInfo f ? f.Length : -1)}\u0001{t.Ticks}");
            }
            parts.Sort(StringComparer.Ordinal);
            return (string.Join('\u0002', parts), young);
        }
        catch { return (null, false); }
    }

    static IEnumerable<string> Dirs(string dir) { try { return Directory.GetDirectories(dir); } catch { return []; } }
}
