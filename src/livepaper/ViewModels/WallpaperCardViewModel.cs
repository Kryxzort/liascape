using System;
using System.IO;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using livepaper.Models;

namespace livepaper.ViewModels;

public partial class WallpaperCardViewModel : ViewModelBase
{
    public string Title { get; }
    public string ThumbnailSource { get; }
    public string PageUrl { get; }
    public string? Resolution { get; }
    public LibraryItem? LibraryItem { get; }
    public bool IsScene { get; }
    public string? WorkshopId { get; }
    // Static JPG extracted from GIF for non-animated display. ThumbnailSource stays as the GIF path.
    public string? StaticThumbnailSource { get; }
    public bool IsGifThumbnail => ThumbnailSource.EndsWith(".gif", StringComparison.OrdinalIgnoreCase);

    private AnimatedImage.Avalonia.AnimatedImageSource? _gifSource;
    public AnimatedImage.Avalonia.AnimatedImageSource? GifSource => _gifSource ??= LoadGifSource();

    [ObservableProperty] private bool _isGifActive;
    partial void OnIsGifActiveChanged(bool value) => OnPropertyChanged(nameof(ActiveGifSource));
    public AnimatedImage.Avalonia.AnimatedImageSource? ActiveGifSource => IsGifActive ? GifSource : null;

    private AnimatedImage.Avalonia.AnimatedImageSource? LoadGifSource()
    {
        if (!IsGifThumbnail) return null;
        try
        {
            if (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                return new AnimatedImage.Avalonia.AnimatedImageSourceUri { UriSource = new Uri(ThumbnailSource, UriKind.Absolute) };

            string path = ThumbnailSource;
            if (path.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                path = path.Substring(7);

            if (File.Exists(path))
                return new AnimatedImage.Avalonia.AnimatedImageSourceStream(File.OpenRead(path));
        }
        catch { }
        return null;
    }
    [ObservableProperty] private bool _isSelected;
    [ObservableProperty] private bool _isInPlaylist;
    [ObservableProperty] private bool _isCurrentlyPlaying;

    public string CheckmarkText => IsInPlaylist ? "−" : "+";

    partial void OnIsInPlaylistChanged(bool value) => OnPropertyChanged(nameof(CheckmarkText));

    public Action<WallpaperCardViewModel>? OnTogglePlaylist { get; set; }

    [RelayCommand]
    private void AddToPlaylist() => OnTogglePlaylist?.Invoke(this);

    public WallpaperCardViewModel(WallpaperResult result)
    {
        Title = result.Title;
        // When a static JPG was extracted from a GIF, ThumbnailSource stays as the GIF (for hover)
        // and StaticThumbnailSource holds the JPG (for the non-animated display).
        if (result.AnimatedThumbnailUrl != null)
        {
            ThumbnailSource = result.AnimatedThumbnailUrl;
            StaticThumbnailSource = result.ThumbnailUrl;
        }
        else
        {
            ThumbnailSource = result.ThumbnailUrl;
        }
        PageUrl = result.PageUrl;
        Resolution = result.Resolution;
    }

    public WallpaperCardViewModel(LibraryItem item)
    {
        Title = item.Title;
        ThumbnailSource = item.ThumbnailPath ?? "";
        PageUrl = item.VideoPath;
        LibraryItem = item;
    }
}
