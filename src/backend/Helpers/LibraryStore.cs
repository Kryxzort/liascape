using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Liascape.Helpers;

// One JSON index per source folder under the library, holding each item's metadata, per-item
// volume/speed overrides, and dedup keys. Keyed by the item's folder name (<id> for workshop/local,
// <name> for web/imported). null Volume/Speed = "use global" (the key is simply absent when
// serialized → WhenWritingNull). Layout: library/<source>/<key>/<media>.
public sealed class LibMeta
{
    public string? SourceUrl { get; set; }   // web page URL (dedup) — null for workshop/local (id = folder)
    public string? Title { get; set; }
    public bool IsScene { get; set; }
    public string? WorkshopId { get; set; }
    public int? Volume { get; set; }          // null = use global
    public double? Speed { get; set; }        // null = use global
    // EBU R128 loudness measured once (ffmpeg loudnorm pass 1) → normalizes loudness between videos.
    // All four present = measured; absent = not analyzed. Target-independent (gain applied live).
    public double? LoudnessI { get; set; }      // integrated loudness (LUFS)
    public double? LoudnessTP { get; set; }     // true peak (dBTP)
    public double? LoudnessLRA { get; set; }    // loudness range (LU)
    public double? LoudnessThresh { get; set; } // measurement threshold
    public bool? LoudnessSkip { get; set; }     // true = no audio track → nothing to normalize, don't retry
    // A WE scene's loudness is learned by liascape-player on first play (`scene.loudness`, BS.1770 over its first ~60 s
    // of audible play): LoudnessI = integrated LUFS, LoudnessTP = its SAMPLE peak (dBFS, ≤ the true peak), no
    // LRA/Thresh (so ReadLoudness — the video loudnorm path — never takes it). LoudnessSeconds = the audible
    // seconds it covers; LoudnessPartial = measured over less than the window (the scene was switched away
    // early) — replaced by a longer or complete measurement on a later play.
    public double? LoudnessSeconds { get; set; }
    public bool? LoudnessPartial { get; set; }
    // The measurement itself (2026-10-28, refined across plays): the player's `scene.loudness` `state` — a
    // histogram of BS.1770 block loudness (0.1 LU bins) + the sample peak — opaque here; sent back as the next
    // source's `loudness_seed`, so every play continues the same integration until the player's cap (30 min of
    // audible play). LoudnessSeconds = the audible seconds it covers (every play). LoudnessI moves only when the
    // measurement moved ≥ 0.5 LU (MergeSceneLoudness), so `gain.normalize` never twitches.
    public JsonElement? LoudnessState { get; set; }
    public bool Crashed { get; set; }
    public bool Whitelist { get; set; }
    // A scene's user-property overrides (project.json general.properties → name → value in WE's encoding:
    // bool, number, "r g b", combo key, text — SceneProperties). null/absent = every property at the scene's
    // own default. Sent to the player at every open + live (`scene_props`); legacy: LWE --set-property.
    public Dictionary<string, JsonElement>? SceneProps { get; set; }
    public string? Resolution { get; set; }
    public string? AgeRating { get; set; }
    public string? YoutubeUrl { get; set; }
    public string? PageUrl { get; set; }
    public string? AuthorName { get; set; }
    public string? Description { get; set; }
    public long? FileSizeBytes { get; set; }
    public long? Subscriptions { get; set; }
    public long? Favorites { get; set; }
    public long? Views { get; set; }
    public string[]? Tags { get; set; }
}

public static class LibraryStore
{
    public const string MotionBgs = "motionbgs", Moewalls = "moewalls", Desktophut = "desktophut",
        Imported = "imported", Workshop = "workshop", Local = "local";
    public static readonly string[] Sources = { MotionBgs, Moewalls, Desktophut, Imported, Workshop, Local };

    private static string Root => DownloadHelper.LibraryPath;
    public static string SourceDir(string source) => Path.Combine(Root, source);
    private static string IndexPath(string source) => Path.Combine(SourceDir(source), "index.json");

    private static readonly object _lock = new();
    private static readonly JsonSerializerOptions _json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, // absent volume/speed == "use global"
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    // Atomic save + a retried load (AtomicFile): written in place, a read mid-save (every switch's override,
    // /settings, /library, SetMeta's own read-modify-write) got an EMPTY index — every override read as
    // "follows the global", and a SetMeta then saved that empty index + one entry over everything.
    public static Dictionary<string, LibMeta> LoadIndex(string source)
    {
        try { return AtomicFile.ReadJson<Dictionary<string, LibMeta>>(IndexPath(source), _json) ?? new(); }
        catch { return new(); }
    }

    // Private: every write is a read-modify-write under `_lock` (SetMeta / Remove / UpdateIndex). Trash, undo, the
    // WE sync and the direct-download reconcile used to LoadIndex, work, then SaveIndex their copy outside it —
    // over an override saved meanwhile (matrix race:indexLostUpdate: 2–3 of 40 slider saves reverted by
    // trash/undo cycles of another item).
    private static void SaveIndex(string source, Dictionary<string, LibMeta> idx)
    {
        try { AtomicFile.WriteAllText(IndexPath(source), JsonSerializer.Serialize(idx, _json)); }
        catch { }
    }

    // Read-modify-write a whole source's index under the same lock as SetMeta; `mutate` returns whether to save.
    // Reentrant (Monitor), so a writer touching two indexes can nest them and save in the order it needs.
    public static void UpdateIndex(string source, Func<Dictionary<string, LibMeta>, bool> mutate)
    {
        lock (_lock)
        {
            using var _ = FileLock.Hold(IndexPath(source)); // and every other liascape process (`liascape restore`'s WE sync)
            var idx = LoadIndex(source);
            if (mutate(idx)) SaveIndex(source, idx);
        }
    }

    // mediaPath (library/<source>/<key>/<file>…) → (source, key). Null if outside the library / malformed.
    public static (string Source, string Key)? Locate(string mediaPath)
    {
        try
        {
            var full = Path.GetFullPath(mediaPath);
            var root = Path.GetFullPath(Root) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.Ordinal)) return null;
            var parts = full.Substring(root.Length).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length >= 2 ? (parts[0], parts[1]) : null;
        }
        catch { return null; }
    }

    public static LibMeta? GetMeta(string mediaPath)
    {
        var loc = Locate(mediaPath);
        if (loc == null) return null;
        return LoadIndex(loc.Value.Source).TryGetValue(loc.Value.Key, out var m) ? m : null;
    }

    // Read-modify-write the item's index entry under a lock. Creates the entry if missing.
    public static void SetMeta(string mediaPath, Action<LibMeta> mutate)
    {
        var loc = Locate(mediaPath);
        if (loc == null) return;
        lock (_lock)
        {
            using var _ = FileLock.Hold(IndexPath(loc.Value.Source));
            var idx = LoadIndex(loc.Value.Source);
            if (!idx.TryGetValue(loc.Value.Key, out var m))
            {
                // an item that's gone (trashed, deleted) gets no entry: a save landing after its trash (the modal's
                // persist 250 ms after release, an "item"-mode volume key) left a ghost a later item with that key
                // inherited (matrix race:saveAfterTrash); Undo restores its trashed entry anyway
                if (!Directory.Exists(Path.Combine(SourceDir(loc.Value.Source), loc.Value.Key))) return;
                m = new LibMeta(); idx[loc.Value.Key] = m;
            }
            mutate(m);
            SaveIndex(loc.Value.Source, idx);
        }
    }

    public static void Remove(string mediaPath)
    {
        var loc = Locate(mediaPath);
        if (loc == null) return;
        lock (_lock)
        {
            using var _ = FileLock.Hold(IndexPath(loc.Value.Source));
            var idx = LoadIndex(loc.Value.Source);
            if (idx.Remove(loc.Value.Key)) SaveIndex(loc.Value.Source, idx);
        }
    }
}
