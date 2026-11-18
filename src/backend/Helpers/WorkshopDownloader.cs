using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;
using Liascape.Web;

namespace Liascape.Helpers;

public static class WorkshopDownloader
{
    public static async Task<string> AcquireAsync(
        string workshopId,
        AppSettings settings,
        IProgress<(double Progress, string Status)>? progress,
        CancellationToken ct,
        string? title = null)
    {
        // the one rule (Blocked): a mode that can't download now refuses before anything reaches Steam
        if (Blocked(settings, WorkshopAction.Download) is { } blocked) throw new InvalidOperationException(blocked);
        // Already present (WE/Steam downloaded it) — skip re-download.
        // Subscribe mode still subscribes below so the item is tracked online even if present.
        bool alreadyHave = false;
        foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
        {
            if (IsWorkshopDirReady(dir)) { alreadyHave = true; break; }
        }

        return await AcquireViaSubscribeAsync(workshopId, title, settings, alreadyHave, progress, ct);
    }

    /// How "Download without subscribing" would get an item: `Route` = the download mode's own way ("steamapp", "subscribe"),
    /// or null with `Missing` = why not, in the user's words (the menu shows it on the disabled entries).
    public sealed record OneOffRoute(string? Route, string? Missing);

    public const string OneOffSignIn = "Sign in to Steam to download without subscribing";
    public const string OneOffPageOnly = "A Steam page can only subscribe";

    /// The way a one-off copy is fetched (the Browse sidebar's right-click "Download without subscribing"): the chosen download
    /// mode's own, never another's (Blocked). "Use the Steam app": the running client's DownloadItem. "Subscribe with Steam
    /// login": the sign-in's subscribe → Steam's copy → unsubscribe, so none signed out. "Open in the Steam app": none, a page
    /// can only subscribe. Pure: the caller reads the settings and the secret store.
    /// Guard: steam-selftest "one-off route", test-steam-signin.sh § 2 (one-off), probe-steam side:oneOff:modes
    public static OneOffRoute OneOffRouteOf(string mode, bool steamSignIn) =>
        BlockedFor(mode, steamSignIn, WorkshopAction.OneOff) is { } why ? new(null, why)
        : mode == "steamapp" ? new("steamapp", null)
        : new("subscribe", null);

    public static OneOffRoute OneOffRouteFor(AppSettings s) => OneOffRouteOf(s.WorkshopDownloadMode, SteamAuthService.HasUsableSignIn(s));

    /// A one-off's fetched folder (Steam's), for the library to copy. `Subscribed` = the route subscribed
    /// to fetch it: once the library's copy is made the caller hands that back (LetGoOfOneOff) — the copy first, since Steam
    /// deletes its folder after the unsubscribe.
    public sealed record OneOffFetch(string Dir, bool Subscribed);

    /// "Download without subscribing": a one-off copy for the library that nothing updates, fetched by the download mode's own
    /// route (OneOffRouteOf). It never opens a Steam page or a to-do entry and never takes an item out of the unsubscribe queue;
    /// a subscription the user already had is copied and left alone. Steam's folder of an item that isn't a subscription
    /// (DownloadItem's, or one about to be unsubscribed) is blocked from auto-import until Steam removes it. Without a route it
    /// fails with why. Guard: test-steam-signin.sh § 2 (one-off), § 3 j.
    public static async Task<OneOffFetch> AcquireOneOffAsync(string workshopId, AppSettings settings,
        IProgress<(double Progress, string Status)>? progress, CancellationToken ct)
    {
        var route = OneOffRouteFor(settings);
        if (route.Route == null)
        {
            Console.WriteLine($"workshop: {workshopId}: no way to download it without subscribing — {route.Missing}");
            throw new InvalidOperationException(route.Missing);
        }
        Console.WriteLine($"workshop: {workshopId}: downloading without subscribing (via {route.Route})");
        return route.Route switch
        {
            "steamapp" => await OneOffViaSteamAppAsync(workshopId, settings, progress, ct),
            _ => await OneOffViaSignInAsync(workshopId, settings, progress, ct),
        };
    }

    /// Unsubscribes what a one-off subscribed only to fetch it: the unsubscribe queue and its drain, at once (no Undo window: the
    /// user never asked for the subscription), through the mode's own way (the sign-in, the Steam client). The drain marks it
    /// blocked; a sign-in gone by then drops it like any unsubscribe, saying so. It is part of the download, so the drain reports
    /// no progress for it (the UI's "Removing from Steam" is for the user's own unsubscribes). Guard: test-steam-signin.sh § 2
    /// (one-off), § 3 j.
    public static void LetGoOfOneOff(string workshopId)
    {
        Console.WriteLine($"workshop: {workshopId}: copied without subscribing — unsubscribing the subscription that fetched it");
        WorkshopUnsubQueue.AddPending([workshopId], quiet: true);
        SteamOps.StartDrain();
    }

    // "Use the Steam app": DownloadItem fetches it with no subscription. A client that won't download an unsubscribed item →
    // subscribe through it instead (LetGoOfOneOff then unsubscribes through it too). Never another way: it fails with
    // SteamClientUgc.FailureMessage when the client can't be used.
    private static async Task<OneOffFetch> OneOffViaSteamAppAsync(string workshopId, AppSettings settings,
        IProgress<(double, string)>? progress, CancellationToken ct)
    {
        // blocked while Steam's folder appears, so an auto-import meanwhile doesn't link it
        bool blockedHere = !WorkshopSubOps.IsSubscribed(workshopId) && WorkshopUnsubQueue.Block(workshopId);
        try
        {
            var r = await SteamClientUgc.DownloadAsync(workshopId, settings, progress, ct);
            if (r.Folder != null)
            {
                if (!r.WasSubscribed) WorkshopUnsubQueue.Block(workshopId);
                else if (blockedHere) WorkshopUnsubQueue.DropBlock(workshopId); // the user's own subscription
                return new(MediaOrThrow(workshopId, r.Folder), false);
            }
            if (r.Refused && !r.WasSubscribed)
            {
                Console.WriteLine($"workshop: {workshopId}: the Steam app won't download it unsubscribed — subscribing to fetch it, then unsubscribing");
                var sub = await SteamClientUgc.SubscribeAsync(workshopId, settings, progress, ct);
                if (sub.Folder != null)
                {
                    try { return new(MediaOrThrow(workshopId, sub.Folder), true); }
                    catch { LetGoOfOneOff(workshopId); throw; }
                }
                r = r with { Fallback = sub.Fallback };
            }
            var why = r.Fallback ?? (r.Refused ? "Steam won't download it" : null);
            Console.WriteLine($"workshop: {workshopId}: the Steam app couldn't download it — {why}");
            throw new InvalidOperationException(SteamClientUgc.FailureMessage(why));
        }
        catch when (blockedHere && !WorkshopUnsubQueue.SnapshotPending().Contains(workshopId))
        {
            WorkshopUnsubQueue.DropBlock(workshopId);
            throw;
        }
    }

    // "Subscribe with Steam login": the sign-in subscribes, Steam's client downloads it like any subscription, and the caller
    // unsubscribes once the library has its copy. An item the user already has subscribed: only its copy, nothing sent.
    private static async Task<OneOffFetch> OneOffViaSignInAsync(string workshopId, AppSettings settings,
        IProgress<(double, string)>? progress, CancellationToken ct)
    {
        const string waiting = "Waiting for Steam to download it…";
        if (WorkshopSubOps.IsSubscribed(workshopId))
            return new(await WaitForSteamCopyAsync(workshopId, settings, progress, ct, null, waiting, null), false);
        bool blockedHere = WorkshopUnsubQueue.Block(workshopId);
        string? failed = null;
        try
        {
            var cookie = await SteamAuthService.GetCookieAsync(settings, ct);
            if (string.IsNullOrWhiteSpace(cookie)) failed = SignInFailure.NotSignedIn;
            else
            {
                progress?.Report((-1, "Subscribing on Steam to fetch it…"));
                await SubscribeAsync(workshopId, cookie, subscribe: true, ct);
            }
        }
        catch (SteamSignInRejectedException) { failed = SignInFailure.SignedOut; }
        catch (InvalidOperationException e) { failed = e.Message; } // Steam rejected it: its own words say what to do
        catch (Exception e) when (e is not (OperationCanceledException or SteamRateLimitException))
        { failed = SignInFailure.Unusable; Console.WriteLine($"workshop: {workshopId}: the sign-in failed ({e.Message})"); }
        catch { if (blockedHere) WorkshopUnsubQueue.DropBlock(workshopId); throw; }
        if (failed != null)
        {
            if (blockedHere) WorkshopUnsubQueue.DropBlock(workshopId);
            Console.WriteLine($"workshop: {workshopId}: not downloaded without subscribing — {failed}");
            throw new InvalidOperationException(failed);
        }
        try { return new(await WaitForSteamCopyAsync(workshopId, settings, progress, ct, null, waiting, null), true); }
        catch { LetGoOfOneOff(workshopId); throw; }
    }

    // Steam's folder for it, holding a video or a scene; else why it's no use here
    private static string MediaOrThrow(string workshopId, string folder)
    {
        if (TryGetMediaPath(folder) != null) return folder;
        Console.WriteLine($"workshop: {workshopId}: Steam installed it at {folder} but there's no video or scene in it");
        throw new InvalidOperationException("Steam installed it, but there's no video or scene in it — a web or application wallpaper can't play here.");
    }

    /// The user skipped (or stopped) this item in the Steam to-do: its /download ends as skipped, not failed.
    public sealed class SkippedException(string workshopId) : Exception($"Skipped {workshopId} in the Steam to-do") { }

    /// A download's status while it waits for its page in the Steam to-do (Web/SteamTodo.cs) — the card says "In the Steam to-do".
    public const string InSteamTodo = "In the Steam to-do — its page opens in Steam when it's its turn…";

    // Real Steam subscription. "Subscribe with Steam login": the community AJAX endpoint (the same call the website's Subscribe
    // button makes) with the sign-in; without a usable one (none, one Steam signed out or couldn't use, a subscribe Steam
    // turned down) it FAILS with why and what to do (SignInFailure) — never the item's page instead: that is the "Open in the
    // Steam app" mode's whole job, the user's pick (docs/decisions.md § "Offer three Workshop download modes, the user's
    // choice"). "Open in the Steam app": the item's page (steam://url/CommunityFilePage/<id>) through the Steam to-do, the user
    // clicks Subscribe there. Either way Steam then syncs + auto-updates the item like any normal subscription, and the running
    // Steam client downloads it to a workshop/content/431960 dir which we poll for. Guard: test-steam-signin.sh § 2
    private static async Task<string> AcquireViaSubscribeAsync(
        string workshopId,
        string? title,
        AppSettings settings,
        bool alreadyHave,
        IProgress<(double, string)>? progress,
        CancellationToken ct)
    {
        // "Use the Steam app": the running Steam client does it (one click, its own progress, no sign-in here). It FAILS when the
        // Steam client can't do it — never a quiet switch to the sign-in or the page (a fallback would hide why the chosen
        // mode didn't work)
        if (settings.WorkshopDownloadMode == "steamapp")
        {
            var viaClient = await SteamClientUgc.SubscribeAsync(workshopId, settings, progress, ct);
            if (viaClient.Folder == null)
            {
                Console.WriteLine($"workshop: {workshopId}: the Steam app couldn't subscribe it — {viaClient.Fallback}");
                throw new InvalidOperationException(SteamClientUgc.FailureMessage(viaClient.Fallback));
            }
            WorkshopUnsubQueue.Unblock(workshopId);
            if (TryGetMediaPath(viaClient.Folder) != null) return viaClient.Folder;
            Console.WriteLine($"workshop: {workshopId}: Steam installed it at {viaClient.Folder} but there's no video or scene in it");
            throw new InvalidOperationException("Steam installed it, but there's no video or scene in it — a web or application wallpaper can't play here.");
        }

        string? why = null; // set = the item's page in the Steam app ("Open in the Steam app"), and this is why
        // "Open in the Steam app" (docs/decisions.md § "Offer three Workshop download modes, the user's choice"): always the
        // item's page in Steam — never the sign-in, even when there is one
        bool pageMode = settings.WorkshopDownloadMode == "steampage";
        if (pageMode) why = "Set to open items in the Steam app";
        else
        {
            string? failed = null, cookie = null;
            try
            {
                cookie = await SteamAuthService.GetCookieAsync(settings, ct);
                if (string.IsNullOrWhiteSpace(cookie)) failed = SignInFailure.NotSignedIn;
            }
            catch (SteamSignInRejectedException) { failed = SignInFailure.SignedOut; }
            catch (Exception e) when (e is not OperationCanceledException)
            { failed = SignInFailure.Unusable; Console.WriteLine($"workshop: {workshopId}: the sign-in failed ({e.Message})"); }
            if (failed == null)
            {
                try
                {
                    progress?.Report((-1, "Subscribing on Steam…"));
                    await SubscribeAsync(workshopId, cookie!, subscribe: true, ct);
                }
                catch (SteamRateLimitException) { throw; }
                catch (InvalidOperationException e)
                { failed = e.Message; } // Steam rejected it: its own words say what to do (SubscribeAsync)
            }
            // a sign-in Steam won't take at the click, but Steam already has it on disk (subscribed earlier): nothing to subscribe, it imports
            if (failed != null && alreadyHave)
                foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
                    if (IsWorkshopDirReady(dir)) { WorkshopUnsubQueue.Unblock(workshopId); return dir; }
            if (failed != null)
            {
                Console.WriteLine($"workshop: {workshopId}: not subscribed — {failed}");
                throw new InvalidOperationException(failed);
            }
        }
        // Deliberately (re-)subscribing → unblock it (drop from pending + blocked).
        WorkshopUnsubQueue.Unblock(workshopId);

        // "Open in the Steam app", but Steam already has it on disk (subscribed earlier): nothing to click
        if (pageMode && alreadyHave)
            foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
                if (IsWorkshopDirReady(dir)) return dir;

        string waitingFor = "Subscribed — waiting for Steam to download…";
        // no usable sign-in: the user subscribes on the item's page in the Steam app — through the Steam to-do, one page at a
        // time app-wide: given N pages at once, Steam shows one and loses the rest (docs/decisions.md § "Queue the Steam pages
        // the user must click, one at a time, advanced by Next")
        SteamTodo.Entry? todo = null;
        if (why != null)
        {
            todo = SteamTodo.EnqueueSubscribe(workshopId, title, hasDownload: true, out bool openFailed);
            if (openFailed)
                throw new InvalidOperationException($"The Steam app couldn't be opened (xdg-open steam://…). Start Steam, or pick another way to get Workshop wallpapers under {SignInFailure.Where}.");
            waitingFor = "Click Subscribe in Steam, then it downloads by itself…";
            Console.WriteLine($"workshop: {workshopId}: {why} — in the Steam to-do, waiting for the download");
        }

        return await WaitForSteamCopyAsync(workshopId, settings, progress, ct, todo, waitingFor, why);
    }

    // Waits for Steam's copy of the item: its media in a Workshop root, steady across two polls, then that folder. `todo` = its Steam to-do entry (its Skip / Stop / "Let the Steam app do all
    // N" end the wait; ended here either way); `why` = it waits on the user's click in the Steam app (the timeout says so).
    private static async Task<string> WaitForSteamCopyAsync(string workshopId, AppSettings settings, IProgress<(double, string)>? progress,
        CancellationToken ct, SteamTodo.Entry? todo, string waitingFor, string? why)
    {
        const int maxWaitMs = 600_000;
        int pollMs = PollMs;
        int waited = 0;
        // the last size seen PER media path: the roots can name one folder twice (Steam's
        // ~/.local/share/Steam/…/content/431960 a symlink to another library's — both paths polled), and one shared
        // "last" slot would alternate between them every poll, so the size never matches twice → a 10-min hang
        var lastSize = new System.Collections.Generic.Dictionary<string, long>(StringComparer.Ordinal);
        // the step the card shows (a bare "Downloading…" for a minute on a big item looks like a hang; docs/decisions.md §
        // "Report Workshop download phases, not a percent"). Phases only, no percent: Steam may reserve a staged file's full size before writing it.
        string? shown = null;
        void Phase(string s) { if (s != shown) { shown = s; progress?.Report((-1, s)); } }
        bool delivered = false;
        var entry = todo;
        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var wake = todo?.Wake;
                switch (todo?.Outcome)
                {
                    case SteamTodo.Outcome.Skipped: throw new SkippedException(workshopId);
                    case SteamTodo.Outcome.UseSteamApp:
                        // "Let the Steam app do all N" — the Steam client subscribes it (one helper at a time, app-wide)
                        todo = null; shown = null;
                        var viaClient = await SteamClientUgc.SubscribeAsync(workshopId, settings, progress, ct);
                        if (viaClient.Folder == null)
                            throw new InvalidOperationException($"The Steam app couldn't subscribe to it — {viaClient.Fallback}");
                        if (TryGetMediaPath(viaClient.Folder) != null) { delivered = true; return viaClient.Folder; }
                        continue; // Steam's folder without the media we expect: the usual folders' poll decides
                }
                // still waiting for its page's turn: no 10-minute clock yet (item 5 of a bulk download would time out queued)
                bool queued = todo is { IsCurrent: false, Outcome: SteamTodo.Outcome.Waiting };
                bool arrived = false;
                foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
                {
                    var media = TryGetMediaPath(dir);
                    if (media == null) continue;
                    arrived = true;
                    long size = SafeLen(media);
                    // only accept once the media file has stopped growing (size stable across two polls)
                    // AND is non-empty — guards against importing a still-downloading partial file.
                    if (size > 0 && lastSize.TryGetValue(media, out var prev) && prev == size) { delivered = true; return dir; }
                    lastSize[media] = size;
                }
                if (arrived) Phase(SteamFinishing);
                else if (SteamStaging(settings.WorkshopFolder, workshopId)) Phase(SteamDownloading);
                else Phase(queued ? InSteamTodo : waitingFor);
                if (!queued && (waited += pollMs) > maxWaitMs)
                    throw new TimeoutException(why == null
                        ? $"Subscribed to {workshopId} but Steam hasn't downloaded it yet. Make sure Steam is running and signed in."
                        : $"Steam didn't download {workshopId} within 10 minutes. Click Subscribe on the page Steam opened (Steam has to be " +
                          "running and signed in), then download it again.");
                if (wake == null) await Task.Delay(pollMs, ct);
                else await Task.WhenAny(Task.Delay(pollMs, ct), wake); // a Skip / its turn wakes it at once
            }
        }
        finally { if (entry != null) SteamTodo.Finish(entry, delivered); }
    }

    /// What a "Subscribe with Steam login" download / subscribe without a usable sign-in says: why, and what to do.
    public static class SignInFailure
    {
        public const string Where = "Settings → Getting Workshop wallpapers";
        public const string NotSignedIn = $"Not signed in to Steam. Sign in under {Where}.";
        public const string SignedOut = $"Steam signed this app out. Sign in again under {Where}.";
        public const string Unusable = $"The Steam sign-in couldn't be used. Sign in again under {Where}.";
    }

    public const string SteamDownloading = "Steam is downloading it…";
    public const string SteamFinishing = "Steam is finishing…";

    // Is Steam downloading this item now? It stages a Workshop download in <library>/steamapps/workshop/downloads/431960/<id>
    // and moves it to content/431960/<id> at the end (Steam's content_log: "starting commit from …downloads/431960 to
    // …content/431960"). Each content root's sibling — a symlinked root's textual parent may not exist, the real library's does.
    private static bool SteamStaging(string workshopBasePath, string workshopId)
    {
        foreach (var root in WorkshopContentRoots(workshopBasePath))
        {
            var content = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(root)); // …/workshop/content
            var workshop = content == null ? null : Path.GetDirectoryName(content);       // …/workshop
            if (workshop != null && Directory.Exists(Path.Combine(workshop, "downloads", "431960", workshopId))) return true;
        }
        return false;
    }

    // The poll interval (3 s); LIASCAPE_WORKSHOP_POLL_MS shortens it for the hermetic test.
    internal static int PollMs =>
        int.TryParse(Environment.GetEnvironmentVariable("LIASCAPE_WORKSHOP_POLL_MS"), out var ms) && ms is >= 100 and <= 3000 ? ms : 3000;

    /// Opens a steam:// URL in the Steam app (`xdg-open`, which starts Steam when it isn't running), detached in its own
    /// session so the app's process group (a dev unit restart, Ctrl+C) never takes Steam down with it. False = couldn't start it.
    public static bool OpenInSteamApp(string steamUrl)
    {
        try
        {
            var psi = new ProcessStartInfo("setsid") { UseShellExecute = false };
            psi.ArgumentList.Add("sh");
            psi.ArgumentList.Add("-c");
            psi.ArgumentList.Add("exec xdg-open \"$0\" </dev/null >/dev/null 2>&1");
            psi.ArgumentList.Add(steamUrl);
            Process? p;
            try { p = Process.Start(psi); }
            catch (System.ComponentModel.Win32Exception) { p = Process.Start(new ProcessStartInfo("xdg-open", steamUrl) { UseShellExecute = false }); } // no setsid
            if (p == null) return false;
            _ = p.WaitForExitAsync().ContinueWith(_ => p.Dispose()); // reap it
            return true;
        }
        catch (Exception e) { Console.WriteLine($"workshop: couldn't open {steamUrl}: {e.Message}"); return false; }
    }

    // Obtains a valid steamLoginSecure (auto-minted from the stored refresh token, or manual paste)
    // then subscribes/unsubscribes. This is the entry point callers use.
    public static async Task SetSubscribedAsync(string workshopId, AppSettings settings, bool subscribe, CancellationToken ct = default)
    {
        var cookie = await SteamAuthService.GetCookieAsync(settings, ct);
        if (string.IsNullOrWhiteSpace(cookie))
            throw new InvalidOperationException(
                "Not signed in to Steam. Sign in under Settings → Getting Workshop wallpapers (QR or password).");
        await SubscribeAsync(workshopId, cookie, subscribe, ct);
    }

    // POST to /sharedfiles/subscribe (or /unsubscribe). sessionid is CSRF: it must match between
    // the cookie and the form field, but its value is arbitrary — we generate one. steamLoginSecure
    // is the real auth token (the user's logged-in web session).
    public static async Task SubscribeAsync(string workshopId, string steamLoginSecure, bool subscribe, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(steamLoginSecure) || string.IsNullOrWhiteSpace(workshopId)) return;
        string sessionId = Guid.NewGuid().ToString("N")[..24];
        string action = subscribe ? "subscribe" : "unsubscribe";

        // The cookie value must be URL-encoded: the `||` between steamid and token becomes %7C%7C
        // (matches the browser's encodeURIComponent). Normalize first (Unescape→Escape) so both a
        // raw minted value and an already-encoded pasted value end up encoded exactly once.
        string cookieValue = Uri.EscapeDataString(Uri.UnescapeDataString(steamLoginSecure.Trim()));

        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"{SteamCommunity.Base}/sharedfiles/{action}");
        req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
        req.Headers.Add("Cookie", $"sessionid={sessionId}; steamLoginSecure={cookieValue}");
        req.Content = new FormUrlEncodedContent(new System.Collections.Generic.Dictionary<string, string>
        {
            ["id"] = workshopId,
            ["appid"] = "431960",
            ["sessionid"] = sessionId,
        });

        HttpResponseMessage resp;
        try { resp = await SteamGate.SendAsync(req, SteamGate.Kind.Interactive, ct); } // spaced app-wide; a cooldown sends nothing
        catch (SteamCooldownException) { throw new SteamRateLimitException(); }
        using var _resp = resp;
        var body = await resp.Content.ReadAsStringAsync(ct);

        // Rate-limited → distinct exception so the drain can stop early instead of hammering the
        // rest of the queue (they'd all 429 too). 429, or Steam's 403 + empty/"too many" body.
        if ((int)resp.StatusCode == 429) throw new SteamRateLimitException(); // the gate already started the cooldown
        if (resp.StatusCode == System.Net.HttpStatusCode.Forbidden && body.Contains("too many", StringComparison.OrdinalIgnoreCase))
        { SteamGate.Trip(); throw new SteamRateLimitException(); } // Steam's 403 flavour: start the app-wide cooldown too

        // Steam returns {"success":1} on success (1 also = already in that state). Anything else
        // (non-2xx, or a success code that isn't 1) means the request didn't take.
        bool ok = resp.IsSuccessStatusCode
            && (body.Contains("\"success\":1") || body.Length == 0);
        if (!ok)
            throw new InvalidOperationException(
                "Steam rejected the subscribe request — your login may be expired. " +
                "Sign in again under Settings → Getting Workshop wallpapers." +
                $" [{(int)resp.StatusCode} {(body.Length > 120 ? body[..120] : body)}]");
    }

    // Thrown when Steam rate-limits a subscribe/unsubscribe; signals the drain to back off.
    public sealed class SteamRateLimitException : Exception
    {
        public SteamRateLimitException() : base("Steam rate-limited the request.") { }
    }

    // Roots (…/431960) of every place workshop content can live: configured WE path,
    // standard + Flatpak Steam, and each libraryfolders.vdf library. Parse the vdf once and reuse
    // across many ids (the prune pass does this).
    private static System.Collections.Generic.List<string> WorkshopContentRoots(string workshopBasePath)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roots = new System.Collections.Generic.List<string>();
        if (!string.IsNullOrEmpty(workshopBasePath)) roots.Add(workshopBasePath); // already …/431960
        roots.Add(Path.Combine(home, ".local/share/Steam/steamapps/workshop/content/431960"));
        roots.Add(Path.Combine(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/workshop/content/431960"));
        foreach (var libRoot in ReadSteamLibraryRoots())
            roots.Add(Path.Combine(libRoot, "steamapps/workshop/content/431960"));
        return roots;
    }

    /// The Workshop roots, all Steam's (the WE folder setting, standard + Flatpak Steam, every library). Its folder in one of
    /// them = Steam has it subscribed (until an unsubscribe makes Steam delete it).
    public static System.Collections.Generic.List<string> SteamWorkshopRoots(string workshopBasePath) => WorkshopContentRoots(workshopBasePath);

    /// Is the item on disk in Steam's hands: its folder in a Steam Workshop root, or Steam's staging folder for it (a download
    /// under way)? The Steam to-do's "Steam delivered it" signal (Web/SteamTodo.cs) — disk only, never the Steam client.
    public static bool ItemOnDisk(string workshopBasePath, string workshopId) =>
        WorkshopFolderExists(SteamWorkshopRoots(workshopBasePath), workshopId) || SteamStaging(workshopBasePath, workshopId);

    /// Does Steam have this item in one of its own Workshop folders? (pass SteamWorkshopRoots once for many ids)
    public static bool InSteamWorkshop(System.Collections.Generic.List<string> steamRoots, string workshopId) => WorkshopFolderExists(steamRoots, workshopId);

    /// What the Browse sidebar's Subscribe did: Subscribed = Steam took it (the Steam client, or the sign-in's web call);
    /// else Todo = it waits in the Steam to-do for the user's click + Next.
    public sealed record SubscribeOnlyResult(bool Subscribed, string Message, SteamTodo.Entry? Todo = null);

    /// Subscribe WITHOUT importing anything into the library (the sidebar's subscribe/unsubscribe button) — the download mode's
    /// own way only: `steamapp` → the Steam client (it waits for the install, reporting Steam's bytes), `subscribe` → the
    /// website's subscribe call with the sign-in (done — Steam downloads it by itself), `steampage` → a Steam to-do subscribe
    /// entry without a download (the user clicks Subscribe on its page, then Next). A signed-out `subscribe` never borrows
    /// another mode's way: refused (Blocked). Unblocks the id (wanted again). A rate limit throws
    /// (no page — it's steamcommunity.com from the same connection).
    public static async Task<SubscribeOnlyResult> SubscribeOnlyAsync(string workshopId, string? title, AppSettings settings,
        IProgress<(double, string)>? progress, CancellationToken ct)
    {
        if (Blocked(settings, WorkshopAction.Subscribe) is { } blocked) throw new InvalidOperationException(blocked);
        WorkshopUnsubQueue.Unblock(workshopId);
        SteamTodo.DropUnsubscribe(workshopId); // its unsubscribe still waited in the Steam to-do: nothing to click any more
        string mode = settings.WorkshopDownloadMode;
        if (mode == "steamapp")
        {
            var r = await SteamClientUgc.SubscribeAsync(workshopId, settings, progress, ct);
            if (r.Folder != null)
            {
                Console.WriteLine($"workshop: {workshopId}: subscribed through the Steam client (Subscribe, no download)");
                return new(true, "Subscribed — Steam has it");
            }
            Console.WriteLine($"workshop: {workshopId}: the Steam app couldn't subscribe it — {r.Fallback}");
            return new(false, SteamClientUgc.FailureMessage(r.Fallback)); // a failure, never the sign-in / the to-do instead
        }
        // "Subscribe with Steam login": a sign-in Steam won't take at the click fails with why and what to do, never the page
        if (mode == "subscribe")
        {
            string failed;
            try
            {
                progress?.Report((-1, "Subscribing on Steam…"));
                var cookie = await SteamAuthService.GetCookieAsync(settings, ct);
                if (string.IsNullOrWhiteSpace(cookie)) failed = SignInFailure.NotSignedIn;
                else
                {
                    await SubscribeAsync(workshopId, cookie, subscribe: true, ct);
                    Console.WriteLine($"workshop: {workshopId}: subscribed with the sign-in (Subscribe, no download)");
                    return new(true, "Subscribed — Steam downloads it by itself");
                }
            }
            catch (SteamRateLimitException) { throw; }
            catch (OperationCanceledException) { throw; }
            catch (SteamSignInRejectedException) { failed = SignInFailure.SignedOut; }
            catch (InvalidOperationException e) { failed = e.Message; }
            catch (Exception e) { failed = SignInFailure.Unusable; Console.WriteLine($"workshop: {workshopId}: the sign-in failed ({e.Message})"); }
            Console.WriteLine($"workshop: {workshopId}: not subscribed — {failed}");
            throw new InvalidOperationException(failed);
        }
        var todo = SteamTodo.EnqueueSubscribe(workshopId, title, hasDownload: false, out bool openFailed);
        if (openFailed)
            throw new InvalidOperationException("The Steam app couldn't be opened (xdg-open steam://…) — open the item on Steam and subscribe there.");
        const string msg = "Click Subscribe in Steam, then Next…";
        progress?.Report((-1, msg));
        return new(false, msg, todo);
    }

    // All places a downloaded workshop item might already live (every Steam library).
    private static System.Collections.Generic.IEnumerable<string> ExistingWorkshopDirs(
        string workshopBasePath, string workshopId)
    {
        var seen = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
        foreach (var root in WorkshopContentRoots(workshopBasePath))
        {
            var d = Path.Combine(root, workshopId);
            if (seen.Add(d)) yield return d;
        }
    }

    // Does any on-disk copy of this workshop item still exist? Pass precomputed roots to avoid
    // re-parsing libraryfolders.vdf per id (used by the prune pass).
    private static bool WorkshopFolderExists(System.Collections.Generic.List<string> roots, string workshopId)
    {
        foreach (var root in roots)
            if (Directory.Exists(Path.Combine(root, workshopId))) return true;
        return false;
    }

    /// What a drain did beyond the queue: how many items it opened in the Steam app, and what the user should hear.
    public sealed record DrainResult(int OpenedInSteam = 0, string? Message = null);

    /// The Workshop actions a download mode may or may not do (WorkshopDownloader.Blocked).
    public enum WorkshopAction { Download, Subscribe, Unsubscribe, OneOff }

    public const string UnsubSignIn = "Sign in to Steam to unsubscribe";

    /// Why a Workshop action can't happen in the chosen download mode, else null: THE rule every action's endpoint refuses with
    /// (400, these words) and the UI mirrors up front, disabled with the same words (components/subscribeMode.ts actionBlocked).
    /// Each mode does an action only its own way, never another mode's (docs/decisions.md § "Offer three Workshop download modes,
    /// the user's choice"): "Subscribe with Steam login" without a usable sign-in reaches Steam for nothing (the app stays
    /// disconnected); a Steam page can only subscribe; "Use the Steam app" does everything through the running client (it
    /// fails at the click when the client can't). Pure. Guard: steam-selftest "action rule", "unsub allowed",
    /// test-steam-signin.sh § 2 (refused), probe-steam side:blocked:*, side:unsub:signedOut, side:oneOff:modes
    public static string? BlockedFor(string mode, bool usableSignIn, WorkshopAction a) => mode switch
    {
        "subscribe" when !usableSignIn => a switch
        {
            WorkshopAction.Download => "Sign in to Steam to download",
            WorkshopAction.Subscribe => "Sign in to Steam to subscribe",
            WorkshopAction.Unsubscribe => UnsubSignIn,
            _ => OneOffSignIn,
        },
        "steampage" => a == WorkshopAction.OneOff ? OneOffPageOnly : null,
        _ => null,
    };

    // merged (auto-import on + "subscribe": the UI's Download IS the subscription and says Subscribe) a download's words are
    // the subscribe's, like the button's
    public static string? Blocked(AppSettings s, WorkshopAction a) => BlockedFor(s.WorkshopDownloadMode, SteamAuthService.HasUsableSignIn(s),
        a == WorkshopAction.Download && s.AutoAddWeWallpapersToLibrary && s.WorkshopDownloadMode == "subscribe" ? WorkshopAction.Subscribe : a);

    /// Why an Unsubscribe can't happen now, else null (Blocked's Unsubscribe): nothing queued for later, no Steam page, no
    /// Steam client.
    public static string? UnsubscribeBlocked(AppSettings s) => Blocked(s, WorkshopAction.Unsubscribe);

    /// what the status bar says when unsubscribes were dropped (`back` = library items that came back; `why` = Blocked's words)
    public static string DroppedMessage(int ids, int back, string why) =>
        $"Not unsubscribed{(back > 0 ? $": {(back == 1 ? "it's" : "they're")} back in your library" : ids == 1 ? ": it stays subscribed" : ": they stay subscribed")}. {why}.";

    // A due unsubscribe the drain can't send (no usable sign-in, or Steam turned it down mid-drain): dropped like its Undo,
    // never left queued for a later sign-in and never a page. Guard: steam-selftest "unsub, signed out", "unsub, sign-in rejected"
    private static DrainResult Dropped(System.Collections.Generic.List<string> ids, string why, string reason)
    {
        int back = AppOps.DropUnsubscribes(ids);
        Console.WriteLine($"workshop: unsubscribe {string.Join(", ", ids)}: {why} — not sent, dropped");
        return new DrainResult(0, DroppedMessage(ids.Count, back, reason));
    }

    /// Drains the unsubscribe queue: for each pending id, unsubscribe → mark blocked. We do NOT delete
    /// the workshop folder — Steam removes it (folder + acf entry) on its next sync, avoiding a stale
    /// acf/folder mismatch. `blocked` keeps AutoImport from re-importing the lingering folder until
    /// Steam cleans it. Throttled; on failure the id stays pending to retry. Reports (done,total,id).
    /// "Open in the Steam app" leaves the unsubscribing to the user, in the Steam app: <see cref="UnsubscribeInSteamApp"/> — the
    /// result's Message says what to click. Without a usable sign-in otherwise nothing is sent: <see cref="Dropped"/>.
    public static async Task<DrainResult> DrainUnsubQueueAsync(AppSettings settings, IProgress<(int Done, int Total, string CurrentId)>? progress, CancellationToken ct)
    {
        // ids whose unsubscribe already waits in the Steam to-do are the user's there (Next / Skip decide them)
        var inTodo = SteamTodo.QueuedUnsubscribes();
        // ids still in their Undo window wait for the drain at its end (SteamOps.DrainAfterUndoWindow)
        var pending = WorkshopUnsubQueue.SnapshotDue().FindAll(id => !inTodo.Contains(id));
        if (pending.Count == 0) return new DrainResult();
        // the progress is the user's own unsubscribes' only (a one-off's let-go is part of its download): they go first, so
        // "n of m" counts just them and a quiet one never moves it
        var quiet = WorkshopUnsubQueue.SnapshotQuiet();
        pending = [.. pending.Where(id => !quiet.Contains(id)), .. pending.Where(quiet.Contains)];
        int shown = pending.Count(id => !quiet.Contains(id));
        void Report(int done, int total, string id)
        {
            if (shown > 0 && !quiet.Contains(id)) progress?.Report((Math.Min(done, shown), shown, id));
        }
        // wanted again (a Subscribe: WorkshopUnsubQueue.Unblock) while its unsubscribe was out → subscribed again at the end. Never
        // an Undo: from an id's claim on, Undo is too late and says so (WorkshopUnsubQueue.Withdraw)
        var undone = new System.Collections.Generic.List<string>();
        try { return await DrainCoreAsync(); }
        finally
        {
            if (undone.Count > 0)
            {
                Console.WriteLine($"workshop: {string.Join(", ", undone)}: subscribed again while its unsubscribe was out — subscribing again");
                _ = ResubscribeAsync(undone, SettingsService.Load(), CancellationToken.None);
            }
        }
        async Task<DrainResult> DrainCoreAsync()
        {
        // "Use the Steam app": the running Steam client unsubscribes itself, no Steam page; whatever it can't confirm → the
        // paths below
        if (settings.WorkshopDownloadMode == "steamapp")
        {
            int total0 = pending.Count, n = 0;
            Report(0, total0, pending[0]);
            // claimed once the Steam client's turn is ours, not at the snapshot: an Undo while another helper held the turn
            // takes the id back and Steam never hears of it
            var (sent, confirmed, fallback) = await SteamClientUgc.UnsubscribeAsync(() => WorkshopUnsubQueue.Claim(pending), settings, id =>
            {
                // unsubscribed → Steam removes the folder; AutoImport keeps out meanwhile. Not pending any more = wanted again
                // while this ran → subscribe it again
                if (!WorkshopUnsubQueue.MarkBlocked(id)) lock (undone) undone.Add(id);
                Report(++n, total0, id);
            }, ct);
            pending = sent.Where(id => !confirmed.Contains(id)).ToList();
            if (pending.Count == 0 || ct.IsCancellationRequested) return new DrainResult();
            // a failure, never the sign-in / the to-do instead: what's left stays queued for the next drain
            Console.WriteLine($"workshop: unsubscribe {string.Join(", ", pending)}: the Steam app couldn't — {fallback ?? "Steam didn't confirm it"}");
            return new DrainResult(0, fallback != null
                ? SteamClientUgc.FailureMessage(fallback) + " The unsubscribe stays queued."
                : $"Steam didn't confirm unsubscribing {pending.Count} item{(pending.Count == 1 ? "" : "s")} — they stay queued; try again.");
        }
        // "Open in the Steam app" unsubscribes through each item's Steam page, signed in or not: never the sign-in
        if (settings.WorkshopDownloadMode == "steampage") return UnsubscribeInSteamApp(settings, pending, "Set to open items in the Steam app");
        // the sign-in's mode without a usable sign-in: dropped, never another mode's way
        if (UnsubscribeBlocked(settings) is { } blockedWhy)
            return Dropped(pending, settings.SteamSignInRejected ? "Steam turned the sign-in down" : "not signed in to Steam", blockedWhy);
        int total = pending.Count, done = 0;
        for (int i = 0; i < pending.Count; i++)
        {
            var id = pending[i];
            if (ct.IsCancellationRequested) break;
            // claimed right before it's sent: an Undo since the snapshot (or during an earlier id's request) took it back
            if (WorkshopUnsubQueue.Claim([id]).Count == 0) { done++; continue; }
            Report(done, total, id);
            try
            {
                await SetSubscribedAsync(id, settings, subscribe: false, ct);
                if (!WorkshopUnsubQueue.MarkBlocked(id)) undone.Add(id); // unsubscribed → Steam deletes the folder; wanted again meanwhile → back
            }
            catch (SteamSignInRejectedException)
            {
                // Steam ended the sign-in mid-drain: the rest isn't sent (the ones done before it stay done)
                WorkshopUnsubQueue.Release([id]);
                return Dropped(pending.GetRange(i, pending.Count - i), "Steam turned the sign-in down", UnsubSignIn);
            }
            catch (SteamRateLimitException)
            {
                // Steam is limiting us — the rest of the queue would just fail too. Stop now; the
                // remaining ids stay pending (and blocked) and resume on the next drain.
                WorkshopUnsubQueue.Release([id]);
                return new DrainResult(0, "Steam is limiting requests from this connection — the rest is unsubscribed on a later try.");
            }
            catch
            {
                // Leave queued — retry on a later drain (e.g. after sign-in / next launch).
                WorkshopUnsubQueue.Release([id]);
            }
            done++;
            Report(done, total, id);
            try { await Task.Delay(300, ct); } catch { break; } // throttle
        }
        return new DrainResult();
        }
    }

    /// Subscribe again to items an Undo brought back after Steam had already unsubscribed them — the way the download mode
    /// subscribes: the Steam client (steamapp), the sign-in (subscribe), the item's page in the Steam app (steampage). Null = all
    /// done; else what the user should know (the status bar shows it). Like every other action, never another mode's way: a
    /// mode that can't subscribe now (Blocked: signed out) sends nothing and the words say why.
    /// Guard: steam-selftest "undo's re-subscribe", test-steam-signin.sh § 3 g.
    public static async Task<string?> ResubscribeAsync(System.Collections.Generic.IReadOnlyList<string> ids, AppSettings settings, CancellationToken ct,
        System.Collections.Generic.IReadOnlyDictionary<string, string>? titles = null)
    {
        string mode = settings.WorkshopDownloadMode;
        if (ids.Count == 0) return null;
        if (mode == "steampage")
        {
            // the Steam to-do: one page at a time, Next moves on (Steam shows only one of several pages opened at once)
            foreach (var id in ids)
                SteamTodo.EnqueueSubscribe(id, titles != null && titles.TryGetValue(id, out var t) ? t : null, hasDownload: false, out _);
            // the page route can't know whether the user clicked Unsubscribe there — the words cover both
            return ids.Count == 1
                ? "Undone — to keep it subscribed, click Subscribe on the page Steam opened (if it says Subscribed, you're set), then Next."
                : $"Undone — to keep them subscribed, click Subscribe on each of the {ids.Count} pages the Steam to-do opens (any that say Subscribed are set).";
        }
        // the one rule: a mode that can't subscribe now sends nothing (no page, no other mode's way); the words say why
        if (Blocked(settings, WorkshopAction.Subscribe) is { } blocked)
        {
            Console.WriteLine($"workshop: {string.Join(", ", ids)}: not subscribed again (undo) — {blocked}, nothing sent");
            return ids.Count == 1
                ? $"Undone, but it isn't subscribed again, so Steam may delete its files. {blocked}."
                : $"Undone, but they aren't subscribed again, so Steam may delete their files. {blocked}.";
        }
        string? failedViaApp = null, failed = null;
        var notSent = new System.Collections.Generic.List<string>();
        foreach (var id in ids)
        {
            if (mode == "steamapp")
            {
                SteamClientUgc.Result r;
                try { r = await SteamClientUgc.SubscribeAsync(id, settings, null, ct); }
                catch (Exception e) when (e is not OperationCanceledException) { r = new(null, e.Message); }
                if (r.Folder != null) { Console.WriteLine($"workshop: {id}: subscribed again through the Steam app (undo)"); continue; }
                // a failure, never the sign-in / the to-do instead
                Console.WriteLine($"workshop: {id}: the Steam app couldn't subscribe it again — {r.Fallback}");
                failedViaApp ??= r.Fallback ?? "Steam didn't answer";
                continue;
            }
            try
            {
                await SetSubscribedAsync(id, settings, subscribe: true, ct);
                Console.WriteLine($"workshop: {id}: subscribed again with the sign-in (undo)");
            }
            catch (OperationCanceledException) { throw; }
            catch (SteamSignInRejectedException) { notSent.Add(id); }
            catch (Exception e) { Console.WriteLine($"workshop: {id}: re-subscribing failed ({e.Message})"); failed ??= e.Message; }
        }
        if (failedViaApp != null) return "Undone, but " + char.ToLowerInvariant(SteamClientUgc.FailureMessage(failedViaApp)[0]) + SteamClientUgc.FailureMessage(failedViaApp)[1..];
        if (notSent.Count > 0)
        {
            var why = BlockedFor("subscribe", false, WorkshopAction.Subscribe);
            Console.WriteLine($"workshop: {string.Join(", ", notSent)}: not subscribed again (undo) — Steam turned the sign-in down");
            return notSent.Count == 1
                ? $"Undone, but it isn't subscribed again, so Steam may delete its files. {why}."
                : $"Undone, but they aren't subscribed again, so Steam may delete their files. {why}.";
        }
        return failed == null ? null : $"Undone, but subscribing again failed: {failed}";
    }

    /// "Open in the Steam app"'s unsubscribe: the ids Steam has in its own Workshop folders go into the Steam to-do (Web/SteamTodo.cs) — each
    /// one's page opens in the Steam app, one at a time, for the user to click Unsubscribe, then Next (never the subscriptions
    /// list of hundreds of items). Only those: the unsubscribe queue holds items deleted from the LIBRARY, and a library
    /// Workshop item is either a `local/<id>` link into Steam's folder (a subscription — its folder exists) or an owned
    /// `workshop/<id>` copy (a "Download without subscribing", never a subscription; docs/decisions.md
    /// § "Open an unsubscribe page only for items in a Steam Workshop folder"). The rest are blocked at once, no page. A queued id stays `pending` until the user's Next marks it blocked
    /// (AutoImport keeps the folder out until Steam removes it); Skip / Stop = kept subscribed (`Unblock`).
    private static DrainResult UnsubscribeInSteamApp(AppSettings settings, System.Collections.Generic.List<string> ids, string why)
    {
        var roots = SteamWorkshopRoots(settings.WorkshopFolder);
        var inSteam = ids.FindAll(id => WorkshopFolderExists(roots, id));
        foreach (var id in ids) if (!inSteam.Contains(id)) WorkshopUnsubQueue.MarkBlocked(id); // not a subscription: nothing to click
        if (inSteam.Count == 0) return new DrainResult();
        var (queued, openFailed) = SteamTodo.EnqueueUnsubscribes(inSteam);
        string message = openFailed
            ? $"{why}, and the Steam app couldn't be opened — unsubscribe on Steam yourself, or sign in under Settings → Getting Workshop wallpapers."
            : queued == 1 ? $"{why} — Steam opened the item: click Unsubscribe there, then Next."
            : $"{why} — Steam opens the {queued} items one at a time: click Unsubscribe on each, then Next.";
        Console.WriteLine($"workshop: unsubscribe {string.Join(", ", inSteam)}: {why} — in the Steam to-do{(openFailed ? " (the Steam app couldn't be opened)" : "")}");
        return new DrainResult(queued, message);
    }

    /// Forget blocked ids whose workshop folder Steam has finished removing. One-time, cheap: parses
    /// libraryfolders.vdf once and does a few Directory.Exists per blocked id.
    public static void PruneBlocked(AppSettings settings)
    {
        var roots = WorkshopContentRoots(settings.WorkshopFolder);
        WorkshopUnsubQueue.PruneBlocked(id => WorkshopFolderExists(roots, id));
    }

    public static async Task<string?> ResolveVideoFileAsync(string workshopDir)
    {
        string projectJson = Path.Combine(workshopDir, "project.json");
        if (!File.Exists(projectJson)) return null;
        try
        {
            using var stream = File.OpenRead(projectJson);
            var doc = await JsonDocument.ParseAsync(stream);
            if (!doc.RootElement.TryGetProperty("file", out var f)) return null;
            var file = f.GetString();
            if (string.IsNullOrEmpty(file)) return null;
            var path = Path.Combine(workshopDir, file);
            return File.Exists(path) ? path : null;
        }
        catch { return null; }
    }

    // Parse Steam's libraryfolders.vdf to discover all Steam library roots (users with
    // games on multiple drives). Best-effort: returns roots whose path key we can extract.
    /// Every Steam library root (libraryfolders.vdf's paths) — SteamClientUgc looks for Valve's library in them.
    public static System.Collections.Generic.List<string> SteamLibraryRoots() => ReadSteamLibraryRoots();

    private static System.Collections.Generic.List<string> ReadSteamLibraryRoots()
    {
        var roots = new System.Collections.Generic.List<string>();
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] vdfCandidates =
        [
            Path.Combine(home, ".local/share/Steam/steamapps/libraryfolders.vdf"),
            Path.Combine(home, ".steam/steam/steamapps/libraryfolders.vdf"),
            Path.Combine(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/libraryfolders.vdf"),
        ];

        foreach (var vdf in vdfCandidates)
        {
            if (!File.Exists(vdf)) continue;
            try
            {
                foreach (var line in File.ReadLines(vdf))
                {
                    // Lines look like:  "path"   "/mnt/games/SteamLibrary"
                    var trimmed = line.TrimStart();
                    if (!trimmed.StartsWith("\"path\"", StringComparison.OrdinalIgnoreCase)) continue;
                    int firstQuote = trimmed.IndexOf('"', 6);
                    if (firstQuote < 0) continue;
                    int secondQuote = trimmed.IndexOf('"', firstQuote + 1);
                    if (secondQuote < 0) continue;
                    var path = trimmed.Substring(firstQuote + 1, secondQuote - firstQuote - 1)
                        .Replace("\\\\", "/");
                    if (!string.IsNullOrEmpty(path)) roots.Add(path);
                }
            }
            catch { }
        }
        return roots;
    }

    private static bool IsWorkshopDirReady(string dir)
        => TryGetMediaPath(dir) is { } m && SafeLen(m) > 0;

    // The actual playable file in a workshop dir: scene.pkg for scenes, else the video named in
    // project.json's "file". Returns null until that file actually exists — Steam writes project.json
    // BEFORE the media finishes downloading, so checking project.json alone imports a partial file.
    private static string? TryGetMediaPath(string dir)
    {
        if (!Directory.Exists(dir)) return null;
        string scene = Path.Combine(dir, "scene.pkg");
        if (File.Exists(scene)) return scene;
        string pj = Path.Combine(dir, "project.json");
        if (!File.Exists(pj)) return null;
        try
        {
            using var s = File.OpenRead(pj);
            var doc = JsonDocument.Parse(s);
            if (doc.RootElement.TryGetProperty("file", out var f))
            {
                var file = f.GetString();
                if (!string.IsNullOrEmpty(file))
                {
                    var p = Path.Combine(dir, file);
                    return File.Exists(p) ? p : null;
                }
            }
        }
        catch { }
        return null;
    }

    private static long SafeLen(string path) { try { return new FileInfo(path).Length; } catch { return -1; } }
}
