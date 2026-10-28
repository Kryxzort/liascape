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

namespace Liascape.Web;

// Backend orchestration for the play / download / trash flows, callable from the API endpoints.
public static class AppOps
{
    // FromPlaylist: the trashed items' (path, index) in the playlist, so an undo puts them back
    private sealed record UndoBatch(string BatchDir, List<LibraryItem> Items, List<(string Path, int Index)> FromPlaylist);
    private static readonly List<UndoBatch> _undo = new();
    private static readonly object _undoLock = new();

    // ---- effective playlist settings (override-global vs global) ----
    private static int EffInterval(AppSettings s, PlaylistSettings p) =>
        p.OverrideGlobalSettings ? p.IntervalSeconds : s.GlobalIntervalSeconds;
    private static bool EffAdvance(AppSettings s, PlaylistSettings p) =>
        p.OverrideGlobalSettings ? p.AdvanceOnVideoEnd : s.GlobalAdvanceOnVideoEnd;

    // `paths` are already in the desired order (the UI sends the current strip order).
    // `persist` / `persistPaths` = what to save as the current playlist state when it differs from what
    // plays (play-from plays a pre-arranged order but keeps the playlist's own Order setting and the
    // strip's own order — saving the play order reordered the strip on the next launch).
    public static string PlayPlaylist(List<string> paths, PlaylistSettings ps, PlaylistSettings? persist = null, List<string>? persistPaths = null)
    {
        if (paths.Count == 0) return "Playlist is empty";
        // Persist what's actually playing as the current playlist state. TransitionService.CurrentConfig()
        // (the transition/crossfade gate) reads playlist_state.json — without this, /playlist/play only
        // saved LastSession, so the state stayed stale and scene switches never transitioned/crossfaded.
        try
        {
            var existing = PlaylistService.LoadCurrentState();
            PlaylistService.SaveCurrentState(new CustomPlaylist { VideoPaths = persistPaths ?? paths, Settings = persist ?? ps, Name = existing?.Name ?? "" });
        }
        catch { }
        var s = SettingsService.Load();
        bool shuffle = ps.Order == PlaylistOrder.Shuffle;
        int interval = EffInterval(s, ps);   // advance-on-end: the minimum play time; else the timer

        if (EffAdvance(s, ps))
        {
            // always the timed machinery, whatever the minimum (0 = switch at every end is an ordinary value now): a
            // minimum of 0 used to go through ApplyPlaylist, where one item (a trash leaving one survivor, a one-item
            // playlist) became a plain non-timed launch — an Undo growing it back then had no rotation to re-arm
            var play = shuffle ? paths.OrderBy(_ => Guid.NewGuid()).ToList() : paths;
            PlayerHelper.ApplyTimedPlaylist(play, s.BuildMpvOptions(), shuffle, interval, advanceOnVideoEnd: true);
            Save(s, new LastSession { IsTimedPlaylist = true, Paths = paths, Shuffle = shuffle, TimedIntervalSeconds = interval, AdvanceOnVideoEnd = true, OverrideGlobalSettings = ps.OverrideGlobalSettings });
            return "";
        }

        if (interval == 0 && paths.Count > 1) return "Set an interval greater than 0 to use timed playlists";
        var timed = shuffle ? paths.OrderBy(_ => Guid.NewGuid()).ToList() : paths;
        PlayerHelper.ApplyTimedPlaylist(timed, s.BuildMpvOptions(), shuffle, interval);
        Save(s, new LastSession { IsTimedPlaylist = true, Paths = paths, Shuffle = shuffle, TimedIntervalSeconds = interval, AdvanceOnVideoEnd = false, OverrideGlobalSettings = ps.OverrideGlobalSettings });
        return "";
    }

    // Clicked path plays first, the rest follow (shuffled if shuffle).
    public static string PlayFrom(List<string> paths, int startIndex, PlaylistSettings ps)
    {
        if (paths.Count == 0 || startIndex < 0 || startIndex >= paths.Count) return "bad index";
        bool shuffle = ps.Order == PlaylistOrder.Shuffle;
        var rest = paths.Where((_, i) => i != startIndex).ToList();
        if (shuffle) rest = rest.OrderBy(_ => Guid.NewGuid()).ToList();
        var ordered = new List<string> { paths[startIndex] }.Concat(rest).ToList();
        // Clone, never rebuild: a hand-copied subset dropped every transition field (play-from
        // switched transitions off). Plays the pre-arranged order; saves the playlist's own Order.
        var play = ps.Clone();
        play.Order = PlaylistOrder.Sequential; // pre-arranged; don't reshuffle
        return PlayPlaylist(ordered, play, persist: ps, persistPaths: paths);
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
    public static void RevealLibraryItem(string path, bool isScene, string? workshopId, string? copiedSceneDir)
    {
        string? dir = null, filePath = null;
        if (isScene)
        {
            if (!string.IsNullOrEmpty(copiedSceneDir) && Directory.Exists(copiedSceneDir)) dir = copiedSceneDir;
            else if (!string.IsNullOrEmpty(workshopId))
            {
                var wePath = SettingsService.Load().WallpaperEnginePath;
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
    // ---- scene user properties (the item settings modal's "Scene properties"; library.md) ----
    private static bool IsSceneItem(string path) =>
        !string.IsNullOrEmpty(path) && PlayerHelper.IsScenePath(path) && Directory.Exists(path);

    // GET /library/scene-props: the scene's properties in display order, each with its effective value, default,
    // whether it's overridden and visible (its `condition` over the effective values). `live` = a change reaches
    // the playing scene at once (liascape-player); legacy applies them at the scene's next start (LWE --set-property).
    public static object SceneProps(string path)
    {
        bool onPlayer = PlayerEngine.IsLiascapePlayer;
        object props = IsSceneItem(path) ? SceneProperties.Describe(path, LibraryService.ReadSceneProps(path)) : Array.Empty<object>();
        return new
        {
            path, engine = onPlayer ? "liascape-player" : "legacy", live = onPlayer,
            note = onPlayer ? null : "Applied when the scene starts — the legacy engine can't change them while it plays",
            props,
        };
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
        if (err == null) PlayerHelper.ApplyScenePropsLive(r.Path);
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

    // Web-source download OR workshop acquire (subscribe/steamcmd) then import into the library.
    public static async Task<LibraryItem> DownloadAsync(WallpaperDetail detail, string thumbnailUrl, string sourceId, CancellationToken ct, string? animatedUrl = null)
    {
        var s = SettingsService.Load();
        var progress = new Progress<double>(v =>
            EventBus.Broadcast("download-progress", new { id = sourceId, value = v }));

        WallpaperDetail dl = detail;
        string? anim = animatedUrl;
        if (detail.IsWorkshopAcquire && detail.WorkshopId != null)
        {
            var ap = new Progress<(double, string)>(t =>
                EventBus.Broadcast("download-progress", new { id = sourceId, value = Math.Max(0, t.Item1), status = t.Item2 }));
            string dir = await WorkshopDownloader.AcquireAsync(detail.WorkshopId, s, ap, ct);
            string url = dir;
            if (!detail.IsScene)
            {
                var vf = await WorkshopDownloader.ResolveVideoFileAsync(dir);
                if (!string.IsNullOrEmpty(vf)) url = vf;
            }
            // animated preview lives in the acquired workshop folder (preview.gif/webp)
            anim = ResolveLocalAnimatedPreview(dir) ?? anim;
            dl = new WallpaperDetail { Title = detail.Title, PreviewUrl = thumbnailUrl, DownloadUrl = url, IsScene = detail.IsScene, WorkshopId = detail.WorkshopId, NeedsReferrer = false,
                Resolution = detail.Resolution, AgeRating = detail.AgeRating, YoutubeUrl = detail.YoutubeUrl,
                PageUrl = detail.PageUrl, AuthorName = detail.AuthorName, Description = detail.Description,
                FileSizeBytes = detail.FileSizeBytes, Subscriptions = detail.Subscriptions,
                Favorites = detail.Favorites, Views = detail.Views, Tags = detail.Tags };
        }

        var item = await DownloadHelper.DownloadAsync(dl, thumbnailUrl, sourceId, detail.IsWorkshopAcquire ? null : progress, s.WeCopyFiles, ct, animatedUrl: anim);
        if (item.WorkshopId is string wid) WorkshopUnsubQueue.Unblock(wid); // re-adding an item clears any pending unsubscribe
        EventBus.Broadcast("download-progress", new { id = sourceId, value = 1.0, done = true });
        return item;
    }

    // A volume keybind (`--action=volume-up|down`, `/volume {delta}`): PlayerHelper.AdjustVolume moves the
    // global or the playing wallpaper's own volume (`VolumeKeyTarget`); the UI holds its own copies of both
    // and saves the settings whole — tell it which one changed, or its next save / open modal reverts it.
    public static void VolumeKey(int delta)
    {
        if (PlayerHelper.AdjustVolume(delta) is string item)
            EventBus.Broadcast("library-item-changed", new { path = item, volumeOverride = LibraryService.ReadVolumeOverride(item) });
        else
            EventBus.Broadcast("settings-changed", new { volume = SettingsService.Load().Volume });
    }

    // The keybind actions (`--action=<name>`, forwarded to a running backend's `/action` — ActionForward).
    // null = done; else the reason it couldn't run. next-wallpaper/previous-wallpaper/random (and
    // play/toggle-play's Restore()) throw when the library/session has no item playable under the
    // current engine (e.g. an all-scene library under liascape-player, PlayerHelper.IsSkippedPath) — reported
    // cleanly, same contract as the /next /prev /random HTTP routes.
    public static readonly string[] Actions = ["toggle-mute", "toggle-pause", "stop", "play", "toggle-play",
        "next-wallpaper", "previous-wallpaper", "random", "volume-up", "volume-down"];
    public static string? RunAction(string action)
    {
        if (!Actions.Contains(action)) return $"unknown action (one of: {string.Join(", ", Actions)})";
        try
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
                    EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
                    break;
                case "play":
                    PlayerHelper.Restore();
                    break;
                case "toggle-play":
                    if (PlayerHelper.IsPlaying || PlayerHelper.IsTimedPlaylistActive())
                    {
                        PlayerHelper.Stop();
                        EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
                    }
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
                case "volume-down":
                    VolumeKey(action == "volume-up" ? 5 : -5);
                    break;
            }
        }
        catch (InvalidOperationException e) { return e.Message; }
        return null;
    }

    // The current playlist (the strip) changed — `/playlist/state`, and a trash / undo that took items
    // out of it or put them back. Saved, then applied live to a running rotation.
    public static void SavePlaylistState(CustomPlaylist p)
    {
        var prevP = PlaylistService.LoadCurrentState();
        PlaylistService.SaveCurrentState(p);
        // Live-apply a rotation change (interval — the minimum under advance-on-end — / advance-on-end / the
        // maximum, or the override toggle) to
        // the RUNNING timed playlist — no replay. Diff the EFFECTIVE rotation vs the previously-saved
        // state so a plain reorder/add (which also POSTs state) never resets the countdown. When the
        // playlist follows globals, /settings owns the live-apply (this stays a no-op then).
        if (PlayerHelper.IsTimedPlaylistActive())
        {
            // Order (Sequential↔Shuffle) or the strip contents (drag-reorder / add / remove) changed →
            // reflect it on the RUNNING playlist live (keeps the current item playing + the countdown).
            // Diffed so a rotation/transition-only save doesn't needlessly re-shuffle. Reorder FIRST so
            // it rebuilds _timedPaths before the rotation re-chains the video-end wait.
            bool orderChanged = (prevP?.Settings.Order ?? PlaylistOrder.Sequential) != p.Settings.Order;
            bool listChanged = prevP == null || !prevP.VideoPaths.SequenceEqual(p.VideoPaths);
            if ((orderChanged || listChanged) && p.VideoPaths.Count > 0)
                PlayerHelper.ReorderPlaylist(p.VideoPaths, true, p.Settings.Order == PlaylistOrder.Shuffle, prevP?.VideoPaths);

            var g = SettingsService.Load();
            // the effective rotation, diffed prev → now: an unrelated save (a reorder, a transition) leaves the
            // countdown, the item's play time and an armed switch alone. The maximum + the scene timing first, so a
            // switch the rotation arms (advance-on-end just turned on) already reads them.
            var now = PlayerHelper.EffectiveRotation(g, p.Settings);
            var was = PlayerHelper.EffectiveRotation(g, prevP?.Settings);
            if ((now.Max, now.SeparateScenes, now.ScenesAfter) != (was.Max, was.SeparateScenes, was.ScenesAfter))
                PlayerHelper.ApplyPlayLimitsLive(now.Max, now.SeparateScenes, now.ScenesAfter);
            if ((now.Interval, now.Advance) != (was.Interval, was.Advance)) PlayerHelper.ApplyRotationLive(now.Interval, now.Advance);
            // the playlist's transitions changed (on/off, effects, duration): an armed aligned switch takes them
            if (!TransitionService.SameConfig(TransitionService.Effective(g, prevP?.Settings), TransitionService.Effective(g, p.Settings)))
                PlayerHelper.RearmAlignedSwitch();
        }
        
    }

    // Delete from source — enqueue the (durable) unsubscribe + soft-delete the entries.
    public static string DeleteFromSource(List<LibraryItem> items)
    {
        var ids = items.Where(i => i.WorkshopId != null).Select(i => i.WorkshopId!).Distinct();
        WorkshopUnsubQueue.AddPending(ids);
        return Trash(items);
    }

    // Soft-delete to trash. The items leave the playlist too (an undo puts them back where they were) —
    // live, so a running rotation never plays a trashed file — and when one was on screen (or about to
    // be: the incoming side of a switch), playback advances to the next survivor or stops.
    public static string Trash(List<LibraryItem> items)
    {
        if (items.Count == 0) return "";
        string batchDir = Path.Combine(LibraryService.TrashPath, Guid.NewGuid().ToString("N")[..8]);
        var done = new List<LibraryItem>();
        var shown = ShownOrIncoming();
        var pl = PlaylistService.LoadCurrentState();

        foreach (var item in items)
        {
            try { LibraryService.Trash(item, batchDir); done.Add(item); } catch { }
        }
        if (done.Count == 0) return batchDir;
        var del = new HashSet<string>(done.Select(i => i.VideoPath));
        var removed = pl?.VideoPaths.Select((p, i) => (p, i)).Where(x => del.Contains(x.p)).ToList() ?? [];
        lock (_undoLock) _undo.Add(new UndoBatch(batchDir, done, removed));

        var playing = shown.FirstOrDefault(del.Contains);
        if (playing != null) StopOrAdvanceAfterDelete(playing, del, pl);
        else if (pl != null && removed.Count > 0)
            SavePlaylistState(new CustomPlaylist { VideoPaths = pl.VideoPaths.Where(p => !del.Contains(p)).ToList(), Settings = pl.Settings, Name = pl.Name });
        return batchDir;
    }

    // what's on screen or about to be (liascape-player: either output, the incoming side of a switch; legacy:
    // the current file)
    private static List<string> ShownOrIncoming()
    {
        if (PlayerEngine.IsLiascapePlayer) return LiascapePlayerMedia.ShownOrIncomingPaths();
        return PlayerHelper.QueryCurrentPath() is string p ? [p] : [];
    }

    // `playing` (trashed) was on screen. A playlist session plays on from the next surviving item after
    // it (wrapping), like the old app; a single item / no survivor stops.
    private static void StopOrAdvanceAfterDelete(string playing, HashSet<string> del, CustomPlaylist? pl)
    {
        var s = SettingsService.Load();
        var sess = s.LastSession;
        bool isPlaylist = sess != null && (sess.IsPlaylist || sess.IsTimedPlaylist);
        var strip = pl?.VideoPaths ?? [];
        var survivors = strip.Where(p => !del.Contains(p)).ToList();
        if (isPlaylist && sess != null)
        {
            // Start from the current playlist's settings (transitions etc.) and take the
            // rotation from the session — a fresh PlaylistSettings dropped the transitions.
            var ps = pl?.Settings?.Clone() ?? new PlaylistSettings();
            ps.Order = sess.Shuffle ? PlaylistOrder.Shuffle : PlaylistOrder.Sequential;
            ps.OverrideGlobalSettings = sess.OverrideGlobalSettings;
            ps.IntervalSeconds = sess.TimedIntervalSeconds;
            ps.AdvanceOnVideoEnd = sess.AdvanceOnVideoEnd;
            int at = strip.IndexOf(playing);
            if (at >= 0 && survivors.Count > 0)
            {
                string next = Enumerable.Range(1, strip.Count).Select(k => strip[(at + k) % strip.Count]).First(p => !del.Contains(p));
                PlayFrom(survivors, survivors.IndexOf(next), ps); // saves the strip's survivors as the playlist
                return;
            }
            // the session plays something the strip doesn't hold — play on from its own survivors
            var rest = sess.Paths.Where(p => !del.Contains(p)).ToList();
            if (rest.Count > 0)
            {
                PlayPlaylist(rest, ps, persistPaths: pl != null ? survivors : null);
                return;
            }
        }
        if (pl != null && survivors.Count != strip.Count)
            SavePlaylistState(new CustomPlaylist { VideoPaths = survivors, Settings = pl.Settings, Name = pl.Name });
        PlayerHelper.Stop();
        EventBus.Broadcast("wallpaper-changed", new { path = (string?)null });
    }

    public record UndoResult(bool Ok, int Count, string? Title);
    public static UndoResult Undo()
    {
        UndoBatch? batch;
        lock (_undoLock)
        {
            if (_undo.Count == 0) return new(false, 0, null);
            batch = _undo[^1]; _undo.RemoveAt(_undo.Count - 1);
        }
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
        // undoing a "Delete from Source" un-queues the unsubscribe (a no-op for a plain delete), like the old app
        foreach (var i in batch.Items)
            if (i.WorkshopId is string wid) WorkshopUnsubQueue.Unblock(wid);
        return new(true, batch.Items.Count, batch.Items.Count > 0 ? batch.Items[0].Title : null);
    }

    public static int UndoDepth() { lock (_undoLock) return _undo.Count; }
    public static void PurgeTrash() => LibraryService.CleanTrash();
}
