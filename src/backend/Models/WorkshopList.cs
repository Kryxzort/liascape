using System;
using System.Linq;

namespace Liascape.Models;

// Which Workshop items Browse lists (POST /browse `list`, the Workshop source only): absent = the whole Workshop (the
// filter's sort, search and tags, server-side); "creator" = every Wallpaper Engine item of the Steam account `Id`; "presets"
// = every Workshop preset of the scene `Id` (QueryFiles' child lookup). A list sorts only by `Sort` ("lastupdated", the
// default, or "toprated") and has no search; the filter's tags still apply (a user's files: matched here; presets: Steam's,
// the type replaced by Preset). Any other kind is no list: the whole Workshop. The signed-in account's favourites are a
// set the page filters itself (GET /workshop/my-favorites, Helpers/WorkshopFavorites.cs).
public class WorkshopList
{
    public string Kind { get; set; } = "";
    public string? Id { get; set; }
    public string Sort { get; set; } = "lastupdated";

    public bool IsCreator => string.Equals(Kind, "creator", StringComparison.OrdinalIgnoreCase)
        && Id is { Length: >= 15 and <= 20 } id && id.All(char.IsAsciiDigit);
    public bool IsPresets => string.Equals(Kind, "presets", StringComparison.OrdinalIgnoreCase)
        && Id is { Length: >= 1 and <= 20 } id && id.All(char.IsAsciiDigit) && ulong.TryParse(id, out var n) && n > 0;
    public bool Active => IsCreator || IsPresets;
    // the client protocol's sort names for a user's files (measured: the rest are ignored)
    public string SteamSort => Sort == "toprated" ? "score" : "lastupdated";
    public string Key() => Active ? $"{(IsPresets ? $"presets:{Id}" : $"creator:{Id}")}|{SteamSort}" : "";
}
