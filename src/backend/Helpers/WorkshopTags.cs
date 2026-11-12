using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Liascape.Models;

namespace Liascape.Helpers;

// The Workshop Browse tag taxonomy and how a filter's include/exclude tags combine (docs/decisions.md § "AND Workshop
// features, OR genres, each switchable"; § "Drop untagged items under any age filter"). Lives in the backend
// so every client gets the same semantics; the Steam client-protocol path (SteamWorkshopDetails.QueryAsync) sends the Plan
// as `taggroups` + `excludedtags`, the page-scraping fallback sends what the page can express and checks the rest (Matches).
//   - Group mode Any (OR): an item carries ONE age rating / type / resolution and normally one genre (measured: 500
//     trending items, all with exactly 1 genre; "Anime AND Girls" = 4 items in the whole Workshop), so OR is the only
//     useful mode there — "Anime or Girls".
//   - Group mode All (AND): features stack (500 trending: 0 features → 277, 1 → 131, 2 → 63, 3 → 17, 4 → 9, 5 → 3;
//     "Audio responsive AND Customizable" = 46,026 vs OR 407,685), and Steam's own Workshop page ANDs them: each ticked
//     feature is its own taggroup ("must have all ticked features"). The filter's `featureMatch: "any"` makes them one OR
//     taggroup instead (a user may want 3D OR HDR, not 3D AND HDR). Genre has the mirror choice,
//     `genreMatch: "all"` — default Any; "all" finds the
//     ~2,800 multi-genre items (mostly 2016–17). Only these two groups have a choice.
//   - A tag in no group is its own group.
//   - AGE: an untagged item must never sneak past an age filter (an "Everyone" user must not meet an untagged
//     mature item — 219 videos + scenes, all from 2017, carry no age tag). Any age include OR exclude →
//     a taggroup of the allowed ages (the included ones, else all three, minus the excluded), which drops untagged items.
//     Every other group's excludes only go to excludedtags (an untagged item stays).
//   - TYPE: always restricted to what plays here — (included types, else Video + Scene) minus excluded, minus Scene when
//     scene support is off; Web / Application / Preset always excluded. Pages then come back full instead of thinned
//     after the fact.
//   - A tag both included and excluded is excluded. Nothing left to allow (all ages excluded, only Scene with scenes
//     off, an unplayable type included) → Plan.Empty: the caller answers [] without asking Steam.
public static class WorkshopTags
{
    public enum Mode { Any, All }
    public sealed record Group(string Name, Mode Mode, string[] Tags);

    public static readonly Group Age = new("Age", Mode.Any, ["Everyone", "Questionable", "Mature"]);
    public static readonly Group Type = new("Type", Mode.Any, ["Video", "Scene"]);
    // the filter column's lists (app/ui/src/components/workshopFilter.ts `WF_GROUPS` — Steam's own tag names)
    public static readonly Group Resolution = new("Resolution", Mode.Any, [
        "Standard Definition", "1280 x 720", "1366 x 768", "1920 x 1080", "2560 x 1440", "3840 x 2160",
        "Ultrawide Standard Definition", "Ultrawide 2560 x 1080", "Ultrawide 3440 x 1440",
        "Dual Standard Definition", "Dual 3840 x 1080", "Dual 5120 x 1440", "Dual 7680 x 2160",
        "Triple Standard Definition", "Triple 4096 x 768", "Triple 5760 x 1080", "Triple 7680 x 1440", "Triple 11520 x 2160",
        "Portrait Standard Definition", "Portrait 720 x 1280", "Portrait 1080 x 1920", "Portrait 1440 x 2560", "Portrait 2160 x 3840",
        "Other resolution", "Dynamic resolution"]);
    public static readonly Group Genre = new("Genre", Mode.Any, [
        "Abstract", "Animal", "Anime", "Cartoon", "CGI", "Cyberpunk", "Fantasy", "Game", "Girls", "Guys",
        "Landscape", "Medieval", "Memes", "MMD", "Music", "Nature", "Pixel art", "Relaxing", "Retro", "Sci-Fi",
        "Sports", "Technology", "Television", "Vehicle", "Unspecified"]);
    public static readonly Group Features = new("Features", Mode.All, [
        "Approved", "Audio responsive", "HDR", "3D", "Customizable", "Media Integration", "Puppet Warp", "Video Texture"]);
    public static readonly Group[] Groups = [Age, Type, Resolution, Genre, Features];

    // types that never play here (.claude/rules/backend/sources-steam.md § Scrapers)
    public static readonly string[] Unplayable = ["Web", "Application", "Preset"];

    private static readonly Dictionary<string, (Group G, string Tag)> _byTag =
        Groups.SelectMany((g) => g.Tags.Select((t) => (g, t))).ToDictionary((x) => x.t, (x) => (x.g, x.t), StringComparer.OrdinalIgnoreCase);

    // the tag's group + its canonical spelling; a tag in no group is its own (Any) group
    public static (Group G, string Tag) Resolve(string tag) =>
        _byTag.TryGetValue(tag, out var hit) ? hit : (new Group("tag:" + tag.ToLowerInvariant(), Mode.Any, [tag]), tag);

    // TagGroups: each must match (AND), a group matches when the item has any of its tags (OR). Excluded: none may match.
    public sealed record Plan(IReadOnlyList<string[]> TagGroups, IReadOnlyList<string> Excluded, bool Empty)
    {
        // what the Workshop browse page can express (its requiredtags[] are ANDed): the single-tag groups
        public IEnumerable<string> RequiredTags => TagGroups.Where((g) => g.Length == 1).Select((g) => g[0]);
    }

    public static Plan Build(WorkshopFilter? filter, bool allowScenes)
    {
        filter ??= new WorkshopFilter();
        var (incRaw, excRaw) = filter.Effective();
        var exc = excRaw.Select(Resolve).ToList();
        var excSet = new HashSet<string>(exc.Select((x) => x.Tag), StringComparer.OrdinalIgnoreCase);
        var inc = incRaw.Select(Resolve).Where((x) => !excSet.Contains(x.Tag)).ToList();
        var groups = new List<string[]>();
        var empty = false;

        // an unplayable type included: nothing it could match would play
        if (inc.Any((x) => Unplayable.Contains(x.Tag, StringComparer.OrdinalIgnoreCase))) empty = true;

        // Age: only when the filter touches it at all — then untagged items are out
        if (inc.Any((x) => x.G == Age) || exc.Any((x) => x.G == Age))
        {
            var allowed = (inc.Any((x) => x.G == Age) ? inc.Where((x) => x.G == Age).Select((x) => x.Tag) : Age.Tags)
                .Where((t) => !excSet.Contains(t)).Distinct().ToArray();
            if (allowed.Length == 0) empty = true; else groups.Add(allowed);
        }

        // Type: always — only what plays here
        {
            var allowed = (inc.Any((x) => x.G == Type) ? inc.Where((x) => x.G == Type).Select((x) => x.Tag) : Type.Tags)
                .Where((t) => !excSet.Contains(t) && (allowScenes || t != "Scene")).Distinct().ToArray();
            if (allowed.Length == 0) empty = true; else groups.Add(allowed);
        }

        // every other group: Any → one taggroup of its included tags, All → one per included tag
        foreach (var g in inc.Where((x) => x.G != Age && x.G != Type).GroupBy((x) => x.G.Name))
        {
            var tags = g.Select((x) => x.Tag).Distinct().ToArray();
            var grp = g.First().G;
            var mode = grp == Features ? (filter.FeaturesAny ? Mode.Any : Mode.All)
                : grp == Genre ? (filter.GenresAll ? Mode.All : Mode.Any)
                : grp.Mode;
            if (mode == Mode.All) groups.AddRange(tags.Select((t) => new[] { t }));
            else groups.Add(tags);
        }

        var excluded = exc.Where((x) => x.G != Age && x.G != Type).Select((x) => x.Tag)
            .Concat(Unplayable).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return new Plan(groups, excluded, empty);
    }

    public static bool Matches(Plan plan, IReadOnlyCollection<string> tags)
    {
        if (plan.Empty) return false;
        bool Has(string t) => tags.Contains(t, StringComparer.OrdinalIgnoreCase);
        return plan.TagGroups.All((g) => g.Any(Has)) && !plan.Excluded.Any(Has);
    }

    // What a Wallpaper Engine item's own project.json says, in the Workshop's tag names: its age rating (`contentrating`)
    // and its tags — the genres WE's editor wrote (`tags`), plus the two features the file itself declares (`approved`, WE's
    // curation mark; `general.supportsaudioprocessing` = "Audio responsive"). The UI filters local items (the library,
    // Browse's WE folder) with these the way Steam filters the Workshop. Features only the Workshop listing knows (HDR, 3D,
    // Customizable…) aren't guessed. Anything malformed is skipped.
    public static (string? Age, string[] Tags) FromProject(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return (null, []);
        string? age = null;
        if (root.TryGetProperty("contentrating", out var cr) && cr.ValueKind == JsonValueKind.String)
            age = Age.Tags.FirstOrDefault((t) => string.Equals(t, cr.GetString()?.Trim(), StringComparison.OrdinalIgnoreCase));
        var tags = new List<string>();
        if (root.TryGetProperty("tags", out var ts) && ts.ValueKind == JsonValueKind.Array)
            foreach (var t in ts.EnumerateArray())
                if (t.ValueKind == JsonValueKind.String && t.GetString()?.Trim() is { Length: > 0 } tag) tags.Add(Resolve(tag).Tag);
        static bool True(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
        if (True(root, "approved")) tags.Add("Approved");
        if (root.TryGetProperty("general", out var g) && g.ValueKind == JsonValueKind.Object && True(g, "supportsaudioprocessing"))
            tags.Add("Audio responsive");
        return (age, tags.Distinct(StringComparer.OrdinalIgnoreCase).ToArray());
    }

    public static string Describe(Plan p) => p.Empty ? "(nothing can match)"
        : string.Join(" AND ", p.TagGroups.Select((g) => g.Length == 1 ? g[0] : "(" + string.Join(" OR ", g) + ")"))
          + (p.Excluded.Count > 0 ? " NOT " + string.Join(",", p.Excluded) : "");
}
