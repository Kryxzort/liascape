using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using livepaper.Helpers;
using livepaper.Models;
using livepaper.Scrapers;
using livepaper.Services;

namespace livepaper.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    public string[] HwDecOptions { get; } = ["auto", "nvdec", "vaapi", "no"];
    public IReadOnlyList<AppTheme> Themes { get; } = ThemeService.All;

    [ObservableProperty] private AppTheme _selectedTheme = ThemeService.Default;
    public string[] VideoScaleOptions { get; } = ["fit", "fill"];

    public string[] ThumbnailAspectOptions { get; } = ["Default", "16:9", "1:1"];
    public string[] CardSizeOptions { get; } = ["Small", "Medium", "Large"];
    public Action? CardLayoutChanged { get; set; }

    public List<IBgsProvider> Sources { get; } =
    [
        new MotionBgsService(),
        new MoewallsService(),
        new DesktophutService(),
        new WallpaperEngineService(),
        new SteamWorkshopService()
    ];

    [ObservableProperty] private IBgsProvider _selectedSource;

    // Hides "Wallpaper Engine (Local)" when AutoImportWallpaperEngine is on — those wallpapers
    // are already in the Library, so browsing them separately is redundant.
    public IReadOnlyList<IBgsProvider> FilteredSources =>
        AutoImportWallpaperEngine
            ? Sources.Where(s => s is not WallpaperEngineService).ToList()
            : Sources;

    [ObservableProperty] private ObservableCollection<WallpaperCardViewModel> _browseWallpapers = [];
    [ObservableProperty] private ObservableCollection<WallpaperCardViewModel> _libraryWallpapers = [];
    [ObservableProperty] private bool _isLoading;
    // Single shared shimmer position: every placeholder's shimmer binds Canvas.Left to this, so they
    // all sweep in sync (per-element Style animations start at each element's own time = out of phase).
    [ObservableProperty] private double _shimmerX = ShimmerStart;
    private const double ShimmerStart = -350, ShimmerEnd = 350, ShimmerSpeed = 778; // px/s (≈700px / 0.9s)
    private DispatcherTimer? _shimmerTimer;
    private long _shimmerLastTicks;

    partial void OnIsLoadingChanged(bool value)
    {
        if (value)
        {
            if (_shimmerTimer == null)
            {
                _shimmerTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
                _shimmerTimer.Tick += AdvanceShimmer;
            }
            _shimmerLastTicks = DateTime.UtcNow.Ticks;
            _shimmerTimer.Start();
        }
        else
        {
            _shimmerTimer?.Stop();
        }
    }

    private void AdvanceShimmer(object? sender, EventArgs e)
    {
        long now = DateTime.UtcNow.Ticks;
        double dt = (now - _shimmerLastTicks) / (double)TimeSpan.TicksPerSecond;
        _shimmerLastTicks = now;
        double x = ShimmerX + ShimmerSpeed * dt;
        if (x > ShimmerEnd) x = ShimmerStart + (x - ShimmerEnd);
        ShimmerX = x;
    }

    [ObservableProperty] private string _searchQuery = "";
    [ObservableProperty] private string _statusMessage = "";
    public bool HasStatusContent => !string.IsNullOrEmpty(StatusMessage) || CanUndo;
    partial void OnStatusMessageChanged(string value) => OnPropertyChanged(nameof(HasStatusContent));
    partial void OnCanUndoChanged(bool value) => OnPropertyChanged(nameof(HasStatusContent));
    [ObservableProperty] private int _currentPage = 1;
    [ObservableProperty] private WallpaperCardViewModel? _previewCard;
    // Load the full-res still when a card is previewed; drop it (free the bitmap) when it isn't.
    partial void OnPreviewCardChanged(WallpaperCardViewModel? oldValue, WallpaperCardViewModel? newValue)
    {
        oldValue?.ReleasePreviewBitmap();
        newValue?.LoadPreviewBitmap();
    }
    [ObservableProperty] private string? _errorMessage;
    [ObservableProperty] private string _errorTitle = "Download Failed";

    [ObservableProperty] private bool _isClearLibraryOpen;
    [ObservableProperty] private int _clearLibraryCountdown;
    [ObservableProperty] private bool _clearLibraryReady;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AnyBrowseSelected))]
    private int _browseSelectedCount;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AnyLibrarySelected))]
    private int _librarySelectedCount;

    public bool AnyBrowseSelected => BrowseSelectedCount > 0;
    public bool AnyLibrarySelected => LibrarySelectedCount > 0;

    [ObservableProperty] private bool _isSavePlaylistOpen;
    [ObservableProperty] private string _savePlaylistName = "";
    [ObservableProperty] private bool _isLoadPlaylistOpen;
    [ObservableProperty] private ObservableCollection<string> _availablePlaylists = [];
    [ObservableProperty] private string? _selectedPlaylistToLoad;
    [ObservableProperty] private string? _currentPlaylistName;

    [ObservableProperty] private bool _isImportOpen;
    [ObservableProperty] private string _importTitle = "";
    [ObservableProperty] private bool _isImporting;
    private string _importSourcePath = "";

    private CancellationTokenSource? _clearLibraryCts;

    [RelayCommand]
    private void DismissError() => ErrorMessage = null;

    [RelayCommand]
    private void OpenClearLibrary()
    {
        _clearLibraryCts?.Cancel();
        _clearLibraryCts?.Dispose();
        _clearLibraryCts = new CancellationTokenSource();
        ClearLibraryCountdown = 5;
        ClearLibraryReady = false;
        IsClearLibraryOpen = true;
        var ct = _clearLibraryCts.Token;
        Task.Run(async () =>
        {
            for (int i = 4; i >= 0; i--)
            {
                try { await Task.Delay(1000, ct); }
                catch (OperationCanceledException) { return; }
                await Dispatcher.UIThread.InvokeAsync(() =>
                {
                    ClearLibraryCountdown = i;
                    if (i == 0) ClearLibraryReady = true;
                });
            }
        });
    }

    [RelayCommand]
    private void CancelClearLibrary()
    {
        _clearLibraryCts?.Cancel();
        IsClearLibraryOpen = false;
    }

    [RelayCommand]
    private void ConfirmClearLibrary()
    {
        if (!ClearLibraryReady) return;
        foreach (var b in _undoBatches) LibraryService.PurgeBatch(b.BatchDir);
        _undoBatches.Clear();
        CanUndo = false;
        PlayerHelper.Stop();
        LibraryService.DeleteAll();
        LibraryWallpapers.Clear();
        _currentlyPlayingCard = null;
        PlaylistItems.Clear();
        IsPlaylistEmpty = true;
        IsClearLibraryOpen = false;
        StatusMessage = "Library cleared";
    }

    private bool _isSearchMode;
    private string _currentQuery = "";
    private int _loadGeneration;
    public bool NoMorePages { get; private set; }

    // source settings
    [ObservableProperty] private string _wallpaperEnginePath = "";
    [ObservableProperty] private bool _weCopyFiles;
    [ObservableProperty] private bool _resumeFromLast;
    [ObservableProperty] private bool _allowScenes;
    [ObservableProperty] private decimal _sceneTransitionDelayMs;

    // Workshop acquire settings
    [ObservableProperty] private string _workshopAcquireMode = "subscribe";
    [ObservableProperty] private string _steamLoginSecure = "";
    [ObservableProperty] private string _steamCmdPath = "";
    [ObservableProperty] private string _steamUsername = "";
    public bool IsWorkshopSubscribeMode
    {
        get => WorkshopAcquireMode == "subscribe";
        set { if (value) WorkshopAcquireMode = "subscribe"; }
    }
    public bool IsWorkshopSteamCmdMode
    {
        get => WorkshopAcquireMode == "steamcmd";
        set { if (value) WorkshopAcquireMode = "steamcmd"; }
    }

    // Workshop sort state. The two dropdowns (sort + trend period) drive the backing
    // WorkshopSort/WorkshopTrendDays that BuildWorkshopFilter reads.
    private string _workshopSort = "trend";
    private int _workshopTrendDays = 7;
    public string WorkshopSort => _workshopSort;
    public int WorkshopTrendDays => _workshopTrendDays;

    public string[] WorkshopSortOptions { get; } =
        ["Most Popular", "Most Recent", "Recently Updated", "Most Subscribed", "Top Rated"];
    public string[] WorkshopTrendPeriodOptions { get; } =
        ["Today", "This Week", "This Month", "Three Months", "Six Months", "This Year"];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WorkshopHasActiveFilters))]
    [NotifyPropertyChangedFor(nameof(IsWorkshopTrendSelected))]
    private string _workshopSortDisplay = "Most Popular";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WorkshopHasActiveFilters))]
    private string _workshopTrendPeriodDisplay = "This Week";

    // Trend period dropdown only applies to "Most Popular".
    public bool IsWorkshopTrendSelected => WorkshopSortDisplay == "Most Popular";

    partial void OnWorkshopSortDisplayChanged(string value) => _workshopSort = value switch
    {
        "Most Recent" => "mostrecent",
        "Recently Updated" => "lastupdated",
        "Most Subscribed" => "totaluniquesubscribers",
        "Top Rated" => "toprated",
        _ => "trend"
    };

    partial void OnWorkshopTrendPeriodDisplayChanged(string value) => _workshopTrendDays = value switch
    {
        "Today" => 1,
        "This Month" => 30,
        "Three Months" => 90,
        "Six Months" => 180,
        "This Year" => 365,
        _ => 7
    };

    public string[] WorkshopTypeOptions { get; } = ["Any", "Video", "Scene"];
    public string[] WorkshopAgeRatingOptions { get; } = ["Any", "Everyone", "Questionable", "Mature"];
    // Full resolution taxonomy scraped from the WE workshop browse page.
    public string[] WorkshopResolutionOptions { get; } =
    [
        "Any",
        "Standard Definition", "1280 x 720", "1366 x 768", "1920 x 1080", "2560 x 1440", "3840 x 2160",
        "Ultrawide Standard Definition", "Ultrawide 2560 x 1080", "Ultrawide 3440 x 1440",
        "Dual Standard Definition", "Dual 3840 x 1080", "Dual 5120 x 1440", "Dual 7680 x 2160",
        "Triple Standard Definition", "Triple 4096 x 768", "Triple 5760 x 1080", "Triple 7680 x 1440", "Triple 11520 x 2160",
        "Portrait Standard Definition", "Portrait 720 x 1280", "Portrait 1080 x 1920", "Portrait 1440 x 2560", "Portrait 2160 x 3840",
        "Other resolution", "Dynamic resolution"
    ];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WorkshopHasActiveFilters))]
    private string _workshopFilterTypeDisplay = "Any";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WorkshopHasActiveFilters))]
    private string _workshopFilterAgeRatingDisplay = "Any";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WorkshopHasActiveFilters))]
    private string _workshopFilterResolutionDisplay = "Any";

    public ObservableCollection<WorkshopGenreItem> WorkshopGenres { get; } =
    [
        new("Abstract"), new("Animal"), new("Anime"), new("Cartoon"), new("CGI"),
        new("Cyberpunk"), new("Fantasy"), new("Game"), new("Girls"), new("Guys"),
        new("Landscape"), new("Medieval"), new("Memes"), new("MMD"), new("Music"),
        new("Nature"), new("Pixel art"), new("Relaxing"), new("Retro"), new("Sci-Fi"),
        new("Sports"), new("Technology"), new("Television"), new("Vehicle"), new("Unspecified")
    ];

    // Misc feature tags from the WE workshop "Misc" filter group (AND-filtered like genres).
    public ObservableCollection<WorkshopGenreItem> WorkshopFeatures { get; } =
    [
        new("Approved"), new("Verified"), new("Audio responsive"), new("HDR"), new("3D"),
        new("Customizable"), new("Media Integration"), new("Puppet Warp"), new("Video Texture"),
        new("No Animation"), new("Multi-monitor optimized")
    ];

    // Workshop acquire button label (shown in browse card + preview modal)
    public string WorkshopAcquireButtonLabel =>
        WorkshopAcquireMode == "subscribe" ? "Subscribe & Apply" : "Download & Apply";

    // LWE monitor management
    [ObservableProperty] private ObservableCollection<LweMonitorViewModel> _lweMonitors = [];
    [ObservableProperty] private LweMonitorViewModel? _selectedLweMonitor;
    [ObservableProperty] private decimal _selectedMonitorFps = 30;
    [ObservableProperty] private bool _selectedMonitorIsPrimary;
    private bool _suppressPrimaryChanged;
    [ObservableProperty] private bool _isAddingMonitor;
    [ObservableProperty] private string _newMonitorName = "";

    // mpvpaper settings
    [ObservableProperty] private bool _loop;
    [ObservableProperty] private bool _noAudio;
    [ObservableProperty] private bool _disableCache;
    [ObservableProperty] private int _demuxerMaxBytes;
    [ObservableProperty] private int _demuxerMaxBackBytes;
    [ObservableProperty] private string _hwDec = "";
    [ObservableProperty] private string _videoScale = "fit";
    [ObservableProperty] private double _cardThumbnailHeight = 150;
    [ObservableProperty] private double _cardMinWidth = 210;
    [ObservableProperty] private double _cardButtonFontSize = 13;
    [ObservableProperty] private string _thumbnailAspect = "Default";
    [ObservableProperty] private string _cardSize = "Medium";
    [ObservableProperty] private bool _autoPlayGifs;
    [ObservableProperty] private int _volume;
    [ObservableProperty] private double _speed = 1.0;
    [ObservableProperty] private string _mpvOptionsPreview = "";
    [ObservableProperty] private bool _autoMute;
    [ObservableProperty] private decimal _autoMuteDelayMs;
    [ObservableProperty] private decimal _autoUnmuteDelayMs;
    [ObservableProperty] private decimal _autoMuteThresholdDb;
    [ObservableProperty] private decimal _restartIntervalSeconds;
    [ObservableProperty] private bool _autoMuteOnlyIfMprisActive;

    // Playlist state
    [ObservableProperty] private ObservableCollection<WallpaperCardViewModel> _playlistItems = [];
    [ObservableProperty] private bool _isPlaylistEmpty = true;
    [ObservableProperty] private bool _isPlaylistSettingsOpen;
    [ObservableProperty] private bool _isPlaylistCollapsed;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsSequential))]
    private bool _playlistShuffle;

    public bool IsSequential
    {
        get => !PlaylistShuffle;
        set => PlaylistShuffle = !value;
    }
    [ObservableProperty] private decimal _intervalHours = 0;
    [ObservableProperty] private decimal _intervalMinutes = 30;
    [ObservableProperty] private decimal _intervalSeconds = 0;
    [ObservableProperty] private bool _advanceOnVideoEnd = true;
    [ObservableProperty] private bool _playlistWaitForVideoEnd;
    [ObservableProperty] private bool _overrideGlobalSettings;
    [ObservableProperty] private bool _autoAddLibraryToPlaylist;
    [ObservableProperty] private bool _autoImportWallpaperEngine;

    // Global rotation settings (Settings tab)
    [ObservableProperty] private decimal _globalIntervalHours;
    [ObservableProperty] private decimal _globalIntervalMinutes;
    [ObservableProperty] private decimal _globalIntervalSeconds;
    [ObservableProperty] private bool _globalAdvanceOnVideoEnd = true;
    [ObservableProperty] private bool _globalWaitForVideoEnd;

    // Display proxies: show global values when override is off, per-playlist when on
    public decimal DisplayIntervalHours
    {
        get => OverrideGlobalSettings ? IntervalHours : GlobalIntervalHours;
        set { if (OverrideGlobalSettings) IntervalHours = value; }
    }
    public decimal DisplayIntervalMinutes
    {
        get => OverrideGlobalSettings ? IntervalMinutes : GlobalIntervalMinutes;
        set { if (OverrideGlobalSettings) IntervalMinutes = value; }
    }
    public decimal DisplayIntervalSeconds
    {
        get => OverrideGlobalSettings ? IntervalSeconds : GlobalIntervalSeconds;
        set { if (OverrideGlobalSettings) IntervalSeconds = value; }
    }
    public bool DisplayAdvanceOnVideoEnd
    {
        get => OverrideGlobalSettings ? AdvanceOnVideoEnd : GlobalAdvanceOnVideoEnd;
        set { if (OverrideGlobalSettings) AdvanceOnVideoEnd = value; }
    }
    public bool DisplayWaitForVideoEnd
    {
        get => OverrideGlobalSettings ? PlaylistWaitForVideoEnd : GlobalWaitForVideoEnd;
        set { if (OverrideGlobalSettings) PlaylistWaitForVideoEnd = value; }
    }

    partial void OnAutoMuteChanged(bool value)
    {
        _settings.AutoMute = value;
        if (value) RestartAudioMonitor();
        else AudioMonitor.Stop();
        SettingsService.Save(_settings);
    }

    partial void OnAutoMuteDelayMsChanged(decimal value)
    {
        _settings.AutoMuteDelayMs = (int)value;
        RestartAudioMonitor();
        SettingsService.Save(_settings);
    }

    partial void OnAutoUnmuteDelayMsChanged(decimal value)
    {
        _settings.AutoUnmuteDelayMs = (int)value;
        RestartAudioMonitor();
        SettingsService.Save(_settings);
    }

    partial void OnAutoMuteThresholdDbChanged(decimal value)
    {
        _settings.AutoMuteThresholdDb = (double)value;
        RestartAudioMonitor();
        SettingsService.Save(_settings);
    }

    partial void OnAutoMuteOnlyIfMprisActiveChanged(bool value)
    {
        _settings.AutoMuteOnlyIfMprisActive = value;
        RestartAudioMonitor();
        SettingsService.Save(_settings);
    }

    private void RestartAudioMonitor()
    {
        if (_settings.AutoMute)
            AudioMonitor.Start(_settings.AutoMuteDelayMs, _settings.AutoUnmuteDelayMs, _settings.AutoMuteThresholdDb, _settings.AutoMuteOnlyIfMprisActive);
    }

    partial void OnRestartIntervalSecondsChanged(decimal value)
    {
        _settings.RestartIntervalSeconds = (int)value;
        SettingsService.Save(_settings);
        PlayerHelper.UpdateRestartTimer();
    }

    partial void OnWeCopyFilesChanged(bool value)
    {
        _settings.WeCopyFiles = value;
        SettingsService.Save(_settings);
    }

    partial void OnResumeFromLastChanged(bool value)
    {
        _settings.ResumeFromLast = value;
        SettingsService.Save(_settings);
    }

    partial void OnAllowScenesChanged(bool value)
    {
        _settings.AllowScenes = value;
        ((WallpaperEngineService)Sources.First(s => s is WallpaperEngineService)).AllowScenes = value;
        ((SteamWorkshopService)Sources.First(s => s is SteamWorkshopService)).AllowScenes = value;
        if (SelectedSource is WallpaperEngineService or SteamWorkshopService) _ = LoadWallpapersAsync();
        if (value && !PlayerHelper.IsLweAvailable())
            StatusMessage = "linux-wallpaperengine not found in PATH — install it to use scenes";
        SettingsService.Save(_settings);
    }

    partial void OnWallpaperEnginePathChanged(string value)
    {
        _settings.WallpaperEnginePath = value;
        ((WallpaperEngineService)Sources.First(s => s is WallpaperEngineService)).WorkshopPath = value;
        ((SteamWorkshopService)Sources.First(s => s is SteamWorkshopService)).WorkshopBasePath = value;
        if (SelectedSource is WallpaperEngineService) _ = LoadWallpapersAsync();
        SettingsService.Save(_settings);
    }

    partial void OnWorkshopAcquireModeChanged(string value)
    {
        _settings.WorkshopAcquireMode = value;
        OnPropertyChanged(nameof(IsWorkshopSubscribeMode));
        OnPropertyChanged(nameof(IsWorkshopSteamCmdMode));
        OnPropertyChanged(nameof(WorkshopAcquireButtonLabel));
        SettingsService.Save(_settings);
    }

    partial void OnSteamLoginSecureChanged(string value)
    {
        _settings.SteamLoginSecure = value;
        SettingsService.Save(_settings);
    }

    partial void OnSteamCmdPathChanged(string value)
    {
        _settings.SteamCmdPath = value;
        SettingsService.Save(_settings);
    }

    partial void OnSteamUsernameChanged(string value)
    {
        _settings.SteamUsername = value;
        SettingsService.Save(_settings);
    }

    partial void OnSceneTransitionDelayMsChanged(decimal value)
    {
        _settings.SceneTransitionDelayMs = (int)value;
        SettingsService.Save(_settings);
    }

    partial void OnSelectedLweMonitorChanged(LweMonitorViewModel? value)
    {
        if (value == null) return;
        _suppressPrimaryChanged = true;
        SelectedMonitorFps = value.Fps;
        SelectedMonitorIsPrimary = value.IsPrimary;
        _suppressPrimaryChanged = false;
    }

    partial void OnSelectedMonitorFpsChanged(decimal value)
    {
        if (SelectedLweMonitor == null) return;
        SelectedLweMonitor.Fps = (int)value;
        SaveLweMonitors();
    }

    partial void OnSelectedMonitorIsPrimaryChanged(bool value)
    {
        if (_suppressPrimaryChanged) return;
        if (SelectedLweMonitor == null) return;
        if (value)
        {
            foreach (var m in LweMonitors)
                m.IsPrimary = false;
            SelectedLweMonitor.IsPrimary = true;
            SaveLweMonitors();
        }
        else
        {
            if (LweMonitors.Count <= 1)
            {
                // Can't deselect the only monitor — defer revert so binding completes first
                Dispatcher.UIThread.Post(() => SelectedMonitorIsPrimary = true);
                return;
            }
            // Auto-promote the next monitor in the list
            SelectedLweMonitor.IsPrimary = false;
            var idx = LweMonitors.IndexOf(SelectedLweMonitor);
            var next = LweMonitors[(idx + 1) % LweMonitors.Count];
            next.IsPrimary = true;
            SaveLweMonitors();
        }
    }

    private void AddMonitor(string name)
    {
        if (LweMonitors.Any(m => m.Name == name)) return;
        var saved = _settings.LweMonitors.FirstOrDefault(m => m.Name == name);
        var vm = new LweMonitorViewModel(name, LweMonitors.Count)
        {
            Fps = saved?.Fps ?? 30,
            IsPrimary = saved?.IsPrimary ?? LweMonitors.Count == 0
        };
        LweMonitors.Add(vm);
        UpdateMonitorIndices();
        SaveLweMonitors();
    }

    private void UpdateMonitorIndices()
    {
        for (int i = 0; i < LweMonitors.Count; i++)
            LweMonitors[i].Index = i;
    }

    private void SaveLweMonitors()
    {
        _settings.LweMonitors = LweMonitors
            .Select(m => new Models.LweMonitorSettings { Name = m.Name, Fps = m.Fps, IsPrimary = m.IsPrimary })
            .ToList();
        SettingsService.Save(_settings);
    }

    [RelayCommand]
    private void StartAddMonitor()
    {
        NewMonitorName = "";
        IsAddingMonitor = true;
    }

    [RelayCommand]
    private void ConfirmAddMonitor()
    {
        var name = NewMonitorName.Trim();
        if (!string.IsNullOrEmpty(name))
            AddMonitor(name);
        IsAddingMonitor = false;
        NewMonitorName = "";
    }

    [RelayCommand]
    private void CancelAddMonitor()
    {
        IsAddingMonitor = false;
        NewMonitorName = "";
    }

    [RelayCommand]
    private void RemoveSelectedMonitor()
    {
        if (SelectedLweMonitor == null) return;
        bool wasPrimary = SelectedLweMonitor.IsPrimary;
        LweMonitors.Remove(SelectedLweMonitor);
        UpdateMonitorIndices();
        SelectedLweMonitor = LweMonitors.Count > 0 ? LweMonitors[0] : null;
        // Ensure there's always a primary
        if (wasPrimary && LweMonitors.Count > 0 && !LweMonitors.Any(m => m.IsPrimary))
        {
            LweMonitors[0].IsPrimary = true;
            if (SelectedLweMonitor != null) SelectedMonitorIsPrimary = LweMonitors[0].IsPrimary;
        }
        SaveLweMonitors();
    }

    [RelayCommand]
    private async Task PickWallpaperEngineFolderAsync()
    {
        if (PickFolderDialog == null) return;
        var path = await PickFolderDialog();
        if (path != null) WallpaperEnginePath = path;
    }

    public Func<Task<string?>>? PickFileDialog { get; set; }

    [RelayCommand]
    private async Task PickSteamCmdFileAsync()
    {
        if (PickFileDialog == null) return;
        var path = await PickFileDialog();
        if (path != null) SteamCmdPath = path;
    }

    [RelayCommand]
    private async Task OpenImport()
    {
        if (PickVideoDialog == null) return;
        var path = await PickVideoDialog();
        if (string.IsNullOrEmpty(path)) return;
        _importSourcePath = path;
        ImportTitle = Path.GetFileNameWithoutExtension(path);
        IsImportOpen = true;
    }

    [RelayCommand]
    private void CancelImport()
    {
        IsImportOpen = false;
        _importSourcePath = "";
        ImportTitle = "";
    }

    [RelayCommand]
    private async Task ConfirmImport()
    {
        var source = _importSourcePath;
        var title = ImportTitle?.Trim();
        if (string.IsNullOrEmpty(source) || string.IsNullOrEmpty(title)) return;

        IsImportOpen = false;
        IsImporting = true;
        StatusMessage = $"Importing {title}...";

        try
        {
            var item = await ImportService.ImportAsync(source, title);
            if (item == null)
            {
                StatusMessage = "Import failed";
                return;
            }
            // Re-import dedup by SourceId: if a card already represents this
            // source, swap the new card in at the same library index AND
            // update any PlaylistItems entry pointing at the old card so
            // playlist references stay valid + IsInPlaylist state is preserved.
            var existing = !string.IsNullOrEmpty(item.SourceId)
                ? LibraryWallpapers.FirstOrDefault(c => c.LibraryItem?.SourceId == item.SourceId)
                : null;
            var newCard = MakeLibraryCard(item);
            if (existing != null)
            {
                int libIdx = LibraryWallpapers.IndexOf(existing);
                int playlistIdx = PlaylistItems.IndexOf(existing);
                newCard.IsInPlaylist = existing.IsInPlaylist;
                LibraryWallpapers[libIdx] = newCard;
                if (playlistIdx >= 0) PlaylistItems[playlistIdx] = newCard;
            }
            else
            {
                LibraryWallpapers.Add(newCard);
            }
            StatusMessage = $"Imported: {item.Title}";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Import failed: {ex.Message}";
        }
        finally
        {
            IsImporting = false;
            _importSourcePath = "";
        }
    }

    partial void OnPlaylistShuffleChanged(bool value)
    {
        var s = _settings.LastSession;
        if (s != null && PlayerHelper.IsPlaying && IsRunningCustomPlaylist(s.Paths))
        {
            s.Shuffle = value;
            SettingsService.Save(_settings);
        }
        SavePlaylistStateDebounced();
        ApplyShuffleOrderIfRunning(value);
        RefreshPlayingStatus();
    }
    partial void OnPlaylistWaitForVideoEndChanged(bool value) { _settings.PlaylistWaitForVideoEnd = value; SettingsService.Save(_settings); if (OverrideGlobalSettings) OnPropertyChanged(nameof(DisplayWaitForVideoEnd)); ApplyEffectivePlaylistSettingsIfRunning(); RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }

    partial void OnAutoAddLibraryToPlaylistChanged(bool value)
    {
        _settings.AutoAddLibraryToPlaylist = value;
        SettingsService.Save(_settings);
    }

    partial void OnIsPlaylistCollapsedChanged(bool value)
    {
        _settings.IsPlaylistCollapsed = value;
        SettingsService.Save(_settings);
    }

    [RelayCommand]
    private void TogglePlaylistCollapsed() => IsPlaylistCollapsed = !IsPlaylistCollapsed;

    partial void OnAutoImportWallpaperEngineChanged(bool value)
    {
        _settings.AutoImportWallpaperEngine = value;
        SettingsService.Save(_settings);
        OnPropertyChanged(nameof(FilteredSources));
        if (value && SelectedSource is WallpaperEngineService)
            SelectedSource = Sources[0];
        if (value) Task.Run(SyncWallpaperEngineAsync);
    }

    private async Task SyncWallpaperEngineAsync()
    {
        try
        {
            var added = LibraryService.SyncWallpaperEngine(
                _settings.WallpaperEnginePath, _settings.AllowScenes, _settings.WeCopyFiles);
            if (added.Count == 0) return;
            var fresh = LibraryService.LoadAll().ToDictionary(i => i.VideoPath);
            await Dispatcher.UIThread.InvokeAsync(() =>
            {
                foreach (var media in added)
                {
                    if (LibraryWallpapers.Any(c => c.LibraryItem?.VideoPath == media)) continue;
                    if (!fresh.TryGetValue(media, out var item)) continue;
                    LibraryWallpapers.Add(MakeLibraryCard(item));
                }
            });
        }
        catch { }
    }
    partial void OnIntervalHoursChanged(decimal value) { SavePlaylistStateDebounced(); if (OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalHours)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnIntervalMinutesChanged(decimal value) { SavePlaylistStateDebounced(); if (OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalMinutes)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnIntervalSecondsChanged(decimal value) { SavePlaylistStateDebounced(); if (OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalSeconds)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnAdvanceOnVideoEndChanged(bool value) { SavePlaylistStateDebounced(); if (OverrideGlobalSettings) { OnPropertyChanged(nameof(DisplayAdvanceOnVideoEnd)); ApplyEffectivePlaylistSettingsIfRunning(); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnOverrideGlobalSettingsChanged(bool value)
    {
        SavePlaylistStateDebounced();
        ApplyEffectivePlaylistSettingsIfRunning();
        RefreshLastSessionFromSettingsIfIdle();
        OnPropertyChanged(nameof(DisplayIntervalHours));
        OnPropertyChanged(nameof(DisplayIntervalMinutes));
        OnPropertyChanged(nameof(DisplayIntervalSeconds));
        OnPropertyChanged(nameof(DisplayAdvanceOnVideoEnd));
        OnPropertyChanged(nameof(DisplayWaitForVideoEnd));
        RefreshPlayingStatus();
    }
    partial void OnGlobalIntervalHoursChanged(decimal value) { SaveGlobalRotationSettings(); if (!OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalHours)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnGlobalIntervalMinutesChanged(decimal value) { SaveGlobalRotationSettings(); if (!OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalMinutes)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnGlobalIntervalSecondsChanged(decimal value) { SaveGlobalRotationSettings(); if (!OverrideGlobalSettings) { ApplyEffectivePlaylistSettingsIfRunning(); OnPropertyChanged(nameof(DisplayIntervalSeconds)); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnGlobalAdvanceOnVideoEndChanged(bool value) { SaveGlobalRotationSettings(); if (!OverrideGlobalSettings) { OnPropertyChanged(nameof(DisplayAdvanceOnVideoEnd)); ApplyEffectivePlaylistSettingsIfRunning(); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }
    partial void OnGlobalWaitForVideoEndChanged(bool value) { SaveGlobalRotationSettings(); if (!OverrideGlobalSettings) { OnPropertyChanged(nameof(DisplayWaitForVideoEnd)); ApplyEffectivePlaylistSettingsIfRunning(); } RefreshLastSessionFromSettingsIfIdle(); RefreshPlayingStatus(); }

    private void SaveGlobalRotationSettings()
    {
        _settings.GlobalIntervalSeconds = (int)GlobalIntervalHours * 3600 + (int)GlobalIntervalMinutes * 60 + (int)GlobalIntervalSeconds;
        _settings.GlobalAdvanceOnVideoEnd = GlobalAdvanceOnVideoEnd;
        _settings.GlobalWaitForVideoEnd = GlobalWaitForVideoEnd;
        SettingsService.Save(_settings);
    }

    private void OnBrowseCardChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(WallpaperCardViewModel.IsSelected)) return;
        if (sender is WallpaperCardViewModel card)
            BrowseSelectedCount = Math.Max(0, BrowseSelectedCount + (card.IsSelected ? 1 : -1));
    }

    private void OnLibraryCardChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(WallpaperCardViewModel.IsSelected)) return;
        if (sender is not WallpaperCardViewModel card) return;
        LibrarySelectedCount = Math.Max(0, LibrarySelectedCount + (card.IsSelected ? 1 : -1));
        if (LibrarySelectedCount > 0)
        {
            int scenes = LibraryWallpapers.Count(c => c.IsSelected && c.IsScene);
            int videos = LibrarySelectedCount - scenes;
            string detail = scenes == 0 ? $"{videos} video"
                : videos == 0 ? $"{scenes} scene"
                : $"{videos} video, {scenes} scene";
            StatusMessage = $"{LibrarySelectedCount} selected — {detail}";
        }
        else
        {
            StatusMessage = "";
            RefreshPlayingStatus();
        }
    }

    private int GetEffectiveIntervalSeconds() =>
        OverrideGlobalSettings ? GetIntervalSeconds() : _settings.GlobalIntervalSeconds;

    private bool GetEffectiveAdvanceOnVideoEnd() =>
        OverrideGlobalSettings ? AdvanceOnVideoEnd : _settings.GlobalAdvanceOnVideoEnd;

    private bool GetEffectiveWaitForVideoEnd() =>
        OverrideGlobalSettings ? PlaylistWaitForVideoEnd : _settings.GlobalWaitForVideoEnd;

    partial void OnCurrentPlaylistNameChanged(string? value) => SavePlaylistStateDebounced();

    private bool IsRunningCustomPlaylist(IReadOnlyList<string> sessionPaths)
    {
        var customPaths = new HashSet<string>(PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath));
        return customPaths.Count > 0 && customPaths.Count == sessionPaths.Count
            && sessionPaths.All(p => customPaths.Contains(p));
    }

    private void ApplyEffectivePlaylistSettingsIfRunning()
    {
        if (!PlayerHelper.IsPlaying) return;
        var s = _settings.LastSession;
        if (s == null || (!s.IsTimedPlaylist && !s.IsPlaylist)) return;

        bool advanceOnEnd = GetEffectiveAdvanceOnVideoEnd();
        // Mixed playlists (scenes + videos) use timed machinery internally regardless of how
        // LastSession was tagged (legacy IsPlaylist=true vs new IsTimedPlaylist=true).
        // Detect via scene presence so live updates apply in both cases.
        bool hasScenes = s.Paths.Any(p => p.EndsWith(".scene", StringComparison.OrdinalIgnoreCase));
        bool isTimedMode = s.IsTimedPlaylist || (s.IsPlaylist && PlayerHelper.IsTimedModeActive);

        if (isTimedMode && (!advanceOnEnd || hasScenes || GetEffectiveIntervalSeconds() > 0))
        {
            // Timed or mixed or combined (advance-on-end + interval): propagate changes live.
            int secs = GetEffectiveIntervalSeconds();
            if (secs > 0) PlayerHelper.UpdateTimedSettings(PlaylistShuffle, secs, GetEffectiveWaitForVideoEnd(),
                advanceOnVideoEnd: advanceOnEnd);
            return;
        }

        if (isTimedMode && advanceOnEnd && !hasScenes)
        {
            // Pure advance-on-end (no interval) — already in correct mode
            return;
        }

        // Mode changed — switch in place via IPC (no mpvpaper restart)
        var paths = s.Paths;
        if (paths.Count == 0) return;
        if (advanceOnEnd)
        {
            if (paths.Any(p => p.EndsWith(".scene", StringComparison.OrdinalIgnoreCase)))
            {
                // Mixed playlist: full restart so the scene-aware timed machinery is used
                PlayerHelper.ApplyPlaylist(paths, _settings.BuildMpvPlaylistOptions(), PlaylistShuffle, GetEffectiveIntervalSeconds());
            }
            else
            {
                PlayerHelper.SwitchFromTimedToAdvanceOnEnd(paths, PlaylistShuffle);
            }
            // ApplyPlaylist's mixed-playlist path upgrades to ApplyTimedPlaylist — record accordingly.
            if (PlayerHelper.IsTimedPlaylistActive())
                _settings.LastSession = new LastSession
                {
                    IsTimedPlaylist = true,
                    Paths = paths,
                    Shuffle = PlaylistShuffle,
                    TimedIntervalSeconds = GetEffectiveIntervalSeconds(),
                    WaitForVideoEnd = true,
                    AdvanceOnVideoEnd = true,
                    OverrideGlobalSettings = OverrideGlobalSettings
                };
            else
                _settings.LastSession = new LastSession { IsPlaylist = true, Paths = paths, Shuffle = PlaylistShuffle, AdvanceOnVideoEnd = true, OverrideGlobalSettings = OverrideGlobalSettings };
        }
        else
        {
            int secs = GetEffectiveIntervalSeconds();
            if (secs == 0) return;
            bool waitForVideoEnd = GetEffectiveWaitForVideoEnd();
            var playPaths = PlaylistShuffle ? paths.OrderBy(_ => Guid.NewGuid()).ToList() : new List<string>(paths);
            PlayerHelper.SwitchFromAdvanceOnEndToTimed(playPaths, _settings.BuildMpvOptions(), PlaylistShuffle, secs, waitForVideoEnd);
            _settings.LastSession = new LastSession { IsTimedPlaylist = true, Paths = paths, Shuffle = PlaylistShuffle, TimedIntervalSeconds = secs, WaitForVideoEnd = waitForVideoEnd, AdvanceOnVideoEnd = false, OverrideGlobalSettings = OverrideGlobalSettings };
        }
        SettingsService.Save(_settings);
    }

    // Refresh LastSession when settings change while nothing is playing.
    // Mirrors ApplyEffectivePlaylistSettingsIfRunning's role for the idle case.
    private void RefreshLastSessionFromSettingsIfIdle()
    {
        if (PlayerHelper.IsPlaying) return;
        var s = _settings.LastSession;
        if (s == null) return;
        if (!s.IsTimedPlaylist && !s.IsPlaylist) return;

        bool useOverride = s.OverrideGlobalSettings;
        var currentPaths = PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath)
            .ToList();
        bool matchesStrip = currentPaths.Count > 0 && currentPaths.SequenceEqual(s.Paths);

        if (useOverride && !matchesStrip) return;
        if (matchesStrip) useOverride = OverrideGlobalSettings;

        int newSecs = useOverride ? GetIntervalSeconds() : _settings.GlobalIntervalSeconds;
        bool newAdvance = useOverride ? AdvanceOnVideoEnd : _settings.GlobalAdvanceOnVideoEnd;
        bool newWait = useOverride ? PlaylistWaitForVideoEnd : _settings.GlobalWaitForVideoEnd;

        bool hasScenes = s.Paths.Any(p => p.EndsWith(".scene", StringComparison.OrdinalIgnoreCase));
        // Pure advance-on-end (no interval, no scenes) is stored as IsPlaylist=true.
        // Combined (advance + interval) or timed-only are stored as IsTimedPlaylist=true.
        bool isPlaylist = newAdvance && !hasScenes && newSecs == 0;

        _settings.LastSession = new LastSession
        {
            IsPlaylist = isPlaylist,
            IsTimedPlaylist = !isPlaylist,
            Paths = s.Paths,
            Shuffle = s.Shuffle,
            TimedIntervalSeconds = newSecs,
            WaitForVideoEnd = newWait,
            AdvanceOnVideoEnd = newAdvance,
            OverrideGlobalSettings = useOverride
        };
        SettingsService.Save(_settings);
    }

    private void ApplyShuffleOrderIfRunning(bool shuffle)
    {
        if (!PlayerHelper.IsPlaying) return;
        var s = _settings.LastSession;
        if (s == null || (!s.IsTimedPlaylist && !s.IsPlaylist)) return;
        if (!IsRunningCustomPlaylist(s.Paths)) return;
        if (s.Paths.Count <= 1) return;
        var paths = s.Paths; // canonical unshuffled order
        Task.Run(() => PlayerHelper.ReorderPlaylist(paths, s.IsTimedPlaylist, shuffle));
    }

    // ── Library filter / sort ─────────────────────────────────────────────

    [ObservableProperty] private string _librarySearchQuery = "";
    [ObservableProperty] private int _librarySortIndex = 5;
    [ObservableProperty] private List<WallpaperCardViewModel> _filteredLibraryWallpapers = [];
    private string _activeSearchQuery = "";
    private CancellationTokenSource? _searchDebounceCts;

    private void UpdateFilteredLibrary()
    {
        FilteredLibraryWallpapers = ApplyLibraryFilter(LibraryWallpapers, _activeSearchQuery, LibrarySortIndex).ToList();
    }

    partial void OnLibrarySearchQueryChanged(string value)
    {
        var token = RenewCts(ref _searchDebounceCts).Token;
        var trimmed = value.Trim();
        Task.Run(async () =>
        {
            try
            {
                await Task.Delay(200, token);
                if (token.IsCancellationRequested) return;
                await Dispatcher.UIThread.InvokeAsync(() =>
                {
                    if (token.IsCancellationRequested) return;
                    _activeSearchQuery = trimmed;
                    UpdateFilteredLibrary();
                });
            }
            catch (OperationCanceledException) { }
        });
    }

    partial void OnLibrarySortIndexChanged(int value)
    {
        UpdateFilteredLibrary();
        _settings.LibrarySortIndex = value;
        SettingsService.Save(_settings);
    }

    [RelayCommand]
    private void SetLibrarySort(string index)
    {
        if (int.TryParse(index, out int i)) LibrarySortIndex = i;
    }

    // ── Browse sort / auto-search ─────────────────────────────────────────

    [ObservableProperty] private int _browseSortIndex = 0;
    private CancellationTokenSource? _browseSearchDebounceCts;

    partial void OnBrowseSortIndexChanged(int value)
    {
        if (SelectedSource.SupportsSorting)
        {
            if (_isSearchMode && !string.IsNullOrWhiteSpace(SearchQuery))
                _ = SearchAsync();
            else
                _ = LoadWallpapersAsync();
        }
    }

    [RelayCommand]
    private void SetBrowseSort(string index)
    {
        if (int.TryParse(index, out int i)) BrowseSortIndex = i;
    }

    // ── Workshop filter ───────────────────────────────────────────────────

    private static string AnyToEmpty(string s) => s == "Any" ? "" : s;

    private WorkshopFilter BuildWorkshopFilter() => new()
    {
        Sort = WorkshopSort,
        TrendDays = WorkshopTrendDays,
        Type = AnyToEmpty(WorkshopFilterTypeDisplay),
        AgeRating = AnyToEmpty(WorkshopFilterAgeRatingDisplay),
        Resolution = AnyToEmpty(WorkshopFilterResolutionDisplay),
        Genres = new System.Collections.Generic.HashSet<string>(
            WorkshopGenres.Where(g => g.IsSelected).Select(g => g.Name)),
        Features = new System.Collections.Generic.HashSet<string>(
            WorkshopFeatures.Where(f => f.IsSelected).Select(f => f.Name))
    };

    public bool WorkshopHasActiveFilters =>
        WorkshopSort != "trend" || WorkshopTrendDays != 7 ||
        WorkshopFilterTypeDisplay != "Any" ||
        WorkshopFilterAgeRatingDisplay != "Any" ||
        WorkshopFilterResolutionDisplay != "Any" ||
        WorkshopGenres.Any(g => g.IsSelected) ||
        WorkshopFeatures.Any(f => f.IsSelected);

    [RelayCommand]
    private void ApplyWorkshopFilter()
    {
        if (SelectedSource is not SteamWorkshopService service) return;
        service.Filter = BuildWorkshopFilter();
        _ = LoadWallpapersAsync();
    }

    [RelayCommand]
    private void ClearWorkshopFilter()
    {
        WorkshopSortDisplay = "Most Popular";
        WorkshopTrendPeriodDisplay = "This Week";
        WorkshopFilterTypeDisplay = "Any";
        WorkshopFilterAgeRatingDisplay = "Any";
        WorkshopFilterResolutionDisplay = "Any";
        foreach (var g in WorkshopGenres) g.IsSelected = false;
        foreach (var f in WorkshopFeatures) f.IsSelected = false;
        if (SelectedSource is SteamWorkshopService service)
        {
            service.Filter = new WorkshopFilter();
            _ = LoadWallpapersAsync();
        }
    }

    [RelayCommand]
    private void SignInToSteam()
    {
        string? exe = WorkshopDownloader.FindSteamCmd(SteamCmdPath);
        if (string.IsNullOrEmpty(exe))
        {
            ErrorTitle = "steamcmd Not Found";
            ErrorMessage = "Could not locate steamcmd. Install it (e.g. 'sudo pacman -S steamcmd' or 'sudo apt install steamcmd') and set the path in Settings.";
            return;
        }
        if (string.IsNullOrEmpty(SteamUsername))
        {
            ErrorTitle = "Steam Username Required";
            ErrorMessage = "Enter your Steam username in the field above before signing in.";
            return;
        }
        WorkshopDownloader.LaunchSteamCmdSignIn(exe, SteamUsername);
    }

    // ── Steam QR sign-in (subscribe mode) ───────────────────────────────────
    [ObservableProperty] private bool _isSteamQrOpen;
    [ObservableProperty] private Avalonia.Media.Imaging.Bitmap? _steamQrImage;
    [ObservableProperty] private string _steamQrStatus = "";
    public bool IsSteamSignedIn => !string.IsNullOrEmpty(_settings.SteamRefreshToken);
    public string SteamSignInLabel
    {
        get
        {
            if (!IsSteamSignedIn) return "Not signed in";
            var name = _settings.SteamAccountName.Length > 0 ? _settings.SteamAccountName : "Steam user";
            var days = SteamAuthService.RefreshTokenDaysRemaining(_settings);
            return days is int d ? $"Signed in as {name} · session ~{d}d left" : $"Signed in as {name}";
        }
    }

    // ── Workshop unsubscribe drain (Delete from Source) ─────────────────────
    [ObservableProperty] private bool _isUnsubDraining;
    [ObservableProperty] private string _unsubProgress = "";
    private CancellationTokenSource? _unsubCts;

    public bool HasPendingUnsub => WorkshopUnsubQueue.HasPending();

    /// Foreground drain (shown with the "please wait" modal) — used at close. Returns when the queue
    /// is empty or the user hit Finish later (cancel); the queue persists either way.
    public async Task DrainUnsubForegroundAsync()
    {
        if (!WorkshopUnsubQueue.HasPending()) return;
        _unsubCts = new CancellationTokenSource();
        IsUnsubDraining = true;
        var progress = new Progress<(int Done, int Total)>(t =>
            UnsubProgress = $"Unsubscribing {t.Done} / {t.Total}…");
        try { await WorkshopDownloader.DrainUnsubQueueAsync(_settings, progress, _unsubCts.Token); }
        catch { }
        finally { IsUnsubDraining = false; }
    }

    [RelayCommand]
    private void FinishUnsubLater() => _unsubCts?.Cancel();

    // Silent background drain — used at launch to clear anything left from a prior force-quit.
    private void DrainUnsubInBackground()
    {
        if (!WorkshopUnsubQueue.HasPending()) return;
        _ = Task.Run(async () =>
        {
            try { await WorkshopDownloader.DrainUnsubQueueAsync(_settings, null, CancellationToken.None); }
            catch { }
        });
    }

    private CancellationTokenSource? _steamQrCts;

    [RelayCommand]
    private async Task SignInWithQr()
    {
        _steamQrCts = new CancellationTokenSource();
        SteamQrImage = null;
        SteamQrStatus = "Connecting to Steam…";
        IsSteamQrOpen = true;
        try
        {
            var (refreshToken, steamId, accountName) = await SteamAuthService.LoginViaQrAsync(
                url => Dispatcher.UIThread.Post(() =>
                {
                    SteamQrImage = RenderQrBitmap(url);
                    SteamQrStatus = "Scan with the Steam mobile app";
                }),
                _steamQrCts.Token);

            _settings.SteamRefreshToken = refreshToken;
            _settings.SteamId = steamId;
            _settings.SteamAccountName = accountName;
            _settings.SteamAccessToken = ""; // force a fresh mint on first use
            SettingsService.Save(_settings);
            OnPropertyChanged(nameof(IsSteamSignedIn));
            OnPropertyChanged(nameof(SteamSignInLabel));
            StatusMessage = $"Signed in to Steam as {accountName}";
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            ErrorTitle = "Steam Sign-In Failed";
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsSteamQrOpen = false;
            SteamQrImage = null;
        }
    }

    [RelayCommand]
    private void CancelSteamQr()
    {
        _steamQrCts?.Cancel();
        IsSteamQrOpen = false;
    }

    [RelayCommand]
    private void SignOutSteam()
    {
        _settings.SteamRefreshToken = "";
        _settings.SteamId = 0;
        _settings.SteamAccessToken = "";
        _settings.SteamAccountName = "";
        SettingsService.Save(_settings);
        OnPropertyChanged(nameof(IsSteamSignedIn));
        OnPropertyChanged(nameof(SteamSignInLabel));
    }

    private static Avalonia.Media.Imaging.Bitmap RenderQrBitmap(string url)
    {
        var gen = new QRCoder.QRCodeGenerator();
        var data = gen.CreateQrCode(url, QRCoder.QRCodeGenerator.ECCLevel.M);
        var png = new QRCoder.PngByteQRCode(data).GetGraphic(8);
        return new Avalonia.Media.Imaging.Bitmap(new MemoryStream(png));
    }

    partial void OnSearchQueryChanged(string value)
    {
        if (!SelectedSource.SupportsSearch) return;
        var token = RenewCts(ref _browseSearchDebounceCts).Token;
        var trimmed = value.Trim();
        Task.Run(async () =>
        {
            try
            {
                await Task.Delay(200, token);
                Dispatcher.UIThread.Post(() =>
                {
                    if (token.IsCancellationRequested) return;
                    if (string.IsNullOrEmpty(trimmed))
                        _ = LoadWallpapersAsync();
                    else
                        _ = SearchAsync();
                });
            }
            catch (OperationCanceledException) { }
        });
    }

    private static IEnumerable<WallpaperCardViewModel> ApplyLibraryFilter(
        IEnumerable<WallpaperCardViewModel> source, string query, int sortIndex)
    {
        var filtered = string.IsNullOrEmpty(query)
            ? source
            : source.Where(c =>
                c.Title.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                (c.LibraryItem?.WorkshopId != null &&
                 c.LibraryItem.WorkshopId.Contains(query, StringComparison.OrdinalIgnoreCase)));

        return sortIndex switch
        {
            1 => filtered.OrderByDescending(c => c.Title),
            2 => filtered.OrderBy(c => c.IsScene).ThenBy(c => c.Title),
            3 => filtered.OrderByDescending(c => c.IsScene).ThenBy(c => c.Title),
            4 => filtered.OrderByDescending(c =>
                c.LibraryItem != null ? c.LibraryItem.AddedAt : DateTime.MinValue),
            5 => filtered.OrderBy(c =>
                c.LibraryItem != null ? c.LibraryItem.AddedAt : DateTime.MaxValue),
            _ => filtered.OrderBy(c => c.Title),
        };
    }

    private int _lastSelectedIndex = -1;
    private int _lastBrowseSelectedIndex = -1;
    private WallpaperCardViewModel? _currentlyPlayingCard;
    private bool _suppressFilterUpdate;
    private bool _suppressAutoPlaylistAdd;

    private sealed class UndoBatch
    {
        public required string BatchDir;
        public required List<(WallpaperCardViewModel Card, bool WasInPlaylist)> Items;
    }
    private readonly List<UndoBatch> _undoBatches = [];
    [ObservableProperty] private bool _canUndo;
    public Func<Task<string?>>? PickFolderDialog { get; set; }
    public Func<Task<string?>>? PickVideoDialog { get; set; }
    public Func<string, Task>? CopyToClipboard { get; set; }

    [RelayCommand]
    private async Task CopyText(string text)
    {
        if (CopyToClipboard != null) await CopyToClipboard(text);
    }

    private readonly Models.AppSettings _settings;
    private CancellationTokenSource? _volumeSaveCts;
    private CancellationTokenSource? _playlistSaveCts;
    private CancellationTokenSource? _playlistSyncCts;
    private CancellationTokenSource? _statusClearCts;

    private void SetTimedStatusMessage(string msg, int ms = 5000)
    {
        StatusMessage = msg;
        var cts = RenewCts(ref _statusClearCts);
        Task.Delay(ms, cts.Token).ContinueWith(t =>
        {
            if (t.IsCanceled) return;
            Dispatcher.UIThread.Post(() => StatusMessage = "");
        }, TaskScheduler.Default);
    }
    private bool _isSyncingVolume;
    private bool _isSyncingSpeed;

    private static string PlaylistStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "livepaper", "playlist_state.json");

    public MainWindowViewModel()
    {
        _selectedSource = Sources[0];
        _settings = SettingsService.Load();

#pragma warning disable MVVMTK0034
        _loop = _settings.Loop;
        _noAudio = _settings.NoAudio;
        _disableCache = _settings.DisableCache;
        _demuxerMaxBytes = _settings.DemuxerMaxBytes;
        _demuxerMaxBackBytes = _settings.DemuxerMaxBackBytes;
        _hwDec = _settings.HwDec;
        _selectedTheme = ThemeService.Find(_settings.Theme) ?? ThemeService.Default;
        _videoScale = _settings.VideoScale;
        _thumbnailAspect = _settings.ThumbnailAspect;
        _cardSize = _settings.CardSize;
        _autoPlayGifs = _settings.AutoPlayGifs;
        _librarySortIndex = _settings.LibrarySortIndex;
        _volume = _settings.Volume;
        _speed = _settings.Speed;
        _autoMute = _settings.AutoMute;
        _autoMuteDelayMs = _settings.AutoMuteDelayMs;
        _autoUnmuteDelayMs = _settings.AutoUnmuteDelayMs;
        _autoMuteThresholdDb = (decimal)_settings.AutoMuteThresholdDb;
        _restartIntervalSeconds = _settings.RestartIntervalSeconds;
        _autoMuteOnlyIfMprisActive = _settings.AutoMuteOnlyIfMprisActive;
        var gSecs = _settings.GlobalIntervalSeconds;
        _globalIntervalHours = gSecs / 3600;
        _globalIntervalMinutes = (gSecs % 3600) / 60;
        _globalIntervalSeconds = gSecs % 60;
        _globalAdvanceOnVideoEnd = _settings.GlobalAdvanceOnVideoEnd;
        _globalWaitForVideoEnd = _settings.GlobalWaitForVideoEnd;
        _playlistWaitForVideoEnd = _settings.PlaylistWaitForVideoEnd;
        _autoAddLibraryToPlaylist = _settings.AutoAddLibraryToPlaylist;
        _autoImportWallpaperEngine = _settings.AutoImportWallpaperEngine;
        _isPlaylistCollapsed = _settings.IsPlaylistCollapsed;
        _wallpaperEnginePath = _settings.WallpaperEnginePath;
        _weCopyFiles = _settings.WeCopyFiles;
        _resumeFromLast = _settings.ResumeFromLast;
        _allowScenes = _settings.AllowScenes;
        _sceneTransitionDelayMs = _settings.SceneTransitionDelayMs;
        foreach (var m in _settings.LweMonitors)
        {
            var vm = new LweMonitorViewModel(m.Name, _lweMonitors.Count) { Fps = m.Fps, IsPrimary = m.IsPrimary };
            _lweMonitors.Add(vm);
        }
        if (_lweMonitors.Count > 0)
        {
            _selectedLweMonitor = _lweMonitors[0];
            _selectedMonitorFps = _lweMonitors[0].Fps;
            _selectedMonitorIsPrimary = _lweMonitors[0].IsPrimary;
        }
        _mpvOptionsPreview = _settings.BuildMpvOptions();
        _workshopAcquireMode = _settings.WorkshopAcquireMode;
        _steamLoginSecure = _settings.SteamLoginSecure;
        _steamCmdPath = _settings.SteamCmdPath;
        _steamUsername = _settings.SteamUsername;

        var weService = (WallpaperEngineService)Sources.First(s => s is WallpaperEngineService);
        weService.WorkshopPath = _settings.WallpaperEnginePath;
        weService.AllowScenes = _settings.AllowScenes;

        var wsService = (SteamWorkshopService)Sources.First(s => s is SteamWorkshopService);
        wsService.AllowScenes = _settings.AllowScenes;
        wsService.WorkshopBasePath = _settings.WallpaperEnginePath;
#pragma warning restore MVVMTK0034

        foreach (var genre in WorkshopGenres)
            genre.PropertyChanged += (_, _) => OnPropertyChanged(nameof(WorkshopHasActiveFilters));
        foreach (var feature in WorkshopFeatures)
            feature.PropertyChanged += (_, _) => OnPropertyChanged(nameof(WorkshopHasActiveFilters));

        LibraryService.CleanTrash();

        if (_settings.AutoMute)
            AudioMonitor.Start(_settings.AutoMuteDelayMs, _settings.AutoUnmuteDelayMs, _settings.AutoMuteThresholdDb, _settings.AutoMuteOnlyIfMprisActive);

        BrowseWallpapers.CollectionChanged += (_, e) =>
        {
            if (e.NewItems != null)
                foreach (WallpaperCardViewModel c in e.NewItems) c.PropertyChanged += OnBrowseCardChanged;
            if (e.OldItems != null)
                foreach (WallpaperCardViewModel c in e.OldItems) c.PropertyChanged -= OnBrowseCardChanged;
            BrowseSelectedCount = BrowseWallpapers.Count(c => c.IsSelected);
        };
        LibraryWallpapers.CollectionChanged += (_, e) =>
        {
            if (e.NewItems != null)
                foreach (WallpaperCardViewModel c in e.NewItems) c.PropertyChanged += OnLibraryCardChanged;
            if (e.OldItems != null)
                foreach (WallpaperCardViewModel c in e.OldItems) c.PropertyChanged -= OnLibraryCardChanged;
            LibrarySelectedCount = LibraryWallpapers.Count(c => c.IsSelected);
            if (!_suppressFilterUpdate) UpdateFilteredLibrary();
            if (!_suppressAutoPlaylistAdd && AutoAddLibraryToPlaylist && e.NewItems != null)
            {
                var injected = new List<string>();
                foreach (WallpaperCardViewModel c in e.NewItems)
                {
                    if (c.LibraryItem == null || c.IsInPlaylist) continue;
                    AddCardToPlaylist(c);
                    injected.Add(c.LibraryItem.VideoPath);
                }
                if (injected.Count > 0) PlayerHelper.AppendToActivePlaylist(injected);
            }
        };

        PlaylistItems.CollectionChanged += (_, _) =>
        {
            IsPlaylistEmpty = PlaylistItems.Count == 0;
            SavePlaylistStateDebounced();
            SyncPlaylistToPlayerIfRunning();
            RefreshPlayingStatus();
        };

        PlayerHelper.OnTimedPlaylistStopped = () =>
            Dispatcher.UIThread.Post(() => StatusMessage = "");


        PlayerHelper.OnWallpaperChanged = path =>
            Dispatcher.UIThread.Post(() =>
            {
                if (_currentlyPlayingCard != null) _currentlyPlayingCard.IsCurrentlyPlaying = false;
                _currentlyPlayingCard = path == null ? null
                    : LibraryWallpapers.FirstOrDefault(c => c.LibraryItem?.VideoPath == path);
                if (_currentlyPlayingCard != null) _currentlyPlayingCard.IsCurrentlyPlaying = true;
                RefreshPlayingStatus();
            });

        PlayerHelper.OnSceneCrashed = path => Dispatcher.UIThread.Post(() =>
        {
            var card = LibraryWallpapers.FirstOrDefault(c => c.LibraryItem?.VideoPath == path);
            if (card == null) return;
            LibraryService.MarkCrashed(path);
            card.HasCrashed = true;
            if (!card.IsWhitelisted && card.IsInPlaylist)
            {
                PlaylistItems.Remove(card);
                card.IsInPlaylist = false;
            }
        });

        List<string> newWePaths = [];
        if (AutoImportWallpaperEngine)
            newWePaths = LibraryService.SyncWallpaperEngine(
                _settings.WallpaperEnginePath, _settings.AllowScenes, _settings.WeCopyFiles);

        _suppressAutoPlaylistAdd = true;
        LoadLibrary();
        UpdateFilteredLibrary();
        RestorePlaylistState();
        _suppressAutoPlaylistAdd = false;

        if (AutoAddLibraryToPlaylist && newWePaths.Count > 0)
        {
            var injected = new List<string>();
            foreach (var p in newWePaths)
            {
                var card = LibraryWallpapers.FirstOrDefault(c => c.LibraryItem?.VideoPath == p);
                if (card == null || card.IsInPlaylist) continue;
                AddCardToPlaylist(card);
                injected.Add(p);
            }
            if (injected.Count > 0)
            {
                PlayerHelper.AppendToActivePlaylist(injected);
                var session = _settings.LastSession;
                if (session != null && (session.IsPlaylist || session.IsTimedPlaylist))
                {
                    var existing = new HashSet<string>(session.Paths);
                    foreach (var p in injected)
                        if (existing.Add(p)) session.Paths.Add(p);
                    SettingsService.Save(_settings);
                }
            }
        }

        // Pre-warm the Steam access token in the background so the first workshop subscribe of the
        // session is instant (the ~1-3s mint happens here at launch, not on the user's first click).
        if (_settings.WorkshopAcquireMode == "subscribe" && !string.IsNullOrEmpty(_settings.SteamRefreshToken))
            _ = Task.Run(async () => { try { await SteamAuthService.GetCookieAsync(_settings); } catch { } });

        // Resume any unsubscribe queue left over from a prior force-quit (silent background drain).
        DrainUnsubInBackground();

        var s = _settings.LastSession;
        if (s != null && PlayerHelper.IsPlaying)
        {
            if (s.IsTimedPlaylist) PlayerHelper.ResumeTimedTimer();
            // Highlight the wallpaper that was already playing before the GUI opened (daemon-resumed).
            // OnWallpaperChanged isn't fired in this process for sessions launched by the daemon.
            var currentPath = s.Paths.Count == 1 ? s.Paths[0] : PlayerHelper.QueryCurrentPath();
            WallpaperCardViewModel? playing = null;
            if (currentPath != null)
                playing = LibraryWallpapers.FirstOrDefault(c => c.LibraryItem?.VideoPath == currentPath);
            if (playing == null)
            {
                var workshopId = PlayerHelper.QueryCurrentSceneWorkshopId();
                if (workshopId != null)
                    playing = LibraryWallpapers.FirstOrDefault(c => c.WorkshopId == workshopId);
            }
            if (playing != null)
            {
                playing.IsCurrentlyPlaying = true;
                _currentlyPlayingCard = playing;
            }
            RefreshPlayingStatus();
            PlayerHelper.UpdateRestartTimer();
        }
    }

    // Settings change handlers
    partial void OnLoopChanged(bool value)
    {
        SaveAndRebuild();
        if (PlayerHelper.IsPlaying && _settings.LastSession?.IsPlaylist != true && _settings.LastSession?.IsTimedPlaylist != true)
            Task.Run(() => PlayerHelper.SetLoop(value));
        RefreshPlayingStatus();
    }
    partial void OnNoAudioChanged(bool value)
    {
        SaveAndRebuild();
        Task.Run(() => PlayerHelper.SetMute(value));
        RefreshPlayingStatus();
    }
    partial void OnDisableCacheChanged(bool value) => SaveAndRebuild();
    partial void OnDemuxerMaxBytesChanged(int value) => SaveAndRebuild();
    partial void OnDemuxerMaxBackBytesChanged(int value) => SaveAndRebuild();
    partial void OnHwDecChanged(string value) => SaveAndRebuild();
    partial void OnSelectedThemeChanged(AppTheme value)
    {
        ThemeService.Apply(value);
        _settings.Theme = value.Name;
        SettingsService.Save(_settings);
    }
    partial void OnVideoScaleChanged(string value) { Task.Run(() => PlayerHelper.SetVideoScale(value)); SaveAndRebuild(); }
    partial void OnThumbnailAspectChanged(string value)
    {
        CardLayoutChanged?.Invoke();
        _settings.ThumbnailAspect = value;
        SettingsService.Save(_settings);
    }
    partial void OnCardSizeChanged(string value)
    {
        CardLayoutChanged?.Invoke();
        _settings.CardSize = value;
        SettingsService.Save(_settings);
    }
    partial void OnAutoPlayGifsChanged(bool value)
    {
        _settings.AutoPlayGifs = value;
        SettingsService.Save(_settings);
        if (!value)
        {
            foreach (var c in LibraryWallpapers)
            {
                if (!c.IsGifThumbnail) continue;
                c.IsGifActive = false;
                c.LoadStaticThumbnailAsync();
            }
            foreach (var c in BrowseWallpapers)
                if (c.IsGifThumbnail) c.IsGifActive = false;
            foreach (var c in PlaylistItems)
                if (c.IsGifThumbnail) c.IsPlaylistGifActive = false;
        }
    }
    partial void OnVolumeChanged(int value)
    {
        if (LibraryWallpapers.FirstOrDefault(c => c.IsCurrentlyPlaying)?.VolumeOverride == null)
            Task.Run(() => PlayerHelper.SetVolume(value));
        foreach (var c in LibraryWallpapers)
            c.UpdateGlobalVolume(value);

        var cts = RenewCts(ref _volumeSaveCts);
        Task.Delay(400, cts.Token).ContinueWith(t =>
        {
            if (!t.IsCanceled) Dispatcher.UIThread.Post(SaveAndRebuild);
        }, TaskScheduler.Default);
    }

    partial void OnSpeedChanged(double value)
    {
        if (LibraryWallpapers.FirstOrDefault(c => c.IsCurrentlyPlaying)?.SpeedOverride == null)
            Task.Run(() => PlayerHelper.SetSpeed(value));
        foreach (var c in LibraryWallpapers)
            c.UpdateGlobalSpeed(value);
        _settings.Speed = value;
        SettingsService.Save(_settings);
    }

    private void SaveAndRebuild()
    {
        _settings.Loop = Loop;
        _settings.NoAudio = NoAudio;
        _settings.DisableCache = DisableCache;
        _settings.DemuxerMaxBytes = DemuxerMaxBytes;
        _settings.DemuxerMaxBackBytes = DemuxerMaxBackBytes;
        _settings.HwDec = HwDec;
        _settings.VideoScale = VideoScale;
        _settings.Volume = Volume;
        _settings.Speed = Speed;
        MpvOptionsPreview = _settings.BuildMpvOptions();
        SettingsService.Save(_settings);
    }

    [RelayCommand]
    private void ResetMpvOptions()
    {
        var d = Models.AppSettings.Default();
        Loop = d.Loop;
        NoAudio = d.NoAudio;
        DisableCache = d.DisableCache;
        DemuxerMaxBytes = d.DemuxerMaxBytes;
        DemuxerMaxBackBytes = d.DemuxerMaxBackBytes;
        HwDec = d.HwDec;
        VideoScale = d.VideoScale;
        Volume = d.Volume;
        Speed = d.Speed;
        AutoMute = d.AutoMute;
        AutoMuteDelayMs = d.AutoMuteDelayMs;
        AutoUnmuteDelayMs = d.AutoUnmuteDelayMs;
        AutoMuteThresholdDb = (decimal)d.AutoMuteThresholdDb;
        RestartIntervalSeconds = d.RestartIntervalSeconds;
        _settings.RestartIntervalSeconds = d.RestartIntervalSeconds;
        SettingsService.Save(_settings);
        PlayerHelper.UpdateRestartTimer();
        AutoMuteOnlyIfMprisActive = d.AutoMuteOnlyIfMprisActive;
    }

    // ── Playlist ──────────────────────────────────────────────────────────

    [RelayCommand]
    private void ToggleInPlaylist(WallpaperCardViewModel card)
    {
        if (card.IsSelected && LibrarySelectedCount > 0)
        {
            bool adding = !card.IsInPlaylist;
            foreach (var c in LibraryWallpapers.Where(c => c.IsSelected).ToList())
            {
                if (adding && !c.IsInPlaylist && c.LibraryItem != null)
                    AddCardToPlaylist(c);
                else if (!adding && c.IsInPlaylist)
                    RemoveFromPlaylist(c);
            }
        }
        else
        {
            if (card.LibraryItem == null) return;
            if (card.IsInPlaylist)
            {
                RemoveFromPlaylist(card);
            }
            else
            {
                AddCardToPlaylist(card);
            }
        }
    }

    [RelayCommand]
    private void RemoveFromPlaylist(WallpaperCardViewModel card)
    {
        PlaylistItems.Remove(card);
        card.IsInPlaylist = false;
        card.IsPlaylistGifActive = false;
    }

    private void AddCardToPlaylist(WallpaperCardViewModel card)
    {
        PlaylistItems.Add(card);
        card.IsInPlaylist = true;
        if (AutoPlayGifs && card.IsAutoPlayGif) card.IsPlaylistGifActive = true;
    }

    private CancellationTokenSource RenewCts(ref CancellationTokenSource? field)
    {
        field?.Cancel();
        field?.Dispose();
        return field = new CancellationTokenSource();
    }

    [RelayCommand]
    private void AddSelectedToPlaylist()
    {
        var toAdd = LibraryWallpapers
            .Where(c => c.IsSelected && c.LibraryItem != null && !c.IsInPlaylist)
            .ToList();
        foreach (var c in toAdd)
            AddCardToPlaylist(c);
        ClearLibrarySelection();
    }

    [RelayCommand]
    private void RemoveSelectedFromPlaylist()
    {
        var toRemove = LibraryWallpapers
            .Where(c => c.IsSelected && c.IsInPlaylist)
            .ToList();
        foreach (var c in toRemove)
            RemoveFromPlaylist(c);
        ClearLibrarySelection();
    }

    [RelayCommand]
    private void ClearBrowseSelection()
    {
        foreach (var c in BrowseWallpapers) c.IsSelected = false;
        _lastBrowseSelectedIndex = -1;
    }

    [RelayCommand]
    private void ClearLibrarySelection()
    {
        foreach (var c in LibraryWallpapers) c.IsSelected = false;
        _lastSelectedIndex = -1;
    }

    [RelayCommand]
    private void PlayCustomPlaylist()
    {
        if (PlaylistItems.Count == 0)
        {
            StatusMessage = "Playlist is empty";
            return;
        }
        var paths = PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath)
            .ToList();
        if (paths.Count == 0) return;

        int intervalSecs = GetEffectiveIntervalSeconds();
        bool waitForVideoEnd = GetEffectiveWaitForVideoEnd();

        if (GetEffectiveAdvanceOnVideoEnd())
        {
            if (intervalSecs > 0)
            {
                // Combined mode: switch on video-end, with interval as a fallback.
                var playPaths = PlaylistShuffle ? paths.OrderBy(_ => Guid.NewGuid()).ToList() : paths;
                PlayerHelper.ApplyTimedPlaylist(playPaths, _settings.BuildMpvOptions(), PlaylistShuffle,
                    intervalSecs, waitForVideoEnd, advanceOnVideoEnd: true);
                _settings.LastSession = new LastSession
                {
                    IsTimedPlaylist = true, Paths = paths, Shuffle = PlaylistShuffle,
                    TimedIntervalSeconds = intervalSecs, WaitForVideoEnd = waitForVideoEnd,
                    AdvanceOnVideoEnd = true, OverrideGlobalSettings = OverrideGlobalSettings
                };
                SettingsService.Save(_settings);
                RefreshPlayingStatusSoon();
                return;
            }

            // Pure advance-on-end (no interval): use ApplyPlaylist.
            // May internally upgrade to ApplyTimedPlaylist when scenes are present.
            PlayerHelper.ApplyPlaylist(paths, _settings.BuildMpvPlaylistOptions(), PlaylistShuffle, 0);
            if (PlayerHelper.IsTimedPlaylistActive())
                _settings.LastSession = new LastSession
                {
                    IsTimedPlaylist = true,
                    Paths = paths,
                    Shuffle = PlaylistShuffle,
                    TimedIntervalSeconds = 0,
                    WaitForVideoEnd = true,
                    AdvanceOnVideoEnd = true,
                    OverrideGlobalSettings = OverrideGlobalSettings
                };
            else
                _settings.LastSession = new LastSession { IsPlaylist = true, Paths = paths, Shuffle = PlaylistShuffle, AdvanceOnVideoEnd = true, OverrideGlobalSettings = OverrideGlobalSettings };
            SettingsService.Save(_settings);
            RefreshPlayingStatusSoon();
            return;
        }

        if (intervalSecs == 0 && paths.Count > 1)
        {
            StatusMessage = "Set an interval greater than 0 to use timed playlists";
            return;
        }
        var timedPaths = PlaylistShuffle ? paths.OrderBy(_ => Guid.NewGuid()).ToList() : paths;
        PlayerHelper.ApplyTimedPlaylist(timedPaths, _settings.BuildMpvOptions(), PlaylistShuffle, intervalSecs, waitForVideoEnd);
        _settings.LastSession = new LastSession
        {
            IsTimedPlaylist = true,
            Paths = paths,
            Shuffle = PlaylistShuffle,
            TimedIntervalSeconds = intervalSecs,
            WaitForVideoEnd = waitForVideoEnd,
            AdvanceOnVideoEnd = false,
            OverrideGlobalSettings = OverrideGlobalSettings
        };
        SettingsService.Save(_settings);
        RefreshPlayingStatusSoon();
    }

    [RelayCommand]
    private void PlayFromCard(WallpaperCardViewModel card)
    {
        var allPaths = PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath)
            .ToList();
        if (allPaths.Count == 0) return;

        // Clicked card always goes first; rest is shuffled or in playlist order
        int startIdx = PlaylistItems.IndexOf(card);
        var rest = allPaths.Where((_, i) => i != startIdx).ToList();
        if (PlaylistShuffle) rest = rest.OrderBy(_ => Guid.NewGuid()).ToList();
        var paths = new List<string> { allPaths[startIdx] }.Concat(rest).ToList();

        if (GetEffectiveAdvanceOnVideoEnd())
        {
            // Pre-arranged order; pass shuffle=false so mpv plays the clicked card first.
            PlayerHelper.ApplyPlaylist(paths, _settings.BuildMpvPlaylistOptions(), shuffle: false);
            // ApplyPlaylist may upgrade to ApplyTimedPlaylist when scenes present + AllowScenes=true.
            if (PlayerHelper.IsTimedPlaylistActive())
                _settings.LastSession = new LastSession
                {
                    IsTimedPlaylist = true,
                    Paths = paths,
                    Shuffle = PlaylistShuffle,
                    TimedIntervalSeconds = GetEffectiveIntervalSeconds(),
                    WaitForVideoEnd = true,
                    AdvanceOnVideoEnd = true,
                    OverrideGlobalSettings = OverrideGlobalSettings
                };
            else
                _settings.LastSession = new LastSession { IsPlaylist = true, Paths = paths, Shuffle = PlaylistShuffle, AdvanceOnVideoEnd = true, OverrideGlobalSettings = OverrideGlobalSettings };
            SettingsService.Save(_settings);
            RefreshPlayingStatusSoon();
            return;
        }

        int intervalSecs = GetEffectiveIntervalSeconds();
        if (intervalSecs == 0 && allPaths.Count > 1)
        {
            StatusMessage = "Set an interval greater than 0 to use timed playlists";
            return;
        }

        var waitForVideoEnd = GetEffectiveWaitForVideoEnd();
        PlayerHelper.ApplyTimedPlaylist(paths, _settings.BuildMpvOptions(), PlaylistShuffle, intervalSecs, waitForVideoEnd);
        _settings.LastSession = new LastSession
        {
            IsTimedPlaylist = true,
            Paths = allPaths,
            Shuffle = PlaylistShuffle,
            TimedIntervalSeconds = intervalSecs,
            WaitForVideoEnd = waitForVideoEnd,
            AdvanceOnVideoEnd = false,
            OverrideGlobalSettings = OverrideGlobalSettings
        };
        SettingsService.Save(_settings);
        RefreshPlayingStatusSoon();
    }

    public void MovePlaylistItem(int from, int insertionIndex)
    {
        if (from < 0 || from >= PlaylistItems.Count) return;
        if (insertionIndex < 0 || insertionIndex > PlaylistItems.Count) return;
        int insertAt = insertionIndex > from ? insertionIndex - 1 : insertionIndex;
        if (from == insertAt) return;
        var item = PlaylistItems[from];
        PlaylistItems.RemoveAt(from);
        PlaylistItems.Insert(Math.Min(insertAt, PlaylistItems.Count), item);
    }

    private void SavePlaylistStateDebounced()
    {
        // Snapshot everything on the UI thread before any async delay
        var paths = PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath)
            .ToList();
        var shuffle = PlaylistShuffle;
        var secs = GetIntervalSeconds();
        var advance = AdvanceOnVideoEnd;
        var wait = PlaylistWaitForVideoEnd;
        var overrideGlobal = OverrideGlobalSettings;
        var name = CurrentPlaylistName;

        var cts = RenewCts(ref _playlistSaveCts);
        Task.Delay(200, cts.Token).ContinueWith(t =>
        {
            if (!t.IsCanceled) SavePlaylistState(paths, shuffle, secs, advance, wait, overrideGlobal, name);
        }, TaskScheduler.Default);
    }

    private void SyncPlaylistToPlayerIfRunning()
    {
        // Snapshot both old and new paths on the UI thread before the async delay
        var oldPaths = _settings.LastSession?.Paths?.ToList() ?? [];
        var newPaths = PlaylistItems
            .Where(c => c.LibraryItem != null)
            .Select(c => c.LibraryItem!.VideoPath)
            .ToList();
        var shuffle = PlaylistShuffle;

        var cts = RenewCts(ref _playlistSyncCts);
        Task.Delay(100, cts.Token).ContinueWith(t =>
        {
            if (t.IsCanceled) return;
            if (!PlayerHelper.IsPlaying) return;
            var s = _settings.LastSession;
            if (s == null || (!s.IsTimedPlaylist && !s.IsPlaylist)) return;
            if (newPaths.Count == 0) return;
            s.Paths = newPaths;
            SettingsService.Save(_settings);
            if (s.IsTimedPlaylist)
                PlayerHelper.ReorderPlaylist(newPaths, true, shuffle);
            else
                PlayerHelper.SyncAdvanceOnEndPlaylist(oldPaths, newPaths, shuffle);
            Dispatcher.UIThread.Post(() => RefreshPlayingStatus());
        }, TaskScheduler.Default);
    }

    private static void SavePlaylistState(List<string> paths, bool shuffle, int intervalSeconds, bool advanceOnVideoEnd, bool waitForVideoEnd, bool overrideGlobal, string? name)
    {
        try
        {
            var playlist = new CustomPlaylist
            {
                VideoPaths = paths,
                Settings = new PlaylistSettings
                {
                    Order = shuffle ? PlaylistOrder.Shuffle : PlaylistOrder.Sequential,
                    OverrideGlobalSettings = overrideGlobal,
                    IntervalSeconds = intervalSeconds,
                    AdvanceOnVideoEnd = advanceOnVideoEnd,
                    WaitForVideoEnd = waitForVideoEnd
                },
                Name = name
            };
            var path = PlaylistStatePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(playlist, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private void RestorePlaylistState()
    {
        var path = PlaylistStatePath;
        if (!File.Exists(path)) return;
        try
        {
            var playlist = JsonSerializer.Deserialize<CustomPlaylist>(File.ReadAllText(path));
            if (playlist == null) return;
            var byPath = LibraryWallpapers
                .Where(c => c.LibraryItem != null)
                .GroupBy(c => c.LibraryItem!.VideoPath)
                .ToDictionary(g => g.Key, g => g.First());
            foreach (var videoPath in playlist.VideoPaths)
            {
                if (byPath.TryGetValue(videoPath, out var libCard))
                {
                    AddCardToPlaylist(libCard);
                }
            }
            PlaylistShuffle = playlist.Settings.Order == PlaylistOrder.Shuffle;
            int secs = playlist.Settings.IntervalSeconds;
            IntervalHours = secs / 3600;
            IntervalMinutes = (secs % 3600) / 60;
            IntervalSeconds = secs % 60;
            AdvanceOnVideoEnd = playlist.Settings.AdvanceOnVideoEnd;
            PlaylistWaitForVideoEnd = playlist.Settings.WaitForVideoEnd;
            OverrideGlobalSettings = playlist.Settings.OverrideGlobalSettings;
            CurrentPlaylistName = playlist.Name;
        }
        catch { }
    }

    [RelayCommand]
    private void TogglePlaylistSettings() => IsPlaylistSettingsOpen = !IsPlaylistSettingsOpen;

    [RelayCommand]
    private void ClosePlaylistSettings() => IsPlaylistSettingsOpen = false;

    [RelayCommand]
    private void SetSequential() => PlaylistShuffle = false;

    [RelayCommand]
    private void SetShuffle() => PlaylistShuffle = true;

    [RelayCommand]
    private void OpenSavePlaylist()
    {
        AvailablePlaylists = new ObservableCollection<string>(PlaylistService.ListNames());
        SavePlaylistName = CurrentPlaylistName ?? "";
        IsSavePlaylistOpen = true;
    }

    [RelayCommand]
    private void CancelSavePlaylist() => IsSavePlaylistOpen = false;

    [RelayCommand]
    private void ConfirmSavePlaylist()
    {
        var name = SavePlaylistName?.Trim();
        if (string.IsNullOrEmpty(name)) return;

        var playlist = new CustomPlaylist
        {
            VideoPaths = PlaylistItems
                .Where(c => c.LibraryItem != null)
                .Select(c => c.LibraryItem!.VideoPath)
                .ToList(),
            Settings = new PlaylistSettings
            {
                Order = PlaylistShuffle ? PlaylistOrder.Shuffle : PlaylistOrder.Sequential,
                OverrideGlobalSettings = OverrideGlobalSettings,
                IntervalSeconds = GetIntervalSeconds(),
                AdvanceOnVideoEnd = AdvanceOnVideoEnd,
                WaitForVideoEnd = PlaylistWaitForVideoEnd
            }
        };
        try
        {
            PlaylistService.Save(name, playlist);
            CurrentPlaylistName = name;
            StatusMessage = $"Saved playlist \"{name}\"";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to save playlist: {ex.Message}";
        }
        IsSavePlaylistOpen = false;
    }

    [RelayCommand]
    private void OpenLoadPlaylist()
    {
        AvailablePlaylists = new ObservableCollection<string>(PlaylistService.ListNames());
        SelectedPlaylistToLoad = AvailablePlaylists.FirstOrDefault();
        IsLoadPlaylistOpen = true;
    }

    [RelayCommand]
    private void CancelLoadPlaylist() => IsLoadPlaylistOpen = false;

    [RelayCommand]
    private void ConfirmLoadPlaylist()
    {
        var name = SelectedPlaylistToLoad;
        if (string.IsNullOrEmpty(name)) return;

        try
        {
            var playlist = PlaylistService.Load(name);
            if (playlist == null) return;

            foreach (var c in PlaylistItems) { c.IsInPlaylist = false; c.IsPlaylistGifActive = false; }
            PlaylistItems.Clear();

            var byPath = LibraryWallpapers
                .Where(c => c.LibraryItem != null)
                .GroupBy(c => c.LibraryItem!.VideoPath)
                .ToDictionary(g => g.Key, g => g.First());
            foreach (var videoPath in playlist.VideoPaths)
            {
                if (byPath.TryGetValue(videoPath, out var libCard))
                {
                    AddCardToPlaylist(libCard);
                }
            }

            PlaylistShuffle = playlist.Settings.Order == PlaylistOrder.Shuffle;
            int secs = playlist.Settings.IntervalSeconds;
            IntervalHours = secs / 3600;
            IntervalMinutes = (secs % 3600) / 60;
            IntervalSeconds = (decimal)(secs % 60);
            AdvanceOnVideoEnd = playlist.Settings.AdvanceOnVideoEnd;
            PlaylistWaitForVideoEnd = playlist.Settings.WaitForVideoEnd;
            OverrideGlobalSettings = playlist.Settings.OverrideGlobalSettings;

            CurrentPlaylistName = name;
            StatusMessage = $"Loaded playlist \"{name}\" ({PlaylistItems.Count} wallpapers)";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to load playlist: {ex.Message}";
        }
        IsLoadPlaylistOpen = false;
    }

    // ── Selection ─────────────────────────────────────────────────────────

    [RelayCommand]
    private void SelectAll()
    {
        foreach (var c in FilteredLibraryWallpapers) c.IsSelected = true;
        _lastSelectedIndex = FilteredLibraryWallpapers.Count - 1;
    }

    [RelayCommand]
    private void SelectAllBrowse()
    {
        foreach (var c in BrowseWallpapers) c.IsSelected = true;
        _lastBrowseSelectedIndex = BrowseWallpapers.Count - 1;
    }

    public void DeselectAllLibrary()
    {
        foreach (var c in LibraryWallpapers) c.IsSelected = false;
        _lastSelectedIndex = -1;
    }

    public void DeselectAllBrowse()
    {
        foreach (var c in BrowseWallpapers) c.IsSelected = false;
        _lastBrowseSelectedIndex = -1;
    }

    public void SelectBrowseCard(WallpaperCardViewModel card, bool shiftHeld, bool ctrlHeld = false)
    {
        int idx = BrowseWallpapers.IndexOf(card);
        if (idx < 0) return;

        if (ctrlHeld)
        {
            card.IsSelected = !card.IsSelected;
            if (card.IsSelected) _lastBrowseSelectedIndex = idx;
        }
        else if (shiftHeld && _lastBrowseSelectedIndex >= 0)
        {
            int from = Math.Min(_lastBrowseSelectedIndex, idx);
            int to = Math.Max(_lastBrowseSelectedIndex, idx);
            for (int i = from; i <= to; i++)
                BrowseWallpapers[i].IsSelected = true;
        }
        else
        {
            bool wasOnlySelected = card.IsSelected && BrowseSelectedCount == 1;
            foreach (var c in BrowseWallpapers) c.IsSelected = false;
            if (!wasOnlySelected)
            {
                card.IsSelected = true;
                _lastBrowseSelectedIndex = idx;
            }
            else
            {
                _lastBrowseSelectedIndex = -1;
            }
        }
    }

    public void SelectCard(WallpaperCardViewModel card, bool shiftHeld, bool ctrlHeld = false)
    {
        var displayed = FilteredLibraryWallpapers.ToList();
        int idx = displayed.IndexOf(card);
        if (idx < 0) return;

        if (ctrlHeld)
        {
            card.IsSelected = !card.IsSelected;
            if (card.IsSelected) _lastSelectedIndex = idx;
        }
        else if (shiftHeld && _lastSelectedIndex < 0)
        {
            card.IsSelected = true;
            _lastSelectedIndex = idx;
        }
        else if (shiftHeld)
        {
            if (_lastSelectedIndex >= displayed.Count)
            {
                _lastSelectedIndex = idx;
                card.IsSelected = true;
                return;
            }
            int from = Math.Max(0, Math.Min(_lastSelectedIndex, idx));
            int to = Math.Min(displayed.Count - 1, Math.Max(_lastSelectedIndex, idx));
            for (int i = from; i <= to; i++)
                displayed[i].IsSelected = true;
        }
        else
        {
            bool wasOnlySelected = card.IsSelected && LibrarySelectedCount == 1;
            foreach (var c in displayed) c.IsSelected = false;
            if (!wasOnlySelected)
            {
                card.IsSelected = true;
                _lastSelectedIndex = idx;
            }
            else
            {
                _lastSelectedIndex = -1;
            }
        }
    }

    // ── Browse ────────────────────────────────────────────────────────────

    partial void OnSelectedSourceChanged(IBgsProvider value)
    {
        CurrentPage = 1;
        SearchQuery = "";
        _isSearchMode = false;
        BrowseSortIndex = 0;
        _ = LoadWallpapersAsync();
    }

    [RelayCommand]
    private void OpenPreview(WallpaperCardViewModel card)
    {
        PreviewCard = card;
        if (card.LibraryItem != null && string.IsNullOrEmpty(card.VideoDuration))
            card.LoadDurationAsync();
        // Lazily detect an attached YouTube trailer (scrapes the item page); shows the button if found.
        if (card.IsWorkshopResult && card.WorkshopId != null && string.IsNullOrEmpty(card.WorkshopYoutubeUrl))
            _ = LoadWorkshopYoutubeAsync(card);
    }

    private async Task LoadWorkshopYoutubeAsync(WallpaperCardViewModel card)
    {
        try
        {
            var url = await SteamWorkshopScraper.GetYoutubeUrlAsync(card.WorkshopId!);
            // Resumes on UI thread (no ConfigureAwait); only set if this card is still being previewed.
            if (!string.IsNullOrEmpty(url) && ReferenceEquals(PreviewCard, card))
                card.WorkshopYoutubeUrl = url;
        }
        catch { }
    }

    [RelayCommand]
    private void ClosePreview() => PreviewCard = null;

    [RelayCommand]
    private async Task LoadWallpapersAsync()
    {
        var gen = ++_loadGeneration;
        _isSearchMode = false;
        NoMorePages = false;
        IsLoading = true;
        StatusMessage = "";
        BrowseWallpapers.Clear();
        _lastBrowseSelectedIndex = -1;
        for (int p = 0; p < SelectedSource.PageSizeHint; p++) BrowseWallpapers.Add(new WallpaperCardViewModel(isPlaceholder: true));

        if (SelectedSource is WallpaperEngineService weService)
            weService.SortIndex = BrowseSortIndex;

        try
        {
            var results = await SelectedSource.GetLatestAsync(CurrentPage);
            if (gen != _loadGeneration) return;
            await AddBrowseCardsAsync(results, gen);
        }
        catch (Exception ex)
        {
            if (gen != _loadGeneration) return;
            StatusMessage = $"Failed to load: {ex.Message}";
        }
        finally
        {
            if (gen == _loadGeneration)
                IsLoading = false;
        }
    }

    // Adds cards in small batches, yielding between each batch so the render
    // loop gets frames and the loading spinner stays alive. Leaves a trailing
    // placeholder "runway" that fills in as the user scrolls toward it.
    private async Task AddBrowseCardsAsync(IReadOnlyList<WallpaperResult> results, int gen)
    {
        const int batchSize = 5;
        for (int i = 0; i < results.Count; i++)
        {
            if (gen != _loadGeneration) return;
            var card = new WallpaperCardViewModel(results[i]);
            // Replace placeholder in-place → Avalonia reuses the visual, just swaps DataContext
            if (i < BrowseWallpapers.Count)
                BrowseWallpapers[i] = card;
            else
                BrowseWallpapers.Add(card);
            if ((i + 1) % batchSize == 0)
                await Task.Yield();
        }
        if (gen != _loadGeneration) return;
        // Drop any leftover placeholders past the real cards, then lay down a fresh runway.
        while (BrowseWallpapers.Count > results.Count)
            BrowseWallpapers.RemoveAt(BrowseWallpapers.Count - 1);
        if (results.Count == 0) { NoMorePages = true; return; }
        TopUpRunway(gen);
    }

    // Trailing placeholder cards kept after the loaded cards so scrolling always has more "coming",
    // filled by LoadMore as they approach the viewport. One page's worth.
    private void TopUpRunway(int gen)
    {
        if (gen != _loadGeneration) return;
        if (!SelectedSource.SupportsPagination || NoMorePages) return;
        int target = SelectedSource.PageSizeHint;
        int have = 0;
        for (int i = BrowseWallpapers.Count - 1; i >= 0 && BrowseWallpapers[i].IsPlaceholder; i--)
            have++;
        for (int i = have; i < target; i++)
            BrowseWallpapers.Add(new WallpaperCardViewModel(isPlaceholder: true));
    }

    private int FirstPlaceholderIndex()
    {
        for (int i = 0; i < BrowseWallpapers.Count; i++)
            if (BrowseWallpapers[i].IsPlaceholder) return i;
        return -1;
    }

    private void RemoveTrailingPlaceholders()
    {
        while (BrowseWallpapers.Count > 0 && BrowseWallpapers[^1].IsPlaceholder)
            BrowseWallpapers.RemoveAt(BrowseWallpapers.Count - 1);
    }

    [RelayCommand]
    private async Task SearchAsync()
    {
        if (!SelectedSource.SupportsSearch || string.IsNullOrWhiteSpace(SearchQuery)) return;

        var gen = ++_loadGeneration;
        _isSearchMode = true;
        _currentQuery = SearchQuery;
        CurrentPage = 1;
        NoMorePages = false;
        IsLoading = true;
        StatusMessage = "";
        BrowseWallpapers.Clear();
        _lastBrowseSelectedIndex = -1;
        for (int p = 0; p < SelectedSource.PageSizeHint; p++) BrowseWallpapers.Add(new WallpaperCardViewModel(isPlaceholder: true));

        if (SelectedSource is WallpaperEngineService weServiceSearch)
            weServiceSearch.SortIndex = BrowseSortIndex;

        try
        {
            var results = await SelectedSource.SearchAsync(SearchQuery, 1);
            if (gen != _loadGeneration) return;
            await AddBrowseCardsAsync(results, gen);
        }
        catch (Exception ex)
        {
            if (gen != _loadGeneration) return;
            StatusMessage = $"Search failed: {ex.Message}";
        }
        finally
        {
            if (gen == _loadGeneration)
                IsLoading = false;
        }
    }

    [RelayCommand]
    private async Task LoadMoreAsync()
    {
        if (!SelectedSource.SupportsPagination || NoMorePages || IsLoading) return;

        // The collection already ends in a placeholder runway (laid down by AddBrowseCardsAsync /
        // previous LoadMore). Fetch the next page, fill the leading runway placeholders in place,
        // then top the runway back up so there's always more "coming" as the user scrolls.
        var gen = _loadGeneration;
        IsLoading = true;
        try
        {
            CurrentPage++;
            var results = _isSearchMode
                ? await SelectedSource.SearchAsync(_currentQuery, CurrentPage)
                : await SelectedSource.GetLatestAsync(CurrentPage);

            // LoadMore is triggered from ElementPrepared (during the ItemsRepeater layout pass).
            // With prefetch the await above can complete synchronously, so without this yield the
            // collection mutations below would run during layout -> "Changes in data source are not
            // allowed during layout". Task.Yield defers them to a fresh dispatcher turn.
            await Task.Yield();

            if (gen != _loadGeneration) return;

            var existingUrls = BrowseWallpapers
                .Where(c => !c.IsPlaceholder)
                .Select(c => c.PageUrl)
                .ToHashSet();

            var newCards = results
                .Where(r => !existingUrls.Contains(r.PageUrl))
                .Select(r => new WallpaperCardViewModel(r))
                .ToList();

            if (newCards.Count == 0)
            {
                NoMorePages = true;
                RemoveTrailingPlaceholders();
                return;
            }

            // Fill from the first placeholder onward (replace in place so Avalonia reuses visuals).
            int pi = FirstPlaceholderIndex();
            if (pi < 0) pi = BrowseWallpapers.Count;
            foreach (var card in newCards)
            {
                if (pi < BrowseWallpapers.Count && BrowseWallpapers[pi].IsPlaceholder)
                    BrowseWallpapers[pi] = card;
                else
                    BrowseWallpapers.Insert(pi, card);
                pi++;
            }
            TopUpRunway(gen);
        }
        catch (Exception ex)
        {
            if (gen == _loadGeneration)
            {
                NoMorePages = true;
                RemoveTrailingPlaceholders();
                StatusMessage = $"Failed to load more: {ex.Message}";
            }
        }
        finally
        {
            if (gen == _loadGeneration)
                IsLoading = false;
        }
    }

    [RelayCommand]
    private Task DownloadAsync(WallpaperCardViewModel card)
    {
        // Fire-and-forget per card so clicking another card's button starts immediately.
        _ = DownloadOneAsync(card, applyOnSuccess: true);
        return Task.CompletedTask;
    }

    [RelayCommand]
    private async Task DownloadSelectedAsync()
    {
        var selected = BrowseWallpapers.Where(c => c.IsSelected).ToList();
        if (selected.Count == 0) return;
        ClearBrowseSelection();
        await Task.WhenAll(selected.Select(c => DownloadOneAsync(c, applyOnSuccess: false)));
        if (selected.Count > 1)
            StatusMessage = $"Downloaded {selected.Count(c => !c.IsDownloading)} wallpapers";
    }

    private async Task DownloadOneAsync(WallpaperCardViewModel target, bool applyOnSuccess)
    {
        if (target.IsDownloading) return;

        // Dedup check
        var existing = LibraryWallpapers.FirstOrDefault(c =>
            (c.LibraryItem?.SourceId != null && c.LibraryItem.SourceId == target.PageUrl) ||
            (target.WorkshopId != null && c.LibraryItem?.WorkshopId == target.WorkshopId));
        if (existing != null)
        {
            if (applyOnSuccess) ApplyAndSave(existing.PageUrl);
            StatusMessage = $"Applied: {target.Title}";
            return;
        }

        using var cts = new System.Threading.CancellationTokenSource();
        target.IsDownloading = true;
        target.DownloadProgress = 0;
        target.IsDownloadIndeterminate = true;
        target.DownloadLabel = "Downloading";
        target.CancelDownload = () => cts.Cancel();

        try
        {
            var detail = await SelectedSource.GetDetailAsync(new WallpaperResult
            {
                Title = target.Title,
                ThumbnailUrl = target.ThumbnailSource,
                PageUrl = target.PageUrl,
                IsScene = target.IsScene,
                WorkshopId = target.WorkshopId
            });

            LibraryItem item;
            if (detail.IsWorkshopAcquire && detail.WorkshopId != null)
            {
                target.DownloadLabel = _settings.WorkshopAcquireMode == "subscribe"
                    ? "Subscribing…" : "Downloading";
                var acquireProgress = new Progress<(double, string)>(t =>
                {
                    target.DownloadProgress = Math.Max(0, t.Item1);
                    StatusMessage = t.Item2;
                });
                string workshopDir = await WorkshopDownloader.AcquireAsync(
                    detail.WorkshopId, _settings, acquireProgress, cts.Token);
                target.DownloadLabel = "Downloading";
                StatusMessage = $"Importing {target.Title}…";

                // Re-check dedup after wait
                existing = LibraryWallpapers.FirstOrDefault(c =>
                    c.LibraryItem?.WorkshopId == detail.WorkshopId);
                if (existing != null)
                {
                    if (applyOnSuccess) ApplyAndSave(existing.PageUrl);
                    StatusMessage = $"Applied: {target.Title}";
                    return;
                }

                string downloadUrl = workshopDir;
                if (!detail.IsScene)
                {
                    var videoFile = await WorkshopDownloader.ResolveVideoFileAsync(workshopDir);
                    if (!string.IsNullOrEmpty(videoFile))
                        downloadUrl = videoFile;
                }

                var localDetail = new WallpaperDetail
                {
                    Title = detail.Title,
                    PreviewUrl = target.ThumbnailSource,
                    DownloadUrl = downloadUrl,
                    IsScene = detail.IsScene,
                    WorkshopId = detail.WorkshopId,
                    NeedsReferrer = false
                };
                item = await DownloadHelper.DownloadAsync(
                    localDetail, target.ThumbnailSource,
                    target.PageUrl, null, WeCopyFiles, cts.Token);
            }
            else
            {
                var progressReporter = new Progress<double>(p => target.DownloadProgress = p);
                item = await DownloadHelper.DownloadAsync(
                    detail, target.ThumbnailSource, target.PageUrl, progressReporter, WeCopyFiles, cts.Token);
            }

            var libCard = MakeLibraryCard(item);
            LibraryWallpapers.Add(libCard);

            if (applyOnSuccess) ApplyAndSave(item.VideoPath);
            StatusMessage = $"Applied: {target.Title}";
        }
        catch (OperationCanceledException)
        {
            StatusMessage = $"Cancelled: {target.Title}";
        }
        catch (Exception ex)
        {
            bool isRateLimit = ex.Message.Contains("daily download limit");
            ErrorTitle = isRateLimit ? "Wallsflow Download Limit" : "Download Failed";
            ErrorMessage = isRateLimit
                ? "Wallsflow limits unregistered users to 5 downloads per day. Log in to your Wallsflow account in Settings to continue downloading."
                : ex.Message;
            StatusMessage = $"Download failed: {target.Title}: {ex.Message}";
        }
        finally
        {
            target.IsDownloading = false;
            target.CancelDownload = null;
        }
    }

    private async Task DownloadCardsAsync(IReadOnlyList<WallpaperCardViewModel> targets, WallpaperCardViewModel? applyTarget)
    {
        // Legacy path kept for any callers; routes through DownloadOneAsync.
        if (targets.Count == 0) return;
        PreviewCard = null;
        await Task.WhenAll(targets.Select(t => DownloadOneAsync(t, applyOnSuccess: t == applyTarget)));
    }

    [RelayCommand]
    private void Delete(WallpaperCardViewModel card)
    {
        if (card.IsSelected && LibrarySelectedCount > 0)
            DeleteCards(LibraryWallpapers.Where(c => c.IsSelected).ToList());
        else
            DeleteCards([card]);
        _lastSelectedIndex = -1;
    }

    [RelayCommand]
    private void DeleteSelected()
    {
        var selected = LibraryWallpapers.Where(c => c.IsSelected).ToList();
        if (selected.Count == 0) return;
        DeleteCards(selected);
        ClearLibrarySelection();
    }

    private void DeleteCards(IReadOnlyList<WallpaperCardViewModel> targets)
    {
        string batchDir = Path.Combine(LibraryService.TrashPath, Guid.NewGuid().ToString("N")[..8]);
        var batchItems = new List<(WallpaperCardViewModel Card, bool WasInPlaylist)>();
        int deleted = 0;

        foreach (var target in targets)
        {
            if (target.LibraryItem == null) continue;
            bool wasInPlaylist = target.IsInPlaylist;
            try
            {
                LibraryService.Trash(target.LibraryItem, batchDir);
                LibraryWallpapers.Remove(target);
                if (target == _currentlyPlayingCard) _currentlyPlayingCard = null;
                if (wasInPlaylist)
                {
                    PlaylistItems.Remove(target);
                    target.IsInPlaylist = false;
                }
                batchItems.Add((target, wasInPlaylist));
                deleted++;
            }
            catch (Exception ex)
            {
                StatusMessage = $"Delete failed: {target.Title}: {ex.Message}";
            }
        }

        if (deleted > 0)
        {
            _undoBatches.Add(new UndoBatch { BatchDir = batchDir, Items = batchItems });
            CanUndo = true;
            SetTimedStatusMessage(deleted > 1 ? $"Deleted {deleted} wallpapers" : $"Deleted: {batchItems[0].Card.Title}");
        }
    }

    [RelayCommand]
    private void UndoDelete()
    {
        if (_undoBatches.Count == 0) return;
        var batch = _undoBatches[^1];
        LibraryService.RestoreBatch(batch.BatchDir);
        _undoBatches.RemoveAt(_undoBatches.Count - 1);
        CanUndo = _undoBatches.Count > 0;
        var restoredIds = new List<string>();
        foreach (var (card, wasInPlaylist) in batch.Items)
        {
            LibraryWallpapers.Add(card);
            if (wasInPlaylist)
                AddCardToPlaylist(card);
            if (card.LibraryItem?.WorkshopId is string wid) restoredIds.Add(wid);
        }
        // Undo of a "Delete from Source" → pull the id back out of the unsubscribe queue (no
        // unsubscribe has run yet). No-op for plain deletes (ids aren't in the queue).
        if (restoredIds.Count > 0) WorkshopUnsubQueue.RemovePending(restoredIds);
        SetTimedStatusMessage(batch.Items.Count > 1 ? $"Restored {batch.Items.Count} wallpapers" : $"Restored: {batch.Items[0].Card.Title}");
    }

    public void PurgeTrash()
    {
        foreach (var b in _undoBatches) LibraryService.PurgeBatch(b.BatchDir);
        _undoBatches.Clear();
        CanUndo = false;
    }

    [RelayCommand]
    private void Stop()
    {
        PlayerHelper.Stop();
        AudioMonitor.KillDetachedMonitor();
        StatusMessage = "";
        if (_currentlyPlayingCard != null)
        {
            _currentlyPlayingCard.IsCurrentlyPlaying = false;
            _currentlyPlayingCard = null;
        }
    }

    [RelayCommand]
    private void Apply(WallpaperCardViewModel card)
    {
        DeselectAllLibrary();
        try
        {
            ApplyAndSave(card.PageUrl);
            StatusMessage = $"Applied: {card.Title}";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Failed to apply: {ex.Message}";
        }
    }

    private void ApplyAndSave(string videoPath)
    {
        PlayerHelper.Apply(videoPath, _settings.BuildMpvOptions());
        _settings.LastSession = new LastSession { Paths = [videoPath] };
        SettingsService.Save(_settings);
    }

    private void LoadLibrary()
    {
        _suppressFilterUpdate = true;
        try
        {
            foreach (var item in LibraryService.LoadAll())
                LibraryWallpapers.Add(MakeLibraryCard(item));
        }
        finally
        {
            _suppressFilterUpdate = false;
        }
    }

    private void SyncSelectedVolume(WallpaperCardViewModel source, int? volume)
    {
        if (_isSyncingVolume || !source.IsSelected) return;
        _isSyncingVolume = true;
        try
        {
            foreach (var c in LibraryWallpapers.Where(c => c.IsSelected && c != source))
            {
                if (volume.HasValue) c.SliderVolume = volume.Value;
                else c.SyncVolumeToGlobalCommand.Execute(null);
            }
        }
        finally { _isSyncingVolume = false; }
    }

    private void SyncSelectedSpeed(WallpaperCardViewModel source, double? speed)
    {
        if (_isSyncingSpeed || !source.IsSelected) return;
        _isSyncingSpeed = true;
        try
        {
            foreach (var c in LibraryWallpapers.Where(c => c.IsSelected && c != source))
            {
                if (speed.HasValue) c.SliderSpeed = speed.Value;
                else c.SyncSpeedToGlobalCommand.Execute(null);
            }
        }
        finally { _isSyncingSpeed = false; }
    }

    private WallpaperCardViewModel MakeLibraryCard(LibraryItem item)
    {
        var card = new WallpaperCardViewModel(item);
        card.OnTogglePlaylist = c => ToggleInPlaylistCommand.Execute(c);
        card.OnVolumeChanged = (c, v) => SyncSelectedVolume(c, v);
        card.UpdateGlobalVolume(Volume);
        card.OnSpeedChanged = (c, v) => SyncSelectedSpeed(c, v);
        card.UpdateGlobalSpeed(Speed);
        if (!AutoPlayGifs) card.LoadStaticThumbnailAsync();
        card.OnOpenSettings = c => OpenPreview(c);
        card.OnDelete = c => Delete(c);
        return card;
    }

    internal void ValidateLibraryGhosts()
    {
        var ghosts = LibraryWallpapers
            .Where(c => c.LibraryItem != null && !File.Exists(c.LibraryItem.VideoPath))
            .ToList();
        foreach (var ghost in ghosts)
        {
            if (LibraryService.IsOrphanSymlink(ghost.LibraryItem!.VideoPath))
                LibraryService.CleanOrphan(ghost.LibraryItem.VideoPath);
            LibraryWallpapers.Remove(ghost);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private int GetIntervalSeconds() =>
        (int)IntervalHours * 3600 + (int)IntervalMinutes * 60 + (int)IntervalSeconds;

    private string GetEffectiveIntervalDisplay() => FormatInterval(GetEffectiveIntervalSeconds());

    private static string FormatInterval(int totalSeconds)
    {
        var parts = new List<string>();
        int h = totalSeconds / 3600;
        int m = (totalSeconds % 3600) / 60;
        int s = totalSeconds % 60;
        if (h > 0) parts.Add($"{h}h");
        if (m > 0) parts.Add($"{m}m");
        if (s > 0 || parts.Count == 0) parts.Add($"{s}s");
        return string.Join(" ", parts);
    }

    private void RefreshPlayingStatusSoon()
    {
        if (PlayerHelper.IsPlaying) { RefreshPlayingStatus(); return; }
        Task.Run(async () =>
        {
            for (int i = 0; i < 50 && !PlayerHelper.IsPlaying; i++)
                await Task.Delay(100).ConfigureAwait(false);
            if (PlayerHelper.IsPlaying)
                Dispatcher.UIThread.Post(RefreshPlayingStatus);
        });
    }

    private void RefreshPlayingStatus()
    {
        if (!PlayerHelper.IsPlaying) return;

        var parts = new List<string>();
        var s = _settings.LastSession;

        int playlistCount = PlaylistItems.Count > 0 ? PlaylistItems.Count : s?.Paths.Count ?? 0;
        if (s?.IsTimedPlaylist == true && s.Paths.Count > 1)
        {
            string desc = s.AdvanceOnVideoEnd
                ? $"{playlistCount} wallpapers, on video end"
                : $"{playlistCount} wallpapers, every {FormatInterval(GetEffectiveIntervalSeconds())}";
            if (PlaylistShuffle) desc += " (shuffled)";
            if (_currentlyPlayingCard != null) desc += $" → {_currentlyPlayingCard.Title}";
            parts.Add(desc);
        }
        else if (s?.IsPlaylist == true)
        {
            string desc = $"{playlistCount} wallpapers, on video end";
            if (PlaylistShuffle) desc += " (shuffled)";
            if (_currentlyPlayingCard != null) desc += $" → {_currentlyPlayingCard.Title}";
            parts.Add(desc);
        }
        else if (_currentlyPlayingCard != null)
        {
            parts.Add(_currentlyPlayingCard.Title);
        }
        else if (s?.Paths.Count == 1)
        {
            parts.Add(System.IO.Path.GetFileNameWithoutExtension(s.Paths[0]));
        }

        parts.Add(NoAudio ? $"Vol {Volume}% (muted)" : $"Vol {Volume}%");
        if (Loop) parts.Add("Loop");
        if (Math.Abs(Speed - 1.0) > 0.01) parts.Add($"{Speed:0.##}×");

        StatusMessage = string.Join(" • ", parts);
    }
}
