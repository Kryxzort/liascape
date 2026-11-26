using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using HtmlAgilityPack;
using Liascape.Models;

namespace Liascape.Scrapers;

// desktophut.com, read from its pages (fixtures: scripts/test-fixtures/scrapers/desktophut/). The animated-wallpapers
// category (/category/Animated-Wallpapers?page=<n>) and a search (/search/<query>?page=<n>) are the same grid of
// a.wallpaper-card links; a wallpaper's page has one player whose mp4 is both what the sidebar previews and what a download
// fetches (the site offers no other file without its own download flow).
internal static partial class DesktophutScraper
{
    private const string Site = "https://www.desktophut.com";

    // the category's page, or a search's when `query` is set
    public static async Task<List<WallpaperResult>> ListAsync(int page, string? query)
    {
        string url = query == null
            ? $"{Site}/category/Animated-Wallpapers?page={page}"
            : $"{Site}/search/{Uri.EscapeDataString(query)}?page={page}";
        var (doc, _) = await SitePage.GetAsync(url);
        var cards = new List<WallpaperResult>();
        foreach (var a in doc.DocumentNode.SelectNodes("//a[contains(@class,'wallpaper-card')]") ?? Enumerable.Empty<HtmlNode>())
        {
            string href = SitePage.Attr(a, "href");
            // aria-label is the card's own name; the title attribute is an SEO line ("Download X live wallpaper (4K/HD)")
            string label = SitePage.Attr(a, "aria-label").Trim();
            if (label.Length == 0) label = SitePage.Attr(a, "title").Trim();
            if (href.Length == 0 || label.Length == 0) continue;
            cards.Add(new WallpaperResult
            {
                Title = NameIn(label),
                ThumbnailUrl = SitePage.Attr(a.SelectSingleNode(".//img"), "src"),
                PageUrl = SitePage.OnSite(Site, href),
            });
        }
        return cards;
    }

    public static async Task<WallpaperDetail> DetailAsync(WallpaperResult card)
    {
        var (doc, _) = await SitePage.GetAsync(card.PageUrl);
        string mp4 = SitePage.OnSite(Site, SitePage.Attr(SitePage.Needed(doc, "//source[@type='video/mp4']", "the video", card.PageUrl), "src"));
        return new WallpaperDetail { Title = card.Title.Length > 0 ? card.Title : SitePage.PageName(doc, card.PageUrl), PreviewUrl = mp4, DownloadUrl = mp4 };
    }

    // "Download Neon City Live Wallpaper — animated wallpaper" → "Neon City": the leading "Download" and everything from
    // "live wallpaper" on go; a label that would end up empty stays whole
    private static string NameIn(string label)
    {
        string name = SuffixRe().Replace(DownloadRe().Replace(label, ""), "").Trim();
        return name.Length > 0 ? name : label;
    }

    [GeneratedRegex(@"^Download\s+")]
    private static partial Regex DownloadRe();

    [GeneratedRegex(@"\s+[Ll]ive [Ww]allpaper.*$")]
    private static partial Regex SuffixRe();
}
