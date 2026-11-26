using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

// The playlist bar (playlist_state.json in the config folder: its items, settings and the name it was saved under) and the
// playlists saved by name (one <name>.json each in the data folder's playlists/). Written atomically and read with a
// retried parse (AtomicFile): a read landing mid-save got nothing, and the page showed an empty bar with the default
// settings. Guard: matrix race:playlistSaveLoad.
public static class PlaylistService
{
    private static string BarFile => Path.Combine(AppDirs.Config, "playlist_state.json");
    private static string SavedFolder => Path.Combine(AppDirs.Data, "playlists");
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    // null: no bar saved yet, or one that can't be read
    public static CustomPlaylist? LoadCurrentState() => Read(BarFile);

    // never throws: the bar follows what plays, and a play doesn't fail on it
    public static void SaveCurrentState(CustomPlaylist playlist)
    {
        try { Write(BarFile, playlist); }
        catch { }
    }

    // the saved playlists' names, A to Z whatever the case
    public static List<string> ListNames() => !Directory.Exists(SavedFolder) ? []
        : Directory.EnumerateFiles(SavedFolder, "*.json").Select(Path.GetFileNameWithoutExtension).OfType<string>()
            .Where((n) => n.Length > 0).Order(StringComparer.OrdinalIgnoreCase).ToList();

    public static void Save(string name, CustomPlaylist playlist) => Write(SavedFile(name), playlist);

    public static CustomPlaylist? Load(string name) => Read(SavedFile(name));

    // a name is a file name: what a file name can't hold is left out, and a name left empty is "playlist"
    private static string SavedFile(string name) =>
        Path.Combine(SavedFolder, (LibraryService.SanitizeName(name) is { Length: > 0 } file ? file : "playlist") + ".json");

    private static CustomPlaylist? Read(string file)
    {
        try { return AtomicFile.ReadJson<CustomPlaylist>(file); }
        catch { return null; }
    }

    // The rotation as every save stores it (PlaylistSettings.NormalizeRotation), in the caller's copy too: a playlist play
    // applies it live from that copy.
    private static void Write(string file, CustomPlaylist playlist)
    {
        playlist.Settings?.NormalizeRotation();
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        AtomicFile.WriteAllText(file, JsonSerializer.Serialize(playlist, Indented));
    }
}
