using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Web;

// Every library card's previews made ahead of its card, in the background (docs/decisions.md § "Play every on-screen video
// preview, each as a small clip"). A card makes its previews when it scrolls into view (`/still`,
// `/anim`, `/clip`): a library opened on 300 items without them waits on each card in turn, and a hover's gif starts with a
// trim. This queue makes them before anyone looks.
//   - what: exactly what the card would show with the user's "On hover" / "Not hovered" orders
//     (app/ui/src/components/mediaAssets.ts usePreviewKinds, ported in Kinds): its still at the card's width (always: every
//     card shows it), its trimmed gif (when an order reaches the gif before the image), its video preview clip (when "Not
//     hovered" reaches the video: at the card's box, which the page reports, and "Video preview quality"). Under "Play GIF
//     previews as videos" a local .gif's clip (ClipStore, at the same box and quality) instead of its trimmed gif: GifClip.
//     A change of either order, the quality or that switch plans again at once (Kick from POST /settings).
//   - where it runs: ClipStore's background worker, one job at a time, behind the cards' own clips, their stand-ins, every
//     /still or /anim a card waits for (ServerHost.CardWaits) and the quality sweep. Every ffmpeg under `nice -n 19 ionice -c3`.
//   - the order: the item open in the sidebar, then the cards on screen (POST /previews/seen), then the Library's own order
//     (the page's sort), then the rest. A new import or download plans again and joins it.
//   - held (HoldReason): never starts while the PC is busy or the user plays — a fullscreen window on an output the player
//     shows on (the cover Signal; a maximized one doesn't hold: the app's own window often is), the player's low-VRAM hold, a
//     battery discharging, other programs using 40 % of the CPU (/proc/stat, not counting niced work like ours), the disk
//     stalling every task 10 % of the time (/proc/pressure/io "full"). A running clip encode is stopped and put back.
//     It resumes by itself: the worker looks again every 10 s.
//   - a failure is remembered per file until the file changes (its size + mtime), across restarts (FailFile): never a loop.
//   - restart-safe: nothing to keep; at start-up the plan is taken again from what is missing.
//   - progress: ClipStore's "clips" operation, phase make ("Making previews n / total"): the same line as the cards' own
//     clips, never a second one. Quiet with one item or none, and while held (a count that doesn't move for an hour of
//     gaming says nothing).
// No setting turns background work off: this follows the preview settings the user already has.
// Guard: scripts/test-preview-backfill.sh; --probe probe-libops.js libops:backfill.
public static class PreviewBackfill
{
    // GifClip: the clip of the gif (`Todo.Gif`), Clip: the clip of the video (`Todo.Video`)
    [Flags] public enum Kind { None = 0, Still = 1, Gif = 2, Clip = 4, GifClip = 8 }
    private const Kind Clips = Kind.Clip | Kind.GifClip;
    // an item's missing previews and the files they come from
    public sealed record Todo(string Path, Kind Kinds, string? Still, string? Gif, string? Video);
    public enum Result { Done, Stopped }

    // app/ui/src/api/client.ts CARD_STILL_W: the width every card's still is asked at
    public const int CARD_STILL_W = 640;
    private static readonly Regex VideoRe = new(@"\.(mp4|webm|mov|mkv|avi)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // how often a running clip encode looks at the hold (LIASCAPE_PREVIEW_HOLD_POLL_MS: the test's shorter one)
    private static readonly TimeSpan HOLD_POLL = TimeSpan.FromMilliseconds(
        int.TryParse(Environment.GetEnvironmentVariable("LIASCAPE_PREVIEW_HOLD_POLL_MS"), out var ms) && ms > 0 ? ms : 3000);

    private static readonly object _lock = new();
    private static readonly List<Todo> _todo = new();
    private static int _done;
    private static List<string> _visible = [];
    private static string? _side;
    private static Dictionary<string, int> _rank = new(StringComparer.Ordinal);
    private static (int W, int H)? _box;
    private static string? _held;

    // ---- the page: what is on screen, the sidebar's item, the Library's order, a card's box (POST /previews/seen) ----------
    public sealed record SeenBody(List<string>? Visible, string? Side, List<string>? Order, SeenBox? Box);
    public sealed record SeenBox(int W, int H);
    public static void Seen(SeenBody b)
    {
        bool replan = false;
        lock (_lock)
        {
            _visible = (b.Visible ?? []).Take(1000).ToList();
            _side = b.Side;
            if (b.Order != null)
            {
                _rank = new(StringComparer.Ordinal);
                foreach (var p in b.Order.Take(100_000)) _rank.TryAdd(p, _rank.Count);
                SortLocked();
            }
            if (b.Box is { W: > 0, H: > 0 } bx)
            {
                var nb = (Math.Clamp(bx.W, 16, 8192), Math.Clamp(bx.H, 16, 8192));
                // the first box makes clips possible; a later one only sizes the clips still to make
                replan = _box == null;
                _box = nb;
            }
        }
        if (replan) Kick("card box");
        ClipStore.Wake();
    }

    // ---- planning: what every library item is missing --------------------------------------------------------------------
    private static int _planning, _again;
    public static void Kick(string why) => _ = Task.Run(() =>
    {
        Interlocked.Exchange(ref _again, 1);
        while (true)
        {
            if (Interlocked.Exchange(ref _planning, 1) == 1) return; // the running plan sees _again and goes once more
            try { while (Interlocked.Exchange(ref _again, 0) == 1) Plan(why); }
            catch (Exception e) { Console.WriteLine($"previews: planning failed ({e.GetType().Name}: {e.Message})"); }
            finally { Interlocked.Exchange(ref _planning, 0); }
            if (Volatile.Read(ref _again) == 0) return;
        }
    });

    private static void Plan(string why)
    {
        var s = SettingsService.Load();
        (int W, int H)? box; lock (_lock) box = _box;
        var clips = ClipStore.FullClipKeys();
        var fails = Failures();
        var list = new List<Todo>();
        foreach (var it in LibraryService.LoadAll())
        {
            var t = Missing(it, s, box != null, clips, fails, out _);
            if (t.Kinds != Kind.None) list.Add(t);
        }
        // the preview cache is an LRU of PREVIEW_CACHE_CAP: filling it past 3/4 would evict what this just made (and Browse's
        // previews), and the next plan would make it again
        long cached = CacheBytes();
        if (cached > ServerHost.PREVIEW_CACHE_CAP * 3 / 4 && list.Any(t => (t.Kinds & (Kind.Still | Kind.Gif)) != 0))
        {
            Console.WriteLine($"previews: the preview cache holds {cached / 1048576} MB: no more stills or gifs ahead of their cards");
            list = list.Select(t => t with { Kinds = t.Kinds & Clips }).Where(t => t.Kinds != Kind.None).ToList();
        }
        int n;
        lock (_lock)
        {
            _todo.Clear(); _todo.AddRange(list);
            SortLocked();
            n = _todo.Count;
        }
        if (n > 0) Console.WriteLine($"previews: {n} item(s) to make ({why})");
        // the hold first: a plan made while the PC is busy shows no count
        if (n > 0) RefreshHold();
        ClipStore.Wake();
    }

    private static long CacheBytes()
    {
        try { return new DirectoryInfo(ServerHost.PreviewCacheDir).EnumerateFiles().Sum(f => f.Length); } catch { return 0; }
    }

    // What `it`'s card would show and lacks: components/mediaAssets.ts usePreviewKinds + MotionThumb, kind by kind.
    // `failed`: what is missing but failed before for this very file.
    private static Todo Missing(LibraryItem it, AppSettings s, bool boxKnown, HashSet<string> clips, Dictionary<string, string> fails, out Kind failed)
    {
        failed = Kind.None;
        Kind k = Kind.None;
        string? still = Usable(string.IsNullOrEmpty(it.ThumbnailPath) ? it.AnimatedThumbnailPath : it.ThumbnailPath);
        if (still != null && !File.Exists(ServerHost.LocalStillFile(still, CARD_STILL_W)))
        {
            if (Failed(fails, Kind.Still, still)) failed |= Kind.Still; else k |= Kind.Still;
        }
        var anim = it.AnimatedThumbnailPath;
        bool gif = !string.IsNullOrEmpty(anim) && !VideoRe.IsMatch(anim);
        string? video = PreviewVideo(it);
        var hover = FirstPreview(s.PreviewOnHover, video != null, gif);
        var idle = FirstPreview(s.PreviewNotHovered, video != null && !it.IsScene, gif);
        // only a .gif is trimmed (/anim) or played as a video; an animated webp plays as it is
        string? g = gif && (hover == "gif" || idle == "gif") && anim!.EndsWith(".gif", StringComparison.OrdinalIgnoreCase) ? Usable(anim) : null;
        if (g != null && s.GifPreviewsAsVideo)
        {
            // its clip, the card's box known (components/MotionThumb.tsx plays it; the gif only until it exists)
            if (boxKnown && !clips.Contains(ClipStore.ClipKey(g)))
            {
                if (Failed(fails, Kind.GifClip, g)) failed |= Kind.GifClip; else k |= Kind.GifClip;
            }
        }
        else if (g != null && !File.Exists(ServerHost.LocalTrimFile(g)))
        {
            if (Failed(fails, Kind.Gif, g)) failed |= Kind.Gif; else k |= Kind.Gif;
        }
        string? v = idle == "video" ? Usable(video) : null;
        if (v != null && boxKnown && !clips.Contains(ClipStore.ClipKey(v)))
        {
            if (Failed(fails, Kind.Clip, v)) failed |= Kind.Clip; else k |= Kind.Clip;
        }
        return new Todo(it.VideoPath, k, still, g, v);
    }
    private static string? Usable(string? p) => !string.IsNullOrEmpty(p) && ApiSecurity.MediaAllowed(p) && File.Exists(p) ? p : null;

    // the video an item's preview plays: a video preview asset, else the wallpaper's own video (a scene has none)
    private static string? PreviewVideo(LibraryItem it)
    {
        var a = it.AnimatedThumbnailPath;
        if (!string.IsNullOrEmpty(a) && VideoRe.IsMatch(a)) return a;
        return it.IsScene || !VideoRe.IsMatch(it.VideoPath) ? null : it.VideoPath;
    }
    private static string FirstPreview(IEnumerable<string> order, bool video, bool gif)
    {
        foreach (var k in order)
            if (k == "image" || (k == "video" && video) || (k == "gif" && gif)) return k;
        return "image";
    }

    // the Library's order: the page's sort first, then the rest as the index lists them
    private static void SortLocked()
    {
        var at = _todo.Select((t, i) => (t, i)).OrderBy(x => _rank.TryGetValue(x.t.Path, out var r) ? r : int.MaxValue).ThenBy(x => x.i).Select(x => x.t).ToList();
        _todo.Clear(); _todo.AddRange(at);
    }

    // ---- the worker's side (ClipStore, under its lock: this lock always inside it) ----------------------------------------
    // the next item, or null (nothing left, or held): the sidebar's, else the first on screen, else the first in order
    internal static Todo? Take()
    {
        lock (_lock)
        {
            if (_held != null || _todo.Count == 0) return null;
            int at = _side != null ? _todo.FindIndex(t => t.Path == _side) : -1;
            if (at < 0 && _visible.Count > 0)
            {
                var vis = new HashSet<string>(_visible, StringComparer.Ordinal);
                at = _todo.FindIndex(t => vis.Contains(t.Path));
            }
            if (at < 0) at = 0;
            var t = _todo[at];
            _todo.RemoveAt(at);
            return t;
        }
    }
    // the job ended: done, or stopped (held, the quality changed) and put back first
    internal static void Finished(Todo t, Result r)
    {
        lock (_lock)
        {
            if (r == Result.Done) _done++;
            else if (!_todo.Any(x => x.Path == t.Path)) _todo.Insert(0, t);
        }
    }
    // for the progress line: what is left (0 while held) and done since the queue was last empty
    internal static (int Left, int Done) Counts() { lock (_lock) return (_held != null ? 0 : _todo.Count, _done); }
    internal static void ResetDone() { lock (_lock) _done = 0; }
    internal static bool HasWork() { lock (_lock) return _todo.Count > 0; }

    // ---- making one item's previews (ClipStore's worker thread) ----------------------------------------------------------
    internal static Result Make(Todo t, CancellationToken ct)
    {
        var made = new List<string>();
        if ((t.Kinds & Kind.Still) != 0 && t.Still != null && File.Exists(t.Still))
        {
            var f = ServerHost.LocalStillFile(t.Still, CARD_STILL_W);
            if (!File.Exists(f)) ServerHost.MakeLocalStill(t.Still, CARD_STILL_W, background: true).GetAwaiter().GetResult();
            if (File.Exists(f)) made.Add("still"); else Fail(Kind.Still, t.Still);
        }
        if ((t.Kinds & Kind.Gif) != 0 && t.Gif != null && File.Exists(t.Gif))
        {
            var f = ServerHost.LocalTrimFile(t.Gif);
            if (!File.Exists(f)) try { ServerHost.MakeLocalTrim(t.Gif, background: true).GetAwaiter().GetResult(); } catch { }
            if (File.Exists(f)) made.Add("gif"); else Fail(Kind.Gif, t.Gif);
        }
        // the clips: the gif's (short, quick) first, then the video's
        var left = t.Kinds & Clips;
        foreach (var (kind, file) in new[] { (Kind.GifClip, t.Gif), (Kind.Clip, t.Video) })
        {
            if ((t.Kinds & kind) == 0) continue;
            if (file != null && MakeClip(kind, file, ct, made) == Result.Stopped)
                // what is made stays made; the clips not made yet are all that's left
                return Finish(t with { Kinds = left }, Result.Stopped, made);
            left &= ~kind;
        }
        return Finish(t, Result.Done, made);
    }
    private static Result MakeClip(Kind kind, string file, CancellationToken ct, List<string> made)
    {
        (int W, int H)? box; lock (_lock) box = _box;
        if (box is not { } b) return Result.Done;
        int q = ClipStore.ParseQuality(SettingsService.Load().VideoPreviewQuality);
        // a hold that comes while the clip encodes (a game starting) stops it: it goes back in the queue
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var watch = new Timer(_ => { if (RefreshHold() != null) try { stop.Cancel(); } catch (ObjectDisposedException) { } },
            null, HOLD_POLL, HOLD_POLL);
        var r = ClipStore.MakeBackfillClip(file, b.W, b.H, q < 0 ? 1 : q, stop.Token);
        if (r == ClipStore.BackfillClip.Stopped)
        {
            Console.WriteLine($"previews: stopped the clip of {Path.GetFileName(file)} ({(ct.IsCancellationRequested ? "the quality changed" : _held ?? "stopped")})");
            return Result.Stopped;
        }
        // Had: a card's own request made it meanwhile, nothing made here
        if (r == ClipStore.BackfillClip.Failed) Fail(kind, file); else if (r == ClipStore.BackfillClip.Made) made.Add(kind == Kind.GifClip ? "gif clip" : "clip");
        return Result.Done;
    }
    private static Result Finish(Todo t, Result r, List<string> made)
    {
        if (made.Count > 0) Console.WriteLine($"previews: made {string.Join(" + ", made)} for {Path.GetFileName(t.Path.TrimEnd('/'))}");
        return r;
    }

    // ---- failures: remembered per file until it changes -------------------------------------------------------------------
    private static string FailFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "liascape", "preview-failures.json");
    private static Dictionary<string, string>? _fails;
    private static string StampOf(string file) { try { var fi = new FileInfo(file); return $"{fi.Length}|{fi.LastWriteTimeUtc.Ticks}"; } catch { return ""; } }
    private static Dictionary<string, string> Failures()
    {
        lock (_lock)
        {
            _fails ??= AtomicFile.ReadJson<Dictionary<string, string>>(FailFile) ?? new();
            return new(_fails);
        }
    }
    private static bool Failed(Dictionary<string, string> fails, Kind k, string file) => fails.TryGetValue($"{k}|{file}", out var st) && st == StampOf(file);
    private static void Fail(Kind k, string file)
    {
        Console.WriteLine($"previews: can't make the {k.ToString().ToLowerInvariant()} of {file}: not tried again until it changes");
        string json;
        lock (_lock)
        {
            _fails ??= AtomicFile.ReadJson<Dictionary<string, string>>(FailFile) ?? new();
            _fails[$"{k}|{file}"] = StampOf(file);
            // a file that's gone takes its entry along
            foreach (var key in _fails.Keys.Where(x => !File.Exists(x[(x.IndexOf('|') + 1)..])).ToList()) _fails.Remove(key);
            json = JsonSerializer.Serialize(_fails);
        }
        try { Directory.CreateDirectory(Path.GetDirectoryName(FailFile)!); AtomicFile.WriteAllText(FailFile, json); }
        catch (Exception e) { Console.WriteLine($"previews: can't save the failures: {e.Message}"); }
    }

    // ---- GET /previews/status: the queue, and what one item's card lacks (the tests' and probes' view) -------------------
    public static object Status(string? path)
    {
        object? item = null;
        if (path != null && LibraryService.LoadAll().FirstOrDefault(i => i.VideoPath == path) is { } it)
        {
            bool boxKnown; lock (_lock) boxKnown = _box != null;
            var t = Missing(it, SettingsService.Load(), boxKnown, ClipStore.FullClipKeys(), Failures(), out var failed);
            static List<string> Names(Kind k) => [.. new[] { Kind.Still, Kind.Gif, Kind.Clip, Kind.GifClip }.Where(x => (k & x) != 0).Select(x => x.ToString().ToLowerInvariant())];
            item = new { missing = Names(t.Kinds), failed = Names(failed) };
        }
        lock (_lock)
            return new { held = _held, left = _todo.Count, done = _done, box = _box is { } b ? new { w = b.W, h = b.H } : null, item };
    }

    // ---- the hold -----------------------------------------------------------------------------------------------------------
    // Why the queue waits now, or null. Read by the worker before it takes an item and every HOLD_POLL while a clip encodes; the
    // player is asked at most every 10 s.
    private static long _cpuBusy, _cpuAll;
    private static DateTime _cpuAt, _playerAt;
    private static string? _cpuHeld, _playerHeld;
    private static readonly object _holdLock = new();
    internal static string? RefreshHold()
    {
        string? why;
        lock (_holdLock)
        {
            // a test stands in for all of them (never the machine's own load)
            why = Environment.GetEnvironmentVariable("LIASCAPE_PREVIEW_HOLD_FILE") is { Length: > 0 } ? TestHold()
                : Battery() ?? Cpu() ?? Io() ?? Player();
        }
        bool changed;
        lock (_lock) { changed = why != _held; _held = why; }
        if (changed) Console.WriteLine(why != null ? $"previews: waiting ({why})" : "previews: going on");
        return why;
    }

    // a test's stand-in for every signal below (scripts/test-preview-backfill.sh): the file's words while it exists, and
    // nothing else holds then
    private static string? TestHold()
    {
        var f = Environment.GetEnvironmentVariable("LIASCAPE_PREVIEW_HOLD_FILE");
        if (string.IsNullOrEmpty(f) || !File.Exists(f)) return null;
        try { var w = File.ReadAllText(f).Trim(); return w.Length > 0 ? w : "held"; } catch { return "held"; }
    }

    private static string? Battery()
    {
        try
        {
            foreach (var d in Directory.EnumerateDirectories("/sys/class/power_supply"))
                if (Read(Path.Combine(d, "type")) == "Battery" && Read(Path.Combine(d, "status")) == "Discharging") return "on battery";
        }
        catch { }
        return null;
        static string? Read(string f) { try { return File.ReadAllText(f).Trim(); } catch { return null; } }
    }

    // other programs' share of every core since the last look (at least 2 s ago): user + system + irq + softirq + steal of
    // /proc/stat's first line, never `nice` (our own encodes and every other niced job run there) nor idle / iowait
    private static string? Cpu()
    {
        var now = DateTime.UtcNow;
        if (now - _cpuAt < TimeSpan.FromSeconds(2)) return _cpuHeld;
        try
        {
            var f = File.ReadLines("/proc/stat").First().Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).Select(long.Parse).ToArray();
            long busy = f[0] + f[2] + f[5] + f[6] + (f.Length > 7 ? f[7] : 0), all = f.Take(8).Sum();
            if (_cpuAll > 0 && all > _cpuAll)
            {
                double share = (double)(busy - _cpuBusy) / (all - _cpuAll);
                _cpuHeld = share >= 0.4 ? $"the CPU is {share:P0} busy" : null;
            }
            _cpuBusy = busy; _cpuAll = all; _cpuAt = now;
        }
        catch { _cpuHeld = null; }
        return _cpuHeld;
    }

    // every non-idle task stalled on the disk 10 % of the last 10 s
    private static string? Io()
    {
        try
        {
            var full = File.ReadLines("/proc/pressure/io").FirstOrDefault(l => l.StartsWith("full ", StringComparison.Ordinal));
            var m = full == null ? null : Regex.Match(full, @"avg10=([\d.]+)");
            if (m is { Success: true } && double.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) && v >= 10)
                return "the disk is busy";
        }
        catch { }
        return null;
    }

    // the player's own holds: a fullscreen window over an output it shows on (its cover Signal: a game, a film), its
    // low-VRAM rule. Only a player that is there (never spawned for this).
    private static string? Player()
    {
        var now = DateTime.UtcNow;
        if (now - _playerAt < TimeSpan.FromSeconds(10)) return _playerHeld;
        _playerAt = now;
        _playerHeld = null;
        try
        {
            var c = Liascape.Player.LiascapePlayerClient.Shared;
            if (!c.SocketExists) return null;
            var st = c.Call("state", null, Liascape.Player.LiascapePlayerClient.QuickMs);
            if (st.TryGetProperty("cover", out var cov) && cov.TryGetProperty("outputs", out var outs) && outs.ValueKind == JsonValueKind.Object
                && outs.EnumerateObject().Any(o => o.Value.ValueKind == JsonValueKind.String && o.Value.GetString() == "fullscreen"))
                return _playerHeld = "a fullscreen window";
            var low = c.Call("get", new Dictionary<string, object?> { ["path"] = "player.vram_low_active" }, Liascape.Player.LiascapePlayerClient.QuickMs);
            if (low.TryGetProperty("value", out var lv) && lv.ValueKind == JsonValueKind.True) return _playerHeld = "GPU memory is low";
        }
        catch (Exception) { }
        return _playerHeld;
    }
}
