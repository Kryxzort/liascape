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
}
