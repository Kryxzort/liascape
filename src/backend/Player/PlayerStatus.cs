using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Player;

// liascape-player, the Rust player (videos, images, and scenes when its scene worker + WE's assets resolve), is the only
// engine: where its binary is, why nothing or no scene can play, and the low-VRAM state. A missing binary is an error
// with its reason, never a fallback: docs/decisions.md § "Make liascape-player the only engine, no fallback".
public static class PlayerStatus
{
    private static string? _bin;
    private static bool _binResolved;
    private static readonly object _lock = new();
    // the missing-binary reason last logged (null while a binary resolves): every attempt looks again, the log says why once
    private static string? _loggedMissing;

    public static string UnavailableReason =>
        "liascape-player binary not found (LIASCAPE_PLAYER_BIN, next to liascape-backend, <prefix>/libexec/liascape, <prefix>/lib/liascape, src/player/target/{release,debug}, PATH) — build it with `cargo build --manifest-path src/player/Cargo.toml`";

    // Why nothing can play here: no player binary resolves (looked for again unless the one found before is still there,
    // so one that appeared since counts and one removed since doesn't), else null. A switch refuses with it rather than
    // queue one that can't start. Guard: scripts/test-player-binary.sh § missing, § appears later, § removed again
    public static string? MissingReason() => ResolveBinary() == null ? UnavailableReason : null;

    // Can a scene item play right now? Scene support on, and the player has the `scene` capability — its
    // liascape-scene-worker AND WE's assets dir resolve (`LiascapePlayerClient.ScenesAvailable`).
    public static bool ScenesPlayable(AppSettings s) =>
        ScenesPlayableFor(s.AllowScenes, () => LiascapePlayerClient.Shared.ScenesAvailable);

    // The rule itself (pure — the self-test's truth table): the player is asked only when scene support is on.
    public static bool ScenesPlayableFor(bool allowScenes, Func<bool> liascapeScenes) => allowScenes && liascapeScenes();

    // `/player-engine.scenes`: can a scene play now, and if not, why (the first condition that fails).
    public static object SceneStatus(AppSettings s)
    {
        var (ok, why, assets) = LiascapePlayerClient.Shared.SceneStatus(withAssets: true);
        return new
        {
            available = ok && s.AllowScenes,
            reason = !s.AllowScenes ? SceneSupportOff : why,
            assets_dir = assets,
        };
    }

    // `/player-engine.vram`: is the player's low-VRAM rule holding the wallpaper now (`player.vram_low_active` — paused,
    // and in `stop` mode its GPU memory freed; NOT a user pause: `player.paused` stays as the user left it), under which
    // mode. `low_active` null = no player answering.
    public static object VramStatus(AppSettings s)
    {
        bool? low = null;
        var c = LiascapePlayerClient.Shared;
        if (c.SocketExists)
            try { low = c.Call("get", new Dictionary<string, object?> { ["path"] = "player.vram_low_active" }, LiascapePlayerClient.QuickMs).GetProperty("value").ValueKind == System.Text.Json.JsonValueKind.True; }
            catch (LiascapePlayerException) { }
        if (_vramTotal == null) NoteVramTotal(c.Health().Health); // a card's total doesn't change while it runs
        // API: Settings' "Video memory cap (MiB)" takes `total_mib` as its max (65536 while unknown) and says why
        // a larger saved cap holds at it
        return new { low_active = low, mode = s.VramLowMode, total_mib = _vramTotal };
    }

    // The card's total VRAM (MiB), from the player's `health.vram.total_mib` (its VRAM probe: NVML, else AMD's
    // `mem_info_vram_total`), once any health answer carried it; null until then and without a measurement. It bounds the
    // per-scene VRAM cap: the player's guard gets `min(SceneVramLimitMib, VramCapMax)` (LiascapePlayerMedia.GpuProps),
    // the setting keeps what was saved. Guard: player-selftest (GpuProps, VramTotalOf), probe-settings vram:capMax
    private static volatile int _vramTotalRaw; // 0 = unknown
    private static int? _vramTotal => _vramTotalRaw > 0 ? _vramTotalRaw : null;
    public static int? VramTotalMib => _vramTotal;
    internal static int? VramTotalForTest { get => _vramTotal; set => _vramTotalRaw = value ?? 0; }
    // the cap's bound while the card's total isn't known
    public const int VramCapUnknownMax = 65536;
    public static int VramCapMax => _vramTotal ?? VramCapUnknownMax;

    // `vram.total_mib` of a `hello.health` / `liascape-player health` answer (null: no answer, no measurement, pending)
    public static int? VramTotalOf(JsonElement? health) =>
        health is { ValueKind: JsonValueKind.Object } h && h.TryGetProperty("vram", out var v) && v.ValueKind == JsonValueKind.Object
            && v.TryGetProperty("total_mib", out var t) && t.ValueKind == JsonValueKind.Number && t.TryGetDouble(out var d) && d >= 1
            ? (int)Math.Min(Math.Round(d), int.MaxValue) : null;

    // A health answer read anywhere: a total newly known (or changed) moves the playing wallpaper's guard at once, so a saved
    // cap above the card holds at its total live, not from the next player start. The set reads the settings when it runs
    // (`settings`, the saved file unless a test hands its own), never a snapshot taken here: an edit saved meanwhile wins.
    // Guard: player-selftest VramCapRaceAssertions
    public static void NoteVramTotal(JsonElement? health, Func<AppSettings>? settings = null)
    {
        if (VramTotalOf(health) is not int t || t == _vramTotal) return;
        _vramTotalRaw = t;
        LiascapePlayerMedia.ReassertVramCap(settings ?? SettingsService.Load);
    }

    public const string SceneSupportOff ="scene support is off (Settings → Wallpaper Engine → Play scenes)";

    // Why a scene can't be applied right now (Apply's error) — null when it can.
    public static string? SceneUnavailableReason(AppSettings s)
    {
        if (!s.AllowScenes) return "Turn on \"Play scenes\" in Settings to play scenes";
        var (ok, why, _) = LiascapePlayerClient.Shared.SceneStatus(withAssets: false);
        return ok ? null : $"liascape-player can't play scenes here: {why}";
    }

    // env LIASCAPE_PLAYER_BIN → next to the running liascape-backend / libexec/liascape/ / lib/liascape/ → the repo dev tree
    // src/player/target/{release,debug}/liascape-player → PATH (release first: debug is opt-level 0 and the
    // player mixes audio itself). Cached while the file found is still there: a miss, or a binary removed since, is looked
    // for again on every call; `fresh` resolves again regardless (the upgrade check, a status read). Guard: player-selftest
    // "binary resolution"
    public static string? ResolveBinary(bool fresh = false)
    {
        lock (_lock)
        {
            if (_binResolved && !fresh && _bin != null && File.Exists(_bin)) return _bin;
            string? envMiss = null;
            _bin = Resolve(ref envMiss);
            _binResolved = true;
            // a status read and every switch resolve afresh while it's missing: say why once, again only when the why
            // changes or a binary turned up meanwhile. Guard: scripts/test-player-binary.sh § missing ("logged once")
            var why = _bin == null ? UnavailableReason : envMiss;
            if (why == null) _loggedMissing = null;
            else if (why != _loggedMissing)
            {
                _loggedMissing = why;
                if (envMiss != null) LiascapePlayerClient.Log(envMiss);
                if (_bin == null) LiascapePlayerClient.Log(UnavailableReason);
            }
            return _bin;
        }
    }

    private static string? Resolve(ref string? envMiss)
    {
        static bool Exe(string? p) => !string.IsNullOrEmpty(p) && File.Exists(p);
        var env = Environment.GetEnvironmentVariable("LIASCAPE_PLAYER_BIN");
        if (!string.IsNullOrEmpty(env))
        {
            if (Exe(env)) return Path.GetFullPath(env);
            envMiss = $"LIASCAPE_PLAYER_BIN={env} does not exist — trying the other locations";
        }
        // next to this executable, or the installed layout's libexec/liascape/, or lib/liascape/ itself (Arch's package,
        // whose guidelines rule out /usr/libexec) — this backend runs from <prefix>/lib/liascape/backend/;
        // scripts/liascape sets LIASCAPE_PLAYER_BIN, this covers a bare start
        var here = Path.GetDirectoryName(Environment.ProcessPath);
        foreach (var dir in new[] { here, AppContext.BaseDirectory,
                     here == null ? null : Path.Combine(here, "..", "..", "..", "libexec", "liascape"),
                     here == null ? null : Path.Combine(here, "..") })
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

    // GET /player-engine: whether liascape-player can run (+ why not), what runs, scene and VRAM status. Resolves the
    // binary afresh: one that appeared since (a rebuild, a store path after boot) shows here, and the next switch starts it.
    public static object Status()
    {
        var s = SettingsService.Load();
        var bin = ResolveBinary(fresh: true);
        return new
        {
            available = bin != null,
            binary = bin,
            running = LiascapePlayerClient.Shared.RunningInfo(),
            scenes = SceneStatus(s),
            vram = VramStatus(s),
            reason = bin == null ? UnavailableReason : LiascapePlayerClient.Shared.LastError,
        };
    }
}
