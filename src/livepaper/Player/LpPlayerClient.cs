using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace livepaper.Player;

// An lp-player API error object ({code, message, hint}) — every one carries a hint saying what to do next.
public sealed class LpPlayerException(string code, string message, string hint) : Exception(message)
{
    public string Code { get; } = code;
    public string Hint { get; } = hint;
    public override string ToString() => $"{Code}: {Message} (hint: {Hint})";
}

// The lp-player Command API client: JSON Lines over the unix socket (.claude/rules/player-core.md
// § Command API). One persistent request connection (serialized; reconnects after any error/timeout)
// + one subscribed event connection read on a background thread (reconnects with backoff when the
// player restarts).
public sealed class LpPlayerClient
{
    private static LpPlayerClient? _shared;
    private static readonly object _sharedLock = new();

    // The process-wide client on the default socket. The self-test swaps in a private one.
    public static LpPlayerClient Shared
    {
        get { lock (_sharedLock) return _shared ??= new LpPlayerClient(DefaultSocketPath()); }
        set { lock (_sharedLock) _shared = value; }
    }
    public static void ResetShared() { lock (_sharedLock) { _shared?.StopEvents(); _shared = null; } }

    [DllImport("libc")] private static extern uint getuid();

    // Mirrors src/player/src/paths.rs: $LP_PLAYER_SOCKET, else $XDG_RUNTIME_DIR/livepaper/lp-player.sock
    // (else /run/user/<uid>/livepaper/lp-player.sock).
    public static string DefaultSocketPath()
    {
        var env = Environment.GetEnvironmentVariable("LP_PLAYER_SOCKET");
        if (!string.IsNullOrEmpty(env)) return env;
        var rt = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        if (string.IsNullOrEmpty(rt)) { try { rt = $"/run/user/{getuid()}"; } catch { rt = Path.GetTempPath(); } }
        return Path.Combine(rt, "livepaper", "lp-player.sock");
    }

    public LpPlayerClient(string socketPath) { SocketPath = socketPath; }

    public string SocketPath { get; }
    // EnsureRunning may `setsid lp-player serve` when nothing answers. Off for the self-test.
    public bool AutoSpawn { get; set; } = true;
    // The COMPOSITOR's pid from `hello` (refreshed on every new connection) — auto-mute ownership (R69).
    // Under a supervisor this is the supervisor's CHILD, not the process EnsureRunning/the self-test
    // spawned — never signal this pid alone while SupervisorPid is set (the supervisor treats that as
    // a crash and restarts it).
    public int? PlayerPid { get; private set; }
    // The supervisor's own pid from `hello.supervisor_pid` — null when unsupervised (`--no-supervise`)
    // or before the first `hello`. Kill/stop fallbacks target THIS pid when it's set (.claude/rules/
    // player-core.md § Supervisor; player-adapter.md).
    public int? SupervisorPid { get; private set; }
    // Bumped whenever a connection reaches a different COMPOSITOR process (a restart, supervised or
    // not — corr ids restart at tr-1 either way) → waiters re-check.
    public int Generation { get; private set; }
    // Last start/request failure, for /player-engine (null = fine).
    public string? LastError { get; private set; }

    // ---- logging (rate-limited: an identical line at most once per 10 s) ------------------------
    private static readonly Dictionary<string, long> _logSeen = new();
    private static readonly string _logPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "livepaper", "lp-player-adapter.log");
    public static void Log(string msg)
    {
        long now = Environment.TickCount64;
        lock (_logSeen)
        {
            if (_logSeen.TryGetValue(msg, out var t) && now - t < 10_000) return;
            _logSeen[msg] = now;
            if (_logSeen.Count > 512) _logSeen.Clear();
        }
        var line = $"[lp-player {DateTime.Now:HH:mm:ss.fff}] {msg}";
        try { Console.Error.WriteLine(line); } catch { }
        try { Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!); File.AppendAllText(_logPath, line + "\n"); } catch { }
    }

    // ---- request connection --------------------------------------------------------------------
    private readonly object _cmdLock = new();
    private Socket? _sock;
    private StreamReader? _rd;
    private long _nextId;
    private bool _helloPending;

    private bool EnsureConnected()
    {
        if (_sock is { Connected: true } && _rd != null) return true;
        Disconnect();
        if (!File.Exists(SocketPath)) return false;
        try
        {
            var s = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            s.Connect(new UnixDomainSocketEndPoint(SocketPath));
            _sock = s;
            _rd = new StreamReader(new NetworkStream(s, ownsSocket: false), new UTF8Encoding(false));
            _helloPending = true;
            return true;
        }
        catch { Disconnect(); return false; }
    }

    private void Disconnect()
    {
        try { _rd?.Dispose(); } catch { }
        try { _sock?.Dispose(); } catch { }
        _rd = null; _sock = null;
    }

    // Synchronous queries (PlayerHelper may ask while holding its _lock) never wait longer than this.
    public const int QuickMs = 300;

    // Stall breaker: after a request times out, every request fails fast with `timeout` for StallMs —
    // a stopped/stalled player costs ONE timeout, not one per caller (a SIGSTOPped player must not make
    // /settings take seconds). The first request after the window tries for real.
    private const int StallMs = 3000;
    private long _stalledUntil;
    public bool IsStalled => Environment.TickCount64 < Interlocked.Read(ref _stalledUntil);

    // One request → its reply's `result`. Throws LpPlayerException: the player's error object, or
    // `io` (no player / connection lost) / `timeout` (no reply within timeoutMs, the request connection
    // busy for longer than that, or the stall breaker open), each with a hint.
    public JsonElement Call(string cmd, object? args, int timeoutMs = 2000)
    {
        // waiting for the connection counts against the same timeout (a query must not sit behind a
        // switch that waits out its own 2 s on a stalled player)
        if (!Monitor.TryEnter(_cmdLock, Math.Max(1, timeoutMs)))
            throw new LpPlayerException("timeout", $"`{cmd}`: the request connection stayed busy for {timeoutMs} ms",
                "another request is waiting on a slow player — `lp-player ctl probe '{\"name\":\"loop\"}'`");
        try
        {
            if (IsStalled)
                throw new LpPlayerException("timeout", $"`{cmd}`: lp-player is not responding (a request timed out < {StallMs / 1000} s ago)",
                    "is it stopped or stalled? `lp-player ctl probe '{\"name\":\"loop\"}'` — requests resume on their own once it answers");
            if (!EnsureConnected())
                throw new LpPlayerException("io", $"no lp-player answering on {SocketPath}",
                    "select Player engine = lp-player (livepaper starts it) or run `lp-player serve`");
            if (_helloPending && cmd != "hello")
            {
                _helloPending = false;
                try { Call("hello", null, timeoutMs); } catch (LpPlayerException) { }
                if (!EnsureConnected()) throw new LpPlayerException("io", "lp-player closed the connection", "check `lp-player ctl logs '{\"min_level\":\"warn\"}'`");
            }
            long id = ++_nextId;
            var req = new Dictionary<string, object?> { ["id"] = id, ["cmd"] = cmd };
            if (args != null) req["args"] = args;
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(req) + "\n");
            try
            {
                _sock!.SendTimeout = Math.Max(1, timeoutMs);
                try { _sock.Send(bytes); }
                catch (SocketException) when (!_helloPending)
                {
                    // the player closed this (reused) connection since the last call — the request never
                    // left, so resending it on a fresh connection is safe (a restart: hello first)
                    Disconnect();
                    if (!EnsureConnected()) throw;
                    _helloPending = false;
                    try { Call("hello", null, timeoutMs); } catch (LpPlayerException) { }
                    if (!EnsureConnected()) throw;
                    _sock!.SendTimeout = Math.Max(1, timeoutMs);
                    _sock.Send(bytes);
                }
                long deadline = Environment.TickCount64 + timeoutMs;
                while (true)
                {
                    int left = (int)(deadline - Environment.TickCount64);
                    if (left <= 0) throw new TimeoutException();
                    _sock.ReceiveTimeout = left;
                    var line = _rd!.ReadLine() ?? throw new IOException("lp-player closed the connection");
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    // a stale reply (an earlier timed-out request) or an event → not ours
                    if (!root.TryGetProperty("id", out var rid) || rid.ValueKind != JsonValueKind.Number || rid.GetInt64() != id) continue;
                    if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
                    {
                        var result = root.TryGetProperty("result", out var r) ? r.Clone() : default;
                        if (cmd == "hello" && result.ValueKind == JsonValueKind.Object && result.TryGetProperty("pid", out var pid))
                        {
                            int p = pid.GetInt32();
                            int? sup = result.TryGetProperty("supervisor_pid", out var supEl) && supEl.ValueKind == JsonValueKind.Number
                                ? supEl.GetInt32() : (int?)null;
                            if (PlayerPid != p)
                            {
                                bool restarted = PlayerPid != null;
                                // the supervisor stayed the same and only its child changed = a supervised
                                // restart (the crash was restarted with `--restore`), not a fresh process
                                // from EnsureRunning/an engine switch (which replaces the supervisor too).
                                bool supervised = restarted && sup != null && sup == SupervisorPid;
                                int? prevPid = PlayerPid;
                                PlayerPid = p; Generation++;
                                // corr ids are per player process (tr-1… again) → outcomes recorded for the
                                // old one must not answer waits on the new one
                                if (restarted)
                                {
                                    if (supervised)
                                    {
                                        string info = result.TryGetProperty("restart", out var ri) && ri.ValueKind == JsonValueKind.Object
                                            ? ri.GetRawText() : "null";
                                        Log($"lp-player supervised restart: compositor {prevPid} -> {p} (supervisor {sup}) restart={info}");
                                    }
                                    try { Restarted?.Invoke(); } catch (Exception ex) { Log($"restart handler threw: {ex.Message}"); }
                                }
                            }
                            SupervisorPid = sup;
                        }
                        Interlocked.Exchange(ref _stalledUntil, 0);
                        return result;
                    }
                    Interlocked.Exchange(ref _stalledUntil, 0); // an error reply is still an answer
                    var e = root.GetProperty("error");
                    throw new LpPlayerException(Prop(e, "code") ?? "error", Prop(e, "message") ?? "", Prop(e, "hint") ?? "");
                }
            }
            catch (LpPlayerException) { throw; }
            catch (Exception ex)
            {
                Disconnect();
                if (ex is TimeoutException || ex.InnerException is SocketException { SocketErrorCode: SocketError.TimedOut } || ex is IOException { InnerException: SocketException { SocketErrorCode: SocketError.TimedOut } })
                {
                    Interlocked.Exchange(ref _stalledUntil, Environment.TickCount64 + StallMs);
                    throw new LpPlayerException("timeout", $"no reply to `{cmd}` within {timeoutMs} ms",
                        "pass a longer timeout; is the loop stalled? `lp-player ctl probe '{\"name\":\"loop\"}'`");
                }
                throw new LpPlayerException("io", $"`{cmd}`: {ex.Message}", "the player went away — `lp-player ctl hello` to check, livepaper restarts it on the next switch");
            }
        }
        finally { Monitor.Exit(_cmdLock); }
    }

    // Call that logs the error (with its hint) instead of throwing → null.
    public JsonElement? TryCall(string cmd, object? args, int timeoutMs = 2000)
    {
        try { return Call(cmd, args, timeoutMs); }
        catch (LpPlayerException e) { Log($"`{cmd}` failed — {e}"); return null; }
    }

    public bool SocketExists => File.Exists(SocketPath);

    // Is a player answering right now? (never spawns)
    public bool Reachable()
    {
        if (!File.Exists(SocketPath)) return false;
        try { Call("hello", null, 1000); return true; } catch (LpPlayerException) { return false; }
    }

    [DllImport("libc", SetLastError = true)] private static extern int kill(int pid, int sig);

    // Is `pid` (still) an lp-player process? (guards against a recycled pid)
    private static bool IsPlayerProcess(int pid)
    {
        try { return File.ReadAllText($"/proc/{pid}/cmdline").Contains("lp-player"); } catch { return false; }
    }

    // Make sure the player is GONE — supervisor AND compositor (engine switch away from lp-player):
    // `quit` over the socket first (the compositor exits 0, the supervisor classifies that as a clean
    // exit and exits too, no restart). If that didn't work, escalate against the SUPERVISOR (never the
    // compositor alone — a supervisor that's still alive treats a dead/signalled child as a crash and
    // RESTARTS it with `--restore`, which is exactly what an engine switch away from lp-player must not
    // leave behind): SIGCONT+SIGTERM it (it forwards the TERM to its child and exits cleanly), then
    // SIGKILL it (its child dies via PR_SET_PDEATHSIG) — and if the compositor pid is somehow still
    // alive a short moment later (PDEATHSIG race / unsupervised), SIGKILL it directly too. Unsupervised
    // (`--no-supervise`, SupervisorPid null): the compositor pid IS the only target throughout, same as
    // before.
    public void QuitOrKill(int waitMs = 1500)
    {
        int? compositor = PlayerPid;
        int? supervisor = SupervisorPid;
        int? target = supervisor ?? compositor; // the supervisor when one exists, else the compositor itself
        if (SocketExists) { try { Call("quit", null, QuickMs); } catch (LpPlayerException) { } }
        StopEvents();
        if (target is not int t) return;
        bool Gone(int pid, int ms) { var sw = Stopwatch.StartNew(); while (sw.ElapsedMilliseconds < ms) { if (!IsPlayerProcess(pid)) return true; Thread.Sleep(25); } return !IsPlayerProcess(pid); }
        void FinishCompositor() { if (compositor is int c && c != t && IsPlayerProcess(c)) { kill(c, 9); Gone(c, 500); } }
        if (Gone(t, waitMs)) { FinishCompositor(); return; }
        Log($"lp-player ({(supervisor != null ? "supervisor " : "")}pid {t}) did not quit — SIGTERM");
        kill(t, 18); kill(t, 15); // SIGCONT, SIGTERM
        if (Gone(t, waitMs)) { FinishCompositor(); return; }
        Log($"lp-player ({(supervisor != null ? "supervisor " : "")}pid {t}) ignored SIGTERM — SIGKILL");
        kill(t, 9);
        Gone(t, waitMs);
        FinishCompositor();
    }

    public bool WaitForSocket(int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        do
        {
            if (Reachable()) return true;
            Thread.Sleep(50);
        } while (sw.ElapsedMilliseconds < timeoutMs);
        return false;
    }

    // ---- lifecycle ---------------------------------------------------------------------------------
    private readonly object _spawnLock = new();

    // Connect, or `setsid lp-player serve` (no --headless: real outputs, inheriting the session env —
    // WAYLAND_DISPLAY etc.) and wait ≤ 3 s for its socket. "Already running" counts as success: a
    // second `serve` exits 1 on the instance lock and we connect to the winner.
    public bool EnsureRunning()
    {
        if (Reachable()) { LastError = null; return true; }
        if (!AutoSpawn) return false;
        lock (_spawnLock)
        {
            if (Reachable()) { LastError = null; return true; }
            // a start that just failed isn't retried for 10 s — a broken player must not be respawned
            // on every switch attempt (the rotation's fallback retries once a second)
            if (_lastSpawnFail != 0 && Environment.TickCount64 - _lastSpawnFail < 10_000) return false;
            // alive but not answering (stopped/stalled): a second `serve` would only lose the instance lock
            if (IsStalled && SocketExists) { LastError = "lp-player is not responding"; return false; }
            var bin = PlayerEngine.ResolveBinary();
            if (bin == null) { Fail(PlayerEngine.UnavailableReason); return false; }
            Process? p;
            try
            {
                // stdio → a log file, never a pipe: the player outlives this backend (a dead pipe
                // would turn its next stderr write into an error).
                var outLog = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "livepaper", "lp-player-serve.log");
                Directory.CreateDirectory(Path.GetDirectoryName(outLog)!);
                var psi = new ProcessStartInfo("setsid") { UseShellExecute = false };
                psi.ArgumentList.Add("sh");
                psi.ArgumentList.Add("-c");
                psi.ArgumentList.Add(SocketPath == DefaultSocketPath()
                    ? "exec \"$0\" serve </dev/null >\"$1\" 2>&1"
                    : "exec \"$0\" serve --socket \"$2\" </dev/null >\"$1\" 2>&1");
                psi.ArgumentList.Add(bin);
                psi.ArgumentList.Add(outLog);
                psi.ArgumentList.Add(SocketPath);
                p = Process.Start(psi);
                Log($"started `{bin} serve` (pid {p?.Id}) → {SocketPath}");
            }
            catch (Exception e) { Fail($"could not start {bin}: {e.Message}"); return false; }
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < 3000)
            {
                if (Reachable()) { LastError = null; _lastSpawnFail = 0; return true; }
                if (p is { HasExited: true } && p.ExitCode != 1) break; // 1 = "already running" → keep connecting
                Thread.Sleep(50);
            }
            if (Reachable()) { LastError = null; _lastSpawnFail = 0; return true; }
            string why = p is { HasExited: true }
                ? $"`lp-player serve` exited {p.ExitCode}" + (p.ExitCode == 2 ? " (this build has no Wayland output backend yet, or bad arguments)" : "")
                : "`lp-player serve` did not open its socket within 3 s";
            Fail($"{why} — see ~/.cache/livepaper/lp-player-serve.log, or run `{bin} serve` in a terminal");
            return false;
        }
    }

    private long _lastSpawnFail;
    private void Fail(string why) { LastError = why; _lastSpawnFail = Environment.TickCount64; Log(why); }

    // ---- events --------------------------------------------------------------------------------
    public static readonly string[] Topics = ["transition.", "source.", "supervisor."]; // supervisor.* arrives with Task 16
    public event Action<string, JsonElement>? Event;
    // a connection reached a DIFFERENT player process than before (it restarted)
    public event Action? Restarted;
    private Thread? _evThread;
    private volatile bool _evStop;
    private volatile Socket? _evSock;
    private readonly ManualResetEventSlim _subscribed = new(false);

    private readonly object _evLock = new();

    public void StartEvents()
    {
        lock (_evLock)
        {
            if (_evThread is { IsAlive: true }) return;
            _evStop = false;
            _evThread = new Thread(EventLoop) { IsBackground = true, Name = "lp-player-events" };
            _evThread.Start();
        }
    }

    // true once the event connection's `subscribe` was acknowledged (events from now on are seen)
    public bool WaitSubscribed(int timeoutMs) => _subscribed.Wait(timeoutMs);

    public void StopEvents()
    {
        _evStop = true;
        try { _evSock?.Shutdown(SocketShutdown.Both); } catch { }
    }

    private void EventLoop()
    {
        int backoff = 250;
        while (!_evStop)
        {
            try
            {
                if (File.Exists(SocketPath))
                {
                    using var s = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                    s.Connect(new UnixDomainSocketEndPoint(SocketPath));
                    _evSock = s;
                    using var ns = new NetworkStream(s, ownsSocket: false);
                    using var rd = new StreamReader(ns, new UTF8Encoding(false));
                    var sub = JsonSerializer.Serialize(new { id = "sub", cmd = "subscribe", args = new { topics = Topics } });
                    s.Send(Encoding.UTF8.GetBytes(sub + "\n"));
                    string? line;
                    while (!_evStop && (line = rd.ReadLine()) != null)
                    {
                        JsonElement root;
                        try { using var doc = JsonDocument.Parse(line); root = doc.RootElement.Clone(); }
                        catch { continue; }
                        if (root.TryGetProperty("event", out var ev) && ev.ValueKind == JsonValueKind.String)
                        {
                            try { Event?.Invoke(ev.GetString()!, root); } catch (Exception e) { Log($"event handler threw: {e.Message}"); }
                        }
                        else if (root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() == "sub")
                        {
                            backoff = 250;
                            _subscribed.Set();
                            // pid / Generation after a restart — off this thread (it may wait behind a long request)
                            _ = System.Threading.Tasks.Task.Run(() => { try { Call("hello", null, 1000); } catch (LpPlayerException) { } });
                        }
                    }
                }
            }
            catch { }
            _subscribed.Reset();
            _evSock = null;
            if (_evStop) break;
            Thread.Sleep(backoff);
            backoff = Math.Min(backoff * 2, 5000);
        }
    }

    private static string? Prop(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
