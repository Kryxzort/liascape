using Avalonia;
using System;
using System.Linq;
using livepaper.Helpers;

namespace livepaper;

sealed class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        PlayerHelper.LoadUserMuteState();

        if (args.Contains("--kill"))
        {
            PlayerHelper.Stop();
            return;
        }

        if (args.Contains("--monitor"))
        {
            AudioMonitor.RunDaemon();
            return;
        }

        var action = args.FirstOrDefault(a => a.StartsWith("--action="))?.Substring("--action=".Length);
        if (action != null)
        {
            switch (action)
            {
                case "toggle-mute":
                    if (PlayerHelper.IsUserMuted)
                        PlayerHelper.SetUserMute(false);
                    else if (PlayerHelper.IsMuted)
                        PlayerHelper.SetMute(false);
                    else
                        PlayerHelper.SetUserMute(true);
                    break;
                case "toggle-pause":
                    PlayerHelper.TogglePause();
                    break;
                case "stop":
                    PlayerHelper.Stop();
                    break;
                case "play":
                    PlayerHelper.Restore();
                    break;
                case "toggle-play":
                    if (PlayerHelper.IsPlaying || PlayerHelper.IsTimedPlaylistActive())
                        PlayerHelper.Stop();
                    else
                        PlayerHelper.Restore();
                    break;
                case "next-wallpaper":
                    PlayerHelper.NextWallpaper();
                    break;
                case "previous-wallpaper":
                    PlayerHelper.PreviousWallpaper();
                    break;
                case "random":
                    PlayerHelper.ApplyRandom();
                    break;
                case "volume-up":
                    PlayerHelper.AdjustVolume(5);
                    break;
                case "volume-down":
                    PlayerHelper.AdjustVolume(-5);
                    break;
            }
            return;
        }

        if (args.Contains("--random"))
        {
            PlayerHelper.ApplyRandom();
            return;
        }

        if (args.Contains("--timer-daemon"))
        {
            PlayerHelper.RunTimerDaemon();
            return;
        }

        if (args.Contains("--restart-daemon"))
        {
            PlayerHelper.RunRestartDaemon();
            return;
        }

        if (args.Contains("--restore"))
        {
            RunHeadlessAutoSync();
            PlayerHelper.Restore();
            return;
        }

        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    // Runs WE auto-import + playlist auto-add for `--restore` so daemon-style
    // launches pick up new wallpapers added since the last session.
    private static void RunHeadlessAutoSync()
    {
        try
        {
            var settings = SettingsService.Load();
            if (!settings.AutoImportWallpaperEngine) return;
            var newPaths = LibraryService.SyncWallpaperEngine(
                settings.WallpaperEnginePath, settings.AllowScenes, settings.WeCopyFiles);
            if (newPaths.Count == 0) return;
            if (!settings.AutoAddLibraryToPlaylist) return;

            var state = PlaylistService.LoadCurrentState() ?? new livepaper.Models.CustomPlaylist();
            var existing = new System.Collections.Generic.HashSet<string>(state.VideoPaths);
            foreach (var p in newPaths)
                if (existing.Add(p)) state.VideoPaths.Add(p);
            PlaylistService.SaveCurrentState(state);

            var session = settings.LastSession;
            if (session != null && (session.IsPlaylist || session.IsTimedPlaylist))
            {
                var sessExisting = new System.Collections.Generic.HashSet<string>(session.Paths);
                var merged = new System.Collections.Generic.List<string>(session.Paths);
                foreach (var p in newPaths)
                    if (sessExisting.Add(p)) merged.Add(p);
                session.Paths = merged;
                SettingsService.Save(settings);
            }
        }
        catch { }
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
