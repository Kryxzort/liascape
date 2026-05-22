using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using livepaper.Helpers;
using livepaper.Models;
using livepaper.Scrapers;

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
    [ObservableProperty] private string? _staticThumbnailSource;
    public bool IsGifThumbnail => ThumbnailSource.EndsWith(".gif", StringComparison.OrdinalIgnoreCase);

    private AnimatedImage.Avalonia.AnimatedImageSource? _gifSource;
    private Stream? _gifStream;
    public AnimatedImage.Avalonia.AnimatedImageSource? GifSource => _gifSource ??= LoadGifSource(out _gifStream);

    [ObservableProperty] private bool _isGifActive;
    partial void OnIsGifActiveChanged(bool value)
    {
        if (!value) ReleaseGifSource();
        OnPropertyChanged(nameof(ActiveGifSource));
    }
    public AnimatedImage.Avalonia.AnimatedImageSource? ActiveGifSource => IsGifActive ? GifSource : null;
    public void RestartGif() { ReleaseGifSource(); OnPropertyChanged(nameof(ActiveGifSource)); }

    private void ReleaseGifSource()
    {
        (_gifSource as IDisposable)?.Dispose();
        _gifStream?.Dispose();
        _gifSource = null;
        _gifStream = null;
    }

    private AnimatedImage.Avalonia.AnimatedImageSource? _playlistGifSource;
    private Stream? _playlistGifStream;
    [ObservableProperty] private bool _isPlaylistGifActive;
    partial void OnIsPlaylistGifActiveChanged(bool value)
    {
        if (!value) ReleasePlaylistGifSource();
        OnPropertyChanged(nameof(PlaylistActiveGifSource));
    }
    public AnimatedImage.Avalonia.AnimatedImageSource? PlaylistActiveGifSource =>
        IsPlaylistGifActive ? (_playlistGifSource ??= LoadGifSource(out _playlistGifStream)) : null;
    public void RestartPlaylistGif() { ReleasePlaylistGifSource(); OnPropertyChanged(nameof(PlaylistActiveGifSource)); }

    private void ReleasePlaylistGifSource()
    {
        (_playlistGifSource as IDisposable)?.Dispose();
        _playlistGifStream?.Dispose();
        _playlistGifSource = null;
        _playlistGifStream = null;
    }

    private AnimatedImage.Avalonia.AnimatedImageSource? LoadGifSource(out Stream? stream)
    {
        stream = null;
        if (!IsGifThumbnail) return null;
        try
        {
            if (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                return new AnimatedImage.Avalonia.AnimatedImageSourceUri { UriSource = new Uri(ThumbnailSource, UriKind.Absolute) };

            string path = ThumbnailSource;
            if (path.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                path = path.Substring(7);

            if (File.Exists(path))
            {
                stream = File.OpenRead(path);
                return new AnimatedImage.Avalonia.AnimatedImageSourceStream(stream);
            }
        }
        catch { }
        return null;
    }

    public bool IsLocalSource => !PageUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase);
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

    public bool IsVolumeSynced => _volumeOverride == null;
    public int? VolumeOverride => _volumeOverride;
    public bool IsSpeedSynced => _speedOverride == null;
    public double? SpeedOverride => _speedOverride;

    partial void OnIsWhitelistedChanged(bool value)
    {
        if (LibraryItem != null) LibraryService.SetWhitelisted(LibraryItem.VideoPath, value);
    }

    partial void OnSliderVolumeChanged(int value)
    {
        if (_suppressSliderChange || LibraryItem == null) return;
        _volumeOverride = value;
        OnPropertyChanged(nameof(IsVolumeSynced));
        OnPropertyChanged(nameof(VolumeOverride));
        LibraryService.SaveVolumeOverride(LibraryItem.VideoPath, value);
        if (IsCurrentlyPlaying)
            Task.Run(() => PlayerHelper.SetVolume(value));
        OnVolumeChanged?.Invoke(this, value);
    }

    [RelayCommand]
    private void SyncVolumeToGlobal()
    {
        if (LibraryItem == null) return;
        _volumeOverride = null;
        _suppressSliderChange = true;
        SliderVolume = _globalVolume;
        _suppressSliderChange = false;
        OnPropertyChanged(nameof(IsVolumeSynced));
        OnPropertyChanged(nameof(VolumeOverride));
        LibraryService.SaveVolumeOverride(LibraryItem.VideoPath, null);
        if (IsCurrentlyPlaying)
            Task.Run(() => PlayerHelper.SetVolume(_globalVolume));
        OnVolumeChanged?.Invoke(this, null);
    }

    public void UpdateGlobalVolume(int volume)
    {
        _globalVolume = volume;
        if (_volumeOverride == null)
        {
            _suppressSliderChange = true;
            SliderVolume = volume;
            _suppressSliderChange = false;
        }
    }

    partial void OnSliderSpeedChanged(double value)
    {
        if (_suppressSpeedChange || LibraryItem == null) return;
        _speedOverride = value;
        OnPropertyChanged(nameof(IsSpeedSynced));
        OnPropertyChanged(nameof(SpeedOverride));
        LibraryService.SaveSpeedOverride(LibraryItem.VideoPath, value);
        if (IsCurrentlyPlaying)
            Task.Run(() => PlayerHelper.SetSpeed(value));
        OnSpeedChanged?.Invoke(this, value);
    }

    [RelayCommand]
    private void SyncSpeedToGlobal()
    {
        if (LibraryItem == null) return;
        _speedOverride = null;
        _suppressSpeedChange = true;
        SliderSpeed = _globalSpeed;
        _suppressSpeedChange = false;
        OnPropertyChanged(nameof(IsSpeedSynced));
        OnPropertyChanged(nameof(SpeedOverride));
        LibraryService.SaveSpeedOverride(LibraryItem.VideoPath, null);
        if (IsCurrentlyPlaying)
            Task.Run(() => PlayerHelper.SetSpeed(_globalSpeed));
        OnSpeedChanged?.Invoke(this, null);
    }

    public void UpdateGlobalSpeed(double speed)
    {
        _globalSpeed = speed;
        if (_speedOverride == null)
        {
            _suppressSpeedChange = true;
            SliderSpeed = speed;
            _suppressSpeedChange = false;
        }
    }

    public Action<WallpaperCardViewModel, int?>? OnVolumeChanged { get; set; }
    public Action<WallpaperCardViewModel, double?>? OnSpeedChanged { get; set; }


    [ObservableProperty] private bool _isCurrentlyPlaying;

    public string CheckmarkText => IsInPlaylist ? "−" : "+";

    partial void OnIsInPlaylistChanged(bool value) => OnPropertyChanged(nameof(CheckmarkText));

    public Action<WallpaperCardViewModel>? OnTogglePlaylist { get; set; }
    public Action<WallpaperCardViewModel>? OnOpenSettings { get; set; }

    [RelayCommand]
    private void AddToPlaylist() => OnTogglePlaylist?.Invoke(this);

    [RelayCommand]
    private void OpenSettings() => OnOpenSettings?.Invoke(this);

    [RelayCommand]
    private void OpenPage()
    {
        if (string.IsNullOrEmpty(PageUrl)) return;
        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { PageUrl }, UseShellExecute = false }); }
        catch { }
    }

    [RelayCommand]
    private async Task OpenInFileManager()
    {
        string? dir = null;
        string? filePath = null;

        if (LibraryItem != null)
        {
            // Resolve symlinks so WeCopyFiles=false points to the workshop item dir
            string path = LibraryItem.VideoPath;
            try
            {
                var target = File.ResolveLinkTarget(path, returnFinalTarget: true);
                if (target != null) path = target.FullName;
            }
            catch { }
            filePath = path;
            dir = Path.GetDirectoryName(path);
        }
        else if (!string.IsNullOrEmpty(PageUrl) && !PageUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            // WE local browse card: PageUrl is a local file (video) or dir (scene)
            if (IsScene && Directory.Exists(PageUrl))
                dir = PageUrl;
            else if (File.Exists(PageUrl))
            {
                filePath = PageUrl;
                dir = Path.GetDirectoryName(PageUrl);
            }
        }

        if (dir == null || !Directory.Exists(dir)) return;

        if (filePath != null && File.Exists(filePath) && await Task.Run(() => TryShowItem(filePath)))
            return;

        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { dir }, UseShellExecute = false }); }
        catch { }
    }

    private static bool TryShowItem(string path)
    {
        try
        {
            string uri = new Uri(path).AbsoluteUri;
            var psi = new ProcessStartInfo("dbus-send")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("--session");
            psi.ArgumentList.Add("--dest=org.freedesktop.FileManager1");
            psi.ArgumentList.Add("--type=method_call");
            psi.ArgumentList.Add("/org/freedesktop/FileManager1");
            psi.ArgumentList.Add("org.freedesktop.FileManager1.ShowItems");
            psi.ArgumentList.Add($"array:string:{uri}");
            psi.ArgumentList.Add("string:");
            using var proc = Process.Start(psi);
            proc?.WaitForExit(2000);
            return proc?.ExitCode == 0;
        }
        catch { return false; }
    }

    public WallpaperCardViewModel(WallpaperResult result)
    {
        Title = result.Title;
        // When a static JPG was extracted from a GIF, ThumbnailSource stays as the GIF (for hover)
        // and StaticThumbnailSource holds the JPG (for the non-animated display).
        if (result.AnimatedThumbnailUrl != null)
        {
            ThumbnailSource = result.AnimatedThumbnailUrl;
#pragma warning disable MVVMTK0034
            _staticThumbnailSource = result.ThumbnailUrl;
#pragma warning restore MVVMTK0034
        }
        else
        {
            ThumbnailSource = result.ThumbnailUrl;
        }
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
        _volumeOverride = item.VolumeOverride;
        _sliderVolume = item.VolumeOverride ?? SettingsService.Load().Volume;
        _speedOverride = item.SpeedOverride;
        _sliderSpeed = item.SpeedOverride ?? 1.0;
#pragma warning restore MVVMTK0034

        // Pre-populate StaticThumbnailSource from WE cache if thumbnail is a GIF
        if (IsGifThumbnail && item.WorkshopId != null)
        {
            string cached = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cache", "livepaper", "we_thumbs", $"{item.WorkshopId}.jpg");
            if (File.Exists(cached))
                _staticThumbnailSource = cached;
        }
    }

    private static string GifThumbCacheDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "livepaper", "we_thumbs");

    public void LoadStaticThumbnailAsync()
    {
        if (!IsGifThumbnail || StaticThumbnailSource != null) return;
        string gifPath = ThumbnailSource;
        string cacheDir = GifThumbCacheDir;
        string cacheKey = WorkshopId ?? Path.GetFileNameWithoutExtension(gifPath);
        string outputPath = Path.Combine(cacheDir, $"{cacheKey}.jpg");
        Task.Run(async () =>
        {
            try
            {
                Directory.CreateDirectory(cacheDir);
                await WallpaperEngineScraper.ExtractGifStaticFrameAsync(gifPath, outputPath);
                if (File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                    Dispatcher.UIThread.Post(() => StaticThumbnailSource = outputPath);
            }
            catch { }
        });
    }
}
