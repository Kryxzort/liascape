using System;
using System.Collections.Generic;
using System.Linq;

namespace Liascape.Models;

// The Workshop Browse filter (POST /browse `filter`). `Include` / `Exclude` are Steam tags; how they combine (OR within a
// group, AND across groups, the age rule) is Helpers/WorkshopTags' job, so every client gets the same semantics.
// The single-pick fields (Type, AgeRating, Resolution, Genres, Features) are the pre-2026-11-11 filter bar's: still
// accepted, and when Include AND Exclude are both empty each value becomes one included tag (Effective).
public class WorkshopFilter
{
    public string Sort { get; set; } = "trend";
    public int TrendDays { get; set; } = 7;
    public List<string> Include { get; set; } = [];
    public List<string> Exclude { get; set; } = [];
    // how ticked FEATURES combine (owner 2026-11-11: "what if a user wants 3D OR HDR and not 3D AND HDR"): "all"
    // (default; missing / unknown = all) = every one required, "any" = at least one. Only features and genres have a choice
    // (GenreMatch below) — age / type / resolution are one tag per item, so OR is their only meaningful mode (WorkshopTags).
    public string FeatureMatch { get; set; } = "all";
    public bool FeaturesAny => string.Equals(FeatureMatch?.Trim(), "any", StringComparison.OrdinalIgnoreCase);
    // how ticked GENRES combine (owner 2026-11-11: "lets just have a 'all or any' option for genere too"): "any" (default;
    // missing / unknown = any) = at least one, "all" = every one. An item normally carries ONE genre — "all" of two finds
    // the ~2,800 multi-genre items (mostly 2016–17 uploads, measured 2026-11-11: e.g. Game + Music 180, Anime + Girls 4).
    public string GenreMatch { get; set; } = "any";
    public bool GenresAll => string.Equals(GenreMatch?.Trim(), "all", StringComparison.OrdinalIgnoreCase);

    // legacy
    public HashSet<string> Genres { get; set; } = [];
    public HashSet<string> Features { get; set; } = [];
    public string Type { get; set; } = "";
    public string AgeRating { get; set; } = "";
    public string Resolution { get; set; } = "";

    // (included, excluded) tags: Include/Exclude, or the legacy fields mapped into included when both are empty.
    public (List<string> Include, List<string> Exclude) Effective()
    {
        static List<string> Clean(IEnumerable<string>? tags) =>
            // "@…" = the UI's own pseudo-tags (Browse's "In my library", filtered client-side) — never Steam's
            (tags ?? []).Where((t) => !string.IsNullOrWhiteSpace(t) && !t.TrimStart().StartsWith('@')).Select((t) => t.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var inc = Clean(Include);
        var exc = Clean(Exclude);
        if (inc.Count == 0 && exc.Count == 0)
            inc = Clean(new[] { Type, AgeRating, Resolution }.Concat(Genres ?? []).Concat(Features ?? []));
        return (inc, exc);
    }

    // value identity — the Workshop service drops its prefetched page only when this changes (every /browse re-sends the
    // filter; comparing by reference invalidated the prefetch on every request)
    public string Key()
    {
        var (inc, exc) = Effective();
        static string J(IEnumerable<string> t) => string.Join("\u0001", t.Select((x) => x.ToLowerInvariant()).Order());
        return $"{Sort}|{(Sort == "trend" ? TrendDays : 0)}|{FeaturesAny}|{GenresAll}|{J(inc)}|{J(exc)}";
    }
}
