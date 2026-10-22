using System;
using System.Globalization;
using System.Text.Json;

namespace livepaper.Player;

// Legacy mpv IPC property commands → lp-player graph properties (see .claude/rules/player-adapter.md
// § Property map). PlayerHelper still speaks mpv (`SendCommand("set_property", "volume", 80)`); under
// PlayerEngine=lp-player its dispatch hands those args here and LpPlayerMedia.Set routes the result
// (source props → `srcs:*`, layer props → `lay:*:main`).
public static class MpvPropertyMap
{
    public const double SilentDb = -96.0;  // mpv volume-gain-min = lp-player's silent
    private const double MaxDb = 12.0;      // lp-player gain clamp

    // mpv's `volume` is CUBIC (50 → −18.06 dB, measured −18.07): gain = 60·log10(N/100) dB — the curve
    // users are used to. N ≤ 0 → silent (−96).
    public static double VolumeDb(double percent) =>
        percent <= 0 ? SilentDb : Math.Clamp(60.0 * Math.Log10(percent / 100.0), SilentDb, MaxDb);

    // `["set_property", name, value]` or `["set", name, "value"]` → (lp prop, typed value); anything it
    // can't express (another command, an unknown property, an unparseable value) → null + a log line.
    public static (string prop, object value)? Translate(object[] mpvArgs)
    {
        if (mpvArgs.Length < 3 || Str(mpvArgs[0]) is not ("set_property" or "set"))
            return Unknown(mpvArgs, "not a property set");
        var name = Str(mpvArgs[1]);
        var v = mpvArgs[2];
        switch (name)
        {
            case "volume": return Num(v) is double vol ? ("gain.user", VolumeDb(vol)) : Unknown(mpvArgs, "volume not a number");
            case "speed": return Num(v) is double sp ? ("speed", sp) : Unknown(mpvArgs, "speed not a number");
            case "mute": return Bool(v) is bool m ? ("gain.mute", m ? SilentDb : 0.0) : Unknown(mpvArgs, "mute not a bool");
            case "pause": return Bool(v) is bool p ? ("paused", p) : Unknown(mpvArgs, "pause not a bool");
            case "loop-file":
            case "loop":
                {
                    var s = Str(v);
                    if (s is "inf" or "yes" or "force") return ("loop", true);
                    if (Bool(v) is bool lb) return ("loop", lb);
                    return Num(v) is double n ? ("loop", n > 0) : Unknown(mpvArgs, "loop value");
                }
            // legacy VideoScale: fill = panscan 1.0, fit = panscan 0.0 → the layer's `fit`
            case "panscan": return Num(v) is double ps ? ("fit", ps >= 0.5 ? "fill" : "fit") : Unknown(mpvArgs, "panscan not a number");
            case "vf":
                {
                    var s = Str(v) ?? "";
                    if (s.Length == 0) return ("fps_cap", 0.0);
                    if (s.StartsWith("fps=", StringComparison.Ordinal)
                        && double.TryParse(s[4..], NumberStyles.Float, CultureInfo.InvariantCulture, out var fps))
                        return ("fps_cap", fps);
                    return Unknown(mpvArgs, "only vf fps=N maps (fps_cap)");
                }
            case "hwdec": return ("hwdec", Str(v) ?? "");
            case "cache": return ("cache", Str(v) is not ("no" or "false") && Bool(v) != false);
            case "demuxer-max-bytes": return Mib(v) is double mx ? ("demuxer_max_mib", mx) : Unknown(mpvArgs, "byte size");
            case "demuxer-max-back-bytes": return Mib(v) is double bk ? ("demuxer_back_mib", bk) : Unknown(mpvArgs, "byte size");
            case "af": return ("af", Str(v) ?? "");
            case "aid": return ("no_audio", Str(v) is "no" or "false" || Bool(v) == false);
        }
        return Unknown(mpvArgs, "no lp-player equivalent");
    }

    private static (string, object)? Unknown(object[] a, string why)
    {
        LpPlayerClient.Log($"MpvPropertyMap: `{string.Join(" ", a)}` not translated ({why})");
        return null;
    }

    private static string? Str(object? o) => o switch
    {
        null => null,
        string s => s,
        JsonElement { ValueKind: JsonValueKind.String } j => j.GetString(),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => o.ToString(),
    };

    private static double? Num(object? o) => o switch
    {
        double d => d,
        float f => f,
        int i => i,
        long l => l,
        decimal m => (double)m,
        JsonElement { ValueKind: JsonValueKind.Number } j => j.GetDouble(),
        _ => double.TryParse(Str(o), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null,
    };

    private static bool? Bool(object? o) => o switch
    {
        bool b => b,
        JsonElement { ValueKind: JsonValueKind.True } => true,
        JsonElement { ValueKind: JsonValueKind.False } => false,
        _ => Str(o) switch { "yes" or "true" => true, "no" or "false" => false, _ => null },
    };

    // mpv byte sizes ("20MiB", "512KiB", "1GiB", raw bytes) → MiB
    private static double? Mib(object? o)
    {
        var s = (Str(o) ?? "").Trim();
        double mult = 1.0 / 1048576.0;
        foreach (var (suf, m) in new[] { ("GiB", 1024.0), ("MiB", 1.0), ("KiB", 1.0 / 1024.0) })
            if (s.EndsWith(suf, StringComparison.OrdinalIgnoreCase)) { s = s[..^suf.Length]; mult = m; break; }
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n * mult : null;
    }
}
