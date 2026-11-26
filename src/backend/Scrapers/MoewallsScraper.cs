using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using HtmlAgilityPack;
using Liascape.Models;

namespace Liascape.Scrapers;

// moewalls.com, read from its pages (fixtures: scripts/test-fixtures/scrapers/moewalls/). A WordPress theme: the latest list
// (/page/<n>) and a search (/page/<n>/?s=…) are the same grid of li.g1-collection-item, each card's a.g1-frame holding its
// title and page; the grid also holds ad slots, which have no frame. A wallpaper's page has a preview player and a download
// button whose data-url is the key go.moewalls.com's download takes. That download, like the site's thumbnails, is refused
// without the wallpaper's page as Referer (.claude/rules/backend/sources-steam.md § Scrapers).
internal static class MoewallsScraper
{
    private const string Site = "https://moewalls.com";

    // the latest list's page, or a search's when `query` is set
    public static async Task<List<WallpaperResult>> ListAsync(int page, string? query)
    {
        string url = query == null ? $"{Site}/page/{page}" : $"{Site}/page/{page}/?s={Uri.EscapeDataString(query)}";
        var (doc, _) = await SitePage.GetAsync(url);
        var cards = new List<WallpaperResult>();
        foreach (var item in doc.DocumentNode.SelectNodes("//li[contains(@class,'g1-collection-item')]") ?? Enumerable.Empty<HtmlNode>())
        {
            var frame = item.SelectSingleNode(".//a[contains(concat(' ', normalize-space(@class), ' '), ' g1-frame ')]");
            string title = SitePage.Attr(frame, "title").Trim();
            string href = SitePage.Attr(frame, "href");
            if (title.Length == 0 || href.Length == 0) continue;
            cards.Add(new WallpaperResult
            {
                Title = title,
                ThumbnailUrl = SitePage.OnSite(Site, SitePage.Attr(item.SelectSingleNode(".//img"), "src")),
                PageUrl = href,
            });
        }
        return cards;
    }

    public static async Task<WallpaperDetail> DetailAsync(WallpaperResult card)
    {
        var (doc, _) = await SitePage.GetAsync(card.PageUrl);
        var video = SitePage.Needed(doc, "//source[@type='video/mp4']", "the preview video", card.PageUrl);
        string key = SitePage.Attr(SitePage.Needed(doc, "//*[@id='moe-download']", "the download button", card.PageUrl), "data-url");
        if (key.Length == 0) throw new System.IO.InvalidDataException($"the download button has no data-url on {card.PageUrl}");
        return new WallpaperDetail
        {
            Title = card.Title.Length > 0 ? card.Title : SitePage.PageName(doc, card.PageUrl),
            PreviewUrl = SitePage.OnSite(Site, SitePage.Attr(video, "src")),
            // data-url arrives already URL-encoded: it goes into the query as it is
            DownloadUrl = "https://go.moewalls.com/download.php?video=" + key,
            Referrer = card.PageUrl,
        };
    }
}
