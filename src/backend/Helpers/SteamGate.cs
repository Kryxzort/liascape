using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

// EVERY request to steamcommunity.com goes through here (owner 2026-11-11: "make sure you obey the rate limits so user dont
// face ip issues"). Steam limits steamcommunity.com per IP, and once tripped it refused for 30+ minutes — the owner's own
// browser included — after a burst of ~150 page reads (a manual scan + the trailer lookup + timing tests, close together).
// Each feature pacing itself wasn't enough: Browse fetches pages in parallel (+ a prefetch), the background trailer lookup
// ran beside it, and a backend restart forgot Steam had just said "slow down" and started asking again at once.
//   - Spacing: request STARTS are spaced app-wide — InteractiveGapMs for what the user clicked (Browse, subscribe),
//     BackgroundGapMs for background work, which also stays BackgroundQuietMs behind the last interactive request (the
//     user's browsing goes first). Only the start slot is serialized, never the whole request — Browse stays snappy.
//   - Cooldown: a 429 (or Steam's 403 "too many", reported by the caller via Trip) stops ALL steamcommunity requests for
//     Steam's `Retry-After` if it sent one, else 10 min doubling per repeat (cap 60), reset by the next success. Saved to
//     $XDG_CACHE_HOME/liascape/steam-cooldown.json, so a restart keeps honouring it.
//   - During a cooldown nothing is sent: SendAsync throws SteamCooldownException at once — a background job waits it out
//     (CooldownRemaining), something the user clicked fails fast with "try again in N min" instead of adding requests.
// Not here: Steam sign-in (once, user-driven), api.steampowered.com (a separate host and limit).
public static class SteamGate
{
    public enum Kind { Interactive, Background }
    private const int InteractiveGapMs = 500, BackgroundGapMs = 4000, BackgroundQuietMs = 10_000, BaseCooldownMin = 10, MaxCooldownMin = 60;
    private static readonly SemaphoreSlim _slot = new(1, 1);
    private static long _lastStart, _lastInteractive; // Environment.TickCount64
    private static readonly object _lock = new();
    private static DateTimeOffset _until = DateTimeOffset.MinValue;
    private static int _strikes;
    private static bool _loaded;

    private static string StateFile => Path.Combine(
        Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } x ? x
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"),
        "liascape", "steam-cooldown.json");

    private sealed record State(DateTimeOffset Until, int Strikes);

    private static void Load()
    {
        if (_loaded) return;
        _loaded = true;
        try { if (JsonSerializer.Deserialize<State>(File.ReadAllText(StateFile)) is { } s) { _until = s.Until; _strikes = s.Strikes; } }
        catch { /* none yet / unreadable → no cooldown */ }
    }

    private static void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile)!);
            var tmp = StateFile + "." + Environment.ProcessId + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new State(_until, _strikes)));
            File.Move(tmp, StateFile, overwrite: true);
        }
        catch { }
    }

    public static TimeSpan CooldownRemaining
    {
        get { lock (_lock) { Load(); var r = _until - DateTimeOffset.UtcNow; return r > TimeSpan.Zero ? r : TimeSpan.Zero; } }
    }

    // Steam said "too many": stop every steamcommunity request for its Retry-After, else 10 min doubling (cap 60).
    public static void Trip(TimeSpan? retryAfter = null)
    {
        lock (_lock)
        {
            Load();
            _strikes++;
            var minutes = Math.Min(MaxCooldownMin, BaseCooldownMin * (1 << Math.Min(_strikes - 1, 6)));
            var wait = retryAfter is { } ra && ra > TimeSpan.Zero ? ra : TimeSpan.FromMinutes(minutes);
            var until = DateTimeOffset.UtcNow + wait;
            if (until > _until) _until = until;
            Save();
            Console.WriteLine($"steam: rate-limited — pausing every Steam Community request for {Math.Ceiling(wait.TotalMinutes)} min (strike {_strikes})");
        }
    }

    private static void Succeeded()
    {
        lock (_lock) { if (_strikes == 0) return; _strikes = 0; Save(); }
    }

    public static async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, Kind kind, CancellationToken ct = default)
    {
        if (CooldownRemaining is { } cd && cd > TimeSpan.Zero) throw new SteamCooldownException(cd);
        await _slot.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            long now = Environment.TickCount64;
            long wait = Math.Max(0, (kind == Kind.Background ? BackgroundGapMs : InteractiveGapMs) - (now - _lastStart));
            if (kind == Kind.Background) wait = Math.Max(wait, BackgroundQuietMs - (now - _lastInteractive));
            if (wait > 0) await Task.Delay((int)wait, ct).ConfigureAwait(false);
            if (CooldownRemaining is { } cd2 && cd2 > TimeSpan.Zero) throw new SteamCooldownException(cd2);
            _lastStart = Environment.TickCount64;
            if (kind == Kind.Interactive) _lastInteractive = _lastStart;
        }
        finally { _slot.Release(); }
        var resp = await HttpClientProvider.Client.SendAsync(req, ct).ConfigureAwait(false);
        if ((int)resp.StatusCode == 429)
        {
            var ra = resp.Headers.RetryAfter is { } h ? h.Delta ?? (h.Date is { } d ? d - DateTimeOffset.UtcNow : null) : null;
            Trip(ra);
        }
        else if (resp.IsSuccessStatusCode) Succeeded();
        return resp;
    }
}

public sealed class SteamCooldownException(TimeSpan remaining)
    : Exception($"Steam is limiting requests from this connection — try again in {Math.Max(1, (int)Math.Ceiling(remaining.TotalMinutes))} min")
{
    public TimeSpan Remaining { get; } = remaining;
}
