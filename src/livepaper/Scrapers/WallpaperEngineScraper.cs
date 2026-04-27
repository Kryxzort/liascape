using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using livepaper.Models;

namespace livepaper.Scrapers;

public static class WallpaperEngineScraper
{
    public static async Task<List<WallpaperResult>> GetAllAsync(string workshopPath, bool allowScenes = false)
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
            string? thumbnail = FindThumbnail(dir);

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
                    ThumbnailUrl = thumbnail ?? "",
                    PageUrl = dir,
                    IsScene = true,
                    WorkshopId = workshopId
                });
                continue;
            }

            if (info == null) continue;
            if (!string.Equals(info.Type, "video", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.IsNullOrEmpty(info.File)) continue;

            var videoPath = Path.Combine(dir, info.File);
            if (!File.Exists(videoPath)) continue;

            results.Add(new WallpaperResult
            {
                Title = title,
                ThumbnailUrl = thumbnail ?? "",
                PageUrl = videoPath,
                WorkshopId = workshopId
            });
        }

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

    private static string? FindThumbnail(string dir)
    {
        // prefer preview.jpg, then any image file
        string preview = Path.Combine(dir, "preview.jpg");
        if (File.Exists(preview)) return preview;

        foreach (string ext in new[] { "*.gif", "*.png", "*.jpg", "*.jpeg" })
        {
            var files = Directory.GetFiles(dir, ext, SearchOption.TopDirectoryOnly);
            if (files.Length > 0) return files[0];
        }
        return null;
    }
}
