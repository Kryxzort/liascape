using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Liascape.Models;

namespace Liascape.Helpers;

// "Start with your desktop" (AppSettings.StartWithDesktop): Liascape's own XDG autostart entry,
// $XDG_CONFIG_HOME/autostart/liascape.desktop, running `liascape restore`. On, it is written; off, it is removed, and only
// a file that carries our marker line counts as ours (a liascape.desktop the user wrote is never touched, and nothing else
// in the folder ever is). An entry only helps where something runs autostart entries, so every status says whether this
// session does (`Detect`) and, where it doesn't, the line for the compositor's own config instead. The compositor's config
// is only ever read, to search it: one that already runs `liascape restore` gets no entry on top (restore would run twice).
// Guard: scripts/test-autostart.sh
public static class Autostart
{
    public const string Marker = "X-Liascape-Autostart=true";
    private static readonly object _lock = new();

    // state: runs (autostart entries run here) | compositor (its config already runs `liascape restore`, configFile names
    // where) | wontRun (Hyprland / Sway with nothing that runs them: put `line` in its config) | unknown.
    // via: what runs them (desktop | uwsm | systemd | dex). entry: none | ours | foreign (a liascape.desktop that isn't
    // ours). exec: the entry's Exec value; null with `missing` saying why when no command resolves.
    public sealed record Status(
        bool enabled, string state, string reason, string? via, string? compositor, string line, string? configFile,
        string entry, string entryPath, string? exec, string? missing, string? error = null);

    // what a session's environment says it runs; Systemd = `systemctl --user is-active xdg-desktop-autostart.target`'s answer
    // (null: no user manager answered), asked only when nothing before it decided
    public sealed record DetectIn(Func<string, string?> Env, IEnumerable<string> EnvNames, string? Compositor,
        Func<string?> Systemd, string? RestoreFile, string? DexFile);

    // desktops whose session starts autostart entries itself (an XDG_CURRENT_DESKTOP / XDG_SESSION_DESKTOP name, lowercased)
    private static readonly Dictionary<string, string> Desktops = new()
    {
        ["kde"] = "KDE Plasma", ["plasma"] = "KDE Plasma", ["plasmawayland"] = "KDE Plasma", ["gnome"] = "GNOME",
        ["gnome-classic"] = "GNOME", ["gnome-flashback"] = "GNOME", ["ubuntu"] = "GNOME", ["xfce"] = "Xfce", ["lxqt"] = "LXQt",
        ["lxde"] = "LXDE", ["mate"] = "MATE", ["x-cinnamon"] = "Cinnamon", ["cinnamon"] = "Cinnamon", ["budgie"] = "Budgie",
        ["budgie-desktop"] = "Budgie", ["unity"] = "Unity", ["pantheon"] = "Pantheon", ["deepin"] = "Deepin", ["dde"] = "Deepin",
        ["cosmic"] = "COSMIC", ["ukui"] = "UKUI",
    };

    private static IEnumerable<string> Names(Func<string, string?> env) =>
        new[] { "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP" }
            .SelectMany(k => (env(k) ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Select(n => n.ToLowerInvariant());

    public static string? CompositorOf(Func<string, string?> env)
    {
        var names = Names(env).ToList();
        if (!string.IsNullOrEmpty(env("HYPRLAND_INSTANCE_SIGNATURE")) || names.Contains("hyprland")) return "Hyprland";
        if (!string.IsNullOrEmpty(env("SWAYSOCK")) || names.Contains("sway")) return "Sway";
        return null;
    }

    public static (string state, string reason, string? via) Detect(DetectIn i)
    {
        string? comp = i.Compositor;
        if (i.RestoreFile != null)
            return ("compositor", $"your {comp} config already runs liascape restore ({i.RestoreFile})", null);
        var de = Names(i.Env).Select(n => Desktops.GetValueOrDefault(n)).FirstOrDefault(n => n != null)
            ?? (i.Env("KDE_FULL_SESSION") == "true" ? "KDE Plasma" : !string.IsNullOrEmpty(i.Env("GNOME_DESKTOP_SESSION_ID")) ? "GNOME" : null);
        if (de != null) return ("runs", $"{de} starts autostart entries itself", "desktop");
        if (i.EnvNames.Any(n => n.StartsWith("UWSM_", StringComparison.Ordinal))
            || (i.Env("DESKTOP_SESSION") ?? "").Contains("uwsm", StringComparison.OrdinalIgnoreCase))
            return ("runs", "uwsm starts autostart entries for your session", "uwsm");
        if (i.Systemd() == "active")
            return ("runs", "your session's systemd starts autostart entries (xdg-desktop-autostart.target is active)", "systemd");
        if (i.DexFile != null) return ("runs", $"dex starts autostart entries from your {comp} config ({i.DexFile})", "dex");
        if (comp != null)
            return ("wontRun", $"{comp} was started without anything that runs autostart entries (no uwsm, no systemd autostart, no dex)", null);
        return ("unknown", "Liascape can't tell whether your session runs autostart entries: it knows neither its desktop nor its compositor, and neither uwsm nor systemd runs them", null);
    }

    // `liascape restore` in a line that isn't a comment: a bare name, a path or an AppImage, quoted or not
    private static readonly Regex RestoreRx = new(@"(?<![\w.-])liascape[\w.-]*['""]?\s+['""]?restore\b", RegexOptions.IgnoreCase);
    // dex run with --autostart / -a (alone or among other short flags), anywhere after its name
    private static readonly Regex DexRx = new(@"(?<![\w.-])dex(\s+\S+)*?\s+(--autostart|-[A-Za-z]*a[A-Za-z]*)(\s|$)");

    // The compositor's config, searched (never written): the first file whose live lines run `liascape restore`, and the first
    // that runs dex as an autostart runner. Bounded: 3 folders deep, 300 files, 1 MiB each, text only.
    public static (string? restore, string? dex) ScanConfig(string configHome, string home, string compositor)
    {
        var dirs = compositor == "Hyprland" ? new[] { Path.Combine(configHome, "hypr") }
            : new[] { Path.Combine(configHome, "sway"), Path.Combine(home, ".sway") };
        string? restore = null, dex = null;
        var opts = new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, IgnoreInaccessible = true, AttributesToSkip = 0 };
        int files = 0;
        foreach (var dir in dirs.Where(Directory.Exists))
        {
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir, "*", opts))
                {
                    if (++files > 300 || (restore != null && dex != null)) break;
                    bool lua = f.EndsWith(".lua", StringComparison.Ordinal);
                    if (compositor == "Hyprland" && !lua && !f.EndsWith(".conf", StringComparison.Ordinal)) continue;
                    // a regular file's first bytes only: a FIFO or a device among the configs never blocks the read
                    var head = Liascape.Web.ApiSecurity.ReadHead(f, (1 << 20) + 1);
                    if (head == null || head.Length > 1 << 20 || Array.IndexOf(head, (byte)0) >= 0) continue;
                    foreach (var raw in Encoding.UTF8.GetString(head).Split('\n'))
                    {
                        var line = Live(raw, lua);
                        if (line.Length == 0) continue;
                        if (restore == null && RestoreRx.IsMatch(line)) restore = Shown(f, home);
                        if (dex == null && DexRx.IsMatch(line)) dex = Shown(f, home);
                    }
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        return (restore, dex);
    }

    // a config line without its comment (`#` in Hyprland's and Sway's, `--` in Lua)
    private static string Live(string raw, bool lua)
    {
        var t = raw.Trim();
        if (lua) { int c = t.IndexOf("--", StringComparison.Ordinal); return c < 0 ? t : t[..c].Trim(); }
        if (t.StartsWith('#')) return "";
        int h = t.IndexOf(" #", StringComparison.Ordinal);
        return h < 0 ? t : t[..h].Trim();
    }

    private static string Shown(string path, string home) =>
        home.Length > 1 && path.StartsWith(home + "/", StringComparison.Ordinal) ? "~" + path[home.Length..] : path;

    // The command the entry runs: the AppImage itself (its mount goes when it exits), else the launcher that started this
    // backend (scripts/liascape exports LIASCAPE_LAUNCHER) — a Nix store path only when no profile link to a liascape is
    // on PATH (a store path stops working once a garbage collection takes an older generation) — else `liascape` on PATH.
    public static (string? cmd, string? missing) ResolveCommand(Func<string, string?> env, IEnumerable<string> pathDirs, Func<string, bool> isFile)
    {
        if (env("APPIMAGE") is { Length: > 0 } image && isFile(image)) return (image, null);
        var onPath = pathDirs.Where(d => d.StartsWith('/')).Select(d => Path.Combine(d, "liascape")).Where(isFile).ToList();
        var profile = onPath.FirstOrDefault(p => !p.StartsWith("/nix/store/", StringComparison.Ordinal));
        if (env("LIASCAPE_LAUNCHER") is { Length: > 0 } launcher)
            return (launcher.StartsWith("/nix/store/", StringComparison.Ordinal) ? profile ?? launcher : launcher, null);
        if (onPath.Count > 0) return (profile ?? onPath[0], null);
        return (null, "Liascape couldn't find its liascape command (it wasn't started from its launcher, and none is on PATH)");
    }

    // One argument of a desktop entry's Exec (the Desktop Entry spec): `%` doubled; one with a reserved character goes in
    // double quotes with `"` `` ` `` `$` `\` escaped, and every backslash written twice (the string escape is read first).
    // A control character can't be written at all.
    public static string? DesktopArg(string s)
    {
        if (s.Any(c => c < 0x20 || c == 0x7f)) return null;
        var v = s.Replace("%", "%%");
        if (v.IndexOfAny(" \t\"'\\><~|&;$*?#()`".ToCharArray()) < 0) return v;
        var q = new StringBuilder("\"");
        foreach (var c in v) { if (c is '"' or '`' or '$' or '\\') q.Append('\\'); q.Append(c); }
        return q.Append('"').ToString().Replace("\\", "\\\\");
    }

    // one word for `sh -c` (what Hyprland's exec-once and Sway's exec run)
    public static string ShellArg(string s) =>
        Regex.IsMatch(s, @"^[A-Za-z0-9_./+:@%-]+$") ? s : "'" + s.Replace("'", "'\\''") + "'";

    public static string Line(string? compositor, string cmd) => compositor switch
    {
        "Hyprland" => $"exec-once = {cmd} restore",
        "Sway" => $"exec {cmd} restore",
        _ => $"{cmd} restore",
    };

    public static string EntryText(string exec) => $"""
        [Desktop Entry]
        Type=Application
        Name=Liascape
        Comment=Puts your wallpaper back when you log in
        Exec={exec}
        Icon=liascape
        Terminal=false
        X-GNOME-Autostart-enabled=true
        {Marker}

        """;

    public static string EntryPath => Path.Combine(ConfigHome, "autostart", "liascape.desktop");
    // $XDG_CONFIG_HOME (~/.config): AppDirs' base
    private static string ConfigHome => Path.GetDirectoryName(AppDirs.Config)!;

    // none | ours (a regular file with our marker line) | foreign (anything else under that name: never touched)
    public static string EntryState(string path)
    {
        var fi = new FileInfo(path);
        if (!fi.Exists && !Directory.Exists(path) && fi.LinkTarget == null) return "none";
        if (fi.LinkTarget != null || !fi.Exists) return "foreign";
        try { return File.ReadLines(path).Any(l => l.Trim() == Marker) ? "ours" : "foreign"; } catch { return "foreign"; }
    }

    // Read-only: what this session runs and what the entry would be. GET /health/features reads it.
    public static Status Check(AppSettings s)
    {
        Func<string, string?> env = Environment.GetEnvironmentVariable;
        var names = Environment.GetEnvironmentVariables().Keys.Cast<string>().ToList();
        var home = Environment.GetEnvironmentVariable("HOME") ?? "";
        var comp = CompositorOf(env);
        var (restoreFile, dexFile) = comp != null ? ScanConfig(ConfigHome, home, comp) : (null, null);
        var (state, reason, via) = Detect(new DetectIn(env, names, comp, SystemdAutostart, restoreFile, dexFile));
        var pathDirs = (env("PATH") ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries);
        var (cmd, missing) = ResolveCommand(env, pathDirs, File.Exists);
        string? exec = null;
        if (cmd != null)
        {
            if (DesktopArg(cmd) is { } arg) exec = arg + " restore";
            else missing = $"Liascape's command ({cmd}) has a character an autostart entry can't hold";
        }
        // the line uses the bare name when the first `liascape` on PATH is that same command
        var first = pathDirs.Where(d => d.StartsWith('/')).Select(d => Path.Combine(d, "liascape")).FirstOrDefault(File.Exists);
        bool bare = cmd == null || (first != null && env("APPIMAGE") is not { Length: > 0 }
            && (first == cmd || Liascape.Web.ApiSecurity.RealPath(first) == Liascape.Web.ApiSecurity.RealPath(cmd)));
        var path = EntryPath;
        return new Status(s.StartWithDesktop, state, reason, via, comp, Line(comp, bare ? "liascape" : ShellArg(cmd!)),
            restoreFile, EntryState(path), path, exec, missing);
    }

    // The entry made to match the setting: written (or rewritten when its Exec moved: a new AppImage place, a new install)
    // while it is on, wanted and possible, removed (ours only) otherwise. /settings runs it on a change, `serve` at start
    // and GET /autostart on every read, so a compositor line added since takes the entry away.
    public static Status Sync(AppSettings s)
    {
        lock (_lock)
        {
            var st = Check(s);
            bool want = s.StartWithDesktop && st.state != "compositor" && st.exec != null && st.entry != "foreign";
            try
            {
                if (want)
                {
                    var text = EntryText(st.exec!);
                    if (st.entry != "ours" || File.ReadAllText(st.entryPath) != text)
                    {
                        AtomicFile.WriteAllText(st.entryPath, text);
                        Console.WriteLine($"autostart: wrote {st.entryPath}");
                    }
                    return st with { entry = "ours" };
                }
                if (st.entry == "ours")
                {
                    File.Delete(st.entryPath);
                    Console.WriteLine($"autostart: removed {st.entryPath}");
                    return st with { entry = "none" };
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Console.WriteLine($"autostart: {st.entryPath}: {e.Message}");
                return st with { error = e.Message };
            }
            return st;
        }
    }

    // the manager of THIS XDG_RUNTIME_DIR only, never the session bus's: `systemctl --user` falls back to the session bus
    // when the runtime dir has no manager, so a test with a private runtime dir but the desktop's DBUS_SESSION_BUS_ADDRESS
    // would read the desktop's (as Helpers/UserScope.cs guards for systemd-run)
    private static string? SystemdAutostart()
    {
        var rt = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        if (string.IsNullOrEmpty(rt) || !File.Exists(Path.Combine(rt, "systemd", "private"))) return null;
        var r = ChildProcess.RunAsync("systemctl", ["--user", "is-active", "xdg-desktop-autostart.target"], TimeSpan.FromMilliseconds(1500))
            .GetAwaiter().GetResult();
        var said = r.Out.Trim();
        return r.Exit == null || said.Length == 0 || said.Contains(' ') ? null : said;
    }
}
