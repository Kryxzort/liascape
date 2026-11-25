using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Scrapers;

// The local Wallpaper Engine folder as a Browse source (Services/WallpaperEngineService.cs): one card per item folder
// (<folder>/<workshop id>/), its kind from project.json (fixtures: scripts/test-fixtures/scrapers/wallpaper-engine/):
//   - "video" with its file present → a video card, the file as its page; any container mpv plays, so the file's
//     extension is never checked;
//   - "scene", or no readable project.json but a scene.pkg → a scene card (scene support on), the folder as its page;
//   - no type but a preset naming its Workshop base (Presets.Read) → a preset card (presets playable), the folder as its
//     page, as the Workshop lists them; one naming no base isn't a subscription's preset (the WE auto-import's rule).
//     Guard: probe-filters local:wePreset;
//   - anything else (web, application, a missing video file, no project.json) → no card.
// A query keeps the cards whose title contains it, any case. The title is project.json's, else the folder's name.
internal static class WallpaperEngineScraper
{
    // project.json's fields a card uses; Tags / Age feed the UI's filter column (WorkshopTags.FromProject)
    private sealed record Project(string? Type, string? File, string? Title, string[]? Tags, string? Age);

    // sortIndex: the UI's sort menu — 1 title A→Z, 2 Z→A, 3 videos first, 4 scenes first (each then by title),
    // 5 newest folder first, 6 oldest first; anything else = the folder's own order
    public static async Task<List<WallpaperResult>> ListAsync(string folder, bool scenes, bool presets, string? query, int sortIndex)
    {
        if (!Directory.Exists(folder)) return [];
        var cards = new List<WallpaperResult>();
        foreach (var dir in Directory.EnumerateDirectories(folder))
            if (await CardAsync(dir, scenes, presets, query) is { } card) cards.Add(card);

        var byTitle = StringComparer.OrdinalIgnoreCase;
        return sortIndex switch
        {
            1 => [.. cards.OrderBy((c) => c.Title, byTitle)],
            2 => [.. cards.OrderByDescending((c) => c.Title, byTitle)],
            3 => [.. cards.OrderBy((c) => c.IsScene).ThenBy((c) => c.Title, byTitle)],
            4 => [.. cards.OrderBy((c) => !c.IsScene).ThenBy((c) => c.Title, byTitle)],
            5 => [.. cards.OrderByDescending((c) => c.AddedAt)],
            6 => [.. cards.OrderBy((c) => c.AddedAt)],
            _ => cards,
        };
    }

    // null: no card, or one the query leaves out — decided before any picture is looked for, so a search copies or
    // extracts no GIF still for an item it doesn't list
    private static async Task<WallpaperResult?> CardAsync(string dir, bool scenes, bool presets, string? query)
    {
        string id = Path.GetFileName(dir);
        var project = await ReadAsync(Path.Combine(dir, "project.json"));
        string? type = project?.Type;
        bool scene = string.Equals(type, "scene", StringComparison.OrdinalIgnoreCase)
            || (project == null && File.Exists(Path.Combine(dir, "scene.pkg")));
        bool preset = !scene && project != null && type == null && Presets.Read(dir) is { BaseId: not null };
        bool video = string.Equals(type, "video", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(project!.File);
        if ((scene && !scenes) || (preset && !presets) || !(scene || preset || video)) return null;
        string title = string.IsNullOrEmpty(project?.Title) ? id : project.Title;
        if (!string.IsNullOrEmpty(query) && !title.Contains(query, StringComparison.OrdinalIgnoreCase)) return null;

        string page = dir, still;
        string? animated = null;
        if (video)
        {
            page = Path.Combine(dir, project!.File!);
            if (!File.Exists(page)) return null;
            (still, animated) = await VideoPicturesAsync(dir, id);
        }
        else still = FolderPicture(dir) ?? "";
        return new WallpaperResult
        {
            Title = title,
            ThumbnailUrl = still,
            AnimatedThumbnailUrl = animated,
            PageUrl = page,
            IsScene = !video,
            IsPreset = preset,
            WorkshopId = id,
            AddedAt = Directory.GetCreationTime(dir),
            Tags = project?.Tags,
            AgeRating = project?.Age,
        };
    }

    // null: no project.json, or one that isn't a JSON object with string fields where they're read
    private static async Task<Project?> ReadAsync(string file)
    {
        if (!File.Exists(file)) return null;
        try
        {
            await using var stream = File.OpenRead(file);
            using var json = await JsonDocument.ParseAsync(stream);
            var root = json.RootElement;
            string? Field(string name) => root.TryGetProperty(name, out var v) ? v.GetString() : null;
            var (age, tags) = WorkshopTags.FromProject(root);
            return new Project(Field("type"), Field("file"), Field("title"), tags.Length > 0 ? tags : null, age);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // A scene's or a preset's picture: preview.jpg, else the first GIF, PNG or JPEG in the folder
    private static string? FolderPicture(string dir) =>
        Existing(Path.Combine(dir, "preview.jpg")) ?? FirstOf(dir, "*.gif") ?? FirstOf(dir, "*.png") ?? FirstOf(dir, "*.jpg") ?? FirstOf(dir, "*.jpeg");

    // A video's still and, when the folder has a GIF, that GIF for the card to play. A GIF's still is preview.jpg, else the
    // GIF's first frame that isn't blank; either is kept in GifThumbCacheDir as <workshop id>.jpg. A GIF with no still to
    // show (no preview.jpg, no frame came out) is the still itself, not animated.
    private static async Task<(string Still, string? Animated)> VideoPicturesAsync(string dir, string id)
    {
        string? preview = Existing(Path.Combine(dir, "preview.jpg"));
        if (FirstOf(dir, "*.gif") is not { } gif)
            return (preview ?? FirstOf(dir, "*.png") ?? FirstOf(dir, "*.jpg") ?? FirstOf(dir, "*.jpeg") ?? "", null);

        string cached = Path.Combine(GifThumbCacheDir, id + ".jpg");
        Directory.CreateDirectory(GifThumbCacheDir);
        if (!File.Exists(cached))
        {
            if (preview != null) File.Copy(preview, cached, overwrite: true);
            else await ExtractGifStaticFrameAsync(gif, cached);
        }
        if (preview != null) return (preview, gif);
        return File.Exists(cached) ? (cached, gif) : (gif, null);
    }

    private static string? Existing(string file) => File.Exists(file) ? file : null;

    private static string? FirstOf(string dir, string pattern) =>
        Directory.EnumerateFiles(dir, pattern, SearchOption.TopDirectoryOnly).FirstOrDefault();

    // the videos' GIF stills (Settings' cache clear lists it: AppOps.CacheCategories "we-thumbs")
    internal static string GifThumbCacheDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "liascape", "we_thumbs");

    internal static async Task ExtractGifStaticFrameAsync(string gifPath, string outputPath)
    {
        string tmp = outputPath + ".tmp";
        try
        {
            // First non-black/white frame (YAVG between 30 and 225)
            try
            {
                await RunFfmpeg("-i", gifPath, "-vf", "signalstats,metadata=select:key=lavfi.signalstats.YAVG:value=30:function=greater,metadata=select:key=lavfi.signalstats.YAVG:value=225:function=less", "-frames:v", "1", tmp, "-y");
                if (File.Exists(tmp) && new FileInfo(tmp).Length > 0)
                {
                    File.Move(tmp, outputPath, overwrite: true);
                    return;
                }
            }
            catch { }

            // Fallback: frame 1
            if (File.Exists(tmp)) File.Delete(tmp);
            try
            {
                await RunFfmpeg("-i", gifPath, "-vf", "select=eq(n\\,1)", "-frames:v", "1", tmp, "-y");
                if (File.Exists(tmp) && new FileInfo(tmp).Length > 0)
                {
                    File.Move(tmp, outputPath, overwrite: true);
                    return;
                }
            }
            catch { }

            // Fallback: frame 0
            if (File.Exists(tmp)) File.Delete(tmp);
            try
            {
                await RunFfmpeg("-i", gifPath, "-frames:v", "1", tmp, "-y");
                if (File.Exists(tmp) && new FileInfo(tmp).Length > 0)
                    File.Move(tmp, outputPath, overwrite: true);
            }
            catch { }
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    private static async Task RunFfmpeg(params string[] args)
    {
        var psi = new ProcessStartInfo("ffmpeg")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var proc = Process.Start(psi);
        if (proc == null) return;
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            await proc.WaitForExitAsync(cts.Token);
            if (proc.ExitCode != 0) throw new InvalidOperationException($"ffmpeg exited with code {proc.ExitCode}");
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            using var killCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await proc.WaitForExitAsync(killCts.Token); } catch { }
            throw;
        }
    }
}
