using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Liascape.Helpers;

// Where the Steam sign-in's secrets live (owner 2026-11-11: "wait, steam token is kept in plaintext??" → "system keyring and
// then fallback to some file other than settings.json"). Three names: the refresh token (~200 days), the cached web cookie
// (~24 h), a pasted steamLoginSecure. Every reader / writer goes through here (SteamAuthService, SteamOps, WorkshopDownloader).
//  - Primary: the freedesktop Secret Service (GNOME Keyring, KWallet's provider, KeePassXC) through libsecret's `secret-tool`
//    — attributes `application=liascape name=<name>`; the value goes over stdin, never argv (argv is world-readable in /proc).
//    Used when `secret-tool` is on PATH, a session bus is reachable and a probe lookup answers cleanly (once per process).
//  - Fallback: `$XDG_CONFIG_HOME/liascape/steam-auth.json` ({name: value}), 0600 from its creation (AtomicFile.WritePrivate),
//    under its own flock. Never settings.json.
//  - A lookup that fails / is denied (a dismissed unlock prompt) reads as absent (signed out) and the keyring is left alone for
//    10 min, so a locked keyring never prompts in a loop; a store that fails falls back to the file.
//  - Migration: an older settings.json still holding them (AppSettings.Legacy*) → moved here, then nulled there (a field-level
//    SettingsService.Update); a failed store leaves settings.json untouched. Re-checked whenever settings.json changes.
// Never logs a value. `LIASCAPE_SECRETS=file` forces the fallback.
public static class SecretStore
{
    public const string RefreshToken = "steam-refresh-token";
    public const string AccessToken = "steam-access-token";
    public const string LoginSecure = "steam-login-secure";
    private static readonly string[] Names = [RefreshToken, AccessToken, LoginSecure];

    public static string FallbackPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "liascape", "steam-auth.json");

    private enum Kind { Unknown, Keyring, File }
    private static Kind _kind;
    private static string? _tool;
    private static DateTime _keyringQuietUntil;
    private static readonly Dictionary<string, (string? Value, DateTime Until)> Cache = new();
    private static (DateTime, long) _settingsSeen;
    private static readonly object Gate = new();

    // "keyring" | "file" — which one this process uses (detected on first use)
    public static string Backend { get { lock (Gate) return Detect() == Kind.Keyring ? "keyring" : "file"; } }

    public static string? Get(string name)
    {
        lock (Gate)
        {
            MigrateIfNeeded();
            if (Detect() == Kind.Keyring && DateTime.UtcNow >= _keyringQuietUntil)
            {
                if (Cache.TryGetValue(name, out var c) && DateTime.UtcNow < c.Until) return c.Value;
                var sw = Stopwatch.StartNew();
                var (found, value, error) = KeyringLookup(name);
                if (error != null)
                {
                    Quiet($"a keyring lookup failed ({error})");
                    return FileGet(name);
                }
                if (found) { Cache[name] = (value, DateTime.UtcNow.AddSeconds(5)); return value; }
                // nothing there after a long wait = most likely an unlock prompt the user dismissed: don't ask again soon
                if (sw.ElapsedMilliseconds > 2000) Quiet("the keyring answered nothing after a wait (locked / prompt dismissed?)");
                // a leftover from a time without a keyring → into the keyring
                var f = FileGet(name);
                if (f != null && KeyringStore(name, f)) FileDelete(name);
                Cache[name] = (f, DateTime.UtcNow.AddSeconds(f == null ? 30 : 5));
                return f;
            }
            return FileGet(name);
        }
    }

    // false = neither the keyring nor the file took it. Null / empty = Delete.
    public static bool Set(string name, string? value)
    {
        lock (Gate)
        {
            MigrateIfNeeded();
            return SetInner(name, value);
        }
    }

    public static void Delete(string name) { lock (Gate) { MigrateIfNeeded(); DeleteInner(name); } }

    // every secret (sign-out)
    public static void Clear() { lock (Gate) { MigrateIfNeeded(); foreach (var n in Names) DeleteInner(n); } }

    // serve's startup: an older settings.json is cleaned even when nothing asks for a secret
    public static void MigrateNow() { lock (Gate) MigrateIfNeeded(); }

    // the self-test: forget the detection, the cache and the migration mark (a new environment / file under test)
    internal static void ResetForTest() { lock (Gate) { _kind = Kind.Unknown; _tool = null; _keyringQuietUntil = default; Cache.Clear(); _settingsSeen = default; } }

    private static bool SetInner(string name, string? value)
    {
        Cache.Remove(name);
        if (string.IsNullOrEmpty(value)) { DeleteInner(name); return true; }
        if (Detect() == Kind.Keyring && KeyringStore(name, value))
        {
            FileDelete(name); // a stale fallback copy
            Cache[name] = (value, DateTime.UtcNow.AddSeconds(5));
            return true;
        }
        if (Detect() == Kind.Keyring) Console.WriteLine("secrets: the keyring didn't take it — kept in the file fallback");
        return FileSet(name, value);
    }

    private static void DeleteInner(string name)
    {
        Cache.Remove(name);
        if (Detect() == Kind.Keyring) KeyringClear(name);
        FileDelete(name);
    }

    private static void Quiet(string why)
    {
        if (DateTime.UtcNow < _keyringQuietUntil) return;
        _keyringQuietUntil = DateTime.UtcNow.AddMinutes(10);
        Cache.Clear();
        Console.WriteLine($"secrets: {why} — signed out as far as this app can tell; not asking the keyring again for 10 min");
    }

    // ---- migration out of settings.json ----

    private static void MigrateIfNeeded()
    {
        var fi = new FileInfo(SettingsService.FilePath);
        if (!fi.Exists) return;
        var key = (fi.LastWriteTimeUtc, fi.Length);
        if (key == _settingsSeen) return;
        _settingsSeen = key;
        var s = SettingsService.Load();
        var found = new List<(string Name, string Value)>();
        if (!string.IsNullOrEmpty(s.LegacySteamRefreshToken)) found.Add((RefreshToken, s.LegacySteamRefreshToken));
        if (!string.IsNullOrEmpty(s.LegacySteamAccessToken)) found.Add((AccessToken, s.LegacySteamAccessToken));
        if (!string.IsNullOrEmpty(s.LegacySteamLoginSecure)) found.Add((LoginSecure, s.LegacySteamLoginSecure));
        if (found.Count == 0) return;
        foreach (var (n, v) in found)
            if (!SetInner(n, v))
            {
                Console.WriteLine("secrets: couldn't move the Steam sign-in out of settings.json — left there for now");
                _settingsSeen = default; // try again next time
                return;
            }
        // only what was moved (a value changed meanwhile by another writer stays for the next pass)
        string? rt = Find(RefreshToken), at = Find(AccessToken), ls = Find(LoginSecure);
        SettingsService.Update(x =>
        {
            if (rt != null && x.LegacySteamRefreshToken == rt) x.LegacySteamRefreshToken = null;
            if (at != null && x.LegacySteamAccessToken == at) x.LegacySteamAccessToken = null;
            if (ls != null && x.LegacySteamLoginSecure == ls) x.LegacySteamLoginSecure = null;
        });
        Console.WriteLine($"secrets: moved the Steam sign-in out of settings.json into {(Detect() == Kind.Keyring ? "the Secret Service" : "the file fallback")}");
        string? Find(string n) => found.FirstOrDefault(f => f.Name == n).Value;
    }

    // ---- which backend ----

    private static Kind Detect()
    {
        if (_kind != Kind.Unknown) return _kind;
        string? why = null;
        if (string.Equals(Environment.GetEnvironmentVariable("LIASCAPE_SECRETS"), "file", StringComparison.OrdinalIgnoreCase))
            why = "LIASCAPE_SECRETS=file";
        else if ((_tool = FindTool()) == null) why = "secret-tool not found — install libsecret to use the system keyring";
        else if (!FeatureHealth.SessionBusReachable()) why = "no D-Bus session bus";
        else
        {
            // a lookup of a name never stored: exit 1 with nothing on stderr = the Secret Service answered "not found"
            var (code, _, err) = Run(["lookup", "application", "liascape", "name", "probe"], null, 5000);
            if (!(code == 0 || (code == 1 && string.IsNullOrWhiteSpace(err))))
                why = "no Secret Service answered" + (string.IsNullOrWhiteSpace(err) ? "" : $": {FirstLine(err)}");
        }
        _kind = why == null ? Kind.Keyring : Kind.File;
        Console.WriteLine(_kind == Kind.Keyring ? "secrets: Secret Service (the system keyring, via secret-tool)" : $"secrets: file fallback ({why})");
        return _kind;
    }

    private static string? FindTool()
    {
        var o = Environment.GetEnvironmentVariable("LIASCAPE_SECRET_TOOL"); // tests: a stub
        if (!string.IsNullOrEmpty(o)) return File.Exists(o) ? o : null;
        return (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':')
            .Where(d => d.Length > 0).Select(d => Path.Combine(d, "secret-tool")).FirstOrDefault(File.Exists);
    }

    private static string FirstLine(string s) { var l = s.Trim().Split('\n')[0].Trim(); return l.Length > 160 ? l[..160] : l; }

    // ---- the Secret Service via secret-tool (the value only ever on stdin / stdout) ----

    private static string[] Attrs(string name) => ["application", "liascape", "name", name];

    private static (bool Found, string? Value, string? Error) KeyringLookup(string name)
    {
        // 60 s: a locked keyring asks the user to unlock it
        var (code, outp, err) = Run(["lookup", .. Attrs(name)], null, 60000);
        if (code == 0) return (outp.Length > 0, outp.Length > 0 ? outp : null, null);
        if (code == 1 && string.IsNullOrWhiteSpace(err)) return (false, null, null);
        return (false, null, code == -1 ? "timed out" : FirstLine(err));
    }

    private static bool KeyringStore(string name, string value)
    {
        var (code, _, err) = Run(["store", $"--label=Liascape: Steam sign-in ({name})", .. Attrs(name)], value, 60000);
        if (code != 0) Console.WriteLine($"secrets: keyring store failed ({(code == -1 ? "timed out" : FirstLine(err))})");
        return code == 0;
    }

    private static void KeyringClear(string name)
    {
        var (code, _, err) = Run(["clear", .. Attrs(name)], null, 60000);
        if (code != 0 && !string.IsNullOrWhiteSpace(err)) Console.WriteLine($"secrets: keyring clear failed ({FirstLine(err)})");
    }

    // exit code (-1 = timed out / couldn't start), stdout, stderr
    private static (int Code, string Out, string Err) Run(string[] args, string? stdin, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo(_tool!)
            {
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var o = p.StandardOutput.ReadToEndAsync();
            var e = p.StandardError.ReadToEndAsync();
            if (stdin != null) p.StandardInput.Write(stdin);
            p.StandardInput.Close();
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } return (-1, "", ""); }
            p.WaitForExit();
            return (p.ExitCode, o.Result, e.Result);
        }
        catch (Exception ex) { return (-1, "", ex.Message); }
    }

    // ---- the file fallback ----

    private static Dictionary<string, string> FileRead()
    {
        try { return AtomicFile.ReadJson<Dictionary<string, string>>(FallbackPath) ?? new(); }
        catch { return new(); } // unreadable → nothing stored (never crash over it)
    }

    private static string? FileGet(string name) => FileRead().TryGetValue(name, out var v) && v.Length > 0 ? v : null;

    private static bool FileSet(string name, string value)
    {
        try
        {
            using var _ = FileLock.Hold(FallbackPath);
            var d = FileRead();
            d[name] = value;
            AtomicFile.WritePrivate(FallbackPath, JsonSerializer.Serialize(d));
            return true;
        }
        catch (Exception e) { Console.WriteLine($"secrets: couldn't write the file fallback ({e.GetType().Name})"); return false; }
    }

    private static void FileDelete(string name)
    {
        if (!File.Exists(FallbackPath)) return;
        try
        {
            using var _ = FileLock.Hold(FallbackPath);
            var d = FileRead();
            if (!d.Remove(name)) return;
            if (d.Count == 0) File.Delete(FallbackPath);
            else AtomicFile.WritePrivate(FallbackPath, JsonSerializer.Serialize(d));
        }
        catch (Exception e) { Console.WriteLine($"secrets: couldn't update the file fallback ({e.GetType().Name})"); }
    }
}
