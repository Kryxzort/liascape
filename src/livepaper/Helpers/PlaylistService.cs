using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using livepaper.Models;

namespace livepaper.Helpers;

public static class PlaylistService
{
    public static readonly string PlaylistsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "livepaper", "playlists");

    public static string CurrentStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "livepaper", "playlist_state.json");

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    public static CustomPlaylist? LoadCurrentState()
    {
        if (!File.Exists(CurrentStatePath)) return null;
        try { return JsonSerializer.Deserialize<CustomPlaylist>(File.ReadAllText(CurrentStatePath)); }
        catch { return null; }
    }

    public static void SaveCurrentState(CustomPlaylist playlist)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CurrentStatePath)!);
            File.WriteAllText(CurrentStatePath, JsonSerializer.Serialize(playlist, JsonOpts));
        }
        catch { }
    }

    public static List<string> ListNames()
    {
        if (!Directory.Exists(PlaylistsPath)) return [];
        return Directory.GetFiles(PlaylistsPath, "*.json")
            .Select(Path.GetFileNameWithoutExtension)
            .Where(n => !string.IsNullOrEmpty(n))
            .Select(n => n!)
            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static void Save(string name, CustomPlaylist playlist)
    {
        Directory.CreateDirectory(PlaylistsPath);
        string path = Path.Combine(PlaylistsPath, Sanitize(name) + ".json");
        File.WriteAllText(path, JsonSerializer.Serialize(playlist, JsonOpts));
    }

    public static CustomPlaylist? Load(string name)
    {
        string path = Path.Combine(PlaylistsPath, Sanitize(name) + ".json");
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<CustomPlaylist>(File.ReadAllText(path));
        }
        catch
        {
            return null;
        }
    }

    public static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Where(c => !invalid.Contains(c)).ToArray()).Trim();
        return string.IsNullOrEmpty(clean) ? "playlist" : clean;
    }
}
