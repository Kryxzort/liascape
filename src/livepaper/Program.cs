using System;
using System.Linq;
using livepaper.Helpers;

namespace livepaper;

sealed class Program
{
    public static void Main(string[] args)
    {
        var tMain = DateTime.Now;
        // hidden: MpvPropertyMap + protocol round-trip against a private headless lp-player (PASS/FAIL)
        if (args.Contains("--lp-player-selftest"))
            Environment.Exit(livepaper.Player.LpPlayerSelfTest.Run());

        PlayerHelper.LoadUserMuteState();

        if (args.Contains("--kill"))
        {
            PlayerHelper.Stop();
            DrainLpPlayerBeforeExit();
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
            // A running app backend owns the session: hand the action to it, so it acts on its own state
            // (history, timer, mute) and the UI hears about the switch. Run here only when none answers.
            var tFwd = DateTime.Now;
            if (livepaper.Web.ActionForward.TryForward(action, out var code, out var message))
            {
                var start = System.Diagnostics.Process.GetCurrentProcess().StartTime;
                if ((DateTime.Now - start).TotalMilliseconds > 1500) // a keybind should feel instant
                    Console.Error.WriteLine($"livepaper --action={action}: slow — runtime start {(tMain - start).TotalMilliseconds:F0} ms, init {(tFwd - tMain).TotalMilliseconds:F0} ms, forward {(DateTime.Now - tFwd).TotalMilliseconds:F0} ms");
                if (message != null) Console.Error.WriteLine($"livepaper --action={action}: {message}");
                Environment.ExitCode = code;
                return;
            }
            if (livepaper.Web.AppOps.RunAction(action) is string err)
            {
                Console.Error.WriteLine($"livepaper --action={action}: {err}");
                Environment.ExitCode = 1;
            }
            DrainLpPlayerBeforeExit();
            return;
        }

        if (args.Contains("--random"))
        {
            try { PlayerHelper.ApplyRandom(); }
            catch (InvalidOperationException e)
            {
                Console.Error.WriteLine($"livepaper --random: {e.Message}");
                Environment.ExitCode = 1;
            }
            DrainLpPlayerBeforeExit();
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
            try { PlayerHelper.Restore(); }
            catch (InvalidOperationException e)
            {
                Console.Error.WriteLine($"livepaper --restore: {e.Message}");
                Environment.ExitCode = 1;
            }
            DrainLpPlayerBeforeExit();
            return;
        }

        // Default + `--serve`: headless web backend for the Electron/React UI. Blocks. The Electron
        // shell spawns this and reads the chosen port from ~/.config/livepaper/serve.port.
        livepaper.Web.ServerHost.Run(args);
    }

    // lp-player mutations are queued (fire-and-forget off the caller's thread — see
    // LpPlayerMedia.Queue / .claude/rules/player-adapter.md § Threading) so the long-lived `--serve`
    // backend's _lock never waits on the player. A one-shot CLI invocation (--kill/--action=*/--random/
    // --restore) has no such lifetime: if the process exits right after enqueueing a switch/set, the
    // queued work may never actually run (the whole CLR goes with it) — the exact gap this closes,
    // found by the on-machine acceptance round (`--action=volume-up` silently not reaching a live
    // lp-player wallpaper). Bounded and a no-op under legacy/when nothing was queued.
    internal static void DrainLpPlayerBeforeExit()
    {
        if (livepaper.Player.PlayerEngine.IsLpPlayer)
            try { livepaper.Player.LpPlayerMedia.Drain().Wait(3000); } catch { }
    }

    // Runs WE auto-import + playlist auto-add on `--restore` and `--serve` startup, so the library
    // stays populated.
    internal static void RunHeadlessAutoSync()
    {
        try
        {
            var settings = SettingsService.Load();
            // independent of auto-import: swap any direct-DL copy whose workshop ID now lives in the WE dir
            // for a symlink/copy of the WE file (in place → playlists/session stay valid; reclaims disk).
            if (settings.ReplaceDirectWithWorkshop)
                LibraryService.ReconcileDirectDownloads(settings.WallpaperEnginePath, settings.WeCopyFiles);
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
}
