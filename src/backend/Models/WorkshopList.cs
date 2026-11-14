using System;
using System.Linq;

namespace Liascape.Models;

// Which Workshop items Browse lists (POST /browse `list`, the Workshop source only): absent = the whole Workshop (the
// filter's sort, search and tags, server-side); "favorites" = the signed-in account's Workshop favourites; "creator" = every
// Wallpaper Engine item of the Steam account `Id`. A list is a user's files over Steam's client protocol, which sorts them only
// by `Sort` ("lastupdated", the default, or "toprated") and has no search; the filter's tags still apply (matched here).
public class WorkshopList
{
    public string Kind { get; set; } = "";
    public string? Id { get; set; }
    public string Sort { get; set; } = "lastupdated";

    public bool IsFavorites => string.Equals(Kind, "favorites", StringComparison.OrdinalIgnoreCase);
    public bool IsCreator => string.Equals(Kind, "creator", StringComparison.OrdinalIgnoreCase)
        && Id is { Length: >= 15 and <= 20 } id && id.All(char.IsAsciiDigit);
    public bool Active => IsFavorites || IsCreator;
    // the client protocol's sort names for a user's files (measured: the rest are ignored)
    public string SteamSort => Sort == "toprated" ? "score" : "lastupdated";
    public string Key() => Active ? $"{(IsFavorites ? "favorites" : $"creator:{Id}")}|{SteamSort}" : "";
}
