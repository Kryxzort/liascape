using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Models;

namespace livepaper.Helpers;

public static class WorkshopDownloader
{
    public static string SteamCmdWorkshopContentDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "livepaper", "steamcmd_workshop",
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
        foreach (var dir in ExistingWorkshopDirs(settings.WallpaperEnginePath, workshopId))
        {
            if (IsWorkshopDirReady(dir)) { alreadyHave = true; break; }
        }

        if (settings.WorkshopAcquireMode == "steamcmd")
        {
            if (alreadyHave)
                foreach (var dir in ExistingWorkshopDirs(settings.WallpaperEnginePath, workshopId))
                    if (IsWorkshopDirReady(dir)) return dir;
            return await AcquireViaSteamCmdAsync(workshopId, settings, progress, ct);
        }

        return await AcquireViaSubscribeAsync(workshopId, settings, progress, ct);
    }

    // Real Steam subscription via the community AJAX endpoint (same call the website's Subscribe
    // button makes). Steam then syncs + auto-updates the item like any normal subscription, and the
    // running Steam client downloads it to a workshop/content/431960 dir which we poll for.
    private static async Task<string> AcquireViaSubscribeAsync(
        string workshopId,
        AppSettings settings,
        IProgress<(double, string)>? progress,
        CancellationToken ct)
    {
        progress?.Report((-1, "Subscribing on Steam…"));
        await SetSubscribedAsync(workshopId, settings, subscribe: true, ct);

        progress?.Report((-1, "Subscribed — waiting for Steam to download…"));

        const int maxWaitMs = 600_000;
        const int pollMs = 3_000;
        int waited = 0;
        while (waited < maxWaitMs)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var dir in ExistingWorkshopDirs(settings.WallpaperEnginePath, workshopId))
                if (IsWorkshopDirReady(dir)) return dir;
            await Task.Delay(pollMs, ct);
            waited += pollMs;
        }

        throw new TimeoutException(
            $"Subscribed to {workshopId} but Steam hasn't downloaded it yet. " +
            "Make sure Steam is running and signed in.");
    }

    // Obtains a valid steamLoginSecure (auto-minted from the stored refresh token, or manual paste)
    // then subscribes/unsubscribes. This is the entry point callers use.
    public static async Task SetSubscribedAsync(string workshopId, AppSettings settings, bool subscribe, CancellationToken ct = default)
    {
        var cookie = await SteamAuthService.GetCookieAsync(settings, ct);
        if (string.IsNullOrWhiteSpace(cookie))
            throw new InvalidOperationException(
                "Not signed in to Steam. Use \"Sign in with Steam (QR)\" in Settings → Sources, " +
                "or switch to steamcmd mode.");
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

        using var resp = await HttpClientProvider.Client.SendAsync(req, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        // Steam returns {"success":1} on success (1 also = already in that state). Anything else
        // (non-2xx, or a success code that isn't 1) means the request didn't take.
        bool ok = resp.IsSuccessStatusCode
            && (body.Contains("\"success\":1") || body.Length == 0);
        if (!ok)
            throw new InvalidOperationException(
                "Steam rejected the subscribe request — your login may be expired. " +
                "Re-sign in to Steam (QR) in Settings → Sources." +
                $" [{(int)resp.StatusCode} {(body.Length > 120 ? body[..120] : body)}]");
    }

    // All places a downloaded workshop item might already live (every Steam library + steamcmd).
    private static System.Collections.Generic.IEnumerable<string> ExistingWorkshopDirs(
        string workshopBasePath, string workshopId)
    {
        var seen = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var dirs = new System.Collections.Generic.List<string>();
        if (!string.IsNullOrEmpty(workshopBasePath))
            dirs.Add(Path.Combine(workshopBasePath, workshopId));
        dirs.Add(Path.Combine(SteamCmdWorkshopContentDir, workshopId));
        dirs.Add(Path.Combine(home, ".local/share/Steam/steamapps/workshop/content/431960", workshopId));
        dirs.Add(Path.Combine(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/workshop/content/431960", workshopId));
        foreach (var libRoot in ReadSteamLibraryRoots())
            dirs.Add(Path.Combine(libRoot, "steamapps/workshop/content/431960", workshopId));

        foreach (var d in dirs)
            if (seen.Add(d)) yield return d;
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
            ".cache", "livepaper", "steamcmd_workshop");
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
    {
        if (!Directory.Exists(dir)) return false;
        // Scenes use scene.pkg; videos use project.json — either is valid.
        string pj = Path.Combine(dir, "project.json");
        if (File.Exists(pj))
        {
            try { return new FileInfo(pj).Length > 10; }
            catch { return false; }
        }
        return File.Exists(Path.Combine(dir, "scene.pkg"));
    }

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
            ".cache", "livepaper", "steamcmd_workshop");
        Directory.CreateDirectory(installDir);

        // Wrap in a shell command so the terminal stays open after steamcmd exits
        string innerCmd =
            $"\"{steamcmdExe}\" +force_install_dir \"{installDir}\" +login \"{username}\" +quit" +
            "; echo; echo 'Sign-in complete. Press Enter to close.'; read";

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
                        psi.ArgumentList.Add("sh"); psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(innerCmd);
                        break;
                    case "foot":
                        psi.ArgumentList.Add("sh"); psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(innerCmd);
                        break;
                    case "gnome-terminal":
                        psi.ArgumentList.Add("--"); psi.ArgumentList.Add("sh"); psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(innerCmd);
                        break;
                    case "konsole":
                        psi.ArgumentList.Add("-e"); psi.ArgumentList.Add("sh"); psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(innerCmd);
                        break;
                    default:
                        psi.ArgumentList.Add("-e"); psi.ArgumentList.Add("sh"); psi.ArgumentList.Add("-c"); psi.ArgumentList.Add(innerCmd);
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
