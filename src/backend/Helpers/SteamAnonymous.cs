using System;
using System.Threading;
using System.Threading.Tasks;
using SteamKit2;
using SteamKit2.Internal;

namespace Liascape.Helpers;

// ONE shared anonymous session on Steam's client protocol (the CM servers the Steam client — and so Wallpaper Engine — talks
// to): no account, no Web API key, no steamcommunity.com. Used by the trailer lookup and the Workshop Browse source
// (SteamWorkshopDetails). Shared rather than one session per call because a session costs more than the request it carries
// (measured 2026-11-11: connect 0.83–1.85 s — the first one also fetches the server list —, anonymous logon 0.38–0.8 s,
// one QueryFiles page of 100 0.5–1.3 s): per call a Browse page took 2.3–4 s, on the kept session ~1 s.
//   - Lazily connected on first use; a dropped connection (Steam restarts its CMs, the network goes away) is simply
//     reconnected by the next request.
//   - Requests are serialized (one at a time) — politeness, and the trailer job's batches interleave with Browse pages
//     instead of queueing behind the whole job.
//   - Disconnected after IdleMinutes without a request.
//   - Every call has a deadline: UseAsync returns null (never throws) when the servers can't be reached, refuse the
//     logon, or don't answer in time — the caller then falls back to page reading. After a failed connect it doesn't try
//     again for RetryAfterFailSeconds (each caller would otherwise wait its whole deadline before falling back).
public static class SteamAnonymous
{
    private const int IdleMinutes = 3, RetryAfterFailSeconds = 60;

    private sealed class Conn
    {
        public readonly SteamClient Client = new();
        public readonly CallbackManager Manager;
        public readonly SteamUser User;
        public readonly PublishedFile Pub;
        public readonly TaskCompletionSource<bool> Ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public volatile bool Dead;

        public Conn()
        {
            Manager = new CallbackManager(Client);
            User = Client.GetHandler<SteamUser>()!;
            Pub = Client.GetHandler<SteamUnifiedMessages>()!.CreateService<PublishedFile>();
            Manager.Subscribe<SteamClient.ConnectedCallback>(_ => User.LogOnAnonymous());
            Manager.Subscribe<SteamClient.DisconnectedCallback>(_ => { Dead = true; Ready.TrySetResult(false); });
            Manager.Subscribe<SteamUser.LoggedOnCallback>(cb => Ready.TrySetResult(cb.Result == EResult.OK));
            Manager.Subscribe<SteamUser.LoggedOffCallback>(_ => Dead = true);
            // the callback pump: lives as long as the connection
            new Thread(() => { while (!Dead) Manager.RunWaitCallbacks(TimeSpan.FromMilliseconds(250)); })
            { IsBackground = true, Name = "lia-steam-cm" }.Start();
            Client.Connect();
        }

        public void Close()
        {
            if (Dead) return;
            try { User.LogOff(); Client.Disconnect(); } catch { }
            Dead = true;
        }
    }

    private static readonly SemaphoreSlim _one = new(1, 1);
    private static Conn? _conn;
    private static long _lastUse, _failedAt = long.MinValue / 2; // Environment.TickCount64
    private static readonly Timer _idle = new(_ => CloseIfIdle(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));

    private static void CloseIfIdle()
    {
        if (_conn is not { Dead: false } c || Environment.TickCount64 - Interlocked.Read(ref _lastUse) < IdleMinutes * 60_000L) return;
        if (!_one.Wait(0)) return;
        try { if (ReferenceEquals(_conn, c)) { c.Close(); _conn = null; Console.WriteLine("steam-cm: idle — disconnected"); } }
        finally { _one.Release(); }
    }

    // Runs `work` on the logged-on session (one request at a time). null = Steam's servers unreachable / refused / no
    // answer within `timeout` (waiting for an earlier request included) — or `work` itself returned null.
    public static async Task<T?> UseAsync<T>(Func<PublishedFile, Task<T?>> work, TimeSpan timeout, CancellationToken ct = default) where T : class
    {
        if (Environment.TickCount64 - Interlocked.Read(ref _failedAt) < RetryAfterFailSeconds * 1000L) return null;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { await _one.WaitAsync(cts.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) { return null; }
        try
        {
            Interlocked.Exchange(ref _lastUse, Environment.TickCount64);
            var c = _conn;
            if (c == null || c.Dead)
            {
                c = _conn = new Conn();
                var t0 = Environment.TickCount64;
                bool ok;
                try { ok = await c.Ready.Task.WaitAsync(cts.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { ok = false; }
                if (!ok && ct.IsCancellationRequested) { c.Close(); _conn = null; return null; } // the caller gave up, not Steam
                if (!ok)
                {
                    c.Close(); _conn = null;
                    Interlocked.Exchange(ref _failedAt, Environment.TickCount64);
                    Console.WriteLine($"steam-cm: Steam's servers unreachable / refused the anonymous logon — not retried for {RetryAfterFailSeconds} s");
                    return null;
                }
                Console.WriteLine($"steam-cm: connected + logged on anonymously in {Environment.TickCount64 - t0} ms");
            }
            try { return await work(c.Pub).WaitAsync(cts.Token).ConfigureAwait(false); }
            // the CALLER gave up (a stale Browse prefetch): the connection is fine — its answer is just dropped
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return null; }
            catch (Exception e)
            {
                // a request that failed or hung: the connection may be half-dead — start a fresh one next time
                Console.WriteLine($"steam-cm: request failed ({(e is OperationCanceledException ? "no answer in time" : e.GetType().Name)}) — reconnecting next time");
                c.Close(); _conn = null;
                return null;
            }
            finally { Interlocked.Exchange(ref _lastUse, Environment.TickCount64); }
        }
        finally { _one.Release(); }
    }
}
