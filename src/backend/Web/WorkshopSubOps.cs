using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Web;

// The Browse sidebar's Subscribe / Unsubscribe toggle for Workshop items — "Wallpaper Engine (Local)" (the WE folder's items:
// Steam subscriptions unless put there by hand) and "Wallpaper Engine (Workshop)" (owner 2026-11-11: "make it so browse >
// wallpaper engine (local) has option to unsubscribe / same for browse > workshop / it needs to be in the sidebar / probably a
// button that lets you subscribe/unsubscribe in the sidebar"). `POST /workshop/state|subscribe|unsubscribe` are thin wrappers.
// - State: from disk + the unsubscribe queue + the Steam to-do only — never a Steam-client connection just to show it.
// - Unsubscribe: an item IN the library = exactly the Library's "Delete from source" (trash + the queued unsubscribe, undoable);
//   not in it = the queued unsubscribe alone. Then the drain (routed by the download mode, like Delete from source).
// - Subscribe: WorkshopDownloader.SubscribeOnlyAsync — nothing imported. WS `subscribe-progress {id, value, status, done?,
//   error?, skipped?}` while it runs (the page route: until the to-do entry is Done / skipped).
public static class WorkshopSubOps
{
    // ids a subscribe is running for (this toggle, or a Workshop download's subscribe) → "Subscribing…"
    static readonly ConcurrentDictionary<string, int> _subscribing = new();
    // subscribed here this session: Steam may not have made its folder yet (a web subscribe returns at once)
    static readonly ConcurrentDictionary<string, byte> _subscribedHere = new();

    public static bool ValidId(string? id) => !string.IsNullOrEmpty(id) && id.Length <= 20 && id.All(char.IsAsciiDigit);

    /// Marks a subscribe as running for `id` until disposed.
    public static IDisposable Subscribing(string id)
    {
        _subscribing.AddOrUpdate(id, 1, (_, n) => n + 1);
        return new Release(id);
    }
    sealed class Release(string id) : IDisposable
    {
        int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 1) return;
            if (_subscribing.AddOrUpdate(id, 0, (_, n) => n - 1) <= 0) _subscribing.TryRemove(new KeyValuePair<string, int>(id, 0));
        }
    }

    /// `{<id>: {subscribed, pending: "subscribe" | "unsubscribe" | null, inLibrary}}`. Subscribed = its folder is in one of
    /// Steam's Workshop roots (not our steamcmd cache) or it was subscribed here this session, and it isn't blocked / pending in
    /// the unsubscribe queue — or a subscribe is under way (the Steam to-do / a download / this toggle).
    public static Dictionary<string, object> State(IEnumerable<string> ids)
    {
        var s = SettingsService.Load();
        var roots = WorkshopDownloader.SteamWorkshopRoots(s.WorkshopFolder);
        var (pending, blocked) = WorkshopUnsubQueue.Snapshot();
        var todoSub = SteamTodo.QueuedSubscribes();
        var todoUnsub = SteamTodo.QueuedUnsubscribes();
        var lib = new HashSet<string>(LibraryService.LoadAll().Where(i => i.WorkshopId != null).Select(i => i.WorkshopId!), StringComparer.Ordinal);
        var result = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var id in ids.Where(ValidId).Distinct().Take(500))
        {
            string? p = _subscribing.ContainsKey(id) || todoSub.Contains(id) ? "subscribe"
                      : pending.Contains(id) || todoUnsub.Contains(id) ? "unsubscribe" : null;
            bool onDisk = WorkshopDownloader.InSteamWorkshop(roots, id);
            bool subscribed = p == "subscribe" || (p == null && !blocked.Contains(id) && (_subscribedHere.ContainsKey(id) || onDisk));
            // onDisk: its folder is still in a Steam Workshop root — the WE-local list drops it once Steam deleted it
            result[id] = new { subscribed, pending = p, inLibrary = lib.Contains(id), onDisk };
        }
        return result;
    }

    static void Progress(string id, double value, string? status, bool done = false, string? error = null, bool skipped = false) =>
        EventBus.Broadcast("subscribe-progress", new { id, value, status, done, error, skipped });

    /// Subscribe without importing. `{subscribed, inSteamTodo, message}`; throws what the subscribe threw (after saying so on WS).
    public static async Task<object> SubscribeAsync(string id, string? title)
    {
        SteamTodo.RememberTitle(id, title);
        var s = SettingsService.Load();
        WorkshopDownloader.SubscribeOnlyResult r;
        using (Subscribing(id))
        {
            Progress(id, 0, "Subscribing…");
            var progress = new Progress<(double, string)>(t => Progress(id, Math.Max(0, t.Item1), t.Item2));
            try { r = await WorkshopDownloader.SubscribeOnlyAsync(id, title, s, progress, CancellationToken.None); }
            catch (Exception e)
            {
                Console.WriteLine($"workshop: {id}: subscribing failed — {e.Message}");
                Progress(id, 0, null, done: true, error: e.Message);
                throw;
            }
        }
        if (r.Subscribed)
        {
            _subscribedHere[id] = 1;
            Progress(id, 1, r.Message, done: true);
            return new { subscribed = true, inSteamTodo = false, message = r.Message };
        }
        if (r.Todo is { } entry) _ = WatchTodoAsync(id, entry);
        return new { subscribed = false, inSteamTodo = true, message = r.Message };
    }

    // the page route: the entry ends with the user's Next (or Steam's files appearing — SteamTodo.Turn), Skip / Stop, or "Let the
    // Steam app do all N"
    static async Task WatchTodoAsync(string id, SteamTodo.Entry e)
    {
        try
        {
            while (true)
            {
                var wake = e.Wake;
                if (e.Outcome != SteamTodo.Outcome.Waiting) break;
                await wake;
            }
            bool ok = e.Outcome is SteamTodo.Outcome.Done or SteamTodo.Outcome.UseSteamApp;
            if (ok) _subscribedHere[id] = 1;
            Progress(id, ok ? 1 : 0, ok ? "Subscribed" : "Not subscribed", done: true, skipped: !ok);
        }
        catch (Exception ex) { Console.WriteLine($"workshop: {id}: watching its Steam to-do entry failed: {ex.Message}"); }
    }

    /// Unsubscribe from the Browse sidebar. In the library → Delete from source (trash + queue, undoable: `batch`); else the
    /// queue alone. Then the drain. `{inLibrary, batch}`.
    public static object Unsubscribe(string id, string? title)
    {
        var items = LibraryService.LoadAll().Where(i => i.WorkshopId == id).ToList();
        SteamTodo.RememberTitle(id, !string.IsNullOrWhiteSpace(title) ? title : items.FirstOrDefault()?.Title);
        _subscribedHere.TryRemove(id, out _);
        string? batch = null;
        if (items.Count > 0) batch = AppOps.DeleteFromSource(items);
        else WorkshopUnsubQueue.AddPending([id]);
        Console.WriteLine($"workshop: {id}: unsubscribe from the Browse sidebar{(items.Count > 0 ? $" — {items.Count} library item(s) moved to the trash (undoable)" : "")}");
        SteamOps.StartDrain();
        return new { inLibrary = items.Count > 0, batch };
    }
}
