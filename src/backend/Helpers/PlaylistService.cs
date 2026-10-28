using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

public static class PlaylistService
{
    public static readonly string PlaylistsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "liascape", "playlists");

    public static string CurrentStatePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "playlist_state.json");

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    // Atomic save + a retried load (AtomicFile): written in place, a read mid-save (the UI's init, the tick's
    // transition config, /settings) got null — the UI showed an empty playlist bar with the DEFAULT playlist settings.
    public static CustomPlaylist? LoadCurrentState()
    {
        try { return AtomicFile.ReadJson<CustomPlaylist>(CurrentStatePath); }
        catch { return null; }
    }

    public static void SaveCurrentState(CustomPlaylist playlist)
    {
        try { AtomicFile.WriteAllText(CurrentStatePath, JsonSerializer.Serialize(playlist, JsonOpts)); }
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
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(playlist, JsonOpts));
    }

    public static CustomPlaylist? Load(string name)
    {
        string path = Path.Combine(PlaylistsPath, Sanitize(name) + ".json");
        try { return AtomicFile.ReadJson<CustomPlaylist>(path); }
        catch { return null; }
    }

    public static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Where(c => !invalid.Contains(c)).ToArray()).Trim();
        return string.IsNullOrEmpty(clean) ? "playlist" : clean;
    }
}
