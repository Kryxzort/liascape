using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Player;
using Liascape.Scrapers;

namespace Liascape.Web;

// Backend orchestration for the play / download / trash flows, callable from the API endpoints.
public static class AppOps
{
    // FromPlaylist: the trashed items' (path, index) in the playlist, so an undo puts them back. `Hidden`: a Hide instead of a
    // trash (Helpers/HiddenItems.cs: the scope and the keys it newly hid, with their titles; the other fields empty): the same
    // Undo brings the cards back, as it does a removal. Guard: scripts/test-hidden.sh § undo
    private sealed record HideUndo(string Scope, List<(string Key, string? Title)> Keys);
    private sealed record UndoBatch(string BatchDir, List<LibraryItem> Items, List<(string Path, int Index)> FromPlaylist, HideUndo? Hidden = null);
    private static readonly List<UndoBatch> _undo = new();
    private static readonly object _undoLock = new();

    // ---- effective playlist settings (override-global vs global) ----
    private static int EffInterval(AppSettings s, PlaylistSettings p) =>
        p.OverrideGlobalSettings ? p.IntervalSeconds : s.GlobalIntervalSeconds;
    private static bool EffAdvance(AppSettings s, PlaylistSettings p) =>
        p.OverrideGlobalSettings ? p.SwitchWhenVideoEnds : s.GlobalSwitchWhenVideoEnds;

    // `paths` are already in the desired order (the UI sends the current playlist bar order).
    // `persistPaths` = what to save as the current playlist state when it differs from what plays (a trash playing on
    // from the session's own survivors keeps the playlist bar's).
    public static string PlayPlaylist(List<string> paths, PlaylistSettings ps, List<string>? persistPaths = null,
        int? playFrom = null)
    {
        if (paths.Count == 0) return "Playlist is empty";
        // a playlist of presets that can't play (their base gone) plays nothing: say why rather than leave the screen as
        // it was with no word. Guard: scripts/test-liascape-player-adapter.sh § presets
        // (a Workshop download Steam left empty too: test-item-actions.sh § incomplete)
        if (paths.All(p => PlayerHelper.UnplayableReason(p) != null)) return PlayerHelper.UnplayableReason(paths[0])!;
        // Persist what's actually playing as the current playlist state. TransitionService.CurrentConfig()
        // (the transition/crossfade gate) reads playlist_state.json — without this, /playlist/play only
        // saved LastSession, so the state stayed stale and scene switches never transitioned/crossfaded.
        try
        {
            var existing = PlaylistService.LoadCurrentState();
            PlaylistService.SaveCurrentState(new CustomPlaylist { VideoPaths = persistPaths ?? paths, Settings = ps, Name = existing?.Name ?? "" });
        }
        catch { }
        var s = SettingsService.Load();
        bool shuffle = ps.Order == PlaylistOrder.Shuffle;
        int interval = EffInterval(s, ps);   // advance-on-end: the minimum play time; else the timer

        if (PlayerStatus.MissingReason() is string missing) return missing;
        // the player's program — the bar's order (the player shuffles), the playlist's "When the
        // playlist starts again" (§ Playlist start: Start over / Resume), its identity = the bar's saved name
        bool adv = EffAdvance(s, ps);
        if (!adv && interval == 0 && paths.Count > 1) return "Set an interval greater than 0 to use timed playlists";
        var bar = PlaylistService.LoadCurrentState();
        // nothing in it can play (scenes off and every item a scene, …): refused with why, what plays is left alone and the
        // session isn't saved. Guard: scripts/test-liascape-player-adapter.sh § "a playlist with nothing playable"
        if (PlayerHelper.LoadProgram(paths, s, ps, shuffle, interval, adv, from: playFrom != null ? "index" : null, index: playFrom ?? 0,
                key: LiascapePlayerProgram.KeyOf(bar?.Name)) == null)
            return PlayerHelper.NoPlayableInPlaylist;
        Save(s, new LastSession { Paths = paths, Playlist = true });
        return "";
    }

    // Clicked path plays first, the rest follow (shuffled if shuffle).
    public static string PlayFrom(List<string> paths, int startIndex, PlaylistSettings ps)
    {
        if (paths.Count == 0 || startIndex < 0 || startIndex >= paths.Count || string.IsNullOrEmpty(paths[startIndex])) return "bad index";
        // the clicked item is a preset that can't play: refused with its reason, as /apply is, never quietly the item
        // after it. Guard: scripts/test-liascape-player-adapter.sh § presets
        if (PlayerHelper.UnplayableReason(paths[startIndex]) is string why) return why;
        // the program plays from that item (`from: index` — an explicit play-from beats the start setting) in the
        // playlist's own order; the player shuffles the rest of a shuffled cycle
        return PlayPlaylist(paths, ps, playFrom: startIndex);
    }

    // only LastSession: `s` was loaded before the switch, and saving it whole reverted any /settings change since
    private static void Save(AppSettings s, LastSession sess) { s.LastSession = sess; SettingsService.Update(x => x.LastSession = sess); }

    // animated preview in an acquired workshop folder (preview.gif/webp), if any
    private static string? ResolveLocalAnimatedPreview(string dir)
    {
        foreach (var ext in new[] { ".gif", ".webp" })
        {
            string f = System.IO.Path.Combine(dir, "preview" + ext);
            if (System.IO.File.Exists(f)) return f;
        }
        return null;
    }

    // Reveal the real media in the file manager. Scene → CopiedSceneDir or <WE>/<workshopId>;
    // video → resolve the symlink → reveal the file.
    // A crashed scene made playable again: the index mark cleared (LibraryService.ClearCrashed), a running rotation's skip
    // flag lifted (the player drops its own broken mark with it: docs/player/modules/programs.md), every page told.
    public static bool ClearCrash(string? path)
    {
        if (string.IsNullOrEmpty(path) || !LibraryService.ClearCrashed(path)) return false;
        LiascapePlayerProgram.PushItem(path);
        EventBus.Broadcast("library-item-changed", new { path, hasCrashed = false });
        return true;
    }

    // Settings → Housekeeping's "Clear crash marks": every marked item through ClearCrash, so each one's skip flag and page
    // event follow as for the sidebar's Clear. Returns how many it cleared.
    public static int ClearAllCrashes() =>
        LibraryService.LoadAll().Where(i => i.HasCrashed).Count(i => ClearCrash(i.VideoPath));

    // The resolved file (ApiSecurity.OpenableMedia) handed to xdg-open — the desktop's default app for its type. False = refused.
    public static bool OpenMedia(string? path)
    {
        if (ApiSecurity.OpenableMedia(path) is not { } real) return false;
        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { real }, UseShellExecute = false })?.Dispose(); } catch { }
        return true;
    }

    public static void RevealLibraryItem(string path, bool isScene, string? workshopId, string? copiedSceneDir)
    {
        string? dir = null, filePath = null;
        if (isScene)
        {
            if (!string.IsNullOrEmpty(copiedSceneDir) && Directory.Exists(copiedSceneDir)) dir = copiedSceneDir;
            else if (!string.IsNullOrEmpty(workshopId))
            {
                var wePath = SettingsService.Load().WorkshopFolder;
                if (!string.IsNullOrEmpty(wePath)) dir = Path.Combine(wePath, workshopId);
            }
        }
        if (dir == null)
        {
            string real = path;
            try { var t = File.ResolveLinkTarget(path, returnFinalTarget: true); if (t != null) real = t.FullName; } catch { }
            filePath = real;
            dir = Path.GetDirectoryName(real);
        }
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
        if (filePath != null && File.Exists(filePath) && TryShowItem(filePath)) return;
        try { Process.Start(new ProcessStartInfo("xdg-open") { ArgumentList = { dir }, UseShellExecute = false }); } catch { }
    }

    // dbus FileManager1.ShowItems — highlights the file in the file manager (vs just opening the dir).
    private static bool TryShowItem(string path)
    {
        try
        {
            string uri = new Uri(path).AbsoluteUri;
            var psi = new ProcessStartInfo("dbus-send") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in new[] { "--session", "--dest=org.freedesktop.FileManager1", "--type=method_call",
                "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems", $"array:string:{uri}", "string:" })
                psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi);
            proc?.WaitForExit(2000);
            return proc?.ExitCode == 0;
        }
        catch { return false; }
    }

    // ffprobe the video length in seconds.
    // ---- scene user properties (the card settings modal's "Scene properties"; .claude/rules/backend/library.md) ----
    private static bool IsSceneItem(string path) =>
        !string.IsNullOrEmpty(path) && PlayerHelper.IsScenePath(path) && Directory.Exists(path);

    // GET /library/scene-props: the scene's properties in display order, each with its effective value, default,
    // whether it's overridden and visible (its `condition` over the effective values). A change reaches the playing
    // scene at once. Guard: scripts/test-liascape-player-adapter.sh § Phase 2 ("GET /library/scene-props")
    public static object SceneProps(string path)
    {
        object props = IsSceneItem(path) ? SceneProperties.Describe(path, LibraryService.ReadSceneProps(path)) : Array.Empty<object>();
        return new { path, props };
    }

    // POST /library/scene-props: save (field-level, the index lock), then live. Returns an error or null.
    public static string? SetSceneProp(ServerHost.ScenePropReq r)
    {
        if (!IsSceneItem(r.Path)) return "not a scene item folder";
        string? err;
        if (r.Name == null) err = r.Reset ? LibraryService.SaveSceneProp(r.Path, null, null) : "name (or reset) required";
        else if (r.Reset) err = LibraryService.SaveSceneProp(r.Path, r.Name, null);
        else if (r.Value is not { } v || v.ValueKind == System.Text.Json.JsonValueKind.Undefined) err = "value required (or reset: true)";
        else err = LibraryService.SaveSceneProp(r.Path, r.Name, v);
        if (err == null)
        {
            // re-planned (its loudness configuration), then live
            PlayerHelper.ApplyScenePropsLive(r.Path);
        }
        return err;
    }

    // POST /library/scene-props/preview: the drag twin — this value on the item's live source(s), nothing saved.
    public static string? PreviewSceneProp(ServerHost.ScenePropReq r)
    {
        if (!IsSceneItem(r.Path)) return "not a scene item folder";
        if (r.Name == null || r.Value is not { } v) return "name and value required";
        if (SceneProperties.Find(r.Path, r.Name) is not { } p) return $"{r.Name}: no such property in this scene's project.json";
        if (SceneProperties.Coerce(p, v).Error is string e) return e;
        PlayerHelper.ApplyScenePropsLive(r.Path, new Dictionary<string, System.Text.Json.JsonElement> { [r.Name] = v });
        return null;
    }

    public static double GetDurationSeconds(string path)
    {
        try
        {
            var psi = new ProcessStartInfo("ffprobe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in new[] { "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", path })
                psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi);
            var output = proc?.StandardOutput.ReadToEnd().Trim();
            proc?.WaitForExit(4000);
            if (double.TryParse(output, NumberStyles.Float, CultureInfo.InvariantCulture, out double s)) return s;
        }
        catch { }
        return 0;
    }

    // Web-source download OR workshop acquire (the download mode's way) then import into the library. `oneOff` (a Workshop item's
    // "Download without subscribing"): WorkshopDownloader.AcquireOneOffAsync by the download mode's own route, the library's own
    // workshop/<id> copy, and a queued unsubscribe of it stays queued (the copy is the library's own, not a subscription's); a
    // subscription the route made only to fetch it is let go once the copy is made (or the import failed).
    // `library`: a web source's library folder (WebSource.Library), null for the rest
    // `delivered`: Steam's folder for it, already subscribed and on disk (a preset's base that came with it): imported as it is,
    // never acquired again (PresetDownloads.FetchAsync)
    public static async Task<LibraryItem> DownloadAsync(WallpaperDetail detail, string thumbnailUrl, string sourceId, CancellationToken ct, string? animatedUrl = null,
        bool oneOff = false, string? library = null, string? delivered = null)
    {
        var s = SettingsService.Load();
        var progress = new Progress<double>(v =>
            EventBus.Broadcast("download-progress", new { id = sourceId, value = v }));

        WallpaperDetail dl = detail;
        string? anim = animatedUrl;
        string? letGo = null; // a one-off's fetching subscription, unsubscribed once the library has its copy
        var route = WorkshopDownloader.Route.Direct; // how Steam's copy came (WorkshopDownloader.Took): a preset's base follows it
        try
        {
            if (detail.IsWorkshopAcquire && detail.WorkshopId != null)
            {
                var ap = new Progress<(double, string)>(t =>
                    EventBus.Broadcast("download-progress", new { id = sourceId, value = Math.Max(0, t.Item1), status = t.Item2 }));
                string dir;
                if (delivered != null) dir = delivered;
                else if (oneOff)
                {
                    var got = await WorkshopDownloader.AcquireOneOffAsync(detail.WorkshopId, s, ap, ct);
                    dir = got.Dir;
                    if (got.Subscribed) letGo = detail.WorkshopId;
                }
                else
                    // the Browse sidebar's toggle says "Subscribing…" meanwhile
                    using (WorkshopSubOps.Subscribing(detail.WorkshopId))
                    {
                        dir = await WorkshopDownloader.AcquireAsync(detail.WorkshopId, s, ap, ct, detail.Title);
                        route = WorkshopDownloader.Took(detail.WorkshopId);
                    }
                string url = dir;
                if (!detail.IsScene)
                {
                    var vf = await WorkshopDownloader.ResolveVideoFileAsync(dir);
                    if (!string.IsNullOrEmpty(vf)) url = vf;
                }
                // animated preview lives in the acquired workshop folder (preview.gif/webp)
                anim = ResolveLocalAnimatedPreview(dir) ?? anim;
                dl = new WallpaperDetail { Title = detail.Title, PreviewUrl = thumbnailUrl, DownloadUrl = url, IsScene = detail.IsScene, WorkshopId = detail.WorkshopId,
                    Resolution = detail.Resolution, AgeRating = detail.AgeRating, YoutubeUrl = detail.YoutubeUrl,
                    PageUrl = detail.PageUrl, AuthorName = detail.AuthorName, Description = detail.Description,
                    FileSizeBytes = detail.FileSizeBytes, Subscriptions = detail.Subscriptions,
                    Favorites = detail.Favorites, Tags = detail.Tags };
            }

            var item = await DownloadHelper.DownloadAsync(new DownloadHelper.Request(dl, sourceId)
            {
                ThumbnailUrl = thumbnailUrl, AnimatedUrl = anim, Library = library, CopyLocalFiles = s.CopyFilesInsteadOfSymlinking, OwnCopy = oneOff,
            }, detail.IsWorkshopAcquire ? null : progress, ct);
            if (item.WorkshopId is string wid && !oneOff) WorkshopUnsubQueue.Unblock(wid); // re-adding an item clears any pending unsubscribe
            SceneLoudnessOps.Imported(item, "download"); // a scene: its offline loudness estimate, in the background
            LibraryFactsOps.Kick("download"); // a web source's item: its frame size (a Workshop download saved Steam's tags)
            PreviewBackfill.Kick("download"); // its card's previews
            EventBus.Broadcast("download-progress", new { id = sourceId, value = 1.0, done = true });
            // a preset brings its base scene, by this download's own mode and action (in the background, never throws)
            if (detail.IsWorkshopAcquire && item.IsScene && Presets.Read(item.VideoPath) != null) PresetDownloads.Start(item, () => PresetDownloads.FetchBaseAsync(item, oneOff, route));
            // …and one added from the Wallpaper Engine folder (Browse's "Wallpaper Engine (Local)") its base from beside it
            else if (!detail.IsWorkshopAcquire && detail.WorkshopId != null && item.IsScene && Directory.Exists(detail.DownloadUrl)
                && Presets.Read(item.VideoPath) != null)
                PresetDownloads.Start(item, () => PresetDownloads.AddLocalBaseAsync(item, detail.DownloadUrl, oneOff));
            return item;
        }
        finally { if (letGo != null) WorkshopDownloader.LetGoOfOneOff(letGo); }
    }

    // A volume keybind (`liascape volume up|down`, `/volume {delta}`): PlayerHelper.AdjustVolume moves the
    // global or the playing wallpaper's own volume (`VolumeKeyTarget`); the UI holds its own copies of both
    // and saves the settings whole — tell it which one changed, or its next save / open modal reverts it.
    public static void VolumeKey(int delta)
    {
        if (PlayerHelper.AdjustVolume(delta) is string item)
            EventBus.Broadcast("library-item-changed", new { path = item, volumeOverride = LibraryService.ReadVolumeOverride(item) });
        else
            EventBus.Broadcast("settings-changed", new { volume = SettingsService.Load().Volume });
    }

    // The keybind actions, `liascape <action>` (the words of `liascape volume up` joined by `-`), run here or forwarded to a
    // running backend's `/action` (ActionForward); each one's whole work, by its name. An action returns what it has to
    // say (null = nothing). One that can't happen throws InvalidOperationException with why: next / previous / random or a
    // play when nothing in the library or the session can play (PlayerHelper.IsSkippedPath) — the same 409 as the
    // /next /prev /random routes.
    private static readonly Dictionary<string, Func<string?>> ActionTable = new()
    {
        ["toggle-mute"] = () =>
        {
            if (PlayerHelper.IsUserMuted) PlayerHelper.SetUserMute(false);
            // an auto-mute, the player's or the backend's monitor's, lifts without becoming the user's own mute
            else if (PlayerHelper.IsMuted || PlayerHelper.AutoMutedInPlayer) PlayerHelper.UnmuteAuto();
            else PlayerHelper.SetUserMute(true);
            return null;
        },
        ["toggle-pause"] = () =>
        {
            PlayerHelper.TogglePause();
            // the in-app background follows at once (a switch's resume reaches it through /current). Guard: probe-matrix pause:appBg
            EventBus.Broadcast("pause-changed", new { paused = PlayerHelper.IsPausedNow() });
            return null;
        },
        ["stop"] = StopAndSay,
        ["play"] = () => { PlayerHelper.Restore(); return null; },
        ["toggle-play"] = () =>
        {
            if (PlayerHelper.IsPlaying || LiascapePlayerProgram.IsActive) return StopAndSay();
            PlayerHelper.Restore();
            return null;
        },
        ["next"] = () => { PlayerHelper.NextWallpaper(); return null; },
        ["previous"] = () => { PlayerHelper.PreviousWallpaper(); return null; },
        ["random"] = () => { PlayerHelper.ApplyRandom(); return null; },
        ["volume-up"] = () => { VolumeKey(+5); return null; },
        ["volume-down"] = () => { VolumeKey(-5); return null; },
        ["toggle-loop-current"] = () => LoopCurrent(out var said) is string why ? throw new InvalidOperationException(why) : said,
    };

    // every open page hears that nothing plays now
    private static string? StopAndSay()
    {
        PlayerHelper.Stop();
        EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
        return null;
    }

    public static IReadOnlyCollection<string> Actions => ActionTable.Keys;

    public static string? RunAction(string action) => RunAction(action, out _);

    // null = done, else why it couldn't be done; `info` = what a done action has to say (the CLI prints it, the UI shows it)
    public static string? RunAction(string action, out string? info)
    {
        info = null;
        if (!ActionTable.TryGetValue(action, out var run)) return $"unknown action (one of: {string.Join(", ", Actions)})";
        try { info = run(); return null; }
        catch (InvalidOperationException e) { return e.Message; }
    }

    // `liascape toggle-loop-current` (a keybind to loop the current wallpaper indefinitely): toggles "keep
    // playing this one" — the rotation (the player's prog:main) stays on what plays, which loops, until toggled off; a
    // user switch still moves (and the keep holds that one), a Play of a playlist lifts it. The player keeps it across a
    // backend or player restart, and with the app closed the CLI toggles it straight on the player. A single wallpaper
    // (no rotation) already stays: said so, nothing changes. WS `toggle-loop-current {keep, path, message}` → the UI's status.
    public static string? LoopCurrent(out string? info)
    {
        info = null;
        var path = LiascapePlayerProgram.CurrentPath ?? PlayerHelper.QueryCurrentPath();
        string title = path == null ? "" : LibraryService.LoadAll().FirstOrDefault(i => i.VideoPath == path)?.Title ?? Path.GetFileNameWithoutExtension(path.TrimEnd('/'));
        if (!LiascapePlayerProgram.IsActive)
            return path == null ? "nothing is playing" : $"no playlist is rotating — {title} already stays on screen";
        if (LiascapePlayerProgram.ToggleKeep() is not bool keep) return "the player didn't answer — nothing changed";
        info = keep ? $"Looping {title}. The playlist stays on it until you toggle the loop again." : $"The playlist moves on again from {title}";
        EventBus.Broadcast("toggle-loop-current", new { keep, path, message = info });
        return null;
    }

    // The current playlist (the playlist bar) changed — `/playlist/state`, and a trash / undo that took items
    // out of it or put them back. Saved, then applied live to a running rotation.
    public static void SavePlaylistState(CustomPlaylist p)
    {
        var prevP = PlaylistService.LoadCurrentState();
        PlaylistService.SaveCurrentState(p);
        if (LiascapePlayerProgram.IsActive) ApplyToProgram(prevP, p);
    }

    // The playlist bar's save → the player's program, live, diffed prev → now (an unrelated save sends nothing): the
    // items (+ the bar's identity: another playlist loaded into the bar or "Save as" → its key, set first so the player
    // keeps the old one's resume point), the order, the effective limits / rotation / transition / start mode.
    private static void ApplyToProgram(CustomPlaylist? prevP, CustomPlaylist p)
    {
        bool orderChanged = (prevP?.Settings.Order ?? PlaylistOrder.Sequential) != p.Settings.Order;
        bool listChanged = prevP == null || !prevP.VideoPaths.SequenceEqual(p.VideoPaths);
        string key = LiascapePlayerProgram.KeyOf(p.Name);
        bool keyChanged = LiascapePlayerProgram.KeyOf(prevP?.Name) != key;
        if ((listChanged || keyChanged) && p.VideoPaths.Count > 0) LiascapePlayerProgram.SetItems(p.VideoPaths, key);
        if (orderChanged) LiascapePlayerProgram.SetOrder(p.Settings.Order == PlaylistOrder.Shuffle);
        var g = SettingsService.Load();
        var now = PlayerHelper.EffectiveRotation(g, p.Settings);
        var was = PlayerHelper.EffectiveRotation(g, prevP?.Settings);
        if ((now.Max, now.SeparateScenes, now.ScenesAfter) != (was.Max, was.SeparateScenes, was.ScenesAfter))
            LiascapePlayerProgram.SetLimits(now.Max, now.SeparateScenes, now.ScenesAfter);
        if ((now.Interval, now.Advance) != (was.Interval, was.Advance)) LiascapePlayerProgram.SetRotation(now.Interval, now.Advance);
        if (!TransitionService.SameConfig(TransitionService.Effective(g, prevP?.Settings), TransitionService.Effective(g, p.Settings)))
            LiascapePlayerProgram.SetTransition();
        var startNow = PlayerHelper.EffectiveStart(g, p.Settings);
        if (startNow != PlayerHelper.EffectiveStart(g, prevP?.Settings)) LiascapePlayerProgram.SetStartMode(startNow);
    }

    // Delete from source — enqueue the (durable) unsubscribe + soft-delete the entries; the unsubscribe reaches Steam after its
    // Undo window (SteamOps.DrainAfterUndoWindow).
    public static string DeleteFromSource(List<LibraryItem> items)
    {
        var ids = items.Where(i => i.WorkshopId != null).Select(i => i.WorkshopId!).Distinct().ToList();
        foreach (var i in items) if (i.WorkshopId != null) SteamTodo.RememberTitle(i.WorkshopId, i.Title); // its Steam to-do entry's name
        WorkshopUnsubQueue.AddPending(ids, hold: SteamOps.UnsubUndoWindow);
        var batch = Trash(items);
        if (ids.Count > 0) SteamOps.DrainAfterUndoWindow(ids);
        return batch;
    }

    // Soft-delete to trash. The items leave the playlist too (an undo puts them back where they were) —
    // live, so a running rotation never plays a trashed file — and when one was on screen (or about to
    // be: the incoming side of a switch), playback advances to the next survivor or stops.
    // `undoable` false: a removal the user didn't make (a watched folder's link whose file is gone, Web/FolderWatch.cs): the
    // items are deleted (LibraryService.Delete: a link is unlinked, its target never touched) with no Undo to offer.
    public static string Trash(List<LibraryItem> items, bool undoable = true)
    {
        if (items.Count == 0) return "";
        string batchDir = Path.Combine(LibraryService.TrashPath, Guid.NewGuid().ToString("N")[..8]);
        var done = new List<LibraryItem>();
        var shown = ShownOrIncoming();
        var pl = PlaylistService.LoadCurrentState();

        foreach (var item in items)
        {
            try { if (undoable) LibraryService.Trash(item, batchDir); else LibraryService.Delete(item); done.Add(item); } catch { }
        }
        if (done.Count == 0) return batchDir;
        // their preview clips live as long as they are in the library (an undo makes them again)
        foreach (var i in done) ClipStore.ForgetUnder(i.IsScene ? i.VideoPath : Path.GetDirectoryName(i.VideoPath) ?? i.VideoPath);
        var del = new HashSet<string>(done.Select(i => i.VideoPath));
        var removed = pl?.VideoPaths.Select((p, i) => (p, i)).Where(x => del.Contains(x.p)).ToList() ?? [];
        if (undoable) lock (_undoLock) _undo.Add(new UndoBatch(batchDir, done, removed));

        // a trashed base scene's presets can't play now: off screen like a trashed item, skipped by the rotation, but
        // they stay in the library and the playlist (Undo, or the base downloaded again, makes them playable)
        var off = PresetsOf(done).Where(p => !del.Contains(p) && PlayerHelper.PresetUnplayableReason(p) != null).ToHashSet();
        if (off.Count > 0) LiascapePlayerProgram.PushItems();
        var playing = shown.FirstOrDefault(p => del.Contains(p) || off.Contains(p));
        if (playing != null) StopOrAdvanceAfterDelete(playing, del, pl, off);
        else if (pl != null && removed.Count > 0)
            SavePlaylistState(new CustomPlaylist { VideoPaths = pl.VideoPaths.Where(p => !del.Contains(p)).ToList(), Settings = pl.Settings, Name = pl.Name });
        if (off.Count > 0) EventBus.Broadcast("library-synced", new { count = 0 }); // the Library greys them out
        return batchDir;
    }

    // The library's presets of these items when they are base scenes (by Workshop id: Presets.PresetPathsOf).
    // Guard: adapter IT § presets "the base trashed", scripts/test-presets.sh § 3
    private static List<string> PresetsOf(IEnumerable<LibraryItem> items)
    {
        var paths = new List<string>();
        foreach (var i in items)
        {
            if (!PlayerHelper.IsScenePath(i.VideoPath) || i.IsPreset) continue;
            var id = i.WorkshopId ?? (LibraryStore.Locate(i.VideoPath) is { Source: LibraryStore.Local or LibraryStore.Workshop } l ? l.Key : null);
            if (id != null) paths.AddRange(Presets.PresetPathsOf(id));
        }
        return paths.Distinct().ToList();
    }

    // what's on screen or about to be (either output, the incoming side of a switch), or parked while no output shows it
    private static List<string> ShownOrIncoming() => LiascapePlayerMedia.ShownOrIncomingPaths();

    // `playing` (trashed, or a preset of a trashed base: `off`) was on screen. A playlist session plays on from the next
    // surviving item after it (wrapping), like the old app; a single item / no playable survivor stops. `off` stays in
    // the playlist (its `skip` flag passes it by).
    private static void StopOrAdvanceAfterDelete(string playing, HashSet<string> del, CustomPlaylist? pl, IReadOnlySet<string> off)
    {
        if (LiascapePlayerProgram.IsActive)
        {
            // .claude/rules/backend/api.md § Session and playlist operations: the program's items lose it (the bar's survivors), then the rotation goes
            // on to the next survivor at once — the item after the trashed one's place (the reorder rule)
            var keep = (pl?.VideoPaths ?? LiascapePlayerProgram.Paths?.ToList() ?? []).Where(x => !del.Contains(x)).ToList();
            if (keep.Any(x => !off.Contains(x)))
            {
                if (pl != null) SavePlaylistState(new CustomPlaylist { VideoPaths = keep, Settings = pl.Settings, Name = pl.Name });
                else LiascapePlayerProgram.SetItems(keep);
                LiascapePlayerMedia.QueueNewSession(); // I1, as a play-from of the survivors: it plays on
                LiascapePlayerProgram.Next();
                return;
            }
            if (pl != null) SavePlaylistState(new CustomPlaylist { VideoPaths = keep, Settings = pl.Settings, Name = pl.Name });
            PlayerHelper.Stop();
            EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
            return;
        }
        var s = SettingsService.Load();
        var sess = s.LastSession;
        var playlistBar = pl?.VideoPaths ?? [];
        var survivors = playlistBar.Where(p => !del.Contains(p)).ToList();
        if (sess is { Playlist: true })
        {
            // the bar's settings as they are (order, rotation, transitions): a fresh PlaylistSettings would drop them
            var ps = pl?.Settings?.Clone() ?? new PlaylistSettings();
            int at = playlistBar.IndexOf(playing);
            if (at >= 0 && survivors.Count > 0)
            {
                // the next survivor that can play: a preset that can't is refused by PlayFrom, which would leave the trashed
                // item on screen; none left → stop
                var next = Enumerable.Range(1, playlistBar.Count).Select(k => playlistBar[(at + k) % playlistBar.Count])
                    .FirstOrDefault(p => !del.Contains(p) && PlayerHelper.PresetUnplayableReason(p) == null);
                // saves the playlist bar's survivors as the playlist; refused (none of them can play) → stopped below
                if (next != null && PlayFrom(survivors, survivors.IndexOf(next), ps) == "") return;
            }
            else
            {
                // the session plays something the playlist bar doesn't hold — play on from its own survivors
                var rest = sess.Paths.Where(p => !del.Contains(p)).ToList();
                if (rest.Count > 0 && PlayPlaylist(rest, ps, persistPaths: pl != null ? survivors : null) == "") return;
            }
        }
        if (pl != null && survivors.Count != playlistBar.Count)
            SavePlaylistState(new CustomPlaylist { VideoPaths = survivors, Settings = pl.Settings, Name = pl.Name });
        PlayerHelper.Stop();
        EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
    }

    // Kind: "trash" (items back in the library) or "hide" (cards shown again)
    public record UndoResult(bool Ok, int Count, string? Title, string? Message = null, string Kind = "trash");

    // A Hide the user made: the keys it newly hides (as the write found the file: another process may have hidden one
    // meanwhile) go on the Undo stack as one step (none new: nothing to undo). → the new state
    public static HiddenItems.State Hide(string scope, IReadOnlyDictionary<string, HiddenItems.Entry> entries)
    {
        lock (_undoLock)
        {
            var s = HiddenItems.Change(scope, entries, [], out var added);
            var fresh = added.Select(k => (k, entries[k].Title)).ToList();
            if (fresh.Count > 0) _undo.Add(new UndoBatch("", [], [], new HideUndo(scope, fresh)));
            EventBus.Broadcast("hidden-changed", s);
            return s;
        }
    }

    // the Hidden filter row's Unhide (not on the Undo stack: Hide is its way back)
    public static HiddenItems.State Unhide(string scope, IEnumerable<string> keys)
    {
        var s = HiddenItems.Change(scope, new Dictionary<string, HiddenItems.Entry>(), keys);
        EventBus.Broadcast("hidden-changed", s);
        return s;
    }

    // An Undo of a Delete from source takes its unsubscribes back first, in one step against the drain
    // (WorkshopUnsubQueue.Withdraw): one the drain is already sending makes it too late. Then nothing changes, the batch stays
    // on the stack and the words say so, never the item shown back while Steam unsubscribes it; Undo again once Steam has
    // answered brings it back and subscribes it again. Guard: test-steam-signin.sh § 3 i. "an Undo while the Steam client is
    // unsubscribing it"
    public static UndoResult Undo()
    {
        UndoBatch? batch;
        WorkshopUnsubQueue.Withdrawal w;
        lock (_undoLock)
        {
            if (_undo.Count == 0) return new(false, 0, null);
            batch = _undo[^1];
            if (batch.Hidden is { } h)
            {
                // the step goes only once its write landed: a write that failed (the file unreadable) leaves it for the next Undo
                var s = HiddenItems.Change(h.Scope, new Dictionary<string, HiddenItems.Entry>(), h.Keys.Select(k => k.Key));
                _undo.RemoveAt(_undo.Count - 1);
                EventBus.Broadcast("hidden-changed", s);
                return new(true, h.Keys.Count, h.Keys[0].Title, Kind: "hide");
            }
            w = WorkshopUnsubQueue.Withdraw(batch.Items.Select(i => i.WorkshopId).OfType<string>());
            if (w.Sending.Count > 0)
            {
                var title = batch.Items.FirstOrDefault(i => i.WorkshopId == w.Sending[0])?.Title;
                Console.WriteLine($"workshop: undo of {string.Join(", ", w.Sending)}: too late, its unsubscribe is out — nothing changed");
                return new(false, 0, null, w.Sending.Count == 1 && title != null
                    ? $"Too late to undo: Steam is unsubscribing {title} right now. Undo again in a moment to get it back and subscribe it again."
                    : "Too late to undo: Steam is unsubscribing them right now. Undo again in a moment to get them back and subscribe them again.");
            }
            _undo.RemoveAt(_undo.Count - 1);
        }
        RestoreUndo(batch, w.Unsubscribed);
        return new(true, batch.Items.Count, batch.Items.Count > 0 ? batch.Items[0].Title : null);
    }

    // puts a trash batch's items back. `withdrawn`:
    // Undo took the unsubscribes back already (WorkshopUnsubQueue.Withdraw), these ones Steam had done; null = take them back here
    private static void RestoreUndo(UndoBatch batch, IReadOnlyCollection<string>? withdrawn = null)
    {
        LibraryService.RestoreBatch(batch.BatchDir);
        // back into the playlist where they were (live — a running rotation picks them up again)
        if (batch.FromPlaylist.Count > 0 && PlaylistService.LoadCurrentState() is { } pl)
        {
            var paths = new List<string>(pl.VideoPaths);
            foreach (var (p, i) in batch.FromPlaylist.OrderBy(x => x.Index))
                if (!paths.Contains(p)) paths.Insert(Math.Min(i, paths.Count), p);
            if (!paths.SequenceEqual(pl.VideoPaths))
                SavePlaylistState(new CustomPlaylist { VideoPaths = paths, Settings = pl.Settings, Name = pl.Name });
        }
        // a base scene back: its presets play again (the rotation's `skip` flags, the Library's greyed cards)
        if (PresetsOf(batch.Items).Count > 0)
        {
            LiascapePlayerProgram.PushItems();
            EventBus.Broadcast("library-synced", new { count = 0 });
        }
        // undoing a "Delete from Source" un-queues the unsubscribe (a no-op for a plain delete), like the old app — and one
        // Steam already carried out is undone too: subscribed again (else the item comes back while Steam deletes its folder)
        var resub = new List<string>();
        var titles = new Dictionary<string, string>();
        foreach (var i in batch.Items)
        {
            if (i.WorkshopId is not string wid) continue;
            titles[wid] = i.Title;
            if (withdrawn != null ? withdrawn.Contains(wid) && !resub.Contains(wid) : WorkshopUnsubQueue.Restore(wid)) resub.Add(wid);
            SteamTodo.DropUnsubscribe(wid); // its unsubscribe still waited in the Steam to-do: nothing to click any more
        }
        if (resub.Count > 0)
            _ = Task.Run(async () =>
            {
                try
                {
                    var msg = await WorkshopDownloader.ResubscribeAsync(resub, SettingsService.Load(), CancellationToken.None, titles);
                    if (msg != null) EventBus.Broadcast("unsub-progress", new { done = 0, total = 0, currentId = "", finished = true, openedInSteam = resub.Count, message = msg });
                }
                catch (Exception e) { Console.WriteLine($"workshop: re-subscribing after undo failed: {e.Message}"); }
            });
    }

    public static int UndoDepth() { lock (_undoLock) return _undo.Count; }
    public static void PurgeTrash() => LibraryService.CleanTrash();

    // ---- the caches Settings → Housekeeping can clear ----
    // Each category is one folder of copies the app makes again on demand, under the cache dir its WRITER uses: the
    // backend's own under ~/.cache/liascape (ServerHost.PreviewCacheDir, WallpaperEngineScraper.GifThumbCacheDir,
    // ClipStore.Dir), the player's under $XDG_CACHE_HOME/liascape (else ~/.cache/liascape). A clear deletes only the
    // regular files directly in a category's folder (never a symlink, a subfolder or the folder itself, and never a
    // folder that is itself a link), and `Only` narrows a folder other files share (the logs sit beside settings-free
    // dev folders: history-*, src, we-ref), so nothing else there is in its reach. `Busy` names the files a writer is still making: they are neither counted nor deleted, so a
    // clear mid-write never breaks the writer (each writes a temporary name and renames it into place). The ids are the
    // UI's (Settings.tsx CACHE_LINES). Guard: scripts/test-cache-clear.sh; probe-settings cache:*
    public sealed record CacheCategory(string Id, Func<string> Dir, Func<string, bool> Busy, Func<string, bool>? Only = null);
    // a log's name: `<name>.log` (being written: emptied in place, its writer appends on) or a rotated `<name>.log.<n>` (deleted)
    private static bool IsLog(string f) { var n = Path.GetFileName(f); int i = n.LastIndexOf(".log", StringComparison.Ordinal);
        return i > 0 && (i + 4 == n.Length || (n[i + 4] == '.' && n.Length > i + 5 && n[(i + 5)..].All(char.IsAsciiDigit))); }
    private static bool IsCurrentLog(string f) => f.EndsWith(".log", StringComparison.Ordinal);
    private static string HomeCache => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "liascape");
    private static string PlayerCache => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } x ? x
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"), "liascape");
    public static readonly CacheCategory[] CacheCategories =
    [
        // the /still frames and trimmed /anim GIFs of every card, Browse and Library: an extraction in flight owns its output
        // and its temporaries (ServerHost.Extracting)
        new("thumbs", () => ServerHost.PreviewCacheDir, ServerHost.Extracting),
        // the Wallpaper Engine folder's still frames for Browse (ffmpeg writes `<id>.jpg.tmp`, then renames)
        new("we-thumbs", () => WallpaperEngineScraper.GifThumbCacheDir, f => f.EndsWith(".tmp", StringComparison.Ordinal)),
        // the cards' video preview clips (ClipStore: an encode writes `<clip>.mp4.tmp`; ClipBusy keeps its item's `.src`)
        new("clips", () => ClipStore.Dir, f => f.EndsWith(".tmp", StringComparison.Ordinal)),
        // the scene loudness estimator's per-sound-file readings (`<hash>.json`, written as `<hash>.tmp<pid>`): gone, the next
        // estimate decodes each file again; the scenes' saved loudness (index.json) stays
        new("scene-loudness", () => Path.Combine(PlayerCache, "scene-loudness"), f => Path.GetExtension(f).StartsWith(".tmp", StringComparison.Ordinal)),
        // album art the scene worker fetched for media-aware scenes (curl writes `<hash>.part`, then renames)
        new("media-art", () => Path.Combine(PlayerCache, "media-art"), f => f.EndsWith(".part", StringComparison.Ordinal)),
        // the LWE core's shader text work (`<hash>.<kind>`, written as `….<pid>.<n>.tmp`): a missing entry is a miss that
        // redoes the work (docs/player/modules/scene-lwe-core.md § Shader cache)
        new("shaders", () => Path.Combine(PlayerCache, "lwe-shaders"), f => f.EndsWith(".tmp", StringComparison.Ordinal)),
        // the app's debug logs, directly in ~/.cache/liascape: every writer appends (the player's serve log too:
        // LiascapePlayerClient.Spawn), so a current log is emptied in place and its writer carries on at the new end
        new("logs", () => HomeCache, _ => false, IsLog),
    ];
    public static CacheCategory? CacheCategoryOf(string id) => Array.Find(CacheCategories, c => c.Id == id);

    // the files a clear of `c` would delete now: regular files directly in its folder, not busy. A clip item's `.src` (its
    // source path, read when the clip is made and swept) stays while one of its clips is still being encoded.
    private static List<FileInfo> CacheFiles(CacheCategory c)
    {
        var d = new DirectoryInfo(c.Dir());
        try { if (!d.Exists || d.LinkTarget != null) return []; } catch { return []; }
        FileInfo[] all;
        try { all = d.GetFiles(); } catch { return []; }
        var files = all.Where(f => (f.Attributes & FileAttributes.ReparsePoint) == 0 && !c.Busy(f.FullName) && (c.Only?.Invoke(f.FullName) ?? true)).ToList();
        if (c.Id == "clips")
        {
            var encoding = all.Where(f => c.Busy(f.FullName)).Select(f => f.Name.Split('_')[0]).ToHashSet();
            files.RemoveAll(f => f.Name.EndsWith(".src", StringComparison.Ordinal) && encoding.Contains(Path.GetFileNameWithoutExtension(f.Name)));
        }
        return files;
    }

    public sealed record CacheSize(string Id, long Bytes, int Count);
    public static CacheSize SizeOf(CacheCategory c)
    {
        long bytes = 0; int count = 0;
        foreach (var f in CacheFiles(c))
            try { bytes += f.Length; count++; } catch { }
        return new(c.Id, bytes, count);
    }

    // FreedBytes / Count: what this clear deleted; Bytes: what the category still holds (a file a writer finished meanwhile)
    public sealed record CacheCleared(string Id, long FreedBytes, int Count, long Bytes);
    private static readonly object _cacheClearLock = new();
    public static List<CacheCleared> ClearCaches(IEnumerable<CacheCategory> cats)
    {
        lock (_cacheClearLock)
            return cats.Select(c =>
            {
                long freed = 0; int count = 0;
                foreach (var f in CacheFiles(c))
                    try
                    {
                        long n = f.Length;
                        if (c.Id == "logs" && IsCurrentLog(f.FullName))
                            using (var s = new FileStream(f.FullName, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) s.SetLength(0);
                        else f.Delete();
                        freed += n; count++;
                    }
                    catch { }
                return new CacheCleared(c.Id, freed, count, SizeOf(c).Bytes);
            }).ToList();
    }
}
