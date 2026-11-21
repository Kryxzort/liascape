using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Web;

// Importing what a folder holds (Helpers/FolderScanner.cs): the Library's Import (a picked folder or file, or one dropped on the
// window) scans first and the UI shows what it found (POST /library/scan); only what the user ticks lands (POST
// /library/import-found). A watched folder (Web/FolderWatch.cs) runs the same scan and the same import. Every import, a
// dialog's or a watch's, runs through one gate at a time: a folder added as watched while its first import runs never imports
// an item twice. Progress: the top bar's line (LibraryOps "import"). Guard: scripts/test-folder-import.sh
public static class FolderImportOps
{
    private static readonly SemaphoreSlim _gate = new(1, 1);
    private static int _queued, _done;

    public sealed record ScanReq(List<string>? Paths);
    public sealed record ImportFoundReq(List<string>? Paths, bool Copy, string? Watch, List<string>? Skip, List<string>? Roots);
    public sealed record WatchedReq(string? Path, bool? Copy, bool Remove = false);

    public static string? Norm(string? p)
    {
        if (string.IsNullOrWhiteSpace(p) || p[0] != '/' || p.Contains('\0')) return null;
        try { return Path.TrimEndingDirectorySeparator(Path.GetFullPath(p)) is { Length: > 0 } n ? n : "/"; } catch { return null; }
    }

    // POST /library/scan {paths}: what each path holds (a folder scanned, a file identified), every item once.
    public static object Scan(List<string> paths)
    {
        var known = FolderScanner.Known.Load();
        var s = SettingsService.Load();
        var items = new List<object>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unreadable = new List<string>();
        int unsupported = 0, duplicates = 0; bool truncated = false;
        var roots = new List<string>();
        foreach (var raw in paths)
        {
            if (Norm(raw) is not { } p) continue;
            var r = FolderScanner.Scan(p, known);
            roots.Add(p);
            unreadable.AddRange(r.Unreadable); unsupported += r.Unsupported; duplicates += r.Duplicates; truncated |= r.Truncated;
            var baseDir = Directory.Exists(p) ? p : Path.GetDirectoryName(p) ?? "/";
            foreach (var f in r.Items)
            {
                if (!seen.Add(f.Path)) continue;
                var rel = Path.GetRelativePath(baseDir, Path.GetDirectoryName(f.Path) ?? baseDir);
                items.Add(new { path = f.Path, kind = f.Kind, title = f.Title, folder = f.Folder, workshopId = f.WorkshopId,
                    inLibrary = f.InLibrary, subscription = f.Subscription, preset = f.Preset, baseWorkshopId = f.BaseId, dir = rel == "." ? "" : rel });
            }
        }
        // a folder already watched: the dialog offers no second watch of it
        var watched = s.WatchedFolders.Select(w => Norm(w.Path)).ToHashSet();
        return new { roots, folders = roots.Where(Directory.Exists).ToList(), items, unreadable, unsupported, duplicates, truncated, scenesOff = !s.AllowScenes,
            autoImport = s.AutoAddWeWallpapersToLibrary, watched = roots.Where(watched.Contains).ToList(), copy = s.CopyFilesInsteadOfSymlinking };
    }

    // POST /library/import-found {paths, copy, watch?, skip?, roots?}: imports the ticked paths in the background (each
    // identified again: the dialog's list may be minutes old). `watch` = the scanned folder, from now on watched (link or copy:
    // `copy`), `skip` = what the user left unticked there, which the watch never imports. The folder joins the list once the
    // ticked items are in (its first pass then finds them there: nothing is imported twice). `roots` = the folders the dialog
    // scanned: a ticked preset's base scene is looked for there (only a root holding a ticked path). The dialog sends what
    // the user left unticked as `skip` whether or not it watches, and a preset never brings one of those as its base: the
    // user's untick wins, the preset then needs its base scene. Returns how many it queued.
    public static object ImportFound(ImportFoundReq r)
    {
        var paths = (r.Paths ?? []).Select(Norm).OfType<string>().Distinct().ToList();
        string? watch = Norm(r.Watch);
        if (watch != null && !Directory.Exists(watch)) watch = null;
        var skip = watch == null ? [] : (r.Skip ?? []).Select(Norm).OfType<string>().Where(x => x.StartsWith(watch + "/", StringComparison.Ordinal)).Distinct().ToList();
        var roots = (r.Roots ?? []).Select(Norm).OfType<string>()
            .Where(x => paths.Any(p => p == x || p.StartsWith(x.TrimEnd('/') + "/", StringComparison.Ordinal))).Distinct().ToList();
        if (paths.Count == 0) { if (watch != null) SetWatched(watch, r.Copy, skip); return new { queued = 0 }; }
        Interlocked.Add(ref _queued, paths.Count);
        LibraryOps.Set("import", "import", _done, _queued);
        _ = Task.Run(async () =>
        {
            await _gate.WaitAsync();
            try
            {
                var known = FolderScanner.Known.Load();
                // what the library has meanwhile stays out (the dialog shows it disabled; a second dialog may have imported it),
                // and so does a Steam subscription (FolderScanner: the WE auto-import's alone)
                var found = paths.Select(p => FolderScanner.Identify(p, known)).ToList();
                var take = found.Where(f => f is { InLibrary: false, Subscription: false }).Cast<FolderScanner.Found>().ToList();
                if (found.Count > take.Count) Step(found.Count - take.Count);
                // the scanned folders' Wallpaper Engine items by Workshop id, scanned only once a preset asks for its base
                Dictionary<string, string>? tree = null;
                var skipped = (r.Skip ?? []).Select(Norm).OfType<string>().ToHashSet(StringComparer.Ordinal);
                string? BaseIn(string id)
                {
                    tree ??= TreeOf(roots, known);
                    return tree.TryGetValue(id, out var d) && !skipped.Contains(d) ? d : null;
                }
                await ImportAsync(take, link: !r.Copy,
                    f => watch != null && f.Path.StartsWith(watch + "/", StringComparison.Ordinal) ? watch : null, "import", BaseIn);
            }
            catch (Exception e) { Console.WriteLine($"import: failed: {e.Message}"); }
            finally
            {
                if (watch != null) try { SetWatched(watch, r.Copy, skip); } catch (Exception e) { Console.WriteLine($"watch: {watch}: {e.Message}"); }
                _gate.Release(); EndIfIdle();
            }
        });
        return new { queued = paths.Count };
    }

    private static void Step(int n) { var d = Interlocked.Add(ref _done, n); LibraryOps.Set("import", "import", d, _queued); }
    private static void EndIfIdle()
    {
        if (Volatile.Read(ref _done) < Volatile.Read(ref _queued)) return;
        Interlocked.Exchange(ref _queued, 0); Interlocked.Exchange(ref _done, 0);
        LibraryOps.End("import");
    }

    // Imports each found item (call under the gate); `watchedFrom` marks an item a watch brought in, `baseIn` finds a preset's
    // base in the folder tree it came from (BringBasesAsync). The library page hears `library-synced` as items land (at most
    // once a second) and once at the end; then every background pass an import kicks.
    private static async Task<List<LibraryItem>> ImportAsync(List<FolderScanner.Found> found, bool link, Func<FolderScanner.Found, string?> watchedFrom,
        string why, Func<string, string?> baseIn, DateTime? settledBefore = null)
    {
        var added = new List<LibraryItem>();
        var shown = DateTime.UtcNow;
        foreach (var f in found)
        {
            try
            {
                if (await ImportOneAsync(f, link, watchedFrom(f)) is { } item) added.Add(item);
            }
            catch (Exception e) { Console.WriteLine($"import: {f.Path}: {e.Message}"); }
            Step(1);
            if (DateTime.UtcNow - shown > TimeSpan.FromSeconds(1)) { shown = DateTime.UtcNow; EventBus.Broadcast("library-synced", new { count = added.Count }); }
        }
        await BringBasesAsync(added, link, watchedFrom, baseIn, settledBefore);
        AfterImport(added, why);
        return added;
    }

    // A preset can't play without its base scene, so each preset this import added brings its base from the same folder tree
    // (`baseIn`: its folder there by Workshop id) the way this import brings items: linked or copied, a watched folder's mark,
    // never a Steam subscription, never a file a watch still sees being written (`settledBefore`: its next pass brings it),
    // never while "Play scenes" is off (a scene the user can't play doesn't land only because a preset named it; the dialog
    // can't tick a preset then, a watch waits). The one helper every local way a preset arrives shares
    // (PresetDownloads.AddBaseFromAsync) reuses a base the library has and never adds one that isn't a scene (the preset
    // says what it is). Runs after the whole batch, so a base ticked or found beside its preset is imported once.
    // Guard: scripts/test-folder-import.sh § presets
    private static async Task BringBasesAsync(List<LibraryItem> added, bool link, Func<FolderScanner.Found, string?> watchedFrom,
        Func<string, string?> baseIn, DateTime? settledBefore)
    {
        foreach (var preset in added.Where(i => i.IsScene && Presets.Read(i.VideoPath) != null).ToList())
            await PresetDownloads.AddBaseFromAsync(preset, "its imported folder", baseIn, async dir =>
            {
                if (!SettingsService.Load().AllowScenes) { Console.WriteLine($"import: {dir}: a preset's base scene, not imported while Play scenes is off"); return; }
                if (FolderScanner.Identify(dir, FolderScanner.Known.Load()) is not { Subscription: false } f) return;
                if (settledBefore is { } c && f.Mtime > c) return;
                if (await ImportOneAsync(f, link, watchedFrom(f)) is { } b) added.Add(b);
            });
    }

    // every Wallpaper Engine item folder under these folders by Workshop id (the first seen), Steam's own folders left out
    private static Dictionary<string, string> TreeOf(List<string> roots, FolderScanner.Known known)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var root in roots)
            foreach (var (id, dir) in FolderScanner.Scan(root, known).WeFolders)
                if (!known.InSteam(dir)) map.TryAdd(id, dir);
        return map;
    }

    private static Task<LibraryItem?> ImportOneAsync(FolderScanner.Found f, bool link, string? watchedFrom)
    {
        void Mark(LibMeta m) { if (watchedFrom != null) { m.WatchedFrom = watchedFrom; m.SourceSig = f.Sig; } }
        return f.Folder ? ImportService.ImportFolderAsync(f, link, Mark) : ImportService.ImportAsync(f.Path, f.Title, link, Mark);
    }

    // What every import kicks: the page re-reads the library, scenes get a loudness estimate, Steam's facts and frame sizes,
    // the cards' previews; with "Add new wallpapers to the playlist" on, the new items join it (Program.AddToPlaylist).
    private static void AfterImport(List<LibraryItem> added, string why)
    {
        EventBus.Broadcast("library-synced", new { count = added.Count });
        if (added.Count == 0) return;
        Program.AddToPlaylist(added.Select(i => i.VideoPath).ToList(), live: true);
        if (added.Any(i => i.IsScene)) SceneLoudnessOps.AfterImport(why);
        LibraryFactsOps.Kick(why);
        PreviewBackfill.Kick(why);
    }

    // ---- watched folders ----

    // POST /library/watched {path, copy?, remove?}: add a folder (or change its link / copy choice), or stop watching it.
    // Stopping leaves every item it brought in where it is (they are the user's library now).
    public static object? EditWatched(WatchedReq r)
    {
        if (Norm(r.Path) is not { } p) return null;
        if (r.Remove)
        {
            SettingsService.Update(s => s.WatchedFolders = s.WatchedFolders.Where(w => Norm(w.Path) != p).ToList());
            Broadcast();
            FolderWatch.Reconcile();
            return new { ok = true };
        }
        if (!Directory.Exists(p)) return null;
        SetWatched(p, r.Copy, null);
        FolderWatch.Kick(p, 0); // an edit of a listed folder looks at it again too
        return new { ok = true };
    }

    private static void SetWatched(string p, bool? copy, List<string>? skip)
    {
        SettingsService.Update(s =>
        {
            var w = s.WatchedFolders.FirstOrDefault(x => Norm(x.Path) == p);
            if (w == null) s.WatchedFolders = [.. s.WatchedFolders, w = new WatchedFolder { Path = p, Copy = copy ?? s.CopyFilesInsteadOfSymlinking }];
            else if (copy is bool c) w.Copy = c;
            if (skip != null) w.Skip = skip;
        });
        Broadcast();
        FolderWatch.Reconcile();
    }

    private static void Broadcast() =>
        EventBus.Broadcast("settings-changed", new { watchedFolders = SettingsService.Load().WatchedFolders.Select(w => new { path = w.Path, copy = w.Copy, skip = w.Skip }) });

    // The library's items a user deletes or trashes: a watched folder never brings them back (their sources join its Skip).
    public static void Forget(IEnumerable<LibraryItem> items)
    {
        var bySource = new List<(string Root, string Src)>();
        foreach (var i in items)
            if (LibraryStore.GetMeta(i.VideoPath) is { WatchedFrom: { } root } m && FolderScanner.SourceOf(m) is { } src) bySource.Add((root, src));
        if (bySource.Count == 0) return;
        SettingsService.Update(s =>
        {
            foreach (var w in s.WatchedFolders)
                foreach (var (root, src) in bySource)
                    if (Norm(w.Path) == root && !w.Skip.Contains(src)) w.Skip = [.. w.Skip, src];
        });
        Broadcast();
    }

    // One watched folder's pass (Web/FolderWatch.cs): import what's new, import again what changed, and let go of what's gone.
    // Returns true when a file was still being written (its write time younger than `stable`): the caller looks again later.
    //   - new: imported (the folder's link / copy choice), never one in its Skip, never one the library has under another
    //     source (the same Workshop id), never a Steam subscription (FolderScanner: the WE auto-import's alone), never a scene while "Play scenes" is off (the next pass takes it once it's on).
    //   - changed (its Sig): imported again in the form it has; a video's loudness is measured again.
    //   - gone: only an item this folder brought in (LibMeta.WatchedFrom). A link leaves the library (unlinked: AppOps.Trash
    //     without an undo, so the playlist and a playing wallpaper follow, like a delete); a copy stays as the user's own and
    //     is no longer the folder's. Nothing is let go while the folder is missing or reads as empty (an unmounted drive's
    //     mount point), or when the source sits under a folder the scan couldn't read. The user's files are never touched.
    // Guard: scripts/test-folder-import.sh § watch
    public static async Task<bool> WatchPassAsync(string root, TimeSpan stable)
    {
        await _gate.WaitAsync();
        try { return await WatchPassLockedAsync(root, stable); }
        finally { _gate.Release(); }
    }

    private static async Task<bool> WatchPassLockedAsync(string root, TimeSpan stable)
    {
        var s = SettingsService.Load();
        var w = s.WatchedFolders.FirstOrDefault(x => Norm(x.Path) == root);
        if (w == null) return false;
        if (!Directory.Exists(root)) { Console.WriteLine($"watch: {root}: not there (offline?), nothing changes"); return false; }
        var known = FolderScanner.Known.Load();
        var scan = FolderScanner.Scan(root, known);
        var idx = LibraryStore.LoadIndex(LibraryStore.Imported);
        var bySrc = new Dictionary<string, (string Key, LibMeta Meta)>(StringComparer.Ordinal);
        foreach (var (k, m) in idx) if (FolderScanner.SourceOf(m) is { } src) bySrc.TryAdd(src, (k, m));
        var skip = w.Skip.ToHashSet(StringComparer.Ordinal);
        var cutoff = DateTime.UtcNow - stable;
        bool unsettled = false;
        var fresh = new List<FolderScanner.Found>();
        var again = new List<(FolderScanner.Found F, string Key)>();
        var adopt = new List<(string Key, string Sig)>();
        foreach (var f in scan.Items)
        {
            if (bySrc.TryGetValue(f.Path, out var have))
            {
                if (have.Meta.WatchedFrom != root) { if (have.Meta.WatchedFrom == null) adopt.Add((have.Key, f.Sig)); continue; }
                if (have.Meta.SourceSig == f.Sig) continue;
                if (f.Mtime > cutoff) { unsettled = true; continue; }
                again.Add((f, have.Key));
                continue;
            }
            if (skip.Contains(f.Path) || f.InLibrary || f.Subscription || (f.Kind == "scene" && !s.AllowScenes)) continue;
            if (f.Mtime > cutoff) { unsettled = true; continue; }
            fresh.Add(f);
        }
        bool changed = false;
        // an item imported once from inside this folder becomes the folder's (its Sig as it is now: nothing is redone)
        if (adopt.Count > 0)
        {
            LibraryStore.UpdateIndex(LibraryStore.Imported, i =>
            {
                foreach (var (k, sig) in adopt) if (i.TryGetValue(k, out var m) && m.WatchedFrom == null) { m.WatchedFrom = root; m.SourceSig = sig; }
                return true;
            });
        }
        if (fresh.Count > 0)
        {
            Console.WriteLine($"watch: {root}: {fresh.Count} new");
            Interlocked.Add(ref _queued, fresh.Count);
            // a preset's base from this folder, unless the user deleted it here (its Skip)
            string? BaseIn(string id) => scan.WeFolders.TryGetValue(id, out var d) && !skip.Contains(d) && !known.InSteam(d) ? d : null;
            try { await ImportAsync(fresh, link: !w.Copy, _ => root, "watch", BaseIn, cutoff); }
            finally { EndIfIdle(); }
        }
        foreach (var (f, key) in again)
        {
            Console.WriteLine($"watch: {root}: changed: {f.Path}");
            try
            {
                await ImportOneAsync(f, link: !w.Copy, root);
                // a video's loudness is the old file's: measured again (LibraryService.BackfillLoudnessAsync)
                LibraryStore.UpdateIndex(LibraryStore.Imported, i =>
                {
                    if (!i.TryGetValue(key, out var m)) return false;
                    m.LoudnessI = m.LoudnessTP = m.LoudnessLRA = m.LoudnessThresh = null; m.LoudnessSkip = null;
                    return true;
                });
                changed = true;
            }
            catch (Exception e) { Console.WriteLine($"watch: {f.Path}: {e.Message}"); }
        }
        if (again.Count > 0) { LibraryFactsOps.Kick("watch"); PreviewBackfill.Kick("watch"); if (s.NormalizeAudio) LibraryService.KickLoudnessBackfill(force: false); }
        // gone
        var present = scan.Items.Select(f => f.Path).ToHashSet(StringComparer.Ordinal);
        var mine = bySrc.Where(kv => kv.Value.Meta.WatchedFrom == root && !present.Contains(kv.Key)).ToList();
        if (mine.Count > 0 && scan.Items.Count == 0)
            Console.WriteLine($"watch: {root}: reads as empty, keeps its {mine.Count} item(s) (an unmounted drive?)");
        else if (mine.Count > 0)
        {
            var links = new List<LibraryItem>();
            var released = new List<string>();
            var bar = PlaylistService.LoadCurrentState()?.VideoPaths ?? [];
            foreach (var (src, (key, meta)) in mine)
            {
                if (File.Exists(src) || Directory.Exists(src)) continue;   // there, but no longer an item (a Skip, a type)
                if (scan.Unreadable.Any(u => src.StartsWith(u + "/", StringComparison.Ordinal))) continue;
                var itemDir = Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key);
                if (LinkedMedia(itemDir, key, meta, bar) is { } media) links.Add(new LibraryItem { Title = meta.Title ?? key, VideoPath = media, IsScene = meta.IsScene });
                else released.Add(key);
            }
            if (released.Count > 0)
                LibraryStore.UpdateIndex(LibraryStore.Imported, i =>
                {
                    foreach (var k in released) if (i.TryGetValue(k, out var m)) { m.WatchedFrom = null; m.SourceSig = null; }
                    return true;
                });
            if (links.Count > 0) AppOps.Trash(links, undoable: false);
            if (links.Count + released.Count > 0)
            {
                Console.WriteLine($"watch: {root}: gone: {links.Count} link(s) left the library, {released.Count} copy(ies) kept");
                changed = true;
            }
        }
        if (changed) EventBus.Broadcast("library-synced", new { count = 0 });
        return unsettled;
    }

    // The play path of an imported item that only links to its source (the item folder is a link to a Wallpaper Engine folder,
    // or its media file is a link), as the library and the playlist name it; null = the library's own copy. Its source is gone,
    // so the media can't be read: a scene is its folder, a video the playlist's path under the folder, else the link itself.
    private static string? LinkedMedia(string itemDir, string key, LibMeta meta, List<string> bar)
    {
        bool linkDir = LibraryService.IsSymlink(itemDir);
        string? linkFile = null;
        if (!linkDir)
        {
            try { linkFile = Directory.GetFiles(itemDir, key + ".*").FirstOrDefault(f => LibraryService.IsSymlink(f) && Path.GetExtension(f) != ".jpg"); }
            catch { }
            if (linkFile == null) return null;
        }
        if (meta.IsScene) return itemDir;
        return bar.FirstOrDefault(p => p.StartsWith(itemDir + "/", StringComparison.Ordinal)) ?? linkFile ?? Path.Combine(itemDir, key);
    }
}
