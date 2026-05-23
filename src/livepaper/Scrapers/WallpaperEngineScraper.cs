using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Models;

namespace livepaper.Scrapers;

public static class WallpaperEngineScraper
{
    public static async Task<List<WallpaperResult>> GetAllAsync(string workshopPath, bool allowScenes = false, string query = "", int sortIndex = 0)
    {
        var results = new List<WallpaperResult>();

        if (!Directory.Exists(workshopPath))
            return results;

        // WE workshop layout: <workshopPath>/<wallpaperId>/{project.json, <video>, preview.*, ...}
        // Drive discovery from project.json so we pick up any video format
        // mpv supports (mp4, webm, mov, mkv, ...) while filtering out
        // non-video wallpaper types ("web", "application").
        foreach (var dir in Directory.EnumerateDirectories(workshopPath))
        {
            var info = await ReadProjectAsync(dir);

            string workshopId = Path.GetFileName(dir);
            string title = (info != null && !string.IsNullOrEmpty(info.Title))
                ? info.Title : workshopId;
            var addedAt = Directory.GetCreationTime(dir);

            // Scene detection: type == "scene" OR scene.pkg present
            bool hasScene = File.Exists(Path.Combine(dir, "scene.pkg"));
            bool isScene = (info != null && string.Equals(info.Type, "scene", StringComparison.OrdinalIgnoreCase))
                || (info == null && hasScene);

            if (isScene)
            {
                if (!allowScenes) continue;
                results.Add(new WallpaperResult
                {
                    Title = title,
                    ThumbnailUrl = FindThumbnail(dir) ?? "",
                    PageUrl = dir,
                    IsScene = true,
                    WorkshopId = workshopId,
                    AddedAt = addedAt
                });
                continue;
            }

            if (info == null) continue;
            if (!string.Equals(info.Type, "video", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.IsNullOrEmpty(info.File)) continue;

            if (!string.IsNullOrEmpty(query) && !title.Contains(query, StringComparison.OrdinalIgnoreCase))
                continue;

            var videoPath = Path.Combine(dir, info.File);
            if (!File.Exists(videoPath)) continue;

            var (thumbnail, animatedGif) = await FindThumbnailAsync(dir);

            results.Add(new WallpaperResult
            {
                Title = title,
                ThumbnailUrl = thumbnail ?? "",
                AnimatedThumbnailUrl = animatedGif,
                PageUrl = videoPath,
                WorkshopId = workshopId,
                AddedAt = addedAt
            });
        }


        results = sortIndex switch
        {
            1 => [.. results.OrderBy(r => r.Title, StringComparer.OrdinalIgnoreCase)],
            2 => [.. results.OrderByDescending(r => r.Title, StringComparer.OrdinalIgnoreCase)],
            3 => [.. results.OrderBy(r => r.IsScene).ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase)],
            4 => [.. results.OrderByDescending(r => r.IsScene).ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase)],
            5 => [.. results.OrderByDescending(r => r.AddedAt ?? DateTime.MinValue)],
            6 => [.. results.OrderBy(r => r.AddedAt ?? DateTime.MaxValue)],
            _ => results
        };

        return results;
    }

    private record ProjectInfo(string? Type, string? File, string? Title);

    private static async Task<ProjectInfo?> ReadProjectAsync(string dir)
    {
        string projectJson = Path.Combine(dir, "project.json");
        if (!File.Exists(projectJson)) return null;

        try
        {
            using var stream = File.OpenRead(projectJson);
            var doc = await JsonDocument.ParseAsync(stream);
            var root = doc.RootElement;
            return new ProjectInfo(
                Type: root.TryGetProperty("type", out var t) ? t.GetString() : null,
                File: root.TryGetProperty("file", out var f) ? f.GetString() : null,
                Title: root.TryGetProperty("title", out var ti) ? ti.GetString() : null
            );
        }
        catch
        {
            return null;
        }
    }

    private static string GifThumbCacheDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "livepaper", "we_thumbs");

    // Returns (staticPath, animatedGifPath). animatedGifPath is non-null when a GIF
    // exists in the directory. Checks for GIF before preview.jpg so videos with both
    // get animated thumbnails.
    private static async Task<(string? Static, string? AnimatedGif)> FindThumbnailAsync(string dir)
    {
        string workshopId = Path.GetFileName(dir);
        string preview = Path.Combine(dir, "preview.jpg");
        string? gifPath = Directory.GetFiles(dir, "*.gif", SearchOption.TopDirectoryOnly).FirstOrDefault();

        if (gifPath != null)
        {
            string cacheDir = GifThumbCacheDir;
            string staticCache = Path.Combine(cacheDir, $"{workshopId}.jpg");

            if (File.Exists(preview))
            {
                // Cache preview.jpg so library cards find it in we_thumbs and show it immediately.
                if (!File.Exists(staticCache))
                {
                    Directory.CreateDirectory(cacheDir);
                    File.Copy(preview, staticCache);
                }
                return (preview, gifPath);
            }

            Directory.CreateDirectory(cacheDir);
            if (!File.Exists(staticCache))
                await ExtractGifStaticFrameAsync(gifPath, staticCache);
            return File.Exists(staticCache) ? (staticCache, gifPath) : (gifPath, null);
        }

        if (File.Exists(preview)) return (preview, null);

        foreach (string ext in new[] { "*.png", "*.jpg", "*.jpeg" })
        {
            var files = Directory.GetFiles(dir, ext, SearchOption.TopDirectoryOnly);
            if (files.Length > 0) return (files[0], null);
        }

        return (null, null);
    }

    private static string? FindThumbnail(string dir)
    {
        string preview = Path.Combine(dir, "preview.jpg");
        if (File.Exists(preview)) return preview;

        foreach (string ext in new[] { "*.gif", "*.png", "*.jpg", "*.jpeg" })
        {
            var files = Directory.GetFiles(dir, ext, SearchOption.TopDirectoryOnly);
            if (files.Length > 0) return files[0];
        }
        return null;
    }

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
