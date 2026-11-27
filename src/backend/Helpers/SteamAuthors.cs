using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

// The filter column's Author field (GET /workshop/author, Web/WorkshopSocialOps.cs): what the user typed → one Steam account,
// whose files Browse then lists (`/browse` `list: {kind: "creator"}`). Steam has no author search (its Workshop search matches
// titles and descriptions only) and no lookup by display name (names aren't unique), so the field takes:
//   - a Steam ID (17 digits) or a profile link naming one (steamcommunity.com/profiles/<id>): no request;
//   - a profile link with a custom name (steamcommunity.com/id/<name>): its public XML, once per run (SteamCommunity.VanityAsync);
//   - a name the app has seen beside an account: the profiles and comment threads read this run, and the library's Workshop
//     items' saved creator names matched to the creator the details cache holds for them; never a request.
// Anything else (an unknown or shared name, another site's link) is refused with what to paste instead.
// docs/decisions.md § "Pick a creator's or a scene's list in the filter column". Guard: scripts/test-workshop-social.sh § 1c
public static class SteamAuthors
{
    public enum Kind { SteamId, Vanity, Name, Bad }
    public readonly record struct Parsed(Kind Kind, string Value);

    /// What the field can't take, in words for the field's own error state; `Reason` = "unknown" | "shared" | "bad" | "none".
    public sealed class UnresolvedException(string message, string reason) : Exception(message) { public string Reason { get; } = reason; }

    // a custom profile name: Steam allows letters, digits, _ and -, 2–32 of them
    static readonly Regex _vanityRe = new(@"^[A-Za-z0-9_-]{2,32}$", RegexOptions.Compiled);

    public static Parsed Parse(string? text)
    {
        var t = (text ?? "").Trim();
        if (t.Length == 0) return new(Kind.Bad, "");
        // digits that aren't a Steam ID may still be a name seen before ("1234"): matched as one
        if (t.All(char.IsAsciiDigit)) return SteamCommunity.ValidSteamId(t) ? new(Kind.SteamId, t) : new(Kind.Name, t);
        bool linkish = t.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || t.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || t.Contains("steamcommunity.com", StringComparison.OrdinalIgnoreCase);
        if (!linkish) return new(Kind.Name, Regex.Replace(t, @"\s+", " "));
        if (!Uri.TryCreate(t.Contains("://") ? t : "https://" + t, UriKind.Absolute, out var u)
            || u.Scheme is not ("http" or "https")
            || !u.Host.Equals("steamcommunity.com", StringComparison.OrdinalIgnoreCase) && !u.Host.Equals("www.steamcommunity.com", StringComparison.OrdinalIgnoreCase))
            return new(Kind.Bad, t);
        var seg = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (seg.Length < 2) return new(Kind.Bad, t);
        if (seg[0] == "profiles") return SteamCommunity.ValidSteamId(seg[1]) ? new(Kind.SteamId, seg[1]) : new(Kind.Bad, t);
        if (seg[0] == "id") { var v = Uri.UnescapeDataString(seg[1]); return _vanityRe.IsMatch(v) ? new(Kind.Vanity, v) : new(Kind.Bad, t); }
        return new(Kind.Bad, t);
    }

    /// The account the text names, with its name and avatar when this run knows them. Throws UnresolvedException for what
    /// the field can't take; Steam unreachable → HttpRequestException, its cooldown → SteamCooldownException.
    public static async Task<SteamCommunity.Profile> ResolveAsync(string? text, CancellationToken ct)
    {
        var p = Parse(text);
        switch (p.Kind)
        {
            case Kind.SteamId:
                return SteamCommunity.Known(p.Value) ?? new SteamCommunity.Profile(p.Value, null, null);
            case Kind.Vanity:
                return await SteamCommunity.VanityAsync(p.Value, ct).ConfigureAwait(false)
                    ?? throw new UnresolvedException("No Steam profile at that link", "none");
            case Kind.Name:
                var ids = AccountsNamed(p.Value);
                if (ids.Count == 1) return SteamCommunity.Known(ids[0]) ?? new SteamCommunity.Profile(ids[0], p.Value, null);
                throw ids.Count == 0
                    ? new UnresolvedException("Unknown name: paste a profile link or ID", "unknown")
                    : new UnresolvedException("Name not unique: paste a profile link or ID", "shared");
            default:
                throw new UnresolvedException(string.IsNullOrWhiteSpace(text) ? "Paste a profile link or ID" : "Not a profile: paste a profile link or ID", "bad");
        }
    }

    // the accounts the app has seen under this name (any case), never a request
    static List<string> AccountsNamed(string name)
    {
        var ids = new HashSet<string>();
        bool Same(string? n) => n != null && string.Equals(Regex.Replace(n.Trim(), @"\s+", " "), name, StringComparison.OrdinalIgnoreCase);
        foreach (var (id, n) in SteamCommunity.SeenNames()) if (Same(n)) ids.Add(id);
        foreach (var source in LibraryStore.Sources)
            foreach (var m in LibraryStore.LoadIndex(source).Values)
                if (Same(m.AuthorName) && m.WorkshopId is { } w && WorkshopDetailsCache.TryGet(w, out var d) && SteamCommunity.ValidSteamId(d.CreatorId))
                    ids.Add(d.CreatorId);
        return [.. ids];
    }
}
