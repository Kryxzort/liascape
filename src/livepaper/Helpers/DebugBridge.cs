using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Threading;

namespace livepaper.Helpers;

/// Debug-only control channel. Enabled ONLY when env LIVEPAPER_DEBUG_IPC=1 (no-op otherwise, so
/// it is harmless in normal use). Lets an external tool drive the running app — switch source,
/// scroll, force load-more, and read live metrics — over a Unix domain socket at
/// /tmp/livepaper-debug.sock. Used to profile scroll lag/memory growth.
public static class DebugBridge
{
    public const string SocketPath = "/tmp/livepaper-debug.sock";

    // command text -> response text. Invoked on the UI thread.
    public static Func<string, string>? Handler;

    public static bool Enabled =>
        Environment.GetEnvironmentVariable("LIVEPAPER_DEBUG_IPC") == "1";

    public static void Start()
    {
        if (!Enabled) return;
        try
        {
            try { File.Delete(SocketPath); } catch { }

            var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            listener.Bind(new UnixDomainSocketEndPoint(SocketPath));
            listener.Listen(8);
            Console.Error.WriteLine($"[DBG] bridge listening at {SocketPath}");

            _ = Task.Run(async () =>
            {
                while (true)
                {
                    Socket conn;
                    try { conn = await listener.AcceptAsync(); }
                    catch { break; }
                    _ = Task.Run(() => Serve(conn));
                }
            });
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[DBG] bridge failed to start: " + e);
        }
    }

    private static void Serve(Socket conn)
    {
        using (conn)
        {
            try
            {
                var buf = new byte[8192];
                int n = conn.Receive(buf);
                if (n <= 0) return;
                var cmd = Encoding.UTF8.GetString(buf, 0, n).Trim();

                string resp = "";
                using var done = new ManualResetEventSlim();
                Dispatcher.UIThread.Post(() =>
                {
                    try { resp = Handler?.Invoke(cmd) ?? "(no handler)"; }
                    catch (Exception e) { resp = "ERR " + e.Message; }
                    finally { done.Set(); }
                });
                done.Wait(8000);
                conn.Send(Encoding.UTF8.GetBytes(resp + "\n"));
            }
            catch { }
        }
    }
}
