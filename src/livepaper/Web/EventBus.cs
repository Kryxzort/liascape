using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using livepaper.Helpers;

namespace livepaper.Web;

// API: pushes backend events (PlayerHelper callbacks, download/unsub progress) to all connected
// renderers over WebSocket /events. One message shape: {"type": "...", "payload": {...}}.
public static class EventBus
{
    private static readonly ConcurrentDictionary<Guid, (WebSocket Sock, SemaphoreSlim Gate)> _clients = new();

    public static void Add(Guid id, WebSocket ws) => _clients[id] = (ws, new SemaphoreSlim(1, 1));
    public static void Remove(Guid id) => _clients.TryRemove(id, out _);

    public static void Broadcast(string type, object? payload = null)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type, payload }));
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

    // Wires PlayerHelper's wallpaper-changed / scene-crashed / timed-stopped callbacks to fan out
    // to the UI over WS.
    public static void WirePlayer()
    {
        PlayerHelper.OnWallpaperChanged = p => Broadcast("wallpaper-changed", new { path = p });
        PlayerHelper.OnSceneCrashed = p => Broadcast("scene-crashed", new { path = p });
        PlayerHelper.OnTimedPlaylistStopped = () => Broadcast("timed-stopped");
    }
}
