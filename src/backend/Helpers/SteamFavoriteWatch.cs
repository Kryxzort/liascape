using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Web;

namespace Liascape.Helpers;

// "Favourite on Steam" (the sidebar's star without a usable sign-in) opens the item's page in the Steam app; this watches that
// item's favourite state for `Window` after, through the Steam app's own account (Helpers/SteamClientUgc.cs `favorites`: every
// page of the account's favourited Wallpaper Engine items, a private profile's too), and moves the account's favourites cache
// (Helpers/WorkshopFavorites.cs Apply) when it flips. It reads the list itself, never through the cache's count check or its
// 50 s hold: that check gates the page's own asks, and a watch reading through it would miss a flip for up to 50 s.
// - One loop for every item watched: each read answers all of them; a click on an item already watched starts its window again.
// - Each read is an operation on the held child (SteamClientHold): reads `Every` apart keep it connected, so a watch is one
//   connection ("Playing Wallpaper Engine") for its window plus the hold's tail, never one per read.
// - No watch without the Steam app: not "Use the Steam app", no steamclient.so, or no account from it (`steamid`: Steam not
//   running, offline, Wallpaper Engine not owned), or a first list read failing ends it at once; the page opened anyway. A
//   later read that fails is skipped.
// - A flip is against the state the cache keeps for that account when it has a whole list, else against the first read;
//   another account signed in to Steam mid-watch starts over from its first read (its state was never this account's).
// - Logs say what happened, never a Steam ID or a favourite's id.
// Guard: scripts/test-steam-app-hold.sh k., l., m.
public static class SteamFavoriteWatch
{
    static TimeSpan Ms(string env, int dflt) =>
        TimeSpan.FromMilliseconds(int.TryParse(Environment.GetEnvironmentVariable(env), out var v) && v > 0 ? v : dflt);
    // the tests shorten both (LIASCAPE_FAV_WATCH_MS / LIASCAPE_FAV_WATCH_POLL_MS)
    public static TimeSpan Window { get; internal set; } = Ms("LIASCAPE_FAV_WATCH_MS", 180_000);
    public static TimeSpan Every { get; internal set; } = Ms("LIASCAPE_FAV_WATCH_POLL_MS", 3_000);

    static readonly object Gate = new();
    static readonly Dictionary<string, long> Until = []; // watched id → its window's end (Environment.TickCount64)
    static bool running;
    static long Now => Environment.TickCount64;

    /// Watch this item after its page opened in the Steam app. False = no watch (said why in the log).
    public static bool Start(string workshopId, AppSettings s)
    {
        if (s.WorkshopDownloadMode != "steamapp") { Console.WriteLine("favourites watch: not \"Use the Steam app\", no watch"); return false; }
        if (SteamClientUgc.Candidates(s).Count == 0) { Console.WriteLine("favourites watch: no Steam client found, no watch"); return false; }
        lock (Gate)
        {
            Until[workshopId] = Now + (long)Window.TotalMilliseconds;
            if (running) return true;
            running = true;
        }
        _ = Task.Run(RunAsync);
        return true;
    }

    static async Task RunAsync()
    {
        var was = new Dictionary<string, bool>();
        ulong account = 0;
        bool anyRead = false;
        try
        {
            // the account first (one call, no Workshop query): Steam not running, offline or Wallpaper Engine not owned ends it here
            var (sid, whyNot) = await SteamClientUgc.SteamIdAsync(SettingsService.Load(), CancellationToken.None).ConfigureAwait(false);
            if (sid == 0)
            {
                lock (Gate) { Until.Clear(); running = false; }
                Console.WriteLine($"favourites watch: no watch — {whyNot}");
                return;
            }
            account = sid;
            while (true)
            {
                string[] ids;
                lock (Gate)
                {
                    foreach (var (id, end) in Until.ToList()) if (Now >= end) { Until.Remove(id); was.Remove(id); }
                    if (Until.Count == 0) { running = false; Console.WriteLine("favourites watch: its window is over"); return; }
                    ids = Until.Keys.ToArray();
                }
                var (list, why) = await SteamClientUgc.FavoritesAsync(SettingsService.Load(), CancellationToken.None).ConfigureAwait(false);
                if (list == null)
                {
                    if (!anyRead)
                    {
                        lock (Gate) { Until.Clear(); running = false; }
                        Console.WriteLine($"favourites watch: no watch — {why}");
                        return;
                    }
                    Console.WriteLine($"favourites watch: a read failed ({why}); the next one in {Every.TotalSeconds:0.#} s");
                }
                else
                {
                    if (!anyRead) Console.WriteLine($"favourites watch: watching {ids.Length} item(s) through the Steam app");
                    anyRead = true;
                    if (list.SteamId != account) { account = list.SteamId; was.Clear(); }
                    var on = list.Ids.ToHashSet();
                    foreach (var id in ids)
                    {
                        bool now = on.Contains(id);
                        if (!was.TryGetValue(id, out var before))
                        {
                            was[id] = now;
                            if (WorkshopFavorites.Lists(account, id) is not bool kept || kept == now) continue;
                        }
                        else if (before == now) continue;
                        was[id] = now;
                        WorkshopFavorites.Apply(account, id, now);
                        Console.WriteLine($"favourites watch: an item was {(now ? "favourited" : "unfavourited")} on Steam; the favourites list follows");
                    }
                }
                await Task.Delay(Every).ConfigureAwait(false);
            }
        }
        catch (Exception e)
        {
            lock (Gate) { Until.Clear(); running = false; }
            Console.WriteLine($"favourites watch: stopped ({e.GetType().Name})");
        }
    }
}
