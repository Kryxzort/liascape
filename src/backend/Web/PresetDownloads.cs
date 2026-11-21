using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Web;

// A Workshop preset can't play without its base scene (.claude/rules/backend/library.md § Presets), so getting a preset also
// gets its base, the way the preset came: the same download mode and the same action. Background work that never throws:
// a base it can't fetch leaves the preset "Needs its base scene", and the base's download card says why.
// .claude/rules/backend/sources-steam.md § Workshop downloads. Guard: scripts/test-steam-signin.sh § 2 (presets), § 3 k.
public static class PresetDownloads
{
    public const string WaitingForBase = "Waiting for Steam to download its base scene…";
    // the preset's own card while a "Download & apply" waits for its base
    public const string GettingBase = "Getting its base scene…";

    // a base being fetched + its route (subscribed, one-off, the Steam app) → that fetch: two presets of one scene downloaded
    // together the same way share it (one subscribe, one copy); a one-off and a subscribed preset each get their own
    static readonly Dictionary<string, Task> _fetching = new(StringComparer.Ordinal);
    // a preset's item folder → its base fetch while it runs: a "Download & apply" waits on it before it applies
    static readonly Dictionary<string, Task> _forPreset = new(StringComparer.Ordinal);

    /// A preset's base fetch (FetchBaseAsync, AddLocalBaseAsync) in the background, remembered under the preset's folder
    /// until it ends (`Pending`).
    public static void Start(LibraryItem preset, Func<Task> fetch)
    {
        var path = preset.VideoPath;
        Task t;
        lock (_forPreset)
        {
            t = fetch();
            if (t.IsCompleted) return;
            _forPreset[path] = t;
        }
        t.ContinueWith(_ => { lock (_forPreset) if (_forPreset.TryGetValue(path, out var cur) && cur == t) _forPreset.Remove(path); },
            TaskScheduler.Default);
    }

    /// The base fetch a preset's download started and that still runs, else null.
    public static Task? Pending(string presetPath)
    {
        lock (_forPreset) return _forPreset.GetValueOrDefault(presetPath);
    }

    static string PageUrl(string id) => $"https://steamcommunity.com/sharedfiles/filedetails/?id={id}";

    sealed record BaseFacts(bool Found, string? Title, string? Kind);

    /// After a preset's download (`/download`, plain or "Download without subscribing"): its base scene, unless the library has
    /// it. The base follows the preset's mode and action, never another route (docs/decisions.md § "Offer three Workshop
    /// download modes, the user's choice"): "Subscribe with Steam login" / "Use the Steam app" download it as the preset was
    /// (subscribed, or a one-off copy for a one-off preset); "Open in the Steam app" opened only the preset's page, whose
    /// required-items prompt is Steam's way to the base, so it waits for the base's folder with no page of its own and then
    /// imports it (a timeout leaves it) — unless the user handed the preset's Steam to-do entry to the Steam app ("Let the Steam
    /// app do all N", `viaSteamApp`): the client's subscribe shows no required-items prompt, so the base is subscribed through the
    /// client too. A base that isn't a scene is never fetched: its kind is saved and the preset says why.
    /// The base id: the preset file's `dependency`, else Steam's (WorkshopSocialOps.BaseOfAsync).
    public static async Task FetchBaseAsync(LibraryItem preset, bool oneOff, bool viaSteamApp = false)
    {
        string dir = preset.VideoPath, who = preset.WorkshopId ?? System.IO.Path.GetFileName(dir);
        string? baseId = null;
        try
        {
            if (Presets.Read(dir) is not { } file) return;
            WorkshopSocialOps.PresetBaseInfo? info = null;
            baseId = file.BaseId;
            if (baseId == null && preset.WorkshopId is { } pid)
            {
                info = await WorkshopSocialOps.BaseOfAsync(pid, CancellationToken.None).ConfigureAwait(false);
                baseId = info?.BaseId;
            }
            if (baseId == null || baseId == preset.WorkshopId) { Console.WriteLine($"workshop: {who}: a preset naming no base scene — nothing to fetch"); return; }
            if (Presets.BaseDirOf(baseId) != null)
            {
                Console.WriteLine($"workshop: {who}: its base {baseId} is in the library — reused");
                Done(preset);
                return;
            }
            var facts = await FactsAsync(preset.WorkshopId, baseId, info).ConfigureAwait(false);
            if (facts == null) { Fail(who, baseId, "Couldn't reach Steam to look up its base scene."); return; }
            if (!facts.Found) { Fail(who, baseId, $"Steam has no public item {baseId}, the base scene it names."); return; }
            if (facts.Title != null) LibraryStore.SetMeta(dir, m => m.BaseTitle = facts.Title);
            if (facts.Kind is { } kind && kind != "scene")
            {
                LibraryStore.SetMeta(dir, m => m.BaseKind = kind);
                Console.WriteLine($"workshop: {who}: its base {baseId} is a {kind} wallpaper — not fetched");
                EventBus.Broadcast("library-item-changed", new { path = dir, presetReason = Presets.StatusOf(dir, PlayerEngine.IsLiascapePlayer).Reason, baseTitle = facts.Title });
                return;
            }
            Task fetch;
            string key = $"{baseId}|{(oneOff ? "one-off" : viaSteamApp ? "steam-app" : "subscribed")}";
            lock (_fetching)
            {
                if (!_fetching.TryGetValue(key, out var running))
                {
                    var (id, title) = (baseId, facts.Title);
                    // started off the lock: FetchAsync's synchronous start reads the settings
                    running = Task.Run(() => FetchAsync(id, title, oneOff, viaSteamApp))
                        .ContinueWith(t => { lock (_fetching) _fetching.Remove(key); return t; }, TaskScheduler.Default).Unwrap();
                    _fetching[key] = running;
                }
                fetch = running;
            }
            await fetch.ConfigureAwait(false);
            if (Presets.BaseDirOf(baseId) != null) Done(preset);
        }
        catch (Exception e) when (baseId != null) { Fail(who, baseId, e.Message); }
        catch (Exception e) { Console.WriteLine($"workshop: {who}: fetching its base scene failed: {e.Message}"); }
    }

    /// After a preset is added from the Wallpaper Engine folder (Browse's "Wallpaper Engine (Local)", `presetDir` = its folder
    /// there): its base scene from the same folder, added the way the preset was (the same source's detail through
    /// AppOps.DownloadAsync: a link, or the library's own copy), unless the library has it. Nothing is asked of Steam and no
    /// download mode is involved; a base that isn't there (or isn't a scene) leaves the preset "Needs its base scene", whose
    /// button fetches it by the download mode. Never throws. Guard: test-presets.sh § 1 Wallpaper Engine (Local)
    public static async Task AddLocalBaseAsync(LibraryItem preset, string presetDir, bool oneOff)
    {
        string who = preset.WorkshopId ?? System.IO.Path.GetFileName(presetDir);
        try
        {
            if (Presets.Read(presetDir) is not { BaseId: { } baseId } || baseId == preset.WorkshopId) return;
            if (Presets.BaseDirOf(baseId) != null) { Done(preset); return; }
            if (System.IO.Path.GetDirectoryName(System.IO.Path.TrimEndingDirectorySeparator(presetDir)) is not { } weDir) return;
            string baseDir = System.IO.Path.Combine(weDir, baseId);
            if (Presets.KindOf(baseDir) != "scene")
            {
                Console.WriteLine($"workshop: {who}: its base {baseId} isn't a scene in the Wallpaper Engine folder — not added");
                return;
            }
            Console.WriteLine($"workshop: {who}: adding its base {baseId} from the Wallpaper Engine folder too");
            var detail = await new Liascape.Services.WallpaperEngineService().GetDetailAsync(new WallpaperResult
            { Title = TitleOf(baseDir) ?? baseId, ThumbnailUrl = "", PageUrl = baseDir, WorkshopId = baseId, IsScene = true }).ConfigureAwait(false);
            await AppOps.DownloadAsync(detail, "", baseDir, CancellationToken.None, null, oneOff).ConfigureAwait(false);
            if (Presets.BaseDirOf(baseId) != null) Done(preset);
        }
        catch (Exception e) { Console.WriteLine($"workshop: {who}: adding its base scene from the Wallpaper Engine folder failed: {e.Message}"); }
    }

    static string? TitleOf(string dir)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(System.IO.Path.Combine(dir, "project.json")));
            return doc.RootElement.TryGetProperty("title", out var t) && t.GetString() is { Length: > 0 } s ? s : null;
        }
        catch { return null; }
    }

    // the base's details from Steam: BaseOfAsync's when it names the same base (the shared details cache), else the base's own;
    // null = Steam couldn't be reached
    static async Task<BaseFacts?> FactsAsync(string? presetId, string baseId, WorkshopSocialOps.PresetBaseInfo? info)
    {
        try
        {
            if (info == null && presetId != null) info = await WorkshopSocialOps.BaseOfAsync(presetId, CancellationToken.None).ConfigureAwait(false);
            if (info?.BaseId == baseId) return new(info.Title != null || info.Kind != null, info.Title, info.Kind);
        }
        catch (Exception e) when (e is not OperationCanceledException) { Console.WriteLine($"workshop: {presetId}: Steam didn't say what its base is ({e.Message})"); }
        if (!ulong.TryParse(baseId, out var n)) return new(false, null, null);
        var got = await SteamWorkshopDetails.GetDetailsAsync([n]).ConfigureAwait(false);
        if (got == null) return null;
        return got.TryGetValue(n, out var d) && d.Found ? new(true, d.Title, WorkshopSocialOps.KindOf(d.Tags)) : new(false, null, null);
    }

    // the base by the download mode's own way, imported like any /download of it (its own card's events under its page URL)
    static async Task FetchAsync(string baseId, string? title, bool oneOff, bool viaSteamApp)
    {
        var s = SettingsService.Load();
        string page = PageUrl(baseId);
        var detail = await ServerHost.Workshop.GetDetailAsync(new WallpaperResult
        { Title = title ?? baseId, ThumbnailUrl = "", PageUrl = page, WorkshopId = baseId, IsScene = true }).ConfigureAwait(false);
        if (viaSteamApp)
        {
            // the preset's own route: the user's switch for that to-do batch, never the saved mode's page
            Console.WriteLine($"workshop: {baseId}: a preset's base — subscribing it through the Steam client, as the Steam to-do did the preset");
            var progress = new Progress<(double, string)>(t =>
                EventBus.Broadcast("download-progress", new { id = page, value = Math.Max(0, t.Item1), status = t.Item2 }));
            var r = await SteamClientUgc.SubscribeAsync(baseId, s, progress, CancellationToken.None).ConfigureAwait(false);
            if (r.Folder == null) throw new InvalidOperationException(SteamClientUgc.FailureMessage(r.Fallback));
        }
        else if (s.WorkshopDownloadMode == "steampage")
        {
            // a Steam page can't make a one-off (WorkshopDownloader.Blocked), so a one-off preset never gets here
            if (oneOff) throw new InvalidOperationException(WorkshopDownloader.OneOffPageOnly);
            Console.WriteLine($"workshop: {baseId}: a preset's base — waiting for Steam to download it (its required items), no page");
            var progress = new Progress<(double, string)>(t =>
                EventBus.Broadcast("download-progress", new { id = page, value = Math.Max(0, t.Item1), status = t.Item2 }));
            try { await WorkshopDownloader.WaitForSteamDeliveryAsync(baseId, s, progress, WaitingForBase, CancellationToken.None).ConfigureAwait(false); }
            catch (TimeoutException)
            {
                throw new InvalidOperationException("Steam didn't download its base scene. Accept the required items when Steam asks, or download the base scene itself.");
            }
        }
        else Console.WriteLine($"workshop: {baseId}: a preset's base — {(oneOff ? "downloading it without subscribing" : "downloading it")} like the preset");
        // "Open in the Steam app": the folder is there now (in one of Steam's Workshop folders), so this imports it without
        // opening anything
        await AppOps.DownloadAsync(detail, "", page, CancellationToken.None, null, oneOff).ConfigureAwait(false);
    }

    static void Done(LibraryItem preset)
    {
        EventBus.Broadcast("library-synced", new { count = 0 });
        LiascapePlayerProgram.PushItem(preset.VideoPath); // a rotation's skip flag for it follows
        SceneLoudnessOps.Imported(preset, "base"); // its loudness estimate needs the base's folder
    }

    static void Fail(string who, string baseId, string why)
    {
        Console.WriteLine($"workshop: {who}: its base {baseId} wasn't fetched — {why}");
        EventBus.Broadcast("download-progress", new { id = PageUrl(baseId), value = 0.0, error = why });
    }

    /// After a Subscribe (nothing imported) of a preset: its base scene is subscribed the same way when it is neither subscribed
    /// nor in the library. `/workshop/subscribe` under "Subscribe with Steam login" / "Use the Steam app": the mode's way; a
    /// Steam to-do entry the user handed to the Steam app ("Let the Steam app do all N", `viaSteamApp`): the Steam client's.
    /// "Open in the Steam app" otherwise relies on Steam's required-items prompt on the preset's page. A non-preset or a base
    /// that isn't a scene: nothing. Guard: test-steam-signin.sh § 2 (presets), § 3 k.
    public static async Task SubscribeBaseAsync(string presetId, bool viaSteamApp = false)
    {
        try
        {
            if (!viaSteamApp && SettingsService.Load().WorkshopDownloadMode == "steampage") return;
            var b = await WorkshopSocialOps.BaseOfAsync(presetId, CancellationToken.None).ConfigureAwait(false);
            if (b == null) return;
            if (b.Kind != "scene") { Console.WriteLine($"workshop: {presetId}: its base {b.BaseId} is {(b.Kind == null ? "not on Steam" : $"a {b.Kind} wallpaper")} — not subscribed"); return; }
            if (Presets.BaseDirOf(b.BaseId) != null || WorkshopSubOps.IsSubscribed(b.BaseId)) return;
            Console.WriteLine($"workshop: {presetId}: subscribed to a preset — subscribing its base {b.BaseId} too");
            await WorkshopSubOps.SubscribeAsync(b.BaseId, b.Title, viaSteamApp).ConfigureAwait(false);
        }
        catch (Exception e) { Console.WriteLine($"workshop: {presetId}: subscribing its base scene failed: {e.Message}"); }
    }
}

// A preset's base comes into the library, goes, or changes folder by many ways: a download (the needs-base "Download it
// again", Browse), the WE auto-import (a subscription, Steam's required-items prompt), a direct download handed over to
// Steam's folder, a folder import, trash and Undo. Each writes an index, so one pass after the writes settle compares every
// library preset's state (can it play, from which base folder) with the last pass; on a change a running rotation gets its
// items again (each preset's `skip` and `scene_dir`) and the pages re-read the library. A base that changes behind the
// library's back with no write (Steam re-filling the folder a link points at) shows at the next write or sync.
// Guard: scripts/test-liascape-player-adapter.sh § presets "the base back through the WE auto-import"
public static class PresetBases
{
    const int SettleMs = 300;
    static readonly object _gate = new(), _pass = new();
    static Timer? _timer;
    static bool _pending;
    static Dictionary<string, (PresetProblem Problem, string? BaseDir)>? _last;

    /// Start watching (serve only): the first pass is the reference, later ones report changes.
    public static void Watch()
    {
        LibraryStore.Saved += _ => Kick();
        Kick();
    }

    // a pass SettleMs after the first write of a burst, never pushed further back: a steady stream of writes (the facts
    // pass, loudness estimates) can't starve it; a write during a pass kicks the next
    static void Kick()
    {
        lock (_gate)
        {
            if (_pending) return;
            _pending = true;
            _timer ??= new Timer(_ => Pass(), null, Timeout.Infinite, Timeout.Infinite);
            _timer.Change(SettleMs, Timeout.Infinite);
        }
    }

    static void Pass()
    {
        lock (_gate) _pending = false;
        lock (_pass)
        {
            Dictionary<string, (PresetProblem, string?)> now;
            try { now = Snapshot(); }
            catch (Exception e) { Console.WriteLine($"library: checking the presets' base scenes failed: {e.Message}"); return; }
            var last = _last;
            _last = now;
            if (last == null || Same(last, now)) return;
            Console.WriteLine("library: a preset's base scene came, went or moved — a running rotation's items follow");
            LiascapePlayerProgram.PushItems();
            EventBus.Broadcast("library-synced", new { count = 0 });
        }
    }

    // every library preset → its state with the Liascape player (the engine changes nothing about where its base is)
    static Dictionary<string, (PresetProblem, string?)> Snapshot()
    {
        var map = new Dictionary<string, (PresetProblem, string?)>(StringComparer.Ordinal);
        foreach (var src in new[] { LibraryStore.Local, LibraryStore.Workshop, LibraryStore.Imported })
        {
            string[] dirs;
            try { dirs = System.IO.Directory.GetDirectories(LibraryStore.SourceDir(src)); } catch { continue; }
            foreach (var d in dirs)
                if (Presets.Read(d) != null)
                {
                    var st = Presets.StatusOf(d, liascapePlayer: true);
                    map[d] = (st.Problem, st.BaseDir);
                }
        }
        return map;
    }

    static bool Same(Dictionary<string, (PresetProblem, string?)> a, Dictionary<string, (PresetProblem, string?)> b) =>
        a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var v) && v == kv.Value);
}
