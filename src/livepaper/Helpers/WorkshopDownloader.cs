using System;
using System.Diagnostics;
using System.IO;
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
        return settings.WorkshopAcquireMode == "steamcmd"
            ? await AcquireViaSteamCmdAsync(workshopId, settings, progress, ct)
            : await AcquireViaSubscribeAsync(workshopId, settings.WallpaperEnginePath, progress, ct);
    }

    private static async Task<string> AcquireViaSubscribeAsync(
        string workshopBasePath,
        string workshopId,
        IProgress<(double, string)>? progress,
        CancellationToken ct)
    {
        progress?.Report((-1, "Opening Steam…"));

        try
        {
            Process.Start(new ProcessStartInfo("xdg-open")
            {
                ArgumentList = { $"steam://url/CommunityFilePage/{workshopId}" },
                UseShellExecute = false
            });
        }
        catch { }

        progress?.Report((-1, "Waiting for Steam to download… Subscribe to the item in Steam."));

        string[] candidates =
        [
            Path.Combine(workshopBasePath, workshopId),
            Path.Combine(SteamCmdWorkshopContentDir, workshopId)
        ];

        const int maxWaitMs = 600_000;
        const int pollMs = 3_000;
        int waited = 0;

        while (waited < maxWaitMs)
        {
            ct.ThrowIfCancellationRequested();

            foreach (var dir in candidates)
            {
                if (IsWorkshopDirReady(dir))
                    return dir;
            }

            await Task.Delay(pollMs, ct);
            waited += pollMs;
        }

        throw new TimeoutException(
            $"Timed out waiting for workshop item {workshopId} to download from Steam. " +
            "Make sure you subscribed to the item and Steam is running.");
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

    private static bool IsWorkshopDirReady(string dir)
    {
        if (!Directory.Exists(dir)) return false;
        string pj = Path.Combine(dir, "project.json");
        if (!File.Exists(pj)) return false;
        try { return new FileInfo(pj).Length > 10; }
        catch { return false; }
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
