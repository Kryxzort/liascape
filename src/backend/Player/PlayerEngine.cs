using System;
using System.Collections.Generic;
using System.IO;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Player;

// Which player drives the wallpaper: "legacy" (mpvpaper + liascape-transition + LWE, the default) or
// "liascape-player" (the Rust player, experimental: videos/images, and scenes when its scene worker + WE's
// assets resolve — Phase 2). PlayerHelper dispatches
// at its media primitives on IsLiascapePlayer; every legacy branch is untouched when it's false.
public static class PlayerEngine
{
    public const string Legacy = "legacy";
    public const string LiascapePlayer = "liascape-player";

    // -1 = not loaded yet, 0 = legacy, 1 = liascape-player. Cached (hot path: every IPC primitive asks), loaded
    // lazily from settings.json and refreshed by /settings (Refresh) — daemons/CLI processes load fresh.
    private static volatile int _isPlayer = -1;
    private static string? _bin;
    private static bool _binResolved;
    private static readonly object _lock = new();

    public static bool IsLiascapePlayer
    {
        get
        {
            int v = _isPlayer;
            if (v < 0) { Refresh(SettingsService.Load()); v = _isPlayer; }
            return v == 1;
        }
    }

    public static bool Wants(AppSettings s) =>
        string.Equals(s.PlayerEngine?.Trim(), LiascapePlayer, StringComparison.OrdinalIgnoreCase);

    // What IsLiascapePlayer would be for these settings: the setting asks for liascape-player AND the binary exists.
    // A missing binary never crashes — the engine reports unavailable and legacy keeps working.
    public static bool WouldBeLiascapePlayer(AppSettings s) => Wants(s) && ResolveBinary() != null;

    public static void Refresh(AppSettings s)
    {
        lock (_lock) { _binResolved = false; } // re-resolve: a build/install since the last check counts
        bool onPlayer = WouldBeLiascapePlayer(s);
        if (Wants(s) && !onPlayer)
            LiascapePlayerClient.Log($"PlayerEngine=liascape-player but {UnavailableReason} → using the legacy engine");
        _isPlayer = onPlayer ? 1 : 0;
    }

    public static string UnavailableReason =>
        "liascape-player binary not found (LIASCAPE_PLAYER_BIN, next to liascape-backend, <prefix>/libexec/liascape, src/player/target/{release,debug}, PATH) — build it with `cargo build --manifest-path src/player/Cargo.toml`";

    // Can a scene item play right now? Scene support on, and the engine that runs can play one: liascape-player
    // (Phase 2) when the player has the `scene` capability — its liascape-scene-worker AND WE's assets dir
    // resolve (`LiascapePlayerClient.ScenesAvailable`); legacy when linux-wallpaperengine is on PATH.
    public static bool ScenesPlayable(AppSettings s) =>
        ScenesPlayableFor(s.AllowScenes, IsLiascapePlayer, () => LiascapePlayerClient.Shared.ScenesAvailable, PlayerHelper.IsLweAvailable);

    // The rule itself (pure — the self-test's truth table): lazily asks only what the engine needs.
    public static bool ScenesPlayableFor(bool allowScenes, bool isLiascapePlayer, Func<bool> liascapeScenes, Func<bool> lweAvailable) =>
        allowScenes && (isLiascapePlayer ? liascapeScenes() : lweAvailable());

    // `/player-engine.scenes`: can a scene play now, and if not, why (the first condition that fails).
    public static object SceneStatus(AppSettings s)
    {
        if (IsLiascapePlayer)
        {
            var (ok, why, assets) = LiascapePlayerClient.Shared.SceneStatus(withAssets: true);
            return new
            {
                available = ok && s.AllowScenes,
                reason = !s.AllowScenes ? SceneSupportOff : why,
                assets_dir = assets,
            };
        }
        bool lwe = PlayerHelper.IsLweAvailable();
        return new
        {
            available = s.AllowScenes && lwe,
            reason = !s.AllowScenes ? SceneSupportOff : lwe ? null : "linux-wallpaperengine not found in PATH — install it to use scenes",
            assets_dir = (string?)null,
        };
    }

    // `/player-engine.vram` (liascape-player only, else null): is the player's low-VRAM rule holding the wallpaper now
    // (`player.vram_low_active` — paused, and in `stop` mode its GPU memory freed; NOT a user pause: `player.paused`
    // stays as the user left it), under which mode. `low_active` null = no player answering.
    public static object? VramStatus(AppSettings s)
    {
        if (!IsLiascapePlayer) return null;
        bool? low = null;
        var c = LiascapePlayerClient.Shared;
        if (c.SocketExists)
            try { low = c.Call("get", new Dictionary<string, object?> { ["path"] = "player.vram_low_active" }, LiascapePlayerClient.QuickMs).GetProperty("value").ValueKind == System.Text.Json.JsonValueKind.True; }
            catch (LiascapePlayerException) { }
        return new { low_active = low, mode = s.VramLowMode };
    }

    public const string SceneSupportOff ="scene support is off (Settings → Wallpaper Engine → Allow scene support)";

    // Why a scene can't be applied right now (Apply's error) — null when it can.
    public static string? SceneUnavailableReason(AppSettings s)
    {
        if (!s.AllowScenes) return "Enable \"Allow scene support\" in Settings to play scenes";
        if (!IsLiascapePlayer) return PlayerHelper.IsLweAvailable() ? null : "linux-wallpaperengine not found in PATH — install it to use scenes";
        var (ok, why, _) = LiascapePlayerClient.Shared.SceneStatus(withAssets: false);
        return ok ? null : $"liascape-player can't play scenes here: {why}";
    }

    // env LIASCAPE_PLAYER_BIN → next to the running liascape-backend / libexec/liascape/ → the repo dev tree
    // src/player/target/{release,debug}/liascape-player → PATH (release first: debug is opt-level 0 and the
    // player mixes audio itself). Cached until the next Refresh, or `fresh` (the upgrade check).
    public static string? ResolveBinary(bool fresh = false)
    {
        lock (_lock)
        {
            if (_binResolved && !fresh) return _bin;
            _bin = Resolve();
            _binResolved = true;
            return _bin;
        }
    }

    private static string? Resolve()
    {
        static bool Exe(string? p) => !string.IsNullOrEmpty(p) && File.Exists(p);
        var env = Environment.GetEnvironmentVariable("LIASCAPE_PLAYER_BIN");
        if (!string.IsNullOrEmpty(env))
        {
            if (Exe(env)) return Path.GetFullPath(env);
            LiascapePlayerClient.Log($"LIASCAPE_PLAYER_BIN={env} does not exist — trying the other locations");
        }
        // next to this executable, or the installed layout's libexec/liascape/ (this backend runs from
        // <prefix>/lib/liascape/backend/ — scripts/liascape sets LIASCAPE_PLAYER_BIN, this covers a bare start)
        var here = Path.GetDirectoryName(Environment.ProcessPath);
        foreach (var dir in new[] { here, AppContext.BaseDirectory,
                     here == null ? null : Path.Combine(here, "..", "..", "..", "libexec", "liascape") })
        {
            if (string.IsNullOrEmpty(dir)) continue;
            var cand = Path.Combine(dir, "liascape-player");
            if (Exe(cand)) return Path.GetFullPath(cand);
        }
        // dev tree: walk up from the running assembly to the repo root (src/backend/bin/… → repo)
        var d = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && !string.IsNullOrEmpty(d); i++)
        {
            foreach (var profile in new[] { "release", "debug" })
            {
                var cand = Path.Combine(d, "src", "player", "target", profile, "liascape-player");
                if (Exe(cand)) return Path.GetFullPath(cand);
            }
            d = Path.GetDirectoryName(d.TrimEnd('/'));
        }
        foreach (var p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':'))
            if (p.Length > 0 && Exe(Path.Combine(p, "liascape-player"))) return Path.Combine(p, "liascape-player");
        return null;
    }

    // GET /player-engine: what the setting asks for, what runs, whether liascape-player can run (+ why not).
    public static object Status()
    {
        var s = SettingsService.Load();
        lock (_lock) { _binResolved = false; }
        var bin = ResolveBinary();
        return new
        {
            engine = Wants(s) ? LiascapePlayer : Legacy,
            active = IsLiascapePlayer ? LiascapePlayer : Legacy,
            available = bin != null,
            binary = bin,
            running = LiascapePlayerClient.Shared.RunningInfo(),
            scenes = SceneStatus(s),
            vram = VramStatus(s),
            reason = bin == null ? UnavailableReason
                : Wants(s) && !IsLiascapePlayer ? "liascape-player was not found when it was selected — select it again to switch now"
                : LiascapePlayerClient.Shared.LastError,
        };
    }
}
