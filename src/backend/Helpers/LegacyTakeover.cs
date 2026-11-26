using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Liascape.Player;

namespace Liascape.Helpers;

// A wallpaper session an older build left running: its mpvpaper / linux-wallpaperengine / helper processes would stay on
// screen beside liascape-player, and its timer / restart / monitor daemons would keep switching and muting. Stopped at
// `serve` start and `restore` (and the daemons by `stop`), then the session plays on the player
// (ServerHost.Run). The one place the backend still names those programs: they are what an older build ran, never
// what this one starts. Guard: scripts/test-player-binary.sh § a legacy settings file
public static class LegacyTakeover
{
    [DllImport("libc")] private static extern int kill(int pid, int sig);
    [DllImport("libc", SetLastError = true)] private static extern long syscall(long number, int a, nint b, nint c, uint d);
    [DllImport("libc")] private static extern int close(int fd);
    // pidfd_open / pidfd_send_signal: the same number on every architecture (Linux 5.1 / 5.3)
    private const long SysPidfdSendSignal = 424, SysPidfdOpen = 434;
    private const int SIGTERM = 15, SIGKILL = 9;
    // how long a process asked to stop gets before it is killed (one budget for the whole batch)
    private const int TermGraceMs = 2000;

    private static string ConfigFile(string name) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "liascape", name);

    // Both halves; returns how many processes of an older build's session it stopped (the caller replays the session when
    // any: a timer-daemon alone is a rotation between two wallpapers).
    // Guard: scripts/test-player-binary.sh § a timer-daemon alone
    public static int Run() => StopDaemons() + StopWallpapers();

    // A timer-daemon / restart-daemon / monitor-daemon an older build left: verified by its command line (a pid file
    // outlives a reboot: its number may belong to anything by now); its pid file goes with it. Returns how many it stopped.
    public static int StopDaemons()
    {
        var stopping = new List<(int pid, ulong start, string what)>();
        foreach (var (pidFile, verb) in new[] { (ConfigFile("timer.pid"), "timer-daemon"), (ConfigFile("restart.pid"), "restart-daemon"), (ConfigFile("monitor.pid"), "monitor-daemon") })
        {
            try
            {
                if (!File.Exists(pidFile)) continue;
                if (int.TryParse(File.ReadAllText(pidFile).Trim(), out int pid) && pid != Environment.ProcessId)
                {
                    string[] argv = [];
                    try { argv = File.ReadAllText($"/proc/{pid}/cmdline").Split('\0'); } catch { }
                    if (argv.Contains(verb) && argv.Any(a => a.Contains("liascape")) && Stat(pid) is { } st)
                        stopping.Add((pid, st.start, $"a leftover {verb}"));
                }
                File.Delete(pidFile);
            }
            catch { }
        }
        Stop(stopping);
        return stopping.Count;
    }

    // Every wallpaper process of an older build's session of THIS user: matched by program name (argv[0] or the
    // executable, a Nix `.<name>-wrapped` counts), and only a process whose HOME is ours — a hermetic test's backend must
    // never reach the desktop session's wallpaper. Detached (setsid) by the build that started them, so /proc is the only
    // way to find them. Returns how many it stopped.
    public static int StopWallpapers()
    {
        var names = new HashSet<string> { "mpvpaper", "liascape-transition", "liascape-audio", "linux-wallpaperengine" };
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrEmpty(home)) return 0;
        static string Norm(string? path)
        {
            var n = Path.GetFileName(path ?? "");
            if (n.StartsWith('.') && n.EndsWith("-wrapped")) n = n[1..^"-wrapped".Length];
            return n;
        }
        var stopping = new List<(int pid, ulong start, string what)>();
        foreach (var dir in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(dir), out int pid) || pid == Environment.ProcessId) continue;
            try
            {
                var argv0 = File.ReadAllText(Path.Combine(dir, "cmdline")).Split('\0')[0];
                string? exe = null;
                try { exe = new FileInfo(Path.Combine(dir, "exe")).LinkTarget; } catch { }
                var name = names.Contains(Norm(argv0)) ? Norm(argv0) : names.Contains(Norm(exe)) ? Norm(exe) : null;
                if (name == null) continue;
                var env = File.ReadAllText(Path.Combine(dir, "environ")).Split('\0');
                if (!env.Contains("HOME=" + home)) continue;
                if (Stat(pid) is { } st) stopping.Add((pid, st.start, $"a legacy wallpaper process: {name}"));
            }
            catch { } // gone meanwhile, or not ours to read
        }
        Stop(stopping);
        return stopping.Count;
    }

    // SIGTERM each with its process tree (a daemon's children, a wallpaper's helpers — a whole-tree kill, as the build
    // that started them did), then SIGKILL whatever is still there once the grace ran out. Each process is known by its
    // pid AND its start time (`/proc/<pid>/stat` field 22) from the moment it was matched, and signalled through a pidfd
    // opened before that start time is checked again: the fd stays bound to the process checked, so a pid that exited and
    // was reused meanwhile is never signalled (a kernel without pidfds: the start-time check right before kill(2)).
    // Guard: scripts/test-player-binary.sh § a legacy settings file
    private static void Stop(List<(int pid, ulong start, string what)> procs)
    {
        if (procs.Count == 0) return;
        var targets = new List<Target>();
        var all = Snapshot();
        try
        {
            foreach (var (pid, start, what) in procs)
            {
                if (!all.TryGetValue(pid, out var root) || root.start != start) continue; // gone already (or its pid reused)
                var tree = new List<(int pid, ulong start)> { (pid, start) };
                for (int i = 0; i < tree.Count; i++)
                    foreach (var (child, st) in all)
                        if (st.ppid == tree[i].pid && !tree.Any(t => t.pid == child)) tree.Add((child, st.start));
                foreach (var (p, st) in tree)
                {
                    var t = Target.Open(p, st);
                    if (t == null) continue; // gone already
                    targets.Add(t);
                    t.Signal(SIGTERM);
                }
                LiascapePlayerClient.Log($"stopped {what} (pid {pid}){(tree.Count > 1 ? $" with {tree.Count - 1} child process(es)" : "")}");
            }
            var deadline = Environment.TickCount64 + TermGraceMs;
            var left = targets.Where(t => t.Alive).ToList();
            while (left.Count > 0 && Environment.TickCount64 < deadline)
            {
                Thread.Sleep(50);
                left.RemoveAll(t => !t.Alive);
            }
            foreach (var t in left)
            {
                if (!t.Alive) continue;
                t.Signal(SIGKILL);
                LiascapePlayerClient.Log($"pid {t.Pid} ignored SIGTERM for {TermGraceMs} ms — SIGKILL");
            }
        }
        finally { foreach (var t in targets) t.Dispose(); }
    }

    // One process to stop: its pid, the start time it was matched with, and a pidfd bound to it (-1: no pidfd support).
    private sealed class Target(int pid, ulong start, int fd) : IDisposable
    {
        public int Pid => pid;
        private int _fd = fd;

        // null when the process is gone or its pid now names another process
        public static Target? Open(int pid, ulong start)
        {
            int fd = (int)syscall(SysPidfdOpen, pid, 0, 0, 0);
            if (Same((pid, start))) return new Target(pid, start, fd);
            if (fd >= 0) close(fd);
            return null;
        }

        public bool Alive => Same((pid, start));

        public void Signal(int sig)
        {
            if (_fd >= 0) syscall(SysPidfdSendSignal, _fd, sig, 0, 0);
            else if (Same((pid, start))) kill(pid, sig);
        }

        public void Dispose()
        {
            if (_fd >= 0) close(_fd);
            _fd = -1;
        }
    }

    // Every live process: its parent and start time (zombies and exiting ones left out: they hold nothing any more).
    private static Dictionary<int, (int ppid, ulong start)> Snapshot()
    {
        var d = new Dictionary<int, (int, ulong)>();
        foreach (var dir in Directory.EnumerateDirectories("/proc"))
            if (int.TryParse(Path.GetFileName(dir), out int pid) && pid != Environment.ProcessId && Stat(pid) is { } st)
                d[pid] = st;
        return d;
    }

    // still the process matched (same start time) and alive
    private static bool Same((int pid, ulong start) t) => Stat(t.pid) is { } st && st.start == t.start;

    // `/proc/<pid>/stat`: fields after the `(comm)` — state (3), ppid (4), start time (22); null when gone or a zombie
    private static (int ppid, ulong start)? Stat(int pid)
    {
        try
        {
            var stat = File.ReadAllText($"/proc/{pid}/stat");
            int close = stat.LastIndexOf(')');
            if (close < 0) return null;
            var f = stat[(close + 2)..].Split(' ');
            if (f.Length < 20 || f[0] is "Z" or "X") return null;
            return (int.Parse(f[1]), ulong.Parse(f[19]));
        }
        catch { return null; }
    }
}
