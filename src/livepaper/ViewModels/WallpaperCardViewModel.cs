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
    public bool IsGifThumbnail => ThumbnailSource.EndsWith(".gif", StringComparison.OrdinalIgnoreCase);

    private Avalonia.Labs.Gif.IGifSource? _gifSource;
    public Avalonia.Labs.Gif.IGifSource? GifSource => _gifSource ??= LoadGifSource();

    [ObservableProperty] private bool _isGifActive;
    partial void OnIsGifActiveChanged(bool value) => OnPropertyChanged(nameof(ActiveGifSource));
    public Avalonia.Labs.Gif.IGifSource? ActiveGifSource => IsGifActive ? GifSource : null;

    private Avalonia.Labs.Gif.IGifSource? LoadGifSource()
    {
        if (!IsGifThumbnail) return null;
        try
        {
            if (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                return Avalonia.Labs.Gif.GifStreamSource.FromUriString(ThumbnailSource);

            string path = ThumbnailSource;
            if (path.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                path = path.Substring(7);

            if (File.Exists(path))
                return Avalonia.Labs.Gif.GifStreamSource.FromStream(File.OpenRead(path));
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
        ThumbnailSource = result.ThumbnailUrl;
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
