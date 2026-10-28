using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using System.Text.Json;

namespace Liascape.Helpers;

// PATCH semantics for a state endpoint's body: `saved` with the keys `body` has laid over it — every key it
// leaves out keeps its saved value, a nested object (a playlist's `settings`) merges key by key the same way,
// a list or a scalar replaces, an explicit null sets null. Each key binds with the API's web JSON defaults
// (camelCase or PascalCase, the setters' clamps); a bad value throws JsonException; unknown keys are ignored.
// `saved` is never touched. POST /playlist/state uses it (a body of just the paths reset the rotation +
// transitions to the C# defaults — matrix plState:partial); /settings has its own (SettingsService.Merge).
public static class JsonMerge
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    public static T Over<T>(T? saved, JsonElement body) where T : class, new() => (T)Over(typeof(T), saved, body);

    private static object Over(Type t, object? saved, JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object) throw new JsonException($"the {t.Name} body must be a JSON object");
        var merged = saved == null ? Activator.CreateInstance(t)!
            : JsonSerializer.Deserialize(JsonSerializer.Serialize(saved, t, Web), t, Web)!; // a deep copy
        var props = t.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanRead && p.CanWrite && p.GetIndexParameters().Length == 0)
            .ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
        foreach (var kv in body.EnumerateObject())
        {
            if (!props.TryGetValue(kv.Name, out var p)) continue;
            var pt = p.PropertyType;
            bool nested = kv.Value.ValueKind == JsonValueKind.Object && pt.IsClass && pt != typeof(string)
                && !typeof(IEnumerable).IsAssignableFrom(pt);
            p.SetValue(merged, nested ? Over(pt, p.GetValue(merged), kv.Value) : kv.Value.Deserialize(pt, Web));
        }
        return merged;
    }
}
