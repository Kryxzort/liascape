using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Liascape.Player;

namespace Liascape.Helpers;

// A WE scene's OFFLINE loudness estimate (library.md § Loudness, player-adapter.md § Scenes → "Loudness"): runs
// `liascape-player scene-loudness <scene dir> --props '<its scene_props>'` — the player's own estimator (its sound
// objects → a play plan → each audio file decoded once by ffmpeg, cached per file in ~/.cache/liascape/scene-loudness →
// the live learner) — and stores the result per audio configuration (LibMeta.SceneLoudness[fingerprint]). One child
// at a time per caller, under `nice -n 19 ionice -c3` for the background queue (Web/SceneLoudnessOps); a property
// change re-plans at normal priority (a re-mix from the cache: ~1 ms + the spawn). Never touches playback, never the
// scene's files (read-only).
public static class SceneLoudnessPlanner
{
    public sealed record Plan(string Fingerprint, SceneLoudnessEstimate Estimate, string PropsKey);

    // The CLI's own bound (ffmpeg has 120 s per file; a scene has a handful) — a stuck child is killed.
    private const int TimeoutMs = 600_000;

    private static string? _nice, _ionice;
    private static bool _toolsResolved;

    private static string? OnPath(string exe)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries))
        {
            var p = Path.Combine(dir, exe);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // The item's user properties as the player gets them (`scene_props`) and a key that changes with them (a queued
    // estimate whose props changed meanwhile is stored but never made current — SceneLoudnessOps).
    public static (string Json, string Key) PropsOf(string scenePath, LibMeta? m)
    {
        var map = SceneProperties.PlayerMap(scenePath, m?.SceneProps);
        var json = JsonSerializer.Serialize(map);
        return (json, json);
    }

    // Estimate `scenePath` under its current props (read from the index now). null + `error` on failure (not a scene,
    // a half-downloaded folder, no binary, a killed child). `ct` kills the child.
    public static Plan? Estimate(string scenePath, bool background, CancellationToken ct, out string? error)
    {
        error = null;
        var bin = PlayerEngine.ResolveBinary();
        if (bin == null) { error = "liascape-player not found"; return null; }
        var (props, key) = PropsOf(scenePath, LibraryStore.GetMeta(scenePath));
        var dir = Path.GetFullPath(scenePath).TrimEnd('/');
        ProcessStartInfo psi;
        lock (typeof(SceneLoudnessPlanner))
        {
            if (!_toolsResolved) { _nice = OnPath("nice"); _ionice = OnPath("ionice"); _toolsResolved = true; }
        }
        if (background && _nice != null)
        {
            psi = new ProcessStartInfo(_nice);
            psi.ArgumentList.Add("-n"); psi.ArgumentList.Add("19");
            if (_ionice != null) { psi.ArgumentList.Add(_ionice); psi.ArgumentList.Add("-c3"); }
            psi.ArgumentList.Add(bin);
        }
        else psi = new ProcessStartInfo(bin);
        psi.ArgumentList.Add("scene-loudness");
        psi.ArgumentList.Add(dir);
        psi.ArgumentList.Add("--props");
        psi.ArgumentList.Add(props);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        psi.Environment.Remove("LD_LIBRARY_PATH"); // a stray one on this machine breaks the Nix binary's libs
        string stdout;
        int exit;
        try
        {
            using var p = Process.Start(psi)!;
            p.StandardInput.Close();
            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();
            using (ct.Register(() => { try { p.Kill(true); } catch { } }))
            {
                if (!p.WaitForExit(TimeoutMs)) { try { p.Kill(true); } catch { } error = "timed out"; return null; }
            }
            p.WaitForExit();
            if (ct.IsCancellationRequested) { error = "cancelled"; return null; }
            stdout = outTask.Result;
            exit = p.ExitCode;
            if (exit != 0 && string.IsNullOrWhiteSpace(stdout)) { error = $"exit {exit}: {Trim(errTask.Result)}"; return null; }
        }
        catch (Exception e) { error = e.Message; return null; }
        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var r = doc.RootElement;
            if (r.TryGetProperty("error", out var err)) { error = err.GetString() ?? $"exit {exit}"; return null; }
            if (exit != 0) { error = $"exit {exit}"; return null; }
            if (Str(r, "fingerprint") is not string fp || fp.Length == 0) { error = "no fingerprint"; return null; }
            string[]? notes = r.TryGetProperty("confidence", out var c) && c.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.Array
                ? n.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToArray() : null;
            var est = new SceneLoudnessEstimate
            {
                Lufs = Num(r, "lufs"),
                PeakDbfs = Num(r, "peak_dbfs"),
                Seed = r.TryGetProperty("seed", out var sd) && sd.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.Object ? st.Clone() : null,
                Confidence = c.ValueKind == JsonValueKind.Object ? Str(c, "level") : null,
                Notes = notes is { Length: > 0 } ? notes : null,
                LufsIfCoherent = Num(r, "lufs_if_coherent"),
                Model = Str(r, "model"),
                At = DateTime.UtcNow,
            };
            return new Plan(fp, est, key);
        }
        catch (Exception e) { error = $"unreadable output: {e.Message}"; return null; }
    }

    // Store a plan in the item's index (atomically, field-level — the index lock): its configuration's estimate, made
    // the item's current configuration only if the props it was planned for are still the item's. Returns whether
    // anything was stored, the applied value moved, and the current configuration changed.
    public static (bool Stored, bool Applied, bool FpChanged) Store(string scenePath, Plan plan)
    {
        (bool, bool, bool) r = (false, false, false);
        LibraryStore.SetMeta(scenePath, m =>
        {
            if (!m.IsScene && !PlayerHelper.IsScenePath(scenePath)) return;
            bool current = PropsOf(scenePath, m).Key == plan.PropsKey;
            var before = m.SceneLoudnessFp;
            if (!current)
            {
                // planned for props the item no longer has: keep the estimate for that configuration only
                LibraryService.SceneLoudnessEntryOf(m, plan.Fingerprint, create: true)!.Estimate = plan.Estimate;
                r = (true, false, false);
                return;
            }
            var (stored, applied) = LibraryService.MergeSceneEstimate(m, plan.Fingerprint, plan.Estimate);
            r = (stored, applied, before != m.SceneLoudnessFp);
        });
        return r;
    }

    // Already estimated for its current configuration (the "Estimate" button skips it; "Recalculate all" doesn't).
    public static bool HasEstimate(LibMeta? m) =>
        m?.SceneLoudnessFp is string fp && LibraryService.SceneLoudnessEntryOf(m, fp)?.Estimate != null;

    private static string Trim(string s) { s = s.Trim(); return s.Length > 300 ? s[..300] + "…" : s; }
    private static string? Str(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static double? Num(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
}
