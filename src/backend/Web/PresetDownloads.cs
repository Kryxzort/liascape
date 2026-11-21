using System;
using System.Collections.Generic;
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

    // a base being fetched → that fetch: two presets of one scene downloaded together share it (one subscribe, one copy)
    static readonly Dictionary<string, Task> _fetching = new(StringComparer.Ordinal);

    static string PageUrl(string id) => $"https://steamcommunity.com/sharedfiles/filedetails/?id={id}";

    sealed record BaseFacts(bool Found, string? Title, string? Kind);

    /// After a preset's download (`/download`, plain or "Download without subscribing"): its base scene, unless the library has
    /// it. The base follows the preset's mode and action, never another route (docs/decisions.md § "Offer three Workshop
    /// download modes, the user's choice"): "Subscribe with Steam login" / "Use the Steam app" download it as the preset was
    /// (subscribed, or a one-off copy for a one-off preset); "Open in the Steam app" opened only the preset's page, whose
    /// required-items prompt is Steam's way to the base, so it waits for the base's folder with no page of its own and then
    /// imports it (a timeout leaves it). A base that isn't a scene is never fetched: its kind is saved and the preset says why.
    /// The base id: the preset file's `dependency`, else Steam's (WorkshopSocialOps.BaseOfAsync).
    public static async Task FetchBaseAsync(LibraryItem preset, bool oneOff)
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
            lock (_fetching)
            {
                if (!_fetching.TryGetValue(baseId, out var running))
                {
                    var id = baseId;
                    running = FetchAsync(id, facts.Title, oneOff).ContinueWith(t => { lock (_fetching) _fetching.Remove(id); return t; }, TaskScheduler.Default).Unwrap();
                    _fetching[baseId] = running;
                }
                fetch = running;
            }
            await fetch.ConfigureAwait(false);
            if (Presets.BaseDirOf(baseId) != null) Done(preset);
        }
        catch (Exception e) when (baseId != null) { Fail(who, baseId, e.Message); }
        catch (Exception e) { Console.WriteLine($"workshop: {who}: fetching its base scene failed: {e.Message}"); }
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
    static async Task FetchAsync(string baseId, string? title, bool oneOff)
    {
        var s = SettingsService.Load();
        string page = PageUrl(baseId);
        var detail = await ServerHost.Workshop.GetDetailAsync(new WallpaperResult
        { Title = title ?? baseId, ThumbnailUrl = "", PageUrl = page, WorkshopId = baseId, IsScene = true }).ConfigureAwait(false);
        if (s.WorkshopDownloadMode == "steampage")
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
        // "Open in the Steam app": the folder is there now, so this imports it without opening anything
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

    /// After a Subscribe (nothing imported: `/workshop/subscribe`, or its Steam to-do entry ending Done) of a preset: its base
    /// scene is subscribed the same way when it is neither subscribed nor in the library. "Open in the Steam app" relies on
    /// Steam's required-items prompt on the preset's page. A non-preset or a base that isn't a scene: nothing.
    public static async Task SubscribeBaseAsync(string presetId)
    {
        try
        {
            if (SettingsService.Load().WorkshopDownloadMode == "steampage") return;
            var b = await WorkshopSocialOps.BaseOfAsync(presetId, CancellationToken.None).ConfigureAwait(false);
            if (b == null) return;
            if (b.Kind != "scene") { Console.WriteLine($"workshop: {presetId}: its base {b.BaseId} is {(b.Kind == null ? "not on Steam" : $"a {b.Kind} wallpaper")} — not subscribed"); return; }
            if (Presets.BaseDirOf(b.BaseId) != null || WorkshopSubOps.IsSubscribed(b.BaseId)) return;
            Console.WriteLine($"workshop: {presetId}: subscribed to a preset — subscribing its base {b.BaseId} too");
            await WorkshopSubOps.SubscribeAsync(b.BaseId, b.Title).ConfigureAwait(false);
        }
        catch (Exception e) { Console.WriteLine($"workshop: {presetId}: subscribing its base scene failed: {e.Message}"); }
    }
}
