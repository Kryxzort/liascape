using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;

namespace Liascape.Web;

// The "Steam to-do" (owner 2026-11-11, "Guided" — the panel he picked): every Workshop page the USER has to click in the Steam
// app (Subscribe on a download's page route, Unsubscribe on a Delete from source without a sign-in, Subscribe again after an
// Undo) goes through ONE app-wide queue, one page at a time. Before it, a bulk download opened N pages at once (Steam shows
// one, the rest were lost) and a bulk Delete from source opened the whole subscriptions list (~320 items) with "unsubscribe the
// N you deleted there".
//
// Advancing is the user's: **Next** ("I clicked it") opens the next page — nothing is detected (owner: "lets just have them
// click 'next' or smth themselves" — reading Steam's own state would mean connecting to the Steam client, which the user who
// chose "Open in the Steam app" may have chosen precisely to avoid; and "not on disk does not always mean unsubscribed").
// - Next on a subscribe entry: the item's /download keeps waiting for Steam's files (AcquireViaSubscribeAsync's poll, its own
//   10-minute limit). On an unsubscribe entry: unsubscribed → `WorkshopUnsubQueue.MarkBlocked` (not when its page opens).
// - Skip / Stop: a subscribe entry's waiting /download ends as skipped (`WorkshopDownloader.SkippedException`); an
//   unsubscribe entry stays subscribed → `WorkshopUnsubQueue.Unblock` (out of pending AND blocked).
// - "Let the Steam app do all N" (`UseSteamAppAsync`): the remaining entries go through the Steam client (SteamClientUgc) —
//   the only thing here that touches it, the user's explicit choice for THIS batch (the saved mode is unchanged). A Steam
//   client that can't answer (`ProbeAsync`) leaves the to-do as it was and the panel says why.
// WS `steam-todo` (Payload) on every change; `POST /steam-todo/{next,reopen,skip,stop,use-steam-app}`, `GET /steam-todo`.
public static class SteamTodo
{
    public enum Kind { Subscribe, Unsubscribe }
    public enum Outcome { Waiting, Done, Skipped, UseSteamApp, Dropped }

    public sealed class Entry
    {
        public required string Id { get; init; }
        public required string Title { get; init; }
        public required Kind Action { get; init; }
        /// A /download waits on it (else: a re-subscribe after an Undo, or an unsubscribe).
        public bool HasDownload { get; init; }
        /// Its page was opened (it is the current entry).
        public volatile bool IsCurrent;
        /// Its download finished while it was the current entry — Steam has it; the user's Next still moves on.
        public volatile bool Delivered;
        volatile Outcome _outcome = Outcome.Waiting;
        public Outcome Outcome => _outcome;
        TaskCompletionSource _wake = New();
        /// Completes on the entry's next change (it became current, or got an outcome) — the download's wait loop wakes on it.
        public Task Wake => Volatile.Read(ref _wake).Task;
        internal void Poke() => Interlocked.Exchange(ref _wake, New()).TrySetResult();
        internal void Set(Outcome o) { _outcome = o; Poke(); }
        static TaskCompletionSource New() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    static readonly object _gate = new();
    static readonly List<Entry> _queue = []; // [0] = the current entry
    static int _finished;                    // entries this run of the to-do has finished (the "2 of 5")
    static string? _message;                 // what the panel says beyond the step (the Steam app couldn't be opened / reached)
    static bool _busy;                        // "Let the Steam app do all N" is asking Steam
    static readonly ConcurrentDictionary<string, string> _titles = new();

    /// Opens a page in the Steam app — WorkshopDownloader.OpenInSteamApp (the hermetic test's stub xdg-open records it).
    internal static Func<string, bool> Open = WorkshopDownloader.OpenInSteamApp;

    public static string PageUrl(string id) => $"steam://url/CommunityFilePage/{id}";

    /// A deleted item's title, for its unsubscribe entry (the unsubscribe queue keeps ids only).
    public static void RememberTitle(string id, string? title) { if (!string.IsNullOrWhiteSpace(title)) _titles[id] = title!; }
    static string TitleOf(string id, string? t) =>
        !string.IsNullOrWhiteSpace(t) ? t! : _titles.TryGetValue(id, out var x) ? x : $"Workshop item {id}";

    // ---- adding ----------------------------------------------------------------------------------------------------------

    /// A subscribe entry. `openFailed` = it became the current entry and the Steam app couldn't be opened — the caller (a
    /// download) fails as before; the entry is gone again.
    public static Entry EnqueueSubscribe(string id, string? title, bool hasDownload, out bool openFailed)
    {
        var (e, failed) = Add(new Entry { Id = id, Title = TitleOf(id, title), Action = Kind.Subscribe, HasDownload = hasDownload });
        openFailed = failed;
        if (failed) Resolve(e, Outcome.Dropped);
        return e;
    }

    /// Unsubscribe entries (the caller passes the ids Steam has in its Workshop folders — WorkshopDownloader.UnsubscribeInSteamApp).
    /// Queued = how many were handed in.
    public static (int Queued, bool OpenFailed) EnqueueUnsubscribes(IEnumerable<string> ids)
    {
        int n = 0; bool failed = false;
        foreach (var id in ids)
        {
            var (_, f) = Add(new Entry { Id = id, Title = TitleOf(id, null), Action = Kind.Unsubscribe });
            failed |= f; n++;
        }
        return (n, failed);
    }

    /// The ids an unsubscribe entry is waiting on — a later drain leaves them to the to-do.
    public static HashSet<string> QueuedUnsubscribes()
    {
        lock (_gate) return [.. _queue.Where(e => e.Action == Kind.Unsubscribe).Select(e => e.Id)];
    }

    static (Entry E, bool OpenFailed) Add(Entry e)
    {
        bool current;
        lock (_gate)
        {
            var dup = _queue.Find(x => x.Id == e.Id && x.Action == e.Action);
            if (dup != null) return (dup, false);
            _queue.Add(e);
            current = _queue.Count == 1;
            if (current) { e.IsCurrent = true; _message = null; }
        }
        bool failed = current && !OpenCurrent(e);
        Console.WriteLine($"workshop: {e.Id}: {(e.Action == Kind.Subscribe ? "subscribe" : "unsubscribe")} in the Steam to-do{(current ? failed ? " — the Steam app couldn't be opened" : " — opened its page in the Steam app" : "")}");
        Broadcast();
        e.Poke();
        return (e, failed);
    }

    static bool OpenCurrent(Entry e)
    {
        if (Open(PageUrl(e.Id))) { lock (_gate) if (_queue.FirstOrDefault() == e) _message = null; return true; }
        lock (_gate) _message = "The Steam app couldn't be opened (xdg-open steam://…) — Open again to retry, or Skip.";
        return false;
    }

    // ---- the user's buttons ---------------------------------------------------------------------------------------------

    /// "Done — next": the user did it in Steam.
    public static void Next() { if (Current() is { } e) Resolve(e, Outcome.Done); }
    public static void Skip() { if (Current() is { } e) Resolve(e, Outcome.Skipped); }
    public static void Reopen()
    {
        if (Current() is not { } e) return;
        OpenCurrent(e);
        Broadcast();
    }

    /// Clears the to-do: every entry as skipped (downloads end, unsubscribes stay subscribed).
    public static void Stop()
    {
        List<Entry> all;
        lock (_gate) { all = [.. _queue]; _queue.Clear(); _finished = 0; _message = null; }
        foreach (var e in all) { e.Set(Outcome.Skipped); SideEffects(e, Outcome.Skipped); }
        if (all.Count > 0) Console.WriteLine($"workshop: the Steam to-do was stopped ({all.Count} left: {string.Join(", ", all.Select(e => e.Id))})");
        Broadcast();
    }

    /// "Let the Steam app do all N": the remaining entries through the Steam client, once it answered. Null = done; else why
    /// not (the to-do stays as it was, the panel says it).
    public static async Task<string?> UseSteamAppAsync()
    {
        lock (_gate) { if (_queue.Count == 0 || _busy) return null; _busy = true; _message = null; }
        Broadcast();
        string? why;
        var settings = SettingsService.Load();
        try { why = await SteamClientUgc.ProbeAsync(settings, CancellationToken.None); }
        catch (Exception ex) { why = ex.Message; }
        List<Entry> all;
        lock (_gate)
        {
            _busy = false;
            if (why != null) { _message = $"The Steam app couldn't be reached — {why}."; all = []; }
            else { all = [.. _queue]; _queue.Clear(); _finished = 0; _message = null; }
        }
        if (why != null) { Console.WriteLine($"workshop: the Steam to-do can't use the Steam app — {why}"); Broadcast(); return _message; }
        Console.WriteLine($"workshop: the Steam to-do hands {all.Count} to the Steam app ({string.Join(", ", all.Select(e => e.Id))})");
        var detached = new List<Entry>();
        var unsubs = new List<string>();
        foreach (var e in all)
        {
            if (e.Action == Kind.Unsubscribe) unsubs.Add(e.Id);
            else if (!e.HasDownload) detached.Add(e);
            e.Set(Outcome.UseSteamApp); // a download's wait loop goes through the Steam client itself
        }
        Broadcast();
        if (unsubs.Count > 0 || detached.Count > 0)
            _ = Task.Run(async () =>
            {
                try
                {
                    if (unsubs.Count > 0)
                    {
                        var (done, fallback) = await SteamClientUgc.UnsubscribeAsync(unsubs, settings, id =>
                        {
                            if (!WorkshopUnsubQueue.MarkBlocked(id)) Resubscribe(id); // undone meanwhile → back
                        }, CancellationToken.None);
                        var left = unsubs.Where(id => !done.Contains(id)).ToList();
                        if (left.Count > 0) // still pending: the next drain tries them again
                            Console.WriteLine($"workshop: the Steam app didn't confirm unsubscribing {string.Join(", ", left)}{(fallback != null ? $" — {fallback}" : "")} — left for the next try");
                    }
                    foreach (var e in detached)
                    {
                        var r = await SteamClientUgc.SubscribeAsync(e.Id, settings, null, CancellationToken.None);
                        Console.WriteLine(r.Folder != null ? $"workshop: {e.Id}: subscribed through the Steam client (the Steam to-do)"
                                                           : $"workshop: {e.Id}: not subscribed through the Steam client — {r.Fallback}");
                    }
                }
                catch (Exception ex) { Console.WriteLine($"workshop: the Steam app's turn at the Steam to-do failed: {ex.Message}"); }
            });
        return null;
    }

    // ---- the download / undo side ---------------------------------------------------------------------------------------

    /// A download that waited on this entry ended. Delivered while current: Steam has it — the entry stays until the user's
    /// Next (nothing advances by itself). Else (cancelled, failed, or delivered before its turn): it leaves the to-do.
    public static void Finish(Entry e, bool delivered)
    {
        lock (_gate) if (!_queue.Contains(e)) return;
        if (delivered && e.IsCurrent) { e.Delivered = true; Broadcast(); return; }
        Resolve(e, Outcome.Dropped);
    }

    /// Undo of a Delete from source while its unsubscribe waits in the to-do: it leaves (nothing to unsubscribe any more).
    public static void DropUnsubscribe(string id)
    {
        Entry? e;
        lock (_gate) e = _queue.Find(x => x.Id == id && x.Action == Kind.Unsubscribe);
        if (e != null) Resolve(e, Outcome.Dropped);
    }

    // ---- internals ------------------------------------------------------------------------------------------------------

    static Entry? Current() { lock (_gate) return _queue.FirstOrDefault(); }

    static void Resolve(Entry e, Outcome o)
    {
        Entry? next = null;
        lock (_gate)
        {
            int i = _queue.IndexOf(e);
            if (i < 0) return;
            _queue.RemoveAt(i);
            _finished++;
            if (i == 0) { _message = null; next = _queue.FirstOrDefault(); if (next != null) next.IsCurrent = true; }
            if (_queue.Count == 0) _finished = 0;
        }
        e.Set(o);
        SideEffects(e, o);
        Console.WriteLine($"workshop: {e.Id}: the Steam to-do — {o switch { Outcome.Done => "done", Outcome.Skipped => "skipped", _ => "left" }}");
        if (next != null) { OpenCurrent(next); next.Poke(); }
        Broadcast();
    }

    static void SideEffects(Entry e, Outcome o)
    {
        if (e.Action != Kind.Unsubscribe) return;
        // the user unsubscribed in Steam → blocked (AutoImport keeps out the folder until Steam removes it). Not pending any
        // more = an Undo restored it meanwhile → subscribe it again (WorkshopUnsubQueue.MarkBlocked)
        if (o == Outcome.Done) { if (!WorkshopUnsubQueue.MarkBlocked(e.Id)) Resubscribe(e.Id); }
        // kept subscribed: out of pending AND blocked
        else if (o == Outcome.Skipped) WorkshopUnsubQueue.Unblock(e.Id);
    }

    static void Resubscribe(string id) =>
        _ = Task.Run(async () =>
        {
            try { await WorkshopDownloader.ResubscribeAsync([id], SettingsService.Load(), CancellationToken.None); }
            catch (Exception ex) { Console.WriteLine($"workshop: {id}: re-subscribing failed: {ex.Message}"); }
        });

    /// What the panel shows: the current entry + the count, or `finished` (idle).
    public static object Payload()
    {
        lock (_gate)
        {
            if (_queue.Count == 0) return new { finished = true };
            var c = _queue[0];
            return new
            {
                action = c.Action == Kind.Subscribe ? "subscribe" : "unsubscribe",
                index = _finished + 1, total = _finished + _queue.Count, remaining = _queue.Count,
                current = new { id = c.Id, title = c.Title }, delivered = c.Delivered, message = _message, busy = _busy,
            };
        }
    }

    static void Broadcast() => EventBus.Broadcast("steam-todo", Payload());
}
