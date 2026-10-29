using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

// Per-source, per-item-folder library. Layout (see LibraryStore):
//   <source>/<key>/<key>.mp4|png (+ <key>.jpg/.gif)        web/imported video — folder named after the item
//   workshop/<id>/{file.mp4, preview.*, project.json}      direct-DL video (owned, Steam-mirror)
//   local/<id> -> symlink into the user's WE dir           subscribed/WE-local video
//   workshop/<id> | local/<id>                             SCENE — the item FOLDER itself is the play path.
//       PlayerHelper.IsScenePath = "no media extension"; LWE launches by id (local) or dir (owned).
//       Scene-ness comes from index .IsScene / project.json type / scene.pkg.
//   <source>/index.json                                    metadata (volume/speed/crashed/whitelist/source/…)
// Metadata + dedup live in the per-source index.json (see LibraryStore).
public static class LibraryService
{
    private static readonly string[] VideoExts = { ".mp4", ".webm", ".mov", ".mkv", ".avi" };
    private static bool IsVideoFile(string p) => VideoExts.Contains(Path.GetExtension(p).ToLowerInvariant());

    // ---------- read overrides / flags (now from the source index) ----------
    public static int? ReadVolumeOverride(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Volume;
    public static double? ReadSpeedOverride(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Speed;
    public static bool IsWhitelisted(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Whitelist ?? false;
    public static bool HasCrashed(string mediaPath) => LibraryStore.GetMeta(mediaPath)?.Crashed ?? false;

    // ---------- write overrides / flags (drop volume/speed when == global → "use global") ----------
    public static void SaveVolumeOverride(string mediaPath, int? volume)
    {
        if (volume.HasValue && volume.Value == SettingsService.Load().Volume) volume = null;
        LibraryStore.SetMeta(mediaPath, m => m.Volume = volume);
    }

    // A volume key on the item's own volume: the step from what's SAVED, inside the index lock (a value computed from an
    // earlier read lost every concurrent step but one). Its own volume, else the global; dropped when it lands on the
    // global. Returns (from, to); from == to = at the clamp, nothing saved.
    public static (int From, int To) StepVolumeOverride(string mediaPath, int delta)
    {
        int global = SettingsService.Load().Volume, from = global, to = global;
        LibraryStore.SetMeta(mediaPath, m =>
        {
            from = m.Volume ?? global;
            to = Math.Clamp(from + delta, 0, 100);
            if (to != from) m.Volume = to == global ? null : to;
        });
        return (from, to);
    }

    public static void SaveSpeedOverride(string mediaPath, double? speed)
    {
        if (speed.HasValue && Math.Abs(speed.Value - SettingsService.Load().Speed) < 1e-6) speed = null;
        LibraryStore.SetMeta(mediaPath, m => m.Speed = speed);
    }

    // ---------- scene user properties (SceneProperties; library.md § "Scene properties") ----------
    public static Dictionary<string, JsonElement>? ReadSceneProps(string scenePath) => LibraryStore.GetMeta(scenePath)?.SceneProps;

    // One property's override (`value` null = back to the scene's default), or every one (`name` null). A value
    // equal to the default drops the override. Field-level, inside the index lock. Returns an error or null.
    public static string? SaveSceneProp(string scenePath, string? name, JsonElement? value)
    {
        if (name == null)
        {
            LibraryStore.SetMeta(scenePath, m => m.SceneProps = null);
            return null;
        }
        var p = SceneProperties.Find(scenePath, name);
        if (p == null) return $"{name}: no such property in this scene's project.json";
        System.Text.Json.Nodes.JsonNode? v = null;
        if (value is JsonElement e)
        {
            var (c, err) = SceneProperties.Coerce(p, e);
            if (err != null) return err;
            if (!SceneProperties.SameValue(p, c, p.Default)) v = c;
        }
        else if (!p.Editable) return $"{name}: can't be set";
        LibraryStore.SetMeta(scenePath, m =>
        {
            var d = m.SceneProps ?? new Dictionary<string, JsonElement>();
            if (v == null) d.Remove(name);
            else d[name] = JsonSerializer.SerializeToElement(v);
            m.SceneProps = d.Count == 0 ? null : d;
        });
        return null;
    }

    public static void SetWhitelisted(string mediaPath, bool whitelisted) =>
        LibraryStore.SetMeta(mediaPath, m => m.Whitelist = whitelisted);

    public static void MarkCrashed(string mediaPath) =>
        LibraryStore.SetMeta(mediaPath, m => m.Crashed = true);

    // ---------- loudness (EBU R128) measurement, cached in the index ----------
    public readonly record struct Loudness(double I, double TP, double LRA, double Thresh);

    // Cached measurement for an item, or null if not yet analyzed.
    public static Loudness? ReadLoudness(string mediaPath)
    {
        var m = LibraryStore.GetMeta(mediaPath);
        if (m?.LoudnessI is { } i && m.LoudnessTP is { } tp && m.LoudnessLRA is { } lra && m.LoudnessThresh is { } th)
            return new Loudness(i, tp, lra, th);
        return null;
    }

    // The loudnorm audio-filter string to gain-match a measured item to targetLufs (linear, true-peak
    // limited at -1.5 dBTP). Null if the item isn't measured yet. Used by both mpvpaper (PlayerHelper)
    // and the transition overlay (TransitionService → liascape-transition --from-af/--to-af) so both level.
    public static string? LoudnormAf(string mediaPath, double targetLufs)
    {
        var m = ReadLoudness(mediaPath);
        if (m == null) return null;
        var inv = System.Globalization.CultureInfo.InvariantCulture; var v = m.Value;
        return "loudnorm=I=" + targetLufs.ToString(inv) + ":TP=-1.5:LRA=11" +
               ":measured_I=" + v.I.ToString(inv) + ":measured_TP=" + v.TP.ToString(inv) +
               ":measured_LRA=" + v.LRA.ToString(inv) + ":measured_thresh=" + v.Thresh.ToString(inv) + ":linear=true";
    }

    // ---- a WE scene's loudness, per audio configuration: estimated offline, learned live (liascape-player) ----
    // LibMeta.SceneLoudness[fingerprint] = {estimate, live} (library.md § Loudness). The fingerprint is the offline
    // estimator's (`liascape-player scene-loudness`, SceneLoudnessPlanner) of the scene's sound under its user
    // properties: toggling a sound off and back on returns to the measurement that configuration already had, a
    // never-played combination starts from its estimate. The player measures (BS.1770, pre-gain, AUDIBLE play —
    // player-core.md § Scene worker → "Scene loudness"; one measurement per (path, `loudness_key`)): the first report
    // after ~60 s, then one per further 60 s and at the end of each play, each covering EVERY play of that
    // configuration so far, until its cap (30 min). The resolver turns the applied value into the scene source's
    // `gain.normalize` (LiascapePlayerMedia.SceneNormalizeDb).
    // - A report's configuration = its `key` (the source's `loudness_key`), else (a source that had none — never
    //   estimated) the item's current one, else "".
    // - The live measurement (state, seconds, partial) is replaced by any report covering MORE audible seconds
    //   (reports are cumulative: a lost one is made up by the next; two sources of one scene at once keep the longer).
    // - The APPLIED value (LoudnessI, LoudnessTP) = the CURRENT configuration's live measurement once it has one,
    //   else its estimate; within one configuration it moves only when it changed ≥ ApplyHysteresisLu (0.5 LU / dB)
    //   — `gain.normalize` follows a refinement smoothly (the 500 ms ramp) and never twitches by a tenth; a change of
    //   configuration jumps to the new one's value (another sound). A report of another configuration (an old key's
    //   end report after a property change) is stored under it and applies nothing.
    // Returns (stored: `m` changed, applied: LoudnessI/TP changed → normalization should follow it live). Pure (the
    // self-test drives it on a bare LibMeta).
    public const double ApplyHysteresisLu = 0.5;
    public static (bool Stored, bool Applied) MergeSceneLoudness(LibMeta m, string? key, double lufs, double? peakDbfs,
        double seconds, bool complete, JsonElement? state = null)
    {
        if (!double.IsFinite(lufs) || !double.IsFinite(seconds) || seconds <= 0) return (false, false);
        string fp = !string.IsNullOrEmpty(key) ? key : m.SceneLoudnessFp ?? "";
        var e = SceneLoudnessEntryOf(m, fp, create: true)!;
        if (e.Live is { } old && seconds <= old.Seconds + 1e-9) return (false, false);
        double? peak = peakDbfs is double p && double.IsFinite(p) ? p : null;
        e.Live = new SceneLoudnessLive
        {
            State = state is { ValueKind: JsonValueKind.Object } s ? s.Clone() : null,
            Seconds = seconds, Lufs = lufs, PeakDbfs = peak, Partial = complete ? null : true,
        };
        m.LoudnessLRA = null; m.LoudnessThresh = null; m.LoudnessSkip = null;
        bool applied = fp == (m.SceneLoudnessFp ?? "") && ApplySceneLoudness(m, jump: false);
        return (true, applied);
    }

    // The offline estimate of configuration `fp` (the item's current props): stored in its entry, and `fp` becomes the
    // item's current configuration. The applied value follows: a new configuration jumps to its value (its live
    // measurement if it was played before, else this estimate); the same one moves by the 0.5 LU rule, and only when it
    // has no live measurement (an estimate never displaces live data). An item measured before it had any fingerprint
    // (reports under "") hands that measurement to `fp` the first time it gets one. Pure.
    public static (bool Stored, bool Applied) MergeSceneEstimate(LibMeta m, string fp, SceneLoudnessEstimate est)
    {
        if (string.IsNullOrEmpty(fp)) return (false, false);
        var e = SceneLoudnessEntryOf(m, fp, create: true)!;
        if (m.SceneLoudnessFp == null && e.Live == null && m.SceneLoudness!.TryGetValue("", out var unkeyed) && unkeyed.Live != null)
        {
            e.Live = unkeyed.Live;
            m.SceneLoudness.Remove("");
        }
        bool jump = m.SceneLoudnessFp != fp;
        e.Estimate = est;
        m.SceneLoudnessFp = fp;
        return (true, ApplySceneLoudness(m, jump));
    }

    // The current configuration's entry (`create` adds an empty one).
    public static SceneLoudnessEntry? SceneLoudnessEntryOf(LibMeta m, string? fp, bool create = false)
    {
        fp ??= "";
        if (m.SceneLoudness?.TryGetValue(fp, out var e) == true) return e;
        if (!create) return null;
        m.SceneLoudness ??= new();
        return m.SceneLoudness[fp] = new SceneLoudnessEntry();
    }

    // (lufs, peak, estimated) of the current configuration: its live measurement, else its estimate; null = nothing.
    public static (double? Lufs, double? Peak, bool Estimated)? SceneLoudnessTarget(LibMeta? m)
    {
        if (m == null || SceneLoudnessEntryOf(m, m.SceneLoudnessFp) is not { } e) return null;
        if (e.Live is { } l) return (l.Lufs, l.PeakDbfs, false);
        if (e.Estimate is { } est) return (est.Lufs, est.Lufs == null ? null : est.PeakDbfs, true);
        return null;
    }

    // LoudnessI/TP ← the current configuration's target: `jump` = exactly (a configuration change), else by the 0.5 LU
    // rule. A configuration with nothing (no estimate, never measured) leaves them as they are unless it's a jump
    // (another sound: nothing known = not normalized). Returns whether they changed.
    private static bool ApplySceneLoudness(LibMeta m, bool jump)
    {
        var t = SceneLoudnessTarget(m);
        double? lufs = t?.Lufs, peak = t?.Peak;
        if (t == null && !jump) return false;
        bool applied = false;
        if (jump)
        {
            applied = m.LoudnessI != lufs || m.LoudnessTP != peak;
            m.LoudnessI = lufs; m.LoudnessTP = peak;
            return applied;
        }
        if (lufs is not double nl) { applied = m.LoudnessI != null; m.LoudnessI = null; m.LoudnessTP = null; return applied; }
        if (m.LoudnessI is not double i || Math.Abs(nl - i) >= ApplyHysteresisLu) { m.LoudnessI = nl; applied = true; }
        if (m.LoudnessTP is not double tp ? peak != null : peak is not double np || Math.Abs(np - tp) >= ApplyHysteresisLu)
        {
            m.LoudnessTP = peak; applied = true;
        }
        return applied;
    }

    // Store a scene's loudness report in its index entry (a scene folder in the library only). Applied = the value
    // normalization uses moved (it should follow live — PlayerHelper.OnLoudnessMeasured).
    public static (bool Stored, bool Applied) StoreSceneLoudness(string scenePath, string? key, double lufs, double? peakDbfs,
        double seconds, bool complete, JsonElement? state = null)
    {
        // outside the library (Locate) or gone (trashed meanwhile): SetMeta writes nothing, `r` stays (false, false)
        if (!PlayerHelper.IsScenePath(scenePath)) return (false, false);
        (bool, bool) r = (false, false);
        LibraryStore.SetMeta(scenePath, m => r = MergeSceneLoudness(m, key, lufs, peakDbfs, seconds, complete, state));
        return r;
    }

    // The card's loudness line (LibraryItem.Loudness*, WS `library-item-changed`): the applied LUFS of the current
    // configuration, whether it's the estimate, the measured seconds, the estimate's confidence + its first note when low.
    public readonly record struct SceneLoudnessInfo(double? Lufs, bool? Estimated, double? Seconds, string? Confidence, string? Note);
    public static SceneLoudnessInfo SceneLoudnessInfoOf(LibMeta? m)
    {
        if (m == null) return default;
        var e = SceneLoudnessEntryOf(m, m.SceneLoudnessFp);
        var est = e?.Estimate;
        bool? estimated = e?.Live != null ? false : est?.Lufs != null ? true : m.LoudnessI != null ? false : null;
        string? note = est?.Confidence == "low" && est.Notes is { Length: > 0 } n ? n[0] : null;
        return new SceneLoudnessInfo(m.LoudnessI, estimated, e?.Live?.Seconds, est?.Confidence, note);
    }

    // What a source of the scene continues (`loudness_seed`), with the configuration it belongs to (`loudness_key`):
    // the current configuration's live measurement, else its estimate's seed (10 s of audible play); null = nothing.
    public static JsonElement? SceneLoudnessSeed(string scenePath) => SceneLoudnessSeedOf(LibraryStore.GetMeta(scenePath));
    public static JsonElement? SceneLoudnessSeedOf(LibMeta? m)
    {
        if (m == null || SceneLoudnessEntryOf(m, m.SceneLoudnessFp) is not { } e) return null;
        if (e.Live?.State is { ValueKind: JsonValueKind.Object } s) return s;
        if (e.Estimate?.Seed is { ValueKind: JsonValueKind.Object } seed) return seed;
        return null;
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> _measuring = new();

    // Measure once (if not cached) + store. Safe to fire-and-forget; de-dups concurrent calls per path.
    // Silent wallpapers (no audio stream) are marked LoudnessSkip so they're not re-probed every time.
    public static async System.Threading.Tasks.Task EnsureLoudnessAsync(string mediaPath)
    {
        var meta = LibraryStore.GetMeta(mediaPath);
        if (ReadLoudness(mediaPath) != null || meta?.LoudnessSkip == true) return;
        if (!_measuring.TryAdd(mediaPath, 0)) return; // already in flight
        try
        {
            if (!await HasAudioAsync(mediaPath).ConfigureAwait(false))
            {
                LibraryStore.SetMeta(mediaPath, m => m.LoudnessSkip = true); // no audio → never retry
                return;
            }
            var r = await MeasureLoudnessAsync(mediaPath).ConfigureAwait(false);
            if (r is { } v)
            {
                if (!double.IsFinite(v.I)) // silent track (-inf) → nothing to normalize, don't retry
                    LibraryStore.SetMeta(mediaPath, m => m.LoudnessSkip = true);
                else
                {
                    LibraryStore.SetMeta(mediaPath, m =>
                        { m.LoudnessI = v.I; m.LoudnessTP = v.TP; m.LoudnessLRA = v.LRA; m.LoudnessThresh = v.Thresh; });
                    PlayerHelper.OnLoudnessMeasured(mediaPath); // it may be playing un-normalized right now
                }
            }
        }
        finally { _measuring.TryRemove(mediaPath, out _); }
    }

    // Quick check for an audio stream (ffprobe). Assumes yes on any failure (don't wrongly skip).
    private static async System.Threading.Tasks.Task<bool> HasAudioAsync(string path)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("ffprobe")
            { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in new[] { "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path })
                psi.ArgumentList.Add(a);
            using var p = System.Diagnostics.Process.Start(psi);
            if (p == null) return true;
            string o = await p.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
            _ = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } return true; }
            return o.Contains("audio");
        }
        catch { return true; }
    }

    // ffmpeg loudnorm pass 1 → JSON on stderr; parse the input_* fields (the file's measured loudness).
    public static async System.Threading.Tasks.Task<Loudness?> MeasureLoudnessAsync(string mediaPath)
    {
        if (!File.Exists(mediaPath)) return null;
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("ffmpeg")
            {
                UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true,
            };
            // -vn → don't decode video (loudness is audio-only). ~4× faster on 4K clips (the old path
            // wastefully decoded full video frames just to measure the audio track).
            foreach (var a in new[] { "-hide_banner", "-nostdin", "-vn", "-i", mediaPath,
                "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-" })
                psi.ArgumentList.Add(a);
            using var p = System.Diagnostics.Process.Start(psi);
            if (p == null) return null;
            string err = await p.StandardError.ReadToEndAsync().ConfigureAwait(false);
            _ = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(120000)) { try { p.Kill(); } catch { } return null; }
            // the JSON block is the last {...} in stderr
            int s = err.LastIndexOf('{'), e = err.LastIndexOf('}');
            if (s < 0 || e <= s) return null;
            using var doc = JsonDocument.Parse(err.Substring(s, e - s + 1));
            double G(string k)
            {
                var str = doc.RootElement.GetProperty(k).GetString()!;
                if (str == "-inf") return double.NegativeInfinity; // silent audio track → loudnorm reports -inf
                if (str == "inf") return double.PositiveInfinity;
                return double.Parse(str, System.Globalization.CultureInfo.InvariantCulture);
            }
            return new Loudness(G("input_i"), G("input_tp"), G("input_lra"), G("input_thresh"));
        }
        catch { return null; }
    }

    private static int _backfilling = 0;
    private static long _lastBackfillKick;

    // Start the background backfill OFF the caller's thread (an `async` method runs synchronously up to
    // its first real await — with every item measured that was the whole scan, on `/settings`' request
    // thread). `force` = normalization was just switched on; otherwise at most once per 30 s (every
    // debounced slider save posts /settings) — still picks up items added while the app is open.
    public static void KickLoudnessBackfill(bool force)
    {
        long now = Environment.TickCount64, last = System.Threading.Interlocked.Read(ref _lastBackfillKick);
        if (!force && last != 0 && now - last < 30_000) return;
        System.Threading.Interlocked.Exchange(ref _lastBackfillKick, now);
        _ = System.Threading.Tasks.Task.Run(async () => { try { await BackfillLoudnessAsync().ConfigureAwait(false); } catch { } });
    }

    // Measure every un-measured library video in the background — one ffmpeg at a time (gentle), so
    // clips are ready before they play instead of being measured lazily on first play. Runs while the
    // app is open when NormalizeAudio is on. Idempotent (skips measured) + single-flight; stops early if
    // normalization is turned off mid-scan.
    // The scan reads each source's index ONCE (it used to parse the whole index.json twice per item,
    // plus settings.json per item — O(items × index size), ~0.3–0.5 s for a 300-item library, and
    // `/settings` ran it on its request thread on every save). EnsureLoudnessAsync re-reads an item's
    // entry before measuring, so a snapshot of the index is enough to decide what to skip.
    public static async System.Threading.Tasks.Task BackfillLoudnessAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref _backfilling, 1) == 1) return;
        try
        {
            using var sem = new System.Threading.SemaphoreSlim(3); // 3 ffmpegs at once — fast, still gentle
            var tasks = new List<System.Threading.Tasks.Task>();
            var indexes = new Dictionary<string, Dictionary<string, LibMeta>>();
            LibMeta? Meta(string path)
            {
                if (LibraryStore.Locate(path) is not { } loc) return null;
                if (!indexes.TryGetValue(loc.Source, out var idx)) indexes[loc.Source] = idx = LibraryStore.LoadIndex(loc.Source);
                return idx.GetValueOrDefault(loc.Key);
            }
            foreach (var item in LoadAll())
            {
                if (item.IsScene || !IsVideoFile(item.VideoPath)) continue;
                var meta = Meta(item.VideoPath);
                if (meta is { LoudnessI: not null, LoudnessTP: not null, LoudnessLRA: not null, LoudnessThresh: not null }
                    || meta?.LoudnessSkip == true) continue; // measured or no-audio
                if (!SettingsService.Load().NormalizeAudio) break; // turned off mid-scan (checked before real work only)
                var path = item.VideoPath;
                await sem.WaitAsync().ConfigureAwait(false);
                tasks.Add(System.Threading.Tasks.Task.Run(async () =>
                    { try { await EnsureLoudnessAsync(path).ConfigureAwait(false); } finally { sem.Release(); } }));
            }
            await System.Threading.Tasks.Task.WhenAll(tasks).ConfigureAwait(false);
        }
        catch { }
        finally { System.Threading.Interlocked.Exchange(ref _backfilling, 0); }
    }

    // ---------- LoadAll ----------
    public static List<LibraryItem> LoadAll()
    {
        var items = new List<LibraryItem>();
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return items;

        foreach (var source in LibraryStore.Sources)
        {
            var dir = LibraryStore.SourceDir(source);
            if (!Directory.Exists(dir)) continue;
            var idx = LibraryStore.LoadIndex(source);

            // Every item is a folder. SCENE = folder whose VideoPath IS the folder (no media file —
            // see PlayerHelper.IsScenePath); VIDEO/IMAGE = folder holding a media file. local/<id> is a
            // symlink, still a directory entry. Scene-ness: the index flag, else project.json type / scene.pkg.
            foreach (var itemDir in SafeDirs(dir))
            {
                var key = Path.GetFileName(itemDir);
                var m = idx.GetValueOrDefault(key);
                if ((m?.IsScene ?? false) || IsSceneFolder(itemDir))
                {
                    items.Add(Build(itemDir, key, m, isScene: true, assetDir: itemDir, workshopId: key,
                        copiedSceneDir: source == LibraryStore.Workshop ? itemDir : null));
                    continue;
                }
                var media = ResolveItemMedia(itemDir, key);
                if (media == null) continue;
                if (!File.Exists(media)) { if (m == null) TryDeleteDir(itemDir); continue; } // dangling symlink
                items.Add(Build(media, key, m, isScene: false, itemDir));
            }
        }
        return items;
    }

    // A workshop/local folder is a scene when project.json says type=scene (authoritative when present),
    // else when a compiled scene.pkg sits in it. Web/imported folders have neither → video/image.
    private static bool IsSceneFolder(string itemDir)
    {
        var pj = Path.Combine(itemDir, "project.json");
        if (File.Exists(pj))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                if (doc.RootElement.TryGetProperty("type", out var t))
                    return string.Equals(t.GetString(), "scene", StringComparison.OrdinalIgnoreCase);
            }
            catch { }
        }
        return File.Exists(Path.Combine(itemDir, "scene.pkg"));
    }

    // the playable media inside an item folder: web/imported = <key>.<videoext>|png; workshop/local = project.json "file"
    private static string? ResolveItemMedia(string itemDir, string key)
    {
        var pj = Path.Combine(itemDir, "project.json");
        if (File.Exists(pj))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                if (doc.RootElement.TryGetProperty("file", out var f) && f.GetString() is { Length: > 0 } file)
                    return Path.Combine(itemDir, file);
            }
            catch { }
        }
        foreach (var ext in VideoExts.Concat(new[] { ".png" }))
        {
            var p = Path.Combine(itemDir, key + ext);
            if (File.Exists(p)) return p;
        }
        // fall back to the first video file in the folder (workshop folder may name the file arbitrarily)
        return SafeFiles(itemDir, "*").FirstOrDefault(IsVideoFile);
    }

    private static LibraryItem Build(string media, string key, LibMeta? m, bool isScene,
        string? assetDir = null, string? workshopId = null, string? copiedSceneDir = null)
    {
        m ??= new LibMeta();
        string folder = assetDir ?? Path.GetDirectoryName(media) ?? "";
        DateTime added; try { var fi = new FileInfo(media); added = fi.CreationTime.Year <= 1970 ? fi.LastWriteTime : fi.CreationTime; } catch { added = DateTime.Now; }
        var loud = isScene || m.IsScene ? SceneLoudnessInfoOf(m) : default;
        return new LibraryItem
        {
            Title = m.Title ?? key,
            VideoPath = media,
            ThumbnailPath = FindThumb(folder, key),
            AnimatedThumbnailPath = FindAnimated(folder, key),
            SourceId = m.SourceUrl ?? m.WorkshopId ?? workshopId,
            IsScene = isScene || m.IsScene,
            WorkshopId = m.WorkshopId ?? workshopId,
            CopiedSceneDir = copiedSceneDir,
            HasCrashed = m.Crashed,
            IsWhitelisted = m.Whitelist,
            VolumeOverride = m.Volume,
            SpeedOverride = m.Speed,
            AddedAt = added,
            LoudnessLufs = loud.Lufs, LoudnessEstimated = loud.Estimated, LoudnessSeconds = loud.Seconds,
            LoudnessConfidence = loud.Confidence, LoudnessNote = loud.Note,
            Resolution = m.Resolution, AgeRating = m.AgeRating, YoutubeUrl = m.YoutubeUrl, PageUrl = m.PageUrl,
            AuthorName = m.AuthorName, Description = m.Description, FileSizeBytes = m.FileSizeBytes,
            Subscriptions = m.Subscriptions, Favorites = m.Favorites, Views = m.Views, Tags = m.Tags,
        };
    }

    // A scene item's preview image (its folder IS its play path) — liascape-player shows it while no frame exists.
    // Many WE scenes ship only a preview.gif (mpv shows that too).
    public static string? PreviewImageOf(string sceneDir)
    {
        if (string.IsNullOrEmpty(sceneDir)) return null;
        var key = Path.GetFileName(sceneDir.TrimEnd('/'));
        return FindThumb(sceneDir, key) ?? FindAnimated(sceneDir, key);
    }

    // thumbnail in an item folder: <key>.jpg (web/imported) or preview.* (workshop/local Steam folder)
    private static string? FindThumb(string folder, string key)
    {
        foreach (var name in new[] { key + ".jpg", key + ".jpeg", key + ".png", "preview.jpg", "preview.png", "preview.jpeg" })
        {
            var p = Path.Combine(folder, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    private static string? FindAnimated(string folder, string key)
    {
        foreach (var name in new[] { key + ".gif", key + ".webp", "preview.gif", "preview.webp" })
        {
            var p = Path.Combine(folder, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // ---------- WE auto-import → local/<id> ----------
    public static List<string> SyncWallpaperEngine(string workshopPath, bool allowScenes, bool copyFilesInsteadOfSymlinking)
    {
        var added = new List<string>();
        if (string.IsNullOrEmpty(workshopPath) || !Directory.Exists(workshopPath)) return added;
        var localDir = LibraryStore.SourceDir(LibraryStore.Local);
        Directory.CreateDirectory(localDir);
        var adds = new Dictionary<string, LibMeta>(); // applied under the index lock at the end
        var have = ExistingWorkshopIds();
        var blocked = WorkshopUnsubQueue.SnapshotBlockedSet();

        foreach (var dir in SafeDirs(workshopPath))
        {
            var id = Path.GetFileName(dir);
            if (have.Contains(id) || blocked.Contains(id)) continue;
            string? type = null, file = null, title = null;
            bool hasScenePkg = File.Exists(Path.Combine(dir, "scene.pkg"));
            var pj = Path.Combine(dir, "project.json");
            if (File.Exists(pj))
            {
                try { using var doc = JsonDocument.Parse(File.ReadAllText(pj)); var r = doc.RootElement;
                    type = r.TryGetProperty("type", out var t) ? t.GetString() : null;
                    file = r.TryGetProperty("file", out var f) ? f.GetString() : null;
                    title = r.TryGetProperty("title", out var ti) ? ti.GetString() : null; }
                catch { continue; }
            }
            else if (!hasScenePkg) continue;

            bool isVideo = string.Equals(type, "video", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(file);
            bool isScene = string.Equals(type, "scene", StringComparison.OrdinalIgnoreCase) || (type == null && hasScenePkg);

            if (isVideo)
            {
                if (!File.Exists(Path.Combine(dir, file!))) continue;
                var link = Path.Combine(localDir, id);
                try { if (!Directory.Exists(link) && !File.Exists(link)) File.CreateSymbolicLink(link, dir); } catch { continue; }
                adds[id] = new LibMeta { Title = SanitizeName(title) is { Length: > 0 } st ? st : id, WorkshopId = id };
                added.Add(Path.Combine(link, file!));
            }
            else if (isScene && allowScenes)
            {
                var link = Path.Combine(localDir, id);                          // local/<id> → WE dir; the folder IS the scene
                try { if (!Directory.Exists(link) && !File.Exists(link)) File.CreateSymbolicLink(link, dir); } catch { continue; }
                adds[id] = new LibMeta { Title = SanitizeName(title) is { Length: > 0 } st2 ? st2 : id, WorkshopId = id, IsScene = true };
                added.Add(link);
            }
        }
        if (adds.Count > 0)
            LibraryStore.UpdateIndex(LibraryStore.Local, idx => { foreach (var (id, m) in adds) idx[id] = m; return true; });
        return added;
    }

    // workshop/ + local/ folder names = the set of workshop IDs already present
    private static HashSet<string> ExistingWorkshopIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var src in new[] { LibraryStore.Workshop, LibraryStore.Local })
            foreach (var d in SafeDirs(LibraryStore.SourceDir(src)))
                ids.Add(Path.GetFileName(d));
        return ids;
    }

    // ---------- replace a direct-DL with the WE-dir copy when it appears ----------
    public static void ReconcileDirectDownloads(string workshopPath, bool copyFilesInsteadOfSymlinking)
    {
        if (string.IsNullOrEmpty(workshopPath) || !Directory.Exists(workshopPath)) return;
        var workshopLib = LibraryStore.SourceDir(LibraryStore.Workshop);
        if (!Directory.Exists(workshopLib)) return;
        var localDir = LibraryStore.SourceDir(LibraryStore.Local);
        Directory.CreateDirectory(localDir);
        var moved = new List<string>();
        foreach (var dir in SafeDirs(workshopLib).ToList())
        {
            var id = Path.GetFileName(dir);
            var weDir = Path.Combine(workshopPath, id);
            if (!Directory.Exists(weDir)) continue;            // the WE-dir copy hasn't appeared
            var link = Path.Combine(localDir, id);
            if (Directory.Exists(link) || File.Exists(link)) continue; // already represented under local/
            try
            {
                File.CreateSymbolicLink(link, weDir);          // local/<id> → WE dir (scene-ness rides in meta.IsScene)
                Directory.Delete(dir, recursive: true);        // drop the direct-DL copy (reclaim disk)
                moved.Add(id);
            }
            catch { try { if (File.Exists(link) || Directory.Exists(link)) File.Delete(link); } catch { } }
        }
        if (moved.Count == 0) return;
        // each moved entry (with its overrides as they are NOW) goes workshop → local under the index lock; local
        // is saved first, so a reader never finds the item in neither index
        LibraryStore.UpdateIndex(LibraryStore.Workshop, workshopIdx =>
        {
            var metas = moved.ToDictionary(id => id, id => workshopIdx.GetValueOrDefault(id) ?? new LibMeta { WorkshopId = id });
            LibraryStore.UpdateIndex(LibraryStore.Local, localIdx => { foreach (var (id, m) in metas) localIdx[id] = m; return true; });
            foreach (var id in moved) workshopIdx.Remove(id);
            return true;
        });
    }

    // ---------- trash / delete / restore ----------
    public static string TrashPath => Path.Combine(DownloadHelper.LibraryPath, ".trash");

    public static void Trash(LibraryItem item, string batchDir)
    {
        var loc = LibraryStore.Locate(item.VideoPath);
        if (loc == null) return;
        var dest = Path.Combine(batchDir, loc.Value.Source);
        Directory.CreateDirectory(dest);
        // move the item's folder (scene → the folder IS VideoPath; video → its parent); record the index
        // entry so Restore can replay it. Directory.Move on a local/ symlink moves the link, not its target.
        var assetDir = item.IsScene ? item.VideoPath : Path.GetDirectoryName(item.VideoPath)!;
        LibraryStore.UpdateIndex(loc.Value.Source, idx =>
        {
            if (!idx.TryGetValue(loc.Value.Key, out var meta)) return false;
            try { File.WriteAllText(Path.Combine(dest, loc.Value.Key + ".meta.json"),
                JsonSerializer.Serialize(new TrashedEntry(loc.Value.Source, loc.Value.Key, item.IsScene, meta))); } catch { }
            idx.Remove(loc.Value.Key);
            return true;
        });
        if (Directory.Exists(assetDir)) { try { Directory.Move(assetDir, Path.Combine(dest, loc.Value.Key)); } catch { } }
    }

    private sealed record TrashedEntry(string Source, string Key, bool IsScene, LibMeta Meta);

    public static void RestoreBatch(string batchDir)
    {
        if (!Directory.Exists(batchDir)) return;
        foreach (var sourceDir in Directory.GetDirectories(batchDir))
        {
            var source = Path.GetFileName(sourceDir);
            var restored = new Dictionary<string, LibMeta>(); // replayed under the index lock below
            var target = LibraryStore.SourceDir(source);
            Directory.CreateDirectory(target);
            foreach (var entryFile in SafeFiles(sourceDir, "*.meta.json"))
            {
                try
                {
                    var e = JsonSerializer.Deserialize<TrashedEntry>(File.ReadAllText(entryFile));
                    if (e == null) continue;
                    var folderSrc = Path.Combine(sourceDir, e.Key);            // scene + video both restore the folder
                    if (Directory.Exists(folderSrc) && !Directory.Exists(Path.Combine(target, e.Key)))
                        Directory.Move(folderSrc, Path.Combine(target, e.Key));
                    restored[e.Key] = e.Meta;
                }
                catch { }
            }
            if (restored.Count > 0)
                LibraryStore.UpdateIndex(source, idx => { foreach (var (k, m) in restored) idx[k] = m; return true; });
        }
        try { Directory.Delete(batchDir, recursive: true); } catch { }
    }

    public static void PurgeBatch(string batchDir) { try { Directory.Delete(batchDir, recursive: true); } catch { } }

    public static void CleanTrash()
    {
        if (!Directory.Exists(TrashPath)) return;
        foreach (var dir in Directory.GetDirectories(TrashPath)) PurgeBatch(dir);
    }

    public static void Delete(LibraryItem item)
    {
        var loc = LibraryStore.Locate(item.VideoPath);
        if (loc == null) return;
        // scene → the folder IS VideoPath; video → its parent. Directory.Delete unlinks a local/ symlink
        // without touching the WE target (verified on .NET 9: recursive delete of a symlinked dir unlinks).
        var assetDir = item.IsScene ? item.VideoPath : Path.GetDirectoryName(item.VideoPath)!;
        try { if (Directory.Exists(assetDir)) Directory.Delete(assetDir, recursive: true); } catch { }
        LibraryStore.Remove(item.VideoPath);
    }

    public static void DeleteAll()
    {
        if (!Directory.Exists(DownloadHelper.LibraryPath)) return;
        foreach (var source in LibraryStore.Sources)
        {
            var d = LibraryStore.SourceDir(source);
            try { if (Directory.Exists(d)) Directory.Delete(d, recursive: true); } catch { }
        }
    }

    // ---------- helpers (preserved) ----------
    private static IEnumerable<string> SafeDirs(string dir)
    { try { return Directory.GetDirectories(dir); } catch { return Array.Empty<string>(); } }
    private static IEnumerable<string> SafeFiles(string dir, string pat)
    { try { return Directory.GetFiles(dir, pat); } catch { return Array.Empty<string>(); } }
    private static void TryDeleteDir(string dir) { try { Directory.Delete(dir, recursive: true); } catch { } }

    internal static bool IsSymlink(string path)
    { try { return new FileInfo(path).LinkTarget != null || new DirectoryInfo(path).LinkTarget != null; } catch { return false; } }

    public static string SanitizeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string((name ?? "").Where(c => !invalid.Contains(c)).ToArray()).Trim();
    }

    internal static void CopyDirectory(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src)) File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src)) CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }

    // Extracts the numeric workshop item ID from a Steam community URL (?id=NNN / &id=NNN).
    public static string? ExtractSteamWorkshopId(string url)
    {
        int idx = url.IndexOf("?id=", StringComparison.Ordinal);
        if (idx < 0) idx = url.IndexOf("&id=", StringComparison.Ordinal);
        if (idx < 0) return null;
        int start = idx + 4, end = start;
        while (end < url.Length && char.IsDigit(url[end])) end++;
        var c = url.Substring(start, end - start);
        return c.Length >= 8 && long.TryParse(c, out _) ? c : null;
    }
}
