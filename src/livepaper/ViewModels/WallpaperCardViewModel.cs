using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
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
    private static readonly SemaphoreSlim _metadataSem = new(4, 4);
    public string Title { get; }
    public string ThumbnailSource { get; }
    public string PageUrl { get; }
    public string? Resolution { get; }
    public LibraryItem? LibraryItem { get; }
    public bool IsScene { get; }
    public string? WorkshopId { get; }
    public bool IsPlaceholder { get; }

    // Workshop browse metadata (only non-null for cards from SteamWorkshopService)
    public bool IsWorkshopResult { get; }
    public string WorkshopDescription { get; } = "";
    public string WorkshopAuthorId { get; } = "";
    public string WorkshopSizeText { get; } = "";
    public string WorkshopSubsText { get; } = "";
    public string WorkshopFavText { get; } = "";
    public string WorkshopViewsText { get; } = "";
    public string WorkshopUpdatedText { get; } = "";
    public string[] WorkshopTags { get; } = [];
    public string? WorkshopUrl { get; }
    public string? WorkshopSteamUri { get; }
    public bool HasWorkshopStats => IsWorkshopResult &&
        (!string.IsNullOrEmpty(WorkshopSubsText) || !string.IsNullOrEmpty(WorkshopFavText));
    public bool HasWorkshopDescription => IsWorkshopResult && !string.IsNullOrEmpty(WorkshopDescription);
    public bool HasWorkshopTags => IsWorkshopResult && WorkshopTags.Length > 0;
    // Static JPG extracted from GIF for non-animated display. ThumbnailSource stays as the GIF path.
    [ObservableProperty] private string? _staticThumbnailSource;
    // True for local .gif files AND for remote workshop cards that have a raw preview URL
    // to attempt animated loading on hover (Steam serves GIF/WebP animated previews).
    public bool IsGifThumbnail =>
        ThumbnailSource.EndsWith(".gif", StringComparison.OrdinalIgnoreCase) ||
        (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase) &&
         !string.IsNullOrEmpty(StaticThumbnailSource));

    // Eligible for AutoPlayGifs bulk auto-activation. Remote previews are now loaded
    // asynchronously (see LoadRemoteGifSourceAsync + AnimatedPreviewCache), so auto-playing
    // a whole grid of Workshop cards no longer blocks the UI thread.
    public bool IsAutoPlayGif => IsGifThumbnail;

    // Single source used by the card's static image layer. Falls back to ThumbnailSource when no
    // extracted static frame is available. Avoids materializing two AdvancedImage controls per card.
    public string? DisplayThumbnailSource =>
        string.IsNullOrEmpty(StaticThumbnailSource) ? ThumbnailSource : StaticThumbnailSource;

    partial void OnStaticThumbnailSourceChanged(string? value) =>
        OnPropertyChanged(nameof(DisplayThumbnailSource));

    private AnimatedImage.Avalonia.AnimatedImageSource? _gifSource;
    private Stream? _gifStream;
    private CancellationTokenSource? _gifLoadCts;
    private bool _gifLoadStarted;
    // Bound by the preview modal AND (via ActiveGifSource) by the grid cards. For local files this
    // builds synchronously; for remote previews it kicks off an async download (off the UI thread)
    // and notifies when ready — returning null in the meantime so the static thumbnail shows.
    public AnimatedImage.Avalonia.AnimatedImageSource? GifSource
    {
        get { EnsureGifSourceLoading(); return _gifSource; }
    }

    [ObservableProperty] private bool _isGifActive;
    partial void OnIsGifActiveChanged(bool value)
    {
        if (!value) ReleaseGifSource();
        OnPropertyChanged(nameof(ActiveGifSource));
    }
    public AnimatedImage.Avalonia.AnimatedImageSource? ActiveGifSource => IsGifActive ? GifSource : null;

    // Stop the grid animation WITHOUT releasing the source, so the preview modal (which binds
    // GifSource) can keep animating this gif on its own. Two animations of the same gif at once
    // corrupt each other (the library's frame decode isn't safe for concurrent playback of the
    // same gif), so we pause the grid copy while the modal is open.
    public void DeactivateGifKeepSource()
    {
        if (!IsGifActive) return;
#pragma warning disable MVVMTK0034
        _isGifActive = false; // bypass OnIsGifActiveChanged so the source is NOT released
#pragma warning restore MVVMTK0034
        OnPropertyChanged(nameof(IsGifActive));
        OnPropertyChanged(nameof(ActiveGifSource));
    }

    private void EnsureGifSourceLoading()
    {
        if (_gifSource != null || _gifLoadStarted || !IsGifThumbnail) return;
        _gifLoadStarted = true;
        if (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            _gifLoadCts = new CancellationTokenSource();
            _ = LoadRemoteGifSourceAsync(_gifLoadCts.Token);
        }
        else
        {
            _gifSource = LoadLocalGifSource(ThumbnailSource, out _gifStream);
        }
    }

    // Download the preview bytes AND parse the animation entirely off the UI thread, then hand the
    // control a ready-to-play source so the UI thread only wires up the timeline (no stall).
    private async Task LoadRemoteGifSourceAsync(CancellationToken ct)
    {
        try
        {
            var bytes = await AnimatedPreviewCache.GetBytesAsync(ThumbnailSource, ct);
            if (ct.IsCancellationRequested || bytes == null || bytes.Length == 0) return;
            var source = await BuildAnimatedSourceAsync(bytes, ct);
            if (ct.IsCancellationRequested || source == null) return;
            _gifSource = source;
            // Notify both bindings so the now-ready source is picked up.
            OnPropertyChanged(nameof(GifSource));
            OnPropertyChanged(nameof(ActiveGifSource));
        }
        catch { }
    }

    // Parses on a background thread when possible (GifRendererBuilder), falling back to an
    // in-memory stream source (parsed on the UI thread, but at least with no network).
    private async Task<AnimatedImage.Avalonia.AnimatedImageSource?> BuildAnimatedSourceAsync(byte[] bytes, CancellationToken ct)
    {
        if (GifRendererBuilder.IsAvailable)
        {
            var prebuilt = await Task.Run(() => GifRendererBuilder.TryBuild(bytes), ct);
            if (prebuilt != null) return prebuilt;
        }
        return new AnimatedImage.Avalonia.AnimatedImageSourceStream(new MemoryStream(bytes, writable: false));
    }

    private void ReleaseGifSource()
    {
        _gifLoadCts?.Cancel();
        _gifLoadCts?.Dispose();
        _gifLoadCts = null;
        (_gifSource as IDisposable)?.Dispose();
        _gifStream?.Dispose();
        _gifSource = null;
        _gifStream = null;
        _gifLoadStarted = false;
    }

    private AnimatedImage.Avalonia.AnimatedImageSource? _playlistGifSource;
    private Stream? _playlistGifStream;
    private CancellationTokenSource? _playlistGifLoadCts;
    private bool _playlistGifLoadStarted;
    [ObservableProperty] private bool _isPlaylistGifActive;
    partial void OnIsPlaylistGifActiveChanged(bool value)
    {
        if (!value) { ReleasePlaylistGifSource(); OnPropertyChanged(nameof(PlaylistActiveGifSource)); return; }
        EnsurePlaylistGifSourceLoading();
        OnPropertyChanged(nameof(PlaylistActiveGifSource));
    }
    public AnimatedImage.Avalonia.AnimatedImageSource? PlaylistActiveGifSource =>
        IsPlaylistGifActive ? _playlistGifSource : null;

    private void EnsurePlaylistGifSourceLoading()
    {
        if (_playlistGifSource != null || _playlistGifLoadStarted || !IsGifThumbnail) return;
        _playlistGifLoadStarted = true;
        if (ThumbnailSource.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            _playlistGifLoadCts = new CancellationTokenSource();
            _ = LoadRemotePlaylistGifSourceAsync(_playlistGifLoadCts.Token);
        }
        else
        {
            _playlistGifSource = LoadLocalGifSource(ThumbnailSource, out _playlistGifStream);
        }
    }

    private async Task LoadRemotePlaylistGifSourceAsync(CancellationToken ct)
    {
        try
        {
            var bytes = await AnimatedPreviewCache.GetBytesAsync(ThumbnailSource, ct);
            if (ct.IsCancellationRequested || bytes == null || bytes.Length == 0) return;
            var source = await BuildAnimatedSourceAsync(bytes, ct);
            if (ct.IsCancellationRequested || source == null) return;
            _playlistGifSource = source;
            OnPropertyChanged(nameof(PlaylistActiveGifSource));
        }
        catch { }
    }

    private void ReleasePlaylistGifSource()
    {
        _playlistGifLoadCts?.Cancel();
        _playlistGifLoadCts?.Dispose();
        _playlistGifLoadCts = null;
        (_playlistGifSource as IDisposable)?.Dispose();
        _playlistGifStream?.Dispose();
        _playlistGifSource = null;
        _playlistGifStream = null;
        _playlistGifLoadStarted = false;
    }

    private static AnimatedImage.Avalonia.AnimatedImageSource? LoadLocalGifSource(string thumbnailSource, out Stream? stream)
    {
        stream = null;
        try
        {
            string path = thumbnailSource;
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
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAnyStateOverlay))]
    private bool _isSelected;
    [ObservableProperty] private bool _isInPlaylist;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAnyStateOverlay))]
    private bool _hasCrashed;
    [ObservableProperty] private bool _isWhitelisted;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAnyStateOverlay))]
    private bool _isCurrentlyPlaying;

    public bool IsAnyStateOverlay => HasCrashed || IsSelected || IsCurrentlyPlaying;
    [ObservableProperty] private string _videoDuration = "";
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
    private void OpenSteamUri()
    {
        var uri = WorkshopSteamUri;
        if (string.IsNullOrEmpty(uri)) return;
        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { uri }, UseShellExecute = false }); }
        catch { }
    }

    // Trailer URL for workshop items that have an attached YouTube video; populated lazily when the
    // preview modal opens (scraped from the item page). Drives the "YouTube Video" button.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWorkshopYoutube))]
    private string? _workshopYoutubeUrl;

    public bool HasWorkshopYoutube => !string.IsNullOrEmpty(WorkshopYoutubeUrl);

    [RelayCommand]
    private void OpenYoutube()
    {
        var url = WorkshopYoutubeUrl;
        if (string.IsNullOrEmpty(url)) return;
        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { url }, UseShellExecute = false }); }
        catch { }
    }

    [RelayCommand]
    private async Task OpenInFileManager()
    {
        string? dir = null;
        string? filePath = null;

        if (LibraryItem != null)
        {
            if (IsScene)
            {
                if (LibraryItem.CopiedSceneDir != null && Directory.Exists(LibraryItem.CopiedSceneDir))
                    dir = LibraryItem.CopiedSceneDir;
                else if (WorkshopId != null)
                {
                    var wePath = SettingsService.Load().WallpaperEnginePath;
                    if (!string.IsNullOrEmpty(wePath))
                        dir = Path.Combine(wePath, WorkshopId);
                }
            }

            if (dir == null)
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

    public void LoadDurationAsync()
    {
        if (LibraryItem == null || IsScene) return;
        Task.Run(async () =>
        {
            await _metadataSem.WaitAsync();
            try
            {
                var dur = ReadDuration(LibraryItem.VideoPath);
                Dispatcher.UIThread.Post(() => VideoDuration = dur);
            }
            finally { _metadataSem.Release(); }
        });
    }

    private static string ReadDuration(string path)
    {
        try
        {
            var psi = new ProcessStartInfo("ffprobe")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("-v"); psi.ArgumentList.Add("error");
            psi.ArgumentList.Add("-show_entries"); psi.ArgumentList.Add("format=duration");
            psi.ArgumentList.Add("-of"); psi.ArgumentList.Add("default=noprint_wrappers=1:nokey=1");
            psi.ArgumentList.Add(path);
            using var proc = Process.Start(psi);
            var output = proc?.StandardOutput.ReadToEnd().Trim();
            proc?.WaitForExit();
            if (double.TryParse(output, NumberStyles.Float, CultureInfo.InvariantCulture, out double s))
            {
                var ts = TimeSpan.FromSeconds((int)s);
                var parts = new System.Collections.Generic.List<string>();
                if (ts.Hours > 0) parts.Add($"{ts.Hours} {(ts.Hours == 1 ? "hour" : "hours")}");
                if (ts.Minutes > 0) parts.Add($"{ts.Minutes} {(ts.Minutes == 1 ? "minute" : "minutes")}");
                if (ts.Seconds > 0 || parts.Count == 0) parts.Add($"{ts.Seconds} {(ts.Seconds == 1 ? "second" : "seconds")}");
                if (parts.Count == 1) return parts[0];
                return string.Join(", ", parts[..^1]) + " and " + parts[^1];
            }
        }
        catch { }
        return "";
    }

    public WallpaperCardViewModel(bool isPlaceholder)
    {
        IsPlaceholder = isPlaceholder;
        Title = "";
        ThumbnailSource = "";
        PageUrl = "";
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

        if (result.WorkshopId != null && result.PageUrl.StartsWith("https://steamcommunity.com"))
        {
            IsWorkshopResult = true;
            WorkshopDescription = result.Description ?? "";
            WorkshopAuthorId = result.AuthorId ?? "";
            WorkshopTags = result.Tags ?? [];
            WorkshopUrl = $"https://steamcommunity.com/sharedfiles/filedetails/?id={result.WorkshopId}";
            WorkshopSteamUri = $"steam://url/CommunityFilePage/{result.WorkshopId}";
            if (result.FileSizeBytes.HasValue)
                WorkshopSizeText = FormatBytes(result.FileSizeBytes.Value);
            if (result.Subscriptions.HasValue)
                WorkshopSubsText = FormatCount(result.Subscriptions.Value);
            if (result.Favorites.HasValue)
                WorkshopFavText = FormatCount(result.Favorites.Value);
            if (result.Views.HasValue)
                WorkshopViewsText = FormatCount(result.Views.Value);
            if (result.AddedAt.HasValue)
                WorkshopUpdatedText = result.AddedAt.Value.ToString("MMM d, yyyy");
        }
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes >= 1_073_741_824) return $"{bytes / 1_073_741_824.0:F1} GB";
        if (bytes >= 1_048_576) return $"{bytes / 1_048_576.0:F0} MB";
        if (bytes >= 1_024) return $"{bytes / 1_024.0:F0} KB";
        return $"{bytes} B";
    }

    private static string FormatCount(long n)
    {
        if (n >= 1_000_000) return $"{n / 1_000_000.0:F1}M";
        if (n >= 1_000) return $"{n / 1_000.0:F1}K";
        return n.ToString();
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

        // Pre-populate StaticThumbnailSource from WE cache if thumbnail is a GIF
        if (IsGifThumbnail && item.WorkshopId != null)
        {
            string cached = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cache", "livepaper", "we_thumbs", $"{item.WorkshopId}.jpg");
            if (File.Exists(cached))
                _staticThumbnailSource = cached;
        }
#pragma warning restore MVVMTK0034
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
            await _metadataSem.WaitAsync();
            try
            {
                Directory.CreateDirectory(cacheDir);
                await WallpaperEngineScraper.ExtractGifStaticFrameAsync(gifPath, outputPath);
                if (File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
                    Dispatcher.UIThread.Post(() => StaticThumbnailSource = outputPath);
            }
            finally { _metadataSem.Release(); }
        });
    }
}
