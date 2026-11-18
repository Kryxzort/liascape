using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

// LIASCAPE_TEST_NO_NETWORK=1 (hermetic test stacks: the UI matrix): the backend reaches no real server. Every outbound
// connection a test could make by accident — the shared HttpClient (scrapers, steamcommunity.com, downloads), the
// /img /anim /still fetches, Steam's client protocol (the anonymous Browse session and the sign-in) — is refused here
// before it connects, with one log line naming it ("test-network: REFUSED …"), so a stub a probe forgot fails loudly
// (the matrix fails the run on that line) instead of quietly reaching Steam or a wallpaper site. Loopback stays allowed:
// the tests' own fake servers (LIASCAPE_STEAM_COMMUNITY / LIASCAPE_STEAM_API) listen there. A refusal throws
// HttpRequestException, what a real network failure throws, so no caller needs a branch for it.
// Guard: steam-selftest "no network"; scripts/test-ui-matrix.sh "FAIL real network".
public static class TestNetwork
{
    public static bool NoNetwork => Environment.GetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK") == "1";

    // Logs and throws when the guard is on (`what` = the call, `host` its server; loopback passes).
    public static void Check(string what, string? host = null)
    {
        if (!NoNetwork || (host != null && IsLoopback(host))) return;
        Console.WriteLine($"test-network: REFUSED {what}{(host != null ? $" ({host})" : "")} — LIASCAPE_TEST_NO_NETWORK=1: a test reaches no real server");
        throw new HttpRequestException($"refused by LIASCAPE_TEST_NO_NETWORK: {what}");
    }

    // The shared HttpClient's connect: plain sockets, after Check (null without the guard = the handler's default connect).
    public static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>>? ConnectCallback =>
        NoNetwork ? Connect : null;

    private static async ValueTask<Stream> Connect(SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        Check($"HTTP {ctx.InitialRequestMessage.Method} {ctx.InitialRequestMessage.RequestUri}", ctx.DnsEndPoint.Host);
        var s = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try { await s.ConnectAsync(ctx.DnsEndPoint, ct).ConfigureAwait(false); return new NetworkStream(s, ownsSocket: true); }
        catch { s.Dispose(); throw; }
    }

    private static bool IsLoopback(string host)
    {
        host = host.Trim('[', ']');
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || (IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip));
    }
}
