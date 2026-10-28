using System;
using System.Collections.Generic;
using System.Linq;

namespace Liascape.Models;

public class AppSettings
{
    public bool Loop { get; set; } = true;
    public bool NoAudio { get; set; } = true;
    public bool DisableCache { get; set; } = false;
    public int DemuxerMaxMib { get; set; } = 20;
    public int DemuxerMaxBackMib { get; set; } = 5;
    public string HwDec { get; set; } = "auto";
    public string VideoScale { get; set; } = "fill";
    public int VideoFpsCap { get; set; } = 0; // cap mpv video playback fps (0 = native). Scenes (LWE) unaffected.
    private int _volume = 100;
    public int Volume
    {
        get => _volume;
        set => _volume = Math.Clamp(value, 0, 100);
    }
    private double _speed = 1.0;
    public double Speed
    {
        get => _speed;
        set => _speed = Math.Clamp(value, 0.1, 4.0);
    }
    // EBU R128 loudness normalization between videos: each clip is measured once (cached in the library
    // index) and gain-matched to NormalizeTargetLufs at playback. Per-item/global Volume stacks ON TOP
    // (applied after the loudnorm filter). Target in LUFS (dB-referenced loudness); -14 = streaming std.
    public bool NormalizeAudio { get; set; } = false;
    private double _normTarget = -14.0;
    public double NormalizeTargetLufs
    {
        get => _normTarget;
        // 0 (loudest) … -100 (near-silent). Even at 0, loudnorm's -1.5 dBTP limiter + volume capped at
        // unity (≤100) mean the output can't clip — extremes just land very loud-but-limited or silent.
        set => _normTarget = Math.Clamp(value, -100.0, 0.0);
    }
    public string WorkshopFolder { get; set; } = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".local/share/Steam/steamapps/workshop/content/431960");
    public bool CopyFilesInsteadOfSymlinking { get; set; } = false;
    public bool ResumeFromLast { get; set; } = true;
    public bool AllowScenes { get; set; } = false;
    public int LweVolume { get; set; } = 100;
    public List<SceneMonitor> SceneMonitors { get; set; } = [];
    public int SceneTransitionDelayMs { get; set; } = 1000;
    public bool AutoMute { get; set; } = false;
    public int AutoMuteDelayMs { get; set; } = 200;
    public int AutoUnmuteDelayMs { get; set; } = 2000;
    public double AutoMuteMinLevelDb { get; set; } = -70.0;
    public bool AutoMuteOnlyIfMprisActive { get; set; } = false;
    public string ThumbnailAspect { get; set; } = "1:1";
    public string CardSize { get; set; } = "Medium";
    public bool AutoPlayGifs { get; set; } = false;
    public bool AdvancedSettings { get; set; } = false;      // UI: reveal power-user settings rows
    public bool LiveWallpaperBehindAllTabs { get; set; } = false;    // UI: play the wallpaper behind Browse/Library too
    public bool DebugMode { get; set; } = false;             // UI: enable the liascapeDbg bridge + metrics
    public bool DebugOverlay { get; set; } = true;           // UI: show the on-screen debug HUD (when DebugMode on)
    public bool RestartOnlyAtPlaylistChangeover { get; set; } = false;   // defer the mpvpaper leak-restart to the next playlist changeover
    public bool StayPausedWhenSwitching { get; set; } = false;     // next/prev/random while paused: false = resume and switch, true = stay paused (a cut)
    public bool ReplaceDirectWithWorkshop { get; set; } = false; // swap a direct-DL copy for a WE-dir symlink/copy when it appears
    public int LibrarySortIndex { get; set; } = 5;
    // The global rotation (PlayerHelper § Rotation): GlobalSwitchWhenVideoEnds ("Switch when video ends") off →
    // GlobalIntervalSeconds is a plain timer ("Switch every"); on → it is the minimum play time and
    // GlobalMaxPlaySeconds the maximum (below), and GlobalSeparateSceneTiming gives scenes + still images (they never
    // end) their own GlobalSwitchScenesAfterSeconds instead. Every limit is 0 = off. Defaults: a video plays to its
    // end however long (no minimum, no maximum); a scene / still image switches after 30 min.
    public int GlobalIntervalSeconds { get; set; } = 0;
    public bool GlobalSwitchWhenVideoEnds { get; set; } = true;
    public string Theme { get; set; } = "Catppuccin Mocha";
    private int _restartMpvpaperEverySeconds = 600;
    public int RestartMpvpaperEverySeconds
    {
        get => _restartMpvpaperEverySeconds;
        set => _restartMpvpaperEverySeconds = Math.Clamp(value, 0, 3600);
    }
    // The maximum play time under advance-on-end (wall-clock seconds, 0 = off): the playing item — a video mid-clip,
    // a scene / still image unless they have their own timing — advances once it played that long (a cap beats the
    // minimum). Default off: a video plays to its end, even a 10 h one.
    private int _globalMaxPlaySeconds = 0;
    public int GlobalMaxPlaySeconds { get => _globalMaxPlaySeconds; set => _globalMaxPlaySeconds = PlayLimit(value); }
    // "Separate timing for scenes" (advance-on-end only): on → a scene or a still image ignores the minimum / maximum
    // and switches after "Switch scenes after" (wall-clock seconds, 0 = off: it stays until a user switch); off → they
    // follow the video rules (the minimum reached is their end, else the maximum, else they stay).
    public bool GlobalSeparateSceneTiming { get; set; } = true;
    private int _globalSwitchScenesAfterSeconds = 1800;
    public int GlobalSwitchScenesAfterSeconds { get => _globalSwitchScenesAfterSeconds; set => _globalSwitchScenesAfterSeconds = PlayLimit(value); }
    public static int PlayLimit(int seconds) => Math.Clamp(seconds, 0, MaxPlayLimitSeconds);
    public const int MaxPlayLimitSeconds = 359999; // 99:59:59, the UI's h/m/s fields

    // Global transition fallbacks (used when a playlist's OverrideGlobalSettings is off). See
    // PlaylistSettings.Transition* + TransitionService. Empty/!Enabled => instant cut.
    public bool GlobalTransitionEnabled { get; set; } = false;
    public List<string> GlobalTransitionEffectIds { get; set; } = [];
    public int GlobalTransitionDurationMs { get; set; } = 600;
    public int GlobalTransitionDurationMaxMs { get; set; } = 0;
    public bool GlobalTransitionShuffle { get; set; } = true;
    // How transitions render (global, advanced): "reveal" = freeze A, reveal the LIVE wallpaper-B
    // underneath (WE-style; warp effects fall back to frozen); "frozen" = both sides frozen stills
    // (all effects, zero cost); "full-live" = overlay decodes A+B live (all effects, heavy on 4K).
    public string TransitionMethod { get; set; } = "reveal";
    // Full-live only: aim the outgoing (A) decoder this many ms relative to the live wallpaper at the
    // cover, to cancel the per-machine settling drift (negative = aim slightly ahead). The renderer
    // takes it in seconds via --lag-offset; ~-30ms suits this dev box, may differ per GPU/refresh.
    public int FullLiveSyncOffsetMs { get; set; } = -30;
    // Which player drives the wallpaper: "legacy" (mpvpaper + liascape-transition + LWE) or "liascape-player" (the
    // Rust player, experimental — videos/images only in Phase 1; scenes are skipped). Switching applies
    // live (/settings → PlayerHelper.SwitchEngineLive). See .claude/rules/player-adapter.md.
    public string PlayerEngine { get; set; } = "legacy";
    // What the volume keybinds (`liascape volume up|down`, `/volume {delta}`) move — Advanced setting:
    // "auto" = the playing wallpaper's own volume when it has one, else the global; "item" = always the
    // playing wallpaper's own (creating its override); "global" = always the global (a wallpaper with its own
    // volume doesn't move). PlayerHelper.AdjustVolume.
    public string VolumeKeyTarget { get; set; } = "auto";
    // liascape-player GPU / VRAM (Phase 2 Task 8 — all live: player-adapter.md § Scenes → "GPU / VRAM"; legacy: unused).
    // AutoThrottleScenes: a scene whose worker starves its outputs is throttled stepwise and restored (false = every
    // scene at its fixed fps) → `player.scene_throttle`.
    public bool AutoThrottleScenes { get; set; } = true;
    // The per-scene VRAM guard: a scene worker using more than SceneVramLimitMib of VRAM is stopped (a rotation
    // advances, a single wallpaper keeps its last frame; never marked crashed) → `player.scene_vram_limit_mib`
    // (the MiB while enabled, else 0 = off). The MiB value is kept while off (the toggle restores it).
    public bool LimitVramPerScene { get; set; } = false;
    private int _sceneVramLimitMib = 1536;
    public int SceneVramLimitMib
    {
        get => _sceneVramLimitMib;
        set => _sceneVramLimitMib = Math.Clamp(value, 64, 1_048_576);
    }
    // When the GPU's VRAM runs low (system-wide, every source kind): "stop" (pause + free the sources' GPU memory),
    // "pause", or "off" → `player.vram_low_mode`. An unknown value reads as the default.
    private string _vramLowMode = "stop";
    public string VramLowMode
    {
        get => _vramLowMode;
        set => _vramLowMode = value is "stop" or "pause" or "off" ? value : "stop";
    }
    public bool AutoAddLibraryToPlaylist { get; set; } = false;
    public bool AutoAddWeWallpapersToLibrary { get; set; } = false;
    public bool IsPlaylistBarCollapsed { get; set; } = false;
    // "subscribe" (real Steam subscription via community endpoint) or "steamcmd" (direct download).
    public string WorkshopDownloadMode { get; set; } = "subscribe";
    // QR sign-in: refresh token (~1yr) + steamid; access token (~24h) cached + auto-minted.
    public string SteamRefreshToken { get; set; } = "";
    public ulong SteamId { get; set; } = 0;
    public string SteamAccessToken { get; set; } = "";
    public string SteamAccountName { get; set; } = "";
    // Manual cookie paste (fallback / advanced; used only when no refresh token is stored).
    public string SteamLoginSecure { get; set; } = "";
    public string SteamCmdPath { get; set; } = "";
    public string SteamUsername { get; set; } = "";
    public LastSession? LastSession { get; set; }

    public string BuildMpvOptions()
    {
        var parts = new List<string>();
        if (Loop) parts.Add("loop");
        if (NoAudio) parts.Add("--no-audio");
        else parts.Add($"--volume={Volume}");
        if (Speed != 1.0) parts.Add($"--speed={Speed.ToString("G", System.Globalization.CultureInfo.InvariantCulture)}");
        if (DisableCache) parts.Add("--cache=no");
        if (DemuxerMaxMib > 0) parts.Add($"--demuxer-max-bytes={DemuxerMaxMib}MiB");
        if (DemuxerMaxBackMib > 0) parts.Add($"--demuxer-max-back-bytes={DemuxerMaxBackMib}MiB");
        if (!string.IsNullOrWhiteSpace(HwDec)) parts.Add($"--hwdec={HwDec}");
        if (VideoFpsCap > 0) parts.Add($"--vf=fps={VideoFpsCap}"); // cap playback fps (video only)
        if (VideoScale == "fill") parts.Add("--panscan=1.0");
        parts.Add("--image-display-duration=inf");
        return string.Join(" ", parts);
    }

    // For playlist mode: omit per-file loop so mpv advances to the next entry.
    public string BuildMpvPlaylistOptions()
    {
        var parts = new List<string>();
        if (NoAudio) parts.Add("--no-audio");
        else parts.Add($"--volume={Volume}");
        if (Speed != 1.0) parts.Add($"--speed={Speed.ToString("G", System.Globalization.CultureInfo.InvariantCulture)}");
        if (DisableCache) parts.Add("--cache=no");
        if (DemuxerMaxMib > 0) parts.Add($"--demuxer-max-bytes={DemuxerMaxMib}MiB");
        if (DemuxerMaxBackMib > 0) parts.Add($"--demuxer-max-back-bytes={DemuxerMaxBackMib}MiB");
        if (!string.IsNullOrWhiteSpace(HwDec)) parts.Add($"--hwdec={HwDec}");
        if (VideoFpsCap > 0) parts.Add($"--vf=fps={VideoFpsCap}"); // cap playback fps (video only)
        if (VideoScale == "fill") parts.Add("--panscan=1.0");
        parts.Add("--image-display-duration=10");
        return string.Join(" ", parts);
    }

    // Live preview of the linux-wallpaperengine (scene) command, one line per configured monitor.
    // Mirrors PlayerHelper.SpawnLweProcesses exactly. Uses a <monitor> placeholder when none set.
    public string BuildLweOptions()
    {
        var monitors = SceneMonitors.Where(m => !string.IsNullOrWhiteSpace(m.Name)).ToList();
        bool anyPrimary = monitors.Any(m => m.IsPrimary);
        var src = monitors.Count > 0
            ? monitors
            : new List<SceneMonitor> { new() { Name = "<monitor>", Fps = 60, IsPrimary = true } };
        var lines = new List<string>();
        foreach (var m in src)
        {
            var parts = new List<string> { "linux-wallpaperengine", "--noautomute", "--screen-root", m.Name };
            bool hasAudio = !anyPrimary || m.IsPrimary;
            if (NoAudio || !hasAudio) parts.Add("--silent");
            else { parts.Add("--volume"); parts.Add("100"); }
            if (m.Fps > 0) { parts.Add("--fps"); parts.Add(m.Fps.ToString()); }
            parts.Add("--no-fullscreen-pause");
            lines.Add(string.Join(" ", parts));
        }
        return string.Join("\n", lines);
    }

    public static AppSettings Default() => new();
}
