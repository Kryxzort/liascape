using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;
using Liascape.Player;

namespace Liascape.Helpers;

// GET /health/features (owner, 2026-10-28: "make missing libraries fail loudly — if a feature won't work because of
// something in the build, show a warning icon"): every feature that silently degrades when a build piece or a runtime
// tool is missing, with whether it works HERE, why not, and the settings (camelCase AppSettings keys, what the UI's
// rows carry as `rk`) it breaks — the UI puts a warning icon with the reason on each of those rows.
// `ok`: true = works, false = won't work (reason says why + what to install), null = not known (e.g. the GPU interop
// before a player ran). The player's own pieces come from its `hello.health` (player-core.md § health), else from
// `liascape-player health` / `scene-check` in this backend's environment (what a player it starts would see).
public static class FeatureHealth
{
    // `inUse` = the user has the feature switched on / selected now (Report: InUse) — the UI's summary lists only what
    // breaks something in use; the row icons show regardless (so a toggle warns before it's turned on)
    public sealed record Feature(string id, string label, bool? ok, string? reason, string[] affects, bool inUse = true);

    // What one report is built from — gathered by Report(), a table in the self-test.
    public sealed record Inputs(
        bool LiascapePlayer,                 // liascape-player is the engine (what the user runs)
        string? LiascapePlayerMissing,       // null = the binary resolves, else why not
        JsonElement? PlayerHealth,     // hello.health / `liascape-player health` (null: no answer)
        (bool ok, string? reason) Scenes,
        Func<string, bool> OnPath,
        bool SteamCmdFound,
        bool LegacyTransitions);       // legacy: liascape-transition + the catalogue resolve

    public static List<Feature> Report(AppSettings s)
    {
        bool onPlayer = PlayerEngine.Wants(s); // the engine the user picked (a missing binary is the first feature)
        string? missing = PlayerEngine.ResolveBinary() == null ? PlayerEngine.UnavailableReason : null;
        JsonElement? ph = null;
        (bool, string?) scenes;
        if (onPlayer && missing == null)
        {
            // a probe that throws reads as unknown (the endpoint never 500s over one)
            try { ph = LiascapePlayerClient.Shared.Health().Health; } catch (Exception e) { LiascapePlayerClient.Log($"/health/features: player health: {e.Message}"); }
            // the running player's own word (its reason names what IT couldn't resolve), else the scene rule here
            if (Part(ph, "scenes") is (bool pok, var pwhy)) scenes = (pok, pwhy);
            else
                try { var (ok, why, _) = LiascapePlayerClient.Shared.SceneStatus(withAssets: false); scenes = (ok, why); }
                catch (Exception e) { scenes = (false, $"couldn't check scene support: {e.Message}"); }
        }
        else if (onPlayer) scenes = (false, missing);
        else scenes = PlayerHelper.IsLweAvailable() ? (true, null) : (false, "linux-wallpaperengine not found in PATH — install it to use scenes");
        bool legacyTr = !onPlayer && TransitionService.ResolveDir() != null && TransitionService.ResolveBinary() != null;
        return Build(new Inputs(onPlayer, missing, ph, scenes, OnPath, WorkshopDownloader.FindSteamCmd(s.SteamCmdPath) != null, legacyTr))
            .Select(f => f with { inUse = InUse(f.id, s) }).ToList();
    }

    public static bool InUse(string id, AppSettings s) => id switch
    {
        "liascape-player" => PlayerEngine.Wants(s),
        "scenes" => s.AllowScenes,
        "transitions" => s.GlobalTransitionEnabled,
        "vram" => s.SceneVramLimitEnabled || !string.Equals(s.VramLowMode, "off", StringComparison.OrdinalIgnoreCase),
        "hwdec-interop" => !string.Equals(s.HwDec, "no", StringComparison.OrdinalIgnoreCase),
        "auto-mute" => s.AutoMute,
        "mpris" => s.AutoMute && s.AutoMuteOnlyIfMprisActive,
        "steamcmd" => s.WorkshopAcquireMode == "steamcmd",
        _ => true, // ffmpeg: imports, thumbnails, durations — always
    };

    public static bool OnPath(string tool) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':')
            .Any(d => d.Length > 0 && File.Exists(Path.Combine(d, tool)));

    // {ok, reason} of one `hello.health` entry; a missing entry / no answer = unknown
    private static (bool? ok, string? reason) Part(JsonElement? h, string name)
    {
        if (h is not { ValueKind: JsonValueKind.Object } o || !o.TryGetProperty(name, out var e) || e.ValueKind != JsonValueKind.Object) return (null, null);
        bool? ok = e.TryGetProperty("ok", out var okEl) ? okEl.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;
        string? reason = e.TryGetProperty("reason", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
        return (ok, reason);
    }

    public static List<Feature> Build(Inputs i)
    {
        var f = new List<Feature>
        {
            new("liascape-player", "liascape-player (the wallpaper player)", i.LiascapePlayerMissing == null, i.LiascapePlayerMissing, ["playerEngine"]),
            new("scenes", "Wallpaper Engine scenes", i.Scenes.ok,
                i.Scenes.ok ? null : i.Scenes.reason ?? "scenes can't play here", ["allowScenes"]),
        };
        if (i.LiascapePlayer)
        {
            if (i.LiascapePlayerMissing == null)
            {
                var (eok, ewhy) = Part(i.PlayerHealth, "effects");
                f.Add(new("transitions", "Transition effects", eok, eok == false ? ewhy : null,
                    ["globalTransitionEnabled", "transitionMethod", "transitions"]));
                var (vok, vwhy) = Part(i.PlayerHealth, "vram");
                f.Add(new("vram", "VRAM measurement", vok, vok == false ? vwhy : null,
                    ["sceneVramLimitEnabled", "sceneVramLimitMib", "vramLowMode"]));
                var (hok, hwhy) = Part(i.PlayerHealth, "hwdec_interop");
                f.Add(new("hwdec-interop", "Zero-copy hardware decoding", hok, hok == false ? hwhy : null, ["hwDec"]));
            }
        }
        else
            f.Add(new("transitions", "Transition effects", i.LegacyTransitions,
                i.LegacyTransitions ? null : "liascape-transition or the transitions catalogue not found (install.sh builds it) — every switch is a cut",
                ["globalTransitionEnabled", "transitionMethod", "transitions"]));
        var am = new[] { "pactl", "parec" }.Where(t => !i.OnPath(t)).ToArray();
        f.Add(new("auto-mute", "Auto-mute", am.Length == 0,
            am.Length == 0 ? null : $"{string.Join(" and ", am)} not found in PATH (libpulse / pipewire-pulse tools) — auto-mute can't hear other apps' audio",
            ["autoMute"]));
        bool pc = i.OnPath("playerctl");
        f.Add(new("mpris", "MPRIS check (auto-mute)", pc, pc ? null : "playerctl not found in PATH — \"Only if MPRIS player active\" can't see any player, so auto-mute never mutes with it on",
            ["autoMuteOnlyIfMprisActive"]));
        var ff = new[] { "ffmpeg", "ffprobe" }.Where(t => !i.OnPath(t)).ToArray();
        f.Add(new("ffmpeg", "ffmpeg", ff.Length == 0,
            ff.Length == 0 ? null : $"{string.Join(" and ", ff)} not found in PATH — loudness can't be measured (Normalize audio), and imports, thumbnails and video durations fail",
            ["normalizeAudio"]));
        f.Add(new("steamcmd", "steamcmd", i.SteamCmdFound,
            i.SteamCmdFound ? null : "steamcmd not found (set its path, or install it) — \"Download via steamcmd\" can't download",
            ["workshopAcquireMode", "steamCmdPath"]));
        return f;
    }
}
