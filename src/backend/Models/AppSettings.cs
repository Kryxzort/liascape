using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace Liascape.Models;

public class AppSettings
{
    public bool NoAudio { get; set; } = false;
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
    // (applied after the normalization gain). Target in LUFS (dB-referenced loudness); -14 = streaming std.
    public bool NormalizeAudio { get; set; } = false;
    private double _normTarget = -14.0;
    public double NormalizeTargetLufs
    {
        get => _normTarget;
        // 0 (loudest) … -100 (near-silent). Even at 0, the gain only boosts into a -1 dBTP headroom + volume capped at
        // unity (≤100) mean the output can't clip — extremes just land very loud-but-limited or silent.
        set => _normTarget = Math.Clamp(value, -100.0, 0.0);
    }
    public string WorkshopFolder { get; set; } = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".local/share/Steam/steamapps/workshop/content/431960");
    public bool CopyFilesInsteadOfSymlinking { get; set; } = false;
    public bool AllowScenes { get; set; } = false;
    public int LweVolume { get; set; } = 100;
    public List<SceneMonitor> SceneMonitors { get; set; } = [];
    public int SceneTransitionDelayMs { get; set; } = 1000;
    public bool AutoMute { get; set; } = false;
    public int AutoMuteDelayMs { get; set; } = 500;
    public int AutoUnmuteDelayMs { get; set; } = 2000;
    public double AutoMuteMinLevelDb { get; set; } = -70.0;
    public bool AutoMuteOnlyIfMprisActive { get; set; } = false;
    public string ThumbnailAspect { get; set; } = "1:1";
    public string CardSize { get; set; } = "Medium";
    // UI: Settings → "On hover" / "Not hovered": the order of video / gif / image a card tries, hovered and not (the first one an
    // item has shows; components/mediaAssets.ts). Kept to the three kinds once each, in the order given, the missing ones after
    // in the default's order: an unknown or repeated kind is dropped, so any list loads as a whole order.
    private List<string> _previewOnHover = ["gif", "video", "image"];
    public List<string> PreviewOnHover { get => _previewOnHover; set => _previewOnHover = PreviewOrder(value, ["gif", "video", "image"]); }
    private List<string> _previewNotHovered = ["image", "gif", "video"];
    public List<string> PreviewNotHovered { get => _previewNotHovered; set => _previewNotHovered = PreviewOrder(value, ["image", "gif", "video"]); }
    public static List<string> PreviewOrder(IEnumerable<string?>? order, string[] def)
    {
        var got = (order ?? []).Select(k => k?.Trim().ToLowerInvariant()).Where(k => k is "video" or "gif" or "image").Distinct().Select(k => k!).ToList();
        got.AddRange(def.Where(k => !got.Contains(k)));
        return got;
    }
    // UI: "Video preview quality" — low | mid (default) | high: the clips' size factor, fps and CRF (components/clipSource.ts,
    // Web/ClipStore.cs). An unknown value reads as the default.
    private string _videoPreviewQuality = "mid";
    public string VideoPreviewQuality
    {
        get => _videoPreviewQuality;
        set => _videoPreviewQuality = value?.ToLowerInvariant() is "low" or "mid" or "high" ? value.ToLowerInvariant() : "mid";
    }
    public bool Morphs { get; set; } = true;                 // UI: card -> modal morph flights (off = a plain fade in place, useMorph.ts)
    public bool Glows { get; set; } = true;                  // UI: accent/state glow effects (off = <html class="no-glow">, index.css)
    public bool TextShadow { get; set; } = false;            // UI: a subtitle shadow on all text (on = <html class="text-shadow">, index.css)
    // UI: how much of Settings shows — basic | standard (default) | advanced | expert (.claude/rules/ui/state-and-api.md § Settings page). Hidden
    // rows keep their values and stay live; nothing here reads it (docs/decisions.md § "Use four settings levels,
    // Standard by default, and never reset a hidden value").
    public string SettingsLevel { get => _settingsLevel; set => _settingsLevel = Level(value); }
    private string _settingsLevel = "standard";
    public static string Level(string? v) => v?.Trim().ToLowerInvariant() switch { "basic" => "basic", "advanced" => "advanced", "expert" => "expert", _ => "standard" };
    public bool LiveWallpaperBehindAllTabs { get; set; } = false;    // UI: play the wallpaper behind Browse/Library too
    public bool DebugMode { get; set; } = false;             // UI: enable the liascapeDbg bridge + metrics
    public bool DebugOverlay { get; set; } = true;           // UI: show the on-screen debug HUD (when DebugMode on)
    public bool RestartOnlyAtPlaylistChangeover { get; set; } = false;   // defer the mpvpaper leak-restart to the next playlist changeover
    public bool StayPausedWhenSwitching { get; set; } = false;     // next/prev/random while paused: false = resume and switch, true = stay paused (liascape-player: the transition plays on the still frames; legacy: a cut)
    public bool ReplaceDirectWithWorkshop { get; set; } = false; // swap a direct-DL copy for a WE-dir symlink/copy when it appears
    public int LibrarySortIndex { get; set; } = 5;
    // The global rotation (PlayerHelper § Rotation): GlobalSwitchWhenVideoEnds ("Switch when video ends") off →
    // GlobalIntervalSeconds is a plain timer ("Switch every"); on → it is the minimum play time and
    // GlobalMaxPlaySeconds the maximum (below), and GlobalSeparateSceneTiming gives scenes + still images (they never
    // end) their own GlobalSwitchScenesAfterSeconds instead. The minimum and maximum are 0 = off; the maximum is never
    // under the minimum (RotationMax); scenes-after is at least 1 s (SceneTime). Defaults: a video plays to its end
    // however long (no minimum, no maximum); a scene / still image switches after 30 min.
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
    // a scene / still image unless they have their own timing — advances once it played that long. Never under the
    // minimum (RotationMax, applied on every save). Default off: a video plays to its end, even a 10 h one.
    private int _globalMaxPlaySeconds = 0;
    public int GlobalMaxPlaySeconds { get => _globalMaxPlaySeconds; set => _globalMaxPlaySeconds = PlayLimit(value); }
    // "Separate timing for scenes" (advance-on-end only): on → a scene or a still image ignores the minimum / maximum
    // and switches after "Switch scenes after" (wall-clock seconds, at least 1: SceneTime); off → they follow the video
    // rules (the minimum reached is their end, else the maximum, else they stay).
    public bool GlobalSeparateSceneTiming { get; set; } = true;
    private int _globalSwitchScenesAfterSeconds = 1800;
    public int GlobalSwitchScenesAfterSeconds { get => _globalSwitchScenesAfterSeconds; set => _globalSwitchScenesAfterSeconds = SceneTime(value); }
    public static int PlayLimit(int seconds) => Math.Clamp(seconds, 0, MaxPlayLimitSeconds);
    // "Switch scenes and pictures after" has no "off": a scene or picture always moves on (0 or less → the 1 s floor).
    // Guard: test-settings-merge.sh "never 0"
    public static int SceneTime(int seconds) => Math.Clamp(seconds, 1, MaxPlayLimitSeconds);
    // The maximum play time is 0 (off) or at least the minimum: under advance-on-end a maximum below the minimum would
    // always win for a video and never apply to a scene (docs/decisions.md § "A scene's minimum play time beats its
    // maximum"), so it is stored as the minimum — it follows the minimum up. With advance-on-end off the interval is
    // "Switch every", no minimum, and the maximum is left alone. Guard: test-settings-merge.sh "0 (off) or at least the minimum"
    public static int RotationMax(bool advance, int minSeconds, int maxSeconds)
    {
        int max = PlayLimit(maxSeconds);
        return advance && max > 0 && max < minSeconds ? PlayLimit(minSeconds) : max;
    }
    // every settings save (SettingsService.Save): field setters can't, a body's keys arrive in any order
    public void NormalizeRotation() => GlobalMaxPlaySeconds = RotationMax(GlobalSwitchWhenVideoEnds, GlobalIntervalSeconds, GlobalMaxPlaySeconds);
    // "When the playlist starts again" (docs/decisions.md § "Fold "Resume from last" into the playlist start setting";
    // liascape-player — the program's
    // `start_mode`): "start_over" (default — sequential from the first wallpaper, shuffle shuffles anew) | "resume"
    // (the exact item, time and play time). A playlist's own PlaylistSettings.PlaylistStart beats it under its
    // override. Read at the next start only (a change never jumps the current play). Folds in the old
    // "Resume from last on launch" (ResumeFromLast, removed — an old file's key loads as an unknown one).
    private string _globalPlaylistStart = "start_over";
    public string GlobalPlaylistStart { get => _globalPlaylistStart; set => _globalPlaylistStart = PlaylistStartMode(value); }
    public static string PlaylistStartMode(string? v) => v?.Trim().ToLowerInvariant() is "resume" ? "resume" : "start_over";
    public const int MaxPlayLimitSeconds = 359999; // 99:59:59, the UI's h/m/s fields
    // Pause when covered (liascape-player — `player.pause_when_covered`, live): the wallpaper (picture and
    // sound) pauses while every monitor showing it is covered. "off" | "fullscreen" (a fullscreen window) | "maximized"
    // (default — a fullscreen or maximized window). An unknown value reads as the default. The player prop's own default
    // is off; the backend asserts this one on every player process.
    private string _pauseWhenCovered = "maximized";
    public string PauseWhenCovered { get => _pauseWhenCovered; set => _pauseWhenCovered = CoverMode(value); }
    public static string CoverMode(string? v) => v?.Trim().ToLowerInvariant() switch { "off" => "off", "fullscreen" => "fullscreen", _ => "maximized" };
    // RotateWhileParked (O2, an Expert-level row) — "When no monitor shows the wallpaper": true = keep rotating invisibly
    // (default, today's behaviour), false = hold both clocks until a monitor returns (`prog:main.while_parked` rotate | hold).
    public bool RotateWhileParked { get; set; } = true;

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
    // Rust player). Switching applies
    // live (/settings → PlayerHelper.SwitchEngineLive). See .claude/rules/backend/player-adapter.md.
    public string PlayerEngine { get; set; } = "legacy";
    // What the volume keybinds (`liascape volume up|down`, `/volume {delta}`) move — Advanced setting:
    // "auto" = the playing wallpaper's own volume when it has one, else the global; "item" = always the
    // playing wallpaper's own (creating its override); "global" = always the global (a wallpaper with its own
    // volume doesn't move). PlayerHelper.AdjustVolume.
    public string VolumeKeyTarget { get; set; } = "auto";
    // liascape-player GPU / VRAM (all live: player-adapter.md § Scenes → "GPU / VRAM"; legacy: unused).
    // AutoThrottleScenes: a scene whose worker starves its outputs is throttled stepwise and restored (false = every
    // scene at its fixed fps) → `player.scene_throttle`.
    public bool AutoThrottleScenes { get; set; } = true;
    // Keep one scene renderer (liascape-scene-worker) started ahead of time while scenes are in use, so the next scene
    // starts ~0.1 s sooner; costs ~60 MB of memory (PSS) while it waits → `player.scene_spare` (only while AllowScenes).
    public bool SceneSpareWorker { get; set; } = true;
    // The per-scene VRAM guard: a scene worker using more than SceneVramLimitMib of VRAM is stopped (a rotation
    // advances, a single wallpaper shows what SceneVramStopShows says; never marked crashed) →
    // `player.scene_vram_limit_mib` (the MiB while enabled, else 0 = off). The MiB value is kept while off (the
    // toggle restores it).
    public bool LimitVramPerScene { get; set; } = false;
    // 2 GiB, not 1: measured over a real library with the player's own readout (docs/player/modules/scene-gpu-budget.md
    // § What scenes use), 1 GiB would stop about one scene in six, and the 90th percentile (~1.5 GiB) already sits
    // above it; 2 GiB keeps ~94 % playing with room for a bigger screen's frames, and still stops the few that take
    // 3 to 4 GiB.
    private int _sceneVramLimitMib = 2048;
    public int SceneVramLimitMib
    {
        get => _sceneVramLimitMib;
        set => _sceneVramLimitMib = Math.Clamp(value, 64, 1_048_576);
    }
    // What a scene the guard stopped shows: "last_frame" (its last frame stays) or "nothing" (its screens go black)
    // → `player.scene_vram_stop_shows`, live both ways. An unknown value reads as the default.
    private string _sceneVramStopShows = "last_frame";
    public string SceneVramStopShows
    {
        get => _sceneVramStopShows;
        set => _sceneVramStopShows = value?.ToLowerInvariant() is "last_frame" or "nothing" ? value.ToLowerInvariant() : "last_frame";
    }
    // When the GPU's VRAM runs low (system-wide, every source kind): "stop" (pause + free the sources' GPU memory),
    // "pause", or "off" → `player.vram_low_mode`. An unknown value reads as the default.
    private string _vramLowMode = "stop";
    public string VramLowMode
    {
        get => _vramLowMode;
        set => _vramLowMode = value is "stop" or "pause" or "off" ? value : "stop";
    }
    // liascape-player scenes: a text that names a Windows font (systemfont_consolas …) draws with the real one from the
    // user's own Windows install, read where it is → `player.scene_fonts` (LiascapePlayerMedia.SceneFontsProp: "off",
    // the folder, or "" = find a mounted install's Windows/Fonts). Live: the player replaces a playing scene's worker with
    // one that has the new fonts, its picture held (docs/player/modules/scene-lwe-core.md § Fonts).
    public bool UseWindowsFonts { get; set; } = true;
    public string WindowsFontsFolder { get; set; } = "";
    public bool AutoAddLibraryToPlaylist { get; set; } = false;
    // on by default: Workshop subscriptions live in the library (the Library's Delete of one is Unsubscribe; the Browse
    // sidebar's Download under the "subscribe" mode is Subscribe); a file that says false keeps false
    public bool AutoAddWeWallpapersToLibrary { get; set; } = true;
    public bool IsPlaylistBarCollapsed { get; set; } = false;
    // "steamapp" (the RUNNING Steam client subscribes, as Wallpaper Engine — Helpers/SteamClientUgc.cs: one click, Steam's
    // own progress; it FAILS when Steam can't be reached, never a fallback — WorkshopDownloader), "subscribe" (real
    // Steam subscription via the community endpoint with the sign-in, or the item's page in the Steam app without one),
    // "steampage" (always the item's page in the Steam app — the user clicks Subscribe there) or "steamcmd" (direct download).
    public string WorkshopDownloadMode { get; set; } = "subscribe";
    // The Steam client's steamclient.so for "steamapp"; empty = find it (~/.steam/sdk64, the Steam dir, Flatpak).
    public string SteamClientLibPath { get; set; } = "";
    // The Steam sign-in's SECRETS (refresh token, cached web cookie, pasted steamLoginSecure) live in Helpers/SecretStore.cs —
    // the system keyring, else ~/.config/liascape/steam-auth.json (docs/decisions.md § "Keep Steam tokens in the system
    // keyring, a 0600 file as fallback").
    public ulong SteamId { get; set; } = 0;
    public string SteamAccountName { get; set; } = "";
    // Steam refused the stored refresh token (finalizelogin AccessDenied — signed out on Steam's side: a password change, "sign
    // out of all devices"). Backend-owned (SettingsService.Patch keeps it); cleared by a new QR sign-in or a sign-out.
    public bool SteamSignInRejected { get; set; }
    public string SteamCmdPath { get; set; } = "";
    public string SteamUsername { get; set; } = "";
    public LastSession? LastSession { get; set; }

    public string BuildMpvOptions()
    {
        var parts = new List<string>();
        parts.Add("loop"); // a lone video always loops (docs/decisions.md § "A lone video always loops")
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
