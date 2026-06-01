using System;

namespace livepaper.Models;

public class WallpaperResult
{
    public required string Title { get; init; }
    public required string ThumbnailUrl { get; init; }
    public string? AnimatedThumbnailUrl { get; init; }
    public required string PageUrl { get; init; }
    public string? Resolution { get; init; }
    public bool IsScene { get; init; }
    public string? WorkshopId { get; init; }
    public DateTime? AddedAt { get; init; }

    // Workshop-only metadata (populated by SteamWorkshopScraper)
    public string? Description { get; init; }
    public string? AuthorName { get; init; }
    public string? AuthorId { get; init; }
    public long? FileSizeBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public long? Views { get; init; }
    public string[]? Tags { get; init; }
}
