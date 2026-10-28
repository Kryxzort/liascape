using System;
using System.IO;
using livepaper.Helpers;
using livepaper.Models;

namespace livepaper.Player;

// Which player drives the wallpaper: "legacy" (mpvpaper + lp-transition + LWE, the default) or
// "lp-player" (the Rust player, experimental: videos/images, and scenes when its scene worker + WE's
// assets resolve — Phase 2). PlayerHelper dispatches
// at its media primitives on IsLpPlayer; every legacy branch is untouched when it's false.
public static class PlayerEngine
{
    public const string Legacy = "legacy";
    public const string LpPlayer = "lp-player";

    // -1 = not loaded yet, 0 = legacy, 1 = lp-player. Cached (hot path: every IPC primitive asks), loaded
    // lazily from settings.json and refreshed by /settings (Refresh) — daemons/CLI processes load fresh.
    private static volatile int _isLp = -1;
    private static string? _bin;
    private static bool _binResolved;
    private static readonly object _lock = new();

    public static bool IsLpPlayer
    {
        get
        {
            int v = _isLp;
            if (v < 0) { Refresh(SettingsService.Load()); v = _isLp; }
            return v == 1;
        }
    }

    public static bool Wants(AppSettings s) =>
        string.Equals(s.PlayerEngine?.Trim(), LpPlayer, StringComparison.OrdinalIgnoreCase);

    // What IsLpPlayer would be for these settings: the setting asks for lp-player AND the binary exists.
    // A missing binary never crashes — the engine reports unavailable and legacy keeps working.
    public static bool WouldBeLpPlayer(AppSettings s) => Wants(s) && ResolveBinary() != null;

    public static void Refresh(AppSettings s)
    {
        lock (_lock) { _binResolved = false; } // re-resolve: a build/install since the last check counts
        bool lp = WouldBeLpPlayer(s);
        if (Wants(s) && !lp)
            LpPlayerClient.Log($"PlayerEngine=lp-player but {UnavailableReason} → using the legacy engine");
        _isLp = lp ? 1 : 0;
    }

    public static string UnavailableReason =>
        "lp-player binary not found (LP_PLAYER_BIN, next to livepaper, src/player/target/{release,debug}, PATH) — build it with `cargo build --manifest-path src/player/Cargo.toml`";

    // Can a scene item play right now? Scene support on, and the engine that runs can play one: lp-player
    // (Phase 2) when the player has the `scene` capability — its lp-scene-worker AND WE's assets dir
    // resolve (`LpPlayerClient.ScenesAvailable`); legacy when linux-wallpaperengine is on PATH.
    public static bool ScenesPlayable(AppSettings s) =>
        ScenesPlayableFor(s.AllowScenes, IsLpPlayer, () => LpPlayerClient.Shared.ScenesAvailable, PlayerHelper.IsLweAvailable);

    // The rule itself (pure — the self-test's truth table): lazily asks only what the engine needs.
    public static bool ScenesPlayableFor(bool allowScenes, bool isLpPlayer, Func<bool> lpScenes, Func<bool> lweAvailable) =>
        allowScenes && (isLpPlayer ? lpScenes() : lweAvailable());

    // `/player-engine.scenes`: can a scene play now, and if not, why (the first condition that fails).
    public static object SceneStatus(AppSettings s)
    {
        if (IsLpPlayer)
        {
            var (ok, why, assets) = LpPlayerClient.Shared.SceneStatus(withAssets: true);
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

    public const string SceneSupportOff = "scene support is off (Settings → Wallpaper Engine → Allow scene support)";

    // Why a scene can't be applied right now (Apply's error) — null when it can.
    public static string? SceneUnavailableReason(AppSettings s)
    {
        if (!s.AllowScenes) return "Enable \"Allow scene support\" in Settings to play scenes";
        if (!IsLpPlayer) return PlayerHelper.IsLweAvailable() ? null : "linux-wallpaperengine not found in PATH — install it to use scenes";
        var (ok, why, _) = LpPlayerClient.Shared.SceneStatus(withAssets: false);
        return ok ? null : $"lp-player can't play scenes here: {why}";
    }

    // env LP_PLAYER_BIN → next to the running livepaper executable → the repo dev tree
    // src/player/target/{release,debug}/lp-player → PATH (release first: debug is opt-level 0 and the
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
        var env = Environment.GetEnvironmentVariable("LP_PLAYER_BIN");
        if (!string.IsNullOrEmpty(env))
        {
            if (Exe(env)) return Path.GetFullPath(env);
            LpPlayerClient.Log($"LP_PLAYER_BIN={env} does not exist — trying the other locations");
        }
        foreach (var dir in new[] { Path.GetDirectoryName(Environment.ProcessPath), AppContext.BaseDirectory })
        {
            if (string.IsNullOrEmpty(dir)) continue;
            var cand = Path.Combine(dir, "lp-player");
            if (Exe(cand)) return Path.GetFullPath(cand);
        }
        // dev tree: walk up from the running assembly to the repo root (src/livepaper/bin/… → repo)
        var d = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && !string.IsNullOrEmpty(d); i++)
        {
            foreach (var profile in new[] { "release", "debug" })
            {
                var cand = Path.Combine(d, "src", "player", "target", profile, "lp-player");
                if (Exe(cand)) return Path.GetFullPath(cand);
            }
            d = Path.GetDirectoryName(d.TrimEnd('/'));
        }
        foreach (var p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':'))
            if (p.Length > 0 && Exe(Path.Combine(p, "lp-player"))) return Path.Combine(p, "lp-player");
        return null;
    }

    // GET /player-engine: what the setting asks for, what runs, whether lp-player can run (+ why not).
    public static object Status()
    {
        var s = SettingsService.Load();
        lock (_lock) { _binResolved = false; }
        var bin = ResolveBinary();
        return new
        {
            engine = Wants(s) ? LpPlayer : Legacy,
            active = IsLpPlayer ? LpPlayer : Legacy,
            available = bin != null,
            binary = bin,
            running = LpPlayerClient.Shared.RunningInfo(),
            scenes = SceneStatus(s),
            reason = bin == null ? UnavailableReason
                : Wants(s) && !IsLpPlayer ? "lp-player was not found when it was selected — select it again to switch now"
                : LpPlayerClient.Shared.LastError,
        };
    }
}
