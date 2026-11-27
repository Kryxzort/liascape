---
paths:
  - "src/backend/Scrapers/**"
  - "src/backend/Services/**"
  - "src/backend/HttpClientProvider.cs"
  - "src/backend/Models/WorkshopFilter.cs"
  - "src/backend/Helpers/Steam*.cs"
  - "src/backend/Helpers/SecretStore.cs"
  - "src/backend/Helpers/Workshop*.cs"
  - "src/backend/Web/Steam*.cs"
  - "src/backend/Web/WorkshopSubOps.cs"
  - "src/backend/Web/WorkshopSocialOps.cs"
  - "src/backend/Web/PresetDownloads.cs"
  - "src/backend/Models/WorkshopList.cs"
  - "scripts/test-steam-signin.sh"
  - "scripts/test-steam-app-hold.sh"
  - "app/ui/src/hooks/useSteamAppPresence.ts"
  - "scripts/test-workshop-social.sh"
  - "scripts/test-fixtures/**"
---

# Wallpaper sources and Steam

Sources (the order of `ServerHost`'s providers array = the UI's source pills): motionbgs, moewalls, desktophut,
Wallpaper Engine (Local), Wallpaper Engine (Workshop). Selectors and URLs: the scrapers themselves. How the Steam side
works (sessions, the one-off and preset-base routes, the favourites cache, the test stand-ins):
`docs/backend/steam-workshop.md`. Why behind the choices: `docs/decisions.md` § Steam & sources.

## Scrapers (HTTP + HtmlAgilityPack)
- Fetch a site's page through `SitePage.GetAsync` (`src/backend/Scrapers/SitePage.cs`): the Firefox User-Agent from `HttpClientProvider` and its one shared `HttpClient`, never one per request.
- `GetAttributeValue` returns `""`, not null: test with `string.IsNullOrEmpty` (or `SitePage.Attr`), not `??` chains.
- Pin every parser with a fixture: each site's pages in `scripts/test-fixtures/scrapers/<site>/`, trimmed to the elements the parser reads (never a whole page), and what each source asks for and returns in `expected.json`. A site that changed its markup: capture its page again, trim it the same way and fix the parser until `scraper-selftest` passes; `--write` only to pin a deliberate change, after reading the diff. Guard: `scraper-selftest`.
- Keep the web sources' page addresses as they are (motionbgs' `www.` included, though the site redirects it): a downloaded item's source id is its page address, which de-duplicates it.
- moewalls downloads need `Referer` = the wallpaper's page URL; the `/img` proxy sends it for moewalls thumbnails.
- Steam's Workshop page CSS classes are hashed: parse item ids from `filedetails/?id=` hrefs.
- WE local: `project.json` `type` video → video, scene or `scene.pkg` → scene (only with `AllowScenes`), a preset naming a
  Workshop base → its own card, `isPreset` + `isScene` (only while presets can play: `WallpaperEngineService.AllowPresets`,
  set like the Workshop's), web/application → skipped. Guard: probe-filters `local:wePreset`. Adding such a preset adds its
  base from the same folder, no download mode (`PresetDownloads.AddLocalBaseAsync`). Guard: `scripts/test-presets.sh` § 1
  Wallpaper Engine (Local).

## Steam Community rate limits (`Helpers/SteamGate.cs`)
- Send EVERY steamcommunity.com request through `SteamGate.SendAsync(req, kind)`; never call it around the gate. Steam blocks the user's IP for 30+ min once tripped.
- A 429 (or the subscribe 403 "too many", via `Trip`) starts an app-wide cooldown, persisted in `$XDG_CACHE_HOME/liascape/steam-cooldown.json`. During it nothing is sent: `SteamCooldownException` → 429 `{error, cooldownMs}` (`.Body`).
- The cooldown's end is the backend's alone: `/steam/status` `cooldownMs`, and its own `steam-cooldown` event when it starts, grows or ends (`SteamGate.Changed` → `SteamOps.CooldownChanged`, a timer at its end); never a whole `steam-status`, whose sign-in could be older than a sign-out sent meanwhile. Guard: `test-workshop-social.sh` § 4.
- Prefer no request: Browse, details and trailers ask Steam's CM servers first. Not gated: the sign-in itself and api.steampowered.com.

## Workshop Browse over Steam's client protocol (`Services/SteamWorkshopService.cs`)
- Query anonymously with SteamKit2 `PublishedFile.QueryFiles` through ONE shared session (`Helpers/SteamAnonymous.cs`): serialized, never throws (null on failure, then no retry for 60 s).
- `serve`'s stop must close every Steam client session (an open one keeps a SIGTERMed backend alive): get a new
  `SteamClient` from `SteamAnonymous.NewClient`, connect it through `SteamAnonymous.Connect` and end it on `Stopping`.
  Guard: `scripts/test-backend-stop.sh` § steam, qr, lookup; steam-selftest "steam session".
- Filter semantics (`Helpers/WorkshopTags.cs` `Build`): a group's includes are ONE taggroup (OR); Features are ANDed unless `featureMatch: "any"`; Genres ORed unless `genreMatch: "all"`; any age filter drops untagged items; Type always excludes Web / Application (and Scene with `AllowScenes` off). Never make application wallpapers playable: one is a downloaded Windows program to run, and Wallpaper Engine itself took the type off the Workshop after malware.
- Offer Preset as a Type only with presets allowed (`SteamWorkshopService.AllowPresets` = `AllowScenes` + the Liascape
  player, set by `ServerHost.ConfigureProvider`); ticked without that → no request (`Plan.Empty`). Steam tags a preset
  `Preset` + its base's type, so `Build` puts `Preset` in `excludedtags` unless it is ticked and allowed (a Scene query
  alone would return presets), and a web-based preset stays out through `Web`. A preset result is `isPreset` + `isScene`
  (`SteamWorkshopScraper.MapToResults`). Guard: steam-selftest "presets: …", `test-workshop-social.sh` § 5.
- A scene's presets (`/browse` `list: {kind: "presets", id}`): `SteamWorkshopDetails.QueryChildrenAsync` on the
  anonymous session, the filter's other groups with Type = Preset (`WorkshopTags.ForPresets`), 100 a page; keep a
  result only when its own children name the scene. No page fallback (Steam unreachable → the list's error), presets
  not allowed → `[]`. Guard: `test-workshop-social.sh` § 5.
- Connect the session ahead of a page only on a sign the user is about to ask for one (the Browse tab or a Workshop
  pill hovered or focused: `api.steamWarm` → `POST /steam/warm` → `SteamAnonymous.Warm`); never a blind connect at app
  start. The warm-up never blocks or shows an error, does nothing under `LIASCAPE_STEAM_CM_FIXTURE` /
  `LIASCAPE_WORKSHOP_FALLBACK=1` or offline, and backs off 5 min after a failure without touching the requests' 60 s
  gap. Guard: steam-selftest "warm-up", probe-steam `browse:warm`.
- Prefetch the next page only after the current one and only on the CM path; compare filters by value (`Key()`).
- Fallback (CM unreachable, or `LIASCAPE_WORKSHOP_FALLBACK=1`): the browse page via `SteamGate`, filtering the rest client-side with `WorkshopTags.Matches`.
- `QueryFiles` pages hold 100 (Steam's cap); `GetDetails` takes up to 1000 ids a request (both measured: docs/decisions.md § "Ask Steam for a whole library's details in one request").
- Tests never reach Steam's servers: point every `SteamClient` at a stand-in with `LIASCAPE_STEAM_CM_SERVER` /
  `LIASCAPE_STEAM_DIRECTORY`, or answer from a file with `LIASCAPE_STEAM_CM_FIXTURE` (its format:
  `docs/backend/steam-workshop.md` § Test stand-ins for Steam). Guard: steam-selftest "fixture query", probe-steam `browse:fixture`.
- A new way out (another HttpClient, a socket, a SteamKit2 client) calls `TestNetwork.Check` first, so
  `LIASCAPE_TEST_NO_NETWORK=1` refuses it in tests. Guard: steam-selftest "no network".

## Secrets (`Helpers/SecretStore.cs`)
- Every reader/writer of the Steam tokens goes through `SteamAuthService` → `SecretStore` (`steam-refresh-token`, `steam-access-token`, `steam-login-secure`).
- Primary: the Secret Service via `secret-tool`, value on stdin/stdout, never argv. Fallback: `~/.config/liascape/steam-auth.json` (0600, `AtomicFile.WritePrivate`), also forced by `LIASCAPE_SECRETS=file`.
- A failed or denied keyring lookup = signed out, and the keyring isn't asked again for 10 min (no prompt loop).
- Log which store is in use, never a value. Never write a token to settings.json.

## Sign-in (`SteamAuthService`, `Web/SteamOps.cs`)
- QR (`LoginViaQrAsync`) or account + password (`LoginViaCredentialsAsync`); both store through `SaveSignIn`.
- The password: bind the body to a class whose `ToString` prints nothing (`LoginReq`), take it once (`TakePassword`), hand it to SteamKit2 and drop it. Never log, broadcast or store it, and never put it in an exception message. Guard: `liascape-backend steam-selftest` (fails if the password appears anywhere or a token reaches settings.json).
- Never retry a sign-in automatically. After a rate-limit result refuse new attempts for 15 min (`LoginHold`) without contacting Steam.
- Log lines name the step, never the account name.

## Workshop downloads (`Helpers/WorkshopDownloader.cs`, `WorkshopDownloadMode`)
- Modes: `steamapp` (the default: the running Steam client through `Helpers/SteamClientUgc.cs`) and `subscribe` (the
  sign-in); any other stored value reads as `steamapp` (the `AppSettings.WorkshopDownloadMode` setter). Every action
  takes one fallback order, each step only when the one before can't do it: the chosen mode; under `steamapp` the
  sign-in when one is usable (`SteamAuthService.HasUsableSignIn`); then the item's page in the Steam app through the
  Steam to-do ("Opened in Steam: subscribe there and it downloads here", `WorkshopDownloader.OpenedInSteam`). Nothing
  else stands in (`docs/decisions.md` § "Offer two Workshop download modes, the Steam page the last resort"):
  `subscribe` never uses the Steam client and goes straight to the page signed out; a rate limit is never a reason
  for the page — it throws, and Undo's re-subscribe sends nothing more and says so (steam-selftest "undo's
  re-subscribe, rate-limited"). The same order serves Downloads (`AcquireViaSubscribeAsync`), Subscribe
  (`SubscribeOnlyAsync`), the unsubscribe drain (`DrainUnsubQueueAsync`: a sign-in Steam turns down mid-drain → the
  rest's pages), Undo's re-subscribe (`ResubscribeAsync`) and a link import. Guard: `test-steam-signin.sh` § 2, § 3 b.,
  d., f., g.; steam-selftest "unsub, signed out", "undo's re-subscribe"; `scripts/test-item-actions.sh` § link.
- One rule says which Workshop actions a mode can't do now: `WorkshopDownloader.Blocked` / `BlockedFor`, mirrored by
  `components/subscribeMode.ts` `actionBlocked` (from `/steam/status` `usable`). The one action off is `subscribe`'s
  "Download without subscribing" without a usable sign-in ("Sign in to Steam to download without subscribing"); the
  control shows it disabled up front with those words, and the endpoints (`/download`, `/workshop/subscribe`,
  `/unsubscribe`, `/unsubscribe-keep`, `/delete-from-source`) answer 400 with them before anything reaches Steam. An
  unsubscribe in its Undo window stays queued through a sign-out (`SteamOps.SignInLost`); its drain takes the order.
  Guard: steam-selftest "action rule", "sign-out in the Undo window"; probe-steam `side:oneOff:modes`, `side:blocked:*`,
  `side:unsub:signedOut`, `steam:subToggle:signedOut`.
- Show the Steam client's failure (`SteamClientUgc.FailureMessage`) only where no step is left: a one-off without a
  usable sign-in, and the to-do's "Let the Steam app do all N" (the user's explicit switch, which never falls back).
  Guard: `test-steam-signin.sh` § 3 j.
- `SteamClientUgc` loads the Steam client's own `steamclient.so` in a child (`liascape-backend steam-ugc session …`, commands on its stdin); never ship or load Valve's `libsteam_api.so`. One child, and one operation on it, at a time app-wide (`SteamClientUgc.Turn`); `ProbeAsync` is exempt (a connected child answers it without a second connection).
- Hold that child (`Helpers/SteamClientHold.cs`) from the first operation while the Liascape window is open under
  `steamapp` (`app/ui/src/hooks/useSteamAppPresence.ts` beats), until `Tail` after the last beat or operation; never
  connect for the window alone, never hold for the backend's lifetime. The backend's stop releases it at once; a dead
  child is never `appConnected` (`/steam/status`) and the next operation starts a fresh one. Why: `docs/decisions.md`
  § "Hold the Steam app connection while the Liascape window is open". Guard: `scripts/test-steam-app-hold.sh`,
  probe-steam `browse:appPresence`.
- Every Steam page the user must click goes through ONE app-wide queue, one page at a time: the Steam to-do (`Web/SteamTodo.cs`). Never open several pages at once or the subscriptions list.
- A to-do subscribe entry ends by itself only when its item was absent at its turn and its files then appear (`ItemOnDisk`, `WatchDisk`); otherwise it waits for the user's Next. Unsubscribe entries always wait for Next.
- A queued unsubscribe stays `pending` until Next → `MarkBlocked`; Skip/Stop → `Unblock` (kept subscribed).
- The page's unsubscribe (`UnsubscribeInSteamApp`) opens a page only for ids with a folder in a Steam Workshop root; the rest are blocked at once, no page (an owned `workshop/<id>` copy was never a subscription). It claims the ids while they go in (`WorkshopUnsubQueue.Claim`), so one an Undo took back since the drain's snapshot gets neither. Guard: steam-selftest "unsub, an id withdrawn since the drain's snapshot".
- Poll every Workshop root for the media file, tracking stability PER PATH (Steam's folder may be reachable through a symlink); report phases, not a percent. Compare folders as real paths (`RealPath`).
- Dedup on both `SourceId == PageUrl` and `WorkshopId`.
- The Browse sidebar's Unsubscribe of a library item = Delete from source (trash + unsubscribe, undoable); its right-click "Unsubscribe without deleting" is its own route, `POST /workshop/unsubscribe-keep` (`WorkshopSubOps.UnsubscribeKeepAsync`), which never trashes or deletes: the library's copy is made first, and a failed copy unsubscribes nothing. Guard: `test-steam-signin.sh` § 3 i.
- "Download without subscribing" (`WorkshopDownloader.AcquireOneOffAsync`) makes the library's own `workshop/<id>` copy
  by the download mode's own route (`OneOffRouteOf`, `GET /workshop/one-off`; none = the entries disabled with the
  reason, `/download` 400) — never a Steam page, a to-do entry or an `Unblock`; a subscription the user already had is
  copied and left alone. The routes: `docs/backend/steam-workshop.md` § "Download without subscribing". Guard:
  `test-steam-signin.sh` § 2 (one-off), § 3 j., steam-selftest "one-off route", "reconcile", probe-steam `side:oneOff:*`.
- A preset brings its base scene by the route its download took (`WorkshopDownloader.Took`) and its action, never
  another (`Web/PresetDownloads.cs`): reuse a base already in the library, never fetch one whose Steam kind isn't
  `scene`, never acquire a folder Steam delivered again. A "Download & apply" of a preset waits for its base, then
  applies; one that still can't play answers `notApplied: <reason>`, never a 500. Unsubscribing or deleting a preset
  never touches its base. The routes: `docs/backend/steam-workshop.md` § A preset's base scene. Guard:
  `test-steam-signin.sh` § 2 (presets), § 3 k.
- Redownload of an item Steam left empty (`src/backend/Web/RedownloadOps.cs`) takes the same order: under `steamapp` the client's `DownloadItem` at high priority (`SteamClientUgc.DownloadAsync`) mends Steam's folder in place; the sign-in never stands in (it can only subscribe, and the item is subscribed); then the item's page through the Steam to-do. The library's own copy comes again by the one-off's route (`AcquireOneOffAsync`, never a page) and its files replace the empty ones at the same path. Guard: `scripts/test-item-actions.sh` § incomplete.
- "Open on Steam" → `POST /steam/open-page` (`steam://url/CommunityFilePage/<digits>`); it is not a to-do entry.

## Workshop community: favourites, comments, creators (`Helpers/SteamCommunity.cs`, `Web/WorkshopSocialOps.cs`)
- Reading works signed out (comments, a profile's XML); favourite / unfavourite and posting a comment need the sign-in's cookie and answer 403 `{error, signIn: true}` without one, sending nothing.
- Without a usable sign-in the sidebar's star and comment box are "Favourite on Steam" / "Comment on Steam": the item's
  page in the Steam app (`POST /steam/open-page`, the star's with `{watch: "favorite"}`, which under `steamapp` watches
  the Steam app account's favourites through the held child and hands a flip to `WorkshopFavorites.Apply`). Guard:
  `scripts/test-steam-app-hold.sh` k.–m., probe-steam `ws:favoriteSteam`, `ws:commentSteam`.
- Every call goes through `SteamGate` (Interactive; the favourites cache's own diffs and checks Background); the UI asks only for what the user looks at (WorkshopSocial.tsx: after the sidebar settles, comments once in view) and keeps answers for the session; the backend keeps profiles per run.
- Comment HTML is Steam's, untrusted: only plain text, a name, an http(s) avatar URL, ids and times leave the backend (`ParseComments`); the UI renders them as text only.
- Read a user's files from `PublishedFile.GetUserFiles` on the anonymous CM session, never the community site (a
  creator's list is Browse's only user-files list). Guard: steam-selftest "user files: ids only = …", "user files: total only".
- The Author field (`GET /workshop/author?q=`, `Helpers/SteamAuthors.cs`) never asks Steam for a bare name (a request
  per typo): it matches names this run and the library already know. Guard: `test-workshop-social.sh` § 1c.
- Compare a favourites page's ids, never its "of N entries"; a 200 page without the list's paging line is no answer,
  never "all removed" (`ParseFavoritesPage`). Guard: steam-selftest "favourites page: …", `test-workshop-social.sh` § 7
  "every favourite removed on Steam, …".
- The Workshop details cache (`Helpers/WorkshopDetailsCache.cs`) is written by the serve process alone; send
  `GetDetails` only for the ids it lacks, and never store "no public item" on disk. Guard: `test-workshop-social.sh` § 6.
- The signed-in account's favourites (`Helpers/WorkshopFavorites.cs`): no usable sign-in → `{signedIn: false}` with
  nothing sent; never show another account's list; write the file only for a whole list (0600,
  `AtomicFile.WritePrivate`); no timer — reads run on `open` / `check`; log counts, never a Steam ID or a favourite's id.
  Guard: `test-workshop-social.sh` § 7, steam-selftest "favourites merge: …".
- The item counts are Steam's current `subscriptions` / `favorited`, never the `lifetime_*` ones. Guard: `test-workshop-social.sh`.
- The Library sidebar shows the same pieces for a Workshop item (the Browse sidebar's components) plus its counts from `GET /workshop/counts` (`GetDetails` on the anonymous CM session, never the community site): one request per item however many asks land together (the creator's too), kept 15 min; a failed ask is not kept. Guard: `test-workshop-social.sh` § 1b.
- A preset's base, `GET /workshop/base?id=` (`WorkshopSocialOps.BaseOfAsync`): 404 = not a preset, 400 = a non-digit id. Guard: `test-workshop-social.sh` § 5.
- Tests point `LIASCAPE_STEAM_COMMUNITY` / `LIASCAPE_STEAM_API` at `scripts/test-fixtures/fake-steam-community.mjs`; nothing in a test favourites, posts or subscribes on Steam.

## Verify
- Suites: `CLAUDE.md` § Verify your work. The favourites filter end to end: `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^yours:stack'` (a fake sign-in, `@userfiles`, no network).
