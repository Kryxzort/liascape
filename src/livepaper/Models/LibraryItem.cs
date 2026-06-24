using System;

namespace livepaper.Models;

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
    // Non-null when WeCopyFiles=true and the scene data was copied to the library.
    // Contains the full path to the copied workshop directory inside LibraryPath.
    public string? CopiedSceneDir { get; init; }
    public bool HasCrashed { get; init; }
    public bool IsWhitelisted { get; init; }
    public int? VolumeOverride { get; init; }
    public double? SpeedOverride { get; init; }
    public DateTime AddedAt { get; init; }

    // Rich metadata captured at download time (persisted in the source index.json). All optional.
    public string? Resolution { get; init; }
    public string? AgeRating { get; init; }
    public string? YoutubeUrl { get; init; }
    public string? PageUrl { get; init; }      // source page (Steam workshop page for WE items)
    public string? AuthorName { get; init; }
    public string? Description { get; init; }
    public long? FileSizeBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public long? Views { get; init; }
    public string[]? Tags { get; init; }
}
