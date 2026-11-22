using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

// The one `steam-ugc session` child of "Use the Steam app" (Helpers/SteamClientUgc.cs) and how long it stays connected.
// While it is, Steam shows the user "Playing Wallpaper Engine", so it is held only while that buys something: from the first
// operation (nothing connects before one), for as long as the UI says the Workshop shows on Browse (`POST /steam/app-presence`,
// repeated as a heartbeat; none for `HeartbeatTimeout` = left), then `Linger` more; past that the child releases Steam and
// exits. Coming back inside the linger keeps it. Why not per operation or for the app's lifetime: docs/decisions.md § "Hold
// the Steam app connection while the Workshop shows on Browse".
// - Every start, use and release of the child happens under SteamClientUgc.Turn, so there is never a second one, not even
//   one still releasing while the next starts; the timer's release skips when an operation holds the turn (its end re-checks).
// - A dead child is never connected: its exit clears it at once, and the next operation starts a fresh one.
// - The backend's stop releases it at once (ServerHost's ApplicationStopping); a backend that dies closes the child's stdin,
//   which the child takes as release.
// Guard: scripts/test-steam-app-hold.sh
public static class SteamClientHold
{
    static TimeSpan Ms(string env, int dflt) =>
        TimeSpan.FromMilliseconds(int.TryParse(Environment.GetEnvironmentVariable(env), out var v) && v >= 0 ? v : dflt);
    // the tests shorten both (LIASCAPE_STEAM_APP_LINGER_MS 0 = released after every operation)
    public static readonly TimeSpan Linger = Ms("LIASCAPE_STEAM_APP_LINGER_MS", 60_000);
    public static readonly TimeSpan HeartbeatTimeout = Ms("LIASCAPE_STEAM_APP_HEARTBEAT_MS", 90_000);

    static readonly object Gate = new();
    static Child? child;
    static bool busy, showing, stopping;
    static long lastBeat, leftAt, opEnd;
    static readonly Timer Tick = new(_ => OnTick(), null, Timeout.Infinite, Timeout.Infinite);
    static long Now => Environment.TickCount64;

    /// Connected to Steam right now (a live child that said it was ready).
    public static bool Connected { get { lock (Gate) return child is { Alive: true }; } }

    /// The UI's word: the Workshop shows on Browse in a visible window (true, repeated as the heartbeat) or not.
    public static void SetShowing(bool on)
    {
        lock (Gate)
        {
            if (on) { showing = true; lastBeat = Now; }
            else if (showing) { showing = false; leftAt = Math.Min(Now, lastBeat + (long)HeartbeatTimeout.TotalMilliseconds); }
        }
        Tick.Change(0, Timeout.Infinite);
    }

    /// The child for one operation, started if there is none (the caller holds SteamClientUgc.Turn). Reused = it served an
    /// earlier operation (a Steam restarted since may have left it talking to nothing). Null + why when it can't connect.
    internal static async Task<(Child? Child, bool Reused, string? Why)> AcquireAsync(AppSettings s, CancellationToken ct)
    {
        lock (Gate)
        {
            if (stopping) return (null, false, "Liascape is closing");
            if (child is { Alive: true }) { busy = true; return (child, true, null); }
            child?.Dispose(); child = null;
        }
        var (c, why) = await Child.StartAsync(s, ct);
        if (c == null) return (null, false, why);
        lock (Gate)
        {
            if (stopping) { c.Release(); return (null, false, "Liascape is closing"); }
            child = c; busy = true;
        }
        c.Exited += () => { lock (Gate) if (child == c) { child = null; Console.WriteLine("steam-app: the helper exited"); } };
        Console.WriteLine("steam-app: connected to Steam (shown as playing Wallpaper Engine)");
        return (c, false, null);
    }

    /// An operation ended (the caller still holds the turn): the linger counts from here unless the Workshop shows; with
    /// it already over (or 0), the child goes now, before the next operation's turn.
    internal static void Done(Child c, bool drop = false)
    {
        lock (Gate) { busy = false; opEnd = Now; if (drop && child == c) child = null; }
        if (drop) c.Release();
        Evaluate();
    }

    static void OnTick()
    {
        if (!SteamClientUgc.Turn.Wait(0)) return; // an operation runs or waits: its Done re-checks
        try { Evaluate(); } finally { SteamClientUgc.Turn.Release(); }
    }

    // with the turn held: release the child once the user has been away for the linger, else wake when that comes
    static void Evaluate()
    {
        Child? go = null;
        lock (Gate)
        {
            if (child == null || busy) return;
            if (!child.Alive) { child.Dispose(); child = null; return; }
            long now = Now, hb = (long)HeartbeatTimeout.TotalMilliseconds;
            if (showing && now - lastBeat < hb) { Tick.Change(lastBeat + hb - now, Timeout.Infinite); return; }
            long left = showing ? lastBeat + hb : leftAt;
            long due = Math.Max(left, opEnd) + (long)Linger.TotalMilliseconds;
            if (now < due) { Tick.Change(due - now, Timeout.Infinite); return; }
            go = child; child = null;
        }
        Console.WriteLine("steam-app: away from the Workshop past the linger; releasing Steam");
        go.Release();
    }

    /// The backend stops: release Steam now, whatever runs (an operation on it sees the child end).
    public static void Shutdown()
    {
        Child? c;
        lock (Gate) { stopping = true; c = child; child = null; }
        Tick.Change(Timeout.Infinite, Timeout.Infinite);
        c?.Release(1000);
    }

    /// The parent's handle on one `steam-ugc session` child: commands on its stdin, JSON lines from its stdout.
    internal sealed class Child : IDisposable
    {
        readonly Process proc;
        readonly object writeGate = new();
        bool released;
        public event Action? Exited;
        Child(Process p) { proc = p; p.Exited += (_, _) => Exited?.Invoke(); }
        public bool Alive { get { try { return !proc.HasExited; } catch { return false; } } }

        public static async Task<(Child?, string?)> StartAsync(AppSettings s, CancellationToken ct)
        {
            var libs = SteamClientUgc.Candidates(s);
            if (libs.Count == 0) return (null, "the Steam client's steamclient.so wasn't found — is Steam installed?");
            var self = PlayerHelper.GetSelfInvocationArgs();
            if (self.Count == 0) return (null, "can't start the helper");
            var psi = new ProcessStartInfo(self[0]) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in self.Skip(1)) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("steam-ugc"); psi.ArgumentList.Add("session");
            foreach (var l in libs) psi.ArgumentList.Add(l);
            psi.Environment["SteamAppId"] = SteamClientUgc.WallpaperEngineAppId.ToString();
            psi.Environment["SteamGameId"] = SteamClientUgc.WallpaperEngineAppId.ToString();
            psi.Environment.Remove("LD_LIBRARY_PATH"); // the backend's (a dev shell's) must not shadow Steam's client library's
            Process? p;
            try { p = Process.Start(psi); } catch { p = null; }
            if (p == null) return (null, "can't start the helper");
            p.EnableRaisingEvents = true;
            _ = p.StandardError.ReadToEndAsync(); // drained; Valve's library chats on stderr
            var c = new Child(p);
            string? why = "Steam didn't answer";
            try
            {
                using var reg = ct.Register(() => c.Kill());
                while (await c.ReadAsync() is { } e)
                {
                    var ev = e.GetProperty("event").GetString();
                    if (ev == "ready") return (c, null);
                    if (ev == "error") why = e.GetProperty("message").GetString() ?? why;
                }
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
            c.Release();
            ct.ThrowIfCancellationRequested();
            return (null, why);
        }

        /// The next JSON line, or null once the child's stdout ends (it exited or died).
        public async Task<JsonElement?> ReadAsync()
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync()) != null)
            {
                try { return JsonDocument.Parse(line).RootElement.Clone(); } catch { }
            }
            return null;
        }

        public bool Send(object cmd)
        {
            lock (writeGate)
            {
                if (released) return false;
                try { proc.StandardInput.WriteLine(JsonSerializer.Serialize(cmd)); proc.StandardInput.Flush(); return true; }
                catch { return false; }
            }
        }

        /// Closing stdin = release Steam and exit; a wedged library is killed after `waitMs`.
        public void Release(int waitMs = 3000)
        {
            lock (writeGate) { if (!released) { released = true; try { proc.StandardInput.Close(); } catch { } } }
            try { if (!proc.WaitForExit(waitMs)) Kill(); } catch { }
            Dispose();
        }

        public void Kill() { try { proc.Kill(); } catch { } }
        public void Dispose() { try { proc.Dispose(); } catch { } }
    }
}
