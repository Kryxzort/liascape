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
    // A WE scene's loudness (liascape-player only — .claude/rules/backend/library.md § Loudness): kept PER AUDIO CONFIGURATION, keyed by
    // the offline estimator's `fingerprint` of the scene's sound under its user properties (`liascape-player
    // scene-loudness`; a property that changes no sound keeps it). Each entry holds the estimate (computed from the
    // scene's files on import / Settings → Sound → "Pre-measure scenes") and the live measurement (the player's `scene.loudness`
    // reports, refined on every play up to its cap). SceneLoudnessFp = the CURRENT configuration's fingerprint (null =
    // never estimated: reports go under "" until it is). LoudnessI / LoudnessTP above are the APPLIED value of the
    // current configuration — its live measurement once it has a report, else its estimate (0.5 LU hysteresis
    // within one configuration; a configuration change jumps to the new one's value) — LoudnessI = LUFS,
    // LoudnessTP = the SAMPLE peak (dBFS, ≤ the true peak); no LRA/Thresh, so ReadLoudness (the video loudnorm path)
    // never takes a scene's.
    public Dictionary<string, SceneLoudnessEntry>? SceneLoudness { get; set; }
    public string? SceneLoudnessFp { get; set; }
    public bool Crashed { get; set; }
    public bool Whitelist { get; set; }
    // A scene's user-property overrides (project.json general.properties → name → value in WE's encoding:
    // bool, number, "r g b", combo key, text — SceneProperties). null/absent = every property at the scene's
    // own default. Sent to the player at every open + live (`scene_props`); legacy: LWE --set-property.
    public Dictionary<string, JsonElement>? SceneProps { get; set; }
    public string? Resolution { get; set; }
    public string? AgeRating { get; set; }
    public string? YoutubeUrl { get; set; }
    // Unix seconds the item's Steam page was last READ and showed no trailer (Web/LibraryFactsOps — re-checked after 30 days, an
    // author may add one); absent = never checked, or every check so far failed (offline …) → tried again next start.
    public long? TrailerCheckedAt { get; set; }
    // Unix seconds Steam's servers last said they have no public item with this id (removed, private) when asked for its
    // tags (Web/LibraryFactsOps — asked again after 30 days); absent = never asked, a failed ask, or found (Tags holds them).
    public long? TagsCheckedAt { get; set; }
    // The media's frame size read from the file itself ("W x H"; "" = it has none: no video stream, a scene without a fixed
    // projection) and the file state it was read at (FrameSizeOf = "<bytes>:<mtime ticks>": a changed file is read again).
    // Read only for an item whose Steam tags carry no resolution (Web/LibraryFactsOps); the filter column's Resolution group
    // shows it bucketed (WorkshopTags.ResolutionTagOf).
    public string? FrameSize { get; set; }
    public string? FrameSizeOf { get; set; }
    public string? PageUrl { get; set; }
    public string? AuthorName { get; set; }
    public string? Description { get; set; }
    public long? FileSizeBytes { get; set; }
    public long? Subscriptions { get; set; }
    public long? Favorites { get; set; }
    // the Steam page's view count: neither filled nor sent; kept so an index.json that holds it round-trips
    public long? Views { get; set; }
    // Steam's Workshop tags: saved at a download, or asked once for an auto-imported item (Web/LibraryFactsOps); absent =
    // not known (a non-Workshop item, or not asked yet: the item's project.json speaks meanwhile).
    public string[]? Tags { get; set; }
    // Unix seconds the item came into the library, saved only when its files were made again after that (a `local/<id>` link
    // turned into the library's own copy: LibraryService.KeepOwnCopy), so it keeps its place in "date added"; absent = the
    // media file's own date.
    public long? AddedAt { get; set; }
}

// One audio configuration's loudness (LibMeta.SceneLoudness[fingerprint]).
public sealed class SceneLoudnessEntry
{
    public SceneLoudnessEstimate? Estimate { get; set; }
    public SceneLoudnessLive? Live { get; set; }
}

// The offline estimate (`liascape-player scene-loudness`): Lufs null = the configuration plays no sound.
public sealed class SceneLoudnessEstimate
{
    public double? Lufs { get; set; }
    public double? PeakDbfs { get; set; }
    // the estimated histogram scaled to 10 s of audible play (the CLI's `seed.state`): a new source's
    // `loudness_seed` while the configuration has no live measurement — the first live report outweighs it 6:1
    public JsonElement? Seed { get; set; }
    public string? Confidence { get; set; }     // high | medium | low
    public string[]? Notes { get; set; }        // the confidence notes (the UI shows the first when low)
    public double? LufsIfCoherent { get; set; } // the upper bound when equal-length tracks may be one recording
    public string? Model { get; set; }
    public int V { get; set; } = 1;             // this record's format
    public DateTime? At { get; set; }
}

// The live measurement (the player's `scene.loudness`, cumulative over every play of this configuration): `State` =
// its BS.1770 block-loudness histogram + peak (opaque here — the next source's `loudness_seed`), `Seconds` = the
// audible seconds it covers, `Partial` = less than the window (switched away early on a first play).
public sealed class SceneLoudnessLive
{
    public JsonElement? State { get; set; }
    public double Seconds { get; set; }
    public double Lufs { get; set; }
    public double? PeakDbfs { get; set; }
    public bool? Partial { get; set; }
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

    // Private: every write is a read-modify-write under `_lock` (SetMeta / Remove / UpdateIndex). A caller that
    // LoadIndex-es, works, then SaveIndex-es its copy outside it writes over an override saved meanwhile
    // (Guard: matrix race:indexLostUpdate — 2–3 of 40 slider saves reverted by trash/undo cycles of another item).
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
            // a `..` segment: the lexical check below can't see where it lands after a symlink (workshop items are links
            // into Steam's folders) — a library path never has one, so a request that does (Delete, Trash) touches nothing
            if (Array.IndexOf(mediaPath.Split(Path.DirectorySeparatorChar), "..") >= 0) return null;
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
