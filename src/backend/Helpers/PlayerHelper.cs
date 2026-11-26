using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Helpers;

// The backend's playback entry points (apply, next / previous / random, stop, restore, pause, mute, volume, the live
// settings): each one a request to liascape-player, queued through LiascapePlayerMedia (.claude/rules/backend/player-adapter.md).
public static class PlayerHelper
{
    private static readonly object _lock = new();
    private static bool _isMuted;
    private static bool _autoMuted;
    private static bool _userMuted;

    public static bool IsPlaying => LiascapePlayerMedia.IsPlaying();

    public static bool IsUserMuted => _userMuted;
    public static bool IsMuted => _isMuted;

    // a rotation session is the player's program (`prog:main`)
    public static bool IsTimedPlaylistActive() => LiascapePlayerProgram.IsActive;

    private static string UserMuteStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "user_mute.state");

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
    // the VRAM guard stopped a scene (path, used MiB, limit MiB, the UI's text)
    public static Action<string, double, double, string>? OnSceneVramStoppedCb;
    // why no scene can play here (ScenesBlockedReason), or null once they can again
    public static Action<string?>? OnScenesBlockedCb;
    // the low-VRAM hold's message (VramHoldMessage) while it holds, null once it let go
    public static Action<string?>? OnVramHoldCb;
    public static Action<string?>? OnWallpaperChanged;

    public static void LoadUserMuteState()
    {
        try { _userMuted = File.Exists(UserMuteStatePath); _isMuted = _userMuted || _autoMuted; }
        catch { }
    }

    public static void Apply(string videoPath) => Apply(videoPath, keepPause: false);

    // `keepPause`: a user next/prev/random from a pause with "Stay paused when switching" on — the switch plays on the
    // still frames, no new session. Returns the queued switch (its corr, null when the player didn't take it), or null when
    // nothing was queued.
    private static Task<string?>? Apply(string videoPath, bool keepPause)
    {
        // a preset that can't play: its reason, never its plain base scene
        if (PresetUnplayableReason(videoPath) is string presetWhy) throw new InvalidOperationException(presetWhy);
        // no player binary: the reason, never a queued switch that can't start (a silent black screen)
        if (PlayerStatus.MissingReason() is string missing) throw new InvalidOperationException(missing);
        // scenes play when they're on and the player can (its worker + WE's assets) — else the reason. A crashed one
        // plays too: the user picked it, and a repeat crash only leaves its last frame up (OnSceneBroken); the crash
        // mark keeps it out of rotations (SkipScene). Guard: matrix crash:scene (the click after the mark)
        if (IsScenePath(videoPath) && PlayerStatus.SceneUnavailableReason(SettingsService.Load()) is string why)
            throw new InvalidOperationException(why);
        lock (_lock)
        {
            // a single wallpaper replaces a rotation: `destroy prog:main` queued before the switch
            LiascapePlayerProgram.End();
            // I1: a new session plays — unless it's a user next/prev/random keeping the pause
            if (!keepPause) LiascapePlayerMedia.QueueNewSession();
            return SwitchToFile(videoPath);
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

    // The one switch chokepoint: ONE `transition` request (a cut when transitions are off) does the whole switch, a scene
    // too (`kind: scene`, kind-agnostic in the player). A scene that can't play stops playback here (the pickers never
    // hand one over).
    private static Task<string?>? SwitchToFile(string path)
    {
        var settings = SettingsService.Load();
        if (IsScenePath(path) && !PlayerStatus.ScenesPlayable(settings)) { LiascapePlayerMedia.QueueStop(); return null; }
        var cfg = TransitionService.CurrentConfig();
        // with its transition even while paused: the player plays it on the still frames and keeps the pause
        var switched = LiascapePlayerMedia.QueueSwitch(path, settings, cfg.Enabled ? cfg : null); // queued: we may hold _lock
        OnWallpaperChanged?.Invoke(path);
        return switched;
    }

    public static string? QueryCurrentPath() => LiascapePlayerMedia.CurrentPath();

    // the playing video's position (the in-app preview follows it)
    public static double? QueryTimePos() => LiascapePlayerMedia.Query("time_pos");

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
    // The decision travels with its own switch (never through shared state another Apply could take), and nothing
    // resumes before the switch has a target: a next/random with nothing to switch to leaves the pause alone.
    // Guard: scripts/test-liascape-player-adapter.sh § "a user switch from a pause"
    public static bool IsPausedNow() => LiascapePlayerMedia.IsPlayerPaused();

    // Before a user switch: whether the player is paused, and whether the switch keeps that pause (the setting on)
    private static (bool Paused, bool Keep) PauseOnUserSwitch() =>
        IsPausedNow() ? (true, SettingsService.Load().StayPausedWhenSwitching) : (false, false);

    // A rotation's verb from a pause that doesn't stay: `set player.paused false`, queued ahead of the verb
    private static void ResumeForRotation((bool Paused, bool Keep) p)
    {
        if (p.Paused && !p.Keep) LiascapePlayerMedia.QueueNewSession();
    }

    public static void NextWallpaper()
    {
        var pause = PauseOnUserSwitch();
        if (IsTimedPlaylistActive()) { ResumeForRotation(pause); LiascapePlayerProgram.Next(); return; }
        // Single-wallpaper sessions (single, random) — step the library.
        TryStepLibrary(forward: true, keepPause: pause.Keep);
    }

    public static void PreviousWallpaper()
    {
        // previous at the rotation's first item does nothing — and leaves a user pause alone (matrix
        // `programHeld × prog:previous`: resuming would be for a switch that cannot happen)
        if (IsTimedPlaylistActive() && LiascapePlayerProgram.PrevIsNoOp()) return;
        var pause = PauseOnUserSwitch();
        if (IsTimedPlaylistActive()) { ResumeForRotation(pause); LiascapePlayerProgram.Prev(); return; }
        TryStepLibrary(forward: false, keepPause: pause.Keep);
    }

    // For single-wallpaper sessions (no playlist context), `next`/`prev`
    // steps through the library alphabetically. Wraps at the ends. Returns
    // false when the session isn't a single wallpaper (nothing to step).
    //
    // Skips unplayable items (IsSkippedPath — scenes when !ScenesPlayable, the contract every
    // picker applies) by stepping further in the same direction, bounded to one full pass of
    // the library so an all-unplayable library can't spin forever. Throws InvalidOperationException (never calls Apply on an
    // unplayable path) when NOT ONE library item is playable — callers turn that into a
    // 4xx/clear message instead of letting Apply()'s own scene check 500 the request.
    private static bool TryStepLibrary(bool forward, bool keepPause)
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

        bool scenesOk = PlayerStatus.ScenesPlayable(settings);
        int pickIdx = newIdx;
        for (int attempts = 0; attempts < library.Count && IsSkippedPath(library[pickIdx].VideoPath, scenesOk); attempts++)
            pickIdx = forward ? (pickIdx + 1) % library.Count : (pickIdx - 1 + library.Count) % library.Count;

        if (IsSkippedPath(library[pickIdx].VideoPath, scenesOk))
            throw new InvalidOperationException(NoPlayableMessage);

        var pickPath = library[pickIdx].VideoPath;
        Apply(pickPath, keepPause);
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
        lock (_lock) LiascapePlayerMedia.QueueStop(); // every source ramped out and retired; the player process stays up
        LegacyTakeover.StopDaemons();
    }

    // `liascape restore` (boot / autostart), the `play` key, `toggle-play` from stopped. A player that isn't running is
    // started with its snapshot as a SESSION START (`serve --restore --session-start`): the player brings back what it
    // showed, and each restored program starts per its "When the playlist starts again" by itself (plan § Playlist
    // start: start over → item 1 / a fresh shuffle, the old item never shown; resume → the exact item and position).
    // Whatever the player then shows — a wallpaper (on screen, coming or parked) or a program — IS the session: done
    // (`play` while something plays does nothing). Nothing (first boot, after `stop`, no snapshot) → LastSession
    // replayed: a playlist as the program (`from` = its effective start mode — a Resume finds its point in the player's
    // resume.json), a single wallpaper applied. A replay that doesn't happen (nothing in it can play, the player refused
    // or didn't answer) throws with why: `liascape restore` says so and exits 1. Guard:
    // scripts/test-liascape-player-adapter.sh § "a restore whose last session can't play"
    public static void Restore()
    {
        var settings = SettingsService.Load();
        LegacyTakeover.Run();
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
            var switched = Apply(session.Paths[0], keepPause: false)
                ?? throw new InvalidOperationException($"the last wallpaper ({Path.GetFileName(session.Paths[0].TrimEnd('/'))}) can't play");
            if (!switched.Wait(15_000) || switched.Result == null)
                throw new InvalidOperationException($"liascape-player didn't take the switch to the last wallpaper ({Path.GetFileName(session.Paths[0].TrimEnd('/'))}): {LiascapePlayerClient.Shared.LastError ?? "see liascape-player-adapter.log"}");
            return;
        }
        var ps = PlaylistService.LoadCurrentState()?.Settings;
        var load = LoadProgram(session.Paths, settings, ps, session.Shuffle, session.TimedIntervalSeconds,
            session.IsTimedPlaylist ? session.SwitchWhenVideoEnds : true, from: null)
            ?? throw new InvalidOperationException(NoPlayableInPlaylist);
        // `liascape restore` exits right after: the load's own outcome, never a silent exit 0
        if (!load.Wait(15_000)) throw new InvalidOperationException("liascape-player didn't load the last session's playlist within 15 s");
        if (load.Result is string why) throw new InvalidOperationException($"the last session's playlist didn't load: {why}");
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
        var pause = PauseOnUserSwitch();
        if (IsTimedPlaylistActive()) { ResumeForRotation(pause); LiascapePlayerProgram.Random(); return; }
        ApplyRandomNow(pause.Keep);
    }

    private static void ApplyRandomNow(bool keepPause)
    {
        var settings = SettingsService.Load();
        var library = LibraryService.LoadAll();
        if (library.Count == 0) return;

        bool scenesOk = PlayerStatus.ScenesPlayable(settings);
        var pool = library.Select(i => i.VideoPath).Where(p => !IsSkippedPath(p, scenesOk)).ToList();
        if (pool.Count == 0)
            throw new InvalidOperationException(NoPlayableMessage);

        var current = settings.LastSession?.Paths.FirstOrDefault();
        var pick = PickRandomExcluding(pool, current);
        Apply(pick, keepPause);
        SettingsService.Update(s => s.LastSession = new LastSession { IsRandom = true, Paths = [pick] });
    }

    // the player owns the pause: one essential toggle that reads `player.paused` and sets the opposite
    public static void TogglePause()
    {
        lock (_lock) SendCommand("cycle", "pause");
    }

    // An mpv-style command (`set_property volume 80`, `cycle pause`): MpvPropertyMap translates it and
    // LiascapePlayerMedia queues it.
    public static void SendCommand(params object[] args) => LiascapePlayerMedia.Mpv(args);

    // Automute-driven mute. Updates _autoMuted always; blocked from sending unmute if user has explicitly muted.
    public static void SetMute(bool mute)
    {
        _autoMuted = mute;
        _isMuted = mute || _userMuted;
        if (!mute && _userMuted) return;
        SendCommand("set_property", "mute", _isMuted);
    }

    // The in-player auto-mute has every source muted: `gain.automute`, the player's own slot — `_autoMuted` and
    // `gain.mute` stay the user's there. Asked of the player, so a one-shot CLI process (the keybind, app closed) knows too.
    public static bool AutoMutedInPlayer => AudioMonitor.AutoMuteInPlayer && LiascapePlayerMedia.AutoMuteActive();

    // The user unmutes an auto-mute (toggle-mute, `POST /mute`): holds until the foreign audio ended, whoever auto-mutes
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
    }

    // `/volume {value}`: the playing item's volume, now (no persist)
    public static void SetVolume(int volume) => SendCommand("set_property", "volume", (double)volume);

    // The Settings page's global Volume/Speed drag preview (`/preview {global:true}`, no persist — the
    // UI's debounced /settings persists): every live wallpaper WITHOUT its own override for that field
    // takes the dragged value (effective = override ?? global); an overridden one never moves.
    public static void PreviewGlobal(int? volume, double? speed) => LiascapePlayerMedia.PreviewGlobal(volume, speed);

    // A per-wallpaper override changed: the resolver, on the source(s) showing THAT item (may be an in-flight
    // transition's pending B), seamlessly; coalescible — it re-reads the override when it runs. Effective = override ??
    // global, so clearing an override (index key dropped because it == global) snaps the item back to the global value.
    public static void ApplyOverrideLive(string path) => LiascapePlayerMedia.ApplyOverride(path);

    // A scene item's user properties changed (`/library/scene-props`, saved first): its live source(s) get the new
    // `scene_props` (the worker sets each changed one on the running scene — live, same worker); `preview` = a drag's
    // unsaved values (`/library/scene-props/preview`).
    public static void ApplyScenePropsLive(string path, IReadOnlyDictionary<string, System.Text.Json.JsonElement>? preview = null)
    {
        if (!IsScenePath(path)) return;
        if (preview != null) LiascapePlayerMedia.PreviewSceneProps(path, preview);
        else LiascapePlayerMedia.ApplySceneProps(path);
    }

    // `/settings` live-apply: ONE resolver pass (LiascapePlayerMedia.ApplyEffective) — every live source gets its own
    // effective volume/speed (override ?? global), af, mute and decode/buffer settings, and the layer its fit, each
    // diffed against what it runs (only what differs is sent; a no-op save sends nothing).
    public static void ApplyEffectiveLive() => LiascapePlayerMedia.ApplyEffective();

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
        var own = cur != null ? LibraryService.ReadVolumeOverride(cur) : null;
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
        // the resolver — every live source its own effective volume (an overridden one keeps it)
        LiascapePlayerMedia.ApplyEffective();
        return null;
    }

    // A scene's library path is its item FOLDER (workshop/<id> or local/<id> — a numeric-id dir, no
    // file extension); a video/image path always ends in a media extension. So "no extension" ⟺ scene.
    public static bool IsScenePath(string path) =>
        !string.IsNullOrEmpty(path) && Path.GetExtension(path).Length == 0;

    // Is this item skipped by the pickers (next/prev/random, a rotation's advance)? A scene when scenes
    // can't play, or (D6) when it is marked crashed and not whitelisted — what the sidebar's crash notice
    // promises ("rotations skip it"); a user's own apply still plays it (Apply). Pure — the self-test's truth table.
    public static bool SkipScene(bool isScene, bool playable, bool crashed, bool whitelisted) =>
        isScene && (!playable || (crashed && !whitelisted));

    // A preset that can't play now, and why (Presets.StatusOf, read fresh: its base missing, not a scene); null = not a
    // preset, or one that plays. Never played as its plain base: Apply refuses it with the reason and every picker and
    // the program's `skip` pass it by. Guard: player-selftest SceneSkipAssertions, adapter IT § presets
    public static string? PresetUnplayableReason(string path) =>
        IsScenePath(path) && Presets.Read(path) != null ? Presets.StatusOf(path).Reason : null;

    // `source.broken` (a scene's worker crashed past its restart budget, 3 in 60 s) → marked crashed in its index entry
    // (rotations skip it unless whitelisted, D6; a click still plays it), the UI told (WS `scene-crashed`), and — by
    // design — a rotation PLAYING it advances at once (the player's program; its skip flag follows the mark). A single
    // wallpaper keeps what the player shows (its last frame or preview, silent).
    public static void OnSceneBroken(string path)
    {
        if (string.IsNullOrEmpty(path) || !IsScenePath(path)) return;
        LibraryService.MarkCrashed(path);
        OnSceneCrashed?.Invoke(path);
        AdvanceIfPlaying(path, "scene broken while playing");
    }

    // `scene.vram_exceeded` — the player's VRAM guard stopped this scene's worker (it used more than
    // `player.scene_vram_limit_mib`). For playback exactly like a broken scene — a rotation playing it
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
    // renderer: LiascapePlayerClient.RendererMissing), else null: the UI greys every scene and preset card with it
    // (store unplayableReasonOf) and pickers and rotations already skip them (the player drops its `scene` capability
    // meanwhile: ScenesPlayable). Never a crash mark, or one broken install would mark every scene it reached. Never
    // waits: the latch as it stands, a fresh word asked off-thread (a change → WS scenes-blocked).
    public static string? ScenesBlockedReason
    {
        get
        {
            var c = LiascapePlayerClient.Shared;
            c.KickSceneWord();
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

    // the message while the low-VRAM hold holds, else null
    public static string? VramHoldNow =>
        LiascapePlayerClient.Shared.VramHold is { } h ? VramHoldMessage(h) : null;

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
        LiascapePlayerClient.Log($"{why}: {System.IO.Path.GetFileName(path)} — the player's program advances");
        LiascapePlayerProgram.PushItem(path);
    }

    // The pickers' rule for a program item's `skip` flag (LiascapePlayerProgram.BuildItems).
    public static bool SkippedForRotation(string path, bool scenesPlayable) => IsSkippedPath(path, scenesPlayable);

    // A program switch committed (`program.current`, its effect started): what every client is told plays. The program
    // measures nothing itself — every unmeasured video of it was kicked when its items were built, so with the app
    // closed only an item never measured before plays raw.
    public static void OnProgramSwitched(string path) => OnWallpaperChanged?.Invoke(path);

    // Load `paths` (the playlist bar's order; the player shuffles) as the player's program. `from`: "start" | "resume" |
    // "index" (+ `index` into `paths`); null = the playlist's effective start mode (a start: Play, a restore). Returns the
    // queued load (its result: null = loaded, else why not), or null when nothing in it can play — then nothing is
    // queued and what plays is left alone; the caller says why (NoPlayableInPlaylist).
    public static Task<string?>? LoadProgram(IReadOnlyList<string> paths, AppSettings s, PlaylistSettings? ps, bool shuffle, int intervalSeconds, bool advance,
        string? from, int index = 0, string? key = null)
    {
        if (paths.Count == 0) return null;
        var spec = LiascapePlayerProgram.BuildSpec(paths, s, ps, shuffle, intervalSeconds, advance, key);
        if (spec.Items.All(i => i.Skip))
        {
            LiascapePlayerClient.Log("program: no item of the playlist can play — not loaded");
            return null;
        }
        // the program's items are a set (a path listed twice is one item): the index of the chosen path there, not in
        // `paths`. Guard: scripts/test-liascape-player-adapter.sh § "play-from a path listed twice"
        if (from == "index")
            index = Math.Max(0, index >= 0 && index < paths.Count ? spec.Items.FindIndex(i => i.Path == paths[index]) : 0);
        from ??= EffectiveStart(s, ps) == "resume" ? "resume" : "start";
        return LiascapePlayerProgram.Load(spec, from, index, keepPause: false);
    }

    public const string NoPlayableInPlaylist =
        "Nothing in this playlist can play: scenes need \"Play scenes\" and Wallpaper Engine's assets, a crashed scene plays in a playlist only when whitelisted, and a preset needs its base scene";

    private const string NoPlayableMessage =
        "No playable wallpaper in the library — every item is a scene that can't play: scenes need \"Play scenes\" + Wallpaper Engine's assets (liascape-player), and a crashed scene plays only when whitelisted";

    // Same rule for a whole-library scan: resolve ScenesPlayable once (a settings load + the player's capability)
    // instead of once per scene item; the crash mark is one index read per scene.
    private static bool IsSkippedPath(string path, bool scenesPlayable)
    {
        if (!IsScenePath(path)) return false;
        if (!scenesPlayable || PresetUnplayableReason(path) != null) return true;
        var m = LibraryStore.GetMeta(path);
        return SkipScene(true, true, m?.Crashed ?? false, m?.Whitelist ?? false);
    }

    // A background loudness measurement just landed (LibraryService.EnsureLoudnessAsync; a scene's `scene.loudness`
    // goes through LiascapePlayerMedia.OnSceneLoudness instead — set once per play): with normalization on, the item may be
    // playing right now — unmeasured when it started (or when normalization was switched on), so it ran without
    // `gain.normalize` and nothing applied it once measured (until its next switch): every live source its own item's value.
    public static void OnLoudnessMeasured(string path)
    {
        try { if (SettingsService.Load().NormalizeAudio) LiascapePlayerMedia.ApplyEffective(); }
        catch { }
    }
}
