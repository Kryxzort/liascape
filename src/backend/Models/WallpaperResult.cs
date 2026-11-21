using System;

namespace Liascape.Models;

public class WallpaperResult
{
    public required string Title { get; init; }
    public required string ThumbnailUrl { get; init; }
    public string? AnimatedThumbnailUrl { get; init; }
    public required string PageUrl { get; init; }
    public string? Resolution { get; init; }
    public bool IsScene { get; init; }
    public bool IsPreset { get; init; }
    public string? WorkshopId { get; init; }
    public DateTime? AddedAt { get; init; }

    // Workshop-only metadata (populated by SteamWorkshopScraper)
    public string? Description { get; init; }
    public string? AuthorName { get; init; }
    public string? AuthorId { get; init; }
    public long? FileSizeBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public string[]? Tags { get; init; }
    // the local Wallpaper Engine folder's items: project.json's age rating (Workshop results carry theirs in Tags)
    public string? AgeRating { get; init; }
    // Workshop results from Steam's client protocol carry the item's trailer (QueryFiles returns previews inline):
    // TrailerKnown → YoutubeUrl is the answer (null = none), and the detail skips reading the item's Steam page.
    // The UI posts the result back to /detail as it got it, so these ride along untouched.
    public string? YoutubeUrl { get; init; }
    public bool TrailerKnown { get; init; }
    // Workshop results: what a local sort of a list needs (created time, Steam's vote score 0–1) and the items it
    // requires (a preset: its base scene)
    // Guard: scripts/test-workshop-social.sh § 6 "details: the found items in order, with created / score"
    public DateTime? CreatedAt { get; init; }
    public double? Score { get; init; }
    public string[]? Children { get; init; }
}
