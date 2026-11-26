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
// operation (nothing connects before one), for as long as the Liascape window is open (its page's heartbeat, `POST
// /steam/app-presence` every `HeartbeatEvery`), until `Tail` after the later of the last beat and the last operation; past
// that the child releases Steam and exits. The tail only covers a reload or a renderer recovery and a late beat: a closed or
// crashed window lets go within it. Operations keep it too: a favourites watch's reads (Helpers/SteamFavoriteWatch.cs, every
// few seconds) hold it to the watch's own end, the window open or not. Why not per operation, per Browse visit or for the
// backend's lifetime: docs/decisions.md § "Hold the Steam app connection while the Liascape window is open".
// - Every start, use and release of the child happens under SteamClientUgc.Turn, so there is never a second one, not even
//   one still releasing while the next starts; the timer's release skips when an operation holds the turn (its end re-checks).
// - A dead child is never connected: its exit clears it at once, and the next operation starts a fresh one. A held child
//   answers a ping before it is reused; one that doesn't (a hung library) is replaced first, never after Steam's answer.
// - The backend's stop releases it at once (ServerHost's ApplicationStopping); a backend that dies closes the child's stdin,
//   which the child takes as release.
// Guard: scripts/test-steam-app-hold.sh
public static class SteamClientHold
{
    static TimeSpan Ms(string env, int dflt) =>
        TimeSpan.FromMilliseconds(int.TryParse(Environment.GetEnvironmentVariable(env), out var v) && v >= 0 ? v : dflt);
    // how often the open window's page beats (it reads this from the answer to each beat, so the two can't drift apart); the
    // tests shorten it (LIASCAPE_STEAM_APP_BEAT_MS; 0 = released after every operation; steam-selftest sets it)
    public static TimeSpan HeartbeatEvery { get; internal set; } = Ms("LIASCAPE_STEAM_APP_BEAT_MS", 5_000);
    // beats missed before the window counts as closed: a reload or a renderer recovery beats again within about a second, a
    // busy page's timer can slip by one
    // Guard: scripts/test-steam-app-hold.sh c., d., e.
    public const int TailBeats = 3;
    public static TimeSpan Tail => HeartbeatEvery * TailBeats;
    // a reused child must answer a ping this fast, else it is replaced before the operation (a hung library, a Steam gone)
    const int PingMs = 3000;

    static readonly object Gate = new();
    static Child? child;
    static bool busy, stopping;
    static long lastBeat, opEnd;
    static readonly Timer Tick = new(_ => OnTick(), null, Timeout.Infinite, Timeout.Infinite);
    static long Now => Environment.TickCount64;

    /// Connected to Steam right now (a live child that said it was ready).
    public static bool Connected { get { lock (Gate) return child is { Alive: true }; } }

    /// The open window's heartbeat: the held child stays until `Tail` after the last one. Never connects by itself.
    public static void Beat()
    {
        lock (Gate) lastBeat = Now;
        Tick.Change(0, Timeout.Infinite);
    }

    /// The child for one operation (the caller holds SteamClientUgc.Turn): the held one when it answers a ping, else a fresh
    /// one. Null + why when Steam can't be reached. Guard: scripts/test-steam-app-hold.sh h.
    internal static async Task<(Child? Child, string? Why)> AcquireAsync(AppSettings s, CancellationToken ct)
    {
        Child? held;
        lock (Gate)
        {
            if (stopping) return (null, "Liascape is closing");
            held = child is { Alive: true } ? child : null;
            if (held == null) { child?.Dispose(); child = null; } else busy = true;
        }
        if (held != null)
        {
            if (await held.PingAsync(PingMs)) return (held, null);
            Console.WriteLine("steam-app: the held helper didn't answer; starting a fresh one");
            lock (Gate) { busy = false; if (child == held) child = null; }
            held.Release(500);
        }
        var (c, why) = await Child.StartAsync(s, ct);
        if (c == null) return (null, why);
        lock (Gate)
        {
            if (stopping) { c.Release(); return (null, "Liascape is closing"); }
            child = c; busy = true;
        }
        c.Exited += () => { lock (Gate) if (child == c) { child = null; Console.WriteLine("steam-app: the helper exited"); } };
        Console.WriteLine("steam-app: connected to Steam (shown as playing Wallpaper Engine)");
        return (c, null);
    }

    /// Does the held child answer right now? Only when the turn is free (an operation on it would read the reply); null =
    /// no held child, or the turn is busy. A child that doesn't answer is dropped.
    internal static async Task<bool?> PingHeldAsync()
    {
        if (!SteamClientUgc.Turn.Wait(0)) return null;
        try
        {
            Child? c;
            lock (Gate) { c = child is { Alive: true } ? child : null; if (c != null) busy = true; }
            if (c == null) return null;
            bool ok = await c.PingAsync(PingMs);
            Done(c, drop: !ok);
            return ok;
        }
        finally { SteamClientUgc.Turn.Release(); }
    }

    /// steam-selftest: an idle held child that just finished an operation (any process that exits when its stdin closes).
    internal static void AdoptForTest(Process p)
    {
        var c = new Child(p);
        lock (Gate) { child = c; busy = false; opEnd = Now; }
    }

    /// An operation ended (the caller still holds the turn): the tail counts from here unless a later beat came; with it
    /// already over (or 0), the child goes now, before the next operation's turn.
    internal static void Done(Child c, bool drop = false)
    {
        lock (Gate) { busy = false; opEnd = Now; if (drop && child == c) child = null; }
        if (drop) c.Release();
        Evaluate();
    }

    static void OnTick()
    {
        // the turn is busy: an operation's Done re-checks, but not every taker of the turn ends with one (an unsubscribe
        // whose claim came back empty), so look again shortly. Guard: steam-selftest "steam-app hold: a tick while the turn is held"
        if (!SteamClientUgc.Turn.Wait(0)) { Tick.Change(250, Timeout.Infinite); return; }
        try { Evaluate(); } finally { SteamClientUgc.Turn.Release(); }
    }

    // with the turn held: release the child once the tail after the last beat and the last operation is over, else wake then
    static void Evaluate()
    {
        Child? go = null;
        lock (Gate)
        {
            if (child == null || busy) return;
            if (!child.Alive) { child.Dispose(); child = null; return; }
            long now = Now, due = Math.Max(lastBeat, opEnd) + (long)Tail.TotalMilliseconds;
            if (now < due) { Tick.Change(due - now, Timeout.Infinite); return; }
            go = child; child = null;
        }
        Console.WriteLine("steam-app: no window and no operation for the tail; releasing Steam");
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
        internal Child(Process p) { proc = p; p.EnableRaisingEvents = true; p.Exited += (_, _) => Exited?.Invoke(); }
        public bool Alive { get { try { return !proc.HasExited; } catch { return false; } } }

        public static async Task<(Child?, string?)> StartAsync(AppSettings s, CancellationToken ct)
        {
            var libs = SteamClientUgc.Candidates(s);
            if (libs.Count == 0) return (null, "the Steam client's steamclient.so wasn't found — is Steam installed?");
            var psi = SteamClientUgc.ChildStart("session", libs);
            if (psi == null) return (null, "can't start the helper");
            Process? p;
            try { p = Process.Start(psi); } catch { p = null; }
            if (p == null) return (null, "can't start the helper");
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
        public async Task<JsonElement?> ReadAsync(CancellationToken ct = default)
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync(ct)) != null)
            {
                try { return JsonDocument.Parse(line).RootElement.Clone(); } catch { }
            }
            return null;
        }

        /// {"op": "ping"}: the child asks Steam's library once and answers `done`. False (and killed) = no answer in time.
        public async Task<bool> PingAsync(int ms)
        {
            if (!Send(new { op = "ping" })) return false;
            using var to = new CancellationTokenSource(ms);
            try
            {
                while (await ReadAsync(to.Token) is { } e)
                    if (e.GetProperty("event").GetString() == "done") return true;
            }
            catch (Exception) { }
            Kill();
            return false;
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
