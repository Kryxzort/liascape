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
// Steam subscriptions unless put there by hand) and "Wallpaper Engine (Workshop)". `POST /workshop/state|subscribe|unsubscribe`
// are thin wrappers.
// - State: from disk + the unsubscribe queue + the Steam to-do only — never a Steam-client connection just to show it.
// - Unsubscribe: an item IN the library = exactly the Library's "Delete from source" (trash + the queued unsubscribe, undoable);
//   not in it = the queued unsubscribe alone. Then the drain (routed by the download mode, like Delete from source), after
//   the Undo window (SteamOps.DrainAfterUndoWindow).
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
        var now = Snap.Read();
        var lib = new HashSet<string>(LibraryService.LoadAll().Where(i => i.WorkshopId != null).Select(i => i.WorkshopId!), StringComparer.Ordinal);
        var result = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var id in ids.Where(ValidId).Distinct().Take(500))
        {
            var (p, subscribed, onDisk) = now.Of(id);
            // onDisk: its folder is still in a Steam Workshop root — the WE-local list drops it once Steam deleted it
            result[id] = new { subscribed, pending = p, inLibrary = lib.Contains(id), onDisk };
        }
        return result;
    }

    /// The library's items with `Subscribed` set (GET /library): what State() calls subscribed, per Workshop item. The
    /// Library offers Unsubscribe instead of Delete for these while auto-import is on (it would import them again).
    public static List<LibraryItem> MarkSubscribed(List<LibraryItem> items)
    {
        if (!items.Any(i => i.WorkshopId != null)) return items;
        var now = Snap.Read();
        foreach (var i in items) if (i.WorkshopId != null) i.Subscribed = now.Of(i.WorkshopId).Subscribed;
        return items;
    }

    // one read of everything a subscription's state comes from, for many ids
    sealed record Snap(List<string> Roots, HashSet<string> Pending, HashSet<string> Blocked, HashSet<string> TodoSub, HashSet<string> TodoUnsub)
    {
        public static Snap Read()
        {
            var (pending, blocked) = WorkshopUnsubQueue.Snapshot();
            return new(WorkshopDownloader.SteamWorkshopRoots(SettingsService.Load().WorkshopFolder), pending, blocked,
                SteamTodo.QueuedSubscribes(), SteamTodo.QueuedUnsubscribes());
        }

        public (string? Pending, bool Subscribed, bool OnDisk) Of(string id)
        {
            string? p = _subscribing.ContainsKey(id) || TodoSub.Contains(id) ? "subscribe"
                      : Pending.Contains(id) || TodoUnsub.Contains(id) ? "unsubscribe" : null;
            bool onDisk = WorkshopDownloader.InSteamWorkshop(Roots, id);
            bool subscribed = p == "subscribe" || (p == null && !Blocked.Contains(id) && (_subscribedHere.ContainsKey(id) || onDisk));
            return (p, subscribed, onDisk);
        }
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
            _ = AfterSubscribeAsync(id);
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
            if (ok) { _subscribedHere[id] = 1; _ = AfterSubscribeAsync(id); }
            Progress(id, ok ? 1 : 0, ok ? "Subscribed" : "Not subscribed", done: true, skipped: !ok);
        }
        catch (Exception ex) { Console.WriteLine($"workshop: {id}: watching its Steam to-do entry failed: {ex.Message}"); }
    }

    /// After a Subscribe of an item the library holds (the Library sidebar's Subscribe of its own copy, or the Browse sidebar's):
    /// the Library re-reads (its `subscribed` changed), and with auto-import on Steam's copy takes the own copy's place once
    /// Steam has delivered it (LibraryService.RelinkOwnCopies; waits up to 30 min, polling like a download).
    static async Task AfterSubscribeAsync(string id)
    {
        try
        {
            if (!LibraryService.LoadAll().Any(i => i.WorkshopId == id)) return;
            EventBus.Broadcast("library-synced", new { count = 0 });
            var until = DateTime.UtcNow.AddMinutes(30);
            while (DateTime.UtcNow < until && LibraryService.IsOwnCopy(id))
            {
                var s = SettingsService.Load();
                if (!s.AutoAddWeWallpapersToLibrary) return;
                if (LibraryService.RelinkOwnCopies(s.WorkshopFolder, id).Count > 0) { EventBus.Broadcast("library-synced", new { count = 0 }); return; }
                await Task.Delay(WorkshopDownloader.PollMs);
            }
        }
        catch (Exception e) { Console.WriteLine($"workshop: {id}: after subscribing, handing its library copy to Steam failed: {e.Message}"); }
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
        else { WorkshopUnsubQueue.AddPending([id]); SteamOps.DrainAfterUndoWindow([id]); }
        Console.WriteLine($"workshop: {id}: unsubscribe from the Browse sidebar{(items.Count > 0 ? $" — {items.Count} library item(s) moved to the trash (undoable)" : "")}, in {SteamOps.UnsubUndoWindow.TotalSeconds:0} s");
        return new { inLibrary = items.Count > 0, batch, unsubscribeInMs = (int)SteamOps.UnsubUndoWindow.TotalMilliseconds };
    }

    // one keep at a time: two at once for one id would both copy its folder
    static readonly SemaphoreSlim _keepGate = new(1, 1);

    /// "Unsubscribe without deleting" (the Unsubscribe button's right-click menu): unsubscribes on Steam and KEEPS the library
    /// copy. It never trashes or deletes a library item: a `local/<id>` link into Steam's folder (which Steam removes after the
    /// unsubscribe) first becomes the library's own copy at the same path (LibraryService.KeepOwnCopy); an owned copy needs
    /// nothing. Only then is the unsubscribe queued, so a copy that fails unsubscribes nothing. `{inLibrary, kept}` (kept = the
    /// links turned into copies). Guard: scripts/test-steam-signin.sh § 3 i. (unsubscribe-keep)
    public static async Task<object> UnsubscribeKeepAsync(string id, string? title)
    {
        await _keepGate.WaitAsync();
        try
        {
            var items = LibraryService.LoadAll().Where(i => i.WorkshopId == id).ToList();
            SteamTodo.RememberTitle(id, !string.IsNullOrWhiteSpace(title) ? title : items.FirstOrDefault()?.Title);
            int kept = 0;
            foreach (var it in items)
            {
                try { if (await Task.Run(() => LibraryService.KeepOwnCopy(it))) kept++; }
                catch (Exception e)
                {
                    Console.WriteLine($"workshop: {id}: unsubscribe without deleting — couldn't copy it into the library, nothing unsubscribed: {e.Message}");
                    throw new InvalidOperationException($"couldn't keep a copy in your library ({e.Message})");
                }
            }
            _subscribedHere.TryRemove(id, out _);
            WorkshopUnsubQueue.AddPending([id]);
            Console.WriteLine($"workshop: {id}: unsubscribe without deleting from the Browse sidebar — {items.Count} library item(s) kept ({kept} copied out of Steam's folder)");
            SteamOps.StartDrain();
            return new { inLibrary = items.Count > 0, kept };
        }
        finally { _keepGate.Release(); }
    }
}
