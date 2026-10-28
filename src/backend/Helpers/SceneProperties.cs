using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Liascape.Helpers;

// A Wallpaper Engine scene's user properties (`project.json` → `general.properties`) — what the item
// settings modal edits. `.claude/rules/library.md` § "Scene properties".
//
// Values are kept in WE's own encoding (what `project.json` and LWE's `--set-property name=value` use):
// bool → true/false, slider → a number, color → "r g b" (0–1 floats), combo → the option's key (a string; a
// numeric key as LWE parses it — `std::to_string(value.get<int>())`), textinput → a string. The player gets
// `ToPlayer` of them (a colour as [r, g, b], what `wp_project_property_set_color_by_name` takes).
//
// Types (the corpus: 96 SFW scenes, 2070 properties): slider, bool, color, combo, textinput are editable;
// text (and a missing / "Text" type — HTML labels) and group are labels; scenetexture / file / directory
// need a file picker and usershortcut is a Windows app launcher — listed as not editable. `condition`
// (a JS expression over `<name>.value`) decides visibility, evaluated like WE's JS (loose ==, truthiness).
public sealed class SceneProp
{
    public string Name { get; init; } = "";
    public string Type { get; init; } = "";      // lowercased; "text" for an untyped/"Text" label
    public string Label { get; init; } = "";     // HTML stripped, `ui_*` keys humanised
    public double Order { get; init; }
    public string? Condition { get; init; }
    public bool Editable { get; init; }
    public string? Unsupported { get; init; }    // why an input-ish type can't be edited here
    public JsonNode? Default { get; init; }      // WE encoding; null for labels
    public double? Min { get; init; }
    public double? Max { get; init; }
    public double? Step { get; init; }
    public bool Fraction { get; init; } = true;
    public int? Precision { get; init; }
    public List<SceneComboOption>? Options { get; init; }
}

public sealed record SceneComboOption(string Label, string Value);

public static class SceneProperties
{
    public static readonly string[] EditableTypes = ["bool", "slider", "color", "combo", "textinput"];
    public const int MaxText = 4096;

    // ---- parsing -----------------------------------------------------------------------------------

    // `project.json` of a scene item folder (a `local/<id>` symlink resolves). Cached by (path, mtime, size).
    private static readonly Dictionary<string, (DateTime Mtime, long Size, List<SceneProp> Props)> _cache = new();
    private static readonly object _cacheLock = new();

    public static List<SceneProp> ForItem(string sceneDir)
    {
        var file = Path.Combine(sceneDir, "project.json");
        FileInfo fi;
        try { fi = new FileInfo(file); if (!fi.Exists) return []; } catch { return []; }
        lock (_cacheLock)
            if (_cache.TryGetValue(file, out var c) && c.Mtime == fi.LastWriteTimeUtc && c.Size == fi.Length) return c.Props;
        List<SceneProp> props;
        try { props = Parse(File.ReadAllText(file)); } catch { props = []; }
        lock (_cacheLock) _cache[file] = (fi.LastWriteTimeUtc, fi.Length, props);
        return props;
    }

    public static SceneProp? Find(string sceneDir, string name) => ForItem(sceneDir).FirstOrDefault(p => p.Name == name);

    // `project.json` text → its properties in display order (WE's `order`, then `index`, then file order).
    // Anything malformed is skipped, never thrown: a scene's own file must not break its settings modal.
    public static List<SceneProp> Parse(string json)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(json.TrimStart('﻿'), documentOptions: new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }); }
        catch { return []; }
        if (root?["general"]?["properties"] is not JsonObject props) return [];
        var list = new List<(SceneProp P, int Pos)>();
        int pos = 0;
        foreach (var (name, node) in props)
        {
            pos++;
            if (node is not JsonObject o || string.IsNullOrEmpty(name)) continue;
            try { if (ParseOne(name, o, pos) is { } p) list.Add((p, pos)); } catch { }
        }
        return list.OrderBy(x => x.P.Order).ThenBy(x => x.Pos).Select(x => x.P).ToList();
    }

    private static SceneProp? ParseOne(string name, JsonObject o, int pos)
    {
        string rawType = Str(o["type"]) ?? "";
        string type = rawType.Trim().ToLowerInvariant();
        if (type == "") type = "text"; // untyped = a label (LWE: a group); the corpus has 40, all HTML text
        double order = Num(o["order"]) ?? Num(o["index"]) ?? 1e6 + pos;
        string? cond = Str(o["condition"]) is { } c && c.Trim().Length > 0 ? c.Trim() : null;
        string label = CleanLabel(Str(o["text"]), type is "text" or "group" ? "" : name);
        var v = o["value"];
        switch (type)
        {
            case "bool":
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond, Editable = true,
                    Default = JsonValue.Create(Truthy(v)) };
            case "slider":
            {
                double? min = Num(o["min"]), max = Num(o["max"]), step = Num(o["step"]);
                bool fraction = o["fraction"] is JsonNode f ? Truthy(f) : true;
                int? precision = Num(o["precision"]) is double pr ? (int)Math.Clamp(pr, 0, 8) : null;
                double val = Num(v) ?? min ?? 0;
                // a default outside its own range (corpus: 0.4 with min 0.5) widens the range, so the slider can
                // show it and a reset round-trips
                if (min is double lo0 && max is double hi0 && hi0 > lo0) { min = Math.Min(lo0, val); max = Math.Max(hi0, val); }
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond, Editable = true,
                    Default = JsonValue.Create(val), Min = min, Max = max, Step = step is > 0 ? step : null, Fraction = fraction, Precision = precision };
            }
            case "color":
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond, Editable = true,
                    Default = JsonValue.Create(FormatColor(ParseColor(v) ?? [1, 1, 1])) };
            case "combo":
            {
                var opts = new List<SceneComboOption>();
                if (o["options"] is JsonArray arr)
                    foreach (var on in arr)
                        if (on is JsonObject oo && ComboKey(oo["value"]) is string key && !opts.Any(x => x.Value == key))
                            opts.Add(new SceneComboOption(CleanLabel(Str(oo["label"]), key), key));
                if (opts.Count == 0) return null; // LWE requires options; nothing to pick
                string def = ComboKey(v) is string k && opts.Any(x => x.Value == k) ? k : opts[0].Value;
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond, Editable = true,
                    Default = JsonValue.Create(def), Options = opts };
            }
            case "textinput":
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond, Editable = true,
                    Default = JsonValue.Create(v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : v?.ToJsonString() ?? "") };
            case "text":
            case "group":
                if (label.Length == 0) return null; // an image-only / empty label: nothing to show (no remote images)
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond };
            case "scenetexture":
            case "file":
            case "directory":
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond,
                    Unsupported = "needs a file picker — not supported yet" };
            case "usershortcut":
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond,
                    Unsupported = "a Windows app shortcut — no meaning on Linux" };
            default:
                return new SceneProp { Name = name, Type = type, Label = label, Order = order, Condition = cond,
                    Unsupported = $"unknown property type \"{rawType}\"" };
        }
    }

    // ---- values ------------------------------------------------------------------------------------

    // A value from the UI → WE's encoding for `p`, or an error. Equal to the default → the caller drops the
    // override ("use the scene's own").
    public static (JsonNode? Value, string? Error) Coerce(SceneProp p, JsonElement v)
    {
        if (!p.Editable) return (null, $"{p.Name}: {p.Type} properties can't be set here ({p.Unsupported ?? "a label"})");
        switch (p.Type)
        {
            case "bool":
                return v.ValueKind switch
                {
                    JsonValueKind.True => (JsonValue.Create(true), null),
                    JsonValueKind.False => (JsonValue.Create(false), null),
                    JsonValueKind.String when v.GetString() is "true" or "1" => (JsonValue.Create(true), null),
                    JsonValueKind.String when v.GetString() is "false" or "0" => (JsonValue.Create(false), null),
                    JsonValueKind.Number => (JsonValue.Create(v.GetDouble() != 0), null),
                    _ => (null, $"{p.Name}: expected true or false"),
                };
            case "slider":
            {
                double? d = v.ValueKind == JsonValueKind.Number ? v.GetDouble()
                    : v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var ds) ? ds : null;
                if (d is not double x || double.IsNaN(x) || double.IsInfinity(x)) return (null, $"{p.Name}: expected a number");
                if (p.Min is double lo && p.Max is double hi && hi > lo) x = Math.Clamp(x, lo, hi);
                if (!p.Fraction) x = Math.Round(x);
                return (JsonValue.Create(x), null);
            }
            case "color":
                return ParseColor(v) is { } c ? (JsonValue.Create(FormatColor(c)), null) : (null, $"{p.Name}: expected a colour (\"r g b\" 0–1, [r, g, b] or #rrggbb)");
            case "combo":
            {
                string? key = v.ValueKind switch
                {
                    JsonValueKind.String => v.GetString(),
                    JsonValueKind.Number => ComboKey(JsonNode.Parse(v.GetRawText())),
                    _ => null,
                };
                return key != null && p.Options!.Any(o => o.Value == key) ? (JsonValue.Create(key), null)
                    : (null, $"{p.Name}: not one of its options ({string.Join(", ", p.Options!.Select(o => o.Value))})");
            }
            case "textinput":
                if (v.ValueKind != JsonValueKind.String) return (null, $"{p.Name}: expected text");
                var t = v.GetString()!;
                return t.Length > MaxText ? (null, $"{p.Name}: longer than {MaxText} characters") : (JsonValue.Create(t), null);
        }
        return (null, $"{p.Name}: can't be set");
    }

    // Two WE values of `p` mean the same (a colour by its components, a slider within 1e-9).
    public static bool SameValue(SceneProp p, JsonNode? a, JsonNode? b) => (ToPlayer(p, a), ToPlayer(p, b)) switch
    {
        (double x, double y) => Math.Abs(x - y) < 1e-9,
        (double[] x, double[] y) => x.Zip(y).All(z => Math.Abs(z.First - z.Second) < 1e-6),
        var (x, y) => Equals(x, y),
    };

    // WE encoding → what the player's `scene_props` carries (player-core.md § Scene worker → "User properties").
    public static object? ToPlayer(SceneProp p, JsonNode? v) => p.Type switch
    {
        "bool" => Truthy(v),
        "slider" => Num(v) ?? 0.0,
        "color" => ParseColor(v) is { } c ? c : new double[] { 1, 1, 1 },
        "combo" or "textinput" => Str(v) ?? v?.ToJsonString() ?? "",
        _ => null,
    };

    // LWE's `--set-property name=value` text (legacy engine): PropertyBoolean "true"/"false", PropertySlider
    // `stof`, PropertyColor `ColorBuilder::parse` ("r g b"), combo key / text as is.
    public static string ToCli(SceneProp p, JsonNode? v) => p.Type switch
    {
        "bool" => Truthy(v) ? "true" : "false",
        "slider" => (Num(v) ?? 0).ToString("R", CultureInfo.InvariantCulture),
        "color" => FormatColor(ParseColor(v) ?? [1, 1, 1]),
        _ => Str(v) ?? "",
    };

    // The item's saved overrides (index), the parsed properties, merged: name → effective WE value.
    public static Dictionary<string, JsonNode?> Effective(IReadOnlyList<SceneProp> props, IReadOnlyDictionary<string, JsonElement>? overrides,
        IReadOnlyDictionary<string, JsonElement>? transient = null)
    {
        var d = new Dictionary<string, JsonNode?>();
        foreach (var p in props)
        {
            if (!p.Editable) continue;
            JsonNode? v = p.Default;
            if (overrides != null && overrides.TryGetValue(p.Name, out var ov) && Coerce(p, ov) is ({ } c, null)) v = c;
            if (transient != null && transient.TryGetValue(p.Name, out var tv) && Coerce(p, tv) is ({ } t, null)) v = t;
            d[p.Name] = v;
        }
        return d;
    }

    // The player's `scene_props` map for an item: every override (+ transient) that names an editable property of
    // its project.json, encoded for the player. Defaults aren't sent — LWE loads them itself.
    public static SortedDictionary<string, object?> PlayerMap(string sceneDir, IReadOnlyDictionary<string, JsonElement>? overrides,
        IReadOnlyDictionary<string, JsonElement>? transient = null)
    {
        var m = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        if ((overrides == null || overrides.Count == 0) && (transient == null || transient.Count == 0)) return m;
        var props = ForItem(sceneDir);
        foreach (var p in props)
        {
            if (!p.Editable) continue;
            JsonNode? v = null;
            if (overrides != null && overrides.TryGetValue(p.Name, out var ov) && Coerce(p, ov) is ({ } c, null)) v = c;
            if (transient != null && transient.TryGetValue(p.Name, out var tv) && Coerce(p, tv) is ({ } t, null)) v = t;
            if (v != null) m[p.Name] = ToPlayer(p, v);
        }
        return m;
    }

    // Legacy engine: `--set-property name=value` per override (LWE applies them at launch only — it has no live
    // property IPC, so under legacy a change shows at the scene's next start).
    public static List<string> CliArgs(string sceneDir, IReadOnlyDictionary<string, JsonElement>? overrides)
    {
        var args = new List<string>();
        if (overrides == null || overrides.Count == 0) return args;
        foreach (var p in ForItem(sceneDir))
            if (p.Editable && overrides.TryGetValue(p.Name, out var ov) && Coerce(p, ov) is ({ } c, null))
            {
                args.Add("--set-property");
                args.Add($"{p.Name}={ToCli(p, c)}");
            }
        return args;
    }

    // The player-encoded default of `name` (a reset: LWE has no "reset to default", so the default is sent).
    public static object? PlayerDefault(string sceneDir, string name) =>
        Find(sceneDir, name) is { Editable: true } p ? ToPlayer(p, p.Default) : null;

    // ---- the payload of GET /library/scene-props ----------------------------------------------------

    public static object Describe(string sceneDir, IReadOnlyDictionary<string, JsonElement>? overrides)
    {
        var props = ForItem(sceneDir);
        var eff = Effective(props, overrides);
        return props.Select(p =>
        {
            bool overridden = p.Editable && overrides != null && overrides.ContainsKey(p.Name);
            return new
            {
                name = p.Name, type = p.Type, label = p.Label, order = p.Order, condition = p.Condition,
                visible = Visible(p.Condition, eff), editable = p.Editable, unsupported = p.Unsupported,
                @default = p.Default, value = p.Editable ? eff[p.Name] : null, overridden,
                min = p.Min, max = p.Max, step = p.Step, fraction = p.Fraction, precision = p.Precision,
                options = p.Options,
            };
        }).ToList();
    }

    // ---- conditions ---------------------------------------------------------------------------------

    // WE shows a property when its `condition` (JS, e.g. `a.value && (b.value || c.value == "3")`) is truthy.
    // A subset of JS evaluated here: `name.value` (the effective value: bool / number / combo key or text as a
    // string), literals (true, false, numbers, '…'/"…"), ! && || == != === !== < <= > >=, parentheses, and
    // `x.value = v` (an assignment in WE's JS — evaluates to v). Loose equality like JS (a bool or a numeric
    // string compares as a number). Anything it can't parse → visible (never hide a control by mistake).
    public static bool Visible(string? condition, IReadOnlyDictionary<string, JsonNode?> values)
    {
        if (string.IsNullOrWhiteSpace(condition)) return true;
        try
        {
            var e = new Cond(condition, values);
            var r = e.Or();
            e.Skip();
            return e.AtEnd ? Truth(r) : true;
        }
        catch { return true; }
    }

    // Does the evaluator understand `condition` (self-test: every condition of the real corpus must)?
    public static bool ConditionParses(string condition)
    {
        try { var e = new Cond(condition, new Dictionary<string, JsonNode?>()) { LenientIds = true }; e.Or(); e.Skip(); return e.AtEnd; }
        catch { return false; }
    }

    private sealed class Cond(string s, IReadOnlyDictionary<string, JsonNode?> values)
    {
        // a bare identifier (not `<name>.value`, not a literal) is a ReferenceError in WE's JS: evaluation gives up
        // (→ visible); `ConditionParses` only checks the syntax
        public bool LenientIds { get; init; }
        private int _i;
        public bool AtEnd => _i >= s.Length;
        public void Skip() { while (_i < s.Length && char.IsWhiteSpace(s[_i])) _i++; }
        private bool Eat(string tok)
        {
            Skip();
            if (string.CompareOrdinal(s, _i, tok, 0, tok.Length) != 0) return false;
            _i += tok.Length; return true;
        }
        public object? Or() { var l = And(); while (Eat("||")) { var r = And(); l = Truth(l) ? l : r; } return l; }
        private object? And() { var l = Eq(); while (Eat("&&")) { var r = Eq(); l = !Truth(l) ? l : r; } return l; }
        private object? Eq()
        {
            var l = Rel();
            while (true)
            {
                if (Eat("===")) { l = StrictEq(l, Rel()); continue; }
                if (Eat("!==")) { l = !StrictEq(l, Rel()); continue; }
                if (Eat("==")) { l = LooseEq(l, Rel()); continue; }
                if (Eat("!=")) { l = !LooseEq(l, Rel()); continue; }
                Skip();
                if (_i < s.Length && s[_i] == '=' ) { _i++; l = Rel(); continue; } // `x.value=true`: JS assignment → its value
                return l;
            }
        }
        private object? Rel()
        {
            var l = Add();
            while (true)
            {
                if (Eat("<=")) { l = ToNum(l) <= ToNum(Add()); continue; }
                if (Eat(">=")) { l = ToNum(l) >= ToNum(Add()); continue; }
                Skip();
                if (_i < s.Length && s[_i] == '<') { _i++; l = ToNum(l) < ToNum(Add()); continue; }
                if (_i < s.Length && s[_i] == '>') { _i++; l = ToNum(l) > ToNum(Add()); continue; }
                return l;
            }
        }
        // `+` / `-` (JS: a string on either side of + concatenates, else numbers)
        private object? Add()
        {
            var l = Unary();
            while (true)
            {
                Skip();
                if (_i < s.Length && s[_i] == '+') { _i++; var r = Unary(); l = l is string || r is string ? $"{JsStr(l)}{JsStr(r)}" : ToNum(l) + ToNum(r); continue; }
                if (_i < s.Length && s[_i] == '-') { _i++; l = ToNum(l) - ToNum(Unary()); continue; }
                return l;
            }
        }
        private static string JsStr(object? v) => v switch
        {
            null => "undefined",
            bool b => b ? "true" : "false",
            double d => d.ToString(CultureInfo.InvariantCulture),
            _ => v.ToString() ?? "",
        };
        private object? Unary()
        {
            Skip();
            if (_i < s.Length && s[_i] == '!' && !(_i + 1 < s.Length && s[_i + 1] == '=')) { _i++; return !Truth(Unary()); }
            if (_i < s.Length && s[_i] == '-') { _i++; return -ToNum(Unary()); }
            return Primary();
        }
        private object? Primary()
        {
            Skip();
            if (_i >= s.Length) throw new FormatException("end");
            char c = s[_i];
            if (c == '(') { _i++; var v = Or(); if (!Eat(")")) throw new FormatException(")"); return v; }
            if (c is '"' or '\'')
            {
                int end = s.IndexOf(c, _i + 1);
                if (end < 0) throw new FormatException("string");
                var str = s.Substring(_i + 1, end - _i - 1); _i = end + 1; return str;
            }
            if (char.IsDigit(c) || c == '.')
            {
                int st = _i; while (_i < s.Length && (char.IsDigit(s[_i]) || s[_i] == '.')) _i++;
                return double.Parse(s.AsSpan(st, _i - st), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
            if (char.IsLetter(c) || c is '_' or '$')
            {
                // `a.value`, and JS's `a. value` / `a .value` (whitespace around a member access is legal; corpus)
                var parts = new List<string> { Ident() };
                while (true)
                {
                    int save = _i; Skip();
                    if (_i < s.Length && s[_i] == '.') { _i++; Skip(); if (_i < s.Length && (char.IsLetter(s[_i]) || s[_i] is '_' or '$')) { parts.Add(Ident()); continue; } throw new FormatException("member"); }
                    _i = save; break;
                }
                if (parts.Count == 1)
                {
                    switch (parts[0])
                    {
                        case "true": return true;
                        case "false": return false;
                        case "null" or "undefined": return null;
                    }
                    if (!LenientIds) throw new FormatException($"bare identifier {parts[0]}");
                    return null;
                }
                if (parts.Count != 2 || parts[1] != "value") { if (!LenientIds) throw new FormatException("member"); return null; }
                var name = parts[0];
                if (!values.TryGetValue(name, out var n) || n == null) return null;
                return n.GetValueKind() switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Number => n.GetValue<double>(),
                    JsonValueKind.String => n.GetValue<string>(),
                    _ => null,
                };
            }
            throw new FormatException($"unexpected '{c}'");
        }
        private string Ident()
        {
            int st = _i; while (_i < s.Length && (char.IsLetterOrDigit(s[_i]) || s[_i] is '_' or '$')) _i++;
            return s[st.._i];
        }
    }

    private static bool Truth(object? v) => v switch
    {
        null => false,
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        string s => s.Length > 0,
        _ => true,
    };

    private static double ToNum(object? v) => v switch
    {
        null => double.NaN,
        bool b => b ? 1 : 0,
        double d => d,
        string s => s.Trim().Length == 0 ? 0 : double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN,
        _ => double.NaN,
    };

    private static bool StrictEq(object? a, object? b) => (a, b) switch
    {
        (null, null) => true,
        (double x, double y) => x == y,
        (string x, string y) => x == y,
        (bool x, bool y) => x == y,
        _ => false,
    };

    // JS `==`: null only equals null; same type → strict; otherwise both to numbers (bool → 0/1, string → Number()).
    private static bool LooseEq(object? a, object? b)
    {
        if (a == null || b == null) return a == null && b == null;
        if (a.GetType() == b.GetType()) return StrictEq(a, b);
        return ToNum(a) == ToNum(b);
    }

    // ---- helpers --------------------------------------------------------------------------------------

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static double? Num(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<JsonElement>(out var e) && e.ValueKind == JsonValueKind.Number) return e.GetDouble();
        if (v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var ds)) return ds;
        return null;
    }

    private static bool Truthy(JsonNode? n) => n?.GetValueKind() switch
    {
        JsonValueKind.True => true,
        JsonValueKind.Number => Num(n) is double d && d != 0,
        JsonValueKind.String => Str(n) is "true" or "1",
        _ => false,
    };

    // LWE's combo key: a numeric value → std::to_string(value.get<int>()) (truncated), a string as is.
    private static string? ComboKey(JsonNode? n) => n?.GetValueKind() switch
    {
        JsonValueKind.String => Str(n),
        JsonValueKind.Number => ((long)Math.Truncate(Num(n) ?? 0)).ToString(CultureInfo.InvariantCulture),
        JsonValueKind.True => "1",
        JsonValueKind.False => "0",
        _ => null,
    };

    // "r g b" (0–1 floats; any component > 1 → the whole colour is 0–255, as WE accepts both), [r, g, b], or
    // #rrggbb → [r, g, b] in 0–1.
    public static double[]? ParseColor(JsonNode? n) => n switch
    {
        JsonArray a => ColorFrom(a.Select(x => Num(x)).ToList()),
        JsonValue v when Str(v) is string s => ParseColorText(s),
        _ => null,
    };

    private static double[]? ParseColor(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Array => ColorFrom(e.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Number ? x.GetDouble() : (double?)null).ToList()),
        JsonValueKind.String => ParseColorText(e.GetString()!),
        _ => null,
    };

    private static double[]? ParseColorText(string s)
    {
        s = s.Trim();
        if (s.StartsWith('#') && s.Length == 7 && int.TryParse(s.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex))
            return [((hex >> 16) & 255) / 255.0, ((hex >> 8) & 255) / 255.0, (hex & 255) / 255.0];
        var parts = s.Split([' ', ',', '\t'], StringSplitOptions.RemoveEmptyEntries);
        return ColorFrom(parts.Select(p => double.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : (double?)null).ToList());
    }

    private static double[]? ColorFrom(List<double?> c)
    {
        if (c.Count is < 3 or > 4 || c.Take(3).Any(x => x is null || double.IsNaN(x.Value))) return null;
        var rgb = c.Take(3).Select(x => x!.Value).ToArray();
        if (rgb.Any(x => x > 1)) rgb = rgb.Select(x => x / 255.0).ToArray();
        return rgb.Select(x => Math.Round(Math.Clamp(x, 0, 1), 6)).ToArray();
    }

    public static string FormatColor(double[] c) => string.Join(' ', c.Take(3).Select(x => x.ToString("0.######", CultureInfo.InvariantCulture)));

    private static readonly Dictionary<string, string> UiKeys = new()
    {
        ["ui_browse_properties_scheme_color"] = "Scheme color",
        ["ui_browse_properties_brightness"] = "Brightness",
        ["ui_browse_properties_alignment"] = "Alignment",
        ["ui_editor_effect_local_contrast_title"] = "Local contrast",
    };

    // A property's `text` → plain text: HTML tags dropped (labels carry <hr>, <h4>, <a>, <img> — never rendered:
    // no remote images, no links), entities decoded, whitespace collapsed; a `ui_*` localisation key →
    // its English text (or humanised); empty → `fallback`.
    public static string CleanLabel(string? text, string fallback)
    {
        if (string.IsNullOrWhiteSpace(text)) return fallback;
        var t = text.Trim();
        if (t.StartsWith("ui_", StringComparison.Ordinal) && !t.Contains(' '))
        {
            if (UiKeys.TryGetValue(t, out var known)) return known;
            var words = t.Split('_', StringSplitOptions.RemoveEmptyEntries).Skip(1)
                .Where(w => w is not ("browse" or "properties" or "editor" or "title")).ToList();
            if (words.Count == 0) return fallback;
            var h = string.Join(' ', words);
            return char.ToUpperInvariant(h[0]) + h[1..];
        }
        t = Regex.Replace(t, @"<\s*(br|hr|/p|/h\d|/div|/li)\b[^>]*>", " ", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, "<[^>]*>", "");
        t = WebUtility.HtmlDecode(t);
        var sb = new StringBuilder(t.Length);
        foreach (var ch in t)
            if (ch is '‎' or '‏' or '​') continue; // invisible marks (padding in some labels)
            else sb.Append(char.IsWhiteSpace(ch) ? ' ' : ch);
        var r = Regex.Replace(sb.ToString(), " {2,}", " ").Trim();
        return r.Length == 0 ? fallback : r;
    }
}
