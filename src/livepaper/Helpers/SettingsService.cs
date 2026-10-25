using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
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

    // POST /settings has PATCH semantics. Its body used to be bound as the whole AppSettings, so a partial
    // one ({"Volume": 50} from an agent) reset every field it left out to its C# default — ~15 once,
    // LweMonitors and PlayerEngine among them (→ a live engine switch). The API's own binding options
    // (web defaults: camelCase or PascalCase keys, numbers in strings) bind each key it does have.
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);
    private static readonly Dictionary<string, PropertyInfo> Fields = typeof(AppSettings)
        .GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(p => p.CanRead && p.CanWrite && p.GetIndexParameters().Length == 0)
        .ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
    private static readonly object PatchLock = new();

    // `saved` with the fields `body` has laid over it; every field the body leaves out keeps its saved
    // value. The body is bound exactly like the old whole-body binding (same deserializer + options: the
    // setters' clamps, a bad value throws JsonException) and only the keys it HAS are copied over — so the
    // UI's whole copy still gives exactly what it gave before. A value replaces its field as a unit: an array
    // (LweMonitors, GlobalTransitionEffectIds) is the whole new list, never merged by element; an object
    // (LastSession) the whole new object. An explicit null sets null (on a value-type field it's a bad
    // value). Unknown keys are ignored, as before (e.g. the removed LweSilent). `saved` is never touched.
    public static AppSettings Merge(AppSettings saved, JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object) throw new JsonException("the settings body must be a JSON object");
        var posted = body.Deserialize<AppSettings>(WebJson)!;
        var merged = JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(saved))!; // a deep copy
        foreach (var key in body.EnumerateObject())
            if (Fields.TryGetValue(key.Name, out var f)) f.SetValue(merged, f.GetValue(posted));
        return merged;
    }

    // POST /settings: load → Merge the body over it → save. The fields the backend owns keep their saved
    // values whatever the body says: the UI caches the whole AppSettings at load and re-POSTs it on every
    // change, and its copy of LastSession (apply/random/next write it) and the Steam tokens (QR sign-in)
    // is stale — they're never edited through the form. One poster at a time, so parallel partial bodies
    // all land (each merges over the previous one's save, not over the same load). `prev` = what was saved.
    public static (AppSettings Prev, AppSettings Cur) Patch(JsonElement body)
    {
        lock (PatchLock)
        {
            var prev = Load();
            var s = Merge(prev, body);
            s.LastSession = prev.LastSession;
            s.SteamRefreshToken = prev.SteamRefreshToken;
            s.SteamAccessToken = prev.SteamAccessToken;
            s.SteamAccountName = prev.SteamAccountName;
            s.SteamLoginSecure = prev.SteamLoginSecure;
            Save(s);
            return (prev, s);
        }
    }
}
