using System;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace Liascape.Helpers;

// Shared state files (playlist_state.json, the library's index.json, …) are read by every request, the tick,
// the adapter and the daemons while someone saves them. A save that truncates and writes in place lets a read
// land mid-write: it parses nothing — a null playlist (the UI then showed an empty playlist bar with the DEFAULT
// playlist settings and saved those back), an empty index (every override read as "follows the global";
// SetMeta wrote that empty index + one entry back over everything). UI matrix race:playlistSaveLoad /
// race:indexSaveLoad. Same fix as SettingsService: write a temp file and rename it over (atomic — a reader
// sees the old file or the new one), and a read that still can't parse (a writer that isn't this code, e.g.
// an older build's daemon) is retried before the caller's fallback.
public static class AtomicFile
{
    public static void WriteAllText(string path, string text)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        // unique per writer: two saves at once must not share (and tear) one temp file
        var tmp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tmp, text);
            File.Move(tmp, path, overwrite: true);
        }
        finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
    }

    // Like WriteAllText, but the file is the user's alone (0600) from the moment it exists: the temp file is created 0600
    // and the rename keeps that mode — never a window where another user could read it (settings.json, the secret
    // store's fallback file: web-backend.md § Local API security).
    public static void WritePrivate(string path, string text)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
#pragma warning disable CA1416 // Unix file modes: this backend is Linux-only
            using (var fs = new FileStream(tmp, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            }))
#pragma warning restore CA1416
            using (var w = new StreamWriter(fs, new System.Text.UTF8Encoding(false)))
                w.Write(text);
            File.Move(tmp, path, overwrite: true);
        }
        finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
    }

    // Deserialize `path`, retrying a file that doesn't parse (torn by an in-place writer) a few times.
    // Missing → default. Still unparsable → throws the last JsonException (the caller decides the fallback).
    public static T? ReadJson<T>(string path, JsonSerializerOptions? opts = null)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(path)) return default;
                return JsonSerializer.Deserialize<T>(File.ReadAllText(path), opts);
            }
            catch (Exception e) when ((e is JsonException or IOException) && attempt < 4) { Thread.Sleep(15); }
        }
    }
}
