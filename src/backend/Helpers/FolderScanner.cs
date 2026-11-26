using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

// What a folder holds that the library can take, for both a one-off import (Web/FolderImportOps.cs: the preview dialog) and a
// watched folder (Web/FolderWatch.cs): ONE scanner, so both find the same items.
//   - a folder with a project.json is one Wallpaper Engine item (a scene, a preset, or a video whose file is there); nothing
//     inside it is looked at again. Other WE types (web, application) are counted as unsupported. A preset (Presets.Read) is
//     a scene item of its own that plays its base scene; the import looks for the base in the same tree by Workshop id, so
//     every WE item folder's id is kept (Result.WeFolders), an unsupported one's too: a base that isn't a scene is named.
//   - a loose video / gif / picture is one wallpaper.
//   - every other folder is scanned the same way, so a backed-up Workshop folder (one folder per item) gives every item.
// Never written to: the scan only lists and reads project.json. Folder links are followed, each real folder once (a link loop or
// a second way into the same folder adds nothing); dot-entries, Windows' system folders and the library itself are skipped; a
// folder that can't be read is reported, never an error. Guard: scripts/test-folder-import.sh § scan
// An item whose real path is inside one of Steam's own Workshop folders (any Steam library's workshop/content/431960, the WE
// folder setting) is a subscription: Steam deletes its files on an unsubscribe, so a link to it would dangle and a library
// item would lose its files behind the app's back. The scan lists it as Subscription and nothing imports it (the dialog, a
// watched folder, /library/import-found): the WE auto-import is the one way a subscription enters the library (local/<id>).
// Guard: scripts/test-folder-import.sh § steam
public static class FolderScanner
{
    // the containers ImportService stores under their own name (LibraryService.ImportedMediaExts) plus .m4v (stored as .mp4)
    public static readonly string[] VideoExts = [.. LibraryService.ImportedMediaExts.Where(e => e != ".gif"), ".m4v"];
    public static readonly string[] ImageExts = [.. ImportService.ImageExtensions];
    private static readonly string[] SkipDirs = ["$RECYCLE.BIN", "System Volume Information", "lost+found"];
    private const int MaxDepth = 40;
    // a scan stops listing after this many entries (the dialog says it was cut short): a whole disk picked by mistake
    public const int MaxEntries = 200_000;

    // Kind: video | gif | image | scene. Folder = a Wallpaper Engine item folder (Path is the folder). Sig = what a change of
    // its files changes (size + newest write time), Mtime its newest write (a watched folder waits until it settles).
    // InLibrary: the library has it already (the same source imported before, or the same Workshop id). Subscription: it is in
    // Steam's own Workshop folder (never imported). Preset: a Wallpaper Engine preset (Kind scene), BaseId its base's id.
    public sealed record Found(string Path, string Kind, string Title, bool Folder, string? WorkshopId, string Sig, DateTime Mtime, bool InLibrary,
        bool Subscription = false, bool Preset = false, string? BaseId = null);

    public sealed class Result
    {
        public string Root { get; init; } = "";
        public List<Found> Items { get; } = [];
        public List<string> Unreadable { get; } = [];
        public int Unsupported { get; set; }   // WE items the app can't play (web, application)
        public int Duplicates { get; set; }    // the same Workshop id twice in the folder: one is listed
        public bool Truncated { get; set; }
        // every Wallpaper Engine item folder with a Workshop id → its path (the first seen), unsupported ones too
        public Dictionary<string, string> WeFolders { get; } = new(StringComparer.Ordinal);
    }

    // What the library already has: Workshop ids (local/, workshop/, any entry's workshopId) and the sources imported before.
    public sealed class Known
    {
        public HashSet<string> WorkshopIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Sources { get; } = new(StringComparer.Ordinal);
        // Steam's Workshop folders as real paths (WorkshopDownloader.SteamWorkshopRoots: the WE folder setting, standard /
        // Flatpak / snap Steam, every libraryfolders.vdf library), those that exist
        public List<string> SteamRoots { get; } = [];
        public static Known Load()
        {
            var k = new Known();
            foreach (var root in WorkshopDownloader.SteamWorkshopRoots(SettingsService.Load().WorkshopFolder))
                if (Liascape.Web.ApiSecurity.RealPath(root) is { } real && !k.SteamRoots.Contains(real)) k.SteamRoots.Add(real);
            foreach (var src in LibraryStore.Sources)
            {
                if (src is LibraryStore.Local or LibraryStore.Workshop)
                    try { foreach (var d in Directory.GetDirectories(LibraryStore.SourceDir(src))) k.WorkshopIds.Add(System.IO.Path.GetFileName(d)); } catch { }
                foreach (var m in LibraryStore.LoadIndex(src).Values)
                {
                    if (m.WorkshopId is { Length: > 0 } w) k.WorkshopIds.Add(w);
                    if (SourceOf(m) is { } p) k.Sources.Add(p);
                }
            }
            return k;
        }
        public bool Has(string path, string? workshopId) =>
            Sources.Contains(path) || (Liascape.Web.ApiSecurity.RealPath(path) is { } r && Sources.Contains(r))
            || (workshopId != null && WorkshopIds.Contains(workshopId));
        // inside one of Steam's Workshop folders, by real path (a link or a mount into it counts as it)
        public bool InSteam(string path) =>
            SteamRoots.Count > 0 && (Liascape.Web.ApiSecurity.RealPath(path) ?? path) is var r
            && SteamRoots.Any(s => r.StartsWith(s + "/", StringComparison.Ordinal));
    }

    // an imported item's source path (LibMeta.SourceUrl "import:<path>", ImportService's dedupe key)
    public const string ImportPrefix = "import:";
    public static string? SourceOf(LibMeta m) =>
        m.SourceUrl is { } u && u.StartsWith(ImportPrefix, StringComparison.Ordinal) ? u[ImportPrefix.Length..] : null;

    public static Result Scan(string root, Known? known = null)
    {
        root = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(root));
        var r = new Result { Root = root };
        known ??= Known.Load();
        if (File.Exists(root)) { if (Identify(root, known) is { } one) r.Items.Add(one); return r; }
        if (!Directory.Exists(root)) return r;
        var libReal = Liascape.Web.ApiSecurity.RealPath(LibraryStore.Root) ?? LibraryStore.Root;
        var seenDirs = new HashSet<string>(StringComparer.Ordinal);
        var seenFiles = new HashSet<string>(StringComparer.Ordinal);
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        int entries = 0;
        var stack = new Stack<(string Dir, int Depth)>();
        stack.Push((root, 0));
        while (stack.Count > 0)
        {
            var (dir, depth) = stack.Pop();
            var real = Liascape.Web.ApiSecurity.RealPath(dir) ?? dir;
            if (!seenDirs.Add(real)) continue;                                  // a link loop, or a second way in
            if (real == libReal || real.StartsWith(libReal + "/", StringComparison.Ordinal)) continue;
            List<FileSystemInfo> list;
            try { list = new DirectoryInfo(dir).EnumerateFileSystemInfos().ToList(); }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException or System.Security.SecurityException)
            { r.Unreadable.Add(dir); continue; }
            if (list.Any(x => x.Name == "project.json" && x is FileInfo))
            {
                var we = IdentifyFolder(dir, known);
                if ((we != null ? we.WorkshopId : IdOf(dir, ReadProject(dir).Wid)) is { } wid) r.WeFolders.TryAdd(wid, dir);
                if (we == null) r.Unsupported++;
                else if (we.WorkshopId != null && !seenIds.Add(we.WorkshopId)) r.Duplicates++;
                else r.Items.Add(we);
                continue;
            }
            // folders in name order (the stack pops them in reverse), a linked folder after every real one beside it: a folder
            // reached both ways is listed under its own path
            foreach (var x in list.OrderBy(x => x.LinkTarget == null ? 1 : 0).ThenByDescending(x => x.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (++entries > MaxEntries) { r.Truncated = true; stack.Clear(); break; }
                if (x.Name.StartsWith('.')) continue;
                bool isDir = x is DirectoryInfo || Directory.Exists(x.FullName);   // a link to a folder lists as a file
                if (isDir)
                {
                    if (depth < MaxDepth && !SkipDirs.Contains(x.Name, StringComparer.OrdinalIgnoreCase)) stack.Push((x.FullName, depth + 1));
                    continue;
                }
                if (KindOf(x.FullName) == null || !File.Exists(x.FullName)) continue;   // a dangling link, a FIFO named .mp4
                var fr = Liascape.Web.ApiSecurity.RealPath(x.FullName) ?? x.FullName;
                if (!seenFiles.Add(fr)) continue;
                if (Identify(x.FullName, known) is { } f) r.Items.Add(f);
            }
        }
        r.Items.Sort((a, b) => string.Compare(a.Path, b.Path, StringComparison.OrdinalIgnoreCase));
        return r;
    }

    // a loose file's kind by its name, else null
    public static string? KindOf(string path)
    {
        var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
        return ext == ".gif" ? "gif" : VideoExts.Contains(ext) ? "video" : ImageExts.Contains(ext) ? "image" : null;
    }

    // One path the dialog (or the watcher) names: a loose media file, or a Wallpaper Engine item folder; else null.
    public static Found? Identify(string path, Known known)
    {
        if (Directory.Exists(path)) return File.Exists(System.IO.Path.Combine(path, "project.json")) ? IdentifyFolder(path, known) : null;
        if (KindOf(path) is not { } kind || !File.Exists(path)) return null;
        try
        {
            var fi = new FileInfo(path);
            if (fi.LinkTarget != null) fi = (FileInfo)(fi.ResolveLinkTarget(true) ?? fi);
            var title = System.IO.Path.GetFileNameWithoutExtension(path);
            return new Found(path, kind, title, false, null, $"{fi.Length}:{fi.LastWriteTimeUtc.Ticks}", fi.LastWriteTimeUtc, known.Has(path, null), known.InSteam(path));
        }
        catch { return null; }
    }

    // A Wallpaper Engine item folder: a scene (project.json type "scene", or none with a scene.pkg), a preset (Presets.Read: no
    // type and a `preset` object; a scene item that plays its base), or a video whose file is in the folder. null = a type the
    // app can't play (web, application), or a video whose file is missing.
    private static Found? IdentifyFolder(string dir, Known known)
    {
        var (type, file, title, wid) = ReadProject(dir);
        var preset = Presets.Read(dir);
        bool pkg = File.Exists(System.IO.Path.Combine(dir, "scene.pkg"));
        bool scene = preset != null || string.Equals(type, "scene", StringComparison.OrdinalIgnoreCase) || (type == null && pkg);
        bool video = string.Equals(type, "video", StringComparison.OrdinalIgnoreCase) && file is { Length: > 0 }
            && !file.Contains("..") && File.Exists(System.IO.Path.Combine(dir, file));
        if (!scene && !video) return null;
        var name = System.IO.Path.GetFileName(Liascape.Web.ApiSecurity.RealPath(dir) ?? dir);
        wid = IdOf(dir, wid);
        long size = 0; DateTime newest = DateTime.MinValue;
        try
        {
            foreach (var f in new DirectoryInfo(dir).EnumerateFiles())
            {
                size += f.Length;
                if (f.LastWriteTimeUtc > newest) newest = f.LastWriteTimeUtc;
            }
        }
        catch { }
        var t = LibraryService.SanitizeName(title ?? "") is { Length: > 0 } st ? st : name;
        return new Found(dir, scene ? "scene" : "video", t, true, wid, $"{size}:{newest.Ticks}", newest, known.Has(dir, wid), known.InSteam(dir),
            preset != null, preset?.BaseId);
    }

    // project.json's type, file, title and workshopid (each null when missing or unreadable)
    private static (string? Type, string? File, string? Title, string? Wid) ReadProject(string dir)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(dir, "project.json")));
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object) return (Str(root, "type"), Str(root, "file"), Str(root, "title"), Str(root, "workshopid"));
        }
        catch { }
        return (null, null, null, null);
    }

    // a Workshop item's id: project.json's, else the (real) folder's name when it is one (Steam names each item's folder so)
    private static string? IdOf(string dir, string? wid)
    {
        if (wid is { Length: > 0 } && wid.All(char.IsAsciiDigit)) return wid;
        var name = System.IO.Path.GetFileName(Liascape.Web.ApiSecurity.RealPath(dir) ?? dir);
        return name.Length >= 6 && name.All(char.IsAsciiDigit) ? name : null;
    }

    private static string? Str(JsonElement o, string k) => o.TryGetProperty(k, out var v)
        ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.ValueKind == JsonValueKind.Number ? v.GetRawText() : null : null;
}
