---
paths:
  - "src/backend/Scrapers/**"
  - "src/backend/Services/**"
  - "src/backend/Helpers/WorkshopDownloader.cs"
  - "src/backend/Models/WorkshopFilter.cs"
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
- Thumbnail: `preview.jpg` preferred; GIF thumbnails → static frame via ffmpeg cached to `~/.cache/liascape/we_thumbs/<workshopId>.jpg`; fallback to any `.png`/`.jpg`/`.jpeg`
- `SupportsSorting` returns true only for this source; sort UI visible only when WE local is selected

### Wallpaper Engine Workshop (online) — `SteamWorkshopScraper` + `SteamWorkshopService`

**5th source in `Sources` list; separate pill from "Wallpaper Engine (Local)".**

**Browse = Steam's client protocol, anonymously (since 2026-11-11)** — `PublishedFile.QueryFiles` over SteamKit2's
anonymous CM session (`SteamWorkshopDetails.QueryAsync`, `SteamAnonymous`); 100 items a page with tags, previews
(YouTube ids) and descriptions inline; include/exclude tag filtering by `Helpers/WorkshopTags.cs`. Details: `web-backend.md`
§ "Workshop Browse over Steam's client protocol". The page scraping below is the **fallback** only (Steam's servers
unreachable; `LIASCAPE_WORKSHOP_FALLBACK=1` forces it): `requiredtags[]` = the plan's single-tag groups, the rest filtered
client-side.

**Browse/search/sort/pagination (fallback):**
- `GET https://steamcommunity.com/workshop/browse/?appid=431960&section=readytouseitems&numperpage=30`
- `&browsesort=` (all verified valid + distinct): `trend` (+`&days=` 1/7/30/90/180/365 = Today/Week/Month/3mo/6mo/Year), `mostrecent`, `lastupdated` (Recently Updated), `totaluniquesubscribers` (Most Subscribed), `toprated` (Top Rated). UI = a "Sort by" dropdown + a "Period" dropdown shown only for Most Popular. Client-side custom sorts are NOT viable (infinite scroll only loads pages in Steam's order; would scramble).
- `&searchtext=<query>` for search; `&p=<n>` for pagination
- Tag filtering: `&requiredtags%5B%5D=<tag>` (AND semantics); supports Type, AgeRating, Resolution, multiple Genres simultaneously
- **CSS classes are obfuscated/hashed** — parse IDs from `//a[contains(@href,'filedetails/?id=')]/@href` via regex, NOT by class. Child `<img>` gives preview URL and alt-text title fallback.

**Metadata enrichment (fallback path; keyless, no Steam API key needed):**
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

**Full filter taxonomy** (scraped from the browse page's embedded JSON `{"name":<category>,"tags":[…]}`; the filter UI is React with obfuscated classes, but the option values live in that escaped-JSON blob). Categories: Type, Genre, Age Rating, Resolution, Misc, Category, plus Asset/Preset subtypes. Implemented as `requiredtags[]` (AND):
- **Type** (only playable shown): `Video`, `Scene`. (`Web`/`Application`/`Preset`/`Asset`/`Wallpaper` exist but are skipped — unplayable.)
- **Age Rating**: `Everyone`, `Questionable`, `Mature`.
- **Resolution** (full list): `Standard Definition`, `1280 x 720`, `1366 x 768`, `1920 x 1080`, `2560 x 1440`, `3840 x 2160`, `Ultrawide Standard Definition`, `Ultrawide 2560 x 1080`, `Ultrawide 3440 x 1440`, `Dual Standard Definition`, `Dual 3840 x 1080`, `Dual 5120 x 1440`, `Dual 7680 x 2160`, `Triple Standard Definition`, `Triple 4096 x 768`, `Triple 5760 x 1080`, `Triple 7680 x 1440`, `Triple 11520 x 2160`, `Portrait Standard Definition`, `Portrait 720 x 1280`, `Portrait 1080 x 1920`, `Portrait 1440 x 2560`, `Portrait 2160 x 3840`, `Other resolution`, `Dynamic resolution`.
- **Features** (Misc group, multi-select; full set also includes admin/niche ones not exposed): `Approved`, `Verified`, `Audio responsive`, `HDR`, `3D`, `Customizable`, `Media Integration`, `Puppet Warp`, `Video Texture`, `No Animation`, `Multi-monitor optimized`.
- Not exposed (niche / scene-element or asset/preset subtypes): `Background`/`Character`/`Clock`/`Fire`/`Interactive`/`Magic`/`Post Processing`/`Smoke`/`Space`/`Audio Visualizer` (Category), `Particle`/`Image`/`Sound`/`Model`/`Text`/`Sprite`/`Fullscreen`/`Composite`/`Script`/`Effect`/`Scripted Layer` (Asset), `Boolean`/`Number`/`Vec2..4`/`String` (Preset).

**Download — `WorkshopDownloader.AcquireAsync`:**
Steam blocks anonymous downloads for appid 431960. Two modes (`AppSettings.WorkshopDownloadMode`, Settings → "Getting
Workshop wallpapers"):
- `"subscribe"` (default, "Subscribe via Steam") — a real subscription, so Steam keeps the item synced and updated:
  - **Signed in** (`SteamAuthService.HasUsableSignIn`: a refresh token Steam hasn't turned down, or a pasted cookie): the
    community AJAX endpoint `POST steamcommunity.com/sharedfiles/subscribe` (the website's Subscribe button) with the
    `steamLoginSecure` cookie minted from the refresh token (`GetCookieAsync` → finalizelogin → settokens), through `SteamGate`.
    Status "Subscribing on Steam…" → "Subscribed — waiting for Steam to download…".
  - **Not signed in — the Steam app does it** (owner 2026-11-11: "is it a dead end for users without mobile guard?" — the QR
    sign-in needs the Steam mobile app; he chose both a password sign-in and this): no sign-in, a sign-in Steam turned down
    (`SteamSignInRejected` — no finalizelogin is attempted again), a mint that failed, or Steam turning down the subscribe
    request → `xdg-open steam://url/CommunityFilePage/<id>` (`OpenInSteamApp`: `setsid sh -c 'exec xdg-open …'`, detached
    from the backend's process group; it starts Steam when it isn't running) and the download's `download-progress` status
    says why + what to do: "Not signed in to Steam here — click Subscribe in Steam, then it downloads by itself…" (or "Steam
    signed this app out — …", "Steam turned down the subscribe request — …"). Log `workshop: <id>: <why> — opened its page in
    the Steam app, waiting for the download`. An item already on disk with no usable sign-in opens nothing (imported at once).
    A rate limit (`SteamRateLimitException`) does NOT fall back — the app's page is steamcommunity.com from the same connection.
  - **Through the Steam client (`WorkshopDownloadMode` `"steamapp"`, Settings "Use the Steam app" — the first of three radios,
    opt-in; owner 2026-11-11: "drive steam" → "yeah, try it", then "why is this a checkbox")** — tried FIRST in that mode, then
    the `"subscribe"` paths below: `Helpers/SteamClientUgc.cs` runs a short-lived child
    (`liascape-backend steam-ugc subscribe <id> <steamclient.so>…`, `SteamAppId=431960` in its environment only) that loads the
    Steam client's OWN `steamclient.so` (`~/.steam/sdk64/`, the Steam dir, Flatpak; `SteamClientLibPath` overrides) — never
    Valve's `libsteam_api.so` (an adapter over it, not ours to ship, and only SteamVR / Proton 9 carry a copy: owner "what if
    other users dont got steamvr?") — and calls ISteamClient `SteamClient020` / ISteamUGC `STEAMUGC_INTERFACE_VERSION018` by
    vtable slot (read from Valve's own wrappers with objdump, the slots in the file's header). SubscribeItem, then
    GetItemState / GetItemDownloadInfo (Steam's bytes → a real percent on the card, "Steam is downloading it…") until
    installed; GetItemInstallInfo = the folder Steam chose (imported from there — no folder polling; `DownloadHelper` compares it with the WE folder setting as REAL paths — `RealPath` — so a setting that reaches Steam's folder through a symlink still LINKS the item into `local/` instead of copying it to `workshop/`: owner 2026-11-11, a 369 MB duplicate). Needs Steam running +
    signed in to an account that OWNS Wallpaper Engine (installed: probably — Steam puts Workshop items in the game's library;
    unverified); Steam shows "Playing Wallpaper Engine" while the child is connected. Steam refusing (not running / not owned
    → `ConnectToGlobalUser` 0), no `steamclient.so` → logged `workshop: <id>: not through the Steam app's Workshop interface —
    <why>` and the paths below run as before. Cancel closes the child's stdin → it releases its user + pipe and exits (3 s,
    then killed). Measured live (Python prototype through `steamclient.so` + libsteam_api): subscribe 0.5 s, bytes 0.8 → 1.1 →
    2.1 MB, installed 4.5 s. Guard: `test-steam-signin.sh` § 3 (a fake `steamclient.so`, `scripts/test-fixtures/`).
  - **Four modes, the user's choice** (owner 2026-11-11: "getting workshop wallpapers should have 4 options not 3, the 4th being
    the one which opens the wallpaper in your app" — it overturned the earlier "automatic, no third mode" call, under which
    opening the page was only the sign-in's silent fallback): `steamapp` (the Steam client, below), **`steampage`** (always
    the item's page in the Steam app — never the sign-in, even when there is one; status "Click Subscribe in Steam, then it
    downloads by itself…"; Delete from source unsubscribes in the Steam app too), `subscribe` (the sign-in; without one it
    still falls back to the page, so a download is never a dead end) and `steamcmd`. Settings shows the sign-in row under
    `subscribe` only.
  - Either way it then polls every Workshop root (the WE folder, `~/.cache/liascape/steamcmd_workshop/…`, standard + Flatpak
    Steam, every `libraryfolders.vdf` library) every 3 s (`LIASCAPE_WORKSHOP_POLL_MS` shortens it for the test) until the
    media file exists, is non-empty and has the same size on two polls — tracked PER PATH (owner 2026-11-11: Steam's `~/.local/share/Steam/…/content/431960` a symlink to another library's folder → two paths to one folder; one shared "last size" slot alternated between them and the download said "Downloading…" for the full 10 min; guard: `test-steam-signin.sh` "Workshop folder reached through a symlink"); while it waits it reports the phase as the `download-progress` status — "Steam is downloading it…" once Steam's staging folder `<workshop>/downloads/431960/<id>` exists (each content root's `../../downloads`; Steam moves it to `content/` at the end), "Steam is finishing…" once the files are in but not yet steady — phases only, no percent (Steam may reserve a staged file's full size before writing it; owner 2026-11-11: a 458 MB item showed "Downloading…" over an empty bar for a minute); 10 min timeout (its message says to click Subscribe
    on the page Steam opened, or sign in); cancellable — the UI's Cancel aborts `/download` → `RequestAborted`.
- `"steamcmd"`: runs `steamcmd +force_install_dir ~/.cache/liascape/steamcmd_workshop +login <SteamUsername> +workshop_download_item 431960 <id> +quit`. Password is **never stored** — one-time sign-in via `LaunchSteamCmdSignIn` opens an interactive terminal to cache Steam sentry file. Subsequent runs are non-interactive.

**Unsubscribe** ("Delete from source" → `WorkshopUnsubQueue` pending → `DrainUnsubQueueAsync`): under **`steamapp`** first the
Steam client (`SteamClientUgc.UnsubscribeAsync` → the helper `steam-ugc unsubscribe <id,id,…>`, ISteamUGC UnsubscribeItem slot 69,
each id confirmed by its state losing "subscribed" within 10 s → `MarkBlocked`; owner 2026-11-11: "clicked the unsubscribe
button but for some reason it took me to the steam page instead of handling it itself") — what it can't confirm (Steam not
running, not owned) goes on below; `steampage` → always the Steam app; else signed in → `POST
…/sharedfiles/unsubscribe` per id (spaced, a rate limit stops the drain and says so); **not signed in** (or Steam ends the
sign-in mid-drain) → `UnsubscribeInSteamApp`: the ids Steam still has in its own Workshop folders (our steamcmd cache isn't a
subscription) open in the Steam app — one → `steam://url/CommunityFilePage/<id>`, several →
`steam://openurl/https://steamcommunity.com/my/myworkshopfiles/?appid=431960&browsefilter=mysubscriptions` — for the user to
click Unsubscribe; every id goes pending → blocked (AutoImport keeps the folder out until Steam removes it, as after a real
unsubscribe; downloading it again unblocks). The finishing `unsub-progress` carries `openedInSteam` + `message` ("Not signed in
to Steam here — Steam opened the item: click Unsubscribe there."), which the UI's status bar holds.

**Sign-in** (`SteamAuthService`; both store the same way — `SaveSignIn`: refresh token, Steam ID, account name, clears
`SteamSignInRejected` + the cached cookie): **QR** (`LoginViaQrAsync`, the Steam mobile app) or **account name + password**
(`LoginViaCredentialsAsync`: SteamKit2 `BeginAuthSessionViaCredentialsAsync`, WebBrowser platform + website "Community" like
the QR so finalizelogin works, `IsPersistentSession` for a long-lived token; an `IAuthenticator` asks the UI for an emailed
Steam Guard code / the mobile authenticator's code / approval in the app — `web-backend.md` § Steam sign-in). The password is
handed to Steam once and never stored, logged or broadcast.
Hermetic test (no account, no Steam): `scripts/test-steam-signin.sh` — the hidden `steam-selftest` + a private backend with a
stub `xdg-open` and a fake Workshop folder.

After acquire: `DownloadHelper.DownloadAsync` with the workshop dir as `DownloadUrl` (local file path), identical to WE Local import. `WallpaperDetail.IsWorkshopAcquire = true` signals the acquire branch in `DownloadCardsAsync`.

**Dedup**: checks both `LibraryItem.SourceId == PageUrl` AND `LibraryItem.WorkshopId == workshopId` to cover items previously imported via WE Local.

**Preview thumbnails / animation:** the scraper still exposes the resized `preview_url + ?imw=384&imh=216&letterbox=true` (static) and the raw full-res `preview_url` (animated). In the web UI these animate via `MotionThumb` — a gif/webp `<img>` the browser decodes off-thread (see `web-ui.md`). Remote bytes go through the `/img` proxy + browser cache.

**Debug:** the `DebugMode` setting enables `DebugHud` (`app/ui/src/debug/`) — an on-screen FPS/metrics overlay (toggled by `DebugOverlay`) plus a socket-driven self-drive bridge for scripted UI tests. For CDP inspection, launch the Electron shell with `LIASCAPE_DEBUG=1` and drive `:9222` via `node app/shell/cdp.js "<expr>"`.
