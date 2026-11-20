using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Liascape.Helpers;

// A Wallpaper Engine preset's project.json: the base scene's Workshop id (`dependency`; null = missing or not a Workshop
// id) and its property values (`preset`, WE's own settings keys included; SceneProperties keeps only what the base defines).
public sealed record PresetFile(string? BaseId, IReadOnlyDictionary<string, JsonElement> Values);

public enum PresetProblem { None, NoBase, BaseNotScene, NeedsBase, Legacy }

// BaseDir = the base item's folder when one was found; Reason = why the preset can't play now (null = it plays).
public readonly record struct PresetStatus(PresetProblem Problem, string? BaseDir, string? Reason);

// Presets in the library (.claude/rules/backend/library.md § Presets). A preset is its own item, keyed by its own folder;
// it plays its base scene's folder with its values layered on.
//
// The base is found by Workshop id at every ask, never by a path saved with the preset: a base item's path is its
// identity and the form behind it changes (a `local/<id>` link becomes the library's own copy at that path and Steam's
// folder goes, a re-subscription swaps the copy back for a link, a download lands under `workshop/<id>`, an imported
// folder carries the id in its index entry). A path or a link target held on to would point at nothing after any of
// those. Guard: scripts/test-presets.sh § 1 base forms
public static class Presets
{
    public const string NeedsBaseReason = "Needs its base scene";
    public const string NoBaseReason = "Its preset file names no base scene";
    public const string LegacyReason = "Presets play only in the Liascape player";
    public static string NotSceneReason(string kind) => $"Its base is a {kind.ToLowerInvariant()} wallpaper, not a scene";

    // project.json path → the file state it was read at (mtime ticks, size) and what it said (null = not a preset)
    private static readonly ConcurrentDictionary<string, (long Ticks, long Size, PresetFile? File)> _cache = new();

    // The item folder's preset file, or null when it isn't one (a scene, a video, no or unreadable project.json). Wallpaper
    // Engine writes a preset with NO `type` key and a `preset` object; `dependency` names the base (a digit string). A
    // preset whose `dependency` is missing or not a Workshop id is still a preset (greyed with NoBaseReason), never a scene.
    // Cached by project.json's mtime + size: every library read asks for every scene folder. Never throws.
    public static PresetFile? Read(string itemDir)
    {
        var pj = Path.Combine(itemDir, "project.json");
        long ticks, size;
        try
        {
            var fi = new FileInfo(pj);
            if (!fi.Exists) return null;
            ticks = fi.LastWriteTimeUtc.Ticks; size = fi.Length;
        }
        catch { return null; }
        if (_cache.TryGetValue(pj, out var hit) && hit.Ticks == ticks && hit.Size == size) return hit.File;
        PresetFile? file = null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(pj));
            var r = doc.RootElement;
            if (r.ValueKind == JsonValueKind.Object && !r.TryGetProperty("type", out _)
                && r.TryGetProperty("preset", out var p) && p.ValueKind == JsonValueKind.Object)
            {
                string? baseId = r.TryGetProperty("dependency", out var dep) && dep.ValueKind == JsonValueKind.String
                    && dep.GetString() is { Length: > 0 } s && s.All(char.IsAsciiDigit) ? s : null;
                var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var kv in p.EnumerateObject()) values[kv.Name] = kv.Value.Clone();
                file = new PresetFile(baseId, values);
            }
        }
        catch { }
        _cache[pj] = (ticks, size, file);
        return file;
    }

    // The library item folder of the base with this Workshop id: `local/<id>` (Steam's folder, or the library's own copy
    // there), else `workshop/<id>` (a download), else an `imported/` entry whose index WorkshopId is the id. No cache: the
    // base comes and goes (trash, Undo, a download landing, Steam deleting its folder).
    public static string? BaseDirOf(string baseId) => BaseDirOf(baseId, LibraryStore.LoadIndex);

    internal static string? BaseDirOf(string baseId, Func<string, Dictionary<string, LibMeta>> indexOf)
    {
        if (baseId.Length == 0 || !baseId.All(char.IsAsciiDigit)) return null;
        foreach (var src in new[] { LibraryStore.Local, LibraryStore.Workshop })
        {
            var d = Path.Combine(LibraryStore.SourceDir(src), baseId);
            if (Directory.Exists(d)) return d;
        }
        foreach (var (key, m) in indexOf(LibraryStore.Imported))
            if (m.WorkshopId == baseId && Directory.Exists(Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key)))
                return Path.Combine(LibraryStore.SourceDir(LibraryStore.Imported), key);
        return null;
    }

    // What kind of wallpaper a base folder holds: "preset", project.json's `type` lowercased (scene, video, web,
    // application), "scene" for a bare scene.pkg; null = can't tell yet (no project.json: not whole) — treated as missing.
    internal static string? KindOf(string dir)
    {
        if (Read(dir) != null) return "preset";
        try
        {
            var pj = Path.Combine(dir, "project.json");
            if (File.Exists(pj))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                if (doc.RootElement.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String
                    && t.GetString() is { Length: > 0 } type)
                    return type.ToLowerInvariant();
            }
        }
        catch { }
        return File.Exists(Path.Combine(dir, "scene.pkg")) ? "scene" : null;
    }

    // Can the preset at this item folder play, and from which base folder? Reads its index entry fresh (its own Workshop
    // id, the base's kind a download saved). Not a preset → None with no base: nothing stops it here.
    public static PresetStatus StatusOf(string presetDir, bool liascapePlayer)
    {
        if (Read(presetDir) is not { } f) return new(PresetProblem.None, null, null);
        LibMeta? m = null; string? selfId = null;
        if (LibraryStore.Locate(presetDir) is { } loc)
        {
            m = LibraryStore.LoadIndex(loc.Source).GetValueOrDefault(loc.Key);
            selfId = m?.WorkshopId ?? (loc.Source is LibraryStore.Workshop or LibraryStore.Local ? loc.Key : null);
        }
        return StatusFor(f, selfId, m?.BaseKind, BaseDirOf, KindOf, liascapePlayer);
    }

    // The rule (pure; the self-test's table). The first problem wins: no base named (no id, or its own id: never resolved
    // through itself) → a base the download found isn't a scene (LibMeta.BaseKind) → the base isn't in the library (or
    // isn't whole) → the base folder isn't a scene (a preset: never resolved recursively; a video) → the legacy engine.
    internal static PresetStatus StatusFor(PresetFile f, string? selfId, string? baseKind, Func<string, string?> baseDirOf,
        Func<string, string?> kindOfDir, bool liascapePlayer)
    {
        if (f.BaseId is not { } id || id == selfId) return new(PresetProblem.NoBase, null, NoBaseReason);
        if (baseKind is { Length: > 0 } bk && !bk.Equals("scene", StringComparison.OrdinalIgnoreCase))
            return new(PresetProblem.BaseNotScene, null, NotSceneReason(bk));
        var dir = baseDirOf(id);
        var kind = dir == null ? null : kindOfDir(dir);
        if (dir == null || kind == null) return new(PresetProblem.NeedsBase, null, NeedsBaseReason);
        if (kind != "scene") return new(PresetProblem.BaseNotScene, dir, NotSceneReason(kind));
        if (!liascapePlayer) return new(PresetProblem.Legacy, dir, LegacyReason);
        return new(PresetProblem.None, dir, null);
    }

    // The folder the player loads for an item: a scene's own; a preset's base's when the preset could play (whatever the
    // engine); else null (a video, or a preset that can't play).
    public static string? LoadDirOf(string itemPath)
    {
        if (Read(itemPath) != null)
            return StatusOf(itemPath, liascapePlayer: true) is { Problem: PresetProblem.None, BaseDir: { } d } ? d : null;
        return Directory.Exists(itemPath) ? itemPath : null;
    }

    // The library's presets of the base with this Workshop id (their item folders = their play paths).
    public static List<string> PresetPathsOf(string baseWorkshopId)
    {
        var paths = new List<string>();
        if (baseWorkshopId.Length == 0) return paths;
        foreach (var src in new[] { LibraryStore.Local, LibraryStore.Workshop, LibraryStore.Imported })
        {
            string[] dirs;
            try { dirs = Directory.GetDirectories(LibraryStore.SourceDir(src)); } catch { continue; }
            foreach (var d in dirs)
                if (Read(d) is { BaseId: { } b } && b == baseWorkshopId && Path.GetFileName(d) != baseWorkshopId) paths.Add(d);
        }
        return paths;
    }
}
