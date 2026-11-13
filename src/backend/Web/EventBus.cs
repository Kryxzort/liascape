using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using Liascape.Helpers;

namespace Liascape.Web;

// API: pushes backend events (PlayerHelper callbacks, download/unsub progress) to all connected
// renderers over WebSocket /events. One message shape: {"type": "...", "payload": {...}}.
public static class EventBus
{
    private static readonly ConcurrentDictionary<Guid, (WebSocket Sock, SemaphoreSlim Gate)> _clients = new();

    public static void Add(Guid id, WebSocket ws) => _clients[id] = (ws, new SemaphoreSlim(1, 1));
    public static void Remove(Guid id) => _clients.TryRemove(id, out _);

    // the hidden `steam-selftest` listens here (every event as sent: its type + the JSON)
    internal static Action<string, string>? Tap;

    public static void Broadcast(string type, object? payload = null)
    {
        var json = JsonSerializer.Serialize(new { type, payload });
        Tap?.Invoke(type, json);
        var bytes = Encoding.UTF8.GetBytes(json);
        foreach (var (id, c) in _clients)
        {
            if (c.Sock.State != WebSocketState.Open) { _clients.TryRemove(id, out _); continue; }
            // PERF: serialize sends per socket — concurrent SendAsync on one socket throws.
            _ = SendAsync(id, c, bytes);
        }
    }

    private static async System.Threading.Tasks.Task SendAsync(Guid id, (WebSocket Sock, SemaphoreSlim Gate) c, byte[] bytes)
    {
        await c.Gate.WaitAsync();
        try { await c.Sock.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch { _clients.TryRemove(id, out _); }
        finally { c.Gate.Release(); }
    }

    // The backend is stopping: tell a connected page so (1001 going away; it reconnects, app/ui/src/api/events.ts) instead
    // of waiting for it to close first, which an open page never does. Through the socket's send gate (a broadcast may be
    // mid-send); a page that doesn't read within `ms` gets no frame, and its socket is cut by the caller.
    public static async System.Threading.Tasks.Task CloseForStopAsync(Guid id, WebSocket sock, int ms)
    {
        _clients.TryRemove(id, out var c);
        using var cts = new CancellationTokenSource(ms);
        var gate = c.Gate;
        try
        {
            if (gate != null) await gate.WaitAsync(cts.Token);
            try { await sock.CloseOutputAsync(WebSocketCloseStatus.EndpointUnavailable, "backend stopping", cts.Token); }
            finally { gate?.Release(); }
        }
        catch { }
    }

    // Wires PlayerHelper's wallpaper-changed / scene-crashed / timed-stopped callbacks to fan out
    // to the UI over WS.
    public static void WirePlayer()
    {
        PlayerHelper.OnWallpaperChanged = p => Broadcast("wallpaper-changed", new { path = p });
        PlayerHelper.OnSceneCrashed = p => Broadcast("scene-crashed", new { path = p });
        PlayerHelper.OnSceneVramStoppedCb = (p, used, limit, msg) => Broadcast("scene-vram-stopped", new { path = p, usedMib = used, limitMib = limit, message = msg });
        PlayerHelper.OnTimedPlaylistStopped = () => Broadcast("timed-stopped");
    }
}
