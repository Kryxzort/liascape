using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Player;

namespace Liascape.Web;

// The sidebar's "Redownload" of a Workshop item Steam left unfinished (LibraryService.DownloadIncomplete: its project.json
// empty or unreadable, its main file 0 bytes). It takes the download mode's fallback order (docs/decisions.md § "Offer two
// Workshop download modes, the Steam page the last resort"), each step only when the one before can't do it:
//  - "Use the Steam app": the running client's DownloadItem at high priority (SteamClientUgc.DownloadAsync), which fetches the
//    item again into Steam's Workshop folder, where the item's local/<id> link already points;
//  - the sign-in: it can only subscribe, and an item Steam already has gains nothing from that, so it never stands in here;
//  - the item's page in the Steam app, through the Steam to-do (one page at a time, app-wide): the user unsubscribes and
//    subscribes there, and the next library read shows the whole item.
// The library's own copy (workshop/<id>, a local/<id> that is no longer a link) has no Steam folder to mend: it comes again
// by the one-off's own route (WorkshopDownloader.AcquireOneOffAsync, never a page) and its files replace the empty ones at the
// same path, which is the item's identity (playlist, playing item, sidebar). Progress goes out as a Browse card's
// (download-progress under the item's page URL), so the sidebar's button shows it. Guard: scripts/test-item-actions.sh § incomplete
public static class RedownloadOps
{
    /// Refused before anything reached Steam (400 {error}).
    public sealed class Refused(string message) : Exception(message) { }

    /// Done = the item is whole again; OpenedInSteam = its page waits in the Steam app (the to-do); Message = the status bar's.
    public sealed record Result(bool Done, bool OpenedInSteam, string Message);

    /// The status after the page step: what the user does there.
    public const string OpenedForRedownload = "Opened in Steam: unsubscribe and subscribe again there to download it again";

    static readonly ConcurrentDictionary<string, byte> _running = new(StringComparer.Ordinal);

    static string PageUrl(string id) => $"https://steamcommunity.com/sharedfiles/filedetails/?id={id}";

    public static async Task<Result> RedownloadAsync(string? path, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(path) || LibraryStore.Locate(path) is not { } loc
            || loc.Source is not (LibraryStore.Workshop or LibraryStore.Local))
            throw new Refused("Only a Workshop item in the library can be downloaded again.");
        var dir = Path.Combine(LibraryStore.SourceDir(loc.Source), loc.Key);
        var meta = LibraryStore.GetMeta(path);
        var id = meta?.WorkshopId ?? loc.Key;
        if (!WorkshopSubOps.ValidId(id)) throw new Refused("Only a Workshop item in the library can be downloaded again.");
        if (!Directory.Exists(dir)) throw new Refused("It isn't in the library any more.");
        if (!LibraryService.IsIncompleteWorkshopItem(path)) throw new Refused("Its download is complete: nothing to download again.");
        var s = SettingsService.Load();
        if (WorkshopDownloader.Blocked(s, WorkshopDownloader.WorkshopAction.Download) is { } blocked) throw new Refused(blocked);
        if (!_running.TryAdd(id, 0)) throw new Refused("It's already being downloaded again.");
        string page = PageUrl(id);
        var progress = new Progress<(double, string)>(t =>
            EventBus.Broadcast("download-progress", new { id = page, value = Math.Max(0, t.Item1), status = t.Item2 }));
        try
        {
            bool owned = !LibraryService.IsSymlink(dir);
            Result r = owned ? await OwnCopyAsync(id, dir, s, progress, ct) : await SteamFolderAsync(id, meta?.Title, path, s, progress, ct);
            if (r.Done)
            {
                Console.WriteLine($"workshop: {id}: downloaded again — whole");
                // a running rotation's skip flag follows (its gates read the files fresh), every page hears it
                LiascapePlayerProgram.PushItem(path);
                // the library's own video copy whose new version names another file: its old play path is gone, so every page
                // reads the library again (as after a sync) rather than patching an item that no longer exists
                if (File.Exists(path) || Directory.Exists(path)) EventBus.Broadcast("library-item-changed", new { path, downloadIncomplete = false });
                else EventBus.Broadcast("library-synced", new { count = 0 });
            }
            return r;
        }
        finally
        {
            _running.TryRemove(id, out _);
            EventBus.Broadcast("download-progress", new { id = page, value = 1.0, done = true });
        }
    }

    // A subscription: Steam's own folder, mended by Steam.
    static async Task<Result> SteamFolderAsync(string id, string? title, string path, Models.AppSettings s,
        IProgress<(double, string)> progress, CancellationToken ct)
    {
        string because;
        if (s.WorkshopDownloadMode == "steamapp")
        {
            var r = await SteamClientUgc.DownloadAsync(id, s, progress, ct);
            if (r.Folder != null && !LibraryService.IsIncompleteWorkshopItem(path)) return new(true, false, "Downloaded again");
            because = r.Folder != null ? "Steam's copy is still incomplete"
                : $"the Steam app couldn't download it ({r.Fallback ?? (r.Refused ? "Steam won't download it" : "Steam didn't answer")})";
        }
        else because = "the sign-in can only subscribe, and Steam has it subscribed already";
        // the fallback order's last step: its page in the Steam app, through the one queue of pages the user clicks
        SteamTodo.EnqueueSubscribe(id, title, hasDownload: false, out bool openFailed);
        if (openFailed)
        {
            Console.WriteLine($"workshop: {id}: {because}, and the Steam app couldn't be opened");
            throw new InvalidOperationException("Couldn't open the wallpaper's page in the Steam app (xdg-open steam://…). Start Steam and try again.");
        }
        Console.WriteLine($"workshop: {id}: {because} — its page in the Steam app, through the Steam to-do");
        progress.Report((0, OpenedForRedownload));
        return new(false, true, OpenedForRedownload);
    }

    // The library's own copy: fetched again the one-off's way, its files swapped in for the empty ones.
    static async Task<Result> OwnCopyAsync(string id, string dir, Models.AppSettings s, IProgress<(double, string)> progress, CancellationToken ct)
    {
        var got = await WorkshopDownloader.AcquireOneOffAsync(id, s, progress, ct);
        try
        {
            if (LibraryService.DownloadIncomplete(got.Dir)) throw new InvalidOperationException("Steam's copy of it is incomplete too.");
            ReplaceFiles(dir, got.Dir);
        }
        finally { if (got.Subscribed) WorkshopDownloader.LetGoOfOneOff(id); }
        return new(true, false, "Downloaded again");
    }

    // The copy is made in a staging folder under the trash (purged at start and close, so one cut short leaves nothing), then
    // swapped in at the item's path; the empty folder goes. Throws with the old folder in place when the copy can't be made.
    static void ReplaceFiles(string dir, string from)
    {
        var tag = Guid.NewGuid().ToString("N")[..8];
        var stage = Path.Combine(LibraryService.TrashPath, "redl-" + tag);
        var old = Path.Combine(LibraryService.TrashPath, "redl-old-" + tag);
        try { LibraryService.CopyTree(from, stage); }
        catch { LibraryService.TryDeleteDir(stage); throw; }
        Directory.Move(dir, old);
        try { Directory.Move(stage, dir); }
        catch { try { Directory.Move(old, dir); } catch { } LibraryService.TryDeleteDir(stage); throw; }
        LibraryService.TryDeleteDir(old);
    }
}
