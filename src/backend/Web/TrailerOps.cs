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
// One page at a time, PaceMs apart — gentle on purpose: this is a ONE-TIME fill (cached after), and Steam rate-limits
// steamcommunity.com per IP for a long while once tripped (2026-11-11: a burst of ~150 quick reads → 429s for 30+ min,
// for the owner's own browser too). A 429 waits BackoffMin minutes (MaxBackoffs times), then the run stops and the next
// start continues; only real failures (no connection, timeouts, error pages) count toward MaxFailsInARow (offline).
// Faster routes, checked 2026-11-11: IPublishedFileService/GetDetails (100 items a request, with additional previews)
// needs a Web API key or a signed-in access token (401 without); the keyless ISteamRemoteStorage/GetPublishedFileDetails
// has no previews at all.
// Single-flight; started after the startup WE sync and after /library/sync. Each find → WS `library-item-changed
// {path, youtubeUrl}` (the grid / sidebar merge it). Adapter log: `trailers: …`.
public static class TrailerOps
{
    private const int PaceMs = 4000, MaxFailsInARow = 3, RecheckDays = 30, MaxBackoffs = 3, BackoffMin = 5;
    private static int _running;

    public static void Kick(string why) => _ = Task.Run(async () => { try { await RunAsync(why).ConfigureAwait(false); } catch { } });

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
            int found = 0, none = 0, fails = 0, inARow = 0, backoffs = 0;
            foreach (var item in todo)
            {
                var (r, url) = await SteamWorkshopScraper.CheckYoutubeAsync(item.WorkshopId!).ConfigureAwait(false);
                while (r == SteamWorkshopScraper.PageCheck.RateLimited && backoffs < MaxBackoffs)
                {
                    var wait = TimeSpan.FromMinutes(BackoffMin); backoffs++;
                    Console.WriteLine($"trailers: Steam rate limit — waiting {wait.TotalMinutes:0} min");
                    await Task.Delay(wait).ConfigureAwait(false);
                    (r, url) = await SteamWorkshopScraper.CheckYoutubeAsync(item.WorkshopId!).ConfigureAwait(false);
                }
                if (r == SteamWorkshopScraper.PageCheck.RateLimited) { Console.WriteLine("trailers: still rate-limited — stopping, retried next start"); break; }
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
                await Task.Delay(PaceMs).ConfigureAwait(false);
            }
            Console.WriteLine($"trailers: finished — {found} found, {none} without, {fails} couldn't be checked");
        }
        finally { Interlocked.Exchange(ref _running, 0); }
    }
}
