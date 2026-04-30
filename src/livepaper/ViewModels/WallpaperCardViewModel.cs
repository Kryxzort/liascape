using System;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using livepaper.Helpers;
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

    [ObservableProperty] private bool _isSelected;
    [ObservableProperty] private bool _isInPlaylist;
    [ObservableProperty] private bool _hasCrashed;
    [ObservableProperty] private bool _isWhitelisted;
    [ObservableProperty] private int _sliderVolume;
    [ObservableProperty] private double _sliderSpeed;

    private int? _volumeOverride;
    private int _globalVolume;
    private bool _suppressSliderChange;

    private double? _speedOverride;
    private double _globalSpeed;
    private bool _suppressSpeedChange;

    public bool IsSpeedSliderVisible => LibraryItem != null && !IsScene;
    public bool IsVolumeSynced => _volumeOverride == null;
    public int? VolumeOverride => _volumeOverride;
    public bool IsSpeedSynced => _speedOverride == null;
    public double? SpeedOverride => _speedOverride;

    partial void OnIsWhitelistedChanged(bool value)
    {
        if (LibraryItem != null) LibraryService.SetWhitelisted(LibraryItem.VideoPath, value);
    }

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
        IsScene = result.IsScene;
        WorkshopId = result.WorkshopId;
    }

    public WallpaperCardViewModel(LibraryItem item)
    {
        Title = item.Title;
        ThumbnailSource = item.ThumbnailPath ?? "";
        PageUrl = item.VideoPath;
        LibraryItem = item;
        IsScene = item.IsScene;
        WorkshopId = item.WorkshopId;
#pragma warning disable MVVMTK0034
        _hasCrashed = item.HasCrashed;
        _isWhitelisted = item.IsWhitelisted;
#pragma warning restore MVVMTK0034
    }
}
