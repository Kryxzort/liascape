using System;
using System.IO;
using System.Text.Json;
using livepaper.Models;

namespace livepaper.Helpers;

public static class SettingsService
{
    private static readonly string ConfigPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "livepaper", "settings.json");

    // Every request, the tick, the adapter and the daemons load + save this file concurrently. A save used to
    // truncate it and write in place, so a load that landed mid-write parsed nothing and got the C# defaults
    // (NoAudio on, volume 100, the legacy engine) — applied live, and saved back over everything by whoever
    // saved next (`/settings` itself: its `prev` became the defaults → an engine "switch", the Steam tokens
    // gone). The UI matrix's race:settingsSaveLoad cell caught 6/240. Now a save writes a temp file and renames
    // it over (atomic: a reader sees the old file or the new one), and a load that still can't parse (a writer
    // that isn't this code — an older build's daemon) retries before falling back to the defaults.
    public static AppSettings Load()
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(ConfigPath)) return new AppSettings();
                var json = File.ReadAllText(ConfigPath);
                return JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
            }
            catch (Exception e) when (e is JsonException or IOException)
            {
                if (attempt >= 4) return new AppSettings();
                System.Threading.Thread.Sleep(15);
            }
            catch { return new AppSettings(); }
        }
    }

    public static void Save(AppSettings settings)
    {
        var dir = Path.GetDirectoryName(ConfigPath)!;
        Directory.CreateDirectory(dir);
        // unique per writer: two saves at once must not share (and tear) one temp file
        var tmp = Path.Combine(dir, $".settings.json.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tmp, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, ConfigPath, overwrite: true);
        }
        finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
    }
}
