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
    private static readonly object _lock = new();
    private static CancellationTokenSource? _prelaunchCts;
    private static string[]? _prelaunchPidsToKill;
    private static bool _isMuted;
    private static bool _autoMuted;
    private static bool _userMuted;

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

    public static bool IsUserMuted => _userMuted;
    public static bool IsMuted => _isMuted;

    // a rotation session is the player's program (`prog:main`)
    public static bool IsTimedPlaylistActive() => LiascapePlayerProgram.IsActive;

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
    // scene launch (first playlist item / restore / random) — which has no crossfade to set the right
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

    private static string TimerDaemonPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "timer.pid");

    private static string RestartDaemonPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "restart.pid");

    private static string LwePidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "lwe.pid");

    private static string UserMuteStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "user_mute.state");

    // A timer-daemon / restart-daemon / monitor-daemon left by a legacy session (the engine switched since, an older
    // build) — stopped at `serve` start, by `restore` and by `stop`/`kill` under liascape-player (the player's program
    // rotates by itself, its Signal auto-mutes). Verified by its command line (a pid file outlives
    // a reboot: its number may belong to anything by now); its pid file goes with it.
    public static void KillLegacyDaemons()
    {
        foreach (var (pidFile, verb) in new[] { (TimerDaemonPidPath, "timer-daemon"), (RestartDaemonPidPath, "restart-daemon"), (AudioMonitor.MonitorPidPath, "monitor-daemon") })
        {
            try
            {
                if (!File.Exists(pidFile)) continue;
                if (int.TryParse(File.ReadAllText(pidFile).Trim(), out int pid) && pid != Environment.ProcessId)
                {
                    string[] argv = [];
                    try { argv = File.ReadAllText($"/proc/{pid}/cmdline").Split('\0'); } catch { }
                    if (argv.Contains(verb) && argv.Any(a => a.Contains("liascape")))
                        try
                        {
                            using var p = Process.GetProcessById(pid);
                            p.Kill(entireProcessTree: true);
                            LiascapePlayerClient.Log($"stopped a leftover {verb} (pid {pid}) — {(verb == "monitor-daemon" ? "the player's Signal auto-mutes" : "the player's program rotates by itself")}");
                        }
                        catch { }
                }
                File.Delete(pidFile);
            }
            catch { }
        }
    }

    // Build the argv prefix needed to re-invoke this same liascape process
    // (without args).
    //   - Self-contained (AppImage, install.sh): the apphost binary and
    //     entry assembly share a name (liascape-backend / liascape-backend.dll). The
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
        // named after the assembly (liascape-backend ↔ liascape-backend.dll), so the names
        // match and we don't need a separate dll arg. Framework-dependent
        // builds run under `dotnet` whose name differs.
        var procStem = Path.GetFileNameWithoutExtension(processPath);
        var asmStem = Path.GetFileNameWithoutExtension(entryAsm);
        if (!string.Equals(procStem, asmStem, StringComparison.OrdinalIgnoreCase))
            args.Add(entryAsm);

        return args;
    }

    public static Action<string>? OnSceneCrashed;
    // liascape-player: the VRAM guard stopped a scene (path, used MiB, limit MiB, the UI's text)
    public static Action<string, double, double, string>? OnSceneVramStoppedCb;
    // liascape-player: why no scene can play here (ScenesBlockedReason), or null once they can again
    public static Action<string?>? OnScenesBlockedCb;
    // liascape-player: the low-VRAM hold's message (VramHoldMessage) while it holds, null once it let go
    public static Action<string?>? OnVramHoldCb;
    public static Action<string?>? OnWallpaperChanged;

    public static void LoadUserMuteState()
    {
        try { _userMuted = File.Exists(UserMuteStatePath); _isMuted = _userMuted || _autoMuted; }
        catch { }
    }

    public static void Apply(string videoPath, string mpvOptions)
    {
        // a preset that can't play: its reason, never its plain base scene
        if (PresetUnplayableReason(videoPath) is string presetWhy) throw new InvalidOperationException(presetWhy);
        // no player binary: the reason, never a queued switch that can't start (a silent black screen)
        if (PlayerEngine.MissingReason() is string missing) throw new InvalidOperationException(missing);
        // scenes play when they're on and the player can (its worker + WE's assets) — else the reason. A crashed one
        // plays too: the user picked it, and a repeat crash only leaves its last frame up (OnSceneBroken); the crash
        // mark keeps it out of rotations (SkipScene). Guard: matrix crash:scene (the click after the mark)
        if (IsScenePath(videoPath) && PlayerEngine.SceneUnavailableReason(SettingsService.Load()) is string why)
            throw new InvalidOperationException(why);
        lock (_lock)
        {
            // a single wallpaper replaces a rotation: `destroy prog:main` queued before the switch
            LiascapePlayerProgram.End();
            // I1: a new session plays — unless it's a user next/prev/random keeping the pause
            if (!_keepPauseNextSwitch) LiascapePlayerMedia.QueueNewSession();
            SwitchToFile(videoPath, mpvOptions);
        }
    }

    // A playlist's effective rotation: its own when it overrides the global one, else the globals'. The maximum comes
    // normalized (never under the minimum) whatever the copy: a /playlist/play body or a hand-edited file reaches the
    // rotation the way a save would have stored it.
    public static (int Interval, bool Advance, int Max, bool SeparateScenes, int ScenesAfter) EffectiveRotation(AppSettings s, PlaylistSettings? p) =>
        p?.OverrideGlobalSettings == true
            ? (p.IntervalSeconds, p.SwitchWhenVideoEnds, AppSettings.RotationMax(p.SwitchWhenVideoEnds, p.IntervalSeconds, p.MaxPlaySeconds),
               p.SeparateSceneTiming, p.SwitchScenesAfterSeconds)
            : (s.GlobalIntervalSeconds, s.GlobalSwitchWhenVideoEnds, AppSettings.RotationMax(s.GlobalSwitchWhenVideoEnds, s.GlobalIntervalSeconds, s.GlobalMaxPlaySeconds),
               s.GlobalSeparateSceneTiming, s.GlobalSwitchScenesAfterSeconds);

    // A playlist's "When the playlist starts again" (§ Playlist start): its own under its override, else the global one.
    public static string EffectiveStart(AppSettings s, PlaylistSettings? p) =>
        p?.OverrideGlobalSettings == true ? p.PlaylistStart : s.GlobalPlaylistStart;

    // /settings (the global one) and /playlist/state (a playlist's own): the effective maximum or scene timing changed
    // — the program's limits, live (the player reads them at its next tick; the item's play time keeps counting)
    public static void ApplyPlayLimitsLive(int maxSeconds, bool separateScenes, int scenesAfterSeconds)
    {
        if (LiascapePlayerProgram.IsActive) LiascapePlayerProgram.SetLimits(maxSeconds, separateScenes, scenesAfterSeconds);
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
        // no pre-launch crossover, no overlay, no IPC loadfile — for a scene too (`kind: scene`,
        // kind-agnostic in the player; no V→S lead, no SceneTransitionDelayMs). A scene that can't play
        // stops playback here, exactly like legacy with AllowScenes=false (the pickers never hand one over).
        bool keepPause = _keepPauseNextSwitch; // a user switch staying paused (StayPausedWhenSwitching): legacy cuts
        _keepPauseNextSwitch = false;
        if (PlayerEngine.IsLiascapePlayer)
        {
            if (IsScenePath(path) && !PlayerEngine.ScenesPlayable(SettingsService.Load())) { KillCurrentProcess(); return; }
            var liascapeSettings = SettingsService.Load();
            var liascapeCfg = TransitionService.CurrentConfig();
            // with its transition even while paused: the player plays it on the still frames and keeps the pause
            LiascapePlayerMedia.QueueSwitch(path, liascapeSettings, liascapeCfg.Enabled ? liascapeCfg : null, alignEnd: false); // queued: we may hold _lock
            OnWallpaperChanged?.Invoke(path);
            return;
        }

        int shownGen = Interlocked.Increment(ref _shownGen); // a launch still waiting for its IPC no longer announces
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
                    TransitionService.TransLog("transition SKIPPED: a switch while paused keeps the pause (StayPausedWhenSwitching) → instant cut, B paused");
                else if (!IsPlaying || !mpvAliveForTransition)
                    TransitionService.TransLog($"transition SKIPPED (V→V gate): playing={IsPlaying} mpvAlive={mpvAliveForTransition} → instant cut");
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
                // launched from a path — SpawnLweProcesses' last arg accepts id OR dir). A `local/<id>` that is no longer a
                // link is the library's own copy (LibraryService.KeepOwnCopy): Steam's folder may be gone, so its path.
                var loc = LibraryStore.Locate(path);
                string lweArg = loc?.Source == LibraryStore.Local && LibraryService.IsSymlink(path) ? loc.Value.Key : path;

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
                    _current = Launch(lo, path, rt, shownGen);
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
        if (mpvAlive && TryIpcSwitchToFile(path, effVol, effSpd, pauseAtStart: transitionPauseB))
        {
            OnWallpaperChanged?.Invoke(path);
            if (_isMuted) Task.Run(() => SendCommand("set_property", "mute", true));
        }
        else
        {
            KillCurrentProcess();
            var opts = BakeNormalization(BakeSpeedOverride(BakeVolumeOverride(mpvOptions, path), path), path);
            if (_isMuted && !opts.Contains("--no-audio")) opts += " --mute=yes";
            _current = Launch(opts, path);
            OnWallpaperChanged?.Invoke(path);
        }
        OnWallpaperChanged?.Invoke(path);
    }

    private static bool TryIpcSwitchToFile(string path, int volume, double speed, bool pauseAtStart = false)
    {
        // a lone video always loops (docs/decisions.md § "A lone video always loops"). Other launch-only options (hwdec,
        // cache, demuxer) can't be toggled mid-session and only take effect on the next cold start.
        bool loopFile = true;
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

    public static string? QueryCurrentPath() => TryQueryCurrentPath();

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

    // The transition (effect / duration / on-off / method) changed while the program's switch is armed for A's end:
    // the program's `transition`, with which the player re-arms that switch to the same B — the next switch must use
    // what the user just set.
    public static void RearmAlignedSwitch()
    {
        if (LiascapePlayerProgram.IsActive) LiascapePlayerProgram.SetTransition();
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

    // ── Pause × a user switch (next / previous / random: keybind, CLI, /next /prev /random) ──────
    // StayPausedWhenSwitching off (default): a switch made while paused resumes playback first, so it
    // switches with its transition and plays — single and playlist alike. On: the pause stays and the rotation's
    // countdown with it; the player plays the transition on the still frames (A's paused frame → B's first) and
    // leaves B paused on its first frame (`Transitions::plays_on_still_frames`). A rotation never switches while paused.
    private static bool _keepPauseNextSwitch; // consumed by the next SwitchToFile (and Apply)

    public static bool IsPausedNow() =>
        PlayerEngine.IsLiascapePlayer ? LiascapePlayerMedia.IsPlayerPaused() : QueryMpvData("pause") is { ValueKind: JsonValueKind.True };

    // Before a user switch: resume (default) — or leave the pause for the switch to keep (true)
    private static bool BeforeUserSwitch()
    {
        if (!IsPausedNow()) return false;
        if (SettingsService.Load().StayPausedWhenSwitching) return true;
        if (PlayerEngine.IsLiascapePlayer) LiascapePlayerMedia.QueueNewSession(); // `set player.paused false`, queued ahead of the switch
        else TrySendCommand("set_property", "pause", false);
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
        if (IsTimedPlaylistActive()) { LiascapePlayerProgram.Next(); return; }
        // Single-wallpaper sessions (single, random) — step the library.
        // mpv-native playlist mode falls through to playlist-next.
        UserSwitch(keep, () => { if (!TryStepLibrary(forward: true)) SendCommand("playlist-next"); });
    }

    public static void PreviousWallpaper()
    {
        // previous at the rotation's first item does nothing — and leaves a user pause alone (matrix
        // `programHeld × prog:previous`; BeforeUserSwitch below would resume for a switch that cannot happen)
        if (IsTimedPlaylistActive() && LiascapePlayerProgram.PrevIsNoOp()) return;
        bool keep = BeforeUserSwitch();
        if (IsTimedPlaylistActive()) { LiascapePlayerProgram.Prev(); return; }
        UserSwitch(keep, () => { if (!TryStepLibrary(forward: false)) SendCommand("playlist-prev"); });
    }

    // For single-wallpaper sessions (no playlist context), `next`/`prev`
    // steps through the library alphabetically. Wraps at the ends. Returns
    // false for mpv-native playlist sessions so the caller can fall through
    // to mpv's own `playlist-next`/`playlist-prev`.
    //
    // Skips unplayable items (IsSkippedPath — scenes when !ScenesPlayable, the contract every
    // picker applies) by stepping further in the same direction, bounded to one full pass of
    // the library so an all-unplayable library can't spin forever. Throws InvalidOperationException (never calls Apply on an
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

    // Live-apply a rotation change (interval — the minimum under advance-on-end — / advance-on-end) to the running
    // program with no replay (the player retimes the countdown, the item's play time keeps counting). Wired from
    // /settings (global rotation, when the session follows globals) + /playlist/state (per-playlist rotation, when it overrides).
    public static void ApplyRotationLive(int intervalSeconds, bool switchWhenVideoEnds)
    {
        if (LiascapePlayerProgram.IsActive) LiascapePlayerProgram.SetRotation(intervalSeconds, switchWhenVideoEnds);
    }

    public static void Stop()
    {
        LiascapePlayerProgram.Forget(); // `stop` destroys the player's programs itself
        lock (_lock) KillCurrentProcess();
        KillLegacyDaemons(); // only a legacy leftover can run (verified by command line)
        // any in-flight transition died with its players — a stale InProgress marker would delay the
        // NEXT session's first video-end sample (late transition on a short first clip)
        TransitionService.ClearInProgress();
    }

    // `liascape restore` (boot / autostart), the `play` key, `toggle-play` from stopped. A player that isn't running is
    // started with its snapshot as a SESSION START (`serve --restore --session-start`): the player brings back what it
    // showed, and each restored program starts per its "When the playlist starts again" by itself (plan § Playlist
    // start: start over → item 1 / a fresh shuffle, the old item never shown; resume → the exact item and position).
    // Whatever the player then shows — a wallpaper (on screen, coming or parked) or a program — IS the session: done
    // (`play` while something plays does nothing). Nothing (first boot, after `stop`, no snapshot) → LastSession
    // replayed: a playlist as the program (`from` = its effective start mode — a Resume finds its point in the player's
    // resume.json), a single wallpaper applied. A legacy daemon left over is stopped.
    public static void Restore()
    {
        var settings = SettingsService.Load();
        // auto-mute: no monitor-daemon — the player's Signal gets the settings once it answers (AfterRestore)
        KillLegacyDaemons();
        ReapAllWallpaperProcs(); // a legacy wallpaper still up would stay on screen beside the player
        if (!LiascapePlayerClient.Shared.EnsureRunning(restore: true, sessionStart: true))
            throw new InvalidOperationException($"liascape-player could not start: {LiascapePlayerClient.Shared.LastError ?? "unknown reason"}");
        AudioMonitor.AfterRestore(settings);
        if (LiascapePlayerProgram.IsActive)
        {
            LiascapePlayerClient.Log($"restore: the player's rotation plays ({Path.GetFileName(LiascapePlayerProgram.CurrentPath ?? "")}) — nothing to replay");
            return;
        }
        switch (LiascapePlayerMedia.ShowsAnything())
        {
            case true:
                LiascapePlayerClient.Log("restore: the player shows its restored wallpaper — nothing to replay");
                return;
            case null:
                LiascapePlayerClient.Log("restore: the player didn't answer what it shows — not replaying over it");
                return;
        }
        var session = settings.LastSession;
        if (session == null || session.Paths.Count == 0) { LiascapePlayerClient.Log("restore: nothing shown, no last session to replay"); return; }
        LiascapePlayerClient.Log($"restore: nothing shown — replaying the last session ({session.Paths.Count} item(s))");
        bool playlist = session.IsTimedPlaylist || session.IsPlaylist;
        if (!playlist || (session.IsPlaylist && session.Paths.Count == 1 && !IsScenePath(session.Paths[0])))
        {
            Apply(session.Paths[0], settings.BuildMpvOptions());
            return;
        }
        var ps = PlaylistService.LoadCurrentState()?.Settings;
        var task = LoadProgram(session.Paths, settings, ps, session.Shuffle, session.TimedIntervalSeconds,
            session.IsTimedPlaylist ? session.SwitchWhenVideoEnds : true, from: null);
        try { task?.Wait(15_000); } catch { } // `liascape restore` exits right after
    }

    // Pick a random video and apply it as a single wallpaper. A running rotation picks its own (`program.random`);
    // otherwise a one-shot from the full library.
    //
    // Excludes unplayable items (IsSkippedPath — same contract as TryStepLibrary) from the pool so a random pick never
    // lands Apply() on a scene that can't play. An empty library is still a silent no-op (nothing to play, not an
    // error); a non-empty library with NO playable item throws so the caller can surface it
    // instead of letting Apply() 500.
    public static void ApplyRandom()
    {
        bool keep = BeforeUserSwitch();
        if (IsTimedPlaylistActive()) { LiascapePlayerProgram.Random(); return; }
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
        }
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

    // The in-player auto-mute has every source muted: `gain.automute`, the player's own slot — `_autoMuted` and
    // `gain.mute` stay the user's there. Asked of the player, so a one-shot CLI process (the keybind, app closed) knows too.
    public static bool AutoMutedInPlayer => AudioMonitor.AutoMuteInPlayer && LiascapePlayerMedia.AutoMuteActive();

    // The user unmutes an auto-mute (toggle-mute, `POST /mute`): holds until the foreign audio ended, under either engine
    // (AudioMonitor's own state stays "muted" until then; the player's `automute.release`).
    public static void UnmuteAuto()
    {
        if (AudioMonitor.AutoMuteInPlayer) LiascapePlayerMedia.ReleaseAutoMute();
        SetMute(false);
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
    // takes the dragged value (effective = override ?? global); an overridden one never moves.
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
    }

    // Apply a per-wallpaper override LIVE to the currently-playing wallpaper, seamlessly (no restart):
    // mpv set_property for video volume/speed, LWE for scene volume (scenes are 1× → speed no-op). No-op
    // unless `path` is what's playing. Effective = override ?? global, so clearing an override (index key
    // dropped because it == global) snaps the running wallpaper back to the global value.
    public static void ApplyOverrideLive(string path)
    {
        // liascape-player: the resolver, on the source(s) showing THAT item (may be an in-flight transition's
        // pending B); coalescible — it re-reads the override when it runs
        if (PlayerEngine.IsLiascapePlayer)
        {
            LiascapePlayerMedia.ApplyOverride(path);
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
    // scene's next start (the one genuine launch-only case there, like SceneMonitors).
    public static void ApplyScenePropsLive(string path, IReadOnlyDictionary<string, System.Text.Json.JsonElement>? preview = null)
    {
        if (!PlayerEngine.IsLiascapePlayer || !IsScenePath(path)) return;
        if (preview != null) LiascapePlayerMedia.PreviewSceneProps(path, preview);
        else LiascapePlayerMedia.ApplySceneProps(path);
    }

    public static void SetLoop(bool loop) =>
        TrySendCommand("set", "loop-file", loop ? "inf" : "no");

    public static void SetVideoScale(string scale)
    {
        double panscan = scale == "fill" ? 1.0 : 0.0;
        SendCommand("set_property", "panscan", panscan);
    }

    // `/settings` live-apply: ONE resolver pass (LiascapePlayerMedia.ApplyEffective) — every live source gets its own
    // effective volume/speed (override ?? global), af, mute and decode/buffer settings, and the layer its fit, each
    // diffed against what it runs (only what differs is sent; a no-op save sends nothing). It replaces
    // SetVolume/SetSpeed/SetVideoScale/ApplyNormalizationLive/ApplyPlaybackSettingsLive there.
    public static void ApplyEffectiveLive() => LiascapePlayerMedia.ApplyEffective();

    // Apply CHANGED playback settings LIVE to the currently-playing wallpaper — no stop/replay/relaunch.
    // Diffs prev→cur so we only poke mpv/LWE for what actually changed (needlessly re-applying vf/hwdec/
    // cache re-inits the decoder → a visible stall). Volume/Speed/VideoScale/Normalization/AutoMute are
    // applied by the /settings handler; this covers Loop, NoAudio, VideoFpsCap, DisableCache, Demuxer*, HwDec
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

        if (prev.VideoFpsCap != cur.VideoFpsCap)
            TrySendCommand("set", "vf", cur.VideoFpsCap > 0 ? $"fps={cur.VideoFpsCap}" : "");
        if (prev.DisableCache != cur.DisableCache)
            TrySendCommand("set", "cache", cur.DisableCache ? "no" : "auto");
        if (prev.DemuxerMaxMib != cur.DemuxerMaxMib)
            TrySendCommand("set", "demuxer-max-bytes", $"{cur.DemuxerMaxMib}MiB");
        if (prev.DemuxerMaxBackMib != cur.DemuxerMaxBackMib)
            TrySendCommand("set", "demuxer-max-back-bytes", $"{cur.DemuxerMaxBackMib}MiB");
        if (prev.HwDec != cur.HwDec)
            TrySendCommand("set", "hwdec", string.IsNullOrWhiteSpace(cur.HwDec) ? "no" : cur.HwDec);
    }


    // Adjust the GLOBAL volume by `delta` (clamped 0-100) — the keybind twin of the Settings page's global
    // slider. Persisted (subsequent launches and the GUI slider reflect it) and pushed live as the playing
    // item's EFFECTIVE volume (override ?? global, like /settings): an item with its own volume keeps it.
    // It pushed the new global even then — the playing wallpaper jumped off its override until the next
    // settings save (a theme change) snapped it back (UI matrix `cli:volume-up:overridden`).
    // The volume keybinds, ±delta clamped 0–100, by `VolumeKeyTarget`: "auto" (default) moves the playing
    // wallpaper's own volume when it has one, else the global; "item" always the playing wallpaper's own
    // (override ?? global → its override); "global" always the global — then an overridden wallpaper keeps
    // its own (pushing the new global onto it would snap it back on the next settings save). Live either
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

    // `shownGen`: the switch this launch belongs to, for a launch that comes after its switch returned (S→V's mpvpaper-B,
    // started under the overlay); null = a launch of its own, which is the newest thing shown.
    private static Process? Launch(string mpvOptions, string file, TaskCompletionSource<bool>? readyTcs = null, int? shownGen = null)
    {
        // liascape-player: a cold launch = a cut to `file` (whatever was on screen was just stopped)
        if (PlayerEngine.IsLiascapePlayer)
        {
            LiascapePlayerMedia.QueueNewSession(); // I1: a cold launch is a new session — it plays
            LiascapePlayerMedia.QueueSwitch(file, SettingsService.Load(), tcfg: null, alignEnd: false);
            readyTcs?.TrySetResult(true);
            return null;
        }
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
        // its own scope: a stopped systemd unit the backend runs in must not take the wallpaper with it (UserScope)
        foreach (var a in UserScope.Prefix("mpvpaper", m => Console.Error.WriteLine(m))) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("mpvpaper");
        psi.ArgumentList.Add("-o");
        psi.ArgumentList.Add(options);
        psi.ArgumentList.Add("*");
        psi.ArgumentList.Add(file);
        var process = Process.Start(psi);
        process?.BeginOutputReadLine();
        process?.BeginErrorReadLine();
        AnnounceWhenIpcAnswers(shownGen ?? Interlocked.Increment(ref _shownGen));
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

    // Bumped by every legacy switch, stop and cold launch: the generation of what the clients were last told plays.
    private static int _shownGen;

    // A cold launch's file is announced when the switch is asked for, but /current asks mpv's IPC, which answers only
    // 0.3–2 s later: a page that loaded in between read "nothing plays" and was never told otherwise. So say it again the
    // moment the launch's IPC first answers. What goes out is the path mpv itself reports (what /current now says), never
    // the launch's file, and only while no newer switch, stop or launch came since: checked and sent under _lock, which
    // every switch and stop holds while it bumps the generation and announces, so this can never land after a newer
    // announcement (a superseded or stopped launch says nothing). Polling stops at the first answer, a newer generation
    // or 15 s.
    private static void AnnounceWhenIpcAnswers(int gen)
    {
        if (OnWallpaperChanged == null) return; // a daemon or a one-shot CLI: no page listens here
        Task.Run(async () =>
        {
            for (int i = 0; i < 150 && Volatile.Read(ref _shownGen) == gen; i++)
            {
                await Task.Delay(100).ConfigureAwait(false);
                if (TryQueryCurrentPath() == null) continue;
                lock (_lock)
                {
                    if (_shownGen == gen && TryQueryCurrentPath() is string playing) OnWallpaperChanged?.Invoke(playing);
                }
                return;
            }
        });
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

    // Reap every legacy wallpaper process of THIS user session — NOT just `_current` (which is null in a daemon process
    // that never spawned mpvpaper). mpvpaper and LWE are detached (setsid), so scanning /proc is the only cross-process
    // way to find them. Matched by program name (argv[0] or the executable, a Nix `.<name>-wrapped` counts), and only
    // a process whose HOME is ours: a hermetic test's backend must never reach the desktop session's wallpaper.
    // Used by the shutdown reaper below and at `serve` start / restore, where a legacy session left running would
    // stay on screen beside liascape-player. Returns how many it reaped. Guard: scripts/test-player-binary.sh
    // § a legacy settings file
    internal static int ReapAllWallpaperProcs()
    {
        var names = new HashSet<string> { "mpvpaper", "liascape-transition", "liascape-audio", "linux-wallpaperengine" };
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrEmpty(home)) return 0;
        static string Norm(string? path)
        {
            var n = Path.GetFileName(path ?? "");
            if (n.StartsWith('.') && n.EndsWith("-wrapped")) n = n[1..^"-wrapped".Length];
            return n;
        }
        int reaped = 0;
        foreach (var dir in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(dir), out int pid) || pid == Environment.ProcessId) continue;
            try
            {
                var argv0 = File.ReadAllText(Path.Combine(dir, "cmdline")).Split('\0')[0];
                string? exe = null;
                try { exe = new FileInfo(Path.Combine(dir, "exe")).LinkTarget; } catch { }
                if (!names.Contains(Norm(argv0)) && !names.Contains(Norm(exe))) continue;
                var env = File.ReadAllText(Path.Combine(dir, "environ")).Split('\0');
                if (!env.Contains("HOME=" + home)) continue;
                using var p = Process.GetProcessById(pid);
                p.Kill(entireProcessTree: true);
                reaped++;
                LiascapePlayerClient.Log($"stopped a legacy wallpaper process: {Norm(argv0)} (pid {pid})");
            }
            catch { } // gone meanwhile, or not ours to read
        }
        return reaped;
    }

    // Graceful shutdown reaper for the long-lived monitor-daemon.
    // It receives SIGTERM ONLY on system shutdown / session-stop: GUI close kills just the serve
    // backend (the wallpaper must SURVIVE that), and the app tears its OWN daemons down with
    // Process.Kill() = SIGKILL (no handler fires). So a SIGTERM/HUP reaching the daemon == the machine is
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
        // liascape-player: `stop` (every source ramped out and retired), queued — callers hold _lock (Stop);
        // the player process stays up
        if (PlayerEngine.IsLiascapePlayer) { LiascapePlayerMedia.QueueStop(); _current = null; return; }
        _prelaunchCts?.Cancel();
        _prelaunchCts = null;
        if (_prelaunchPidsToKill != null) { KillPids(_prelaunchPidsToKill); _prelaunchPidsToKill = null; }
        Interlocked.Increment(ref _shownGen); // what a launch waiting for its IPC would announce is going away
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
    // can't play, or (D6) when it is marked crashed and not whitelisted — what the sidebar's crash notice
    // promises ("rotations skip it"); a user's own apply still plays it (Apply). Pure — the self-test's truth table. Marking
    // happens only under liascape-player (OnSceneBroken), so it is inert for legacy unless liascape-player marked one.
    public static bool SkipScene(bool isScene, bool playable, bool crashed, bool whitelisted) =>
        isScene && (!playable || (crashed && !whitelisted));

    // A preset that can't play now, and why (Presets.StatusOf, read fresh: its base missing, not a scene, the legacy
    // engine); null = not a preset, or one that plays. Never played as its plain base: Apply refuses it with the reason
    // and every picker and the program's `skip` pass it by. Guard: player-selftest SceneSkipAssertions, adapter IT § presets
    public static string? PresetUnplayableReason(string path) =>
        IsScenePath(path) && Presets.Read(path) != null ? Presets.StatusOf(path, PlayerEngine.IsLiascapePlayer).Reason : null;

    // liascape-player: `source.broken` (a scene's worker crashed past its restart budget, 3 in 60 s) →
    // marked crashed in its index entry (rotations skip it unless whitelisted, D6; a click still plays it), the UI told
    // (WS `scene-crashed`), and — by design — a rotation PLAYING it advances at once (the player's program;
    // its skip flag follows the mark). A single wallpaper keeps what the player shows (its last frame or
    // preview, silent).
    public static void OnSceneBroken(string path)
    {
        if (string.IsNullOrEmpty(path) || !IsScenePath(path)) return;
        LibraryService.MarkCrashed(path);
        OnSceneCrashed?.Invoke(path);
        AdvanceIfPlaying(path, "scene broken while playing");
    }

    // liascape-player: `scene.vram_exceeded` — the player's VRAM guard stopped this scene's worker (it used more
    // than `player.scene_vram_limit_mib`). For playback exactly like a broken scene — a rotation playing it
    // advances at once, a single wallpaper keeps what the player shows (its last frame) — but it is NOT marked
    // crashed (it isn't broken; with a higher limit or less on the GPU it plays): the UI is told why instead
    // (WS `scene-vram-stopped {path, usedMib, limitMib, message}`).
    public static string VramStoppedMessage(double usedMib, double limitMib) =>
        $"it used {usedMib:0} MiB of video memory, over the {limitMib:0} MiB cap";

    public static void OnSceneVramStopped(string path, double usedMib, double limitMib)
    {
        if (string.IsNullOrEmpty(path) || !IsScenePath(path)) return;
        OnSceneVramStoppedCb?.Invoke(path, usedMib, limitMib, VramStoppedMessage(usedMib, limitMib));
        AdvanceIfPlaying(path, $"scene over the VRAM limit ({usedMib:0} > {limitMib:0} MiB)");
    }

    // why liascape-player can't play a scene here, for reasons that aren't any scene's (a worker couldn't load the scene
    // renderer: LiascapePlayerClient.RendererMissing), else null — whatever the engine: the UI applies it only while
    // the engine is liascape-player (store unplayableReasonOf, live across an engine switch), greying every scene and
    // preset card and playing none; pickers and rotations already skip them (the player drops its `scene` capability
    // meanwhile: ScenesPlayable; legacy's gates never read it). Never a crash mark, or one broken install would mark every
    // scene it reached. Never waits: the latch as it stands, a fresh word asked off-thread (a change → WS scenes-blocked).
    public static string? ScenesBlockedReason
    {
        get
        {
            var c = LiascapePlayerClient.Shared;
            if (PlayerEngine.IsLiascapePlayer) c.KickSceneWord();
            return c.RendererMissing;
        }
    }

    // liascape-player's low-VRAM hold, in the words the UI shows while it holds (the now-playing line): the wallpapers
    // are paused (in `stop` mode their memory freed too, a still shown) because video memory is low, and how much free
    // memory it waits for. Guard: probe-matrix vram:held.
    public static string VramHoldMessage(Liascape.Player.VramHoldInfo h) =>
        h.FreeMib is double f && h.NeededMib is double n
            ? $"Paused: low video memory — {f:0} MB free, needs {n:0} MB"
            : "Paused: low video memory";

    // the message while the low-VRAM hold holds, else null (under liascape-player only: legacy has no hold)
    public static string? VramHoldNow =>
        PlayerEngine.IsLiascapePlayer && LiascapePlayerClient.Shared.VramHold is { } h ? VramHoldMessage(h) : null;

    // the hold took the wallpapers or let go → the UI (WS `vram-hold {message}`, null once it let go)
    public static void OnVramHold(Liascape.Player.VramHoldInfo? hold) =>
        OnVramHoldCb?.Invoke(hold == null ? null : VramHoldMessage(hold));

    // the latch moved → the UI (WS `scenes-blocked {reason}`) and the program's items (their skip follows ScenesPlayable)
    public static void OnScenesBlocked(string? reason)
    {
        OnScenesBlockedCb?.Invoke(reason);
        LiascapePlayerProgram.PushItems();
    }

    // the playing item of a running rotation is `path`: the player's program advanced by itself (a broken / VRAM-stopped
    // current item) — its item's skip flag follows the crash mark; anything else (a single wallpaper, a pending B) → nothing
    private static void AdvanceIfPlaying(string path, string why)
    {
        if (!LiascapePlayerProgram.IsActive) return;
        TransitionService.TransLog($"{why}: {System.IO.Path.GetFileName(path)} — the player's program advances");
        LiascapePlayerProgram.PushItem(path);
    }

    // The pickers' rule for a program item's `skip` flag (LiascapePlayerProgram.BuildItems).
    public static bool SkippedForRotation(string path, bool scenesPlayable) => IsSkippedPath(path, scenesPlayable);

    // A program switch committed (`program.current`, its effect started): what every client is told plays. The program
    // measures nothing itself — every unmeasured video of it was kicked when its items were built (NormalizeAf), so with
    // the app closed only an item never measured before plays raw.
    public static void OnProgramSwitched(string path) => OnWallpaperChanged?.Invoke(path);

    // Load `paths` (the playlist bar's order; the player shuffles) as the player's program. `from`: "start" | "resume" |
    // "index" (+ index); null = the playlist's effective start mode (a start: Play, a restore). Returns the queued load.
    public static Task? LoadProgram(IReadOnlyList<string> paths, AppSettings s, PlaylistSettings? ps, bool shuffle, int intervalSeconds, bool advance,
        string? from, int index = 0, string? key = null)
    {
        if (paths.Count == 0) return null;
        var spec = LiascapePlayerProgram.BuildSpec(paths, s, ps, shuffle, intervalSeconds, advance, key);
        if (spec.Items.All(i => i.Skip))
        {
            // nothing in it can play: playback stops
            LiascapePlayerClient.Log("program: no item of the playlist can play — stopping");
            LiascapePlayerProgram.End();
            lock (_lock) KillCurrentProcess();
            return null;
        }
        from ??= EffectiveStart(s, ps) == "resume" ? "resume" : "start";
        return LiascapePlayerProgram.Load(spec, from, index, keepPause: false);
    }

    private static string NoPlayableMessage() => PlayerEngine.IsLiascapePlayer
        ? "No playable wallpaper in the library — every item is a scene that can't play: scenes need \"Play scenes\" + Wallpaper Engine's assets (liascape-player), and a crashed scene plays only when whitelisted"
        : "No playable wallpaper in the library — every item is a scene, and scenes need \"Play scenes\" + linux-wallpaperengine";

    // Same rule for a whole-library scan: resolve ScenesPlayable once (a settings load + a `which` / the
    // player's capability) instead of once per scene item; the crash mark is one index read per scene.
    private static bool IsSkippedPath(string path, bool scenesPlayable)
    {
        if (!IsScenePath(path)) return false;
        if (!scenesPlayable || PresetUnplayableReason(path) != null) return true;
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
        bool anyPrimary = settings.SceneMonitors.Any(m => m.IsPrimary);
        // the item's scene-property overrides (launch-only under legacy: LWE has no live property IPC)
        var propArgs = scenePath == null ? [] : SceneProperties.CliArgs(scenePath, LibraryService.ReadSceneProps(scenePath));

        foreach (var monitor in settings.SceneMonitors)
        {
            if (string.IsNullOrWhiteSpace(monitor.Name)) continue;
            var psi = new ProcessStartInfo("setsid")
            {
                UseShellExecute = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
            };
            foreach (var a in UserScope.Prefix("linux-wallpaperengine", m => Console.Error.WriteLine(m))) psi.ArgumentList.Add(a);
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

    // A background loudness measurement just landed (LibraryService.EnsureLoudnessAsync; a scene's `scene.loudness`
    // goes through LiascapePlayerMedia.OnSceneLoudness instead — set once per play): with normalization on, the item may be
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
