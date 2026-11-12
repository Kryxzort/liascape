using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Microsoft.AspNetCore.Http;

namespace Liascape.Web;

// The video preview clips (`GET /clip`): what "Animate wallpapers without a GIF" plays on every card on screen
// (app/ui/src/components/clipSource.ts). A full-size <video> per card can't: it keeps one of Chromium's 6 connections to
// the media origin while it plays and decodes 1080p-4K frames for a box a few hundred pixels wide
// (docs/decisions.md § "Play every on-screen video preview, each as a small clip").
//
// One clip per item, sized to the box it plays in and kept as long as the item is in the library:
//   - the width: the box's device pixels × the quality's factor (the UI sends them), as wide as an object-fit: cover of the
//     source's own shape needs (a 16:9 video in a square box needs 16/9 of the box's width), snapped up to WIDTHS so cards
//     share clips, never wider than the source. The clip keeps the source's shape: the card crops it, so a shape change
//     never re-encodes.
//   - full length up to CAP_SECONDS, made in the background one at a time (`nice -n 19 ionice -c3`), behind every short
//     clip. Until it exists, a SHORT_SECONDS stand-in plays (made at once on the request); the full clip replaces it.
//   - re-made for a box wider than the stored clip; a smaller box keeps the bigger clip (the browser downscales it). Shrunk
//     only when the stored one is 2x wider than needed (3-4x the bytes), only while the app is inactive (`POST
//     /clip/shrink`), never for a card on screen.
//   - always at exactly the quality Settings names, up AND down (a lower one frees its space): a change settles first, then
//     the sweep re-makes the whole library (§ the library follows "Video preview quality").
//   - a replaced file goes after GRACE, so a card still playing it can hand over to the new one first.
//   - deleted with its library item (trash, delete, clear) and at start-up when its source is gone; clips of items outside
//     the library (Browse's Wallpaper Engine folder) share a size-capped LRU (OUTSIDE_CAP).
// Every clip file is immutable under its name (`v`), which the UI puts in the <video> URL: a URL never changes content
// under Chromium's media cache. Guard: matrix clip:params, clip:size, clip:shortToFull, clip:hoverHandoff.
public static class ClipStore
{
    public const int SHORT_SECONDS = 10;
    // A cap, because a preview loops on screen the whole time: 5 min holds nearly every wallpaper whole (they loop in
    // 10 s - 3 min) at a bounded size; a longer video's clip is its first 5 min, a cut where the loop jumps back.
    public const int CAP_SECONDS = 300;
    private static readonly int[] WIDTHS = [240, 320, 480, 640, 960, 1280, 1920];
    // name, fps cap, x264 CRF: a higher one never looks worse than a lower one (an upgrade only goes up). TypicalMb: a full
    // clip's size on medium cards, measured over real wallpapers; Settings' card preview shows it until this store holds
    // clips of that quality to take the median of (`GET /clip/qualities`)
    private static readonly (string Name, int Fps, int Crf, double TypicalMb)[] QUALITY =
        [("low", 24, 31, 0.8), ("mid", 30, 27, 1.8), ("high", 60, 23, 4.5)];
    private static readonly long OUTSIDE_CAP = 1024L * 1024 * 1024;
    private static readonly TimeSpan GRACE = EnvMs("LIASCAPE_CLIP_GRACE_MS", 90_000);
    // the hermetic sweep test shortens the waits (scripts/test-clip-sweep.sh)
    private static TimeSpan EnvMs(string name, int ms) =>
        TimeSpan.FromMilliseconds(int.TryParse(Environment.GetEnvironmentVariable(name), NumberStyles.None, CultureInfo.InvariantCulture, out var v) && v > 0 ? v : ms);
    // a card asks again every few seconds while it waits for a better clip (clipSource.ts POLL_MS); a job nobody asked for
    // within this window belongs to cards that left the screen and is dropped
    private static readonly TimeSpan ASK_WINDOW = TimeSpan.FromSeconds(15);
    // Chromium's media loader reads ahead a few MB and then stops reading a response, keeping its connection; one capped
    // range per request lets that connection go back to the pool between reads (the media origin has 6)
    private const long CHUNK = 1L << 20;

    private static readonly Regex NameRe = new(@"^([0-9a-f]{24})_([0-9a-f]{8})_(\d{2,4})_([0-2])_(full|short)\.mp4$", RegexOptions.Compiled);
    private static readonly Regex RangeRe = new(@"^bytes=(\d{0,18})-(\d{0,18})$", RegexOptions.Compiled);

    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "liascape", "video_clips");

    private sealed record Clip(string Name, string Item, string Stamp, int W, int Q, bool Full, DateTime Mtime);
    private sealed record Src(int W, int H, double Dur);

    public static int ParseQuality(string? q) => q switch { "low" => 0, "mid" => 1, "high" => 2, _ => -1 };

    private static string Hex(string s, int n) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..n].ToLowerInvariant();
    private static string ItemId(string path) => Hex(path, 24);
    private static string StampOf(FileInfo fi) => Hex($"{fi.LastWriteTimeUtc.Ticks}|{fi.Length}", 8);

    private static Clip? Parse(string file)
    {
        var name = Path.GetFileName(file);
        var m = NameRe.Match(name);
        if (!m.Success) return null;
        DateTime mt; try { mt = File.GetLastWriteTimeUtc(file); } catch { mt = default; }
        return new(name, m.Groups[1].Value, m.Groups[2].Value, int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture),
            int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture), m.Groups[5].Value == "full", mt);
    }
    private static List<Clip> ClipsOf(string item)
    {
        try { return Directory.GetFiles(Dir, item + "_*.mp4").Select(Parse).OfType<Clip>().ToList(); } catch { return []; }
    }
    private static string SrcFile(string item) => Path.Combine(Dir, item + ".src");
    private static void WriteSrc(string item, string path)
    {
        var f = SrcFile(item);
        try { if (!File.Exists(f) || File.ReadAllText(f) != path) AtomicFile.WriteAllText(f, path); } catch { }
    }
    private static string? ReadSrc(string item) { try { return File.ReadAllText(SrcFile(item)); } catch { return null; } }
    private static void Delete(string name) { try { File.Delete(Path.Combine(Dir, name)); } catch { } }

    // ---- the source: its size and length, probed once per version of the file -----------------------------------------
    private static readonly ConcurrentDictionary<string, Src?> _probed = new();
    private static Src? Probe(string path, string stamp) => _probed.GetOrAdd(path + "|" + stamp, _ =>
    {
        try
        {
            var psi = new ProcessStartInfo("ffprobe") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            foreach (var a in new[] { "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path })
                psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var errTask = p.StandardError.ReadToEndAsync();
            var outTask = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(20000)) { try { p.Kill(true); } catch { } return null; }
            using var j = JsonDocument.Parse(outTask.GetAwaiter().GetResult());
            var s = j.RootElement.GetProperty("streams")[0];
            double dur = 0;
            if (j.RootElement.TryGetProperty("format", out var f) && f.TryGetProperty("duration", out var d))
                double.TryParse(d.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out dur);
            int w = s.GetProperty("width").GetInt32(), h = s.GetProperty("height").GetInt32();
            return w > 0 && h > 0 ? new Src(w, h, dur) : null;
        }
        catch { return null; }
    });

    // the clip width a box of boxW × boxH device pixels needs (object-fit: cover of the source's shape), snapped up to WIDTHS,
    // never wider than the source
    private static int TargetWidth(Src s, int boxW, int boxH)
        => SnapUp(s, Math.Max(boxW, boxH * (double)s.W / s.H));
    private static int SnapNear(Src s, double need)
    {
        int b = WIDTHS.OrderBy(x => Math.Abs(Math.Log(x / need))).First();
        return Math.Max(2, Math.Min(b, s.W & ~1));
    }
    private static int SnapUp(Src s, double need)
    {
        int b = WIDTHS.FirstOrDefault(x => x >= need);
        if (b == 0) b = WIDTHS[^1];
        return Math.Max(2, Math.Min(b, s.W & ~1));
    }

    // ---- GET /clip ------------------------------------------------------------------------------------------------------
    //   ?path=&w=&h=&q=&info=1  →  {v, full, pending, q}: the clip to play now for a box of w × h device pixels at quality q
    //                              (low|mid|high); queues a better one when needed (pending: a newer clip is coming, ask again)
    //        &exact=1           →  a clip of exactly quality q (Settings' card preview shows the chosen quality, not the
    //                              better clip the library keeps): the stored full one when it is that quality, else a
    //                              SHORT_SECONDS sample made on the request, in seconds; the full clip still queues as above
    //   ?path=&v=               →  that clip's bytes (one capped range per request)
    //   ?path=                  →  the bytes of the clip a mid-quality 320 px box would get (older pages, curl)
    // Every parameter is checked here; only numbers from these tables reach ffmpeg's arguments.
    public static async Task<IResult> Handle(HttpContext ctx, string? path)
    {
        if (!ApiSecurity.MediaAllowed(path)) return Results.Json(new { error = "not a library path" }, statusCode: 403);
        if (!File.Exists(path)) return Results.NotFound();
        var qs = ctx.Request.Query;
        string? v = qs["v"].FirstOrDefault();
        if (v != null)
        {
            var c = Parse(v + ".mp4");
            if (c == null || c.Item != ItemId(path!)) return Results.Json(new { error = "bad clip id" }, statusCode: 400);
            var file = Path.Combine(Dir, c.Name);
            if (!File.Exists(file)) return Results.NotFound();
            Touch(file);
            return Bytes(ctx.Request, file);
        }
        bool info = qs["info"].FirstOrDefault() == "1";
        int w = 320, h = 320, q = 1;
        if (info || qs.ContainsKey("w") || qs.ContainsKey("h") || qs.ContainsKey("q"))
        {
            if (!int.TryParse(qs["w"].FirstOrDefault(), NumberStyles.None, CultureInfo.InvariantCulture, out w)
                || !int.TryParse(qs["h"].FirstOrDefault(), NumberStyles.None, CultureInfo.InvariantCulture, out h))
                return Results.Json(new { error = "w and h: the box in device pixels" }, statusCode: 400);
            q = ParseQuality(qs["q"].FirstOrDefault());
            if (q < 0) return Results.Json(new { error = "q: low, mid or high" }, statusCode: 400);
            w = Math.Clamp(w, 16, 8192); h = Math.Clamp(h, 16, 8192);
        }
        var r = await Info(path!, w, h, q, qs["exact"].FirstOrDefault() == "1");
        // q: the quality the named clip was made at (a higher one than asked can serve; a lower one while pending is being raised)
        if (info) return Results.Json(new { v = r.V, full = r.Full, pending = r.Pending, q = r.V == null ? null : QUALITY[r.Q].Name });
        if (r.V == null) return Results.StatusCode(502);
        var f2 = Path.Combine(Dir, r.V + ".mp4");
        return File.Exists(f2) ? Bytes(ctx.Request, f2) : Results.StatusCode(502);
    }

    private static void Touch(string file) { try { File.SetLastAccessTimeUtc(file, DateTime.UtcNow); } catch { } }

    private sealed record InfoResult(string? V, bool Full, bool Pending, int Q = 0);
    private static async Task<InfoResult> Info(string path, int boxW, int boxH, int q, bool exact)
    {
        Directory.CreateDirectory(Dir);
        var fi = new FileInfo(path);
        string item = ItemId(path), stamp = StampOf(fi);
        var src = await Task.Run(() => Probe(path, stamp));
        if (src == null) return new(null, false, false);
        WriteSrc(item, path);
        int want = TargetWidth(src, boxW, boxH);
        var mine = ClipsOf(item).Where(c => c.Stamp == stamp).ToList();
        var full = Best(mine.Where(c => c.Full));
        if (exact)
        {
            // the library's own clip follows the setting through the sweep, never through this preview: until it is re-made
            // the preview plays a sample of exactly q. Its box (the preview's) never sizes the library's clip: want 0 =
            // carry the stored width over. A first full clip queues as for a card.
            if (full == null || (full.Q == q && full.W < want)) Enqueue(path, item, Math.Max(want, full?.W ?? 0), q);
            bool coming = full != null && full.Q != q && SweepAsk(path, item, 0, q);
            if (full != null && full.Q == q && full.W >= want) return new(Stem(full), true, Queued(item), q);
            var sample = Best(mine.Where(c => !c.Full && c.Q == q && c.W >= want)) ?? await MakeNow(path, item, stamp, want, q, full: false);
            // pending: a full clip of this quality is on its way (the queue or the sweep)
            return new(sample == null ? null : Stem(sample), false, Queued(item) || coming, sample?.Q ?? q);
        }
        if (full != null)
        {
            if (full.Q == q)
            {
                if (full.W < want) Enqueue(path, item, want, q);
                return new(Stem(full), true, Queued(item), q);
            }
            // another quality than the stored clip's: the sweep re-makes it (after the change settles; this card first while
            // it keeps asking). Meanwhile the stored clip plays on.
            bool coming = SweepAsk(path, item, want, q);
            // a page asking for a quality nobody set (an old tab): a wider box still gets more, at the stored clip's quality
            if (!coming && full.W < want) Enqueue(path, item, want, full.Q);
            return new(Stem(full), true, coming || Queued(item), full.Q);
        }
        // a video no longer than the stand-in: its full clip is as quick to make as one
        if (src.Dur > 0 && src.Dur <= SHORT_SECONDS + 0.5)
        {
            var made = await MakeNow(path, item, stamp, want, q, full: true);
            return new(made == null ? null : Stem(made), made != null, false, made?.Q ?? 0);
        }
        Enqueue(path, item, want, q);
        var stand = Best(mine.Where(c => !c.Full)) ?? await MakeNow(path, item, stamp, want, q, full: false);
        return new(stand == null ? null : Stem(stand), false, Queued(item), stand?.Q ?? 0);
    }

    // ---- GET /clip/qualities: what each quality costs, for Settings' card preview caption -------------------------------
    // fps: the encoder's cap; mb: the median full clip of that quality in this store (`measured`), else TypicalMb
    public sealed record QualityInfo(string Name, int Fps, double Mb, bool Measured);
    public static List<QualityInfo> Qualities()
    {
        var sizes = new List<long>[QUALITY.Length];
        for (int i = 0; i < sizes.Length; i++) sizes[i] = [];
        try
        {
            foreach (var f in Directory.EnumerateFiles(Dir, "*_full.mp4"))
                if (Parse(f) is { } c && c.Q < sizes.Length) try { sizes[c.Q].Add(new FileInfo(f).Length); } catch { }
        }
        catch { }
        return QUALITY.Select((x, i) =>
        {
            var s = sizes[i];
            if (s.Count == 0) return new QualityInfo(x.Name, x.Fps, x.TypicalMb, false);
            s.Sort();
            return new QualityInfo(x.Name, x.Fps, Math.Round(s[s.Count / 2] / 1048576.0, 2), true);
        }).ToList();
    }
    private static Clip? Best(IEnumerable<Clip> cs) => cs.OrderByDescending(c => c.Mtime).FirstOrDefault();
    private static string Stem(Clip c) => Path.GetFileNameWithoutExtension(c.Name);
    private static string NameFor(string item, string stamp, int w, int q, bool full) => $"{item}_{stamp}_{w}_{q}_{(full ? "full" : "short")}.mp4";

    // ---- encoding ---------------------------------------------------------------------------------------------------------
    private static List<string> Args(string src, string dst, int seconds, int w, int q)
    {
        var (_, fps, crf, _) = QUALITY[q];
        var ci = CultureInfo.InvariantCulture;
        return ["-nostdin", "-hide_banner", "-loglevel", "error", "-t", seconds.ToString(ci), "-i", src,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", $"scale={w.ToString(ci)}:-2",
            // -fpsmax caps a faster source without padding a slower one with duplicate frames (each one still a decode)
            "-fpsmax", fps.ToString(ci), "-c:v", "libx264", "-preset", "veryfast", "-crf", crf.ToString(ci),
            // a keyframe every 4 s: a hand-over seeks into the clip mid-play (clipSource.ts), and a seek decodes from the last one
            "-g", (fps * 4).ToString(ci), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", dst, "-y"];
    }

    // one ffmpeg; true when it wrote a non-empty file. `background`: under nice 19 + idle I/O (the full clips); else below
    // normal priority (the stand-ins a card waits for). Killed at `timeout` or on `ct`.
    private static bool Encode(List<string> args, string dst, bool background, TimeSpan timeout, CancellationToken ct, Action<Process>? started = null)
    {
        var psi = new ProcessStartInfo(background ? "nice" : "ffmpeg") { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
        if (background) foreach (var a in new[] { "-n", "19", "ionice", "-c3", "ffmpeg" }) psi.ArgumentList.Add(a);
        foreach (var a in args) psi.ArgumentList.Add(a);
        Process p;
        try { p = Process.Start(psi)!; } catch { return false; }
        using (p)
        {
            started?.Invoke(p);
            if (!background) try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
            // drain both pipes: a full stderr buffer blocks the child
            var e = p.StandardError.ReadToEndAsync();
            var o = p.StandardOutput.ReadToEndAsync();
            using var reg = ct.Register(() => { try { p.Kill(true); } catch { } });
            if (!p.WaitForExit((int)timeout.TotalMilliseconds)) { try { p.Kill(true); } catch { } p.WaitForExit(5000); return false; }
            try { Task.WaitAll([e, o], 5000); } catch { }
            if (p.ExitCode != 0) return false;
        }
        try { return new FileInfo(dst).Length > 0; } catch { return false; }
    }

    // stand-ins (and the full clip of a video no longer than one) are made on the request: a card waits for them. A cap of
    // a quarter of the cores (2–4): x264 already threads each encode — measured on 24 cores, 8 stand-ins (10 s, 480 px):
    // 1 at a time 3.0 s, 2 2.1 s, 4 1.9 s, 6 2.0 s, 8 1.9 s; more at once only adds CPU contention
    private static readonly SemaphoreSlim _nowGate = new(Math.Clamp(Environment.ProcessorCount / 4, 2, 4));
    private static int _nowInFlight;
    private static readonly ConcurrentDictionary<string, Task<Clip?>> _making = new();
    private static Task<Clip?> MakeNow(string path, string item, string stamp, int w, int q, bool full)
    {
        var name = NameFor(item, stamp, w, q, full);
        return _making.GetOrAdd(name, _ => Task.Run(async () =>
        {
            Interlocked.Increment(ref _nowInFlight);
            await _nowGate.WaitAsync();
            try
            {
                var dst = Path.Combine(Dir, name);
                if (!File.Exists(dst))
                {
                    var tmp = dst + ".tmp";
                    // PERF: a scroll onto new cards makes several at once; below normal priority they yield to the UI's frames
                    if (Encode(Args(path, tmp, full ? CAP_SECONDS : SHORT_SECONDS, w, q), tmp, false, TimeSpan.FromSeconds(60), CancellationToken.None))
                        File.Move(tmp, dst, true);
                    else try { File.Delete(tmp); } catch { }
                }
                if (!File.Exists(dst)) return null;
                if (full) Superseded(item, name);
                PruneOutside();
                return Parse(dst);
            }
            finally { _nowGate.Release(); Interlocked.Decrement(ref _nowInFlight); _making.TryRemove(name, out Task<Clip?>? _); }
        }));
    }

    // ---- the background queue: full clips, upgrades, shrinks — one at a time ---------------------------------------------
    // One: x264 threads each encode (one 10 s, 480 px clip alone: ~0.38 s; two at once finish 8 in 2.1 s, not 1.5), so a
    // second worker would mostly take cores from the stand-ins a card is waiting for.
    private sealed class Job
    {
        public required string Path, Item;
        public int W, Q;
        public DateTime Asked;
        public bool Shrink;
        // the sweep's (W 0 = the stored clip's width carried over to Q's factor), of sweep generation Gen
        public bool Sweep;
        public int Gen;
    }
    private static readonly object _lock = new();
    private static readonly Dictionary<string, Job> _jobs = new();
    private static readonly Dictionary<string, DateTime> _failed = new(); // item|stamp|w|q → when: not retried for an hour
    private static Job? _running;
    private static CancellationTokenSource? _runningCts;
    private static bool _idle;
    private static readonly SemaphoreSlim _wake = new(0);
    private static Task? _worker;

    private static bool Queued(string item) { lock (_lock) return (_jobs.TryGetValue(item, out var j) && !j.Shrink) || (_running is { Shrink: false } r && r.Item == item); }

    private static void Enqueue(string path, string item, int w, int q)
    {
        lock (_lock)
        {
            if (_running is { Shrink: false } r && r.Item == item && r.W >= w && r.Q >= q) { r.Asked = DateTime.UtcNow; return; }
            if (_failed.TryGetValue($"{item}|{w}|{q}", out var at) && DateTime.UtcNow - at < TimeSpan.FromHours(1)) return;
            if (_jobs.TryGetValue(item, out var j) && !j.Shrink) { j.W = Math.Max(j.W, w); j.Q = Math.Max(j.Q, q); j.Asked = DateTime.UtcNow; }
            else _jobs[item] = new Job { Path = path, Item = item, W = w, Q = q, Asked = DateTime.UtcNow };
            _worker ??= Task.Run(Work);
        }
        _wake.Release();
    }

    // POST /clip/shrink: the app went inactive (`idle`) with these boxes last seen off screen, or came back (`idle` false:
    // the queued shrinks go and a running one is stopped)
    public sealed record ShrinkItem(string Path, int W, int H, string Q);
    public static void SetIdle(bool idle, IEnumerable<ShrinkItem> items)
    {
        lock (_lock)
        {
            _idle = idle;
            foreach (var k in _jobs.Where(kv => kv.Value.Shrink).Select(kv => kv.Key).ToList()) _jobs.Remove(k);
            if (!idle) { if (_running is { Shrink: true }) _runningCts?.Cancel(); return; }
        }
        foreach (var it in items.Take(2000))
        {
            int q = ParseQuality(it.Q);
            if (q < 0 || !ApiSecurity.MediaAllowed(it.Path) || !File.Exists(it.Path)) continue;
            var fi = new FileInfo(it.Path);
            string item = ItemId(it.Path), stamp = StampOf(fi);
            var full = Best(ClipsOf(item).Where(c => c.Full && c.Stamp == stamp));
            var src = full == null ? null : Probe(it.Path, stamp);
            if (full == null || src == null) continue;
            int want = TargetWidth(src, Math.Clamp(it.W, 16, 8192), Math.Clamp(it.H, 16, 8192));
            if (full.W < 2 * want) continue;
            lock (_lock)
            {
                if (_jobs.ContainsKey(item) || _running?.Item == item) continue;
                _jobs[item] = new Job { Path = it.Path, Item = item, W = want, Q = q, Asked = DateTime.UtcNow, Shrink = true };
                _worker ??= Task.Run(Work);
            }
        }
        _wake.Release();
    }

    private static Job? Pick()
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            foreach (var k in _jobs.Where(kv => !kv.Value.Shrink && now - kv.Value.Asked > ASK_WINDOW).Select(kv => kv.Key).ToList()) _jobs.Remove(k);
            // the card asked for most recently first: the one the user is looking at now; then the sweep; shrinks last
            var j = _jobs.Values.Where(x => !x.Shrink).OrderByDescending(x => x.Asked).FirstOrDefault()
                    ?? NextSweep(now)
                    ?? (_idle ? _jobs.Values.FirstOrDefault(x => x.Shrink) : null);
            if (j == null) return null;
            if (!j.Sweep) _jobs.Remove(j.Item);
            _running = j;
            _runningCts = new CancellationTokenSource();
            return j;
        }
    }

    private static async Task Work()
    {
        while (true)
        {
            await _wake.WaitAsync(TimeSpan.FromSeconds(10));
            while (true)
            {
                // behind every stand-in: a card on screen waits for those
                while (Volatile.Read(ref _nowInFlight) > 0) await Task.Delay(200);
                var j = Pick();
                if (j == null) break;
                try { Run(j, _runningCts!.Token); }
                catch (Exception e) { Console.WriteLine($"clips: {e.GetType().Name}: {e.Message}"); }
                finally
                {
                    lock (_lock)
                    {
                        _running = null; _runningCts?.Dispose(); _runningCts = null;
                        // one more done of this sweep (made, already right, gone or failed); a re-targeted one's doesn't count
                        if (j.Sweep) { if (j.Gen == _gen) _swDone++; ReportLocked(); }
                    }
                }
            }
        }
    }

    private static void Run(Job j, CancellationToken ct)
    {
        var fi = new FileInfo(j.Path);
        if (!fi.Exists) return;
        var stamp = StampOf(fi);
        var src = Probe(j.Path, stamp);
        if (src == null) return;
        var stored = Best(ClipsOf(j.Item).Where(c => c.Full && c.Stamp == stamp));
        int w;
        if (j.Sweep)
        {
            // nothing to follow: gone, or made at this quality meanwhile (a card's own job)
            if (stored == null || stored.Q == j.Q) return;
            // as wide as the cards that asked need, else the stored width carried over to the new quality's factor, to the
            // nearest of WIDTHS: snapping up would ratchet (Low 320 → Mid 480 → High 960 → Low 480); a card that needs more
            // asks for it (Info)
            w = j.W > 0 ? Math.Min(j.W, src.W & ~1) : SnapNear(src, stored.W * FACTOR[j.Q] / FACTOR[stored.Q]);
        }
        else
        {
            w = Math.Min(j.W, src.W & ~1);
            if (j.Shrink ? stored == null || stored.W < 2 * w : stored != null && stored.W >= w && stored.Q >= j.Q) return;
        }
        var name = NameFor(j.Item, stamp, w, j.Q, true);
        var dst = Path.Combine(Dir, name);
        var tmp = dst + ".tmp";
        var t0 = Stopwatch.StartNew();
        // a 5 min clip from a 4K source takes about a minute niced on an idle machine; past this something is wrong
        if (Encode(Args(j.Path, tmp, CAP_SECONDS, w, j.Q), tmp, true, TimeSpan.FromMinutes(20), ct))
        {
            File.Move(tmp, dst, true);
            WriteSrc(j.Item, j.Path);
            Console.WriteLine($"clips: {(j.Shrink ? "shrank" : j.Sweep ? "re-made" : "made")} {w} px {QUALITY[j.Q].Name} ({new FileInfo(dst).Length / 1024} KB, {t0.Elapsed.TotalSeconds:0.0} s) for {Path.GetFileName(j.Path)}");
            Superseded(j.Item, name);
            PruneOutside();
        }
        else
        {
            try { File.Delete(tmp); } catch { }
            if (!ct.IsCancellationRequested) lock (_lock) _failed[j.Sweep ? $"{j.Item}|sweep|{j.Q}" : $"{j.Item}|{j.W}|{j.Q}"] = DateTime.UtcNow;
            else if (j.Sweep) Console.WriteLine($"clips: stopped re-making {Path.GetFileName(j.Path)} at {QUALITY[j.Q].Name}");
        }
    }

    // `keep` is the item's clip now: every other file of the item goes after GRACE (a card still playing one hands over to
    // the new clip first — clipSource.ts asks again every few seconds)
    private static void Superseded(string item, string keep)
    {
        var old = ClipsOf(item).Select(c => c.Name).Where(n => n != keep).ToList();
        if (old.Count == 0) return;
        _ = Task.Delay(GRACE).ContinueWith(_ => { foreach (var n in old) Delete(n); });
    }

    // ---- the library follows "Video preview quality" ---------------------------------------------------------------------
    // A user who picks Low wants the disk and decode savings, one who picks High the better picture, so a change reaches every
    // clip of the library, up and down (docs/decisions.md § "Play every on-screen video preview, each as a small clip"):
    //   - it settles for SETTLE first: flipping through Low / Mid / High starts nothing; each change restarts the wait.
    //   - and waits while the UI holds it (HoldSweep: the Settings tab is showing, where the choice is still being made);
    //     leaving Settings releases it (RELEASE later). The hold is a lease (HOLD_LEASE, renewed by the UI), so a closed or
    //     crashed window can't keep the library at the old quality.
    //   - then the sweep re-makes, on the background queue above (one at a time, nice 19 / idle I/O, behind every stand-in
    //     and every card's own job), each library item whose full clip is another quality: first the items a card asked
    //     about within ASK_WINDOW (a card on screen keeps asking while `pending`, clipSource.ts: that is the UI saying what
    //     is visible), the latest first; then the rest, the most recently played first.
    //   - the old clip goes GRACE after the new one exists (Superseded); the wallpaper's own file is only ever read.
    //   - a newer change re-targets it: a running encode of another quality is killed, the list is taken again.
    //   - a restart resumes it: the clips on disk are its state (ResumeSweep reads the setting and settles).
    // Progress: LibraryOps "clips" (the top bar's line). Guard: scripts/test-clip-sweep.sh; matrix clip:size.
    private static readonly double[] FACTOR = [0.75, 1, 1.5]; // the box factor of each quality: clipSource.ts QUALITY_FACTOR
    private static readonly TimeSpan SETTLE = EnvMs("LIASCAPE_CLIP_SETTLE_MS", 4000);
    private static readonly TimeSpan RELEASE = EnvMs("LIASCAPE_CLIP_RELEASE_MS", 1000);
    private static readonly TimeSpan HOLD_LEASE = EnvMs("LIASCAPE_CLIP_HOLD_MS", 60000);
    private static DateTime _holdUntil;
    private static int _target = -1, _pendingQ = -1, _gen, _swDone, _swTotal, _armSeq;
    private static bool _settling;
    private static DateTime _checkedAt;
    private static readonly List<(string Item, string Path)> _todo = new();
    private static readonly Dictionary<string, (string Path, int W, DateTime Asked)> _seen = new();
    private static Timer? _settleTimer;
    private static readonly object _settleRun = new();

    // POST /settings changed it (cheap: the work runs once it settles)
    public static void QualityChanged(string quality)
    {
        int q = ParseQuality(quality);
        if (q < 0) return;
        lock (_lock) { _pendingQ = q; ArmSettle(); }
    }
    // POST /clip/sweep-hold: the Settings tab shows (renewed while it does) or was left
    public static void HoldSweep(bool hold)
    {
        lock (_lock)
        {
            _holdUntil = hold ? DateTime.UtcNow + HOLD_LEASE : default;
            if (!hold && _settling) _settleTimer?.Change(RELEASE, Timeout.InfiniteTimeSpan);
        }
    }
    // at start-up: whatever a sweep left undone before the restart
    public static void ResumeSweep()
    {
        try { QualityChanged(SettingsService.Load().VideoPreviewQuality); } catch (Exception e) { Console.WriteLine($"clips: can't read the quality: {e.Message}"); }
    }
    private static void ArmSettle()
    {
        _settling = true;
        _armSeq++;
        _settleTimer ??= new Timer(_ => { try { Settle(); } catch (Exception e) { Console.WriteLine($"clips: sweep failed: {e.Message}"); } });
        _settleTimer.Change(SETTLE, Timeout.InfiniteTimeSpan);
    }

    // a card asks for quality q while its item's full clip is another one: true when the sweep is heading for q (the item
    // is in its list, and first while the card keeps asking). `want` 0: the asker's box doesn't size the clip.
    private static bool SweepAsk(string path, string item, int want, int q)
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            if (_settling ? q != _pendingQ : q != _target)
            {
                // the setting may have changed without POST /settings (another process wrote it): look, at most twice a minute
                if (!_settling && now - _checkedAt > TimeSpan.FromSeconds(30))
                {
                    _checkedAt = now;
                    _ = Task.Run(() => { try { var s = ParseQuality(SettingsService.Load().VideoPreviewQuality); if (s >= 0 && s != Volatile.Read(ref _target)) QualityChanged(QUALITY[s].Name); } catch { } });
                }
                return false;
            }
            _seen[item] = _seen.TryGetValue(item, out var s0) && now - s0.Asked < ASK_WINDOW ? (path, Math.Max(s0.W, want), now) : (path, want, now);
            // an item the list doesn't hold (its clip made at another quality since, an item outside the library on screen)
            if (!_settling && !_todo.Any(t => t.Item == item) && !(_running is { Sweep: true } r && r.Item == item))
            {
                if (_failed.TryGetValue($"{item}|sweep|{q}", out var at) && now - at < TimeSpan.FromHours(1)) return false;
                _todo.Add((item, path)); _swTotal++;
                ReportLocked();
                _worker ??= Task.Run(Work);
                _wake.Release();
            }
            return true;
        }
    }

    private static Job? NextSweep(DateTime now)
    {
        if (_settling || _todo.Count == 0 || _target < 0) return null;
        foreach (var k in _seen.Where(kv => now - kv.Value.Asked > ASK_WINDOW).Select(kv => kv.Key).ToList()) _seen.Remove(k);
        // what a card asked about lately, the latest first: it's on screen
        int at = 0; DateTime latest = default;
        for (int i = 0; i < _todo.Count; i++)
            if (_seen.TryGetValue(_todo[i].Item, out var s) && s.Asked > latest) { latest = s.Asked; at = i; }
        var (item, path) = _todo[at];
        _todo.RemoveAt(at);
        int w = _seen.TryGetValue(item, out var seen) ? seen.W : 0;
        return new Job { Path = path, Item = item, W = w, Q = _target, Asked = now, Sweep = true, Gen = _gen };
    }

    private static void Settle()
    {
        lock (_settleRun)
        {
            int seq, q;
            lock (_lock)
            {
                // held: look again when the lease runs out (a release re-arms it sooner)
                var left = _holdUntil - DateTime.UtcNow;
                if (left > TimeSpan.Zero) { _settleTimer?.Change(left + TimeSpan.FromMilliseconds(50), Timeout.InfiniteTimeSpan); return; }
                seq = _armSeq;
            }
            try { q = ParseQuality(SettingsService.Load().VideoPreviewQuality); } catch { q = -1; }
            if (q < 0) lock (_lock) q = _pendingQ >= 0 ? _pendingQ : 1;
            bool same;
            lock (_lock) same = q == _target;
            var todo = same ? null : Mismatched(q);
            lock (_lock)
            {
                // a change that landed meanwhile settles again (its timer is armed)
                if (seq == _armSeq) { _settling = false; _pendingQ = -1; }
                if (todo != null)
                {
                    bool first = _target < 0;
                    _target = q; _gen++;
                    _todo.Clear(); _todo.AddRange(todo);
                    _swDone = 0; _swTotal = todo.Count;
                    // what the queue would make at another quality: nobody asks for it any more
                    foreach (var k in _jobs.Where(kv => !kv.Value.Shrink && kv.Value.Q != q).Select(kv => kv.Key).ToList()) _jobs.Remove(k);
                    if (_running is { Shrink: false } r && r.Q != q)
                    {
                        Console.WriteLine($"clips: stopping a {QUALITY[r.Q].Name} encode of {System.IO.Path.GetFileName(r.Path)}");
                        _runningCts?.Cancel();
                    }
                    if (!first || todo.Count > 0) Console.WriteLine($"clips: the library follows {QUALITY[q].Name}: {todo.Count} clip(s) to re-make");
                    ReportLocked();
                }
                _worker ??= Task.Run(Work);
            }
            _wake.Release();
        }
    }

    // the library items whose full clip is another quality than q, the most recently played first
    private static List<(string Item, string Path)> Mismatched(int q)
    {
        var lib = DownloadHelper.LibraryPath.TrimEnd('/') + "/";
        var byItem = SafeFiles("*_full.mp4").Select(Parse).OfType<Clip>().GroupBy(c => c.Item).ToDictionary(g => g.Key, g => g.ToList());
        var list = new List<(string Item, string Path, DateTime Used)>();
        foreach (var (item, clips) in byItem)
        {
            if (ReadSrc(item) is not { } path || !path.StartsWith(lib, StringComparison.Ordinal)) continue;
            var fi = new FileInfo(path);
            if (!fi.Exists) continue;
            var stamp = StampOf(fi);
            var full = Best(clips.Where(c => c.Stamp == stamp));
            if (full == null || full.Q == q) continue;
            DateTime used; try { used = File.GetLastAccessTimeUtc(Path.Combine(Dir, full.Name)); } catch { used = default; }
            list.Add((item, path, used));
        }
        return list.OrderByDescending(x => x.Used).Select(x => (x.Item, x.Path)).ToList();
    }

    // the top bar's line: this sweep's count while it runs; gone once its list is empty and nothing of it is running
    private static void ReportLocked()
    {
        if (_todo.Count == 0 && _running is not { Sweep: true }) LibraryOps.End("clips");
        else if (_target >= 0) LibraryOps.Set("clips", QUALITY[_target].Name, _swDone, Math.Max(_swTotal, _swDone));
    }

    // ---- removal: with the library item, and the start-up sweep ----------------------------------------------------------
    // every clip whose source lies at or under `path` (an item's folder, a scene's, the whole library)
    public static void ForgetUnder(string path)
    {
        if (string.IsNullOrEmpty(path) || !Directory.Exists(Dir)) return;
        var root = path.TrimEnd('/');
        foreach (var srcFile in SafeFiles("*.src"))
        {
            var item = Path.GetFileNameWithoutExtension(srcFile);
            var src = ReadSrc(item);
            if (src == null || !(src == root || src.StartsWith(root + "/", StringComparison.Ordinal))) continue;
            ForgetItem(item);
        }
    }
    private static void ForgetItem(string item)
    {
        foreach (var c in ClipsOf(item)) Delete(c.Name);
        try { File.Delete(SrcFile(item)); } catch { }
    }
    private static string[] SafeFiles(string pattern) { try { return Directory.GetFiles(Dir, pattern); } catch { return []; } }

    // At start-up: what no card can ask for any more goes — unfinished encodes, the older layout's clips, the clips of a
    // source that is gone (an item trashed or deleted while the backend was down) or changed, every clip but the newest
    // full one of an item (and its stand-in once it has one).
    public static void Sweep()
    {
        if (!Directory.Exists(Dir)) return;
        var byItem = new Dictionary<string, List<Clip>>();
        foreach (var f in SafeFiles("*"))
        {
            var name = Path.GetFileName(f);
            if (name.EndsWith(".src", StringComparison.Ordinal)) { byItem.TryAdd(name[..^4], []); continue; }
            var c = Parse(f);
            if (c == null) { try { File.Delete(f); } catch { } continue; }
            if (!byItem.TryGetValue(c.Item, out var l)) byItem[c.Item] = l = [];
            l.Add(c);
        }
        foreach (var (item, clips) in byItem)
        {
            var src = ReadSrc(item);
            if (src == null || !File.Exists(src)) { ForgetItem(item); continue; }
            var stamp = StampOf(new FileInfo(src));
            var cur = clips.Where(c => c.Stamp == stamp).ToList();
            var keep = Best(cur.Where(c => c.Full)) ?? Best(cur);
            foreach (var c in clips) if (c != keep) Delete(c.Name);
            if (keep == null) try { File.Delete(SrcFile(item)); } catch { }
        }
        PruneOutside();
    }

    // the size cap for clips of items outside the library: the least recently played go first
    private static int _pruning;
    private static void PruneOutside()
    {
        if (Interlocked.Exchange(ref _pruning, 1) == 1) return;
        try
        {
            var lib = DownloadHelper.LibraryPath.TrimEnd('/') + "/";
            var outside = new List<FileInfo>();
            foreach (var srcFile in SafeFiles("*.src"))
            {
                var item = Path.GetFileNameWithoutExtension(srcFile);
                if (ReadSrc(item) is string s && s.StartsWith(lib, StringComparison.Ordinal)) continue;
                outside.AddRange(ClipsOf(item).Select(c => new FileInfo(Path.Combine(Dir, c.Name))));
            }
            long total = 0;
            foreach (var f in outside.OrderByDescending(f => f.LastAccessTimeUtc))
            {
                total += f.Length;
                if (total > OUTSIDE_CAP) try { f.Delete(); } catch { }
            }
        }
        catch { }
        finally { Volatile.Write(ref _pruning, 0); }
    }

    // ---- the bytes ----------------------------------------------------------------------------------------------------------
    private static IResult Bytes(HttpRequest req, string file)
    {
        long len = new FileInfo(file).Length;
        var range = req.Headers.Range.ToString();
        if (range.Length == 0) return new FileRange(file, 0, len - 1, len, false);
        var m = RangeRe.Match(range);
        if (!m.Success || (m.Groups[1].Length == 0 && m.Groups[2].Length == 0)) return new FileRange(file, 0, len - 1, len, false);
        long start, end = len - 1;
        if (m.Groups[1].Length == 0) start = Math.Max(0, len - long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));
        else
        {
            start = long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            if (m.Groups[2].Length > 0) end = Math.Min(end, long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));
        }
        if (start >= len || start > end) return new FileRange(file, -1, -1, len, true);
        return new FileRange(file, start, Math.Min(end, start + CHUNK - 1), len, true);
    }

    private sealed class FileRange(string file, long start, long end, long len, bool partial) : IResult
    {
        public async Task ExecuteAsync(HttpContext ctx)
        {
            var res = ctx.Response;
            res.Headers.AcceptRanges = "bytes";
            if (start < 0) { res.StatusCode = 416; res.Headers.ContentRange = $"bytes */{len}"; return; }
            res.StatusCode = partial ? 206 : 200;
            res.ContentType = "video/mp4";
            res.ContentLength = end - start + 1;
            if (partial) res.Headers.ContentRange = $"bytes {start}-{end}/{len}";
            try { await res.SendFileAsync(file, start, end - start + 1, ctx.RequestAborted); }
            catch (OperationCanceledException) { }
            catch (FileNotFoundException) { ctx.Abort(); }
        }
    }
}
