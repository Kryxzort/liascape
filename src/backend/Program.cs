using System;
using System.Linq;
using Liascape.Helpers;

namespace Liascape;

sealed class Program
{
    // The command line of `liascape-backend` — what the `liascape` launcher (scripts/liascape) hands every
    // subcommand but two: bare `liascape` opens the app, `liascape ctl …` goes to the player. No arguments
    // = `serve` (dev: `dotnet run --project src/backend`).
    public const string Usage = """
        usage: liascape [<command>]

          (no command)              open the app
          restore                   re-apply the last session (for autostart)
          next | previous           the next / previous wallpaper
          random                    a random library wallpaper
          play | stop | toggle-play
          toggle-pause | toggle-mute
          volume up | volume down   ±5 (the global volume or the playing wallpaper's — Settings)
          kill                      stop the wallpaper without asking a running app
          ctl <verb> ['<json>']     the running player's control socket (state, logs, probe, …)
          serve                     the app's backend (the app starts it itself)

        The keybind commands go to the running app when one is open, else they run here.
        """;

    public static void Main(string[] args)
    {
        var tMain = DateTime.Now;
        var cmd = args.Length == 0 ? "serve" : args[0];

        switch (cmd)
        {
            case "help" or "--help" or "-h":
                Console.WriteLine(Usage);
                return;
            case "serve":
                // Headless web backend for the Electron/React UI. Blocks. The Electron shell spawns this and
                // reads the chosen port from ~/.config/liascape/serve.port.
                Liascape.Web.ServerHost.Run(args.Skip(1).ToArray());
                return;
            // hidden: MpvPropertyMap + protocol round-trip against a private headless liascape-player (PASS/FAIL)
            case "player-selftest":
                Environment.Exit(Liascape.Player.LiascapePlayerSelfTest.Run());
                return;
        }

        PlayerHelper.LoadUserMuteState();

        switch (cmd)
        {
            case "kill":
                PlayerHelper.Stop();
                DrainLiascapePlayerBeforeExit();
                return;
            // internal: the daemons a closing app hands its work to (setsid-spawned by the backend itself)
            case "monitor-daemon":
                AudioMonitor.RunDaemon();
                return;
            case "timer-daemon":
                PlayerHelper.RunTimerDaemon();
                return;
            case "restart-daemon":
                PlayerHelper.RunRestartDaemon();
                return;
            case "restore":
                RunHeadlessAutoSync();
                try { PlayerHelper.Restore(); }
                catch (InvalidOperationException e)
                {
                    Console.Error.WriteLine($"liascape restore: {e.Message}");
                    Environment.ExitCode = 1;
                }
                DrainLiascapePlayerBeforeExit();
                return;
        }

        // A keybind action: its words joined by `-` (`liascape volume up` = `liascape volume-up`).
        var action = string.Join("-", args);
        if (!Liascape.Web.AppOps.Actions.Contains(action))
        {
            Console.Error.WriteLine($"liascape: unknown command '{string.Join(" ", args)}'\n\n{Usage}");
            Environment.ExitCode = 2;
            return;
        }
        var name = string.Join(" ", args);
        // A running app backend owns the session: hand the action to it, so it acts on its own state
        // (history, timer, mute) and the UI hears about the switch. Run here only when none answers.
        var tFwd = DateTime.Now;
        if (Liascape.Web.ActionForward.TryForward(action, out var code, out var message))
        {
            var start = System.Diagnostics.Process.GetCurrentProcess().StartTime;
            if ((DateTime.Now - start).TotalMilliseconds > 1500) // a keybind should feel instant
                Console.Error.WriteLine($"liascape {name}: slow — runtime start {(tMain - start).TotalMilliseconds:F0} ms, init {(tFwd - tMain).TotalMilliseconds:F0} ms, forward {(DateTime.Now - tFwd).TotalMilliseconds:F0} ms");
            if (message != null) Console.Error.WriteLine($"liascape {name}: {message}");
            Environment.ExitCode = code;
            return;
        }
        if (Liascape.Web.AppOps.RunAction(action) is string err)
        {
            Console.Error.WriteLine($"liascape {name}: {err}");
            Environment.ExitCode = 1;
        }
        DrainLiascapePlayerBeforeExit();
    }

    // liascape-player mutations are queued (fire-and-forget off the caller's thread — see
    // LiascapePlayerMedia.Queue / .claude/rules/player-adapter.md § Threading) so the long-lived `serve`
    // backend's _lock never waits on the player. A one-shot CLI invocation (`kill`, a keybind action,
    // `restore`) has no such lifetime: if the process exits right after enqueueing a switch/set, the
    // queued work may never actually run (the whole CLR goes with it) — the exact gap this closes,
    // found by the on-machine acceptance round (`volume up` silently not reaching a live
    // liascape-player wallpaper). Bounded and a no-op under legacy/when nothing was queued.
    internal static void DrainLiascapePlayerBeforeExit()
    {
        if (Liascape.Player.PlayerEngine.IsLiascapePlayer)
            try { Liascape.Player.LiascapePlayerMedia.Drain().Wait(3000); } catch { }
    }

    // Runs WE auto-import + playlist auto-add on `restore` and `serve` startup, so the library
    // stays populated.
    internal static void RunHeadlessAutoSync()
    {
        try
        {
            var settings = SettingsService.Load();
            // independent of auto-import: swap any direct-DL copy whose workshop ID now lives in the WE dir
            // for a symlink/copy of the WE file (in place → playlists/session stay valid; reclaims disk).
            if (settings.ReplaceDirectWithWorkshop)
                LibraryService.ReconcileDirectDownloads(settings.WorkshopFolder, settings.CopyFilesInsteadOfSymlinking);
            if (!settings.AutoAddWeWallpapersToLibrary) return;
            var newPaths = LibraryService.SyncWallpaperEngine(
                settings.WorkshopFolder, settings.AllowScenes, settings.CopyFilesInsteadOfSymlinking);
            if (newPaths.Count == 0) return;
            if (!settings.AutoAddLibraryToPlaylist) return;

            var state = PlaylistService.LoadCurrentState() ?? new Liascape.Models.CustomPlaylist();
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
                SettingsService.Update(s => s.LastSession = session);
            }
        }
        catch { }
    }
}
