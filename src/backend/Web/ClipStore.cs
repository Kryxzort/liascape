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
//   - re-made only for more: a box wider than the stored clip, or a higher quality. A smaller box or a lower quality keeps
//     the bigger clip (the browser downscales it). Shrunk only when the stored one is 2x wider than needed (3-4x the bytes),
//     only while the app is inactive (`POST /clip/shrink`), never for a card on screen.
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
    // name, fps cap, x264 CRF: a higher one never looks worse than a lower one (an upgrade only goes up)
    private static readonly (string Name, int Fps, int Crf)[] QUALITY = [("low", 24, 31), ("mid", 30, 27), ("high", 60, 23)];
    private static readonly long OUTSIDE_CAP = 1024L * 1024 * 1024;
    private static readonly TimeSpan GRACE = TimeSpan.FromSeconds(90);
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
    {
        double need = Math.Max(boxW, boxH * (double)s.W / s.H);
        int b = WIDTHS.FirstOrDefault(x => x >= need);
        if (b == 0) b = WIDTHS[^1];
        return Math.Max(2, Math.Min(b, s.W & ~1));
    }

    // ---- GET /clip ------------------------------------------------------------------------------------------------------
    //   ?path=&w=&h=&q=&info=1  →  {v, full, pending}: the clip to play now for a box of w × h device pixels at quality q
    //                              (low|mid|high); queues a better one when needed (pending: a newer clip is coming, ask again)
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
        var r = await Info(path!, w, h, q);
        if (info) return Results.Json(new { v = r.V, full = r.Full, pending = r.Pending });
        if (r.V == null) return Results.StatusCode(502);
        var f2 = Path.Combine(Dir, r.V + ".mp4");
        return File.Exists(f2) ? Bytes(ctx.Request, f2) : Results.StatusCode(502);
    }

    private static void Touch(string file) { try { File.SetLastAccessTimeUtc(file, DateTime.UtcNow); } catch { } }

    private sealed record InfoResult(string? V, bool Full, bool Pending);
    private static async Task<InfoResult> Info(string path, int boxW, int boxH, int q)
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
        if (full != null)
        {
            bool enough = full.W >= want && full.Q >= q;
            // an upgrade never loses what the stored clip has: the wider of the two widths, the higher quality
            if (!enough) Enqueue(path, item, Math.Max(want, full.W), Math.Max(q, full.Q));
            return new(Stem(full), true, Queued(item));
        }
        // a video no longer than the stand-in: its full clip is as quick to make as one
        if (src.Dur > 0 && src.Dur <= SHORT_SECONDS + 0.5)
        {
            var made = await MakeNow(path, item, stamp, want, q, full: true);
            return new(made == null ? null : Stem(made), made != null, false);
        }
        Enqueue(path, item, want, q);
        var stand = Best(mine.Where(c => !c.Full)) ?? await MakeNow(path, item, stamp, want, q, full: false);
        return new(stand == null ? null : Stem(stand), false, Queued(item));
    }
    private static Clip? Best(IEnumerable<Clip> cs) => cs.OrderByDescending(c => c.Mtime).FirstOrDefault();
    private static string Stem(Clip c) => Path.GetFileNameWithoutExtension(c.Name);
    private static string NameFor(string item, string stamp, int w, int q, bool full) => $"{item}_{stamp}_{w}_{q}_{(full ? "full" : "short")}.mp4";

    // ---- encoding ---------------------------------------------------------------------------------------------------------
    private static List<string> Args(string src, string dst, int seconds, int w, int q)
    {
        var (_, fps, crf) = QUALITY[q];
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

    // stand-ins (and the full clip of a video no longer than one) are made on the request: a card waits for them
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
    private sealed class Job
    {
        public required string Path, Item;
        public int W, Q;
        public DateTime Asked;
        public bool Shrink;
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
            // the card asked for most recently first: the one the user is looking at now
            var j = _jobs.Values.Where(x => !x.Shrink).OrderByDescending(x => x.Asked).FirstOrDefault()
                    ?? (_idle ? _jobs.Values.FirstOrDefault(x => x.Shrink) : null);
            if (j == null) return null;
            _jobs.Remove(j.Item);
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
                finally { lock (_lock) { _running = null; _runningCts?.Dispose(); _runningCts = null; } }
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
        int w = Math.Min(j.W, src.W & ~1);
        var stored = Best(ClipsOf(j.Item).Where(c => c.Full && c.Stamp == stamp));
        if (j.Shrink ? stored == null || stored.W < 2 * w : stored != null && stored.W >= w && stored.Q >= j.Q) return;
        var name = NameFor(j.Item, stamp, w, j.Q, true);
        var dst = Path.Combine(Dir, name);
        var tmp = dst + ".tmp";
        var t0 = Stopwatch.StartNew();
        // a 5 min clip from a 4K source takes about a minute niced on an idle machine; past this something is wrong
        if (Encode(Args(j.Path, tmp, CAP_SECONDS, w, j.Q), tmp, true, TimeSpan.FromMinutes(20), ct))
        {
            File.Move(tmp, dst, true);
            WriteSrc(j.Item, j.Path);
            Console.WriteLine($"clips: {(j.Shrink ? "shrank" : "made")} {w} px {QUALITY[j.Q].Name} ({new FileInfo(dst).Length / 1024} KB, {t0.Elapsed.TotalSeconds:0.0} s) for {Path.GetFileName(j.Path)}");
            Superseded(j.Item, name);
            PruneOutside();
        }
        else
        {
            try { File.Delete(tmp); } catch { }
            if (!ct.IsCancellationRequested) lock (_lock) _failed[$"{j.Item}|{j.W}|{j.Q}"] = DateTime.UtcNow;
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
