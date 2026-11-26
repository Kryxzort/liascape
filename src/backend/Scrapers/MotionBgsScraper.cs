using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using HtmlAgilityPack;
using Liascape.Models;

namespace Liascape.Scrapers;

// motionbgs.com, read from its pages (fixtures: scripts/test-fixtures/scrapers/motionbgs/). Two page shapes carry cards:
//   - a page whose every link may be a card: the latest list (/hx2/latest/<n>/, the fragment the site's home page loads)
//     and a tag's pages (/tag:<name>/, /tag:<name>/<n>/), where the header, related tags and paging are links too;
//   - the search results (/search?q=…&page=<n>), where only the links in div.tmb are results.
// A search for a word that names a tag is redirected to that tag's page, so its later pages are the tag's, not the search's.
// The site now serves from motionbgs.com and redirects www to it; the www addresses stay because a downloaded item's
// source id is its page address (DownloadHelper's de-duplication).
internal static class MotionBgsScraper
{
    private const string Site = "https://www.motionbgs.com";

    public static async Task<List<WallpaperResult>> LatestAsync(int page)
    {
        var (doc, _) = await SitePage.GetAsync($"{Site}/hx2/latest/{page}/");
        return LinkCards(doc);
    }

    // Page 1 of a search; TagPath is the tag's path ("/tag:car/") when the site redirected the query to a tag's page.
    public static async Task<(List<WallpaperResult> Cards, string? TagPath)> SearchFirstAsync(string query)
    {
        var (doc, servedFrom) = await SitePage.GetAsync(SearchUrl(query, 1));
        string path = servedFrom.AbsolutePath;
        return path.Contains("/tag:", StringComparison.Ordinal) ? (LinkCards(doc), path) : (ResultCards(doc), null);
    }

    public static async Task<List<WallpaperResult>> SearchPageAsync(string query, int page)
    {
        var (doc, _) = await SitePage.GetAsync(SearchUrl(query, page));
        return ResultCards(doc);
    }

    // A later page (2+) of a tag's list
    public static async Task<List<WallpaperResult>> TagPageAsync(string tagPath, int page)
    {
        var (doc, _) = await SitePage.GetAsync($"{Site}{tagPath}{page}/");
        return LinkCards(doc);
    }

    // The wallpaper's page: the preview <video>'s mp4 and the first download link (the largest size the site offers)
    public static async Task<WallpaperDetail> DetailAsync(WallpaperResult card)
    {
        var (doc, _) = await SitePage.GetAsync(card.PageUrl);
        var video = SitePage.Needed(doc, "//source[@type='video/mp4']", "the preview video", card.PageUrl);
        var download = SitePage.Needed(doc, $"//div[{Class("download")}]//a[@href]", "the download link", card.PageUrl);
        return new WallpaperDetail
        {
            Title = card.Title.Length > 0 ? card.Title : SitePage.PageName(doc, card.PageUrl),
            PreviewUrl = SitePage.OnSite(Site, SitePage.Attr(video, "src")),
            DownloadUrl = SitePage.OnSite(Site, SitePage.Attr(download, "href")),
        };
    }

    private static string SearchUrl(string query, int page) => $"{Site}/search?q={Uri.EscapeDataString(query)}&page={page}";

    // XPath for "has this class among its classes"
    private static string Class(string name) => $"contains(concat(' ', normalize-space(@class), ' '), ' {name} ')";

    // Every link on the page that is a wallpaper: a picture with a title, pointing at a wallpaper's page — not the home
    // page, a tag or a search. The picture sits in the link, or (an older layout) right before it; the title is the card's
    // span.ttl, else the picture's alt text.
    private static List<WallpaperResult> LinkCards(HtmlDocument doc)
    {
        var cards = new List<WallpaperResult>();
        foreach (var a in doc.DocumentNode.SelectNodes("//a") ?? Enumerable.Empty<HtmlNode>())
        {
            var picture = a.SelectSingleNode(".//img") ?? PictureBefore(a);
            string thumb = PictureAddress(picture);
            var ttl = a.SelectSingleNode($".//span[{Class("ttl")}]");
            string title = ttl != null ? SitePage.Text(ttl)! : SitePage.Attr(picture, "alt").Trim();
            string href = SitePage.Attr(a, "href");
            if (thumb.Length == 0 || title.Length == 0 || href.Length == 0) continue;

            href = SitePage.OnSite(Site, href);
            if (!Uri.TryCreate(href, UriKind.Absolute, out var target)) continue;
            string path = target.AbsolutePath.Trim('/');
            if (path.Length == 0 || path.StartsWith("tag:", StringComparison.Ordinal) || path.StartsWith("search", StringComparison.Ordinal))
                continue;
            cards.Add(Card(title, SitePage.OnSite(Site, thumb), href, a));
        }
        return cards;
    }

    // The search page's results: every link in div.tmb with a title (its span.ttl, else the link's own title) is one, with
    // or without a picture (lazy loading may hide it in a <noscript>).
    private static List<WallpaperResult> ResultCards(HtmlDocument doc)
    {
        var cards = new List<WallpaperResult>();
        foreach (var a in doc.DocumentNode.SelectNodes("//div[contains(@class,'tmb')]//a") ?? Enumerable.Empty<HtmlNode>())
        {
            string thumb = PictureAddress(a.SelectSingleNode(".//img"));
            // HtmlAgilityPack keeps a <noscript>'s content as text: parse it to reach its <img>
            if (thumb.Length == 0 && a.SelectSingleNode(".//noscript") is { } noscript)
                thumb = SitePage.Attr(SitePage.Parse(noscript.InnerHtml).DocumentNode.SelectSingleNode("//img"), "src");
            var ttl = a.SelectSingleNode($".//span[{Class("ttl")}]");
            string title = ttl != null ? SitePage.Text(ttl)! : SitePage.Attr(a, "title").Trim();
            string href = SitePage.Attr(a, "href");
            if (title.Length == 0 || href.Length == 0) continue;
            cards.Add(Card(title, SitePage.OnSite(Site, thumb), SitePage.OnSite(Site, href), a));
        }
        return cards;
    }

    private static WallpaperResult Card(string title, string thumb, string page, HtmlNode link) => new()
    {
        Title = title,
        ThumbnailUrl = thumb,
        PageUrl = page,
        Resolution = SitePage.Text(link.SelectSingleNode($".//span[{Class("frm")}]")) is { Length: > 0 } size ? size : null,
    };

    // Cloudflare's lazy loading puts the real address in data-cfsrc and a placeholder in src
    private static string PictureAddress(HtmlNode? img)
    {
        string lazy = SitePage.Attr(img, "data-cfsrc");
        return lazy.Length > 0 ? lazy : SitePage.Attr(img, "src");
    }

    private static HtmlNode? PictureBefore(HtmlNode a)
    {
        var node = a.PreviousSibling;
        while (node != null && node.NodeType != HtmlNodeType.Element) node = node.PreviousSibling;
        return node?.Name == "img" ? node : null;
    }
}
