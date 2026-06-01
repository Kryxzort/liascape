---
paths:
  - "src/livepaper/Scrapers/**"
  - "src/livepaper/Services/**"
  - "src/livepaper/Helpers/WorkshopDownloader.cs"
  - "src/livepaper/Models/WorkshopFilter.cs"
---

## Wallpaper Sources

All HTTP requests must send a Firefox User-Agent:
```text
Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0
```
Use a single shared `HttpClient` instance (not one per request).

### motionbgs.com (HtmlAgilityPack)

**Listing:** `GET https://www.motionbgs.com/hx2/latest/{page}/`
- Parse `//a` tags: thumbnail from `.//img[src]` (prefer `data-cfsrc` over `src` for Cloudflare lazy-load), title from `.//span[@class='ttl']`, resolution from `.//span[@class='frm']`, page URL from `a[href]`
- Skip links where path is empty, starts with `tag:`, or starts with `search`

**Search:** `GET https://www.motionbgs.com/search?q={query}&page={page}`
- May redirect to tag page (e.g. `/tag:car/`) — detect via final URL
- Tag pages: use `ParseLinks` (same as listing)
- Search results: parse `//div[contains(@class,'tmb')]` → `//a` tags
- Thumbnail: try `img[data-cfsrc]` → `img[src]` → `noscript > img[src]` (use explicit `if (string.IsNullOrEmpty)` checks, not `??` chains — `GetAttributeValue` returns `""` not null)

**Individual page** (fetched before download):
- Preview video: `//source[@type='video/mp4'][src]`
- Download link: `//div[@class='download']//a[href]`

### moewalls.com (HtmlAgilityPack)

Plain HTTP with Firefox User-Agent works — no browser automation needed.

**Listing:** `GET https://moewalls.com/page/{page}`
**Search:** `GET https://moewalls.com/page/{page}/?s={query}`
- Parse `//li[contains(@class,'g1-collection-item')]`
- Thumbnail: `.//img[src]`
- Title + page URL: `.//a[@class='g1-frame'][title, href]`

**Individual page:**
- Preview video: `//source[@type='video/mp4'][src]` — prefix with base URL if relative
- Download element: `//*[@id='moe-download']` (use `*` not `button` — element type changed)
- Download URL: `https://go.moewalls.com/download.php?video={data-url}`
- **Downloads require a `Referer` header** set to the wallpaper's page URL.

### Wallpaper Engine local

- Workshop path: `~/.local/share/Steam/steamapps/workshop/content/431960/`
- Discovery from each `<id>/project.json`:
  - `type == "video"` → video wallpaper (`file` field = video filename)
  - `type == "scene"` or `scene.pkg` present → scene (included only when `AllowScenes` is true)
  - `type == "web"` / `"application"` → skipped always
  - `title` field becomes the wallpaper title
- Thumbnail: `preview.jpg` preferred; GIF thumbnails → static frame via ffmpeg cached to `~/.cache/livepaper/we_thumbs/<workshopId>.jpg`; fallback to any `.png`/`.jpg`/`.jpeg`
- `SupportsSorting` returns true only for this source; sort UI visible only when WE local is selected

### Wallpaper Engine Workshop (online) — `SteamWorkshopScraper` + `SteamWorkshopService`

**5th source in `Sources` list; separate pill from "Wallpaper Engine (Local)".**

**Browse/search/sort/pagination:**
- `GET https://steamcommunity.com/workshop/browse/?appid=431960&section=readytouseitems&numperpage=30`
- `&browsesort=trend&days=7` (default) / `mostrecent` / `lastupdated` / `totaluniquesubscribers`
- `&searchtext=<query>` for search; `&p=<n>` for pagination
- Tag filtering: `&requiredtags%5B%5D=<tag>` (AND semantics); supports Type, AgeRating, Resolution, multiple Genres simultaneously
- **CSS classes are obfuscated/hashed** — parse IDs from `//a[contains(@href,'filedetails/?id=')]/@href` via regex, NOT by class. Child `<img>` gives preview URL and alt-text title fallback.

**Metadata enrichment (keyless, no Steam API key needed):**
- Batch `POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/`
  - Body: `itemcount=N&publishedfileids[0]=X&publishedfileids[1]=Y…`
  - Returns: title, description, `preview_url`, `file_size` (string), `time_updated` (unix), `lifetime_subscriptions`, `lifetime_favorited`, `views`, `tags[]` (array of `{tag: string}`)
  - `result != 1` → item unavailable; skip
- Type detection via tags: `Video` / `Scene` / `Web` / `Application` / `Preset` (skip last 3)
- Resolution tag matches `\d+ x \d+` regex
- Thumbnail URL append `?imw=384&imh=216&letterbox=true` for grid thumbnails (16:9 fit)

**Genre taxonomy** (verified from `requiredtags` filter on browse page):
`Abstract`, `Animal`, `Anime`, `Cartoon`, `CGI`, `Cyberpunk`, `Fantasy`, `Game`, `Girls`, `Guys`,
`Landscape`, `Medieval`, `Memes`, `MMD`, `Music`, `Nature`, `Pixel art`, `Relaxing`, `Retro`,
`Sci-Fi`, `Sports`, `Technology`, `Television`, `Vehicle`, `Unspecified`

**Download — `WorkshopDownloader.AcquireAsync`:**
Steam blocks anonymous downloads for appid 431960. Two modes (`AppSettings.WorkshopAcquireMode`):
- `"subscribe"` (default): `xdg-open steam://url/CommunityFilePage/<id>` → poll `workshop/content/431960/<id>/project.json` (3 s intervals, 10 min timeout). Checks both WE workshop dir and `~/.cache/livepaper/steamcmd_workshop/…`.
- `"steamcmd"`: runs `steamcmd +force_install_dir ~/.cache/livepaper/steamcmd_workshop +login <SteamUsername> +workshop_download_item 431960 <id> +quit`. Password is **never stored** — one-time sign-in via `LaunchSteamCmdSignIn` opens an interactive terminal to cache Steam sentry file. Subsequent runs are non-interactive.

After acquire: `DownloadHelper.DownloadAsync` with the workshop dir as `DownloadUrl` (local file path), identical to WE Local import. `WallpaperDetail.IsWorkshopAcquire = true` signals the acquire branch in `DownloadCardsAsync`.

**Dedup**: checks both `LibraryItem.SourceId == PageUrl` AND `LibraryItem.WorkshopId == workshopId` to cover items previously imported via WE Local.
