using System;
using System.ComponentModel;
using System.Linq;
using System.Threading.Tasks;
using livepaper.Helpers;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Avalonia.Controls.Primitives;
using Avalonia.Threading;
using Avalonia.VisualTree;
using livepaper.ViewModels;

namespace livepaper.Views;

public partial class MainWindow : Window
{
    // Layout constants
    private const double MinCardWidthLandscape = 250;
    private const double MinCardWidthPortrait = 160;
    private const double CardHorizontalMargin = 8;
    private const double PlaylistItemWidth = 100;
    private const double PlaylistItemSpacing = 6;
    private const double PlaylistItemStride = PlaylistItemWidth + PlaylistItemSpacing;

    private double _lastRepeaterWidth;
    private System.Threading.CancellationTokenSource? _cardHeightDebounce;
    private Border? _pressedCardBorder;
    // Realized Browse-grid containers, used to drive viewport-gated GIF activation so only the
    // cards actually on screen decode/animate (not the larger ItemsRepeater realization buffer).
    private readonly System.Collections.Generic.HashSet<Control> _realizedBrowse = new();
    private readonly System.Collections.Generic.HashSet<Control> _realizedLib = new();
    // Debounces GIF activation until scrolling settles, so a fast fling doesn't decode a full-res
    // preview for every card it passes (allocation churn → GC pauses → scroll lag).
    private DispatcherTimer? _gifSettleTimer;

    // Playlist drag state
    private WallpaperCardViewModel? _dragCard;
    private Visual? _dragSourceVisual;
    private bool _isDragging;
    private Point _dragStartPos;

    public MainWindow()
    {
        InitializeComponent();
        BrowseScrollViewer.ScrollChanged += OnBrowseScrollChanged;
        DataContextChanged += OnDataContextChanged;
        KeyDown += OnKeyDown;
        // SmoothScroller owns ScrollViewer.Offset via an inertia animator, which fights the
        // robotic Offset writes used by the debug bridge. Skip it under debug.
        if (!DebugBridge.Enabled)
        {
            new SmoothScroller(BrowseScrollViewer);
            new SmoothScroller(LibraryScrollViewer);
            new SmoothScroller(SettingsScrollViewer);
            new SmoothScroller(PlaylistScrollViewer);
        }
        Loaded += (_, _) =>
        {
            BrowseItemsRepeater.SizeChanged += (_, _) => UpdateCardThumbnailHeight();
            LibraryItemsRepeater.SizeChanged += (_, _) => UpdateCardThumbnailHeight();
            if (Vm != null) Vm.CardLayoutChanged = UpdateCardThumbnailHeight;
            UpdateCardThumbnailHeight();
            BrowseItemsRepeater.ElementPrepared += OnRepeaterElementPrepared;
            BrowseItemsRepeater.ElementClearing += OnRepeaterElementClearing;
            LibraryItemsRepeater.ElementPrepared += OnRepeaterElementPrepared;
            LibraryItemsRepeater.ElementClearing += OnRepeaterElementClearing;
            // Activate GIF cards already prepared before Loaded fired (realized/visible only —
            // app opens on Browse, so library gifs stay idle until that tab is shown).
            if (Vm?.AutoPlayGifs == true)
            {
                ReconcileBrowseGifs();
                ReconcileLibraryGifs();
                foreach (var c in Vm.PlaylistItems) ActivatePlaylistGifCard(c);
            }
            PlaylistScrollViewer.ScrollChanged += OnPlaylistScrollGif;
        };

        this.AddHandler(PointerPressedEvent, OnPointerPressedTunnel, RoutingStrategies.Tunnel);
        this.AddHandler(PointerPressedEvent, OnPointerPressed, RoutingStrategies.Bubble, handledEventsToo: true);
        this.AddHandler(PointerMovedEvent, OnPointerMoved, RoutingStrategies.Bubble, handledEventsToo: true);
        this.AddHandler(PointerReleasedEvent, OnPointerReleased, RoutingStrategies.Bubble, handledEventsToo: true);
        this.AddHandler(PointerCaptureLostEvent, OnPointerCaptureLost, RoutingStrategies.Bubble, handledEventsToo: true);
        MainTabControl.SelectionChanged += OnTabChanged;

        if (DebugBridge.Enabled)
        {
            var hbSw = System.Diagnostics.Stopwatch.StartNew();
            long hbLast = 0;
            var hbTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            hbTimer.Tick += (_, _) =>
            {
                long now = hbSw.ElapsedMilliseconds;
                long gap = now - hbLast;
                if (gap > 250) Console.Error.WriteLine($"[HB] stall {gap}ms");
                hbLast = now;
            };
            hbTimer.Start();

            // On-screen FPS meter (debug only).
            FpsOverlay.IsVisible = true;
            FpsMeter.Updated += () =>
                FpsText.Text = $"{FpsMeter.CurrentFps:F0} fps · {FpsMeter.LastFrameMs:F1}ms · low {FpsMeter.LowFps:F0}";
            Loaded += (_, _) =>
            {
                var tl = TopLevel.GetTopLevel(this);
                if (tl != null) FpsMeter.Start(tl);
            };

            DebugBridge.Handler = HandleDebugCommand;
            DebugBridge.Start();
        }
    }

    // Debug control channel handler (see DebugBridge). Runs on the UI thread.
    private string HandleDebugCommand(string cmd)
    {
        var parts = cmd.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var verb = parts.Length > 0 ? parts[0] : "";
        var arg = parts.Length > 1 ? parts[1] : "";
        switch (verb)
        {
            case "tab":
                MainTabControl.SelectedIndex = int.Parse(arg);
                return $"tab={MainTabControl.SelectedIndex}";
            case "cardsize":
                if (Vm != null) Vm.CardSize = arg;
                return "cardSize=" + Vm?.CardSize;
            case "gifs":
                if (Vm != null) Vm.AutoPlayGifs = arg == "on";
                return "autoPlayGifs=" + Vm?.AutoPlayGifs;
            case "fetch":
                _debugFreezeLoad = arg == "off";
                return "fetch=" + (!_debugFreezeLoad);
            case "openpreview":
            {
                var card = Vm?.BrowseWallpapers.FirstOrDefault(c => !c.IsPlaceholder && c.IsGifThumbnail);
                if (card == null) return "no gif card";
                Vm!.OpenPreviewCommand.Execute(card);
                return "opened " + card.Title;
            }
            case "closepreview":
                Vm?.ClosePreviewCommand.Execute(null);
                return "closed";
            case "autoscroll":
            {
                var a = arg.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                double pps = a.Length > 0 && double.TryParse(a[0], out var p) ? p : 2500;
                double secs = a.Length > 1 && double.TryParse(a[1], out var s) ? s : 15;
                StartAutoScroll(pps, secs);
                return $"autoscroll {pps}px/s {secs}s";
            }
            case "source":
                if (Vm == null) return "no vm";
                var src = Vm.Sources.FirstOrDefault(s => s.Name.Contains(arg, StringComparison.OrdinalIgnoreCase));
                if (src == null) return "source not found: " + arg;
                Vm.SelectedSource = src;
                return "source=" + src.Name;
            case "scroll":
            {
                double d = double.Parse(arg);
                var asv = ActiveScroll;
                var off = asv.Offset;
                asv.Offset = new Vector(off.X, Math.Max(0, off.Y + d));
                return $"y={asv.Offset.Y:F0}/{asv.Extent.Height:F0}";
            }
            case "scrollbottom":
            {
                var asv = ActiveScroll;
                double ext = asv.Extent.Height;
                double vp = asv.Viewport.Height;
                asv.Offset = new Vector(asv.Offset.X, Math.Max(0, ext - vp));
                return $"y={asv.Offset.Y:F0}/{ext:F0}";
            }
            case "loadmore":
                Vm?.LoadMoreCommand.Execute(null);
                return "loadmore fired";
            case "gc":
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                return DebugMetrics();
            case "sample":
            {
                if (Vm == null || Vm.BrowseWallpapers.Count == 0) return "no cards";
                var c = Vm.BrowseWallpapers[0];
                return $"display={c.DisplayThumbnailSource}\nthumb={c.ThumbnailSource}\nstatic={c.StaticThumbnailSource}";
            }
            case "fps":
                return $"fps={FpsMeter.CurrentFps:F0} ms={FpsMeter.LastFrameMs:F2} low={FpsMeter.LowFps:F0}";
            case "metrics":
                return DebugMetrics();
            default:
                return "unknown verb: " + verb;
        }
    }

    // Debug: when true, scroll-triggered LoadMore is suppressed so we can measure scroll fps over a
    // fixed already-loaded set without new fetches polluting the result.
    private bool _debugFreezeLoad;
    private bool _autoScrolling;
    // Debug scroll/metrics target the visible tab's scrollviewer (0=Browse, 1=Library, 2=Settings).
    private ScrollViewer ActiveScroll => MainTabControl.SelectedIndex switch
    {
        1 => LibraryScrollViewer,
        2 => SettingsScrollViewer,
        _ => BrowseScrollViewer
    };
    // Continuous per-frame scroll (bounces at top/bottom) to reproduce real smooth-scroll load,
    // which discrete Offset jumps don't. FpsMeter samples while this runs.
    private void StartAutoScroll(double pps, double secs)
    {
        if (_autoScrolling) return;
        _autoScrolling = true;
        var tl = TopLevel.GetTopLevel(this);
        if (tl == null) { _autoScrolling = false; return; }
        var sw = System.Diagnostics.Stopwatch.StartNew();
        TimeSpan? last = null;
        int dir = 1;
        void Frame(TimeSpan t)
        {
            if (!_autoScrolling) return;
            double dt = last.HasValue ? (t - last.Value).TotalSeconds : 1.0 / 60;
            last = t;
            var sv = ActiveScroll;
            double max = Math.Max(0, sv.Extent.Height - sv.Viewport.Height);
            double y = sv.Offset.Y + dir * pps * dt;
            if (y >= max) { y = max; dir = -1; }
            else if (y <= 0) { y = 0; dir = 1; }
            sv.Offset = new Vector(sv.Offset.X, y);
            if (sw.Elapsed.TotalSeconds < secs) tl.RequestAnimationFrame(Frame);
            else _autoScrolling = false;
        }
        tl.RequestAnimationFrame(Frame);
    }

    private string DebugMetrics()
    {
        var p = System.Diagnostics.Process.GetCurrentProcess();
        long ws = p.WorkingSet64 / (1024 * 1024);
        long gc = GC.GetTotalMemory(false) / (1024 * 1024);
        bool lib = MainTabControl.SelectedIndex == 1;
        var list = lib ? (System.Collections.Generic.IEnumerable<WallpaperCardViewModel>?)Vm?.FilteredLibraryWallpapers : Vm?.BrowseWallpapers;
        int cards = 0, active = 0;
        if (list != null)
            foreach (var c in list) { cards++; if (c.IsGifActive) active++; }
        var asv = ActiveScroll;
        return $"tab={(lib ? "lib" : "browse")} fps={FpsMeter.CurrentFps:F0} low={FpsMeter.LowFps:F0} cards={cards} realized={_realizedBrowse.Count} activeGif={active} ws={ws}MB gcHeap={gc}MB " +
               $"gen0={GC.CollectionCount(0)} gen2={GC.CollectionCount(2)} " +
               $"y={asv.Offset.Y:F0}/{asv.Extent.Height:F0}";
    }

    protected override void OnClosed(EventArgs e)
    {
        Vm?.PurgeTrash();
        base.OnClosed(e);
    }

    private MainWindowViewModel? Vm => DataContext as MainWindowViewModel;
    private MainWindowViewModel? _boundVm;

    private void OnDataContextChanged(object? sender, System.EventArgs e)
    {
        if (_boundVm != null)
        {
            _boundVm.PropertyChanged -= OnViewModelPropertyChanged;
            _boundVm.PickFolderDialog = null;
            _boundVm.PickVideoDialog = null;
            _boundVm.PickFileDialog = null;
            _boundVm.CopyToClipboard = null;
            _boundVm = null;
        }
        if (DataContext is MainWindowViewModel vm)
        {
            vm.PropertyChanged += OnViewModelPropertyChanged;
            vm.PickFolderDialog = PickFolderDialogAsync;
            vm.PickVideoDialog = PickVideoDialogAsync;
            vm.PickFileDialog = PickFileDialogAsync;
            vm.CopyToClipboard = async text =>
            {
                // Try wl-copy first — it forks a daemon that keeps holding
                // the clipboard selection after livepaper exits. Avalonia's
                // own clipboard releases ownership on app close, so without
                // wl-copy (or a separate clipboard manager) the snippet is
                // lost as soon as the user closes the window.
                if (await TryWlCopyAsync(text)) return;
                var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
                if (clipboard != null)
                    await clipboard.SetTextAsync(text);
            };
            _boundVm = vm;
        }
    }

    private static async Task<bool> TryWlCopyAsync(string text)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("wl-copy")
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc == null) return false;
            await proc.StandardInput.WriteAsync(text);
            proc.StandardInput.Close();
            await proc.WaitForExitAsync();
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private async Task<string?> PickFolderDialogAsync()
    {
        var folders = await StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select Wallpaper Engine Workshop Folder",
            AllowMultiple = false
        });
        return folders.Count > 0 ? folders[0].Path.LocalPath : null;
    }

    private static readonly FilePickerFileType WallpaperFileType = new("Wallpaper files")
    {
        Patterns = ["*.mp4", "*.webm", "*.mov", "*.mkv", "*.avi", "*.gif", "*.png", "*.jpg", "*.jpeg", "*.webp"]
    };

    private async Task<string?> PickVideoDialogAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Import Wallpaper",
            FileTypeFilter = [WallpaperFileType],
            AllowMultiple = false
        });
        return files.Count > 0 ? files[0].Path.LocalPath : null;
    }

    private async Task<string?> PickFileDialogAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select steamcmd Executable",
            AllowMultiple = false
        });
        return files.Count > 0 ? files[0].Path.LocalPath : null;
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            if (Vm?.PreviewCard != null)
            {
                Vm.ClosePreviewCommand.Execute(null);
                e.Handled = true;
                return;
            }
            if (MainTabControl.SelectedIndex == 0 && Vm?.AnyBrowseSelected == true)
            {
                Vm.ClearBrowseSelectionCommand.Execute(null);
                e.Handled = true;
            }
            else if (MainTabControl.SelectedIndex == 1 && Vm?.AnyLibrarySelected == true)
            {
                Vm.ClearLibrarySelectionCommand.Execute(null);
                e.Handled = true;
            }
            return;
        }
        if (e.Key == Key.A && e.KeyModifiers == KeyModifiers.Control)
        {
            if (MainTabControl.SelectedIndex == 0)
                Vm?.SelectAllBrowseCommand.Execute(null);
            else if (MainTabControl.SelectedIndex == 1)
                Vm?.SelectAllCommand.Execute(null);
            e.Handled = true;
        }
        if (TopLevel.GetTopLevel(this)?.FocusManager?.GetFocusedElement() is TextBox)
            return;
        if (e.Key == Key.Delete && MainTabControl.SelectedIndex == 1 && Vm?.AnyLibrarySelected == true)
        {
            Vm.DeleteSelectedCommand.Execute(null);
            e.Handled = true;
        }
        if (e.Key == Key.Z && e.KeyModifiers == KeyModifiers.Control && Vm?.CanUndo == true)
        {
            Vm.UndoDeleteCommand.Execute(null);
            e.Handled = true;
        }
    }

    private void OnPointerPressedTunnel(object? sender, PointerPressedEventArgs e)
    {
        if (!e.GetCurrentPoint(null).Properties.IsLeftButtonPressed) return;
        if (e.Source is not Visual source) return;
        bool shift = e.KeyModifiers.HasFlag(KeyModifiers.Shift);
        bool ctrl = e.KeyModifiers.HasFlag(KeyModifiers.Control);
        if (!shift && !ctrl) return;
        if (!IsWithin(source, LibraryScrollViewer)) return;
        // Don't intercept trash or playlist-toggle — let those buttons work normally
        var btn = FindAncestor<Button>(source, LibraryScrollViewer);
        if (btn != null && (btn.Classes.Contains("danger") || btn.Classes.Contains("playlist-toggle-btn"))) return;
        var card = FindAncestorDataContext<WallpaperCardViewModel>(source, LibraryScrollViewer);
        if (card == null) return;
        Vm?.SelectCard(card, shift, ctrl);
        e.Handled = true;
    }

    private void OnPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (!e.GetCurrentPoint(null).Properties.IsLeftButtonPressed) return;
        if (e.Source is not Visual source) return;

        _pressedCardBorder = FindAncestor<Border>(source, null, b => b.Classes.Contains("library-card"));
        if (_pressedCardBorder != null)
            _pressedCardBorder.RenderTransform = Avalonia.Media.Transformation.TransformOperations.Parse("scale(0.96)");

        bool shift = e.KeyModifiers.HasFlag(KeyModifiers.Shift);
        bool ctrl = e.KeyModifiers.HasFlag(KeyModifiers.Control);

        if (IsWithin(source, PlaylistScrollViewer))
        {
            if (IsWithinButton(source, PlaylistScrollViewer)) return;
            var card = FindAncestorDataContext<WallpaperCardViewModel>(source, PlaylistScrollViewer);
            if (card == null) return;
            _dragCard = card;
            _dragSourceVisual = FindAncestor<Border>(source, PlaylistScrollViewer, b => b.Classes.Contains("playlist-item"))
                                       ?? FindAncestor<Border>(source, PlaylistScrollViewer);
            _isDragging = false;
            _dragStartPos = e.GetPosition(this);
        }
        else if (IsWithin(source, LibraryScrollViewer))
        {
            if (IsWithinButton(source, LibraryScrollViewer)) return;
            if (source is ScrollBar || (source as Visual)?.FindAncestorOfType<ScrollBar>() != null) return;
            var card = FindAncestorDataContext<WallpaperCardViewModel>(source, LibraryScrollViewer);
            if (card == null) { Vm?.DeselectAllLibrary(); return; }
            Vm?.SelectCard(card, shift, ctrl);
        }
        else if (IsWithin(source, BrowseScrollViewer))
        {
            if (IsWithinButton(source, BrowseScrollViewer)) return;
            if (source is ScrollBar || (source as Visual)?.FindAncestorOfType<ScrollBar>() != null) return;
            var card = FindAncestorDataContext<WallpaperCardViewModel>(source, BrowseScrollViewer);
            if (card == null) { Vm?.DeselectAllBrowse(); return; }
            Vm?.SelectBrowseCard(card, shift, ctrl);
        }
    }

    private void OnPointerMoved(object? sender, PointerEventArgs e)
    {
        if (_dragCard == null) return;

        var windowPos = e.GetPosition(this);

        if (!_isDragging)
        {
            var dx = windowPos.X - _dragStartPos.X;
            var dy = windowPos.Y - _dragStartPos.Y;
            if (dx * dx + dy * dy < 36) return; // 6px threshold

            _isDragging = true;
            DragPreviewBorder.Background = new Avalonia.Media.VisualBrush
            {
                Visual = _dragSourceVisual,
                Stretch = Avalonia.Media.Stretch.Fill
            };
            DragPreviewCanvas.IsVisible = true;
        }

        Canvas.SetLeft(DragPreviewBorder, windowPos.X - 17);
        Canvas.SetTop(DragPreviewBorder, windowPos.Y - 15);

        var svPos = e.GetPosition(PlaylistScrollViewer);
        if (svPos.X >= 0 && svPos.X <= PlaylistScrollViewer.Bounds.Width
            && svPos.Y >= 0 && svPos.Y <= PlaylistScrollViewer.Bounds.Height)
        {
            int idx = GetPlaylistInsertIndex(svPos.X + PlaylistScrollViewer.Offset.X);
            UpdateDropIndicator(idx);
        }
        else
        {
            PlaylistDropIndicator.IsVisible = false;
        }
    }

    private void OnPointerCaptureLost(object? sender, PointerCaptureLostEventArgs e)
    {
        DragPreviewCanvas.IsVisible = false;
        PlaylistDropIndicator.IsVisible = false;
        if (_dragCard != null && !_dragCard.IsGifThumbnail) _dragCard.IsGifActive = false;
        _dragCard = null;
        _dragSourceVisual = null;
        _isDragging = false;
    }

    private void OnPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (_pressedCardBorder != null)
        {
            _pressedCardBorder.RenderTransform = Avalonia.Media.Transformation.TransformOperations.Parse("scale(1)");
            _pressedCardBorder = null;
        }

        if (_dragCard == null) return;

        if (_isDragging && Vm != null)
        {
            var svPos = e.GetPosition(PlaylistScrollViewer);
            bool inStrip = svPos.X >= 0 && svPos.X <= PlaylistScrollViewer.Bounds.Width
                        && svPos.Y >= 0 && svPos.Y <= PlaylistScrollViewer.Bounds.Height;
            if (inStrip)
            {
                int insertIdx = GetPlaylistInsertIndex(svPos.X + PlaylistScrollViewer.Offset.X);
                int fromIdx = Vm.PlaylistItems.IndexOf(_dragCard);
                if (fromIdx >= 0)
                    Vm.MovePlaylistItem(fromIdx, insertIdx);
            }
        }
        else if (Vm != null)
        {
            Vm.PlayFromCardCommand.Execute(_dragCard);
        }

        DragPreviewCanvas.IsVisible = false;
        PlaylistDropIndicator.IsVisible = false;
        if (_dragCard != null && !_dragCard.IsGifThumbnail) _dragCard.IsGifActive = false;
        _dragCard = null;
        _dragSourceVisual = null;
        _isDragging = false;
    }

    private int GetPlaylistInsertIndex(double x)
    {
        int count = Vm?.PlaylistItems.Count ?? 0;
        for (int i = 0; i < count; i++)
        {
            if (x < i * PlaylistItemStride + PlaylistItemWidth / 2.0)
                return i;
        }
        return count;
    }

    private void UpdateDropIndicator(int insertIndex)
    {
        double x = insertIndex * PlaylistItemStride - PlaylistScrollViewer.Offset.X - 1;
        if (x < -2 || x > PlaylistScrollViewer.Bounds.Width + 2)
        {
            PlaylistDropIndicator.IsVisible = false;
            return;
        }
        PlaylistDropIndicator.IsVisible = true;
        PlaylistDropIndicator.Margin = new Thickness(x, 0, 0, 0);
    }

    private static bool IsWithin(Visual? v, Visual ancestor)
    {
        while (v != null)
        {
            if (v == ancestor) return true;
            v = v.GetVisualParent();
        }
        return false;
    }

    private static bool IsWithinButton(Visual? v, Visual stopAt)
    {
        while (v != null && v != stopAt)
        {
            if (v is Button) return true;
            v = v.GetVisualParent();
        }
        return false;
    }

    private static T? FindAncestor<T>(Visual? v, Visual? stopAt = null) where T : Visual
    {
        while (v != null && v != stopAt)
        {
            if (v is T match) return match;
            v = v.GetVisualParent();
        }
        return null;
    }

    private static T? FindAncestor<T>(Visual? v, Visual? stopAt, Func<T, bool> predicate) where T : Visual
    {
        while (v != null && v != stopAt)
        {
            if (v is T match && predicate(match)) return match;
            v = v.GetVisualParent();
        }
        return null;
    }

    private static T? FindAncestorDataContext<T>(Visual? v, Visual? stopAt = null) where T : class
    {
        while (v != null && v != stopAt)
        {
            if (v is StyledElement se && se.DataContext is T ctx) return ctx;
            v = v.GetVisualParent();
        }
        return null;
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainWindowViewModel.IsLoading)
            && sender is MainWindowViewModel vm
            && !vm.IsLoading)
        {
            Dispatcher.UIThread.Post(CheckFillViewport, DispatcherPriority.Background);
        }
        else if (e.PropertyName == nameof(MainWindowViewModel.AutoPlayGifs)
            && sender is MainWindowViewModel vm2 && vm2.AutoPlayGifs)
        {
            // Only the realized (visible) cards of the current tab — not all ~150 library gifs.
            ReconcileBrowseGifs();
            ReconcileLibraryGifs();
            foreach (var c in vm2.PlaylistItems) ActivatePlaylistGifCard(c);
        }
        else if (e.PropertyName == nameof(MainWindowViewModel.PreviewCard))
        {
            // While the preview modal is open, pause grid gif animations so the same gif isn't
            // animated twice at once (which corrupts the frames). Resume when it closes.
            if (Vm?.PreviewCard != null)
            {
                foreach (var el in _realizedBrowse)
                    if (el.DataContext is WallpaperCardViewModel c) c.DeactivateGifKeepSource();
            }
            else
                ReconcileBrowseGifs();
        }
    }

    private void CheckFillViewport()
    {
        if (DataContext is not MainWindowViewModel vm) return;
        if (_debugFreezeLoad) return;
        if (vm.IsLoading || vm.NoMorePages || !vm.SelectedSource.SupportsPagination) return;

        if (BrowseScrollViewer.Extent.Height <= BrowseScrollViewer.Viewport.Height)
            vm.LoadMoreCommand.Execute(null);
    }

    private void OnTabChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (Vm?.AutoPlayGifs != true) return;
        Dispatcher.UIThread.Post(() =>
        {
            int tab = MainTabControl.SelectedIndex;
            // Animate gifs only on the visible tab; deactivate the other tab's realized gifs so they
            // aren't decoding in the background (Library has ~150 gifs — leaving them all running
            // pegged the app at ~15fps / 3GB).
            if (tab == 0)
            {
                DeactivateRealized(_realizedLib);
                ReconcileBrowseGifs();
            }
            else if (tab == 1)
            {
                DeactivateRealized(_realizedBrowse);
                ReconcileLibraryGifs();
            }
        }, DispatcherPriority.Background);
    }

    private static void DeactivateRealized(System.Collections.Generic.HashSet<Control> realized)
    {
        foreach (var el in realized)
            if (el.DataContext is WallpaperCardViewModel c && c.IsGifActive)
                c.IsGifActive = false;
    }

    // Animate only the realized (≈visible) Library gif cards — NOT all LibraryWallpapers.
    private void ReconcileLibraryGifs()
    {
        if (Vm?.AutoPlayGifs != true) return;
        foreach (var el in _realizedLib)
            if (el.DataContext is WallpaperCardViewModel card)
                ActivateGifCard(card);
    }

    private void OnRepeaterElementPrepared(object? sender, ItemsRepeaterElementPreparedEventArgs e)
    {
        if (e.Element is not Control el) return;

        // Track realized Browse containers unconditionally (used for viewport gif-gating + the
        // debug realized-count metric), regardless of the AutoPlayGifs setting.
        if (ReferenceEquals(sender, BrowseItemsRepeater))
        {
            _realizedBrowse.Add(el);
            if (Vm?.AutoPlayGifs == true) ScheduleGifReconcile();
            // A placeholder scrolled into view → fetch to fill it (infinite runway). LoadMore is
            // self-guarded (IsLoading/NoMorePages) so the burst of prepared placeholders coalesces.
            if (!_debugFreezeLoad
                && el.DataContext is WallpaperCardViewModel ph && ph.IsPlaceholder
                && Vm is { IsLoading: false, NoMorePages: false } vm
                && vm.SelectedSource.SupportsPagination)
                vm.LoadMoreCommand.Execute(null);
            return;
        }

        // Track realized Library containers so gif animation is gated to the viewport (not all
        // ~150 library gifs at once, which pegged the app at ~15fps / 3GB).
        if (ReferenceEquals(sender, LibraryItemsRepeater))
            _realizedLib.Add(el);

        if (Vm?.AutoPlayGifs != true) return;

        // Activate the realized card (viewport-gated by realization).
        if (el.DataContext is WallpaperCardViewModel card)
            ActivateGifCard(card);
        else
            el.DataContextChanged += OnElementDataContextChanged;
    }

    private void OnElementDataContextChanged(object? sender, EventArgs e)
    {
        if (sender is not StyledElement se) return;
        se.DataContextChanged -= OnElementDataContextChanged;
        if (Vm?.AutoPlayGifs == true && se.DataContext is WallpaperCardViewModel card)
            ActivateGifCard(card);
    }

    private static void ActivateGifCard(WallpaperCardViewModel card)
    {
        if (!card.IsAutoPlayGif || card.IsGifActive) return;
        card.IsGifActive = true;
    }

    // Restart the settle timer; GIFs (re)activate only once scrolling pauses.
    private void ScheduleGifReconcile()
    {
        if (Vm?.AutoPlayGifs != true) return;
        _gifSettleTimer ??= CreateGifSettleTimer();
        _gifSettleTimer.Stop();
        _gifSettleTimer.Start();
    }

    private DispatcherTimer CreateGifSettleTimer()
    {
        var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(160) };
        t.Tick += (_, _) => { t.Stop(); ReconcileBrowseGifs(); };
        return t;
    }

    // Animate the realized Browse cards. With VerticalCacheLength=0 the ItemsRepeater only realizes
    // ~the viewport, so "realized" already approximates "visible". ElementClearing deactivates cards
    // as they scroll out.
    private void ReconcileBrowseGifs()
    {
        if (Vm?.AutoPlayGifs != true) return;
        if (Vm.PreviewCard != null) return; // grid gifs paused while the preview modal is open
        foreach (var el in _realizedBrowse)
            if (el.DataContext is WallpaperCardViewModel card && card.IsAutoPlayGif && !card.IsGifActive)
                card.IsGifActive = true;
    }

    private void OnRepeaterElementClearing(object? sender, ItemsRepeaterElementClearingEventArgs e)
    {
        if (e.Element is not Control el) return;
        el.DataContextChanged -= OnElementDataContextChanged;
        if (ReferenceEquals(sender, BrowseItemsRepeater))
            _realizedBrowse.Remove(el);
        else if (ReferenceEquals(sender, LibraryItemsRepeater))
            _realizedLib.Remove(el);
        if (el.DataContext is WallpaperCardViewModel card && card.IsGifThumbnail)
            card.IsGifActive = false;
    }

    private void OnCardPointerEntered(object? sender, PointerEventArgs e)
    {
        if (sender is StyledElement se && se.DataContext is WallpaperCardViewModel card
            && card.IsGifThumbnail && !card.IsGifActive)
            card.IsGifActive = true;
    }

    private void OnCardPointerExited(object? sender, PointerEventArgs e)
    {
        if (sender is StyledElement se && se.DataContext is WallpaperCardViewModel card && card != _dragCard
            && card.IsGifThumbnail && Vm?.AutoPlayGifs == false && card.IsGifActive)
            card.IsGifActive = false;
    }

    private async void UpdateCardThumbnailHeight()
    {
        _cardHeightDebounce?.Cancel();
        _cardHeightDebounce = new System.Threading.CancellationTokenSource();
        var ct = _cardHeightDebounce.Token;
        try { await Task.Delay(40, ct); }
        catch (OperationCanceledException) { return; }
        if (Vm == null) return;
        var width = BrowseItemsRepeater.Bounds.Width > 0
            ? BrowseItemsRepeater.Bounds.Width
            : LibraryItemsRepeater.Bounds.Width;
        if (width > 0) _lastRepeaterWidth = width;
        else width = _lastRepeaterWidth;
        if (width <= 0) return;
        (double minCardWidth, double ratio) = Vm.ThumbnailAspect switch
        {
            "1:1"  => (MinCardWidthPortrait,  1.0),
            "16:9" => (MinCardWidthLandscape, 9.0 / 16.0),
            _      => (210.0,                 150.0 / 210.0),
        };
        double sizeMultiplier = Vm.CardSize switch
        {
            "Small" => 0.65,
            "Large" => 1.5,
            _       => 1.0,
        };
        minCardWidth *= sizeMultiplier;
        Vm.CardMinWidth = minCardWidth;
        Vm.CardButtonFontSize = Math.Clamp(Math.Round(13.0 * minCardWidth / 210.0), 9, 13);
        int cols = Math.Max(1, (int)Math.Floor(width / minCardWidth));
        double cardWidth = width / cols - CardHorizontalMargin;
        Vm.CardThumbnailHeight = Math.Round(cardWidth * ratio);
    }

    private void OnPlaylistScrollGif(object? sender, ScrollChangedEventArgs e)
    {
        if (Vm?.AutoPlayGifs != true) return;
        var offset = PlaylistScrollViewer.Offset.X;
        var viewportWidth = PlaylistScrollViewer.Viewport.Width;
        if (viewportWidth <= 0) return;
        for (int i = 0; i < Vm.PlaylistItems.Count; i++)
        {
            var card = Vm.PlaylistItems[i];
            if (!card.IsAutoPlayGif) continue;
            double left = i * PlaylistItemStride;
            bool inView = left + PlaylistItemWidth > offset && left < offset + viewportWidth;
            if (inView && !card.IsPlaylistGifActive) ActivatePlaylistGifCard(card);
            else if (!inView && card.IsPlaylistGifActive) card.IsPlaylistGifActive = false;
        }
    }

    private void OnPlaylistCardPointerEntered(object? sender, PointerEventArgs e)
    {
        if (sender is StyledElement se && se.DataContext is WallpaperCardViewModel card
            && card.IsGifThumbnail && !card.IsPlaylistGifActive)
            card.IsPlaylistGifActive = true;
    }

    private void OnPlaylistCardPointerExited(object? sender, PointerEventArgs e)
    {
        if (sender is StyledElement se && se.DataContext is WallpaperCardViewModel card && card != _dragCard
            && card.IsGifThumbnail && Vm?.AutoPlayGifs == false && card.IsPlaylistGifActive)
            card.IsPlaylistGifActive = false;
    }

    private static void ActivatePlaylistGifCard(WallpaperCardViewModel card)
    {
        if (!card.IsAutoPlayGif || card.IsPlaylistGifActive) return;
        card.IsPlaylistGifActive = true;
    }

    private void OnBrowseScrollChanged(object? sender, ScrollChangedEventArgs e)
    {
        if (sender is not ScrollViewer sv) return;
        if (DataContext is not MainWindowViewModel vm) return;

        ScheduleGifReconcile();

        if (_debugFreezeLoad) return;
        if (vm.IsLoading || vm.NoMorePages || !vm.SelectedSource.SupportsPagination) return;

        if (sv.Extent.Height - sv.Offset.Y - sv.Viewport.Height < 300)
            vm.LoadMoreCommand.Execute(null);
    }

    private sealed class SmoothScroller
    {
        private readonly ScrollViewer _sv;
        private double _velocity;
        private bool _animating;
        private TimeSpan? _lastTime;
        private const double Impulse = 80.0;
        private const double Friction = 0.85;
        private const double StopThreshold = 0.1;
        private const double MaxVelocity = 2500.0;

        public SmoothScroller(ScrollViewer sv)
        {
            _sv = sv;
            sv.AddHandler(PointerWheelChangedEvent, OnWheel, RoutingStrategies.Tunnel);
        }

        private void OnWheel(object? sender, PointerWheelEventArgs e)
        {
            // Let sliders and spinners handle their own wheel events
            if (e.Source is Slider or NumericUpDown) return;
            if ((e.Source as Visual)?.FindAncestorOfType<Slider>() != null) return;
            if ((e.Source as Visual)?.FindAncestorOfType<NumericUpDown>() != null) return;

            double delta = e.Delta.Y != 0 ? e.Delta.Y : e.Delta.X;
            _velocity = Math.Clamp(_velocity - delta * Impulse, -MaxVelocity, MaxVelocity);
            e.Handled = true;

            if (!_animating)
            {
                _animating = true;
                _lastTime = null;
                TopLevel.GetTopLevel(_sv)?.RequestAnimationFrame(OnFrame);
            }
        }

        private void OnFrame(TimeSpan time)
        {
            if (!_animating) return;

            double dt = _lastTime.HasValue
                ? Math.Min((time - _lastTime.Value).TotalMilliseconds, 64)
                : 16.0;
            _lastTime = time;

            _velocity *= Math.Pow(Friction, dt / 16.0);

            if (Math.Abs(_velocity) < StopThreshold)
            {
                _animating = false;
                _velocity = 0;
                return;
            }

            var currentOffset = _sv.Offset;
            bool isHorizontal = _sv.HorizontalScrollBarVisibility != ScrollBarVisibility.Disabled &&
                               _sv.VerticalScrollBarVisibility == ScrollBarVisibility.Disabled;

            if (isHorizontal)
            {
                var maxX = Math.Max(0, _sv.Extent.Width - _sv.Viewport.Width);
                var newX = Math.Clamp(currentOffset.X + _velocity * (dt / 16.0), 0, maxX);
                if (newX <= 0 || newX >= maxX) _velocity = 0;
                _sv.Offset = new Vector(newX, currentOffset.Y);
            }
            else
            {
                var maxY = Math.Max(0, _sv.Extent.Height - _sv.Viewport.Height);
                var newY = Math.Clamp(currentOffset.Y + _velocity * (dt / 16.0), 0, maxY);
                if (newY <= 0 || newY >= maxY) _velocity = 0;
                _sv.Offset = new Vector(currentOffset.X, newY);
            }

            TopLevel.GetTopLevel(_sv)?.RequestAnimationFrame(OnFrame);
        }
    }
}
