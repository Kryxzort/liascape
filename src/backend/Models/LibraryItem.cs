using System;

namespace Liascape.Models;

public class LibraryItem
{
    public required string Title { get; init; }
    public required string VideoPath { get; init; }
    public string? ThumbnailPath { get; init; }
    // Animated preview asset (gif/webp) when the source provided one (WE/Workshop). Null otherwise;
    // the web UI then falls back to playing VideoPath on hover.
    public string? AnimatedThumbnailPath { get; init; }
    public string? SourceId { get; init; }
    public bool IsScene { get; init; }
    public string? WorkshopId { get; init; }
    // Non-null when CopyFilesInsteadOfSymlinking=true and the scene data was copied to the library.
    // Contains the full path to the copied workshop directory inside LibraryPath.
    public string? CopiedSceneDir { get; init; }
    public bool HasCrashed { get; init; }
    // A scene's fonts this machine showed with another family at its last load under liascape-player (LibMeta.FontStandIns;
    // the sidebar's "Uses Consolas, shown with Cascadia Mono"). Null = none, or never loaded there.
    public System.Collections.Generic.List<Liascape.Helpers.FontStandIn>? FontStandIns { get; init; }
    public bool IsWhitelisted { get; init; }
    public int? VolumeOverride { get; init; }
    public double? SpeedOverride { get; init; }
    public DateTime AddedAt { get; init; }
    // A scene's loudness under liascape-player (its CURRENT audio configuration — .claude/rules/backend/library.md § Loudness): the applied
    // LUFS, whether it is the offline estimate (no live measurement of this configuration yet), the audible seconds
    // measured, the estimate's confidence and — when low — its first note. All null for a video / nothing known.
    public double? LoudnessLufs { get; init; }
    public bool? LoudnessEstimated { get; init; }
    public double? LoudnessSeconds { get; init; }
    public string? LoudnessConfidence { get; init; }
    public string? LoudnessNote { get; init; }

    // Rich metadata captured at download time (persisted in the source index.json). All optional.
    public string? Resolution { get; init; }
    public string? AgeRating { get; init; }
    public string? YoutubeUrl { get; init; }
    public string? PageUrl { get; init; }      // source page (Steam workshop page for WE items)
    public string? AuthorName { get; init; }
    public string? Description { get; init; }
    public long? FileSizeBytes { get; init; }
    // its size on disk (LibMeta.DiskBytes); null = not measured yet
    public long? DiskBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public string[]? Tags { get; init; }
    // A Workshop item Steam keeps subscribed (WorkshopSubOps.MarkSubscribed: its folder in a Steam Workshop root, no
    // unsubscribe queued); set by GET /library only. False for the library's own copy after "Unsubscribe without
    // deleting" and for a one-off copy Steam doesn't have: those delete like any local item.
    public bool? Subscribed { get; set; }
    // Steam's servers said they have no public item with its id (removed, private: LibMeta.TagsCheckedAt): nothing to
    // subscribe to
    public bool OffWorkshop { get; init; }
    // the watched folder that brought it in (LibMeta.WatchedFrom): Settings counts each folder's wallpapers by it
    public string? WatchedFrom { get; init; }
    // A Wallpaper Engine preset (Helpers/Presets.cs; also IsScene): its base scene's Workshop id (null = its file names
    // none), the base's library folder when found, the base's title (its own, else the one its download saved), and why it
    // can't play now (null = it plays; the legacy engine's reason included). Read at every GET /library.
    public bool IsPreset { get; init; }
    public string? BaseWorkshopId { get; init; }
    public string? BasePath { get; init; }
    public string? BaseTitle { get; init; }
    public string? PresetReason { get; init; }
}
