using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Liascape.Helpers;

// What the user hid from a grid (a card's right-click → Hide): `hidden.json` in the data dir, `{library, browse}`, each a map
// key → entry. The Library's keys are its items' paths, Browse's the cards' page URLs (a Workshop item's Steam page, a local
// Wallpaper Engine item's folder, a web source's page), each with the source it was hidden on and the card itself, so the
// Hidden filter row can show a hidden card again without asking the source for it. Hiding only hides: nothing here touches
// a wallpaper's files. Every change is field-level (only the keys it names, computed from what's saved, inside the process's
// lock and the cross-process FileLock) and written atomically; a file that doesn't parse is never written over.
// Guard: scripts/test-hidden.sh
public static class HiddenItems
{
    public const string Library = "library", Browse = "browse";
    // a request's bounds: a key is a path or a URL, a card a Browse result
    public const int MaxKeys = 5000, MaxKeyLength = 4096, MaxCardBytes = 64 * 1024;

    public sealed class Entry
    {
        [JsonPropertyName("title")] public string? Title { get; set; }
        // Browse: the source's name (a hidden card shows again only on its own source)
        [JsonPropertyName("source")] public string? Source { get; set; }
        // Browse: the card as the page had it (opaque here)
        [JsonPropertyName("card")] public JsonElement? Card { get; set; }
        [JsonPropertyName("hiddenAt")] public DateTime HiddenAt { get; set; }
    }

    public sealed class State
    {
        [JsonPropertyName("library")] public Dictionary<string, Entry> Library { get; set; } = new();
        [JsonPropertyName("browse")] public Dictionary<string, Entry> Browse { get; set; } = new();
    }

    private static readonly object Gate = new();
    public static string FilePath => Path.Combine(AppDirs.Data, "hidden.json");

    public static bool ValidScope(string? scope) => scope is Library or Browse;

    // the saved state; a file that doesn't parse throws (a caller that writes must not replace it with an empty one)
    private static State Read()
    {
        var s = AtomicFile.ReadJson<State>(FilePath) ?? new State();
        s.Library ??= new(); s.Browse ??= new();
        return s;
    }

    // for a reader (GET /hidden): an unreadable file reads as nothing hidden, logged; it stays as it is on disk
    public static State Load()
    {
        lock (Gate)
        {
            try { return Read(); }
            catch (Exception e) { Console.Error.WriteLine($"hidden: {FilePath} unreadable ({e.Message}) — showing nothing hidden"); return new State(); }
        }
    }

    // Hide `hide` and unhide `unhide` in one scope's map, leaving every other key and the other scope as saved. → the new state;
    // `added`: the keys this change hid (not hidden already, as the file was under the lock)
    public static State Change(string scope, IReadOnlyDictionary<string, Entry> hide, IEnumerable<string> unhide) => Change(scope, hide, unhide, out _);
    public static State Change(string scope, IReadOnlyDictionary<string, Entry> hide, IEnumerable<string> unhide, out List<string> added)
    {
        if (!ValidScope(scope)) throw new ArgumentException($"unknown scope '{scope}'");
        added = [];
        lock (Gate)
        {
            using var _ = FileLock.Hold(FilePath); // and every other liascape process
            var s = Read();
            var map = scope == Library ? s.Library : s.Browse;
            var changed = false;
            foreach (var (k, e) in hide)
            {
                if (map.ContainsKey(k)) continue; // hidden already: keep when it was
                map[k] = e; changed = true; added.Add(k);
            }
            foreach (var k in unhide) changed |= map.Remove(k);
            if (changed) AtomicFile.WriteAllText(FilePath, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
            return s;
        }
    }

    // a request's keys and cards, checked: null = fine, else why not
    public static string? Refusal(IEnumerable<string?> keys, IEnumerable<JsonElement?> cards)
    {
        var ks = keys.ToList();
        if (ks.Count > MaxKeys) return $"at most {MaxKeys} keys at once";
        if (ks.Any(k => string.IsNullOrWhiteSpace(k) || k.Length > MaxKeyLength)) return "every key must be a non-empty string of at most 4096 characters";
        foreach (var c in cards)
        {
            if (c is not { } el) continue;
            if (el.ValueKind != JsonValueKind.Object) return "a card must be an object";
            if (el.GetRawText().Length > MaxCardBytes) return "a card is too large";
        }
        return null;
    }
}
