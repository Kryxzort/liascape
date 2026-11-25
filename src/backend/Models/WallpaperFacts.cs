namespace Liascape.Models;

// What Browse knows about one wallpaper, seen as a result (WallpaperResult, a card on a page) or as that result's detail
// (WallpaperDetail, what a download fetches): the facts a download carries into the library item (DownloadHelper). Only the
// title is always there; each source fills what it knows. Sent to the page camelCase (app/ui/src/api/client.ts Wallpaper,
// Detail).
public abstract class WallpaperFacts
{
    // the card's name; a detail keeps its result's
    public required string Title { get; init; }
    // a size the source names: motionbgs' "4K" / "HD", the Workshop's resolution tag
    public string? Resolution { get; init; }
    public bool IsScene { get; init; }
    public string? WorkshopId { get; init; }
    // the local Wallpaper Engine folder's items: project.json's age rating (Workshop results carry theirs in Tags)
    public string? AgeRating { get; init; }
    public string? YoutubeUrl { get; init; }
    public string? AuthorName { get; init; }
    public string? Description { get; init; }
    public long? FileSizeBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public string[]? Tags { get; init; }
}
