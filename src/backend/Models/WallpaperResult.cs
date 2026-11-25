using System;

namespace Liascape.Models;

// One card on Browse as /browse returns it. The page posts it back as it got it to /detail and /download, so every field
// rides along untouched.
public sealed class WallpaperResult : WallpaperFacts
{
    // the card's still: a site's picture (the page loads it through /img) or a local file; "" = none
    public required string ThumbnailUrl { get; init; }
    public string? AnimatedThumbnailUrl { get; init; }
    // its page on a site (a downloaded item's source id), or the local folder's video file / item folder
    public required string PageUrl { get; init; }
    public bool IsPreset { get; init; }
    public DateTime? AddedAt { get; init; }

    // Workshop-only metadata (populated by SteamWorkshopScraper)
    public string? AuthorId { get; init; }
    // Workshop results from Steam's client protocol carry the item's trailer (QueryFiles returns previews inline):
    // TrailerKnown → YoutubeUrl is the answer (null = none), and the detail skips reading the item's Steam page.
    public bool TrailerKnown { get; init; }
    // Workshop results: what a local sort of a list needs (created time, Steam's vote score 0–1) and the items it
    // requires (a preset: its base scene)
    // Guard: scripts/test-workshop-social.sh § 6 "details: the found items in order, with created / score"
    public DateTime? CreatedAt { get; init; }
    public double? Score { get; init; }
    public string[]? Children { get; init; }
}
