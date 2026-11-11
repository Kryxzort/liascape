using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Scrapers;

namespace Liascape.Web;

// The YouTube trailer cache for library items (owner 2026-11-11: "find me a video with a youtube trailer in my library" —
// none had one stored: a trailer link is part of the Workshop LISTING, not the downloaded files, and only a download from
// the app's own Workshop browser saved it; everything auto-imported from WE subscriptions never got one). Wallpaper Engine
// gets it from the Steam client's UGC API (an item's "additional previews"); this app isn't a Steam client, so it reads the
// item's public Workshop page — the same lookup Browse already does (SteamWorkshopScraper.TryGetYoutubeUrlAsync).
// Cached in the item's index entry (owner: "we should probably cache the youtube link right?"):
//   - a trailer found → `youtubeUrl`, never looked up again;
//   - the page read, no trailer → `trailerCheckedAt` (unix s), re-checked after RecheckDays (an author may add one);
//   - couldn't check (offline, Steam down, an error page) → NOTHING stored, tried again at the next start. Wallpaper
//     Engine's own offline-mode bug is reporting "can't tell" as "nothing there"; a failed check is never a "no".
// Paced by SteamGate (every steamcommunity.com request is): background requests start ≥ 4 s apart and stay 10 s behind the
// user's own browsing; a 429 starts an app-wide cooldown that survives restarts. This lookup is a ONE-TIME fill (cached
// after). On a cooldown it stops and re-schedules itself for when the cooldown ends (no waiting loop, no request sent);
// only real failures (no connection, timeouts, error pages) count toward MaxFailsInARow (offline → stop, next start).
// Faster routes, checked 2026-11-11: IPublishedFileService/GetDetails (100 items a request, with additional previews)
// needs a Web API key or a signed-in access token (401 without); the keyless ISteamRemoteStorage/GetPublishedFileDetails
// has no previews at all.
// Single-flight; started after the startup WE sync and after /library/sync. Each find → WS `library-item-changed
// {path, youtubeUrl}` (the grid / sidebar merge it). Adapter log: `trailers: …`.
public static class TrailerOps
{
    private const int MaxFailsInARow = 3, RecheckDays = 30;
    private static int _running, _scheduled;

    public static void Kick(string why)
    {
        // Steam asked us to wait (a cooldown, possibly from before a restart): come back when it's over — once
        if (SteamGate.CooldownRemaining is { } cd && cd > TimeSpan.Zero) { ScheduleAfter(cd, why); return; }
        _ = Task.Run(async () => { try { await RunAsync(why).ConfigureAwait(false); } catch { } });
    }

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
                else
                {
                    inARow = 0;
                    var at = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                    LibraryStore.SetMeta(item.VideoPath, (m) => { if (url != null) m.YoutubeUrl = url; m.TrailerCheckedAt = at; });
                    if (url != null) { found++; EventBus.Broadcast("library-item-changed", new { path = item.VideoPath, youtubeUrl = url }); }
                    else none++;
                }
            }
            Console.WriteLine($"trailers: finished — {found} found, {none} without, {fails} couldn't be checked");
        }
        finally { Interlocked.Exchange(ref _running, 0); }
    }
}
