using System;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;

namespace Liascape.Helpers;

// What a link pasted into Import names (Web/LinkImportOps.cs downloads it): a Steam Workshop item, one wallpaper's page on a
// Browse web source, or a file straight from a server. Pure: no request, no settings, so every pattern is pinned by
// scraper-selftest "link: …". A page address comes back in the exact form that source's Browse cards use (motionbgs' and
// desktophut's `www.`, moewalls' trailing slash), since a downloaded item's source id is that address and de-duplicates it
// (.claude/rules/backend/sources-steam.md § Scrapers).
public static partial class LinkImport
{
    public enum Kind { Workshop, Site, Direct, Unknown, Refused }

    // `Url`: the address to fetch (Direct, Unknown), the source's page address (Site), Steam's item page (Workshop).
    // `Source`: the Browse source's name (IBrowseSource.Name) of a Site link. `Media`: video | gif | image when the address's
    // own name says so. `Error`: why a Refused link can't be imported, in the words the dialog shows.
    public sealed record Target(Kind Kind, string Url, string? WorkshopId = null, string? Source = null, string? Media = null, string? Error = null);

    public const string NotSupported = "That site isn't supported. Import takes a Steam Workshop item, a MoeWalls, DesktopHut or MotionBgs page, or a link straight to a video or picture.";
    public const string OnlyWeb = "Only web links (http or https) can be imported.";
    public const string Empty = "Paste a link to a wallpaper.";
    public const string WithCredentials = "A link with a user name or password in it isn't imported.";

    static readonly string[] VideoExts = [.. FolderScanner.VideoExts];
    static readonly string[] PictureExts = [.. ImportService.ImageExtensions];

    // the web sources' sites: host (without www.) → the source's name, its page address prefix, whether a page has one
    // path segment (motionbgs, desktophut: /<slug>) or two (moewalls: /<category>/<slug>/), and the first segment of the site's
    // own download links (motionbgs' /dl/4k/18, what its page's download button holds), which are files, not pages
    static readonly (string Host, string Source, string Site, string Label, int Segments, bool Slash, string? Files)[] Sites =
    [
        ("motionbgs.com", "MotionBgs", "https://www.motionbgs.com", "MotionBgs", 1, false, "dl"),
        ("moewalls.com", "Moewalls", "https://moewalls.com", "MoeWalls", 2, true, null),
        ("desktophut.com", "Desktophut", "https://www.desktophut.com", "DesktopHut", 1, false, null),
    ];
    // a site's listing pages, never one wallpaper's: its paging, search, tags and categories
    static readonly string[] Listings = ["page", "search", "category", "tag", "tags", "author", "hx2"];

    public static Target Map(string? text)
    {
        string s = (text ?? "").Trim();
        if (s.Length == 0) return Refuse(Empty);
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https") || u.Host.Length == 0)
            return Refuse(OnlyWeb);
        if (!string.IsNullOrEmpty(u.UserInfo)) return Refuse(WithCredentials);
        string host = u.IdnHost.ToLowerInvariant().TrimEnd('.');
        if (host.StartsWith("www.", StringComparison.Ordinal)) host = host[4..];
        var segs = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);

        if (host == "steamcommunity.com")
        {
            // /sharedfiles/filedetails/?id=N and /workshop/filedetails/?id=N, the two forms Steam links an item by
            bool item = segs.Length == 2 && segs[0] is "sharedfiles" or "workshop" && segs[1] == "filedetails";
            string? id = QueryValue(u.Query, "id");
            if (!item || id == null || id.Length is 0 or > 20 || !id.All(char.IsAsciiDigit) || !ulong.TryParse(id, out var n) || n == 0)
                return Refuse("That Steam page isn't a Workshop item's page.");
            return new(Kind.Workshop, $"https://steamcommunity.com/sharedfiles/filedetails/?id={n}", WorkshopId: n.ToString());
        }

        if (MediaOf(segs.LastOrDefault()) is { } media) return new(Kind.Direct, u.AbsoluteUri, Media: media);

        foreach (var site in Sites)
        {
            if (host != site.Host) continue;
            // a download link: the file it answers with decides, like any address without a media name
            if (site.Files != null && segs.Length > 1 && segs[0] == site.Files) return new(Kind.Unknown, u.AbsoluteUri);
            if (segs.Length != site.Segments || segs.Any((x) => Listings.Contains(x.ToLowerInvariant()) || x.Contains(':')))
                return Refuse($"That {site.Label} page isn't one wallpaper's page.");
            return new(Kind.Site, site.Site + "/" + string.Join('/', segs) + (site.Slash ? "/" : ""), Source: site.Source);
        }
        // anything else may still be a file a server hands out without a name (a CDN's /v/abc123): the answer's
        // Content-Type decides, and a page there is an unsupported site (LinkImportOps)
        return new(Kind.Unknown, u.AbsoluteUri);
    }

    // video | gif | image by a file name's extension, else null
    public static string? MediaOf(string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        string ext = System.IO.Path.GetExtension(Uri.UnescapeDataString(name)).ToLowerInvariant();
        return ext == ".gif" ? "gif" : VideoExts.Contains(ext) ? "video" : PictureExts.Contains(ext) ? "image" : null;
    }

    // The extension a fetched file is stored under (ImportService then keeps a video's and a gif's, makes a picture a png),
    // from the server's Content-Type, else (none, or a generic binary type) from the address's own name, else from the answer's
    // own file name (`fileName`, its Content-Disposition); null = not a video or picture the library takes (a page, an SVG, a
    // document). The file's first bytes are checked against the kind afterwards (ApiSecurity.HeadIsMedia).
    public static string? ExtFor(string? contentType, string url, string? fileName = null)
    {
        string ct = (contentType ?? "").Split(';')[0].Trim().ToLowerInvariant();
        static string? MediaExt(string? name) => name is { Length: > 0 } && System.IO.Path.GetExtension(name.Trim().Trim('"')).ToLowerInvariant() is var e
            && MediaOf("x" + e) != null ? e : null;
        string? named = (Uri.TryCreate(url, UriKind.Absolute, out var u) ? MediaExt(Uri.UnescapeDataString(u.AbsolutePath)) : null) ?? MediaExt(fileName);
        return ct switch
        {
            "video/mp4" => ".mp4", "video/webm" => ".webm", "video/x-matroska" => ".mkv", "video/quicktime" => ".mov",
            "video/x-m4v" => ".m4v", "video/x-msvideo" or "video/avi" => ".avi",
            "image/gif" => ".gif", "image/png" => ".png", "image/jpeg" or "image/jpg" => ".jpg", "image/webp" => ".webp",
            // a video type the list doesn't name: the player plays it whatever the container (stored as its own name's, else .mp4)
            _ when ct.StartsWith("video/", StringComparison.Ordinal) => named is { } n && VideoExts.Contains(n) ? n : ".mp4",
            "" or "application/octet-stream" or "binary/octet-stream" => named,
            _ => null,
        };
    }

    // The name an imported file gets: the server's Content-Disposition file name, else the address's last segment, without
    // its extension; else the host
    public static string TitleFor(string url, string? dispositionName)
    {
        string? name = dispositionName;
        if (string.IsNullOrWhiteSpace(name) && Uri.TryCreate(url, UriKind.Absolute, out var u))
            name = Uri.UnescapeDataString(u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "");
        name = System.IO.Path.GetFileNameWithoutExtension((name ?? "").Trim().Trim('"'));
        if (name.Length > 0) return name;
        return Uri.TryCreate(url, UriKind.Absolute, out var h) ? h.Host : "wallpaper";
    }

    // A web source page's name guessed from its address, for the dialog before anything is fetched ("gojo-and-black-cat-
    // live-wallpaper" → "Gojo And Black Cat"); the download names the item from the page itself
    public static string SlugTitle(string pageUrl)
    {
        string slug = Uri.TryCreate(pageUrl, UriKind.Absolute, out var u)
            ? Uri.UnescapeDataString(u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "") : "";
        string words = LiveWallpaperRe().Replace(slug, "").Replace('-', ' ').Replace('_', ' ').Trim();
        if (words.Length == 0) words = slug;
        return string.Join(' ', words.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select((w) => char.ToUpperInvariant(w[0]) + w[1..]));
    }

    // An address a link import may connect to: a public one, or (hermetic tests only, LIASCAPE_TEST_LINK_LOOPBACK=1) this
    // machine's loopback; never the LAN, link-local (cloud metadata) or another private range (ApiSecurity.IsPublic)
    public static bool AddressAllowed(IPAddress a, bool loopbackToo) =>
        Liascape.Web.ApiSecurity.IsPublic(a) || (loopbackToo && IPAddress.IsLoopback(a.IsIPv4MappedToIPv6 ? a.MapToIPv4() : a));

    // the test stacks' fake servers listen on loopback (scripts/test-item-actions.sh § link, probe-import import:link:*)
    public static bool LoopbackForTests => Environment.GetEnvironmentVariable("LIASCAPE_TEST_LINK_LOOPBACK") == "1";

    // The largest file a link import fetches (LIASCAPE_LINK_MAX_BYTES: a test's small cap); a bigger one stops and leaves nothing
    public static long MaxBytes => long.TryParse(Environment.GetEnvironmentVariable("LIASCAPE_LINK_MAX_BYTES"), out var m) && m > 0 ? m : 4L << 30;

    static Target Refuse(string why) => new(Kind.Refused, "", Error: why);

    static string? QueryValue(string query, string key)
    {
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            int eq = part.IndexOf('=');
            if (eq > 0 && part[..eq] == key) return Uri.UnescapeDataString(part[(eq + 1)..]);
        }
        return null;
    }

    [GeneratedRegex(@"-live-wallpaper\b.*$", RegexOptions.IgnoreCase)]
    private static partial Regex LiveWallpaperRe();
}
