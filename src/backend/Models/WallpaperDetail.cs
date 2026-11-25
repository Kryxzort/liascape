namespace Liascape.Models;

// A result's detail (IBrowseSource.GetDetailAsync): what the sidebar previews and what a download fetches.
public sealed class WallpaperDetail : WallpaperFacts
{
    // the sidebar's preview: the site's preview video, or the local card's still
    public required string PreviewUrl { get; init; }
    // the file a download fetches, or the local video file / item folder an import takes
    public required string DownloadUrl { get; init; }
    // the Referer the download must send, null = none (moewalls refuses its files without the wallpaper's page)
    public string? Referrer { get; init; }
    // True when DownloadUrl is a local workshop dir acquired via WorkshopDownloader
    public bool IsWorkshopAcquire { get; init; }
    public string? PageUrl { get; init; }
}
