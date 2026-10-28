using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Helpers;

public static class PlayerHelper
{
    private static Process? _current;
    private static Timer? _playlistTimer;
    private static Timer? _restartTimer;
    // RestartOnSwitchOnly: a leak-restart is due but deferred to the next wallpaper switch (so the
    // relaunch rides the natural changeover instead of a jarring mid-video restart). Lives in the tick
    // owner's memory; set when it consumes a "soft-restart" pending action, consumed by the next SwitchToFile.
    private static bool _restartPending;
    private static bool _daemonMode = false;
    private static List<string>? _timedPaths;
    private static int _timedIndex;
    private static string _timedOptions = "";
    private static bool _timedShuffle;
    private static TimeSpan _timedInterval;
    private static List<string>? _history;
    private static int _historyIndex = -1;
    private static bool _timedTimerPaused;
    private static bool _timedTimerStopped;
    private static long _timedRemainingMs;
    private static DateTime _lastTickTime;
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(100);
    private static CancellationTokenSource? _observerCts;
    private static List<string> _currentObserverPaths = [];
    private static readonly object _lock = new();
    private static CancellationTokenSource? _daemonCts;
    private static bool _advanceOnVideoEnd;
    private static bool _waitingForVideoEnd;
    // ── Rotation (player-adapter.md § Rotation). "Switch when video ends" off: `_timedInterval` is a plain timer.
    // On: `_timedInterval` IS the minimum play time (MinPlayMs — the one interval field, relabelled in the UI) and
    // `_maxPlayMs` the maximum (wall-clock ms, 0 = off — the playlist's own when it overrides the globals, else the
    // global one: read from the config at a session's start / resume, live from /settings + /playlist/state), and
    // with `_separateScenes` ("Separate timing for scenes") a scene / still image switches after `_scenesAfterMs`
    // instead (0 = off; same source, same live path — ItemPlayRule). The playing item's play time (wall-clock ms since
    // it became current, pauses excluded — the tick counts it; persisted in timed_state with the moment it was saved,
    // so a backend restart counts the time the player played on meanwhile) is what all of them are measured against.
    private static long _maxPlayMs;
    private static bool _separateScenes;
    private static long _scenesAfterMs;
    private static long _itemPlayedMs;
    private static long MinPlayMs => _advanceOnVideoEnd ? (long)_timedInterval.TotalMilliseconds : 0;
    private static double _currentSpeed = 1.0;
    private static CancellationTokenSource? _waitCts;
    private static CancellationTokenSource? _prelaunchCts;
    private static string[]? _prelaunchPidsToKill;
    private static bool _isMuted;
    private static bool _autoMuted;
    private static bool _userMuted;
    private static volatile TaskCompletionSource<bool>? _speedChangeTcs;
    public static CancellationToken DaemonToken => _daemonCts?.Token ?? CancellationToken.None;

    public static bool IsPlaying => PlayerEngine.IsLiascapePlayer ? LiascapePlayerMedia.IsPlaying() : (
        (File.Exists(IpcSocket) && MpvpaperProcs().Length > 0) ||
        IsLweRunning);

    private static bool IsLweRunning
    {
        get
        {
            try
            {
                if (!File.Exists(LwePidPath)) return false;
                return File.ReadAllLines(LwePidPath).Any(line =>
                {
                    if (!int.TryParse(line.Trim(), out int pid)) return false;
                    try { using var p = Process.GetProcessById(pid); return !p.HasExited; }
                    catch { return false; }
                });
            }
            catch { return false; }
        }
    }

    public static bool IsTimedModeActive { get { lock (_lock) { return _timedPaths != null; } } }

    // When _waitingForVideoEnd is true, _historyIndex points to the pre-fetched next item.
    // This returns the index of the item that is actually playing.
    private static int PlayingHistoryIndex =>
        (_waitingForVideoEnd && _historyIndex > 0) ? _historyIndex - 1 : _historyIndex;

    public static void AppendToActivePlaylist(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0) return;
        lock (_lock)
        {
            if (_timedPaths != null)
            {
                var existing = new HashSet<string>(_timedPaths, StringComparer.Ordinal);
                foreach (var p in paths)
                    if (existing.Add(p)) _timedPaths.Add(p);
                EnsureTimedTick(takeBack: false);
            }
            else if (IsPlaying)
            {
                foreach (var p in paths)
                    TrySendCommand("loadfile", p, "append");
            }
        }
    }
    public static bool IsUserMuted => _userMuted;
    public static bool IsMuted => _isMuted;

    // Stale-tolerant check that survives the brief gap during a timed-playlist
    // switch where mpvpaper has been killed but the next instance hasn't launched.
    public static bool IsTimedPlaylistActive()
    {
        try
        {
            if (!File.Exists(TimedStatePath)) return false;
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            return state != null && state.Paths.Count > 0 && !state.TimerStopped;
        }
        catch { return false; }
    }

    private static bool IsTimedPlaylistPaused()
    {
        try
        {
            if (!File.Exists(TimedStatePath)) return false;
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            return state?.TimerPaused ?? false;
        }
        catch { return false; }
    }

    // Daemon-side (no in-memory history): read the timed-state file for the item count + current path,
    // so RunRestartDaemon can apply the same scene-skip / defer-to-switch logic as the in-process timer.
    private static (int Count, string? Current) ReadTimedSnapshot()
    {
        try
        {
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            if (state == null) return (0, null);
            int hi = state.WaitingForVideoEnd && state.HistoryIndex > 0 ? state.HistoryIndex - 1 : state.HistoryIndex;
            string? cur = state.History != null && hi >= 0 && hi < state.History.Count ? state.History[hi] : null;
            return (state.Paths.Count, cur);
        }
        catch { return (0, null); }
    }

    private static string IpcSocket => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") ?? Path.GetTempPath(),
        "liascape", "mpv.sock");

    // Control socket for a running full-live transition overlay (liascape-transition binds it). Lets a keybind
    // during the effect reach the overlay's OWN audio (it decodes A/B itself; mpvpaper isn't audible then).
    private static string OverlayCtlSocket => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") ?? Path.GetTempPath(),
        "liascape", "liascape-transition.ctl");

    // Best-effort live command (mute/volume) to a transition overlay if one is listening (DGRAM, no-op
    // otherwise). So toggle-mute / volume± mid-effect take hold immediately instead of post-teardown.
    private static void SendOverlayCtl(string cmd)
    {
        try
        {
            if (!File.Exists(OverlayCtlSocket)) return;
            using var s = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.Unix,
                System.Net.Sockets.SocketType.Dgram, System.Net.Sockets.ProtocolType.Unspecified);
            s.SendTo(System.Text.Encoding.UTF8.GetBytes(cmd), new System.Net.Sockets.UnixDomainSocketEndPoint(OverlayCtlSocket));
        }
        catch { }
    }

    // ── liascape-audio: libpulse helper for gapless scene-audio crossfades ───────────────────────────────
    // A persistent process holding a PulseAudio context that applies per-PID sink-input volume/mute
    // IN-PROCESS on every stream new/change event — so a stream PA (re)creates at the wrong volume
    // (default-on-create / LWE connect-disconnect reset) is corrected in ~1ms, which shelling `pactl`
    // (~10-40ms) can't. Driven over stdin: "set <pidcsv> <vol> <mute>", "clear", "quit".
    private static Process? _liascapeAudio;
    private static readonly object _liascapeAudioLock = new();

    private static string? ResolveLiascapeAudioBin()
    {
        var env = Environment.GetEnvironmentVariable("LIASCAPE_AUDIO_BIN");
        if (env != null && File.Exists(env)) return env;
        foreach (var c in new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin", "liascape-audio"),
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "native", "liascape-audio", "liascape-audio"),
            Path.Combine(Directory.GetCurrentDirectory(), "src", "native", "liascape-audio", "liascape-audio") })
            try { var f = Path.GetFullPath(c); if (File.Exists(f)) return f; } catch { }
        return null;
    }

    // Send one command to the persistent liascape-audio (spawned lazily, respawned if dead). No-op if the
    // helper isn't built (→ scene audio just isn't crossfaded, falls back to the plain switch).
    private static void AudioCtl(string line)
    {
        try
        {
            lock (_liascapeAudioLock)
            {
                if (_liascapeAudio == null || _liascapeAudio.HasExited)
                {
                    var bin = ResolveLiascapeAudioBin();
                    if (bin == null) { TransitionService.TransLog($"AudioCtl: NO liascape-audio binary found"); return; }
                    var psi = new ProcessStartInfo(bin) { UseShellExecute = false, RedirectStandardInput = true };
                    _liascapeAudio = Process.Start(psi);
                }
                _liascapeAudio?.StandardInput.WriteLine(line);
                _liascapeAudio?.StandardInput.Flush();
            }
        }
        catch { try { lock (_liascapeAudioLock) { _liascapeAudio = null; } } catch { } }
    }
    private static string PidCsv(IEnumerable<int> pids) => string.Join(",", pids);

    // PulseAudio stream-restore continuously saves the linux-wallpaperengine app volume, so a transient
    // crossfade value (e.g. 25% mid-fade, or 0% at fade-out) gets remembered and poisons the NEXT fresh
    // scene launch (first playlist item / --restore / --random) — which has no crossfade to set the right
    // level → it comes up silent/quiet. LWE forces its own application.name and pipewire ignores
    // module-stream-restore.id, so we can't change the restore key. Instead, correct reactively: hold the
    // just-launched scene at `target` via liascape-audio (event-driven → overrides the restored value the instant
    // the stream appears) for ~holdMs, then release so manual volume control governs the steady state.
    private static void CorrectSceneVolume(HashSet<int> beforePids, int target, bool muted, int holdMs)
    {
        _ = Task.Run(async () =>
        {
            int m = muted ? 1 : 0, steps = Math.Max(4, holdMs / 250);
            AudioCtl("clear");
            for (int k = 0; k < steps; k++)
            {
                var np = GetLweProcPids(); np.ExceptWith(beforePids);   // the newly-launched scene's pids
                if (np.Count > 0) AudioCtl($"set {PidCsv(np)} {target} {m}");
                try { await Task.Delay(250); } catch { break; }
            }
            AudioCtl("clear");
        });
    }

    private static string TimedStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "timed_state.json");

    private static string PlaylistObserverPathsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "liascape", "playlist_observer_paths.json");

    private static string TimerDaemonPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "timer.pid");

    private static string RestartDaemonPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "restart.pid");

    private static string LwePidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "lwe.pid");

    private static string GuiTimerPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "gui_timer.pid");

    private static string UserMuteStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "user_mute.state");

    private static string PendingActionPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "pending_action.txt");

    public static void KillTimerDaemon()
    {
        try
        {
            if (!File.Exists(TimerDaemonPidPath)) return;
            var pidText = File.ReadAllText(TimerDaemonPidPath).Trim();
            if (int.TryParse(pidText, out int pid))
            {
                try { System.Diagnostics.Process.GetProcessById(pid).Kill(); } catch { }
            }
            File.Delete(TimerDaemonPidPath);
        }
        catch { }
    }

    public static void WriteGuiTimerPid()
    {
        try
        {
            var path = GuiTimerPidPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AtomicFile.WriteAllText(path, Environment.ProcessId.ToString()); // a reader mid-write saw no owner
        }
        catch { }
    }

    // only our own claim: a stopping backend deleting the NEXT one's let SpawnTimerDaemon's guard spawn a
    // daemon next to it
    public static void ClearGuiTimerPid()
    {
        try { if (File.ReadAllText(GuiTimerPidPath).Trim() == Environment.ProcessId.ToString()) File.Delete(GuiTimerPidPath); } catch { }
    }

    // Another live `--serve` backend's pid in gui_timer.pid (it took the timed playlist over), else null.
    // Checked by its cmdline, not liveness alone: a stale file's pid may belong to anything by now.
    private static int? OtherTimerOwner()
    {
        try
        {
            if (!int.TryParse(File.ReadAllText(GuiTimerPidPath).Trim(), out int pid) || pid == Environment.ProcessId) return null;
            var argv = File.ReadAllText($"/proc/{pid}/cmdline").Split('\0');
            return argv.Contains("--serve") && argv.Any(a => a.Contains("liascape")) ? pid : null;
        }
        catch { return null; }
    }

    // This process stops owning the timed playlist — its backend is shutting down and hands it to a
    // `--timer-daemon`, or another backend took it over — WITHOUT touching the session the new owner
    // resumes from (saved first; TeardownTimer would clear it and consume a pending action): no more
    // ticks, and its armed end-of-video wait is cancelled (the new owner arms its own; left armed, it
    // would be superseded and switch now). The stopping backend used to tick on until the process exited
    // — up to Kestrel's 30 s shutdown timeout while the UI's WebSocket held it open — next to the daemon
    // and then the next backend: their aligned switches superseded each other, a dev restart switched
    // the wallpaper every 1–16 s.
    private static volatile bool _timerReleased;
    private static DateTime _ownerCheckedAt;
    public static void ReleaseTimer()
    {
        lock (_lock)
        {
            SaveTimedState();
            _timerReleased = true;
            _playlistTimer?.Dispose();
            _playlistTimer = null;
            _waitCts?.Cancel();
            StopRestartTimer();
        }
    }

    private static bool IsGuiTimerAlive()
    {
        try
        {
            if (!File.Exists(GuiTimerPidPath)) return false;
            var pidText = File.ReadAllText(GuiTimerPidPath).Trim();
            if (!int.TryParse(pidText, out int pid)) return false;
            using var _ = System.Diagnostics.Process.GetProcessById(pid);
            return true;
        }
        catch { return false; }
    }

    public static void SpawnTimerDaemon()
    {
        // Defensive guard: if a GUI is alive it owns the in-process timer.
        // Spawning a daemon would create two competing owners of mpvpaper.
        if (IsGuiTimerAlive()) return;

        FlushTimedState(); // persist current remaining time before handing off
        KillTimerDaemon();
        try
        {
            var selfArgs = GetSelfInvocationArgs();
            if (selfArgs.Count == 0) return;
            var psi = new System.Diagnostics.ProcessStartInfo("setsid")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in selfArgs) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("--timer-daemon");
            var proc = System.Diagnostics.Process.Start(psi);
            if (proc != null)
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            }
        }
        catch { }
    }

    // Build the argv prefix needed to re-invoke this same liascape process
    // (without args).
    //   - Self-contained (AppImage, install.sh): the apphost binary and
    //     entry assembly share a name (liascape / liascape-backend.dll). The
    //     apphost runs its bundled dll automatically; we just spawn it.
    //   - Framework-dependent (AUR PKGBUILD): the process executable is the
    //     dotnet host. We need to pass the entry assembly path so the
    //     spawned host knows what to run.
    public static List<string> GetSelfInvocationArgs()
    {
        var args = new List<string>();
        var processPath = Environment.ProcessPath
            ?? System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
        if (string.IsNullOrEmpty(processPath)) return args;
        args.Add(processPath);

        var entryAsm = System.Reflection.Assembly.GetEntryAssembly()?.Location;
        if (string.IsNullOrEmpty(entryAsm) || !entryAsm.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            return args;

        // Apphost vs dotnet host: in a self-contained build the apphost is
        // named after the assembly (liascape ↔ liascape-backend.dll), so the names
        // match and we don't need a separate dll arg. Framework-dependent
        // builds run under `dotnet` whose name differs.
        var procStem = Path.GetFileNameWithoutExtension(processPath);
        var asmStem = Path.GetFileNameWithoutExtension(entryAsm);
        if (!string.Equals(procStem, asmStem, StringComparison.OrdinalIgnoreCase))
            args.Add(entryAsm);

        return args;
    }

    public static void WriteTimerDaemonPid()
    {
        try
        {
            var path = TimerDaemonPidPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AtomicFile.WriteAllText(path, Environment.ProcessId.ToString()); // a reader mid-write saw no owner
        }
        catch { }
    }

    public static void DeleteTimerDaemonPid()
    {
        try { File.Delete(TimerDaemonPidPath); } catch { }
    }

    public static void KillRestartDaemon()
    {
        try
        {
            if (!File.Exists(RestartDaemonPidPath)) return;
            var pidText = File.ReadAllText(RestartDaemonPidPath).Trim();
            if (int.TryParse(pidText, out int pid))
            {
                try { System.Diagnostics.Process.GetProcessById(pid).Kill(); } catch { }
            }
            File.Delete(RestartDaemonPidPath);
        }
        catch { }
    }

    private static void WriteRestartDaemonPid()
    {
        try
        {
            var path = RestartDaemonPidPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AtomicFile.WriteAllText(path, Environment.ProcessId.ToString()); // a reader mid-write saw no owner
        }
        catch { }
    }

    private static void DeleteRestartDaemonPid()
    {
        try { File.Delete(RestartDaemonPidPath); } catch { }
    }

    public static void SpawnRestartDaemon()
    {
        // Mirror the timer-daemon guard: if the GUI is alive it owns the
        // in-process restart timer, so don't spawn a competing daemon.
        if (IsGuiTimerAlive()) return;
        if (SettingsService.Load().RestartIntervalSeconds <= 0) return;
        if (PlayerEngine.IsLiascapePlayer) return; // mpvpaper leak workaround — legacy only

        KillRestartDaemon();
        try
        {
            var selfArgs = GetSelfInvocationArgs();
            if (selfArgs.Count == 0) return;
            var psi = new System.Diagnostics.ProcessStartInfo("setsid")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in selfArgs) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("--restart-daemon");
            var proc = System.Diagnostics.Process.Start(psi);
            if (proc != null)
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            }
        }
        catch { }
    }

    // Start or restart the in-process restart timer based on current settings.
    // No-op in daemon processes (they use their own loop or pending actions).
    public static void UpdateRestartTimer()
    {
        _restartTimer?.Dispose();
        _restartTimer = null;
        if (_daemonMode) return;
        if (PlayerEngine.IsLiascapePlayer) return; // the leak-restart is an mpvpaper workaround — legacy only
        var settings = SettingsService.Load();
        if (settings.RestartIntervalSeconds <= 0) return;
        int intervalMs = settings.RestartIntervalSeconds * 1000;
        _restartTimer = new Timer(_ => RestartCurrent(), null,
            TimeSpan.FromMilliseconds(intervalMs),
            TimeSpan.FromMilliseconds(intervalMs));
    }

    private static void StopRestartTimer()
    {
        _restartTimer?.Dispose();
        _restartTimer = null;
    }

    // In-process restart: re-launch the current wallpaper cold to free memory.
    // For timed playlist sessions, delegates via pending action so the tick
    // owner (which holds the in-memory path list) handles it.
    private static void RestartCurrent()
    {
        var settings = SettingsService.Load();
        lock (_lock)
        {
            if (_timedPaths != null && !_timedTimerStopped)
            {
                if (_timedTimerPaused) return;
                // Scene playing → mpvpaper isn't running; the restart is moot. Skip (this is what "zeroes"
                // the restart timer while a scene plays — firing does nothing).
                var cur = _history != null && PlayingHistoryIndex >= 0 && PlayingHistoryIndex < _history.Count
                    ? _history[PlayingHistoryIndex] : null;
                if (cur != null && IsScenePath(cur)) return;
                // RestartOnSwitchOnly + a real playlist (a switch is coming) → defer: the next changeover
                // becomes the relaunch. Otherwise (toggle off, or playlist-of-1 = no switch) → jarring restart now.
                if (settings.RestartOnSwitchOnly && _timedPaths.Count > 1)
                    WritePendingAction("soft-restart");
                else
                    WritePendingAction("restart");
                return;
            }
            // Guard against the race where Stop() runs while this callback
            // was waiting on the lock: don't relaunch if nothing is playing.
            if (!IsPlaying) return;
            var session = settings.LastSession;
            if (session == null || session.Paths.Count == 0) return;
            DoColdRestart(session, settings); // lone video → default (jarring) restart
        }
    }

    // Restart without advancing: used by the timed playlist tick when it
    // consumes a "restart" pending action.
    private static void RestartCurrentAndLaunch()
    {
        if (PlayerEngine.IsLiascapePlayer) return; // a stale "restart" pending action — nothing leaks under liascape-player
        // what PLAYS: an advance-on-end session's _historyIndex is its pre-fetched next (a restart relaunched
        // that — reachable in every advance-on-end session now that pure advance-on-end ticks too)
        int playing = PlayingHistoryIndex;
        if (_history == null || playing < 0 || playing >= _history.Count) return;
        var current = _history[playing];
        KillCurrentProcess();
        _current = Launch(_timedOptions, current);
        // deliberately does not touch _timedRemainingMs — the countdown continues unaffected
        SaveTimedState();
    }

    // Kill and cold-start mpvpaper with the given session. Must be called under _lock.
    private static void DoColdRestart(LastSession session, AppSettings settings)
    {
        if (session.IsPlaylist && session.Paths.Count > 1)
        {
            var cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cache", "liascape");
            Directory.CreateDirectory(cacheDir);
            var playlistPath = Path.Combine(cacheDir, "playlist.txt");
            File.WriteAllLines(playlistPath, session.Paths.Take(session.Paths.Count - 1));
            var shuffleFlag = session.Shuffle ? " --shuffle" : "";
            var options = $"{settings.BuildMpvPlaylistOptions()} --playlist={playlistPath} --loop-playlist=inf{shuffleFlag}";
            KillCurrentProcess();
            _current = Launch(options, session.Paths[session.Paths.Count - 1]);
        }
        else
        {
            KillCurrentProcess();
            _current = Launch(settings.BuildMpvOptions(), session.Paths[0]);
        }
    }

    // Entry point for the --restart-daemon CLI flag. Blocks indefinitely,
    // restarting mpvpaper every RestartIntervalSeconds. Killed when the GUI opens.
    public static void RunRestartDaemon()
    {
        _daemonMode = true;
        InstallShutdownReaper();
        WriteRestartDaemonPid();
        try
        {
            while (true)
            {
                var settings = SettingsService.Load();
                if (settings.RestartIntervalSeconds <= 0) return;
                int intervalMs = settings.RestartIntervalSeconds * 1000;
                Thread.Sleep(intervalMs);
                settings = SettingsService.Load();
                if (PlayerEngine.WouldBeLiascapePlayer(settings)) continue; // mpvpaper leak workaround — legacy only
                if (IsTimedPlaylistActive() && !IsTimedPlaylistPaused())
                {
                    var (count, cur) = ReadTimedSnapshot();
                    if (cur != null && IsScenePath(cur)) { /* scene → skip (zeroes the restart timer) */ }
                    else if (settings.RestartOnSwitchOnly && count > 1) WritePendingAction("soft-restart");
                    else WritePendingAction("restart");
                }
                else if (IsPlaying)
                {
                    var session = settings.LastSession;
                    if (session != null && session.Paths.Count > 0)
                        lock (_lock) { DoColdRestart(session, settings); }
                }
            }
        }
        finally
        {
            DeleteRestartDaemonPid();
        }
    }

    public static void FlushTimedState()
    {
        lock (_lock) { SaveTimedState(); }
    }

    public static Action? OnTimedPlaylistStopped;
    public static Action<string>? OnSceneCrashed;
    // liascape-player Task 8: the VRAM guard stopped a scene (path, used MiB, limit MiB, the UI's text)
    public static Action<string, double, double, string>? OnSceneVramStoppedCb;
    public static Action<string?>? OnWallpaperChanged;

    private record TimedState(
        List<string> Paths, int Index,
        string Options, bool Shuffle, int IntervalSeconds,
        List<string> History, int HistoryIndex,
        bool TimerPaused = false, bool TimerStopped = false, long RemainingMs = 0,
        bool AdvanceOnVideoEnd = false, bool WaitingForVideoEnd = false,
        long ItemPlayedMs = 0, long PlayedSavedAtMs = 0);

    private static void SaveTimedState()
    {
        if (_timedPaths == null || _history == null) return;
        try
        {
            var state = new TimedState(
                _timedPaths, _timedIndex,
                _timedOptions, _timedShuffle, (int)_timedInterval.TotalSeconds,
                _history, _historyIndex,
                _timedTimerPaused, _timedTimerStopped, _timedRemainingMs,
                _advanceOnVideoEnd, _waitingForVideoEnd,
                _itemPlayedMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            var path = TimedStatePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AtomicFile.WriteAllText(path, JsonSerializer.Serialize(state));
        }
        catch { }
    }

    // Lighter than LoadTimedState: only syncs flags that external mutators
    // can set (TimerStopped/TimerPaused). The owner's _timedRemainingMs and
    // history stay authoritative in-memory, so we don't need to save state
    // every tick.
    private static void RefreshSignals()
    {
        try
        {
            if (!File.Exists(TimedStatePath)) return;
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            if (state == null) return;
            _timedTimerStopped = state.TimerStopped;
            _timedTimerPaused = state.TimerPaused;
        }
        catch { }
        // Sync user mute state from file so CLI toggle-mute updates reach the running daemon.
        try
        {
            bool fileMuted = File.Exists(UserMuteStatePath);
            if (fileMuted != _userMuted)
            {
                _userMuted = fileMuted;
                _isMuted = fileMuted || _autoMuted;
            }
        }
        catch { }
    }

    public static void LoadUserMuteState()
    {
        try { _userMuted = File.Exists(UserMuteStatePath); _isMuted = _userMuted || _autoMuted; }
        catch { }
    }

    // Atomic write: a separate file means the timer owner's state file is
    // never clobbered by external mutators.
    private static void WritePendingAction(string action)
    {
        try
        {
            var path = PendingActionPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, action);
            File.Move(tmp, path, overwrite: true);
        }
        catch { }
    }

    private static string? PeekPendingAction()
    {
        try { return File.Exists(PendingActionPath) ? File.ReadAllText(PendingActionPath).Trim() : null; }
        catch { return null; }
    }

    private static string? ConsumePendingAction()
    {
        try
        {
            if (!File.Exists(PendingActionPath)) return null;
            var action = File.ReadAllText(PendingActionPath).Trim();
            File.Delete(PendingActionPath);
            return string.IsNullOrEmpty(action) ? null : action;
        }
        catch { return null; }
    }

    private static bool LoadTimedState()
    {
        try
        {
            if (!File.Exists(TimedStatePath)) return false;
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            if (state == null || state.Paths.Count == 0) return false;
            _timedPaths = state.Paths;
            _timedIndex = state.Index;
            _timedOptions = state.Options;
            _timedShuffle = state.Shuffle;
            _timedInterval = TimeSpan.FromSeconds(state.IntervalSeconds);
            _history = state.History;
            _historyIndex = state.HistoryIndex;
            _timedTimerPaused = state.TimerPaused;
            _timedTimerStopped = state.TimerStopped;
            _timedRemainingMs = state.RemainingMs > 0 ? state.RemainingMs : (long)_timedInterval.TotalMilliseconds;
            _advanceOnVideoEnd = state.AdvanceOnVideoEnd;
            _waitingForVideoEnd = state.WaitingForVideoEnd;
            // the playing item's play time: what was counted + (unpaused) the time since it was saved — the player
            // outlives the backend and kept playing while no process counted (a restart, the daemon hand-over)
            _itemPlayedMs = PlayedAfterLoad(state.ItemPlayedMs, state.PlayedSavedAtMs, state.TimerPaused, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            // Restore speed for tick speed factor (video-time vs wall-clock). Per-video
            // override picked up via mpv IPC SetSpeed on next transition.
            _currentSpeed = SettingsService.Load().Speed;
            return true;
        }
        catch { return false; }
    }

    public static void Apply(string videoPath, string mpvOptions)
    {
        lock (_lock)
        {
            if (IsScenePath(videoPath))
            {
                if (PlayerEngine.IsLiascapePlayer)
                {
                    // Phase 2: liascape-player plays scenes when they're on and the player can (its worker +
                    // WE's assets) — else the reason; a crashed one only when whitelisted (D6)
                    if (PlayerEngine.SceneUnavailableReason(SettingsService.Load()) is string why) throw new InvalidOperationException(why);
                    if (LibraryService.HasCrashed(videoPath) && !LibraryService.IsWhitelisted(videoPath))
                        throw new InvalidOperationException("This scene crashed and won't be played — tick \"Whitelist\" in its settings to play it anyway");
                }
                else
                {
                    var s = SettingsService.Load();
                    if (!s.AllowScenes)
                        throw new InvalidOperationException("Enable \"Allow scene support\" in Settings to play scenes");
                    if (!IsLweAvailable())
                        throw new InvalidOperationException("linux-wallpaperengine not found in PATH — install it to use scenes");
                }
            }
            TeardownTimer();
            ClearTimedStateFile();
            // I1: a new session plays — unless it's a user next/prev/random keeping the pause
            if (PlayerEngine.IsLiascapePlayer && !_keepPauseNextSwitch) LiascapePlayerMedia.QueueNewSession();
            SwitchToFile(videoPath, mpvOptions);
            // Track the single item so QueryCurrentPath works for scenes (no mpv socket to query) and a
            // live override can identify what's playing. _timedPaths stays null → no timed-playlist logic.
            _history = [videoPath];
            _historyIndex = 0;
        }
        UpdateRestartTimer();
    }

    public static void ApplyPlaylist(IReadOnlyList<string> videoPaths, string mpvOptions, bool shuffle = false, int intervalSeconds = 0)
    {
        if (videoPaths.Count == 0) return;
        lock (_lock)
        {
            _advanceOnVideoEnd = false;
            KillAll();
            ClearTimedStateFile();
            ClearPlaylistObserverPaths();

            var paths = shuffle
                ? videoPaths.OrderBy(_ => Guid.NewGuid()).ToArray()
                : videoPaths.ToArray();

            // scenes (they never end): the timed machinery under advance-on-end — a scene moves on at the minimum
            // play time (`intervalSeconds`), else at the maximum, else at a user switch (§ Rotation)
            var settings = SettingsService.Load();
            if (PlayerEngine.ScenesPlayable(settings) && paths.Any(IsScenePath))
            {
                ApplyTimedPlaylist(paths, mpvOptions, shuffle, intervalSeconds, advanceOnVideoEnd: true);
                return;
            }

            paths = paths.Where(p => !IsScenePath(p)).ToArray();
            if (paths.Length == 0) return;

            if (paths.Length == 1)
            {
                _current = Launch(mpvOptions, paths[0]);
                OnWallpaperChanged?.Invoke(paths[0]);
            }
            else
            {
                // Liascape-owned: full playlist control, mid-session injection, no mpv playlist file
                ApplyTimedPlaylist(paths, mpvOptions, shuffle, intervalSeconds, advanceOnVideoEnd: true);
                return;
            }
        }
        UpdateRestartTimer();
    }

    // `intervalSeconds`: advance-on-end off → the timer; on → the minimum play time (§ Rotation)
    public static void ApplyTimedPlaylist(IReadOnlyList<string> paths, string mpvOptions, bool shuffle, int intervalSeconds, bool advanceOnVideoEnd = false)
    {
        lock (_lock)
        {
            TeardownTimer();
            if (paths.Count == 0) { KillCurrentProcess(); return; }

            var ordered = new List<string>(paths); // caller is responsible for initial order; shuffle flag only controls cycle-end reshuffle
            // liascape-player: start at the first item that can play — a scene marked crashed (D6) first in the
            // list used to reach SwitchToFile, which stops playback for an unplayable scene (legacy unchanged)
            int first = 0;
            if (PlayerEngine.IsLiascapePlayer && IsSkippedPath(ordered[0]))
            {
                bool ok = PlayerEngine.ScenesPlayable(SettingsService.Load());
                first = ordered.FindIndex(p => !IsSkippedPath(p, ok));
                if (first < 0) { KillCurrentProcess(); return; }
            }

            _timedPaths = ordered;
            _timedIndex = first;
            _timedOptions = mpvOptions;
            _timedShuffle = shuffle;
            _timedInterval = TimeSpan.FromSeconds(intervalSeconds);
            _timedTimerPaused = false;
            _timedTimerStopped = false;
            _timedRemainingMs = (long)_timedInterval.TotalMilliseconds;
            _advanceOnVideoEnd = advanceOnVideoEnd;
            RefreshPlayLimits();
            _itemPlayedMs = 0;
            // Pick up per-video speed override for the first item so tick scales interval
            // correctly from the first tick rather than after the next transition's SetSpeed.
            // Scenes always play at 1× (tick uses 1.0 factor anyway), so override irrelevant for them.
            _currentSpeed = IsScenePath(ordered[first])
                ? SettingsService.Load().Speed
                : (ReadSpeedOverride(ordered[first]) ?? SettingsService.Load().Speed);
            _history = [ordered[first]];
            _historyIndex = 0;
            if (PlayerEngine.IsLiascapePlayer) LiascapePlayerMedia.QueueNewSession(); // I1: a new playlist session plays (Play / play-from while paused stayed paused)
            SwitchToFile(ordered[first], mpvOptions);

            if (_advanceOnVideoEnd && !IsScenePath(ordered[first]) && ordered.Count > 1)
            {
                var next = AdvanceToNext();
                if (next != null)
                {
                    ArmVideoEndWait(next);
                }
            }

            SaveTimedState();

            EnsureTimedTick();
        }
        UpdateRestartTimer();
    }

    // Re-arms DoVideoEndWait after state is loaded from disk (daemon resume/restore).
    // Handles three cases:
    //   (a) Current item is a scene → clear wait flag, no rearm. Timer ticks normally.
    //   (b) Saved _waitingForVideoEnd=true (the advance-on-end pre-fetch's wait was in flight)
    //       → rearm DoVideoEndWait on the prefetched next.
    //   (c) Saved _waitingForVideoEnd=false + _advanceOnVideoEnd=true → set up new pre-fetch wait.
    // Must be called inside _lock.
    private static void RearmAdvanceOnVideoEnd()
    {
        if (_timedPaths == null || _timedPaths.Count <= 1 || _history == null) return;

        // Currently playing item: when _waitingForVideoEnd was saved true, _historyIndex is
        // pre-fetched ahead so the actual playing item is at index-1.
        string? current;
        if (_waitingForVideoEnd && _historyIndex > 0 && _historyIndex < _history.Count)
            current = _history[_historyIndex - 1];
        else if (_historyIndex >= 0 && _historyIndex < _history.Count)
            current = _history[_historyIndex];
        else
            current = null;

        // Scenes have no natural video-end signal — clear wait flag so the timer ticks.
        // Without this, a stale _waitingForVideoEnd=true would freeze the timer forever.
        if (current != null && IsScenePath(current))
        {
            _waitingForVideoEnd = false;
            _waitCts = null;
            return;
        }

        // (b) A wait was in flight in the GUI — re-attach to the pre-fetched next item (pre-fetched
        // at the switch). Current is a video (scene case bailed above), so prevIsVideo: true.
        if (_waitingForVideoEnd && _historyIndex >= 0 && _historyIndex < _history.Count)
        {
            ArmVideoEndWait(_history[_historyIndex]);
            return;
        }

        // (c) Advance-on-end mode mid-video without an in-flight wait — set one up.
        if (_advanceOnVideoEnd)
        {
            var next = AdvanceToNext();
            if (next == null) return;
            ArmVideoEndWait(next);
        }
    }

    public static bool RestoreTimedPlaylist()
    {
        bool ok;
        lock (_lock)
        {
            ok = false;
            if (!LoadTimedState()) return false;
            if (_timedPaths == null || _history == null || _timedPaths.Count == 0) return false;

            _timedTimerStopped = false;
            _timedTimerPaused = false;
            _timedRemainingMs = (long)_timedInterval.TotalMilliseconds;
            RefreshPlayLimits();
            _itemPlayedMs = 0; // the item starts over (SwitchToFile below), like the countdown

            // When WaitingForVideoEnd=true the saved _historyIndex is pre-fetched one step ahead;
            // restore to the actually-playing item (one step back).
            var playingHistIdx = PlayingHistoryIndex;
            SwitchToFile(_history[playingHistIdx], _timedOptions);
            SaveTimedState();

            EnsureTimedTick();

            RearmAdvanceOnVideoEnd();
            ok = true;
        }
        if (ok) UpdateRestartTimer();
        return ok;
    }

    public static bool ResumeTimedTimer()
    {
        bool ok;
        lock (_lock)
        {
            ok = false;
            if (!LoadTimedState()) return false;
            if (_timedPaths == null || _history == null || _timedPaths.Count == 0) return false;

            _timedTimerStopped = false;
            _timedTimerPaused = false;
            // _timedRemainingMs is restored from state — preserves the countdown (and the item's play time)
            RefreshPlayLimits();

            EnsureTimedTick();

            RearmAdvanceOnVideoEnd();
            ok = true;
        }
        if (ok) UpdateRestartTimer();
        return ok;
    }

    // The tick runs the interval AND takes every queued user switch (pending_action.txt: next / previous /
    // random / restart — a keybind, the UI, another process), so EVERY timed session has one, whatever its
    // interval (pure advance-on-end too: Tick ignores its countdown there) and whatever its length: a
    // one-item session (a trash leaving one survivor, a one-item playlist played) takes a next / random (a
    // switch to its one item, its transition included — the strip's "next" after it is itself) and the
    // restart daemon's "restart" (legacy's leak workaround); it never rotates by itself (`CanRotate`). It
    // used to start only at a session (re)start with > 1 item AND an interval: a pure advance-on-end session
    // never took a next, a one-item session never took anything — the queued action sat in
    // pending_action.txt until a tick started for a grown list (Undo, a strip add) and threw it away
    // (StartTimedTimer). `takeBack: false` (a live list edit): not once this process released the timer to
    // another owner (ReleaseTimer); a session (re)started here takes it back as before.
    private static void EnsureTimedTick(bool takeBack = true)
    {
        if (_playlistTimer != null || _timedTimerStopped || _timedPaths is not { Count: > 0 }) return;
        if (!takeBack && _timerReleased) return;
        StartTimedTimer();
    }

    private static void StartTimedTimer()
    {
        _daemonCts?.Dispose();
        _daemonCts = new CancellationTokenSource();
        _lastTickTime = DateTime.UtcNow;
        _timerReleased = false;
        ConsumePendingAction(); // discard any stale pending action from a prior session

        _playlistTimer = new Timer(_ => Tick(), null, TickInterval, Timeout.InfiniteTimeSpan);
    }

    private static void Tick()
    {
        lock (_lock)
        {
            if (_timerReleased) return;
            // a backend started while this one still runs (a dev restart, a second `--serve`) took over
            if (!_daemonMode && DateTime.UtcNow - _ownerCheckedAt > TimeSpan.FromSeconds(1))
            {
                _ownerCheckedAt = DateTime.UtcNow;
                if (OtherTimerOwner() is int other)
                {
                    Console.Error.WriteLine($"timed playlist: backend {other} owns it now — this one ({Environment.ProcessId}) stops ticking");
                    ReleaseTimer();
                    return;
                }
            }
            var now = DateTime.UtcNow;
            var elapsedMs = (long)(now - _lastTickTime).TotalMilliseconds;
            _lastTickTime = now;

            RefreshSignals();
            if (_timedPaths == null) return;

            // If the current scene crashed, signal and advance immediately.
            // Skip while _waitingForVideoEnd: in advance-on-end mode history is pre-fetched
            // one step ahead, so _history[_historyIndex] may point to a scene that isn't
            // playing yet — checking it here would be a false positive.
            // Legacy only: liascape-player runs no LWE process (IsLweRunning is always false there) — a broken
            // scene arrives as its `source.broken` event instead (OnSceneBroken).
            if (!_waitingForVideoEnd && !PlayerEngine.IsLiascapePlayer &&
                _history != null && _historyIndex >= 0 && _historyIndex < _history.Count &&
                IsScenePath(_history[_historyIndex]) && !IsSkippedPath(_history[_historyIndex]) && !IsLweRunning)
            {
                TransitionService.TransLog($"TICK scene-crash advance: idx={_historyIndex} item={System.IO.Path.GetFileName(_history[_historyIndex])} IsLweRunning=false");
                OnSceneCrashed?.Invoke(_history[_historyIndex]);
                _timedRemainingMs = 0;
                // Kill orphaned LWE immediately — the advance may go through DoVideoEndWait,
                // which doesn't call SwitchToFile right away.
                _prelaunchCts?.Cancel();
                _prelaunchCts = null;
                if (_prelaunchPidsToKill != null) { KillPids(_prelaunchPidsToKill); _prelaunchPidsToKill = null; }
            }

            if (_timedTimerStopped)
            {
                // Cover the race where CLI's Stop ran during our kill→launch
                // gap: the new mpvpaper we launched after CLI's KillAll would
                // otherwise survive forever.
                KillCurrentProcess();
                _timedPaths = null;
                _history = null;
                _historyIndex = -1;
                _playlistTimer?.Dispose();
                _playlistTimer = null;
                _daemonCts?.Cancel();
                OnTimedPlaylistStopped?.Invoke();
                return;
            }

            if (_timedTimerPaused)
            {
                // KeepPauseOnSwitch: a user next/prev/random made while paused runs now (a cut, the
                // pause and the countdown stay); a restart waits for the resume as before
                if (PeekPendingAction() is "next" or "prev" or "random" && ConsumePendingAction() is string act)
                    DispatchPendingAction(act);
                _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                return;
            }

            // the playing item's play time: wall clock (never scaled by speed), paused time excluded (above)
            _itemPlayedMs += elapsedMs;

            var pending = ConsumePendingAction();
            if (pending != null)
            {
                DispatchPendingAction(pending);
                _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                return;
            }

            // what the playing item plays (ItemPlayRule: a video the minimum / maximum; a scene / still image its own
            // "Switch scenes after" with separate timing on, else the video rules)
            var rule = PlayingRule();
            // Maximum play time (advance-on-end): the item played that long → the next one now, with its
            // transition (align:now, like a timed switch; an armed end-of-video switch is cancelled — AdvanceAndLaunch
            // takes its pre-fetched B). A cap beats the minimum.
            if (MaxPlayReached(_advanceOnVideoEnd, CanRotate, _itemPlayedMs, rule.MaxMs))
            {
                LiascapePlayerClient.Log($"max play time: {_itemPlayedMs / 1000.0:0.0} s ≥ {rule.MaxMs / 1000.0:0.#} s → advancing");
                _itemPlayedMs = 0; // (PostSwitch resets it too — but not when there's nothing to advance to)
                AdvanceAndLaunch();
                _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                return;
            }

            // A scene (it never ends) under advance-on-end: its rule's minimum reached IS its end → the next one now
            // (align:now) — "Switch scenes after" with separate timing on, else the minimum; none → it plays until the
            // maximum (above; the video rules only), else until a user switch. (A still image's is DoVideoEndWait's
            // hold: align:end on a still is now.)
            if (SceneMinReached(_advanceOnVideoEnd, CanRotate, PlayingIsScene, _itemPlayedMs, rule.MinMs))
            {
                LiascapePlayerClient.Log($"{(_separateScenes ? "switch scenes after" : "min play time on a scene")}: {_itemPlayedMs / 1000.0:0.0} s ≥ {rule.MinMs / 1000.0:0.#} s → advancing");
                _itemPlayedMs = 0;
                AdvanceAndLaunch();
                _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                return;
            }

            // Under advance-on-end the rotation has no countdown: a video / image switches at its (min-held) end —
            // DoVideoEndWait — and the limits above do the rest.
            if (_advanceOnVideoEnd)
            {
                _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                return;
            }

            // The plain timer (advance-on-end off). Scaled by playback speed so it counts video time, not wall
            // clock: at 2x the interval expires in half the wall-clock time. Scenes run at 1x.
            var speedFactor = IsLweRunning ? 1.0 : _currentSpeed;
            _timedRemainingMs -= (long)(elapsedMs * speedFactor);

            // Video→scene LEAD (legacy, pure timed mode): a scene needs SceneTransitionDelayMs to load behind
            // the cover, so fire the switch that many ms EARLY — the live video keeps playing under the
            // overlay during the load and the scene reveals right at the interval boundary. Only V→S with a
            // transition enabled; the reset-to-full in LaunchAndReset prevents a re-fire. Skipped for
            // intervals shorter than the lead.
            if (!_waitingForVideoEnd && _timedInterval > TimeSpan.Zero)
            {
                int leadMs = SettingsService.Load().SceneTransitionDelayMs;
                if (leadMs > 0 && _timedRemainingMs <= leadMs && _timedRemainingMs > 0
                    && _timedInterval.TotalMilliseconds > leadMs)
                {
                    var cur = _history != null && _historyIndex >= 0 && _historyIndex < _history.Count ? _history[_historyIndex] : null;
                    var nxt = PeekNextTimed();
                    if (cur != null && !IsScenePath(cur) && nxt != null && IsScenePath(nxt)
                        && !PlayerEngine.IsLiascapePlayer && SettingsService.Load().AllowScenes && TransitionService.CurrentConfig().Enabled)
                    {
                        AdvanceAndLaunch();
                        _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
                        return;
                    }
                }
            }

            // _timedInterval > Zero: an interval of 0 never fires (AppOps refuses to start one with > 1 item).
            // A one-item session has nothing to rotate to: its interval only starts over (it ticks for the
            // queued user switches above, never to switch to itself every interval).
            if (_timedRemainingMs <= 0 && _timedInterval > TimeSpan.Zero && !CanRotate)
                _timedRemainingMs = (long)_timedInterval.TotalMilliseconds;
            if (_timedRemainingMs <= 0 && _timedInterval > TimeSpan.Zero)
                AdvanceAndLaunch();

            _playlistTimer?.Change(TickInterval, Timeout.InfiniteTimeSpan);
        }
    }

    // Something to rotate to: a one-item timed session never switches by itself (ApplyTimedPlaylist and
    // RearmAdvanceOnVideoEnd arm nothing for it, its interval only starts over) — only a user's next /
    // random switches it, to its one item.
    private static bool CanRotate => _timedPaths is { Count: > 1 };

    // ── Rotation (player-adapter.md § Rotation) ─────────────────────────────────────────────────────────────
    // "Switch when video ends" off: the interval is a plain timer (mid-video, speed-scaled). On: wall-clock seconds
    // (speed never scales them; a pause stops the clock), 0 = off —
    // - minimum (= the interval field): a clip plays at least this long and switches at its next end; a shorter one
    //   loops on, and the end-of-video switch is requested in the loop that reaches it (HoldForMinPlay) → it advances
    //   at that loop's end, never mid-loop; a still image (it never ends) shows for it; a scene (it never ends either)
    //   switches once it's reached (the tick, align:now).
    // - maximum: once the playing item played that long the rotation advances now (the tick, align:now), even
    //   mid-video; a cap beats the minimum (max < min → the max fires).
    // A one-item session never switches to itself.

    // A playlist's effective rotation: its own when it overrides the global one, else the globals'.
    public static (int Interval, bool Advance, int Max, bool SeparateScenes, int ScenesAfter) EffectiveRotation(AppSettings s, PlaylistSettings? p) =>
        p?.OverrideGlobalSettings == true
            ? (p.IntervalSeconds, p.AdvanceOnVideoEnd, p.MaxPlaySeconds, p.SeparateSceneTiming, p.SwitchScenesAfterSeconds)
            : (s.GlobalIntervalSeconds, s.GlobalAdvanceOnVideoEnd, s.GlobalMaxPlaySeconds, s.GlobalSeparateSceneTiming, s.GlobalSwitchScenesAfterSeconds);

    // What a playing item plays under advance-on-end (2026-10-28, owner: "a toggle which when toggled lets you configure
    // differently for scenes … 0 … just turns them off"). (MinMs, MaxMs), wall-clock ms; 0 = off everywhere:
    // - MinMs: a VIDEO plays at least this long, then switches at its next end (0 → at its first end, however short);
    //   for an item that never ends (a still image, a scene) reaching it IS its end. NeverMs = it stays until a user
    //   switch (or the maximum, where one applies).
    // - MaxMs: the cap, even mid-video (0 = none → a 10 h video plays to its end).
    // Separate timing OFF (the old rules): a scene's end = the minimum (none → only the maximum moves it); a still image
    // shows for the minimum (0 → it flashes by). ON: a scene AND a still image switch after "Switch scenes after"
    // (0 → they stay) and the minimum / maximum don't apply to them — they have no end, so "at least … then at the next
    // end" / "at most" mean nothing there; one number says it. A video is never touched by the scene timing.
    public enum PlayKind { Video, Image, Scene }
    public const long NeverMs = long.MaxValue / 4;   // never reached (and never overflows HoldForMinPlay's arithmetic)
    public static PlayKind PlayKindOf(string path) =>
        IsScenePath(path) ? PlayKind.Scene : LiascapePlayerMedia.IsImagePath(path) ? PlayKind.Image : PlayKind.Video;
    public static (long MinMs, long MaxMs) ItemPlayRule(PlayKind kind, long minMs, long maxMs, bool separateScenes, long scenesAfterMs) =>
        kind == PlayKind.Video ? (Math.Max(0, minMs), Math.Max(0, maxMs))
        : separateScenes ? (scenesAfterMs > 0 ? scenesAfterMs : NeverMs, 0)
        : kind == PlayKind.Scene ? (minMs > 0 ? minMs : NeverMs, Math.Max(0, maxMs))
        : (Math.Max(0, minMs), Math.Max(0, maxMs));

    // the playing item's rule (callers hold _lock)
    private static (long MinMs, long MaxMs) PlayingRule()
    {
        var p = _history != null && PlayingHistoryIndex >= 0 && PlayingHistoryIndex < _history.Count ? _history[PlayingHistoryIndex] : null;
        return ItemPlayRule(p == null ? PlayKind.Video : PlayKindOf(p), MinPlayMs, _maxPlayMs, _separateScenes, _scenesAfterMs);
    }

    // The play-time limits a rotation acts on: only under advance-on-end (the interval is the minimum there); off,
    // the interval is the timer and neither applies.
    public static (int Min, int Max) PlayLimits(int intervalSeconds, bool advance, int maxSeconds) =>
        advance ? (Math.Max(0, intervalSeconds), AppSettings.PlayLimit(maxSeconds)) : (0, 0);

    // the maximum + the scene timing from the config (like TransitionService.CurrentConfig: the current playlist state +
    // the settings) — a session's start / restore / resume; live edits come through ApplyPlayLimitsLive (the minimum is
    // the session's own interval, which a session carries itself)
    private static void RefreshPlayLimits()
    {
        try
        {
            var r = EffectiveRotation(SettingsService.Load(), PlaylistService.LoadCurrentState()?.Settings);
            SetPlayLimits(r.Max, r.SeparateScenes, r.ScenesAfter);
        }
        catch { }
    }
    private static void SetPlayLimits(int maxSeconds, bool separateScenes, int scenesAfterSeconds)
    {
        _maxPlayMs = AppSettings.PlayLimit(maxSeconds) * 1000L;
        _separateScenes = separateScenes;
        _scenesAfterMs = AppSettings.PlayLimit(scenesAfterSeconds) * 1000L;
    }

    // /settings (the global one) and /playlist/state (a playlist's own): the effective maximum or scene timing changed
    // — live on the running rotation. The item's play time keeps counting (an edit never resets it); the next tick
    // compares it (already past it → it advances now), and a still image held for its time (HoldForMinPlay) re-reads it
    // within a second.
    public static void ApplyPlayLimitsLive(int maxSeconds, bool separateScenes, int scenesAfterSeconds)
    {
        lock (_lock) { SetPlayLimits(maxSeconds, separateScenes, scenesAfterSeconds); }
    }

    // the playing item is a scene (whatever the engine: under liascape-player no LWE process exists)
    private static bool PlayingIsScene =>
        _history != null && PlayingHistoryIndex >= 0 && PlayingHistoryIndex < _history.Count && IsScenePath(_history[PlayingHistoryIndex]);

    // a scene's end under advance-on-end: the minimum reached (none set → only the maximum or a user switch moves it)
    public static bool SceneMinReached(bool advanceOnEnd, bool canRotate, bool isScene, long playedMs, long minMs) =>
        advanceOnEnd && canRotate && isScene && minMs > 0 && playedMs >= minMs;

    public static bool MaxPlayReached(bool advanceOnEnd, bool canRotate, long playedMs, long maxMs) =>
        advanceOnEnd && canRotate && maxMs > 0 && playedMs >= maxMs;

    // A loop ending within this of the minimum counts as reaching it (the tick counts the play time in ~100 ms steps).
    public const long MinPlayToleranceMs = 150;
    // The minimum is reached by the loop playing now: what played + what's left of this loop (wall clock at A's current
    // speed; null = no end known — a still image, nothing on screen: then the play time alone).
    public static bool MinPlayReached(long playedMs, long? loopRemainingMs, long minMs) =>
        minMs <= 0 || playedMs + Math.Max(0, loopRemainingMs ?? 0) + MinPlayToleranceMs >= minMs;

    // the play time loaded from timed_state: + the time since it was saved unless paused (never negative)
    public static long PlayedAfterLoad(long savedPlayedMs, long savedAtMs, bool paused, long nowMs) =>
        Math.Max(0, savedPlayedMs) + (paused || savedAtMs <= 0 ? 0 : Math.Max(0, nowMs - savedAtMs));

    // liascape-player DoVideoEndWait, before it requests the aligned switch: wait while A's current loop doesn't reach the
    // minimum. True = request it now; false = this wait was cancelled. Polls A's remaining time ≤ 1 s apart and right
    // after each loop's end — the switch is requested ~0.1 s into the loop that reaches the minimum, so B has (almost)
    // that whole loop to get ready. A must loop meanwhile: with Loop off it would end and hold its last frame, so its
    // loop is turned on for the hold (align:end turns it off again for its last loop).
    private static async Task<bool> HoldForMinPlay(CancellationToken ct)
    {
        bool held = false;
        while (true)
        {
            long min, played; bool adv, still;
            lock (_lock)
            {
                // the playing item's own minimum (ItemPlayRule): a video's, or a still image's time — "Switch scenes
                // after" with separate timing on (NeverMs = it stays: held until a user switch / a live edit)
                min = PlayingRule().MinMs; played = _itemPlayedMs; adv = _advanceOnVideoEnd;
                still = _history != null && PlayingHistoryIndex >= 0 && PlayingHistoryIndex < _history.Count
                        && PlayKindOf(_history[PlayingHistoryIndex]) == PlayKind.Image;
            }
            if (ct.IsCancellationRequested) return false;
            if (!adv || min <= 0) return true;
            long? rem = still ? null : LiascapePlayerMedia.TimeRemaining() is double r ? (long)(r * 1000) : null;
            if (MinPlayReached(played, rem, min))
            {
                if (held) LiascapePlayerClient.Log($"min play time {min / 1000.0:0.#} s: reached by this loop (played {played / 1000.0:0.0} s, {(rem ?? 0) / 1000.0:0.0} s left) → arming the switch for its end");
                return true;
            }
            if (!held)
            {
                held = true;
                LiascapePlayerClient.Log($"{(min >= NeverMs ? "no time set" : $"min play time {min / 1000.0:0.#} s")}: holding {Path.GetFileName(LiascapePlayerMedia.CurrentPath() ?? "?")} (played {played / 1000.0:0.0} s{(still ? ", a still image" : $", this loop ends in {(rem ?? 0) / 1000.0:0.0} s")})");
                if (!still && !SettingsService.Load().Loop) LiascapePlayerMedia.SetLoop(true);
            }
            var wait = (int)Math.Clamp((rem ?? (min - played)) + 60, 100, 1000);
            try { await Task.Delay(wait, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return false; }
        }
    }

    private static void LaunchAndReset(string path)
    {
        SwitchToFile(path, SettingsService.Load().BuildMpvOptions());
        PostSwitch(path);
    }

    // Switch to the next wallpaper.
    //
    // Video→video: IPC loadfile replace (seamless, no flash). Falls back to
    // cold-start (kill old → launch new) if mpvpaper is not alive.
    //
    // Any transition involving a scene: pre-launch — the new process starts
    // first, and the old one is killed only after the new one signals
    // readiness (mpvpaper: AV: line; LWE: SceneTransitionDelayMs).
    private static void SwitchToFile(string path, string mpvOptions)
    {
        // liascape-player: ONE `transition` request (a cut when transitions are off) does the whole switch —
        // no pre-launch crossover, no overlay, no IPC loadfile — for a scene too (Phase 2: `kind: scene`,
        // kind-agnostic in the player; no V→S lead, no SceneTransitionDelayMs). A scene that can't play
        // stops playback here, exactly like legacy with AllowScenes=false (the pickers never hand one over).
        bool keepPause = _keepPauseNextSwitch; // a user switch staying paused: a cut (KeepPauseOnSwitch)
        _keepPauseNextSwitch = false;
        if (PlayerEngine.IsLiascapePlayer)
        {
            if (IsScenePath(path) && !PlayerEngine.ScenesPlayable(SettingsService.Load())) { KillCurrentProcess(); return; }
            var liascapeSettings = SettingsService.Load();
            var liascapeCfg = TransitionService.CurrentConfig();
            LiascapePlayerMedia.QueueSwitch(path, liascapeSettings, liascapeCfg.Enabled && !keepPause ? liascapeCfg : null, alignEnd: false); // queued: we may hold _lock
            _currentSpeed = ReadSpeedOverride(path) ?? liascapeSettings.Speed;
            OnWallpaperChanged?.Invoke(path);
            return;
        }

        // Cancel any in-flight pre-launch transition from a previous switch.
        _prelaunchCts?.Cancel();
        _prelaunchCts = null;
        // If the cancelled task had deferred LWE pids to kill, do it now so
        // rapid skipping doesn't accumulate orphan processes.
        if (_prelaunchPidsToKill != null)
        {
            KillPids(_prelaunchPidsToKill);
            _prelaunchPidsToKill = null;
        }

        bool nextIsScene = IsScenePath(path);
        bool prevIsScene = IsLweRunning;

        // ── WE-style transition (freeze A → animate to B's first frame) ───────
        // v1 fires only for video→video (seamless: B loads paused under the opaque overlay, the
        // renderer unpauses it at teardown). Scene-involved switches keep the existing pre-launch.
        // Captured here while A is still playing; the overlay then hides the loadfile underneath.
        // Only when the seamless IPC swap below will actually run. If the cold path would run (mpv
        // dead / deferred leak-restart), B takes ~2s to appear and would gap before the brief overlay
        // ends — so skip the transition and just instant-cut.
        bool transitionPauseB = false; // method-dependent: reveal=false (B live), frozen/full-live=true (B paused, renderer unpauses)
        bool mpvAliveForTransition = File.Exists(IpcSocket) && MpvpaperProcs().Length > 0;
        if (!nextIsScene && !prevIsScene)
        {
            var tcfg = TransitionService.CurrentConfig();
            if (tcfg.Enabled)
            {
                if (keepPause)
                    TransitionService.TransLog("transition SKIPPED: a switch while paused keeps the pause (KeepPauseOnSwitch) → instant cut, B paused");
                else if (!IsPlaying || !mpvAliveForTransition || _restartPending)
                    TransitionService.TransLog($"transition SKIPPED (V→V gate): playing={IsPlaying} mpvAlive={mpvAliveForTransition} restartPending={_restartPending} → instant cut");
                else
                {
                    var fromPath = QueryCurrentPath();
                    // The overlay covers (frozen A / live decode) before we switch B underneath; whether B
                    // is loaded paused or live depends on the chosen method (TryStart resolves it + reports
                    // pauseB). reveal = B plays live underneath; frozen/full-live = B paused, renderer unpauses.
                    if (!string.IsNullOrEmpty(fromPath) && fromPath != path)
                        TransitionService.TryStart(fromPath, false, path, false, tcfg, out transitionPauseB);
                    else
                        TransitionService.TransLog($"transition SKIPPED (V→V gate): fromPath={(fromPath == null ? "null" : System.IO.Path.GetFileName(fromPath))} same-as-target={fromPath == path} → instant cut");
                }
            }
        }

        // ── Transition involving a scene ──────────────────────────────────────
        if (nextIsScene || prevIsScene)
        {
            // a scene swap tears mpvpaper down (→ leak reset) and "zeroes" the restart timer — any
            // deferred restart is satisfied by the teardown; clear it + reset the in-process countdown.
            if (_restartPending) { _restartPending = false; if (!_daemonMode) UpdateRestartTimer(); }

            // ── WE-style transition for a scene-involved switch ───────────────────────────────────
            // Cover A first (grim still if A is a scene, ffmpeg/live-decode if video), THEN the
            // crossover below launches B UNDERNEATH the opaque overlay (hidden) → the renderer reveals
            // it. This hides the LWE launch flash / the mpvpaper↔LWE swap. TryStart resolves the method
            // (auto-fallback: full-live A=scene→reveal, frozen B=scene→reveal, V→S full-live→reveal-b)
            // and blocks until the overlay covers, so B is launched only once A is hidden.
            bool scenePauseB = false; // frozen S→V: launch mpvpaper-B paused at frame0; renderer unpauses at teardown
            bool transitionActive = false; // did the visual transition actually fire → gate the audio crossfade to match
            if (IsPlaying)
            {
                var tcfg = TransitionService.CurrentConfig();
                // QueryCurrentPath() reads the OLD video from mpv, but for a scene A the playlist history
                // has already advanced to the target → it returns `path`. grim captures the on-screen
                // scene regardless of its path, so use a sentinel for a scene A and only enforce the
                // "different file" guard (skip same-wallpaper switches) for a video A.
                var fromPath = prevIsScene ? "scene" : QueryCurrentPath();
                if (tcfg.Enabled && !string.IsNullOrEmpty(fromPath) && (prevIsScene || fromPath != path))
                {
                    TransitionService.TryStart(fromPath, prevIsScene, path, nextIsScene, tcfg, out scenePauseB);
                    transitionActive = true;
                }
            }

            if (nextIsScene)
            {
                var settings = SettingsService.Load();
                if (!PlayerEngine.ScenesPlayable(settings))
                {
                    KillCurrentProcess();
                    return;
                }
                // Folder-based scene: the item folder IS `path`. Launch a subscribed item by id (LWE's
                // native lookup in the WE dir); an owned copy by directory path (copied scenes always
                // launched from a path — SpawnLweProcesses' last arg accepts id OR dir).
                var loc = LibraryStore.Locate(path);
                string lweArg = loc?.Source == LibraryStore.Local ? loc.Value.Key : path;

                // Capture old processes before launching new ones.
                var oldMpvProcs = MpvpaperProcs();
                var oldLwePids = ReadCurrentLwePids();
                // Snapshot the OUTGOING scene's PROCESS PIDs (real, from pgrep) before launching B. The PID
                // is stable per LWE process even when LWE re-registers its client / re-creates its stream,
                // so it reliably separates old from new (client.id and sink-input # churn; the PID doesn't),
                // and pgrep — unlike the client map — never transiently drops a process mid-registration.
                var oldPids = GetLweProcPids();

                int targetVol = ReadVolumeOverride(path) ?? settings.Volume;
                var newPids = SpawnLweProcesses(lweArg, settings, targetVol, scenePath: path);
                OnWallpaperChanged?.Invoke(path);

                var capturedLwePids = oldLwePids;
                _prelaunchPidsToKill = capturedLwePids;
                var cts = _prelaunchCts = new CancellationTokenSource();
                var capturedMpv = oldMpvProcs;
                bool oldIsMpv = capturedMpv.Length > 0;       // V→S: fade the outgoing VIDEO via mpv IPC; S→S: fade old LWE by client.id
                bool hasOld = oldIsMpv || prevIsScene;         // false = FIRST wallpaper (nothing to crossfade) → no fade-in
                bool muted0 = _isMuted || AudioMonitor.IsMuted || settings.NoAudio;
                int fadeMs = Math.Clamp(TransitionService.CurrentConfig().DurationMs, 200, 8000);
                int coverMs = Math.Clamp(settings.SceneTransitionDelayMs, 0, 8000);
                int oldMuteI = muted0 ? 1 : 0;
                _ = Task.Run(async () =>
                {
                    // the new scene's PID(s) = LWE processes that appeared after the launch (≠ the old set)
                    HashSet<int> NewPids() { var p = GetLweProcPids(); p.ExceptWith(oldPids); return p; }
                    // liascape-audio holds these targets event-driven (instant on any stream create/reset). We only
                    // push the ramp values over stdin; the helper keeps them glued across LWE's re-inits.
                    string oldCsv = PidCsv(oldPids);
                    var newScenePids = new HashSet<int>();
                    try
                    {
                        // Crossfade ONLY when a visual transition is active. Transitions off → instant cut:
                        // new is already launched at target, just wait the load delay, then reap (no liascape-audio).
                        if (transitionActive && newPids.Length > 0)
                        {
                            // Wipe any stale liascape-audio groups FIRST — a prior transition's `clear` tail can be
                            // cancelled by this advance, and Linux REUSES PIDs, so a lingering "[dead pid]→0"
                            // group can pin a freshly-launched scene at 0 forever. Clearing at the START of
                            // every transition guarantees a clean slate (no accumulation, no PID-reuse poison).
                            AudioCtl("clear");
                            // PHASE 1 — cover: new muted+0, old held at target (liascape-audio applies on stream events).
                            if (!oldIsMpv && oldPids.Count > 0) AudioCtl($"set {oldCsv} {targetVol} {oldMuteI}");
                            var coverUntil = DateTime.UtcNow.AddMilliseconds(hasOld ? coverMs : 0);
                            do
                            {
                                newScenePids = NewPids();
                                if (newScenePids.Count > 0) AudioCtl($"set {PidCsv(newScenePids)} 0 1"); // muted, 0
                                if (DateTime.UtcNow >= coverUntil && newScenePids.Count >= 1) break;
                                await Task.Delay(50, cts.Token);
                            } while (DateTime.UtcNow < coverUntil || newScenePids.Count < 1);
                            string newCsv = PidCsv(newScenePids);
                            TransitionService.TransLog($"scene xfade(liascape-audio): new={newScenePids.Count} old={oldPids.Count} oldIsMpv={oldIsMpv} target={targetVol} muted={muted0} hasOld={hasOld} fadeMs={fadeMs}");

                            // PHASE 2 — reveal: ramp new 0→target (unmuted) + old target→0. No fade on first.
                            if (!hasOld) { AudioCtl($"set {newCsv} {targetVol} {oldMuteI}"); }
                            else
                            {
                                // EQUAL-POWER crossfade, corrected for a CUBIC volume curve. BOTH volume
                                // paths here cube the percent: mpv's `volume` (measured: 50% → -18.07 dB,
                                // not -6) and PulseAudio software volume (liascape-audio's pa_volume_t, whose
                                // mapping to gain is the cube of the fraction). A linear percent ramp
                                // therefore sags ~18 dB at the midpoint — measured as a ~22 dB hole lasting
                                // ~3s in the MIDDLE of a transition. So: pick the wanted GAIN with cos/sin
                                // (cos²+sin² = 1 → constant total power), then pre-distort the percent by
                                // its CUBE ROOT so the cubic curve reproduces that gain exactly.
                                // Finer steps too (was 5-12 over up to 8s = audible stepping).
                                static int XfPct(int target, double gain) =>
                                    (int)Math.Round(target * Math.Cbrt(Math.Clamp(gain, 0.0, 1.0)));
                                int steps = Math.Clamp(fadeMs / 50, 10, 160);
                                for (int s = 1; s <= steps && !cts.IsCancellationRequested; s++)
                                {
                                    double x = (double)s / steps;
                                    int nv = XfPct(targetVol, Math.Sin(x * Math.PI / 2));   // incoming: 0 → target
                                    int ov = XfPct(targetVol, Math.Cos(x * Math.PI / 2));   // outgoing: target → 0
                                    if (newScenePids.Count > 0) AudioCtl($"set {newCsv} {nv} {oldMuteI}");
                                    if (oldIsMpv) SendCommand("set_property", "volume", ov);
                                    else if (oldPids.Count > 0) AudioCtl($"set {oldCsv} {ov} {oldMuteI}");
                                    await Task.Delay(Math.Max(1, fadeMs / steps), cts.Token);
                                }
                                if (newScenePids.Count > 0) AudioCtl($"set {newCsv} {targetVol} {oldMuteI}");
                                if (!oldIsMpv && oldPids.Count > 0) AudioCtl($"set {oldCsv} 0 {oldMuteI}");
                            }
                        }
                        else
                        {
                            // No crossfade (transitions off / first wallpaper). No fade sets the level, and
                            // stream-restore may have poisoned the launch volume → correct the new scene to
                            // target via liascape-audio (event-driven, survives the reap re-init) while we wait the
                            // load delay before reaping the old.
                            CorrectSceneVolume(oldPids, targetVol, muted0, 3000);
                            await Task.Delay(SettingsService.Load().SceneTransitionDelayMs, cts.Token);
                        }
                    }
                    catch (OperationCanceledException) { return; }
                    catch { }
                    // old faded to 0 → reap it (gated on the fade, not a fixed delay)
                    _prelaunchPidsToKill = null;
                    foreach (var proc in capturedMpv)
                        using (proc) { try { proc.Kill(entireProcessTree: true); } catch { } }
                    if (capturedMpv.Length > 0)
                    {
                        lock (_lock) { _current = null; }
                        var sock = IpcSocket;
                        try { if (File.Exists(sock)) File.Delete(sock); } catch { }
                    }
                    KillPids(capturedLwePids);

                    // The reap re-inits the NEW stream → reset; liascape-audio holds it (it keeps the group set,
                    // applying on the 'change' event in ~1ms). Re-assert target, hold ~3s, then release so
                    // normal volume control (ApplyLweVolume) governs steady state. (Crossfade only.)
                    if (transitionActive && newScenePids.Count > 0)
                    {
                        AudioCtl($"set {PidCsv(newScenePids)} {targetVol} {oldMuteI}");
                        try { await Task.Delay(3000, cts.Token); } catch { }
                        AudioCtl("clear");
                    }
                });
            }
            else // scene→video (= S→V). transitions on → LIVE-COMPOSITE (reveal-a): the scene-A stays
                 // LIVE underneath, the overlay decodes+composites B over it AND plays B's audio. So
                 // mpvpaper-B must NOT be at BACKGROUND during the effect (it would cover the live A) —
                 // it's launched LATE, under the overlay's opaque end-hold, then the old scene is reaped.
            {
                var oldLwePids = ReadCurrentLwePids();
                var oldPids = GetLweProcPids();   // outgoing scene's real process pids (stable across re-init)
                KillMpvPaperOnly(); // safety: clear any stray mpvpaper + socket

                var settings = SettingsService.Load();
                int targetVol = ReadVolumeOverride(path) ?? settings.Volume;
                double spd = ReadSpeedOverride(path) ?? settings.Speed;
                bool muted0 = _isMuted || AudioMonitor.IsMuted || settings.NoAudio;
                int oldMuteI = muted0 ? 1 : 0;
                int fadeMs = Math.Clamp(TransitionService.CurrentConfig().DurationMs, 200, 8000);
                string oldCsv = PidCsv(oldPids);
                var cts = _prelaunchCts = new CancellationTokenSource();
                var capturedPids = oldLwePids;

                // Launch mpvpaper-B at `vol`. `paused` → load it PAUSED at frame 0 (reveal-a): the renderer
                // unpauses it (--mpv-unpause) at teardown so it hands off frame0→frame0 with the overlay-B
                // (also paused at frame0) — NO seek, exactly like V→V (B never advances → nothing to repeat).
                // Wires _current/speed/mute, returns its AV:-ready signal.
                TaskCompletionSource<bool> LaunchVideoB(int vol, bool paused = false, double startSec = 0)
                {
                    var rt = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    var lo = BakeNormalization(BakeSpeedOverride(BakeVolumeOverride(settings.BuildMpvOptions(), path), path), path);
                    if (_isMuted && !lo.Contains("--no-audio")) lo += " --mute=yes";
                    lo += $" --volume={vol}";
                    if (paused && !lo.Contains("--pause")) lo += " --pause=yes";
                    if (startSec > 0.2) lo += $" --start={startSec.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}";  // pre-buffer near the handoff
                    _current = Launch(lo, path, rt);
                    _currentSpeed = spd;
                    Task.Run(() => { SetSpeed(spd); if (_isMuted) SendCommand("set_property", "mute", true); });
                    OnWallpaperChanged?.Invoke(path);
                    return rt;
                }

                if (!transitionActive)
                {
                    // instant cut: launch B at target now, hold the old scene the load delay, then reap.
                    LaunchVideoB(targetVol);
                    _ = Task.Run(async () =>
                    {
                        try { await Task.Delay(settings.SceneTransitionDelayMs, cts.Token); } catch { return; }
                        if (!cts.IsCancellationRequested) { KillPids(capturedPids); try { if (File.Exists(LwePidPath)) File.Delete(LwePidPath); } catch { } }
                    });
                    return;
                }

                _ = Task.Run(async () =>
                {
                    // reveal-a: the overlay (already covering, spawned by TryStart) reveals B's frozen frame0
                    // over the live scene-A. We fade the live scene-A OUT via liascape-audio over the effect, then —
                    // once the effect completes and the overlay holds opaque-B (--hold-end-ms) — launch
                    // mpvpaper-B UNDER that cover PAUSED at frame0; the renderer unpauses it (--mpv-unpause)
                    // at teardown → frame0→frame0 handoff with the overlay-B, no seek, no repeat.
                    try
                    {
                        AudioCtl("clear");
                        if (oldPids.Count > 0) AudioCtl($"set {oldCsv} {targetVol} {oldMuteI}");
                        // Fade scene-A out over the effect PLUS the end-hold (≈ when B's audio starts at
                        // teardown) so it tails out instead of going silent mid-hold; launch mpvpaper-B
                        // PAUSED at frame0 the moment the EFFECT completes (overlay opaque → B hidden under
                        // it), so it's decoded + ready when the renderer unpauses it at teardown.
                        const int holdMs = 1300;                 // matches --hold-end-ms in TransitionService
                        int totalMs = fadeMs + holdMs;
                        // pre-buffer mpvpaper-B near the TEARDOWN position so the renderer's exact seek is
                        // tiny/fast (≈ effect + hold − overlay warmup), wrapped for looping videos.
                        double bDur = ProbeDurationSec(path);
                        double preBuf = totalMs / 1000.0 - 0.3;
                        if (bDur > 0.5) preBuf %= bDur;
                        if (preBuf < 0) preBuf = 0;
                        int steps = Math.Clamp(totalMs / 120, 6, 16);
                        TaskCompletionSource<bool>? rt = null;
                        for (int s = 1; s <= steps && !cts.IsCancellationRequested; s++)
                        {
                            double el = (double)s / steps * totalMs;
                            double f = Math.Min(1.0, el / totalMs);
                            if (oldPids.Count > 0) AudioCtl($"set {oldCsv} {(int)Math.Round(targetVol * (1 - f))} {oldMuteI}");
                            if (rt == null && el >= fadeMs) rt = LaunchVideoB(targetVol, paused: true, startSec: preBuf);
                            await Task.Delay(Math.Max(1, totalMs / steps), cts.Token);
                        }
                        if (oldPids.Count > 0) AudioCtl($"set {oldCsv} 0 {oldMuteI}");
                        if (cts.IsCancellationRequested) return;
                        rt ??= LaunchVideoB(targetVol, paused: true, startSec: preBuf);
                        try { using var lk = CancellationTokenSource.CreateLinkedTokenSource(cts.Token); lk.CancelAfter(1500); await rt.Task.WaitAsync(lk.Token); } catch { }
                    }
                    catch (OperationCanceledException) { return; }
                    catch { }
                    if (!cts.Token.IsCancellationRequested)
                    {
                        KillPids(capturedPids);   // reap the old scene; the overlay tears down → mpvpaper-B shows
                        try { if (File.Exists(LwePidPath)) File.Delete(LwePidPath); } catch { }
                    }
                    AudioCtl("clear");
                });
            }
            return;
        }

        // ── Video→video: existing seamless approach ───────────────────────────
        // _restartPending → force the cold-start branch (skip the seamless IPC swap) so THIS changeover
        // relaunches mpvpaper (the deferred leak-restart, masked by the natural switch). Then clear it.
        bool mpvAlive = File.Exists(IpcSocket) && MpvpaperProcs().Length > 0;
        // Compute the effective volume/speed BEFORE the switch so they can ride INTO `loadfile` as
        // per-file options. A post-loadfile `set_property volume` races mpv's own apply of the launch
        // default (--volume) and gets clobbered → the advanced-to item played at the global, not its
        // override. Passing them as loadfile options applies them atomically with the load (no race).
        var cfg = SettingsService.Load();
        int effVol = ReadVolumeOverride(path) ?? cfg.Volume;
        double effSpd = ReadSpeedOverride(path) ?? cfg.Speed;
        if (mpvAlive && !_restartPending && TryIpcSwitchToFile(path, effVol, effSpd, pauseAtStart: transitionPauseB))
        {
            _currentSpeed = effSpd; // keep the timed-tick speed factor in sync (cold path sets it below)
            OnWallpaperChanged?.Invoke(path);
            if (_isMuted) Task.Run(() => SendCommand("set_property", "mute", true));
        }
        else
        {
            KillCurrentProcess();
            var opts = BakeNormalization(BakeSpeedOverride(BakeVolumeOverride(mpvOptions, path), path), path);
            if (_isMuted && !opts.Contains("--no-audio")) opts += " --mute=yes";
            _current = Launch(opts, path);
            // Keep tick speed factor in sync with the freshly launched video (mpv IPC path
            // already updates this via SetSpeed; cold-start has no SetSpeed call).
            _currentSpeed = ReadSpeedOverride(path) ?? SettingsService.Load().Speed;
            // this cold relaunch satisfied any deferred leak-restart; reset the in-process countdown
            if (_restartPending) { _restartPending = false; if (!_daemonMode) UpdateRestartTimer(); }
            OnWallpaperChanged?.Invoke(path);
        }
        OnWallpaperChanged?.Invoke(path);
    }

    private static bool TryIpcSwitchToFile(string path, int volume, double speed, bool pauseAtStart = false)
    {
        // Read AppSettings.Loop directly so the loop state is explicit rather
        // than parsed out of the kill+launch options string. Other launch-only
        // options (hwdec, cache, demuxer) can't be toggled mid-session and only
        // take effect on next cold start.
        bool loopFile = SettingsService.Load().Loop;
        // Per-file options applied atomically with the load (mpv ≥ 0.38: loadfile <url> <flags> <index> <opts>).
        // Carries the effective volume/speed + mute so the new file starts at them — no post-load reset race.
        // mute is set EXPLICITLY both ways: file-local options are restored to the pre-file value at the
        // next load, so a file loaded with only `mute=yes` and then auto-UNmuted via set_property would
        // hand the next file the launch-time global (`--mute=yes`) → B plays muted while _isMuted=false
        // and auto-mute never corrects it ("mute state doesn't carry over").
        var fileOpts = $"volume={volume},speed={speed.ToString("G", System.Globalization.CultureInfo.InvariantCulture)},mute={(_isMuted ? "yes" : "no")}";
        // Transition handoff: load B paused at frame 0 (hidden under the opaque overlay); the
        // liascape-transition renderer unpauses it (--mpv-unpause) the instant it tears down → seamless.
        if (pauseAtStart) fileOpts += ",pause=yes";
        // Between-video loudness normalization for the incoming file (or "" to clear) — set the `af`
        // before loadfile so the new file plays normalized; the volume in fileOpts stacks on top.
        TrySendCommand("set", "af", NormalizeAf(path) ?? "");
        return TrySendCommand("set", "loop-file", loopFile ? "inf" : "no")
            && TrySendCommand("set", "loop-playlist", "no")
            && TrySendCommand("playlist-clear")
            && TrySendCommand("loadfile", path, "replace", 0, fileOpts);
    }

    // Bool-returning variant of SendCommand for callers that need to know
    // whether the IPC succeeded so they can fall back to a fresh launch.
    private static bool TrySendCommand(params object[] args)
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.Mpv(args);
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return false;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var cmd = JsonSerializer.Serialize(new { command = args });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static string? QueryCurrentPath()
    {
        // For scenes, the mpv socket isn't connected. Fall back to the in-memory history.
        if (IsLweRunning)
        {
            lock (_lock)
            {
                if (_history != null && _historyIndex >= 0 && _historyIndex < _history.Count)
                    return _history[_historyIndex];
            }
        }
        return TryQueryCurrentPath();
    }

    public static string? QueryCurrentSceneWorkshopId()
    {
        if (!IsLweRunning) return null;
        lock (_lock)
        {
            if (_history == null || _historyIndex < 0 || _historyIndex >= _history.Count) return null;
            var path = _history[_historyIndex];
            if (!IsScenePath(path)) return null;
            // folder-based: the scene folder's NAME is the workshop id (workshop/<id> or local/<id>)
            return Path.GetFileName(path.TrimEnd('/', '\\'));
        }
    }

    private static string? TryQueryCurrentPath()
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.CurrentPath();
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return null;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var cmd = JsonSerializer.Serialize(new { command = new object[] { "get_property", "path" } });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
            var buf = new byte[4096];
            int n = socket.Receive(buf);
            foreach (var line in Encoding.UTF8.GetString(buf, 0, n).Split('\n'))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.String)
                        return data.GetString();
                }
                catch { }
            }
            return null;
        }
        catch { return null; }
    }

    // Reorders the active playlist in real time without restarting mpvpaper or resetting the timer countdown.
    // Sequential: positions the current wallpaper at index 0, then appends the rest in original order
    //             starting from current+1 (wrapping). Shuffled: same but randomises the tail.
    // `previousPaths` (the list before the edit, when the caller knows it): the playing item was removed →
    // the rotation goes on from its place — the first item after it in the old list that's still there,
    // like trash does — instead of from the top of the new list (it replayed everything before it).
    public static void ReorderPlaylist(IReadOnlyList<string> originalPaths, bool isTimedPlaylist, bool shuffle,
        IReadOnlyList<string>? previousPaths = null)
    {
        lock (_lock)
        {
            if (originalPaths.Count == 0) return;

            // Mixed advance-on-end playlists use the timed machinery even when the
            // caller passes isTimedPlaylist=false (it only knows about native-mpv mode).
            if (!isTimedPlaylist && _timedPaths != null)
                isTimedPlaylist = true;

            if (isTimedPlaylist)
            {
                if (_timedPaths == null && !LoadTimedState()) return;

                // In advance-on-end mode, _historyIndex is pre-fetched one step ahead of the
                // playing item. Use the actual playing item as the reorder anchor.
                bool preIsFetched = _waitingForVideoEnd
                    && _history != null && _historyIndex > 0 && _historyIndex < _history.Count;
                int playingHistIdx = preIsFetched ? _historyIndex - 1 : _historyIndex;
                var currentPath = (_history != null && playingHistIdx >= 0 && playingHistIdx < _history.Count)
                    ? _history[playingHistIdx]
                    : null;

                int currentIdx = -1;
                for (int i = 0; i < originalPaths.Count; i++)
                    if (originalPaths[i] == currentPath) { currentIdx = i; break; }

                var rest = new List<string>();
                if (currentIdx >= 0)
                {
                    for (int i = currentIdx + 1; i < originalPaths.Count; i++) rest.Add(originalPaths[i]);
                    for (int i = 0; i < currentIdx; i++) rest.Add(originalPaths[i]);
                }
                else
                {
                    rest.AddRange(originalPaths);
                    // only for an edit of the same list (items removed / moved) — a different playlist loaded over
                    // it starts at its own top
                    int was = currentPath != null && previousPaths != null && originalPaths.All(previousPaths.Contains)
                        ? previousPaths.ToList().IndexOf(currentPath) : -1;
                    if (was >= 0)
                    {
                        var after = Enumerable.Range(1, previousPaths!.Count).Select(k => previousPaths[(was + k) % previousPaths.Count])
                            .FirstOrDefault(p => p != currentPath && rest.Contains(p));
                        int at = after != null ? rest.IndexOf(after) : -1;
                        if (at > 0) rest = rest.Skip(at).Concat(rest.Take(at)).ToList(); // the next advance (→ index 0) plays it
                    }
                }

                if (shuffle) rest = rest.OrderBy(_ => Guid.NewGuid()).ToList();

                List<string> newPaths;
                int newTimedIndex;
                if (currentIdx >= 0 && currentPath != null)
                {
                    // Current is still in the playlist — place it at index 0 so next advance
                    // increments to index 1 (first of rest).
                    newPaths = new List<string>([currentPath]);
                    newPaths.AddRange(rest);
                    newTimedIndex = 0;
                }
                else
                {
                    // Current was removed — let it finish but don't replay it.
                    // Setting _timedIndex to the last slot makes the next advance wrap to 0.
                    newPaths = rest;
                    newTimedIndex = newPaths.Count - 1;
                }

                _timedShuffle = shuffle;
                _timedPaths = newPaths;
                _timedIndex = newTimedIndex;
                _history = currentPath != null ? [currentPath] : [newPaths[0]];
                _historyIndex = 0;
                // Intentionally preserve _timedRemainingMs — don't reset the countdown

                // In advance-on-end mode the in-flight DoVideoEndWait holds a reference to the
                // old path list. Cancel it and re-chain from the (now playing) current item.
                if (_advanceOnVideoEnd)
                {
                    if (_waitingForVideoEnd)
                    {
                        _waitCts?.Cancel();
                        _waitCts = null;
                        _waitingForVideoEnd = false;
                        TrySendCommand("set", "loop-file", "inf");
                    }
                    var playingPath = _history != null && _historyIndex >= 0 && _historyIndex < _history!.Count
                        ? _history[_historyIndex]
                        : null;
                    if (playingPath != null && !IsScenePath(playingPath) && newPaths.Count > 1)
                    {
                        var nextPath = AdvanceToNext();
                        if (nextPath != null)
                            ArmVideoEndWait(nextPath);
                    }
                }

                SaveTimedState();
                EnsureTimedTick(takeBack: false); // the list grew past one item (Undo of a trash, a strip add)
            }
            else
            {
                // Advance-on-end: rebuild mpv's playlist from the current position
                var currentPath = TryQueryCurrentPath();
                if (currentPath == null) return; // IPC not ready — skip to avoid corrupting the queue

                int currentIdx = -1;
                for (int i = 0; i < originalPaths.Count; i++)
                    if (originalPaths[i] == currentPath) { currentIdx = i; break; }

                var rest = new List<string>();
                if (currentIdx >= 0)
                {
                    for (int i = currentIdx + 1; i < originalPaths.Count; i++) rest.Add(originalPaths[i]);
                    for (int i = 0; i < currentIdx; i++) rest.Add(originalPaths[i]);
                }
                else
                {
                    rest.AddRange(originalPaths); // current was removed; all new paths (none duplicate current)
                }

                if (shuffle) rest = rest.OrderBy(_ => Guid.NewGuid()).ToList();

                TrySendCommand("playlist-clear");
                foreach (var p in rest)
                    TrySendCommand("loadfile", p, "append");
                TrySendCommand("set", "loop-playlist", "inf");

                // Restart observer with the new playlist order so playlist-pos events
                // map to the correct cards after reorder
                var newObserverPaths = new List<string> { currentPath };
                newObserverPaths.AddRange(rest);
                StartPlaylistObserver(newObserverPaths);
                try { AtomicFile.WriteAllText(PlaylistObserverPathsPath, JsonSerializer.Serialize(newObserverPaths)); } catch { }
            }
        }
    }

    // Syncs the advance-on-end (mpv-native) playlist to the new path list.
    // For pure additions without shuffle, just appends the new items to mpv's existing
    // queue (preserving the current playback order). Everything else does a full rebuild.
    public static void SyncAdvanceOnEndPlaylist(IReadOnlyList<string> oldPaths, IReadOnlyList<string> newPaths, bool shuffle)
    {
        lock (_lock)
        {
            if (newPaths.Count == 0) return;

            // Mixed advance-on-end playlists use the timed machinery — IPC playlist ops are useless here.
            if (_timedPaths != null)
            {
                ReorderPlaylist(newPaths, true, shuffle, oldPaths);
                return;
            }

            var currentPath = TryQueryCurrentPath();
            if (currentPath == null) return;

            var added = newPaths.Except(oldPaths).ToHashSet();
            var removed = oldPaths.Except(newPaths).ToHashSet();

            // Add-only without shuffle: append new items to the END of mpv's current queue.
            // This preserves the existing playback order (items that were next stay next)
            // and slots new items in AFTER the full current cycle.
            if (!shuffle && added.Count > 0 && removed.Count == 0)
            {
                // Verify the non-added items are in the same order (no reorder happened)
                var existingInNew = newPaths.Where(p => !added.Contains(p)).ToList();
                var existingInOld = oldPaths.Where(p => !added.Contains(p)).ToList();
                if (existingInNew.SequenceEqual(existingInOld))
                {
                    var appendedPaths = newPaths.Where(p => added.Contains(p)).ToList();
                    foreach (var p in appendedPaths)
                        TrySendCommand("loadfile", p, "append");
                    // Extend observer paths with appended items
                    var extendedPaths = _currentObserverPaths.Concat(appendedPaths).ToList();
                    StartPlaylistObserver(extendedPaths);
                    try { AtomicFile.WriteAllText(PlaylistObserverPathsPath, JsonSerializer.Serialize(extendedPaths)); } catch { }
                    return;
                }
            }

            // Full rebuild for removes, reorders, or adds-with-shuffle
            int currentIdx = -1;
            for (int i = 0; i < newPaths.Count; i++)
                if (newPaths[i] == currentPath) { currentIdx = i; break; }

            var rest = new List<string>();
            if (currentIdx >= 0)
            {
                for (int i = currentIdx + 1; i < newPaths.Count; i++) rest.Add(newPaths[i]);
                for (int i = 0; i < currentIdx; i++) rest.Add(newPaths[i]);
            }
            else
            {
                // Current was removed. Map its old position into newPaths so the item that
                // "replaced" it positionally plays next instead of restarting from index 0.
                int oldCurrentIdx = -1;
                for (int i = 0; i < oldPaths.Count; i++)
                    if (oldPaths[i] == currentPath) { oldCurrentIdx = i; break; }

                int startIdx = oldCurrentIdx >= 0
                    ? Math.Min(oldCurrentIdx, newPaths.Count - 1)
                    : 0;

                for (int i = startIdx; i < newPaths.Count; i++) rest.Add(newPaths[i]);
                for (int i = 0; i < startIdx; i++) rest.Add(newPaths[i]);
            }

            if (shuffle) rest = rest.OrderBy(_ => Guid.NewGuid()).ToList();

            TrySendCommand("playlist-clear");
            foreach (var p in rest)
                TrySendCommand("loadfile", p, "append");
            TrySendCommand("set", "loop-playlist", "inf");

            // Restart observer with the new playlist order
            var newObserverPaths = new List<string> { currentPath };
            newObserverPaths.AddRange(rest);
            StartPlaylistObserver(newObserverPaths);
            try { AtomicFile.WriteAllText(PlaylistObserverPathsPath, JsonSerializer.Serialize(newObserverPaths)); } catch { }
        }
    }

    // Public accessor for the web UI (sync the in-app wallpaper preview to live mpv position).
    public static double? QueryTimePos() => TryQueryTimePos();

    // Current video's total length (for the transition: wrap A's advanced start on looping videos).
    public static double? QueryDuration() => TryQueryProperty("duration");

    private static double? TryQueryProperty(string prop)
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.QueryMpv(prop);
        return QueryMpvData(prop) is { ValueKind: JsonValueKind.Number } d ? d.GetDouble() : null;
    }

    // legacy: mpv's `get_property <prop>` reply `data` (cloned), null without an answer
    private static JsonElement? QueryMpvData(string prop)
    {
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return null;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var cmd = JsonSerializer.Serialize(new { command = new object[] { "get_property", prop } });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
            var buf = new byte[4096];
            int n = socket.Receive(buf);
            foreach (var line in Encoding.UTF8.GetString(buf, 0, n).Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    if (doc.RootElement.TryGetProperty("data", out var data))
                        return data.Clone();
                }
                catch { }
            }
            return null;
        }
        catch { return null; }
    }

    private static double? TryQueryTimePos()
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.Query("time_pos");
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return null;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var cmd = JsonSerializer.Serialize(new { command = new object[] { "get_property", "time-pos" } });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
            var buf = new byte[4096];
            int n = socket.Receive(buf);
            using var doc = JsonDocument.Parse(buf.AsMemory(0, n));
            if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Number)
                return data.GetDouble();
            return null;
        }
        catch { return null; }
    }

    private static double? TryQueryTimeRemaining()
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.TimeRemaining();
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return null;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            // playtime-remaining = time-remaining / speed (wall-clock seconds, not video seconds).
            // Using time-remaining here would oversleep at speed > 1, causing B to loop multiple times
            // before we transition to the next file.
            var cmd = JsonSerializer.Serialize(new { command = new object[] { "get_property", "playtime-remaining" } });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
            var buf = new byte[4096];
            int n = socket.Receive(buf);
            var str = Encoding.UTF8.GetString(buf, 0, n);
            foreach (var line in str.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Number)
                        return data.GetDouble();
                }
                catch { }
            }
            return null;
        }
        catch { return null; }
    }

    // prevIsVideo: caller asserts the currently-playing item is a video (not a scene).
    // Used when spawning a chain immediately after SwitchToFile(video) so prevIsScene is
    // correctly false even when the async LWE kill hasn't completed yet.
    private static async Task DoVideoEndWait(string next, CancellationToken ct, bool prevIsVideo = false)
    {
        // For video→video: disable loop on current, append next to mpv's playlist so
        // the transition happens inside mpv (no blank gap), then restore loop after.
        // Falls back to an immediate SwitchToFile for scene transitions or when IPC is unavailable.
        bool nextIsScene = IsScenePath(next);
        bool prevIsScene = !prevIsVideo && IsLweRunning;
        TransitionService.TransLog($"DoVideoEndWait: next={System.IO.Path.GetFileName(next)} nextIsScene={nextIsScene} prevIsVideo={prevIsVideo} IsLweRunning={IsLweRunning} → prevIsScene={prevIsScene}");

        // ── liascape-player V→V (transitions on AND the transitions-off gapless branch): the PLAYER times the
        //    switch — align:"end" makes full-live END at A's end and a cut/reveal/frozen START there — so
        //    no playtime polling and no `_lastSwitchTarget` settle gate (legacy-only): the previous
        //    switch's transition.handoff is the gate (a new request would supersede a pre-Running one).
        //    Cancel (ct) → `cancel {corr}` inside SwitchAndWait.
        //    Phase 2: a scene on either side too (kind-agnostic in the player). A scene A never ends, so
        //    a switch away from one (a restore re-arming onto a scene — the tick moves scenes on itself) is
        //    align:"now" — legacy's "prevIsScene → switch now".
        if (PlayerEngine.IsLiascapePlayer)
        {
            await LiascapePlayerMedia.WaitLastHandoff(ct).ConfigureAwait(false);
            if (ct.IsCancellationRequested) return;
            bool aIsScene = !prevIsVideo && LiascapePlayerMedia.CurrentPath() is string aPath && IsScenePath(aPath);
            // a minimum play time: A loops on until the loop that reaches it, and only then is the aligned switch
            // requested — align:end makes A's CURRENT loop its last, so it lands on a loop's end, never mid-loop
            if (!aIsScene && !await HoldForMinPlay(ct).ConfigureAwait(false)) return;
            var liascapeCfg = TransitionService.CurrentConfig();
            // B is the session's current item from the moment its effect RUNS, not from its handoff: the
            // player shows it (`cur:*` = B) and a new request commits it. Counted only at the handoff, a
            // next/prev/random in that window (the effect's duration) read the pre-fetched B as "what
            // comes next" — the next cancelled the running switch (snap back to A) and switched now to the
            // same B (the user's next did nothing), a prev went to the item before A. Legacy commits there
            // too (SwitchToFile + PostSwitch at its overlay's start). From here a next cancels only the
            // FOLLOWING switch (still in WaitLastHandoff, nothing requested) and its now-switch commits B.
            bool committed = false;
            bool Commit()
            {
                // under _lock; the started callback and the handoff below race — whoever comes first
                if (committed || !_waitingForVideoEnd || ct.IsCancellationRequested || _timerReleased
                    || _waitCts == null || _waitCts.Token != ct) return false; // not (still) THIS wait's switch
                committed = true;
                _waitingForVideoEnd = false;
                _waitCts = null;
                _currentSpeed = ReadSpeedOverride(next) ?? SettingsService.Load().Speed;
                OnWallpaperChanged?.Invoke(next);
                PostSwitch(next);
                return true;
            }
            var outcome = await LiascapePlayerMedia.SwitchAndWait(next, SettingsService.Load(), liascapeCfg.Enabled ? liascapeCfg : null, alignEnd: !aIsScene, ct,
                onStarted: () => { lock (_lock) Commit(); }).ConfigureAwait(false);
            lock (_lock)
            {
                if (committed)
                {
                    // committed at its start: the player resolves a Running switch itself (handoff, or one
                    // committed by the next request) — only a B failing mid-effect snaps back to A
                    if (outcome == "handoff") LiascapePlayerMedia.ResetFailureBackoff();
                    else LiascapePlayerClient.Log($"aligned switch to {System.IO.Path.GetFileName(next)} ended {outcome} after its effect started (already counted as current then)");
                    return;
                }
            }
            if (ct.IsCancellationRequested) return;
            // superseded by another backend's switch (it took the playlist over): leave it to that one
            if (outcome != "handoff" && !_daemonMode && OtherTimerOwner() is int owner)
            {
                Console.Error.WriteLine($"timed playlist: backend {owner} owns it now — this one ({Environment.ProcessId}) stops ticking");
                ReleaseTimer();
                return;
            }
            if (outcome == "failed:player restarted")
            {
                // The player crashed (or was restarted) while this switch was armed: the request died with it. Its
                // snapshot brings A back where it played (an armed align:end switch is saved as A), and the adapter
                // puts back what the backend last showed (LiascapePlayerMedia.ReconcileShown, queued ahead of this) — so
                // arm it again for A's end on the new player. Switching now (the failure path below) cut A short
                // and, with a snapshot saved as B, showed B twice.
                LiascapePlayerClient.Log($"aligned switch to {System.IO.Path.GetFileName(next)}: the player restarted → re-arming it for A's end");
                lock (_lock)
                {
                    if (!_waitingForVideoEnd || ct.IsCancellationRequested || _timerReleased) return;
                    ArmVideoEndWait(next, prevIsVideo);
                }
                return;
            }
            if (outcome == "cancelled:superseded")
            {
                // another requester replaced it — never this process (its own switches cancel the wait
                // first): a second backend before it yields, a daemon. Wait for A's end again, never
                // "switch now": two owners each switching now on the other's supersede was the storm.
                var backoff = LiascapePlayerMedia.NextFailureBackoff();
                LiascapePlayerClient.Log($"aligned switch to {System.IO.Path.GetFileName(next)}: superseded by another request → re-arming in {backoff.TotalSeconds:0} s");
                try { await Task.Delay(backoff, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
                lock (_lock)
                {
                    if (!_waitingForVideoEnd || ct.IsCancellationRequested || _timerReleased) return;
                    ArmVideoEndWait(next, prevIsVideo);
                }
                return;
            }
            if (outcome != "handoff")
            {
                // failed / player unreachable / timed out: back off — 1 s,
                // doubling to ≤ 30 s while it keeps failing (I4: never a storm, whatever the player's
                // reason) — then switch now, the legacy "mpv gone → switch immediately" fallback.
                var backoff = LiascapePlayerMedia.NextFailureBackoff();
                LiascapePlayerClient.Log($"aligned switch to {System.IO.Path.GetFileName(next)}: {outcome} → switching in {backoff.TotalSeconds:0} s");
                try { await Task.Delay(backoff, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
            else LiascapePlayerMedia.ResetFailureBackoff();
            lock (_lock)
            {
                // `committed`: a started callback queued just before a fast terminal outcome ran meanwhile
                if (committed || !_waitingForVideoEnd || ct.IsCancellationRequested || _timerReleased) return;
                if (outcome == "handoff") { Commit(); return; } // no `transition.started` seen (a reconnect gap)
                committed = true; // a started callback still queued must not commit it again
                _waitingForVideoEnd = false;
                _waitCts = null;
                // a scene B that broke before its handoff (`source.broken` marked it crashed meanwhile —
                // the back-off above outlasts that event): switch to the item after it instead (D6)
                var to = next;
                if (IsScenePath(next) && IsSkippedPath(next))
                {
                    to = AdvanceToNext();
                    LiascapePlayerClient.Log($"aligned switch to {System.IO.Path.GetFileName(next)}: it can't play (crashed / unplayable) → {(to != null ? System.IO.Path.GetFileName(to) : "nothing else to play")}");
                    if (to == null) { _timedRemainingMs = (long)_timedInterval.TotalMilliseconds; SaveTimedState(); return; }
                }
                SwitchToFile(to, SettingsService.Load().BuildMpvOptions());
                PostSwitch(to);
            }
            return;
        }

        // In advance-on-end mode PostSwitch re-arms us the instant the overlay fired the switch — but
        // the IPC loadfile-B hasn't settled yet, so mpv still reports the OUTGOING file's near-end
        // playtime-remaining. Reading that now computes sleepMs<=0 → we'd fire a spurious SECOND switch
        // immediately (rapid A→B→A, landing on the wrong item). Wait for the transition's effect+teardown
        // to finish (B actually playing) before sampling. (No-op when no overlay is in flight.)
        while (TransitionService.InProgress && !ct.IsCancellationRequested)
        {
            try { await Task.Delay(100, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
        if (ct.IsCancellationRequested) return;

        // The InProgress wait above only covers a switch that DID get an overlay. When the transition
        // bails (no monitors detected, renderer missing, capture failure…) the switch is a bare
        // loadfile and this task is re-armed within ~1ms of it — mpv's `path` still says A and its
        // playtime-remaining is A's last few seconds (< lead) → instant re-fire → a storm of switches
        // ~85ms apart until the loadfile settles (seen as 2–9 flashes per advance, landing on a random
        // item, per-file volume/mute lost). Gate on mpv reporting the file PostSwitch handed us as
        // current — that is the only reliable "B is loaded" signal, transition or not.
        var expectPath = _lastSwitchTarget;
        if (expectPath != null && !prevIsScene && !IsScenePath(expectPath))
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (!ct.IsCancellationRequested && sw.ElapsedMilliseconds < 8000)
            {
                var cur = TryQueryCurrentPath();
                if (cur == expectPath) break;
                if (cur == null && !File.Exists(IpcSocket)) break; // mpv gone → cold-launch path below handles it
                try { await Task.Delay(50, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
            if (ct.IsCancellationRequested) return;
            if (sw.ElapsedMilliseconds >= 8000)
                TransitionService.TransLog($"DoVideoEndWait: mpv never reported {System.IO.Path.GetFileName(expectPath)} as current after 8s — sampling anyway");
        }

        if (!nextIsScene && !prevIsScene)
        {
            // In advance-on-end mode the first DoVideoEndWait fires immediately after launch;
            // wait up to 5s for the mpv socket before querying.
            double? remaining = TryQueryTimeRemaining();
            if (remaining == null && _advanceOnVideoEnd)
            {
                for (int i = 0; i < 50 && remaining == null && !ct.IsCancellationRequested; i++)
                {
                    try { await Task.Delay(100, ct).ConfigureAwait(false); }
                    catch (OperationCanceledException) { return; }
                    remaining = TryQueryTimeRemaining();
                }
            }
            // transitions ON → fire the full-live overlay V→V transition, leading by the transition
            // wall-time (effect + warmup) so it COMPLETES at the video's end: A plays to its end with no
            // loop, then the seamless full-live handoff to mpvpaper-B — same effect as a manual /next,
            // just timed to the video's end. (Transitions OFF keeps the mpv-internal gapless append below.)
            var tcfgVV = TransitionService.CurrentConfig();
            if (tcfgVV.Enabled)
            {
                if (remaining != null)
                {
                    try
                    {
                        while (true)
                        {
                            _speedChangeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                            var rem2 = TryQueryTimeRemaining();
                            if (rem2 == null) break;
                            // Lead = effect duration + warmup estimate + slack. The lead is NOT the accuracy
                            // mechanism — it only needs to fire EARLY: the renderer gates the effect start on
                            // A's DECODED remaining (--align-a-end, requested below) and spends any early
                            // slack at p=0 showing live A (invisible), so the effect completes at A's EOF to
                            // within a frame regardless of warmup variance. Firing LATE is the only failure
                            // (gate opens instantly; A holds its last frame briefly — never rewinds, it runs
                            // loop-file=no), hence generous slack on top of the measured cover latency.
                            int coverMs = Math.Clamp((TransitionService.LastCoverMs > 0 ? TransitionService.LastCoverMs : 2500) + 1200, 1500, 6000); // first run: ~2.4s measured on a 2-output full-live warmup; early only costs invisible hold
                            // re-read the duration each iteration (not the arm-time capture) so a transition-
                            // duration change during the possibly-minutes-long wait applies live to this lead
                            int durNowMs = TransitionService.CurrentConfig().DurationMs;
                            int leadMs = Math.Clamp(durNowMs, 200, 20000) + coverMs;
                            var sleepMs = Math.Max(0, (int)(rem2.Value * 1000) - leadMs);
                            if (sleepMs <= 0) break;
                            var delayTask = Task.Delay(sleepMs, ct);
                            var done = await Task.WhenAny(delayTask, _speedChangeTcs.Task).ConfigureAwait(false);
                            if (ct.IsCancellationRequested) return;
                            if (done == delayTask) { try { await delayTask; } catch (OperationCanceledException) { return; } break; }
                            try { await Task.Delay(100, ct).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
                        }
                    }
                    finally { _speedChangeTcs = null; }
                }
                lock (_lock)
                {
                    if (!_waitingForVideoEnd || ct.IsCancellationRequested) return;
                    _waitingForVideoEnd = false;
                    _waitCts = null;
                    // this switch is a video-END advance → the renderer must align p=1 to A's EOF
                    TransitionService.RequestAlignAEnd();
                    SwitchToFile(next, SettingsService.Load().BuildMpvOptions());
                    PostSwitch(next);
                }
                return;
            }
            if (remaining != null)
            {
                TrySendCommand("set", "loop-file", "no");
                TrySendCommand("loadfile", next, "append");

                try
                {
                    while (true)
                    {
                        _speedChangeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                        var rem2 = TryQueryTimeRemaining();
                        if (rem2 == null) break;
                        // Sleep for rem2 only — the +300ms buffer lives outside the loop so
                        // speed/volume can fire between them (at A's end, not 300ms after).
                        var sleepMs = Math.Max(0, (int)(rem2.Value * 1000));
                        var delayTask = Task.Delay(sleepMs, ct);
                        var done = await Task.WhenAny(delayTask, _speedChangeTcs.Task).ConfigureAwait(false);
                        if (ct.IsCancellationRequested) return;
                        if (done == delayTask)
                        {
                            try { await delayTask; }
                            catch (OperationCanceledException) { return; }
                            break;
                        }
                        // Speed changed — wait for mpv to process the IPC command before re-querying.
                        // Without this, playtime-remaining still reflects the old speed and we compute
                        // a sleep that's too short, causing the lock block to fire while A is still
                        // playing (loop-file=inf lands on A, playlist-clear removes B, A replays).
                        try { await Task.Delay(100, ct).ConfigureAwait(false); }
                        catch (OperationCanceledException) { return; }
                    }
                }
                finally { _speedChangeTcs = null; }

                // A has just ended. Apply B's speed/volume now — before the 300ms buffer —
                // so B inherits the correct values from its first frame rather than from A.
                // Fresh reads cover mid-sleep changes to global or per-video overrides.
                // SetSpeed/SetVolume must be called outside _lock (they acquire it internally).
                {
                    var transSettings = SettingsService.Load();
                    var transVol = ReadVolumeOverride(next) ?? transSettings.Volume;
                    var transSpeed = ReadSpeedOverride(next) ?? transSettings.Speed;
                    SetVolume(transVol);
                    SetSpeed(transSpeed);
                }

                // 300ms buffer: let mpv complete the A→B playlist advance before the lock
                // block sends loop-file=inf (arriving during the transition re-loops A).
                try { await Task.Delay(300, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }

                lock (_lock)
                {
                    if (!_waitingForVideoEnd || ct.IsCancellationRequested) return;
                    _waitingForVideoEnd = false;
                    _waitCts = null;

                    var settings = SettingsService.Load();
                    TrySendCommand("set", "loop-file", settings.Loop ? "inf" : "no");
                    TrySendCommand("playlist-clear");

                    OnWallpaperChanged?.Invoke(next);
                    PostSwitch(next);
                }
                return;
            }
        }

        // Video→scene: launch LWE SceneTransitionDelayMs before the video ends so the
        // scene is already rendering when mpvpaper is killed (matches normal transition behaviour).
        if (nextIsScene && !prevIsScene)
        {
            var remaining = TryQueryTimeRemaining();
            // Same socket-not-ready retry as the video→video path: in advance-on-end mode
            // this task may fire immediately after SwitchToFile(video) before mpv is up.
            if (remaining == null && _advanceOnVideoEnd)
            {
                for (int i = 0; i < 50 && remaining == null && !ct.IsCancellationRequested; i++)
                {
                    try { await Task.Delay(100, ct).ConfigureAwait(false); }
                    catch (OperationCanceledException) { return; }
                    remaining = TryQueryTimeRemaining();
                    // Socket is up but no file is playing (e.g. a short video ended before we
                    // got here due to the transition buffer). Switch to the scene immediately.
                    // Require at least 30 retries (3s) before breaking — the socket can appear
                    // within ~100ms of launch while playtime-remaining is still null because the
                    // file hasn't finished loading yet (Launch's readyTcs waits up to 2s for the
                    // first valid reading). Breaking too early causes a premature scene switch
                    // that makes the video appear to play for only a fraction of a second.
                    if (remaining == null && File.Exists(IpcSocket) && i >= 30) break;
                }
            }
            if (remaining != null)
            {
                try
                {
                    while (true)
                    {
                        _speedChangeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                        var rem2 = TryQueryTimeRemaining();
                        if (rem2 == null) break; // video already ended, launch scene now
                        // Lead by the FULL transition wall-time so it COMPLETES at the video's natural end
                        // (the video plays to its end + the scene takes over exactly then → no loop mid-
                        // transition). V→S transition = reveal-hold (SceneTransitionDelayMs) + effect duration;
                        // when no transition is active, just the scene-load lead (SceneTransitionDelayMs).
                        var sceneLoadMs = SettingsService.Load().SceneTransitionDelayMs;
                        var tcfg = TransitionService.CurrentConfig();
                        int delayMs = tcfg.Enabled
                            ? sceneLoadMs + Math.Clamp(tcfg.DurationMs, 200, 8000)
                            : sceneLoadMs;
                        var sleepMs = Math.Max(0, (int)(rem2.Value * 1000) - delayMs);
                        if (sleepMs <= 0) break;
                        var delayTask = Task.Delay(sleepMs, ct);
                        var done = await Task.WhenAny(delayTask, _speedChangeTcs.Task).ConfigureAwait(false);
                        if (ct.IsCancellationRequested) return;
                        if (done == delayTask)
                        {
                            try { await delayTask; }
                            catch (OperationCanceledException) { return; }
                            break;
                        }
                        // Speed changed — wait for mpv to process the IPC command before re-querying.
                        try { await Task.Delay(100, ct).ConfigureAwait(false); }
                        catch (OperationCanceledException) { return; }
                    }
                }
                finally { _speedChangeTcs = null; }
            }
        }

        // Scene→video and scene→scene: remaining is null (LWE has no mpv socket) — switch immediately.
        lock (_lock)
        {
            if (!_waitingForVideoEnd || ct.IsCancellationRequested) return;
            _waitingForVideoEnd = false;
            _waitCts = null;
            SwitchToFile(next, SettingsService.Load().BuildMpvOptions());
            PostSwitch(next);
        }
    }

    // The transition (effect / duration / on-off / method) changed while an aligned switch is armed for A's
    // end. liascape-player: that switch was REQUESTED at arm time with the old effect + duration (the player
    // times it), so re-request it with the new config — the next switch must use what the user just set
    // (legacy picks the effect when its overlay starts, near A's end: already live). Same `next`.
    public static void RearmAlignedSwitch()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        lock (_lock)
        {
            if (!_waitingForVideoEnd || _timerReleased || _waitCts == null || _history == null
                || _historyIndex < 0 || _historyIndex >= _history.Count) return;
            var next = _history[_historyIndex];
            if (IsScenePath(next)) return;
            CancelVideoEndWait();
            ArmVideoEndWait(next);
        }
    }

    private static void CancelVideoEndWait()
    {
        _waitCts?.Cancel();
        _waitCts = null;
        _waitingForVideoEnd = false;
        // Restore loop so the current video doesn't advance to the queued file
        // in the gap between cancel and the following SwitchToFile call.
        // TryIpcSwitchToFile will set the correct value immediately after.
        TrySendCommand("set", "loop-file", "inf");
    }

    private static void ArmVideoEndWait(string next, bool prevIsVideo = true)
    {
        var cts = _waitCts = new CancellationTokenSource();
        _waitingForVideoEnd = true;
        Task.Run(() => DoVideoEndWait(next, cts.Token, prevIsVideo));
    }

    // The file the most recent switch made current. DoVideoEndWait waits for mpv to report it as
    // `path` before sampling playtime-remaining (else it samples the outgoing file → storm-switch).
    private static volatile string? _lastSwitchTarget;

    // After switching to a new wallpaper: arm the next video-end pre-fetch (advance-on-end)
    // or reset the countdown (timed interval). Always saves state.
    private static void PostSwitch(string path)
    {
        _lastSwitchTarget = path;
        _itemPlayedMs = 0; // `path` became the playing item (liascape-player: when its effect started)
        _timedRemainingMs = (long)_timedInterval.TotalMilliseconds;
        if (_advanceOnVideoEnd && !IsScenePath(path) && CanRotate)
        {
            var next = AdvanceToNext();
            if (next != null) ArmVideoEndWait(next);
        }
        SaveTimedState();
    }

    private static void AdvanceAndLaunch()
    {
        // When _waitingForVideoEnd is true (both advance-on-end and wait-for-video-end
        // modes), _historyIndex is already pre-fetched one step ahead of the
        // currently-playing item. Use it directly; calling AdvanceToNext() would skip it.
        bool preIsFetched = _waitingForVideoEnd
            && _history != null && _historyIndex >= 0 && _historyIndex < _history.Count;
        CancelVideoEndWait();
        string? next = preIsFetched ? _history![_historyIndex] : AdvanceToNext();
        if (next != null) LaunchAndReset(next);
    }

    private static void StepBackAndLaunch()
    {
        // When _waitingForVideoEnd is true, _historyIndex is pre-fetched one step ahead: the playing
        // item is at PlayingHistoryIndex, the previous one right before it. Nothing played before it →
        // leave it AND its armed video-end wait alone (with a pre-fetch this used to undo the pre-fetch
        // only and relaunch the playing item: restarted, its armed switch cancelled).
        if (_history == null) return;
        int prev = PlayingHistoryIndex - 1;
        if (prev < 0 || prev >= _history.Count) return;
        CancelVideoEndWait();
        _historyIndex = prev;
        LaunchAndReset(_history[_historyIndex]);
    }

    private static void RandomAndLaunch()
    {
        if (_timedPaths == null || _timedPaths.Count == 0) return;
        // In advance-on-end mode _historyIndex is pre-fetched; use the item before it
        // as "current" so we don't accidentally exclude the pending-next item.
        int playingIdx = PlayingHistoryIndex;
        var current = _history != null && playingIdx >= 0 && playingIdx < _history.Count
            ? _history[playingIdx]
            : null;
        // Same IsSkippedPath contract as AdvanceToNext/TryStepLibrary/ApplyRandom — _timedPaths is
        // normally already scene-filtered under liascape-player (ApplyPlaylist), but a stale cross-engine
        // session (SwitchEngineLive replaying a legacy LastSession) can still carry one through; skip
        // it here too rather than randomizing onto a path that just stops playback.
        bool scenesOk = PlayerEngine.ScenesPlayable(SettingsService.Load());
        var pool = _timedPaths.Where(p => !IsSkippedPath(p, scenesOk)).ToList();
        // nothing playable to pick — leave the current wallpaper (and its armed video-end wait) alone
        if (pool.Count == 0) return;
        CancelVideoEndWait();
        var pick = PickRandomExcluding(pool, current);
        if (_history != null)
        {
            // The pick replaces everything after what plays: an advance-on-end session's pre-fetched next
            // (never played) and a forward stack left by previous — kept, previous after a random went to
            // that never-played pre-fetch instead of back to what played before the pick.
            if (playingIdx >= 0 && playingIdx < _history.Count - 1)
                _history.RemoveRange(playingIdx + 1, _history.Count - playingIdx - 1);
            _history.Add(pick);
            if (_history.Count > 100) _history.RemoveAt(0);
            _historyIndex = _history.Count - 1;
        }
        // The rotation goes on from the pick's place: AdvanceToNext steps _timedIndex, which still pointed at
        // the item before the random (or at the pre-fetched next) — next / the re-armed aligned switch went to
        // the pick ITSELF (random onto the old position's successor) or to the old successor.
        int at = _timedPaths.IndexOf(pick);
        if (at >= 0) _timedIndex = at;
        LaunchAndReset(pick);
    }

    // Uniform pick from `pool` excluding `exclude`. No retries: shifts the
    // chosen index past the excluded one to keep the distribution flat.
    private static string PickRandomExcluding(IReadOnlyList<string> pool, string? exclude)
    {
        if (pool.Count == 1 || exclude == null) return pool[Random.Shared.Next(pool.Count)];
        int excludeIdx = -1;
        for (int i = 0; i < pool.Count; i++)
            if (pool[i] == exclude) { excludeIdx = i; break; }
        if (excludeIdx < 0) return pool[Random.Shared.Next(pool.Count)];
        int pick = Random.Shared.Next(pool.Count - 1);
        if (pick >= excludeIdx) pick++;
        return pool[pick];
    }

    private static void DispatchPendingAction(string action)
    {
        // a user switch reaching the tick owner while paused (it may have been made in another
        // process — a keybind with no app open — so decided here, not where it was asked for)
        _keepPauseNextSwitch = action is "next" or "prev" or "random" && KeepsPause();
        try
        {
            switch (action)
            {
                case "next": AdvanceAndLaunch(); break;
                case "prev": StepBackAndLaunch(); break;
                case "random": RandomAndLaunch(); break;
                case "restart": RestartCurrentAndLaunch(); break;
                // defer: don't restart now — the next changeover's SwitchToFile becomes a cold relaunch (masked)
                case "soft-restart": _restartPending = true; break;
            }
        }
        finally { _keepPauseNextSwitch = false; }
    }

    // ── Pause × a user switch (next / previous / random: keybind, CLI, /next /prev /random) ──────
    // KeepPauseOnSwitch off (default): a switch made while paused resumes playback first, so it
    // switches with its transition and plays — single and playlist alike (a paused playlist's tick
    // used to hold the action until the resume, then switch; a single one already unpaused). On: the
    // pause stays — the switch is a cut (an effect can't run with playback stopped: liascape-player's clock
    // is frozen) to the new wallpaper's first frame, paused, and a paused playlist's tick runs it at
    // once (its countdown stays paused). A rotation never switches while paused.
    private static bool _keepPauseNextSwitch; // consumed by the next SwitchToFile (and Apply)

    private static bool KeepsPause() => SettingsService.Load().KeepPauseOnSwitch && IsPausedNow();

    public static bool IsPausedNow() =>
        PlayerEngine.IsLiascapePlayer ? LiascapePlayerMedia.IsPlayerPaused() : QueryMpvData("pause") is { ValueKind: JsonValueKind.True };

    // Before a user switch: resume (default) — or leave the pause for the switch to keep (true)
    private static bool BeforeUserSwitch()
    {
        if (!IsPausedNow()) return false;
        if (SettingsService.Load().KeepPauseOnSwitch) return true;
        if (PlayerEngine.IsLiascapePlayer) LiascapePlayerMedia.QueueNewSession(); // `set player.paused false`, queued ahead of the switch
        else TrySendCommand("set_property", "pause", false);
        SetTimerPaused(false); // the tick owner (maybe another process) counts again and runs the action
        return false;
    }

    // Runs a non-timed user switch with the keep-pause flag set for its SwitchToFile, never leaving it set.
    private static void UserSwitch(bool keep, Action run)
    {
        _keepPauseNextSwitch = keep;
        try { run(); }
        finally { _keepPauseNextSwitch = false; }
    }

    public static void NextWallpaper()
    {
        bool keep = BeforeUserSwitch();
        if (IsTimedPlaylistActive())
        {
            WritePendingAction("next");
            return;
        }
        // Single-wallpaper sessions (single, random) — step the library.
        // mpv-native playlist mode falls through to playlist-next.
        UserSwitch(keep, () => { if (!TryStepLibrary(forward: true)) SendCommand("playlist-next"); });
    }

    public static void PreviousWallpaper()
    {
        bool keep = BeforeUserSwitch();
        if (IsTimedPlaylistActive())
        {
            WritePendingAction("prev");
            return;
        }
        UserSwitch(keep, () => { if (!TryStepLibrary(forward: false)) SendCommand("playlist-prev"); });
    }

    // For single-wallpaper sessions (no playlist context), `next`/`prev`
    // steps through the library alphabetically. Wraps at the ends. Returns
    // false for mpv-native playlist sessions so the caller can fall through
    // to mpv's own `playlist-next`/`playlist-prev`.
    //
    // Skips items unplayable under the current engine (IsSkippedPath — scenes when
    // !ScenesPlayable, the SAME "skipped exactly like AllowScenes=false" contract the
    // timed-playlist tick's own AdvanceToNext already applies) by stepping further in the
    // same direction, bounded to one full pass of the library so an all-unplayable library
    // can't spin forever. Throws InvalidOperationException (never calls Apply on an
    // unplayable path) when NOT ONE library item is playable — callers turn that into a
    // 4xx/clear message instead of letting Apply()'s own scene check 500 the request.
    private static bool TryStepLibrary(bool forward)
    {
        var settings = SettingsService.Load();
        var session = settings.LastSession;
        if (session == null) return false;
        if (session.IsTimedPlaylist || session.IsPlaylist) return false;
        if (session.Paths.Count == 0) return false;

        // Use LoadAll's native order so stepping mirrors the UI grid order
        // exactly (whatever filesystem order GUI displays).
        var library = LibraryService.LoadAll();
        if (library.Count == 0) return false;

        var current = session.Paths[0];
        int currentIdx = library.FindIndex(i => i.VideoPath == current);
        int newIdx = currentIdx < 0
            ? 0
            : forward
                ? (currentIdx + 1) % library.Count
                : (currentIdx - 1 + library.Count) % library.Count;

        bool scenesOk = PlayerEngine.ScenesPlayable(settings);
        int pickIdx = newIdx;
        for (int attempts = 0; attempts < library.Count && IsSkippedPath(library[pickIdx].VideoPath, scenesOk); attempts++)
            pickIdx = forward ? (pickIdx + 1) % library.Count : (pickIdx - 1 + library.Count) % library.Count;

        if (IsSkippedPath(library[pickIdx].VideoPath, scenesOk))
            throw new InvalidOperationException(NoPlayableMessage());

        var pickPath = library[pickIdx].VideoPath;
        Apply(pickPath, settings.BuildMpvOptions());
        settings.LastSession = new LastSession { Paths = [pickPath] };
        SettingsService.Update(s => s.LastSession = new LastSession { Paths = [pickPath] });
        return true;
    }

    public static void UpdateTimedSettings(bool shuffle, int intervalSeconds, bool advanceOnVideoEnd = false)
    {
        lock (_lock)
        {
            if (_timedPaths == null && !LoadTimedState()) return;
            _timedShuffle = shuffle;
            long oldMin = MinPlayMs;
            var oldIntervalMs = (long)_timedInterval.TotalMilliseconds;
            _timedInterval = TimeSpan.FromSeconds(intervalSeconds);
            var newIntervalMs = (long)_timedInterval.TotalMilliseconds;
            var elapsed = Math.Max(0L, oldIntervalMs - _timedRemainingMs);
            _timedRemainingMs = elapsed >= newIntervalMs ? newIntervalMs : newIntervalMs - elapsed;

            if (_advanceOnVideoEnd != advanceOnVideoEnd)
            {
                // _historyIndex is pre-fetched one step ahead when _waitingForVideoEnd is true.
                // Step back to the actual playing item so AdvanceToNext() re-fetches correctly.
                if (_waitingForVideoEnd && _historyIndex > 0)
                    _historyIndex--;
                CancelVideoEndWait();
                _advanceOnVideoEnd = advanceOnVideoEnd;

                if (advanceOnVideoEnd && !ScenePlaying && _timedPaths!.Count > 1)
                {
                    var next = AdvanceToNext();
                    if (next != null)
                        ArmVideoEndWait(next);
                }
            }
            else if (MinPlayMs != oldMin && PlayerEngine.IsLiascapePlayer && _advanceOnVideoEnd && _waitingForVideoEnd && !_timerReleased
                     && _waitCts != null && !ScenePlaying && _history != null && _historyIndex >= 0 && _historyIndex < _history.Count)
            {
                // a new minimum under advance-on-end: the end-of-video switch already armed was requested for the
                // end of A's CURRENT loop (or is still held for an older minimum) — re-arm it to the same B so the
                // new minimum holds (or releases) it. The item's play time keeps counting.
                var next = _history[_historyIndex];
                CancelVideoEndWait();
                ArmVideoEndWait(next);
            }

            // (Positive→0 leaves the timer ticking harmlessly; the `_timedInterval > Zero` guard in Tick
            // suppresses the advance.)
            EnsureTimedTick(takeBack: false);

            SaveTimedState();
        }
    }

    // Live-apply a rotation change (interval — the minimum under advance-on-end — / advance-on-end) to the RUNNING
    // timed playlist with no replay — preserves the running shuffle + the proportional countdown + the item's play
    // time. No-op when no timed session is active (UpdateTimedSettings early-returns). Wired from /settings (global
    // rotation, when the session follows globals) + /playlist/state (per-playlist rotation, when it overrides).
    public static void ApplyRotationLive(int intervalSeconds, bool advanceOnVideoEnd)
        => UpdateTimedSettings(_timedShuffle, intervalSeconds, advanceOnVideoEnd);

    // PlayerEngine changed (/settings), live: stop the OLD engine's media, then replay on the new one —
    // a running timed playlist resumes at the item it was on (timed_state.json), else LastSession.
    // Nothing playing → nothing started. Unchanged engine → just refresh the cached engine/binary.
    public static void SwitchEngineLive(AppSettings prev, AppSettings cur)
    {
        bool wasPlayer = PlayerEngine.IsLiascapePlayer;          // what actually runs (cached since serve start)
        bool nowPlayer = PlayerEngine.WouldBeLiascapePlayer(cur);
        if (wasPlayer == nowPlayer) { PlayerEngine.Refresh(cur); return; }
        bool timed, playing = IsPlaying;                // (an liascape-player query → outside _lock)
        lock (_lock)
        {
            timed = _timedPaths != null && !_timedTimerStopped;
            playing |= timed;
            SaveTimedState();       // the playlist position for the replay (no-op without a timed session)
            TeardownTimer();        // state only — timed_state.json is kept; the tick can't switch any more
            if (!wasPlayer) KillCurrentProcess();             // legacy media: process kills, no socket waits
            else { StopPlaylistObserver(); _current = null; }
        }
        // liascape-player OUTSIDE _lock, synchronously: the old engine is fully gone (stop → quit → TERM/KILL)
        // before the new one starts — never both on screen
        if (wasPlayer) LiascapePlayerMedia.StopAndQuit();
        PlayerEngine.Refresh(cur);
        KillRestartDaemon();
        TransitionService.ClearInProgress();
        LiascapePlayerClient.Log($"PlayerEngine {(wasPlayer ? "liascape-player" : "legacy")} → {(nowPlayer ? "liascape-player" : "legacy")}: " +
            (!playing ? "nothing was playing" : timed ? "resuming the timed playlist" : "replaying the last session"));
        if (!playing) return;
        try
        {
            if (timed && RestoreTimedPlaylist()) return;
            var session = cur.LastSession;
            if (session == null || session.Paths.Count == 0) return;
            if (session.IsTimedPlaylist)
            {
                var paths = session.Shuffle ? session.Paths.OrderBy(_ => Guid.NewGuid()).ToList() : session.Paths;
                ApplyTimedPlaylist(paths, cur.BuildMpvOptions(), session.Shuffle, session.TimedIntervalSeconds, session.AdvanceOnVideoEnd);
            }
            else if (session.IsPlaylist) ApplyPlaylist(session.Paths, cur.BuildMpvPlaylistOptions(), session.Shuffle);
            else Apply(session.Paths[0], cur.BuildMpvOptions());
        }
        catch (Exception e) { LiascapePlayerClient.Log($"replaying the session on {(nowPlayer ? "liascape-player" : "legacy")} failed: {e.Message}"); }
    }

    public static void Stop()
    {
        lock (_lock)
        {
            KillAll();
            SignalTimerStop();
            ClearPlaylistObserverPaths();
        }
        KillRestartDaemon();
        // any in-flight transition died with its players — a stale InProgress marker would delay the
        // NEXT session's first video-end sample (late transition on a short first clip)
        TransitionService.ClearInProgress();
    }

    // Re-apply the last saved session: timed playlist, mpv-native playlist,
    // or single video. For timed playlists, delegates to a detached daemon.
    public static void Restore()
    {
        var settings = SettingsService.Load();
        var session = settings.LastSession;
        if (session == null) return;

        if (settings.AutoMute)
            AudioMonitor.SpawnDetachedMonitor();

        if (session.IsTimedPlaylist && session.Paths.Count > 0)
            SpawnTimerDaemon();
        else if (session.IsPlaylist && session.Paths.Count > 0)
        {
            ApplyPlaylist(session.Paths, settings.BuildMpvPlaylistOptions(), session.Shuffle);
            SpawnTimerDaemon();
        }
        else if (session.Paths.Count > 0)
            Apply(session.Paths[0], settings.BuildMpvOptions());

        SpawnRestartDaemon();
    }

    // Pick a random video and apply it as a single wallpaper. If a timed
    // playlist is active, hands off to the timer owner via a pending action
    // so the daemon picks from its in-memory paths and resets the countdown.
    // Otherwise picks from the full library as a one-shot.
    //
    // Excludes items unplayable under the current engine (IsSkippedPath — same contract as
    // TryStepLibrary/AdvanceToNext) from the pool so a random pick never lands Apply() on a
    // scene under liascape-player. An empty library is still a silent no-op (nothing to play, not an
    // error); a non-empty library with NO playable item throws so the caller can surface it
    // instead of letting Apply() 500.
    public static void ApplyRandom()
    {
        bool keep = BeforeUserSwitch();
        if (IsTimedPlaylistActive())
        {
            WritePendingAction("random");
            return;
        }
        UserSwitch(keep, ApplyRandomNow);
    }

    private static void ApplyRandomNow()
    {

        var settings = SettingsService.Load();
        var library = LibraryService.LoadAll();
        if (library.Count == 0) return;

        bool scenesOk = PlayerEngine.ScenesPlayable(settings);
        var pool = library.Select(i => i.VideoPath).Where(p => !IsSkippedPath(p, scenesOk)).ToList();
        if (pool.Count == 0)
            throw new InvalidOperationException(NoPlayableMessage());

        var current = settings.LastSession?.Paths.FirstOrDefault();
        var pick = PickRandomExcluding(pool, current);
        Apply(pick, settings.BuildMpvOptions());
        settings.LastSession = new LastSession { IsRandom = true, Paths = [pick] };
        SettingsService.Update(s => s.LastSession = new LastSession { IsRandom = true, Paths = [pick] });
    }

    // Owns the timed-playlist tick loop in a detached process. Resumes an
    // already-running session if possible; otherwise restarts it. Blocks
    // until the timer is signalled to stop.
    public static void RunTimerDaemon()
    {
        _daemonMode = true;
        InstallShutdownReaper();
        var settings = SettingsService.Load();
        var session = settings.LastSession;
        if (session == null || session.Paths.Count == 0) return;

        // Live state takes precedence over LastSession flags. ApplyPlaylist can upgrade to
        // ApplyTimedPlaylist mid-call (scenes + AllowScenes) while the caller still saves
        // LastSession.IsPlaylist=true with AdvanceOnVideoEnd=true. Without this check the
        // daemon would attach a playlist observer to a timed playback and the timer would
        // never fire → scene stuck forever.
        bool timedActive = IsTimedPlaylistActive();

        if (session.IsTimedPlaylist || timedActive)
        {
            bool started = IsPlaying && ResumeTimedTimer();
            if (!started)
            {
                if (settings.ResumeFromLast && RestoreTimedPlaylist()) { }
                else if (session.IsTimedPlaylist)
                {
                    var paths = session.Shuffle
                        ? session.Paths.OrderBy(_ => Guid.NewGuid()).ToList()
                        : session.Paths;
                    ApplyTimedPlaylist(paths, settings.BuildMpvOptions(), session.Shuffle, session.TimedIntervalSeconds, session.AdvanceOnVideoEnd);
                }
                // For the upgrade case (LastSession.IsPlaylist + timedActive) without resume,
                // there's no recorded TimedIntervalSeconds to reconstruct from — bail.
            }
        }
        else if (session.IsPlaylist)
        {
            // Reconnect the playlist-pos observer to the already-running mpvpaper
            // so per-video volume/speed overrides keep firing after GUI close.
            // Use the saved observer paths (post-shuffle order) if available.
            List<string> observerPaths = session.Paths;
            try
            {
                if (File.Exists(PlaylistObserverPathsPath))
                    observerPaths = JsonSerializer.Deserialize<List<string>>(File.ReadAllText(PlaylistObserverPathsPath)) ?? session.Paths;
            }
            catch { }
            _daemonCts?.Dispose();
            _daemonCts = new CancellationTokenSource();
            StartPlaylistObserver(observerPaths);
        }
        else return;

        WriteTimerDaemonPid();
        try { DaemonToken.WaitHandle.WaitOne(); }
        finally { DeleteTimerDaemonPid(); }
    }

    public static void TogglePause()
    {
        // During a transition the visible/audible wallpaper IS the overlay (it decodes A/B itself;
        // mpvpaper-B is parked at frame 0 for the handoff). Toggle the overlay's freeze instead of
        // cycling mpvpaper — the renderer owns the pause state (stateless here → can't desync).
        if (Process.GetProcessesByName("liascape-transition").Length > 0)
        {
            SendOverlayCtl("pause");
            return;
        }
        lock (_lock)
        {
            SendCommand("cycle", "pause");
            UpdateTimerPaused(p => !p);
        }
    }

    // the timed playlist's countdown pause, in the state file the tick owner reads (RefreshSignals)
    private static void SetTimerPaused(bool paused)
    {
        lock (_lock)
        {
            if (_timedPaths != null) _timedTimerPaused = paused;
            UpdateTimerPaused(_ => paused);
        }
    }

    private static void UpdateTimerPaused(Func<bool, bool> f)
    {
        try
        {
            if (!File.Exists(TimedStatePath)) return;
            var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
            if (state == null) return;
            var updated = state with { TimerPaused = f(state.TimerPaused), TimerStopped = false };
            if (updated == state) return;
            var tmp = TimedStatePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(updated));
            File.Move(tmp, TimedStatePath, overwrite: true);
        }
        catch { }
    }

    public static void SendCommand(params object[] args)
    {
        if (PlayerEngine.IsLiascapePlayer) { LiascapePlayerMedia.Mpv(args); return; }
        var socketPath = IpcSocket;
        if (!File.Exists(socketPath)) return;
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.SendTimeout = 500;
            socket.ReceiveTimeout = 500;
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            var cmd = JsonSerializer.Serialize(new { command = args });
            socket.Send(Encoding.UTF8.GetBytes(cmd + "\n"));
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[PlayerHelper] SendCommand failed: {ex.Message}");
        }
    }

    // Automute-driven mute. Updates _autoMuted always; blocked from sending unmute if user has explicitly muted.
    public static void SetMute(bool mute)
    {
        _autoMuted = mute;
        _isMuted = mute || _userMuted;
        if (!mute && _userMuted) return;
        SendCommand("set_property", "mute", _isMuted);
        SendOverlayCtl(_isMuted ? "mute 1" : "mute 0");
        if (IsLweRunning) ApplyLweMute(_isMuted);
    }

    // User-initiated mute (keybind, UI toggle). Always applies; sets _userMuted so automute can't undo it.
    public static void SetUserMute(bool mute)
    {
        _userMuted = mute;
        _isMuted = mute || _autoMuted;
        try
        {
            var path = UserMuteStatePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (mute) File.WriteAllText(path, "true");
            else if (File.Exists(path)) File.Delete(path);
        }
        catch { }
        SendCommand("set_property", "mute", _isMuted);
        SendOverlayCtl(_isMuted ? "mute 1" : "mute 0");
        if (IsLweRunning) ApplyLweMute(_isMuted);
    }

    public static void SetVolume(int volume)
    {
        SendCommand("set_property", "volume", (double)volume);
        SendOverlayCtl($"vol {volume}");
        if (IsLweRunning) ApplyLweVolume(volume);
    }

    // The Settings page's global Volume/Speed drag preview (`/preview {global:true}`, no persist — the
    // UI's debounced /settings persists): every live wallpaper WITHOUT its own override for that field
    // takes the dragged value (effective = override ?? global, R61); an overridden one never moves.
    public static void PreviewGlobal(int? volume, double? speed)
    {
        if (PlayerEngine.IsLiascapePlayer) { LiascapePlayerMedia.PreviewGlobal(volume, speed); return; }
        var cur = QueryCurrentPath();
        if (cur == null) return;
        if (volume is int v && ReadVolumeOverride(cur) == null) SetVolume(v);
        if (speed is double sp && !IsLweRunning && ReadSpeedOverride(cur) == null) SetSpeed(sp); // scenes are 1×
    }

    public static void SetSpeed(double speed)
    {
        SendCommand("set_property", "speed", speed);
        lock (_lock) { _currentSpeed = speed; }
        _speedChangeTcs?.TrySetResult(true);
    }

    // Apply a per-wallpaper override LIVE to the currently-playing wallpaper, seamlessly (no restart):
    // mpv set_property for video volume/speed, LWE for scene volume (scenes are 1× → speed no-op). No-op
    // unless `path` is what's playing. Effective = override ?? global, so clearing an override (index key
    // dropped because it == global) snaps the running wallpaper back to the global value. SetSpeed keeps
    // the timed-playlist cache (_currentSpeed) in sync, so later ticks/advances use the new value too.
    public static void ApplyOverrideLive(string path)
    {
        // liascape-player: the resolver, on the source(s) showing THAT item (may be an in-flight transition's
        // pending B); coalescible — it re-reads the override when it runs
        if (PlayerEngine.IsLiascapePlayer)
        {
            LiascapePlayerMedia.ApplyOverride(path, liascapeSpd => { lock (_lock) { _currentSpeed = liascapeSpd; } _speedChangeTcs?.TrySetResult(true); });
            return;
        }
        var cur = QueryCurrentPath();
        if (cur == null) return;
        try { if (Path.GetFullPath(cur) != Path.GetFullPath(path)) return; } catch { return; }
        var s = SettingsService.Load();
        SetVolume(LibraryService.ReadVolumeOverride(path) ?? s.Volume);
        if (!IsLweRunning) SetSpeed(LibraryService.ReadSpeedOverride(path) ?? s.Speed);
    }

    // A scene item's user properties changed (`/library/scene-props`, saved first): liascape-player → its live
    // source(s) get the new `scene_props` (the worker sets each changed one on the running scene — live, same
    // worker); `preview` = a drag's unsaved values (`/library/scene-props/preview`). Legacy: nothing live —
    // LWE takes properties only at launch (`--set-property`, SpawnLweProcesses), so a change shows at the
    // scene's next start (the one genuine launch-only case there, like LweMonitors).
    public static void ApplyScenePropsLive(string path, IReadOnlyDictionary<string, System.Text.Json.JsonElement>? preview = null)
    {
        if (!PlayerEngine.IsLiascapePlayer || !IsScenePath(path)) return;
        if (preview != null) LiascapePlayerMedia.PreviewSceneProps(path, preview);
        else LiascapePlayerMedia.ApplySceneProps(path);
    }

    public static void SetLoop(bool loop) =>
        TrySendCommand("set", "loop-file", loop ? "inf" : "no");

    public static void SetPlaylistShuffle(bool shuffle) =>
        TrySendCommand(shuffle ? "playlist-shuffle" : "playlist-unshuffle");

    public static void SetVideoScale(string scale)
    {
        double panscan = scale == "fill" ? 1.0 : 0.0;
        SendCommand("set_property", "panscan", panscan);
    }

    // liascape-player's `/settings` live-apply: ONE resolver pass (LiascapePlayerMedia.ApplyEffective) — every live
    // source gets its own effective volume/speed (override ?? global), af, mute and decode/buffer settings,
    // and the layer its fit, each diffed against what it runs (only what differs is sent; a no-op save
    // sends nothing). It replaces SetVolume/SetSpeed/SetVideoScale/ApplyNormalizationLive/
    // ApplyPlaybackSettingsLive there. Loop keeps the legacy guard (a single, non-timed wallpaper only);
    // the timed tick's speed factor follows the playing item's effective speed, as SetSpeed keeps it.
    public static void ApplyEffectiveLive(AppSettings prev, AppSettings cur, string? playingPath)
    {
        LiascapePlayerMedia.ApplyEffective();
        if (prev.Loop != cur.Loop && !_waitingForVideoEnd && !IsTimedPlaylistActive()) LiascapePlayerMedia.SetLoop(cur.Loop);
        var speed = (playingPath != null ? ReadSpeedOverride(playingPath) : null) ?? cur.Speed;
        lock (_lock) { _currentSpeed = speed; }
        _speedChangeTcs?.TrySetResult(true);
    }

    // Apply CHANGED playback settings LIVE to the currently-playing wallpaper — no stop/replay/relaunch.
    // Diffs prev→cur so we only poke mpv/LWE for what actually changed (needlessly re-applying vf/hwdec/
    // cache re-inits the decoder → a visible stall). Volume/Speed/VideoScale/Normalization/AutoMute are
    // applied by the /settings handler; this covers Loop, NoAudio, VideoFps, DisableCache, Demuxer*, HwDec
    // (video, via mpv IPC properties) + NoAudio (scene, via LWE mute). All of these were formerly
    // launch-only (needed a stop/replay to take effect). Legacy only — liascape-player: ApplyEffectiveLive.
    public static void ApplyPlaybackSettingsLive(AppSettings prev, AppSettings cur, string? playingPath)
    {
        bool scene = IsLweRunning;
        bool mpvAlive = File.Exists(IpcSocket) && MpvpaperProcs().Length > 0;

        // NoAudio = mute the whole wallpaper's audio. Applies to a scene (LWE) OR a video (mpv).
        if (prev.NoAudio != cur.NoAudio)
        {
            if (scene)
            {
                // Scenes launch with the audio device OPEN (primary at --volume 0 when NoAudio, never
                // --silent) so this toggles LIVE. Hold the new mute/volume via liascape-audio (event-driven →
                // survives LWE's constant stream RE-CREATION, which resets a one-shot pactl — the whole
                // reason liascape-audio exists). Muting keeps the hold (persists until the next switch's
                // AudioCtl("clear")); unmuting holds briefly then releases so steady-state / later volume
                // changes aren't pinned. pactl too, as the liascape-audio-absent fallback.
                bool m = cur.NoAudio || _isMuted || AudioMonitor.IsMuted;
                int vol = (playingPath != null ? ReadVolumeOverride(playingPath) : null) ?? cur.Volume;
                var pids = GetLweProcPids();
                if (pids.Count > 0)
                {
                    AudioCtl("clear");
                    AudioCtl($"set {PidCsv(pids)} {vol} {(m ? 1 : 0)}");
                    if (!m) Task.Run(async () => { await Task.Delay(700); AudioCtl("clear"); });
                }
                ApplyLweMute(m);
                if (!m) ApplyLweVolume(vol);
            }
            else if (mpvAlive)
            {
                // mpv revives/kills the audio track live: `aid auto` re-inits the ao even after a
                // --no-audio launch (verified). Off→on restores the effective volume + any active mute.
                TrySendCommand("set", "aid", cur.NoAudio ? "no" : "auto");
                if (!cur.NoAudio)
                {
                    SetVolume((playingPath != null ? ReadVolumeOverride(playingPath) : null) ?? cur.Volume);
                    if (_isMuted || AudioMonitor.IsMuted) SendCommand("set_property", "mute", true);
                }
            }
        }

        if (!mpvAlive) return; // the rest are video-only mpv decode/buffer properties

        // Loop: match the displayed video's loop-file. Only for a SINGLE (non-timed) video — the timed
        // machinery owns loop-file (loadfile-append during advance-waits, per-item loop while displayed),
        // so re-asserting it under a running playlist would break the advance / stop the clip early.
        if (prev.Loop != cur.Loop && !_waitingForVideoEnd && !IsTimedPlaylistActive())
            SetLoop(cur.Loop);
        if (prev.VideoFps != cur.VideoFps)
            TrySendCommand("set", "vf", cur.VideoFps > 0 ? $"fps={cur.VideoFps}" : "");
        if (prev.DisableCache != cur.DisableCache)
            TrySendCommand("set", "cache", cur.DisableCache ? "no" : "auto");
        if (prev.DemuxerMaxBytes != cur.DemuxerMaxBytes)
            TrySendCommand("set", "demuxer-max-bytes", $"{cur.DemuxerMaxBytes}MiB");
        if (prev.DemuxerMaxBackBytes != cur.DemuxerMaxBackBytes)
            TrySendCommand("set", "demuxer-max-back-bytes", $"{cur.DemuxerMaxBackBytes}MiB");
        if (prev.HwDec != cur.HwDec)
            TrySendCommand("set", "hwdec", string.IsNullOrWhiteSpace(cur.HwDec) ? "no" : cur.HwDec);
    }

    private static void StartPlaylistObserver(IReadOnlyList<string> videoPaths)
    {
        _observerCts?.Cancel();
        _observerCts?.Dispose();
        var cts = _observerCts = new CancellationTokenSource();
        var paths = videoPaths.ToArray();
        _currentObserverPaths = [.. paths];
        Task.Run(() => ObservePathAsync(paths, cts.Token));
    }

    private static void StopPlaylistObserver()
    {
        _observerCts?.Cancel();
        _observerCts?.Dispose();
        _observerCts = null;
    }

    private static async Task ObservePathAsync(string[] videoPaths, CancellationToken ct)
    {
        var socketPath = IpcSocket;
        for (int i = 0; i < 50 && !File.Exists(socketPath) && !ct.IsCancellationRequested; i++)
        {
            try { await Task.Delay(100, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
        if (ct.IsCancellationRequested || !File.Exists(socketPath)) return;

        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            socket.Connect(new UnixDomainSocketEndPoint(socketPath));
            using var ns = new NetworkStream(socket, ownsSocket: false);
            using var reader = new StreamReader(ns, Encoding.UTF8);
            using var writer = new StreamWriter(ns, Encoding.UTF8) { AutoFlush = true };
            using var reg = ct.Register(() => { try { socket.Close(); } catch { } });

            await writer.WriteLineAsync("{\"command\":[\"observe_property\",1,\"playlist-pos\"]}").ConfigureAwait(false);

            while (!ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                if (line == null) break;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("event", out var ev) || ev.GetString() != "property-change") continue;
                    if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Number) continue;
                    var pos = data.GetInt32();
                    if (pos >= 0 && pos < videoPaths.Length)
                    {
                        ApplyOverridesForPath(videoPaths[pos]);
                        OnWallpaperChanged?.Invoke(videoPaths[pos]);
                    }
                }
                catch { }
            }
        }
        catch (OperationCanceledException) { }
        catch { }
    }

    private static void ApplyOverridesForPath(string path)
    {
        var settings = SettingsService.Load();
        var vol = ReadVolumeOverride(path) ?? settings.Volume;
        var spd = ReadSpeedOverride(path) ?? settings.Speed;
        SetVolume(vol);
        SetSpeed(spd);
    }


    // Adjust the GLOBAL volume by `delta` (clamped 0-100) — the keybind twin of the Settings page's global
    // slider. Persisted (subsequent launches and the GUI slider reflect it) and pushed live as the playing
    // item's EFFECTIVE volume (override ?? global, like /settings): an item with its own volume keeps it.
    // It pushed the new global even then — the playing wallpaper jumped off its override until the next
    // settings save (a theme change) snapped it back (UI matrix `cli:volume-up:overridden`).
    // The volume keybinds, ±delta clamped 0–100, by `VolumeKeyTarget`: "auto" (default) moves the playing
    // wallpaper's own volume when it has one, else the global; "item" always the playing wallpaper's own
    // (override ?? global → its override); "global" always the global — then an overridden wallpaper keeps
    // its own (it used to get the new global pushed and snap back on the next settings save). Live either
    // way: an override like /library/volume (save + ApplyOverrideLive), the global by the effective value.
    // Returns the item whose override moved (null: the global did, or nothing changed) for the UI event.
    public static string? AdjustVolume(int delta)
    {
        var settings = SettingsService.Load();
        var cur = QueryCurrentPath();
        var own = cur != null ? ReadVolumeOverride(cur) : null;
        if (cur != null && (settings.VolumeKeyTarget == "item" || (settings.VolumeKeyTarget != "global" && own != null)))
        {
            var (from, to) = LibraryService.StepVolumeOverride(cur, delta);
            if (to == from) return null;
            ApplyOverrideLive(cur);
            return cur;
        }
        // the step from what's saved, inside the settings lock: a value computed from the load above lost every
        // concurrent step but one (16 keybinds at once → +5; scripts/test-cross-process.sh)
        int prevVolume = 0;
        var saved = SettingsService.Update(s => { prevVolume = s.Volume; s.Volume = Math.Clamp(s.Volume + delta, 0, 100); });
        if (saved.Volume == prevVolume) return null;
        // liascape-player: the resolver — every live source its own effective volume (an overridden one keeps it)
        if (PlayerEngine.IsLiascapePlayer) LiascapePlayerMedia.ApplyEffective();
        else SetVolume(own ?? saved.Volume);
        return null;
    }

    // Returns the next wallpaper path, extending history if needed.
    // The item the next timed advance WOULD pick, without advancing (for the video→scene lead). Within
    // a cycle the order is fixed (shuffle reshuffles only at the cycle end), so the next is deterministic
    // except at the shuffle wrap → null there (no early lead, falls back to the boundary advance).
    private static string? PeekNextTimed()
    {
        if (_history != null && _historyIndex < _history.Count - 1) return _history[_historyIndex + 1];
        var p = _timedPaths;
        if (p == null || p.Count == 0) return null;
        int ni = _timedIndex + 1;
        if (ni < p.Count) return p[ni];
        return _timedShuffle ? null : p[0];
    }

    private static string? AdvanceToNext()
    {
        // forward through the history (a next after a previous) — under liascape-player past an item skipped
        // since it played (a scene marked crashed, D6); legacy unchanged
        while (_history != null && _historyIndex < _history.Count - 1)
        {
            _historyIndex++;
            if (!PlayerEngine.IsLiascapePlayer || !IsSkippedPath(_history[_historyIndex])) return _history[_historyIndex];
        }

        var p = _timedPaths;
        if (p == null) return null;

        for (int attempt = 0; attempt < p.Count; attempt++)
        {
            _timedIndex++;
            if (_timedIndex >= p.Count)
            {
                if (_timedShuffle)
                {
                    var last = p[p.Count - 1];
                    List<string> reshuffled;
                    do { reshuffled = p.OrderBy(_ => Guid.NewGuid()).ToList(); }
                    while (p.Count > 1 && reshuffled[0] == last);
                    _timedPaths = p = reshuffled;
                }
                _timedIndex = 0;
            }

            var path = p[_timedIndex];
            if (IsSkippedPath(path)) continue;

            if (_history != null)
            {
                _history.Add(path);
                if (_history.Count > 100) _history.RemoveAt(0);
                _historyIndex = _history.Count - 1;
            }
            return path;
        }

        return null;
    }

    private static Process? Launch(string mpvOptions, string file, TaskCompletionSource<bool>? readyTcs = null)
    {
        // liascape-player: a cold launch = a cut to `file` (whatever was on screen was just stopped)
        if (PlayerEngine.IsLiascapePlayer)
        {
            _lastSwitchTarget = file;
            LiascapePlayerMedia.QueueNewSession(); // I1: a cold launch is a new session — it plays
            LiascapePlayerMedia.QueueSwitch(file, SettingsService.Load(), tcfg: null, alignEnd: false);
            readyTcs?.TrySetResult(true);
            return null;
        }
        _lastSwitchTarget = file; // a cold launch makes `file` current too (see DoVideoEndWait's settle gate)
        var socketPath = IpcSocket;
        Directory.CreateDirectory(Path.GetDirectoryName(socketPath)!);
        if (File.Exists(socketPath)) File.Delete(socketPath);

        var options = $"{mpvOptions} --input-ipc-server={socketPath}";
        var psi = new ProcessStartInfo("setsid")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add("mpvpaper");
        psi.ArgumentList.Add("-o");
        psi.ArgumentList.Add(options);
        psi.ArgumentList.Add("*");
        psi.ArgumentList.Add(file);
        var process = Process.Start(psi);
        process?.BeginOutputReadLine();
        process?.BeginErrorReadLine();
        if (readyTcs != null)
        {
            Task.Run(async () =>
            {
                for (int i = 0; i < 40; i++)
                {
                    await Task.Delay(50).ConfigureAwait(false);
                    if (TryQueryTimeRemaining() != null)
                    {
                        readyTcs.TrySetResult(true);
                        return;
                    }
                }
            });
        }
        ReapExcessMpvpaper(2); // cap orphaned/excess mpvpaper (see method) → never OOM the GPU
        return process;
    }

    // Match processes by their FULL /proc/<pid>/cmdline (the untruncated argv[0] path) — NOT the
    // 15-char `comm`/ProcessName. Why: on NixOS the binary is wrapped (".mpvpaper-wrapped") so
    // GetProcessesByName("mpvpaper") returns EMPTY → every kill silently no-ops → mpvpaper piles up
    // → VRAM OOM → GPU crash storm (this was THE leak). cmdline carries the real "/usr/bin/mpvpaper"
    // regardless of wrapper/truncation, and matching the full unique name avoids the generic false
    // hits a short comm-substring would risk (e.g. "wallpaper" hitting unrelated apps).
    private static Process[] ProcsByCmdline(string needle)
    {
        var hits = new List<Process>();
        foreach (var p in Process.GetProcesses())
        {
            string cmd = "";
            try { cmd = File.ReadAllText($"/proc/{p.Id}/cmdline"); } catch { }
            if (cmd.Contains(needle)) hits.Add(p); else p.Dispose();
        }
        return hits.ToArray();
    }

    private static Process[] MpvpaperProcs() => ProcsByCmdline("mpvpaper");

    // Reap EVERY wallpaper-related process by cmdline scan — NOT just `_current` (which is null in a
    // daemon process that never spawned mpvpaper). mpvpaper is detached (setsid) so scanning /proc is
    // the only cross-process way to find it. Used by the shutdown reaper below.
    private static void ReapAllWallpaperProcs()
    {
        foreach (var needle in new[] { "mpvpaper", "liascape-transition", "liascape-audio" })
            foreach (var p in ProcsByCmdline(needle))
                using (p) { try { p.Kill(entireProcessTree: true); } catch { } }
    }

    // Graceful shutdown reaper for the long-lived daemons (--monitor/--timer-daemon/--restart-daemon).
    // Those receive SIGTERM ONLY on system shutdown / session-stop: GUI close kills just the --serve
    // backend (the wallpaper must SURVIVE that), and the app tears its OWN daemons down with
    // Process.Kill() = SIGKILL (no handler fires). So a SIGTERM/HUP reaching a daemon == the machine is
    // going down → reap the whole wallpaper tree, so detached mpvpaper doesn't linger, hold /home busy,
    // and stall shutdown ~90s (the recurring slow-shutdown bug).
    private static PosixSignalRegistration? _sigTerm, _sigInt, _sigHup;
    public static void InstallShutdownReaper()
    {
        void Reap(PosixSignalContext ctx) { ctx.Cancel = true; try { ReapAllWallpaperProcs(); } catch { } Environment.Exit(0); }
        _sigTerm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Reap);
        _sigInt = PosixSignalRegistration.Create(PosixSignal.SIGINT, Reap);
        _sigHup = PosixSignalRegistration.Create(PosixSignal.SIGHUP, Reap);
    }

    // Cap mpvpaper instances. mpvpaper has a frame-buffer VRAM leak and is spawned DETACHED
    // (setsid, above) so instances OUTLIVE the backend — orphans from a dead/reloaded/crashed
    // backend (or a transition reap-failure) accumulate → VRAM OOM → every GL/Vulkan app SIGSEGVs
    // (the crash storm: kitty/dms/noctalia/clipboard). Keep the `keep` NEWEST (a full-live
    // transition legitimately runs A+B = 2); kill the older excess. Runs at the single spawn
    // chokepoint (Launch) → self-heals on every switch/restart, bounding mpvpaper at ≤keep.
    private static void ReapExcessMpvpaper(int keep = 2)
    {
        try
        {
            var procs = MpvpaperProcs()
                .OrderByDescending(p => { try { return p.StartTime; } catch { return DateTime.MinValue; } })
                .ToList();
            for (int i = 0; i < procs.Count; i++)
                using (procs[i])
                    if (i >= keep) { try { procs[i].Kill(entireProcessTree: true); } catch { } }
        }
        catch { }
    }

    private static void KillCurrentProcess()
    {
        // liascape-player: `stop` (every source ramped out and retired), queued — callers hold _lock (Stop/KillAll);
        // the player process stays up
        if (PlayerEngine.IsLiascapePlayer) { StopPlaylistObserver(); LiascapePlayerMedia.QueueStop(); _current = null; return; }
        StopPlaylistObserver();
        foreach (var proc in MpvpaperProcs())
        {
            using (proc)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
            }
        }
        // Kill any running transition overlay — it's a separate process (liascape-transition) that decodes
        // A/B itself, so without this a Stop/Apply during a transition leaves the effect playing.
        // The video→video transition uses the IPC switch path (no KillCurrentProcess), so this never
        // kills an in-progress transition's own overlay — only Stop / Apply / cold-launch / scene do.
        foreach (var proc in Process.GetProcessesByName("liascape-transition"))
            using (proc) { try { proc.Kill(entireProcessTree: true); } catch { } }
        KillLweProcess();
        _current = null;
        var socketPath = IpcSocket;
        if (File.Exists(socketPath)) File.Delete(socketPath);
    }

    private static void KillLweProcess()
    {
        try
        {
            if (File.Exists(LwePidPath))
            {
                foreach (var line in File.ReadAllLines(LwePidPath))
                {
                    if (!int.TryParse(line.Trim(), out int pid)) continue;
                    try { using var p = Process.GetProcessById(pid); p.Kill(entireProcessTree: true); }
                    catch { }
                }
                File.Delete(LwePidPath);
            }
        }
        catch { }
        // Match the FULL cmdline "linux-wallpaperengine" (comm truncates to ".linux-wallpape" on
        // Nix → exact-match + any short "wallpaper" substring would miss or falsely hit). PID-file
        // path above is primary; this catches orphans precisely.
        foreach (var proc in ProcsByCmdline("linux-wallpaperengine"))
            try { proc.Kill(entireProcessTree: true); } catch { }
    }

    private static void ClearTimedStateFile()
    {
        try { File.Delete(TimedStatePath); } catch { }
    }

    private static void ClearPlaylistObserverPaths()
    {
        try { File.Delete(PlaylistObserverPathsPath); } catch { }
    }

    private static void SignalTimerStop()
    {
        lock (_lock)
        {
            try
            {
                if (!File.Exists(TimedStatePath)) return;
                var state = JsonSerializer.Deserialize<TimedState>(File.ReadAllText(TimedStatePath));
                if (state == null) return;
                var updated = state with { TimerStopped = true };
                var tmp = TimedStatePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(updated));
                File.Move(tmp, TimedStatePath, overwrite: true);
            }
            catch { }
        }
    }

    // State-only teardown (timer state, history, pending action). Does NOT
    // touch mpvpaper — callers that want to start a new session can
    // IPC-switch the existing mpvpaper instead of killing it.
    private static void TeardownTimer()
    {
        _waitCts?.Cancel();
        _waitCts = null;
        _waitingForVideoEnd = false;
        _advanceOnVideoEnd = false;
        _prelaunchCts?.Cancel();
        _prelaunchCts = null;
        if (_prelaunchPidsToKill != null) { KillPids(_prelaunchPidsToKill); _prelaunchPidsToKill = null; }
        _playlistTimer?.Dispose();
        _playlistTimer = null;
        StopRestartTimer();
        _restartPending = false; // don't carry a deferred restart into the next session
        _timedPaths = null;
        _history = null;
        _historyIndex = -1;
        _timedTimerPaused = false;
        _timedTimerStopped = false;
        _timedRemainingMs = 0;
        ConsumePendingAction();
    }

    private static void KillAll()
    {
        TeardownTimer();
        KillCurrentProcess();
    }

    public static bool IsLweAvailable()
    {
        try
        {
            var psi = new ProcessStartInfo("which")
            {
                Arguments = "linux-wallpaperengine",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            proc?.WaitForExit();
            return proc?.ExitCode == 0;
        }
        catch { return false; }
    }

    // A scene's library path is its item FOLDER (workshop/<id> or local/<id> — a numeric-id dir, no
    // file extension); a video/image path always ends in a media extension. So "no extension" ⟺ scene.
    public static bool IsScenePath(string path) =>
        !string.IsNullOrEmpty(path) && Path.GetExtension(path).Length == 0;

    // Is this item skipped by the pickers (next/prev/random, a rotation's advance)? A scene when scenes
    // can't play, or (D6, Phase 2) when it is marked crashed and not whitelisted — what the item settings
    // modal promises ("Scene crashed — won't be played"). Pure — the self-test's truth table. Marking
    // happens only under liascape-player (OnSceneBroken), so it is inert for legacy unless liascape-player marked one.
    public static bool SkipScene(bool isScene, bool playable, bool crashed, bool whitelisted) =>
        isScene && (!playable || (crashed && !whitelisted));

    private static bool IsSkippedPath(string path)
    {
        if (!IsScenePath(path)) return false;
        return IsSkippedPath(path, PlayerEngine.ScenesPlayable(SettingsService.Load()));
    }

    // a scene is what plays now: legacy = an LWE process runs; liascape-player = the session's playing item is a
    // scene folder (no LWE process exists there — every `IsLweRunning` check is legacy-only)
    private static bool ScenePlaying => PlayerEngine.IsLiascapePlayer
        ? _history != null && PlayingHistoryIndex >= 0 && PlayingHistoryIndex < _history.Count && IsScenePath(_history[PlayingHistoryIndex])
        : IsLweRunning;

    // liascape-player Phase 2: `source.broken` (a scene's worker crashed past its restart budget, 3 in 60 s) →
    // marked crashed in its index entry (skipped from now on unless whitelisted, D6), the UI told
    // (WS `scene-crashed`), and — the owner's call — a rotation PLAYING it advances at once (the tick's
    // own advance: its owner check, pause and mode rules apply). A single wallpaper keeps what the player
    // shows (its last frame or preview, silent). A broken PENDING B is the switch's own failure
    // (`transition.failed` → DoVideoEndWait's fallback, which skips an item marked meanwhile).
    public static void OnSceneBroken(string path)
    {
        if (string.IsNullOrEmpty(path) || !IsScenePath(path)) return;
        LibraryService.MarkCrashed(path);
        OnSceneCrashed?.Invoke(path);
        AdvanceIfPlaying(path, "scene broken while playing");
    }

    // liascape-player Task 8: `scene.vram_exceeded` — the player's VRAM guard stopped this scene's worker (it used more
    // than `player.scene_vram_limit_mib`). For playback exactly like a broken scene — a rotation playing it
    // advances at once, a single wallpaper keeps what the player shows (its last frame) — but it is NOT marked
    // crashed (it isn't broken; with a higher limit or less on the GPU it plays): the UI is told why instead
    // (WS `scene-vram-stopped {path, usedMib, limitMib, message}`).
    public static string VramStoppedMessage(double usedMib, double limitMib) =>
        $"stopped: used {usedMib:0} MiB > limit {limitMib:0} MiB of VRAM";

    public static void OnSceneVramStopped(string path, double usedMib, double limitMib)
    {
        if (string.IsNullOrEmpty(path) || !IsScenePath(path)) return;
        OnSceneVramStoppedCb?.Invoke(path, usedMib, limitMib, VramStoppedMessage(usedMib, limitMib));
        AdvanceIfPlaying(path, $"scene over the VRAM limit ({usedMib:0} > {limitMib:0} MiB)");
    }

    // the playing item of a running timed playlist is `path` → advance now (the tick's own advance: its owner,
    // pause and mode rules apply); anything else (a single wallpaper, a pending B, another item) → nothing
    private static void AdvanceIfPlaying(string path, string why)
    {
        lock (_lock)
        {
            if (_timedPaths == null || _timedTimerStopped || _timerReleased || _history == null || _waitingForVideoEnd) return;
            int i = PlayingHistoryIndex;
            if (i < 0 || i >= _history.Count || !SamePath(_history[i], path)) return;
            TransitionService.TransLog($"{why}: {System.IO.Path.GetFileName(path)} → advance");
            if (!_advanceOnVideoEnd && _timedInterval > TimeSpan.Zero)
            {
                _timedRemainingMs = 0;
                _playlistTimer?.Change(TimeSpan.Zero, Timeout.InfiniteTimeSpan); // the tick advances now
            }
            else AdvanceAndLaunch(); // no countdown to expire (an advance-on-end session)
        }
    }

    private static bool SamePath(string a, string b)
    {
        try { return Path.GetFullPath(a).TrimEnd('/') == Path.GetFullPath(b).TrimEnd('/'); } catch { return a == b; }
    }

    private static string NoPlayableMessage() => PlayerEngine.IsLiascapePlayer
        ? "No playable wallpaper in the library — every item is a scene that can't play: scenes need \"Allow scene support\" + Wallpaper Engine's assets (liascape-player), and a crashed scene plays only when whitelisted"
        : "No playable wallpaper in the library — every item is a scene, and scenes need \"Allow scene support\" + linux-wallpaperengine";

    // Same rule for a whole-library scan: resolve ScenesPlayable once (a settings load + a `which` / the
    // player's capability) instead of once per scene item; the crash mark is one index read per scene.
    private static bool IsSkippedPath(string path, bool scenesPlayable)
    {
        if (!IsScenePath(path)) return false;
        if (!scenesPlayable) return true;
        var m = LibraryStore.GetMeta(path);
        return SkipScene(true, true, m?.Crashed ?? false, m?.Whitelist ?? false);
    }

    // Spawns one linux-wallpaperengine process per monitor, writes new PIDs to
    // LwePidPath, and returns the new PID strings. Does NOT kill any existing
    // LWE processes — callers are responsible for killing old ones.
    // audioVolumePercent: the LWE --volume to launch at. A scene-transition launch passes 0 so LWE
    // starts SILENT (no blast before the crossfade's pactl ramp can clamp the sink-input — LWE plays
    // at its launch volume the instant its stream appears, ~0.5s before pactl can list/control it).
    // Per-output cache path for LWE's own --screenshot dump (the scene's framebuffer, written at
    // launch). The transition uses it for scene-A instead of grim → no compositor windows in the cover.
    internal static string SceneShotPath(string output) => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_CACHE_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"),
        "liascape", $"liascape-scene-{output.Replace('/', '_').Replace(' ', '_')}.png");

    private static string[] SpawnLweProcesses(string workshopId, AppSettings settings, int audioVolumePercent = 100, string? scenePath = null)
    {
        var pids = new List<string>();
        bool anyPrimary = settings.LweMonitors.Any(m => m.IsPrimary);
        // the item's scene-property overrides (launch-only under legacy: LWE has no live property IPC)
        var propArgs = scenePath == null ? [] : SceneProperties.CliArgs(scenePath, LibraryService.ReadSceneProps(scenePath));

        foreach (var monitor in settings.LweMonitors)
        {
            if (string.IsNullOrWhiteSpace(monitor.Name)) continue;
            var psi = new ProcessStartInfo("setsid")
            {
                UseShellExecute = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
            };
            psi.ArgumentList.Add("linux-wallpaperengine");
            psi.ArgumentList.Add("--noautomute");
            psi.ArgumentList.Add("--screen-root");
            psi.ArgumentList.Add(monitor.Name);

            bool hasAudio = !anyPrimary || monitor.IsPrimary;
            if (!hasAudio)
                psi.ArgumentList.Add("--silent"); // secondary monitors never carry scene audio (launch-only)
            else
            {
                // Always OPEN the audio device on the primary — even when NoAudio — so NoAudio toggles
                // LIVE (--silent would give no sink-input to unmute → a relaunch). NoAudio → launch at
                // volume 0 (silent from frame 0, no liascape-audio/pactl dependency); ApplyLweVolume brings it
                // back with no relaunch.
                psi.ArgumentList.Add("--volume");
                psi.ArgumentList.Add((settings.NoAudio ? 0 : audioVolumePercent).ToString());
            }

            if (monitor.Fps > 0)
            {
                psi.ArgumentList.Add("--fps");
                psi.ArgumentList.Add(monitor.Fps.ToString());
            }
            psi.ArgumentList.Add("--no-fullscreen-pause");
            // match the video VideoScale so scenes frame like videos (fill = cover, fit = letterbox)
            psi.ArgumentList.Add("--scaling");
            psi.ArgumentList.Add((settings.VideoScale ?? "fill").Equals("fit", StringComparison.OrdinalIgnoreCase) ? "fit" : "fill");
            // self-dump a windowless frame (~0.5s after start) → the transition's scene-A cover uses it
            // instead of grim (which composites whatever windows are open over the wallpaper).
            try { Directory.CreateDirectory(Path.GetDirectoryName(SceneShotPath(monitor.Name))!); } catch { }
            psi.ArgumentList.Add("--screenshot");
            psi.ArgumentList.Add(SceneShotPath(monitor.Name));
            psi.ArgumentList.Add("--screenshot-delay");
            psi.ArgumentList.Add("30");
            foreach (var a in propArgs) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add(workshopId);

            var proc = Process.Start(psi);
            if (proc != null)
            {
                pids.Add(proc.Id.ToString());
            }
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LwePidPath)!);
            File.WriteAllLines(LwePidPath, pids);
        }
        catch { }
        return [.. pids];
    }

    // ffprobe a video's duration (seconds), 0 on failure — wraps the reveal-a pre-buffer seek for loops.
    private static double ProbeDurationSec(string path)
    {
        try
        {
            var psi = new ProcessStartInfo("ffprobe")
            {
                ArgumentList = { "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path },
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            using var p = Process.Start(psi)!;
            var o = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(2000);
            return double.TryParse(o, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : 0;
        }
        catch { return 0; }
    }

    private static int LaunchScene(string workshopId, AppSettings settings)
    {
        KillLweProcess();
        var before = GetLweProcPids();
        int n = SpawnLweProcesses(workshopId, settings).Length;
        // direct (non-transition) scene launch — hold the new scene at its target (muted when NoAudio /
        // user / auto mute) via liascape-audio, countering the stream-restore poison. NoAudio → target 0 (the
        // device is open, just silent) so NoAudio can be toggled back on LIVE.
        CorrectSceneVolume(before, settings.NoAudio ? 0 : settings.Volume,
            settings.NoAudio || _isMuted || AudioMonitor.IsMuted, 3000);
        return n;
    }

    private static string[] ReadCurrentLwePids()
    {
        try { return File.Exists(LwePidPath) ? File.ReadAllLines(LwePidPath) : []; }
        catch { return []; }
    }

    private static void KillPids(string[] pids)
    {
        foreach (var pidStr in pids)
        {
            if (!int.TryParse(pidStr.Trim(), out int pid)) continue;
            try { using var p = Process.GetProcessById(pid); p.Kill(entireProcessTree: true); } catch { }
        }
    }

    // Kills only mpvpaper processes without touching LWE — used in pre-launch
    // transitions where LWE is being kept alive until the new process is ready.
    private static void KillMpvPaperOnly()
    {
        foreach (var proc in MpvpaperProcs())
            using (proc) { try { proc.Kill(entireProcessTree: true); } catch { } }
        _current = null;
        var socketPath = IpcSocket;
        try { if (File.Exists(socketPath)) File.Delete(socketPath); } catch { }
    }

    internal static HashSet<string> GetLweClientObjectIds()
    {
        var psi = new ProcessStartInfo("pactl")
        {
            Arguments = "list clients",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var proc = Process.Start(psi)!;
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();

        var ids = new HashSet<string>();
        foreach (var block in output.Split("Client #", StringSplitOptions.RemoveEmptyEntries))
        {
            if (!block.Contains("application.process.binary = \"linux-wallpaperengine\"")) continue;
            foreach (var line in block.Split('\n'))
            {
                var t = line.Trim();
                if (t.StartsWith("object.id = \""))
                {
                    ids.Add(t.Substring("object.id = \"".Length).TrimEnd('"'));
                    break;
                }
            }
        }
        return ids;
    }

    // Live LWE process PIDs straight from the process table (pgrep). Unlike the client→pid map this
    // never transiently misses a process whose PA client is mid-(re)registration, so it's the reliable
    // basis for the old-vs-new scene split in the crossfade (the client map can briefly drop a client).
    private static HashSet<int> GetLweProcPids()
    {
        var set = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo("pgrep")
            {
                ArgumentList = { "-f", "linux-wallpaperengine" },
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            using var proc = Process.Start(psi)!;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                if (int.TryParse(line.Trim(), out int p)) set.Add(p);
        }
        catch { }
        return set;
    }

    private static List<int> GetLweSinkInputIds()
    {
        try
        {
            var lweClientIds = GetLweClientObjectIds();
            if (lweClientIds.Count == 0) return new List<int>();

            var psi = new ProcessStartInfo("pactl")
            {
                Arguments = "list sink-inputs",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi)!;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();

            var ids = new List<int>();
            foreach (var block in output.Split("Sink Input #", StringSplitOptions.RemoveEmptyEntries))
            {
                string? clientId = null;
                bool isBuffer = false;
                foreach (var line in block.Split('\n'))
                {
                    var t = line.Trim();
                    if (t.StartsWith("client.id = \""))
                        clientId = t.Substring("client.id = \"".Length).TrimEnd('"');
                    else if (t.StartsWith("media.name = \"") && t.Contains("buffer://"))
                        isBuffer = true;
                }
                if (clientId == null || !lweClientIds.Contains(clientId) || isBuffer) continue;
                var firstLine = block.Split('\n')[0].Trim();
                if (int.TryParse(firstLine, out int id))
                    ids.Add(id);
            }
            return ids;
        }
        catch { return new List<int>(); }
    }

    private static void ApplyLweVolume(int volume)
    {
        foreach (var id in GetLweSinkInputIds())
            RunPactl($"set-sink-input-volume {id} {volume}%");
    }

    private static void ApplyLweMute(bool mute)
    {
        foreach (var id in GetLweSinkInputIds())
            RunPactl($"set-sink-input-mute {id} {(mute ? 1 : 0)}");
    }

    private static void RunPactl(string args)
    {
        try
        {
            var psi = new ProcessStartInfo("pactl")
            {
                Arguments = args,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            proc?.WaitForExit();
        }
        catch { }
    }

    // Per-item overrides live in the source index (LibraryStore). Delegate to LibraryService so EVERY
    // playback path (initial launch, playlist advance, transitions, scene launch, option baking) reads the
    // same source of truth the UI/endpoints write.
    private static int? ReadVolumeOverride(string path) => LibraryService.ReadVolumeOverride(path);

    private static double? ReadSpeedOverride(string path) => LibraryService.ReadSpeedOverride(path);

    private static string BakeVolumeOverride(string options, string path)
    {
        var vol = ReadVolumeOverride(path);
        if (!vol.HasValue) return options;
        if (options.Contains("--no-audio")) return options;
        const string prefix = "--volume=";
        int idx = options.IndexOf(prefix, StringComparison.Ordinal);
        if (idx >= 0)
        {
            int end = idx + prefix.Length;
            while (end < options.Length && char.IsDigit(options[end])) end++;
            return options[..idx] + prefix + vol.Value + options[end..];
        }
        return options + $" {prefix}{vol.Value}";
    }

    private static string BakeSpeedOverride(string options, string path)
    {
        var speed = ReadSpeedOverride(path);
        if (!speed.HasValue) return options;
        string val = speed.Value.ToString("G", System.Globalization.CultureInfo.InvariantCulture);
        const string prefix = "--speed=";
        int idx = options.IndexOf(prefix, StringComparison.Ordinal);
        if (idx >= 0)
        {
            int end = idx + prefix.Length;
            while (end < options.Length && (char.IsDigit(options[end]) || options[end] == '.')) end++;
            return options[..idx] + prefix + val + options[end..];
        }
        return options + $" {prefix}{val}";
    }

    // The loudnorm audio filter for an item's between-video normalization, or null when it shouldn't
    // apply (normalization off / muted / scene / not yet measured). When enabled but unmeasured, kicks
    // off a background measure so it's ready next time (never blocks the switch). Applied as an mpv `af`,
    // so the per-item/global `volume` (which mpv applies AFTER the filter chain) stacks on top.
    private static string? NormalizeAf(string path)
    {
        var s = SettingsService.Load();
        if (!s.NormalizeAudio || s.NoAudio || IsScenePath(path)) return null;
        var af = LibraryService.LoudnormAf(path, s.NormalizeTargetLufs);
        if (af == null) { _ = LibraryService.EnsureLoudnessAsync(path); return null; } // measure for next time
        return af;
    }

    // Append the normalization filter to a launch options string (mpvpaper -o "…"). last --af wins.
    private static string BakeNormalization(string options, string path)
    {
        var af = NormalizeAf(path);
        return af == null ? options : options + $" --af={af}";
    }

    // Live-apply normalization to the currently-playing video (toggle/retune takes effect without a
    // switch). null/scene/no-socket → no-op. Unmeasured → clears the filter + kicks a background measure.
    public static void ApplyNormalizationLive(string? path)
    {
        // liascape-player: the resolver — EVERY live source its own item's af: the playing one, an effect's outgoing
        // A, a pending B, any source while no output shows one (`path` = cur:* reached only the first)
        if (PlayerEngine.IsLiascapePlayer) { LiascapePlayerMedia.ApplyEffective(); return; }
        if (path == null || IsScenePath(path) || !File.Exists(IpcSocket)) return;
        TrySendCommand("set", "af", NormalizeAf(path) ?? "");
    }

    // A background loudness measurement just landed (LibraryService.EnsureLoudnessAsync — or, for a scene under
    // liascape-player, the player's own `scene.loudness` learned on first play): with normalization on, the item may be
    // playing right now — unmeasured when it started (or when normalization was switched on), so it ran without
    // the filter / `gain.normalize` and nothing applied it once measured (until its next switch).
    public static void OnLoudnessMeasured(string path)
    {
        try
        {
            if (!SettingsService.Load().NormalizeAudio) return;
            // liascape-player: every live source its own item's value — a scene's `gain.normalize` ramps to it
            if (PlayerEngine.IsLiascapePlayer) { LiascapePlayerMedia.ApplyEffective(); return; }
            if (IsScenePath(path)) return; // legacy: LWE scenes aren't normalized (player-adapter.md § Scenes)
            var cur = QueryCurrentPath();
            if (cur != null && Path.GetFullPath(cur) == Path.GetFullPath(path)) ApplyNormalizationLive(cur);
        }
        catch { }
    }
}
