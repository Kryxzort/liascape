using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Liascape.Helpers;

// A wallpaper process the backend starts must outlive the backend. `setsid` leaves the session but not the cgroup: a
// backend running in a systemd unit (the dev stack's liascape-watch.service, a packaged user service) keeps its children
// in that unit's cgroup, and stopping the unit (KillMode=control-group) SIGTERMs them with it. When the user's systemd
// manager answers, the child is started through `systemd-run --user --scope`, which moves its own pid into a fresh
// transient scope and then execs the command, so the pid the caller sees is still the wallpaper process's own (its
// exit code, its /proc identity). With no manager, no systemd-run or a refused probe the child starts as before, and the
// reason is logged once.
// Guard: scripts/test-backend-stop.sh § "the backend in a systemd unit".
public static class UserScope
{
    [DllImport("libc")] private static extern int kill(int pid, int sig);
    private static readonly object Gate = new();
    private static bool? _usable;

    // The arguments to put between `setsid` and the command: `systemd-run --user --scope … --unit=<prefix>-<random> --`,
    // or none when no user manager can take a scope. `prefix` names what runs in it (`liascape-player`, `mpvpaper`).
    public static IReadOnlyList<string> Prefix(string prefix, Action<string> log)
    {
        if (!Usable(log)) return [];
        return ["systemd-run", "--user", "--scope", "--collect", "--quiet", $"--unit={UnitName(prefix)}",
                $"--description=Liascape {prefix}", "--"];
    }

    // A random suffix, never a pid or a counter: a stale scope of a dead backend's player may still hold an older name,
    // and systemd-run refuses a unit that exists.
    internal static string UnitName(string prefix) =>
        $"{prefix}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}.scope";

    // Decided once per process: the manager of THIS XDG_RUNTIME_DIR, never the session bus's. systemd-run --user tries
    // $XDG_RUNTIME_DIR/systemd/private first and falls back to the session bus, so a test with a private runtime dir but
    // the session's DBUS_SESSION_BUS_ADDRESS would otherwise put its players into the desktop's own user manager.
    private static bool Usable(Action<string> log)
    {
        lock (Gate)
        {
            if (_usable is bool known) return known;
            var why = Probe();
            _usable = why == null;
            log(why == null ? "wallpaper processes start in their own systemd user scope"
                            : $"wallpaper processes start without a systemd scope ({why}): stopping a systemd unit the backend runs in stops them too");
            return _usable.Value;
        }
    }

    private static string? Probe()
    {
        var rt = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        if (string.IsNullOrEmpty(rt)) return "no XDG_RUNTIME_DIR";
        if (!File.Exists(Path.Combine(rt, "systemd", "private"))) return "no systemd user manager on this XDG_RUNTIME_DIR";
        // The real move, not just a reachable bus: a manager can answer and still refuse to adopt this process
        // (a container, a cgroup it may not migrate from).
        var psi = new ProcessStartInfo("systemd-run")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in new[] { "--user", "--scope", "--collect", "--quiet", $"--unit={UnitName("liascape-probe")}", "--", "true" })
            psi.ArgumentList.Add(a);
        Process? p;
        try { p = Process.Start(psi); }
        catch (Exception e) { return $"systemd-run: {e.Message}"; }
        if (p == null) return "systemd-run did not start";
        using (p)
        {
            var err = p.StandardError.ReadToEndAsync();
            _ = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(3000))
            {
                kill(p.Id, 15); // SIGTERM first: let it close its bus connection cleanly
                if (!p.WaitForExit(1000)) { try { p.Kill(); } catch { } }
                return "systemd-run did not answer within 3 s";
            }
            if (p.ExitCode != 0)
            {
                var msg = err.Wait(500) ? err.Result.Trim() : "";
                return $"systemd-run exited {p.ExitCode}{(msg.Length > 0 ? ": " + msg.Split('\n')[0] : "")}";
            }
        }
        return null;
    }
}
