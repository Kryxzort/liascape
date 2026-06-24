namespace livepaper.Models;

public class WallpaperDetail
{
    public required string Title { get; init; }
    public required string PreviewUrl { get; init; }
    public required string DownloadUrl { get; init; }
    public bool NeedsReferrer { get; init; }
    public string? Referrer { get; init; }
    public bool IsScene { get; init; }
    public string? WorkshopId { get; init; }
    // True when DownloadUrl is a local workshop dir acquired via WorkshopDownloader
    public bool IsWorkshopAcquire { get; init; }

    // Rich metadata (carried through download → persisted on the LibraryItem). All optional.
    public string? Resolution { get; init; }
    public string? AgeRating { get; init; }
    public string? YoutubeUrl { get; init; }
    public string? PageUrl { get; init; }
    public string? AuthorName { get; init; }
    public string? Description { get; init; }
    public long? FileSizeBytes { get; init; }
    public long? Subscriptions { get; init; }
    public long? Favorites { get; init; }
    public long? Views { get; init; }
    public string[]? Tags { get; init; }
}
