using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

public static class WorkshopDownloader
{
    public static string SteamCmdWorkshopContentDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "liascape", "steamcmd_workshop",
        "steamapps", "workshop", "content", "431960");

    public static async Task<string> AcquireAsync(
        string workshopId,
        AppSettings settings,
        IProgress<(double Progress, string Status)>? progress,
        CancellationToken ct)
    {
        // Already present (WE/Steam downloaded it, or a prior steamcmd run) — skip re-download.
        // Subscribe mode still subscribes below so the item is tracked online even if present.
        bool alreadyHave = false;
        foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
        {
            if (IsWorkshopDirReady(dir)) { alreadyHave = true; break; }
        }

        if (settings.WorkshopDownloadMode == "steamcmd")
        {
            if (alreadyHave)
                foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
                    if (IsWorkshopDirReady(dir)) return dir;
            return await AcquireViaSteamCmdAsync(workshopId, settings, progress, ct);
        }

        return await AcquireViaSubscribeAsync(workshopId, settings, alreadyHave, progress, ct);
    }

    // Real Steam subscription. Signed in here: the community AJAX endpoint (the same call the website's Subscribe button
    // makes). Not (no sign-in, or one Steam turned down — owner 2026-11-11: "is it a dead end for users without mobile
    // guard?"): the item's page opens in the Steam app (steam://url/CommunityFilePage/<id>) and the user clicks Subscribe
    // there — status says so and why. Either way Steam then syncs + auto-updates the item like any normal subscription,
    // and the running Steam client downloads it to a workshop/content/431960 dir which we poll for.
    private static async Task<string> AcquireViaSubscribeAsync(
        string workshopId,
        AppSettings settings,
        bool alreadyHave,
        IProgress<(double, string)>? progress,
        CancellationToken ct)
    {
        string? why = null; // set = no usable sign-in: subscribe in the Steam app, and this is why
        string? cookie = null;
        try
        {
            cookie = await SteamAuthService.GetCookieAsync(settings, ct);
            if (string.IsNullOrWhiteSpace(cookie)) why = "Not signed in to Steam here";
        }
        catch (SteamSignInRejectedException) { why = "Steam signed this app out"; }
        catch (Exception e) when (e is not OperationCanceledException)
        { why = "The Steam sign-in couldn't be used"; Console.WriteLine($"workshop: {workshopId}: the sign-in failed ({e.Message}) — subscribing in the Steam app"); }

        if (cookie != null)
        {
            try
            {
                progress?.Report((-1, "Subscribing on Steam…"));
                await SubscribeAsync(workshopId, cookie, subscribe: true, ct);
            }
            // rate-limited: the Steam app's page is steamcommunity.com from this same connection — it would be refused too
            catch (SteamRateLimitException) { throw; }
            catch (InvalidOperationException e)
            { why = "Steam turned down the subscribe request"; Console.WriteLine($"workshop: {workshopId}: {e.Message} — subscribing in the Steam app"); }
        }
        // Deliberately (re-)subscribing → unblock it (drop from pending + blocked).
        WorkshopUnsubQueue.Unblock(workshopId);

        // no sign-in, but Steam already has it on disk (subscribed earlier, or a steamcmd copy): nothing to click
        if (why != null && alreadyHave)
            foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
                if (IsWorkshopDirReady(dir)) return dir;

        string waitingFor = "Subscribed — waiting for Steam to download…";
        if (why != null)
        {
            if (!OpenInSteamApp($"steam://url/CommunityFilePage/{workshopId}"))
                throw new InvalidOperationException($"{why}, and the Steam app couldn't be opened (xdg-open steam://…). Sign in under Settings → Getting Workshop wallpapers, or open the item on Steam and subscribe there.");
            waitingFor = $"{why} — click Subscribe in Steam, then it downloads by itself…";
            Console.WriteLine($"workshop: {workshopId}: {why} — opened its page in the Steam app, waiting for the download");
        }
        progress?.Report((-1, waitingFor));

        const int maxWaitMs = 600_000;
        int pollMs = PollMs;
        int waited = 0;
        string? lastMedia = null; long lastSize = -1;
        while (waited < maxWaitMs)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var dir in ExistingWorkshopDirs(settings.WorkshopFolder, workshopId))
            {
                var media = TryGetMediaPath(dir);
                if (media == null) continue;
                long size = SafeLen(media);
                // only accept once the media file has stopped growing (size stable across two polls)
                // AND is non-empty — guards against importing a still-downloading partial file.
                if (size > 0 && media == lastMedia && size == lastSize) return dir;
                lastMedia = media; lastSize = size;
            }
            await Task.Delay(pollMs, ct);
            waited += pollMs;
        }

        throw new TimeoutException(why == null
            ? $"Subscribed to {workshopId} but Steam hasn't downloaded it yet. Make sure Steam is running and signed in."
            : $"Steam didn't download {workshopId} within 10 minutes. Click Subscribe on the page Steam opened (Steam has to be " +
              "running and signed in), then download it again — or sign in under Settings → Getting Workshop wallpapers.");
    }

    // The poll interval (3 s); LIASCAPE_WORKSHOP_POLL_MS shortens it for the hermetic test.
    private static int PollMs =>
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
            $"https://steamcommunity.com/sharedfiles/{action}");
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

    // Roots (…/431960) of every place workshop content can live: configured WE path, steamcmd cache,
    // standard + Flatpak Steam, and each libraryfolders.vdf library. Parse the vdf once and reuse
    // across many ids (the prune pass does this).
    private static System.Collections.Generic.List<string> WorkshopContentRoots(string workshopBasePath)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roots = new System.Collections.Generic.List<string>();
        if (!string.IsNullOrEmpty(workshopBasePath)) roots.Add(workshopBasePath); // already …/431960
        roots.Add(SteamCmdWorkshopContentDir);
        roots.Add(Path.Combine(home, ".local/share/Steam/steamapps/workshop/content/431960"));
        roots.Add(Path.Combine(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/workshop/content/431960"));
        foreach (var libRoot in ReadSteamLibraryRoots())
            roots.Add(Path.Combine(libRoot, "steamapps/workshop/content/431960"));
        return roots;
    }

    // All places a downloaded workshop item might already live (every Steam library + steamcmd).
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

    // Delete a steamcmd-downloaded workshop item (the "unsubscribe" equivalent on library delete).
    // Only touches our own steamcmd cache — never the user's real Steam libraries.
    public static void RemoveDownloadedItem(string workshopId)
    {
        if (string.IsNullOrWhiteSpace(workshopId)) return;
        var dir = Path.Combine(SteamCmdWorkshopContentDir, workshopId);
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
        catch { }
    }

    /// What a drain did beyond the queue: how many items it opened in the Steam app, and what the user should hear.
    public sealed record DrainResult(int OpenedInSteam = 0, string? Message = null);

    /// Drains the unsubscribe queue: for each pending id, unsubscribe → mark blocked. We do NOT delete
    /// the workshop folder — Steam removes it (folder + acf entry) on its next sync, avoiding a stale
    /// acf/folder mismatch. `blocked` keeps AutoImport from re-importing the lingering folder until
    /// Steam cleans it. Throttled; on failure the id stays pending to retry. Reports (done,total,id).
    /// Without a usable sign-in (none, or one Steam turned down) the unsubscribing is the user's, in the Steam app:
    /// <see cref="UnsubscribeInSteamApp"/> — the result's Message says what to click.
    public static async Task<DrainResult> DrainUnsubQueueAsync(AppSettings settings, IProgress<(int Done, int Total, string CurrentId)>? progress, CancellationToken ct)
    {
        var pending = WorkshopUnsubQueue.SnapshotPending();
        if (pending.Count == 0) return new DrainResult();
        if (!SteamAuthService.HasUsableSignIn(settings)) return UnsubscribeInSteamApp(settings, pending, Why(settings));
        int total = pending.Count, done = 0;
        for (int i = 0; i < pending.Count; i++)
        {
            var id = pending[i];
            if (ct.IsCancellationRequested) break;
            progress?.Report((done, total, id));
            try
            {
                await SetSubscribedAsync(id, settings, subscribe: false, ct);
                WorkshopUnsubQueue.MarkBlocked(id);   // unsubscribed → Steam will delete the folder
            }
            catch (SteamSignInRejectedException)
            {
                // Steam ended the sign-in mid-drain: the rest goes to the Steam app
                return UnsubscribeInSteamApp(settings, pending.GetRange(i, pending.Count - i), "Steam signed this app out");
            }
            catch (SteamRateLimitException)
            {
                // Steam is limiting us — the rest of the queue would just fail too. Stop now; the
                // remaining ids stay pending (and blocked) and resume on the next drain.
                return new DrainResult(0, "Steam is limiting requests from this connection — the rest is unsubscribed on a later try.");
            }
            catch
            {
                // Leave queued — retry on a later drain (e.g. after sign-in / next launch).
            }
            done++;
            progress?.Report((done, total, id));
            try { await Task.Delay(300, ct); } catch { break; } // throttle
        }
        return new DrainResult();
    }

    private static string Why(AppSettings s) =>
        !string.IsNullOrWhiteSpace(s.SteamRefreshToken) && s.SteamSignInRejected ? "Steam signed this app out" : "Not signed in to Steam here";

    /// The no-sign-in unsubscribe: the ids Steam still has on disk (its workshop folders — a subscribed item's live there;
    /// our steamcmd cache isn't a subscription) are opened in the Steam app — one item → its page, several → the account's
    /// Wallpaper Engine subscriptions — for the user to click Unsubscribe; every id leaves `pending` for `blocked`
    /// (AutoImport keeps out the folder until Steam removes it, as after a real unsubscribe; re-downloading unblocks).
    private static DrainResult UnsubscribeInSteamApp(AppSettings settings, System.Collections.Generic.List<string> ids, string why)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roots = WorkshopContentRoots(settings.WorkshopFolder).FindAll(r => !r.StartsWith(Path.Combine(home, ".cache", "liascape"), StringComparison.Ordinal));
        var inSteam = ids.FindAll(id => WorkshopFolderExists(roots, id));
        string? message = null;
        if (inSteam.Count > 0)
        {
            string url = inSteam.Count == 1
                ? $"steam://url/CommunityFilePage/{inSteam[0]}"
                : "steam://openurl/https://steamcommunity.com/my/myworkshopfiles/?appid=431960&browsefilter=mysubscriptions";
            if (OpenInSteamApp(url))
                message = inSteam.Count == 1
                    ? $"{why} — Steam opened the item: click Unsubscribe there."
                    : $"{why} — Steam opened your Wallpaper Engine subscriptions: unsubscribe the {inSteam.Count} you deleted there.";
            else
                message = $"{why}, and the Steam app couldn't be opened — unsubscribe on Steam yourself, or sign in under Settings → Getting Workshop wallpapers.";
            Console.WriteLine($"workshop: unsubscribe {string.Join(", ", inSteam)}: {why} — {(message.Contains("couldn't") ? "the Steam app couldn't be opened" : "opened in the Steam app")}");
        }
        foreach (var id in ids) WorkshopUnsubQueue.MarkBlocked(id);
        return new DrainResult(inSteam.Count, message);
    }

    /// Forget blocked ids whose workshop folder Steam has finished removing. One-time, cheap: parses
    /// libraryfolders.vdf once and does a few Directory.Exists per blocked id.
    public static void PruneBlocked(AppSettings settings)
    {
        var roots = WorkshopContentRoots(settings.WorkshopFolder);
        WorkshopUnsubQueue.PruneBlocked(id => WorkshopFolderExists(roots, id));
    }

    private static async Task<string> AcquireViaSteamCmdAsync(
        string workshopId,
        AppSettings settings,
        IProgress<(double, string)>? progress,
        CancellationToken ct)
    {
        string? steamcmdPath = FindSteamCmd(settings.SteamCmdPath);
        if (string.IsNullOrEmpty(steamcmdPath))
            throw new InvalidOperationException(
                "steamcmd not found. Install it or set the path in Settings → Sources.");

        if (string.IsNullOrEmpty(settings.SteamUsername))
            throw new InvalidOperationException(
                "Steam username not set. Configure it in Settings → Sources.");

        string installDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".cache", "liascape", "steamcmd_workshop");
        Directory.CreateDirectory(installDir);

        progress?.Report((0, "Starting steamcmd…"));

        var psi = new ProcessStartInfo(steamcmdPath)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("+force_install_dir");
        psi.ArgumentList.Add(installDir);
        psi.ArgumentList.Add("+login");
        psi.ArgumentList.Add(settings.SteamUsername);
        psi.ArgumentList.Add("+workshop_download_item");
        psi.ArgumentList.Add("431960");
        psi.ArgumentList.Add(workshopId);
        psi.ArgumentList.Add("+quit");

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start steamcmd.");

        proc.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            if (e.Data.Contains("Downloading item", StringComparison.OrdinalIgnoreCase))
                progress?.Report((-1, "Downloading via steamcmd…"));
            else if (e.Data.Contains("Success", StringComparison.OrdinalIgnoreCase))
                progress?.Report((1.0, "Download complete!"));
        };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        try { await proc.WaitForExitAsync(ct); }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            throw;
        }

        if (proc.ExitCode != 0)
            throw new InvalidOperationException(
                $"steamcmd exited with code {proc.ExitCode}. " +
                "You may need to sign in again via Settings → Sources → Sign in to Steam.");

        string itemDir = Path.Combine(SteamCmdWorkshopContentDir, workshopId);
        if (!IsWorkshopDirReady(itemDir))
            throw new InvalidOperationException(
                $"steamcmd completed but workshop item {workshopId} was not found. " +
                "The item may not be available for download with your account.");

        return itemDir;
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

    public static string? FindSteamCmd(string? configured)
    {
        if (!string.IsNullOrEmpty(configured) && File.Exists(configured))
            return configured;

        string[] candidates =
        [
            "/usr/bin/steamcmd",
            "/usr/games/steamcmd",
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".local/share/Steam/steamcmd/steamcmd.sh"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "steamcmd/steamcmd.sh")
        ];

        foreach (var c in candidates)
            if (File.Exists(c)) return c;

        // Let the shell find it in PATH
        try
        {
            var which = Process.Start(new ProcessStartInfo("which")
            {
                ArgumentList = { "steamcmd" },
                UseShellExecute = false,
                RedirectStandardOutput = true
            });
            var output = which?.StandardOutput.ReadToEnd().Trim();
            which?.WaitForExit();
            if (!string.IsNullOrEmpty(output) && File.Exists(output)) return output;
        }
        catch { }

        return null;
    }

    public static void LaunchSteamCmdSignIn(string steamcmdExe, string username)
    {
        string installDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".cache", "liascape", "steamcmd_workshop");
        Directory.CreateDirectory(installDir);

        // Wrap in a shell command so the terminal stays open after steamcmd exits. The values are the script's positional
        // arguments ($1–$3), never pasted into its text: the username (and the steamcmd path) come from the settings, and
        // pasted in quotes a `"; …` in them ran as shell commands (web-backend.md § Local API security).
        const string innerCmd =
            "\"$1\" +force_install_dir \"$2\" +login \"$3\" +quit" +
            "; echo; echo 'Sign-in complete. Press Enter to close.'; read";
        string[] shArgs = ["sh", "-c", innerCmd, "liascape-steamcmd-signin", steamcmdExe, installDir, username];

        string[] terminals = ["kitty", "alacritty", "foot", "wezterm", "xterm", "gnome-terminal", "konsole"];

        foreach (var term in terminals)
        {
            try
            {
                var psi = new ProcessStartInfo(term) { UseShellExecute = false };
                switch (term)
                {
                    case "wezterm":
                        psi.ArgumentList.Add("start"); psi.ArgumentList.Add("--");
                        foreach (var a in shArgs) psi.ArgumentList.Add(a);
                        break;
                    case "foot":
                        foreach (var a in shArgs) psi.ArgumentList.Add(a);
                        break;
                    case "gnome-terminal":
                        psi.ArgumentList.Add("--"); foreach (var a in shArgs) psi.ArgumentList.Add(a);
                        break;
                    case "konsole":
                        psi.ArgumentList.Add("-e"); foreach (var a in shArgs) psi.ArgumentList.Add(a);
                        break;
                    default:
                        psi.ArgumentList.Add("-e"); foreach (var a in shArgs) psi.ArgumentList.Add(a);
                        break;
                }
                var proc = Process.Start(psi);
                if (proc != null) return;
            }
            catch { }
        }

        // Last resort: run headlessly and hope for cached creds
        Process.Start(new ProcessStartInfo(steamcmdExe)
        {
            ArgumentList = { "+force_install_dir", installDir, "+login", username, "+quit" },
            UseShellExecute = false
        });
    }
}
