using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Web;

// The YouTube trailer cache for library items (docs/decisions.md § "Ask Steam's servers for trailers and never cache
// "can't tell" as "none""). A trailer link is part of the Workshop LISTING, not the downloaded files: only a download from
// the app's own Workshop browser saves it; anything auto-imported from WE subscriptions has none. Wallpaper Engine
// gets it from the Steam client's UGC API (an item's "additional previews"); this app asks the same servers ANONYMOUSLY over
// the client protocol (SteamWorkshopDetails — 100 items a request; measured: all known trailers in 355 ms), and
// only falls back to reading the item's public Workshop page (rate-gated) for what they don't answer.
// Cached in the item's index entry:
//   - a trailer found → `youtubeUrl`, never looked up again;
//   - the page read, no trailer → `trailerCheckedAt` (unix s), re-checked after RecheckDays (an author may add one);
//   - couldn't check (offline, Steam down, an error page) → NOTHING stored, tried again at the next start. Wallpaper
//     Engine's own offline-mode bug is reporting "can't tell" as "nothing there"; a failed check is never a "no".
// Paced by SteamGate (every steamcommunity.com request is): background requests start ≥ 4 s apart and stay 10 s behind the
// user's own browsing; a 429 starts an app-wide cooldown that survives restarts. This lookup is a ONE-TIME fill (cached
// after). On a cooldown it stops and re-schedules itself for when the cooldown ends (no waiting loop, no request sent);
// only real failures (no connection, timeouts, error pages) count toward MaxFailsInARow (offline → stop, next start).
// Other routes, checked: IPublishedFileService/GetDetails (100 items a request, with additional previews)
// needs a Web API key or a signed-in access token (401 without); the keyless ISteamRemoteStorage/GetPublishedFileDetails
// has no previews at all.
// Single-flight; started after the startup WE sync and after /library/sync. Each find → WS `library-item-changed
// {path, youtubeUrl}` (the grid / sidebar merge it). Adapter log: `trailers: …`.
public static class TrailerOps
{
    private const int MaxFailsInARow = 3, RecheckDays = 30;
    private static int _running, _scheduled;

    // Always runs: Steam's servers (the first path) aren't steamcommunity.com, so its cooldown doesn't apply to them; only the
    // page-reading fallback waits it out (RunAsync).
    public static void Kick(string why) => _ = Task.Run(async () => { try { await RunAsync(why).ConfigureAwait(false); } catch { } });

    private static void ScheduleAfter(TimeSpan wait, string why)
    {
        if (Interlocked.Exchange(ref _scheduled, 1) == 1) return;
        Console.WriteLine($"trailers: Steam cooldown — resuming in {Math.Ceiling(wait.TotalMinutes)} min");
        _ = Task.Run(async () => { await Task.Delay(wait + TimeSpan.FromSeconds(5)).ConfigureAwait(false); Interlocked.Exchange(ref _scheduled, 0); Kick(why + ", after cooldown"); });
    }

    public static async Task RunAsync(string why)
    {
        if (Interlocked.Exchange(ref _running, 1) == 1) return;
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), stale = now - RecheckDays * 86400L;
            var todo = LibraryService.LoadAll()
                .Where((i) => i.YoutubeUrl == null && !string.IsNullOrEmpty(i.WorkshopId) && i.WorkshopId!.All(char.IsAsciiDigit))
                .Where((i) => LibraryStore.GetMeta(i.VideoPath)?.TrailerCheckedAt is not long at || at < stale)
                .ToList();
            if (todo.Count == 0) return;
            Console.WriteLine($"trailers: checking {todo.Count} item(s) ({why})");
            int found = 0, none = 0, fails = 0, inARow = 0;
            void Record(string path, string? url)
            {
                var at = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                LibraryStore.SetMeta(path, (m) => { if (url != null) m.YoutubeUrl = url; m.TrailerCheckedAt = at; });
                if (url != null) { found++; EventBus.Broadcast("library-item-changed", new { path, youtubeUrl = url }); }
                else none++;
            }
            // FIRST: Steam's own servers, anonymously — 100 items a request, no page reads (SteamWorkshopDetails). Whatever
            // they answer for is recorded; the rest (unreachable servers, an item they didn't return) falls to page reading.
            var t0 = DateTime.UtcNow;
            var cm = await SteamWorkshopDetails.GetTrailersAsync(todo.Select((i) => ulong.Parse(i.WorkshopId!)).Distinct().ToList()).ConfigureAwait(false);
            if (cm != null)
            {
                var rest = new List<LibraryItem>();
                foreach (var item in todo)
                    if (cm.TryGetValue(ulong.Parse(item.WorkshopId!), out var t)) Record(item.VideoPath, t.Youtube is { } y ? $"https://www.youtube.com/watch?v={y}" : null);
                    else rest.Add(item);
                Console.WriteLine($"trailers: Steam servers answered {todo.Count - rest.Count} item(s) in {(DateTime.UtcNow - t0).TotalSeconds:0.0} s — {found} found, {none} without");
                todo = rest;
                if (todo.Count == 0) return;
            }
            else Console.WriteLine("trailers: Steam's servers unreachable — reading Workshop pages instead (rate-gated)");
            // the fallback reads steamcommunity.com: during its cooldown (maybe from before a restart) come back after it
            if (SteamGate.CooldownRemaining is { } cool && cool > TimeSpan.Zero) { ScheduleAfter(cool, why); return; }
            foreach (var item in todo)
            {
                var (r, url) = await SteamWorkshopScraper.CheckYoutubeAsync(item.WorkshopId!, SteamGate.Kind.Background).ConfigureAwait(false);
                if (r == SteamWorkshopScraper.PageCheck.RateLimited)
                {
                    var cd = SteamGate.CooldownRemaining;
                    Console.WriteLine($"trailers: stopped by the Steam cooldown — {found} found, {none} without so far");
                    if (cd > TimeSpan.Zero) ScheduleAfter(cd, why);
                    return;
                }
                if (r != SteamWorkshopScraper.PageCheck.Ok)
                {
                    fails++;
                    if (++inARow >= MaxFailsInARow) { Console.WriteLine($"trailers: {inARow} checks failed in a row — offline? stopping, retried next start"); break; }
                }
                else { inARow = 0; Record(item.VideoPath, url); }
            }
            Console.WriteLine($"trailers: finished — {found} found, {none} without, {fails} couldn't be checked");
        }
        finally { Interlocked.Exchange(ref _running, 0); }
    }
}
