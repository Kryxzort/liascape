using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

// Wallpaper transitions: the effective transition config (a playlist's own or the globals), the pick of one switch's
// effect + duration + method that liascape-player runs, and the catalogue (`transitions/`: the gl-transitions GLSL
// bodies + manifest) the player and the UI's live previews share. See transitions/README.md.
public static class TransitionService
{
    public sealed record Config(bool Enabled, List<string> EffectIds, int DurationMs, int DurationMaxMs, bool Shuffle);

    private static readonly Random _rng = new();
    private static string? _lastEffect;
    private static readonly object _lock = new();

    // ---- effective config (per-playlist override vs global), mirrors AppOps.Eff* ---------------
    public static Config Effective(AppSettings s, PlaylistSettings? p)
    {
        bool ovr = p?.OverrideGlobalSettings == true;
        return ovr
            ? new Config(p!.TransitionEnabled, p.TransitionEffectIds ?? [], p.TransitionDurationMs, p.TransitionDurationMaxMs, p.TransitionShuffle)
            : new Config(s.GlobalTransitionEnabled, s.GlobalTransitionEffectIds ?? [], s.GlobalTransitionDurationMs, s.GlobalTransitionDurationMaxMs, s.GlobalTransitionShuffle);
    }

    // Same effect choice + timing (Config is a record, but its EffectIds list compares by reference).
    public static bool SameConfig(Config a, Config b) =>
        a.Enabled == b.Enabled && a.DurationMs == b.DurationMs && a.DurationMaxMs == b.DurationMaxMs
        && a.Shuffle == b.Shuffle && (a.EffectIds ?? []).SequenceEqual(b.EffectIds ?? []);

    // The effective config for the CURRENT session (single apply => global; playlist => its settings).
    public static Config CurrentConfig()
    {
        var s = SettingsService.Load();
        var ps = PlaylistService.LoadCurrentState()?.Settings;
        return Effective(s, ps);
    }

    // ---- effect / duration selection -----------------------------------------------------------
    public static string? PickEffect(Config c)
    {
        var ids = (c.EffectIds ?? []).Where(EffectExists).Distinct().ToList();
        if (ids.Count == 0) return null;
        if (ids.Count == 1) return ids[0];
        lock (_lock)
        {
            string pick;
            if (c.Shuffle)
            {
                var pool = ids.Where(i => i != _lastEffect).ToList();
                if (pool.Count == 0) pool = ids;
                pick = pool[_rng.Next(pool.Count)];
            }
            else // sequential cycle through the enabled set
            {
                int idx = _lastEffect == null ? -1 : ids.IndexOf(_lastEffect);
                pick = ids[(idx + 1) % ids.Count];
            }
            _lastEffect = pick;
            return pick;
        }
    }

    public static int PickDuration(Config c)
    {
        // 0 ms = a cut (Pick → null); there is no 50 ms floor:
        // 1–49 ms run the effect that fast (the player's gains still ramp ≥ 30 ms)
        int min = Math.Clamp(c.DurationMs, 0, 10000);
        if (c.DurationMaxMs > min) return _rng.Next(min, Math.Clamp(c.DurationMaxMs, min, 10000) + 1);
        return min;
    }

    // The effect/params/duration/method for ONE switch (every effect works with every method in liascape-player).
    // params = the manifest's uniform defaults. null = cut.
    public static (string effectId, Dictionary<string, double[]> uniforms, int durationMs, string method)? Pick(Config cfg)
    {
        if (!cfg.Enabled) return null;
        var effect = PickEffect(cfg);
        if (effect == null) return null;
        int durationMs = PickDuration(cfg);
        if (durationMs <= 0) return null; // 0 ms = a cut (no effect at all, the player's 30 ms anticlick ramps)
        string method = (SettingsService.Load().TransitionMethod ?? "reveal").ToLowerInvariant();
        if (method != "frozen" && method != "full-live" && method != "reveal") method = "reveal";
        var uniforms = new Dictionary<string, double[]>();
        foreach (var u in Manifest().FirstOrDefault(e => e.Id == effect)?.Uniforms ?? [])
            if (u.Default is { Count: > 0 }) uniforms[u.Name] = [.. u.Default];
        return (effect, uniforms, durationMs, method);
    }

    // ---- shader composition + uniform defaults -------------------------------------------------
    private static string ComposeFragment(string dir, string effectId)
    {
        var wrap = File.ReadAllText(Path.Combine(dir, "wrap.frag.template"));
        var body = File.ReadAllText(Path.Combine(dir, "glsl", effectId + ".glsl"));
        return wrap.Replace("//<<BODY>>", body);
    }

    // ---- assets for the UI's live WebGL previews (served by ServerHost) -------------------------
    // The composed fragment for an effect (wrap + body) — the UI compiles the SAME source the
    // player does, so a preview tile matches the live transition exactly.
    public static string? ComposedFragment(string effectId)
    {
        var dir = ResolveDir();
        if (dir == null || !EffectExists(effectId)) return null;
        try { return ComposeFragment(dir, effectId); } catch { return null; }
    }
    public static string? VertSource()
    {
        var dir = ResolveDir();
        try { return dir == null ? null : File.ReadAllText(Path.Combine(dir, "wrap.vert")); } catch { return null; }
    }
    // a representative sample frame ("a"|"b") for preview tiles
    public static string? PreviewImagePath(string which)
    {
        var dir = ResolveDir();
        if (dir == null) return null;
        var p = Path.Combine(dir, "preview", (which == "b" ? "b" : "a") + ".jpg");
        return File.Exists(p) ? p : null;
    }

    private static bool EffectExists(string id) =>
        ResolveDir() is { } d && File.Exists(Path.Combine(d, "glsl", id + ".glsl"));

    // ---- manifest --------------------------------------------------------------------------------
    public sealed class Effect
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
        public bool DefaultOn { get; set; }
        public List<EffectUniform>? Uniforms { get; set; }
    }
    public sealed class EffectUniform
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public List<double>? Default { get; set; }
    }

    private static List<Effect>? _manifest;
    public static List<Effect> Manifest()
    {
        if (_manifest != null) return _manifest;
        try
        {
            var dir = ResolveDir();
            if (dir == null) return _manifest = [];
            var json = File.ReadAllText(Path.Combine(dir, "manifest.json"));
            _manifest = JsonSerializer.Deserialize<List<Effect>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
        }
        catch { _manifest = []; }
        return _manifest;
    }

    // ---- path resolution -------------------------------------------------------------------------
    private static string? _dir;
    public static string? ResolveDir()
    {
        if (_dir != null) return _dir.Length == 0 ? null : _dir;
        var env = Environment.GetEnvironmentVariable("LIASCAPE_TRANSITIONS_DIR");
        foreach (var cand in Candidates(env, installed: "transitions", repoTail: "transitions"))
            if (cand != null && File.Exists(Path.Combine(cand, "manifest.json"))) { _dir = cand; return cand; }
        _dir = ""; return null;
    }
    private static IEnumerable<string?> Candidates(string? env, string installed, string repoTail)
    {
        yield return env;
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".local", "lib", "liascape", installed);
        yield return RepoPath(repoTail);
    }

    // walk up from the running assembly's dir looking for {tail}
    private static string? RepoPath(string tail)
    {
        var d = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && d != null; i++)
        {
            var cand = Path.Combine(d, tail);
            if (File.Exists(cand) || Directory.Exists(cand)) return cand;
            d = Path.GetDirectoryName(d.TrimEnd('/'));
        }
        return null;
    }
}
