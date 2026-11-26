using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using HtmlAgilityPack;

namespace Liascape.Scrapers;

// A wallpaper site's page as Browse's web sources read it (motionbgs, moewalls, desktophut): one GET through the shared
// client with the Firefox User-Agent (.claude/rules/backend/sources-steam.md § Scrapers), parsed with HtmlAgilityPack, and
// the small reading rules every parser shares. Under `scraper-selftest` the page comes from its fixture instead.
internal static class SitePage
{
    // The parsed page and the address it was served from: a site may redirect (motionbgs answers a query that names a tag
    // with that tag's page). A non-2xx answer throws, which /browse and /detail report as the request's error.
    public static async Task<(HtmlDocument Doc, Uri ServedFrom)> GetAsync(string url)
    {
        string html;
        Uri servedFrom;
        if (ScraperSelfTest.Pages is { } fixture)
        {
            var (page, at) = fixture(url);
            (html, servedFrom) = (page, new Uri(at));
        }
        else
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("User-Agent", HttpClientProvider.UserAgent);
            using var resp = await HttpClientProvider.Client.SendAsync(req);
            resp.EnsureSuccessStatusCode();
            html = await resp.Content.ReadAsStringAsync();
            servedFrom = resp.RequestMessage?.RequestUri ?? new Uri(url);
        }
        return (Parse(html), servedFrom);
    }

    public static HtmlDocument Parse(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);
        return doc;
    }

    // An attribute's value with its entities decoded; "" when the node or the attribute is missing (HtmlAgilityPack's own
    // GetAttributeValue already answers "" for a missing attribute, never null).
    public static string Attr(HtmlNode? node, string name) =>
        node == null ? "" : WebUtility.HtmlDecode(node.GetAttributeValue(name, ""));

    // A node's text, trimmed and decoded; null when there is no node (an empty element is "", which callers treat as absent).
    public static string? Text(HtmlNode? node) => node == null ? null : WebUtility.HtmlDecode(node.InnerText).Trim();

    // A link or picture address from the page made absolute on `site` (scheme + host, no trailing slash): an http(s) address
    // stays as it is, a site path gets the site in front. "" stays "" (no picture).
    public static string OnSite(string site, string address)
    {
        if (address.Length == 0 || address.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return address;
        return address.StartsWith('/') ? site + address : site + "/" + address;
    }

    // A wallpaper's name from its own page, for a detail asked with no card behind it (an import from a link: the card's title
    // is ""): the page's og:title, else its <title>, without a leading "Download", the " Live Wallpaper" the sites append and
    // whatever follows it (" - MoeWalls", " – Free Animated …"). Throws, like Needed, when the page names nothing.
    public static string PageName(HtmlDocument doc, string url)
    {
        string? full = Attr(doc.DocumentNode.SelectSingleNode("//meta[@property='og:title']"), "content").Trim() is { Length: > 0 } og ? og
            : Text(doc.DocumentNode.SelectSingleNode("//title"));
        if (string.IsNullOrEmpty(full)) throw new InvalidDataException($"the wallpaper's name not found on {url}");
        string name = System.Text.RegularExpressions.Regex.Replace(full, @"^Download\s+|\s+live wallpaper\b.*$", "",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Trim();
        return name.Length > 0 ? name : full;
    }

    // The one element a wallpaper's page must have (its video, its download link): a page without it is not a wallpaper's
    // page any more (the site changed its markup, or the link was wrong), so the detail fails rather than hand back an
    // address that leads nowhere.
    public static HtmlNode Needed(HtmlDocument doc, string xpath, string what, string url) =>
        doc.DocumentNode.SelectSingleNode(xpath) ?? throw new InvalidDataException($"{what} not found on {url}");
}
