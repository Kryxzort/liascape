using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;
using Liascape.Scrapers;

namespace Liascape.Web;

// What the library's filter column and sidebar know about each item beyond its own files (docs/decisions.md § "Ask Steam
// for a whole library's details in one request"), filled in the background and cached in the item's index entry (field-level writes through LibraryStore.UpdateIndex) so it is asked once:
//   1. Steam's Workshop tags and the YouTube trailer of each Workshop item that has neither yet — an item subscribed through
//      Steam (auto-imported from Wallpaper Engine's folder) has only its project.json, so no resolution and only the genres
//      its author typed. Steam's own servers answer, anonymously over the client protocol (SteamWorkshopDetails.GetDetailsAsync
//      — PublishedFile.GetDetails, a whole library in one request; measured: 1000 ids in 574 ms), the same call carrying
//      both. Saved: `tags` (never asked again), or `tagsCheckedAt` when Steam has no public item with that id (removed,
//      private: asked again after RecheckDays); a trailer → `youtubeUrl`, none → `trailerCheckedAt` (re-checked after
//      RecheckDays, an author may add one). Couldn't ask (offline, Steam down) → NOTHING stored, asked again next time:
//      Wallpaper Engine's own offline-mode bug is reporting "can't tell" as "nothing there"; a failed check is never a "no".
//   2. The trailer of what Steam's servers didn't answer for: the item's public Workshop page (rate-gated by SteamGate,
//      background pace: starts ≥ 4 s apart, 10 s behind the user's own browsing; a 429 starts an app-wide cooldown that
//      survives restarts). On a cooldown it stops and re-schedules itself for when it ends; only real failures count
//      toward MaxFailsInARow (offline → stop, next start). Other routes, checked: IPublishedFileService/GetDetails needs
//      a Web API key or a signed-in access token (401 without); the keyless ISteamRemoteStorage/GetPublishedFileDetails
//      has no previews at all.
//   3. The frame size of every item whose Steam tags carry no resolution — every non-Workshop item, and a Workshop item
//      Steam has none for (or couldn't be asked about): a video's or an image's from ffprobe, a scene's project size
//      (`general.orthogonalprojection` of its scene.json, loose or inside scene.pkg). One ffprobe at a time: measured
//      20–130 ms a file (median ~30) once its header is cached, ~1 s cold off a hard disk (30 files in 28.7 s) — the disk
//      is the cost, and parallel reads would only make it seek between them. Cached per file (`frameSizeOf` = its size +
//      mtime), so only a new or changed file is read again. LibraryService.Build shows it bucketed into the Workshop's
//      resolution tags.
// Single-flight: a kick while a pass runs makes it run once more after (a new arrival during a pass isn't missed). Kicked
// after the startup WE sync, /library/sync, an import and a download. Trailer finds → WS `library-item-changed
// {path, youtubeUrl}`; saved tags / sizes → `library-synced` (the Library re-reads). Adapter log: `library-facts: …`.
// While a pass works, its phase and count → LibraryOps "facts" (the top bar's progress line).
// Guard: scripts/test-library-facts.sh; matrix probe-filters lib:steamTags
public static class LibraryFactsOps
{
    private const int MaxFailsInARow = 3, RecheckDays = 30, FlushEvery = 50, ProbeTimeoutMs = 15_000;
    private static int _running, _again, _scheduled;

    public static void Kick(string why) => _ = Task.Run(async () =>
    {
        try { await RunAsync(why).ConfigureAwait(false); }
        catch (Exception e) { Console.WriteLine($"library-facts: pass failed ({e.GetType().Name}: {e.Message})"); }
    });

    private static void ScheduleAfter(TimeSpan wait, string why)
    {
        if (Interlocked.Exchange(ref _scheduled, 1) == 1) return;
        Console.WriteLine($"library-facts: Steam cooldown — trailer pages resume in {Math.Ceiling(wait.TotalMinutes)} min");
        _ = Task.Run(async () => { await Task.Delay(wait + TimeSpan.FromSeconds(5)).ConfigureAwait(false); Interlocked.Exchange(ref _scheduled, 0); Kick(why + ", after cooldown"); });
    }

    public static async Task RunAsync(string why)
    {
        Interlocked.Exchange(ref _again, 1);
        while (true)
        {
            if (Interlocked.Exchange(ref _running, 1) == 1) return; // the running pass sees _again and goes once more
            try { while (Interlocked.Exchange(ref _again, 0) == 1) await PassAsync(why).ConfigureAwait(false); }
            finally { LibraryOps.End("facts"); Interlocked.Exchange(ref _running, 0); }
            if (Volatile.Read(ref _again) == 0) return; // else a kick landed between the last check and the release
        }
    }

    private sealed record Entry(LibraryItem Item, string Source, string Key, LibMeta? Meta)
    {
        // the Workshop id: the index's, else the folder name of a workshop/ or local/ item (its identity) — a local/<id> link
        // can be there before its index entry
        public ulong? SteamId => (Item.WorkshopId ?? (Source is LibraryStore.Local or LibraryStore.Workshop ? Key : null)) is { Length: > 0 } w
            && w.All(char.IsAsciiDigit) && ulong.TryParse(w, out var id) ? id : null;
    }

    // one snapshot of the library + its indexes (each read once), the entries' (source, key)
    private static List<Entry> Snapshot()
    {
        var indexes = new Dictionary<string, Dictionary<string, LibMeta>>();
        var list = new List<Entry>();
        foreach (var item in LibraryService.LoadAll())
        {
            if (LibraryStore.Locate(item.VideoPath) is not { } loc) continue;
            if (!indexes.TryGetValue(loc.Source, out var idx)) indexes[loc.Source] = idx = LibraryStore.LoadIndex(loc.Source);
            list.Add(new Entry(item, loc.Source, loc.Key, idx.GetValueOrDefault(loc.Key)));
        }
        return list;
    }

    // field-level writes: each change to its entry, under the index lock; a gone item gets no entry (LibraryStore.SetMeta)
    private static void Save(IEnumerable<(Entry E, Action<LibMeta> Set)> changes)
    {
        foreach (var src in changes.GroupBy((c) => c.E.Source))
            LibraryStore.UpdateIndex(src.Key, (idx) =>
            {
                bool any = false;
                foreach (var (e, set) in src)
                {
                    if (!idx.TryGetValue(e.Key, out var m))
                    {
                        if (!Directory.Exists(Path.Combine(LibraryStore.SourceDir(e.Source), e.Key))) continue;
                        idx[e.Key] = m = new LibMeta();
                    }
                    set(m); any = true;
                }
                return any;
            });
    }

    private static async Task PassAsync(string why)
    {
        await SteamPassAsync(why).ConfigureAwait(false);
        await FrameSizePassAsync(why).ConfigureAwait(false);
    }

    private static bool Recent(long? at, long stale) => at is long a && a >= stale;

    private static async Task SteamPassAsync(string why)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), stale = now - RecheckDays * 86400L;
        bool NeedsTags(Entry e) => e.Meta?.Tags == null && !Recent(e.Meta?.TagsCheckedAt, stale);
        bool NeedsTrailer(Entry e) => e.Item.YoutubeUrl == null && !Recent(e.Meta?.TrailerCheckedAt, stale);
        var todo = Snapshot()
            .Where((e) => e.SteamId != null)
            .Where((e) => NeedsTags(e) || NeedsTrailer(e))
            .ToList();
        if (todo.Count == 0) return;
        Console.WriteLine($"library-facts: asking Steam about {todo.Count} Workshop item(s) ({why}) — {todo.Count(NeedsTags)} for tags, {todo.Count(NeedsTrailer)} for a trailer");
        LibraryOps.Set("facts", "steam", 0, todo.Count); // the top bar's line (one request: its count jumps at the answer)
        int tagged = 0, gone = 0, found = 0, none = 0, fails = 0, inARow = 0;
        var t0 = DateTime.UtcNow;
        // FIRST: Steam's own servers, anonymously — no page reads. What they answer for is recorded; the rest (unreachable
        // servers, an item they didn't return) keeps its tags unknown, and its trailer falls to page reading.
        var cm = await SteamWorkshopDetails.GetDetailsAsync(todo.Select((e) => e.SteamId!.Value).Distinct().ToList()).ConfigureAwait(false);
        var pages = new List<Entry>();
        if (cm != null)
        {
            var changes = new List<(Entry, Action<LibMeta>)>();
            var trailers = new List<(string Path, string Url)>();
            foreach (var e in todo)
            {
                if (!cm.TryGetValue(e.SteamId!.Value, out var d)) { if (NeedsTrailer(e)) pages.Add(e); continue; }
                bool tags = NeedsTags(e), trailer = NeedsTrailer(e);
                string? url = trailer && d.Youtube is { } y ? $"https://www.youtube.com/watch?v={y}" : null;
                if (tags) { if (d.Found) tagged++; else gone++; }
                if (trailer) { if (url != null) { found++; trailers.Add((e.Item.VideoPath, url)); } else none++; }
                changes.Add((e, (m) =>
                {
                    // never over tags already there (a download's, another process's meanwhile)
                    if (tags && m.Tags == null) { if (d.Found) { m.Tags = d.Tags; m.TagsCheckedAt = null; } else m.TagsCheckedAt = now; }
                    if (trailer && m.YoutubeUrl == null) { if (url != null) m.YoutubeUrl = url; m.TrailerCheckedAt = now; }
                }));
            }
            Save(changes);
            foreach (var (path, url) in trailers) EventBus.Broadcast("library-item-changed", new { path, youtubeUrl = url });
            if (tagged > 0) EventBus.Broadcast("library-synced", new { count = 0 });
            Console.WriteLine($"library-facts: Steam's servers answered {todo.Count - pages.Count} item(s) in {(DateTime.UtcNow - t0).TotalSeconds:0.0} s — "
                + $"{tagged} tagged, {gone} not on the Workshop; trailers: {found} found, {none} without");
        }
        else
        {
            pages = todo.Where(NeedsTrailer).ToList();
            Console.WriteLine("library-facts: Steam's servers unreachable — tags asked again next time; trailers from Workshop pages (rate-gated)");
        }
        if (pages.Count == 0) return;
        // the fallback reads steamcommunity.com: during its cooldown (maybe from before a restart) come back after it
        if (SteamGate.CooldownRemaining is { } cool && cool > TimeSpan.Zero) { ScheduleAfter(cool, why); return; }
        int asked = 0;
        foreach (var e in pages)
        {
            LibraryOps.Set("facts", "trailers", asked++, pages.Count);
            var (r, url) = await SteamWorkshopScraper.CheckYoutubeAsync(e.SteamId!.Value.ToString(), SteamGate.Kind.Background).ConfigureAwait(false);
            if (r == SteamWorkshopScraper.PageCheck.RateLimited)
            {
                var cd = SteamGate.CooldownRemaining;
                Console.WriteLine($"library-facts: trailer pages stopped by the Steam cooldown — {found} found, {none} without so far");
                if (cd > TimeSpan.Zero) ScheduleAfter(cd, why);
                return;
            }
            if (r != SteamWorkshopScraper.PageCheck.Ok)
            {
                fails++;
                if (++inARow >= MaxFailsInARow) { Console.WriteLine($"library-facts: {inARow} trailer pages failed in a row — offline? stopping, retried next start"); break; }
                continue;
            }
            inARow = 0;
            var at = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            Save([(e, (m) => { if (url != null) m.YoutubeUrl = url; m.TrailerCheckedAt = at; })]);
            if (url != null) { found++; EventBus.Broadcast("library-item-changed", new { path = e.Item.VideoPath, youtubeUrl = url }); }
            else none++;
        }
        Console.WriteLine($"library-facts: trailer pages finished — {found} found, {none} without, {fails} couldn't be checked");
    }

    // ---- frame sizes ----

    private static async Task FrameSizePassAsync(string why)
    {
        var todo = new List<(Entry E, string File, string Stamp)>();
        foreach (var e in Snapshot())
        {
            if (e.Meta?.Tags?.Any(WorkshopTags.IsResolution) == true) continue; // Steam's tag says it
            var file = e.Item.IsScene ? SceneFileOf(e.Item.VideoPath) : e.Item.VideoPath;
            var stamp = StampOf(file);
            if (stamp == null || e.Meta?.FrameSizeOf == stamp) continue;
            todo.Add((e, file!, stamp));
        }
        if (todo.Count == 0) return;
        var sw = Stopwatch.StartNew();
        int at = 0;
        int read = 0, unknown = 0;
        var changes = new List<(Entry, Action<LibMeta>)>();
        void Flush()
        {
            if (changes.Count == 0) return;
            Save(changes);
            changes.Clear();
            EventBus.Broadcast("library-synced", new { count = 0 });
        }
        foreach (var (e, file, stamp) in todo)
        {
            LibraryOps.Set("facts", "sizes", at++, todo.Count);
            var size = e.Item.IsScene ? SceneSizeOf(file) : await VideoSizeOfAsync(file).ConfigureAwait(false);
            if (size == null) { unknown++; continue; } // couldn't read it (no ffprobe, a timeout): nothing stored
            read++;
            changes.Add((e, (m) => { m.FrameSize = size; m.FrameSizeOf = stamp; }));
            if (changes.Count >= FlushEvery) Flush();
        }
        Flush();
        Console.WriteLine($"library-facts: frame sizes of {read} item(s) read in {sw.ElapsedMilliseconds} ms ({why})"
            + (unknown > 0 ? $"; {unknown} couldn't be read — asked again next time" : ""));
    }

    // "<bytes>:<mtime ticks>" of the file the size is read from; null = it isn't there
    private static string? StampOf(string? file)
    {
        try { var fi = new FileInfo(file ?? ""); return fi.Exists ? $"{fi.Length}:{fi.LastWriteTimeUtc.Ticks}" : null; }
        catch { return null; }
    }

    // a scene's scene file: its project.json `file` (scene.json) loose in the folder, else the folder's scene.pkg
    private static string? SceneFileOf(string dir)
    {
        string name = "scene.json";
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "project.json")));
            if (doc.RootElement.TryGetProperty("file", out var f) && f.ValueKind == JsonValueKind.String && f.GetString() is { Length: > 0 } n
                && !n.Contains('/') && !n.Contains("..")) name = n;
        }
        catch { }
        var loose = Path.Combine(dir, name);
        return File.Exists(loose) ? loose : File.Exists(Path.Combine(dir, "scene.pkg")) ? Path.Combine(dir, "scene.pkg") : null;
    }

    // "W x H" of a scene's projection; "" = none fixed (a perspective camera, `auto`) or an unreadable file — kept until the
    // file changes. null never: the file is local, a failure to read it now would fail the same way next time.
    private static string SceneSizeOf(string file)
    {
        try
        {
            string? json = file.EndsWith(".pkg", StringComparison.OrdinalIgnoreCase) ? JsonFromPkg(file, "scene.json") : File.ReadAllText(file);
            if (json == null) return "";
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            if (doc.RootElement.TryGetProperty("general", out var g) && g.ValueKind == JsonValueKind.Object
                && g.TryGetProperty("orthogonalprojection", out var op) && op.ValueKind == JsonValueKind.Object
                && op.TryGetProperty("width", out var w) && w.TryGetInt32(out var wi) && op.TryGetProperty("height", out var h) && h.TryGetInt32(out var hi)
                && wi > 0 && hi > 0)
                return $"{wi} x {hi}";
        }
        catch { }
        return "";
    }

    // One file out of Wallpaper Engine's scene.pkg (layout: src/player/src/scene/pkg.rs): u32-length-prefixed "PKGV00xx",
    // u32 count, count × {u32-length name, u32 offset, u32 length}, then the data (offsets from the end of that table).
    private static string? JsonFromPkg(string pkg, string name)
    {
        using var f = File.OpenRead(pkg);
        using var r = new BinaryReader(f);
        string? Str(int max) { int n = r.ReadInt32(); return n < 0 || n > max ? null : Encoding.UTF8.GetString(r.ReadBytes(n)); }
        if (Str(64) is not { } head || !head.StartsWith("PKGV", StringComparison.Ordinal)) return null;
        int count = r.ReadInt32();
        if (count < 0 || count > 1_000_000) return null;
        (uint Off, uint Len)? hit = null;
        for (int i = 0; i < count; i++)
        {
            if (Str(4096) is not { } n) return null;
            uint off = r.ReadUInt32(), len = r.ReadUInt32();
            if (n == name) hit = (off, len);
        }
        if (hit is not { } e || e.Len > 64 << 20) return null;
        long at = f.Position + e.Off;
        if (at + e.Len > f.Length) return null;
        f.Seek(at, SeekOrigin.Begin);
        return Encoding.UTF8.GetString(r.ReadBytes((int)e.Len));
    }

    // "W x H" of a video's (or image's) first video stream as displayed (a ±90° rotation swaps them); "" = it has no video
    // stream or ffprobe can't read it (kept until the file changes); null = ffprobe couldn't run or didn't answer in time.
    private static async Task<string?> VideoSizeOfAsync(string path)
    {
        try
        {
            var psi = new ProcessStartInfo("ffprobe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in new[] { "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", path })
                psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p == null) return null;
            var outTask = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            using var cts = new CancellationTokenSource(ProbeTimeoutMs);
            try { await p.WaitForExitAsync(cts.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { try { p.Kill(); } catch { } return null; }
            if (p.ExitCode != 0) return "";
            using var doc = JsonDocument.Parse(await outTask.ConfigureAwait(false));
            if (!doc.RootElement.TryGetProperty("streams", out var ss) || ss.ValueKind != JsonValueKind.Array || ss.GetArrayLength() == 0) return "";
            var s = ss[0];
            if (!s.TryGetProperty("width", out var w) || !w.TryGetInt32(out var wi) || !s.TryGetProperty("height", out var h) || !h.TryGetInt32(out var hi)
                || wi <= 0 || hi <= 0) return "";
            int rot = 0;
            if (s.TryGetProperty("side_data_list", out var sd) && sd.ValueKind == JsonValueKind.Array)
                foreach (var x in sd.EnumerateArray())
                    if (x.TryGetProperty("rotation", out var ro) && ro.TryGetInt32(out var rv)) rot = rv;
            if (rot == 0 && s.TryGetProperty("tags", out var tg) && tg.ValueKind == JsonValueKind.Object && tg.TryGetProperty("rotate", out var rt)
                && rt.ValueKind == JsonValueKind.String && int.TryParse(rt.GetString(), out var rv2)) rot = rv2;
            return Math.Abs(rot) % 180 == 90 ? $"{hi} x {wi}" : $"{wi} x {hi}";
        }
        catch (System.ComponentModel.Win32Exception) { return null; } // no ffprobe
        catch { return ""; }
    }
}
