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
  - "src/backend/Models/WorkshopList.cs"
  - "scripts/test-steam-signin.sh"
  - "scripts/test-workshop-social.sh"
  - "scripts/test-fixtures/**"
---

# Wallpaper sources and Steam

Sources (the order of `ServerHost`'s providers array = the UI's source pills): motionbgs, moewalls, desktophut,
Wallpaper Engine (Local), Wallpaper Engine (Workshop). Selectors and URLs: the scrapers themselves. Why behind the
choices here: `docs/decisions.md` § Steam & sources.

## Scrapers (HTTP + HtmlAgilityPack)
- Send the Firefox User-Agent from `HttpClientProvider` and share one `HttpClient`; never one per request.
- `GetAttributeValue` returns `""`, not null: test with `string.IsNullOrEmpty`, not `??` chains.
- moewalls downloads need `Referer` = the wallpaper's page URL; the `/img` proxy sends it for moewalls thumbnails.
- Steam's Workshop page CSS classes are hashed: parse item ids from `filedetails/?id=` hrefs.
- WE local: `project.json` `type` video → video, scene or `scene.pkg` → scene (only with `AllowScenes`), web/application → skipped.

## Steam Community rate limits (`Helpers/SteamGate.cs`)
- Send EVERY steamcommunity.com request through `SteamGate.SendAsync(req, kind)`; never call it around the gate. Steam blocks the user's IP for 30+ min once tripped.
- A 429 (or the subscribe 403 "too many", via `Trip`) starts an app-wide cooldown, persisted in `$XDG_CACHE_HOME/liascape/steam-cooldown.json`. During it nothing is sent: `SteamCooldownException` → `/browse` 429 `{error}`.
- Prefer no request: Browse, details and trailers ask Steam's CM servers first. Not gated: the sign-in itself and api.steampowered.com.

## Workshop Browse over Steam's client protocol (`Services/SteamWorkshopService.cs`)
- Query anonymously with SteamKit2 `PublishedFile.QueryFiles` through ONE shared session (`Helpers/SteamAnonymous.cs`): serialized, never throws (null on failure, then no retry for 60 s).
- Filter semantics (`Helpers/WorkshopTags.cs` `Build`): a group's includes are ONE taggroup (OR); Features are ANDed unless `featureMatch: "any"`; Genres ORed unless `genreMatch: "all"`; any age filter drops untagged items; Type always excludes Web / Application (and Scene with `AllowScenes` off).
- Preset is its own Type option, offered only with presets allowed (`SteamWorkshopService.AllowPresets` = `AllowScenes` + the Liascape player, set by `ServerHost.ConfigureProvider`); ticked without that → no request (`Plan.Empty`). Steam tags a preset `Preset` + its base's type (`Scene` / `Web`), so `Build` puts `Preset` in `excludedtags` unless it is ticked and allowed (a Scene query alone would return presets), and a web-based preset stays out through `Web`. A preset result is `isPreset` + `isScene` (`SteamWorkshopScraper.MapToResults`). Guard: steam-selftest "presets: …", `test-workshop-social.sh` § 5.
- A scene's presets (`/browse` `list: {kind: "presets", id}`): `SteamWorkshopDetails.QueryChildrenAsync` — QueryFiles with `child_publishedfileid` + `return_children` on the anonymous session, the filter's other groups with Type = Preset (`WorkshopTags.ForPresets`), `lastupdated` / `toprated` → query_type 21 / 0, 100 a page; a result is kept only when its own children name the scene. No page fallback (Steam unreachable → the list's error), presets not allowed → `[]`. Steam honours the child filter on the anonymous CM session (measured: a scene with 29 Workshop presets → those 29 on page 1, `total` 29, each naming it in its children; `GetDetails` `includechildren` names a preset's base); Browse has no other route for it: lists never use the page fallback and no Browse query runs signed in (only the private-favourites page does). Guard: `test-workshop-social.sh` § 5.
- Connect the session ahead of a page only on a sign the user is about to ask for one: the Browse tab hovered or focused while it shows the Workshop, or a Workshop pill hovered or focused (`api.steamWarm` → `POST /steam/warm` → `SteamAnonymous.Warm`). No blind connect at app start: the store's first Browse read (`init` → `reload`) already connects then when the Workshop is the remembered source, and a speculative session dies unused after 3 idle min. The warm-up never blocks or shows an error, does nothing under `LIASCAPE_STEAM_CM_FIXTURE` / `LIASCAPE_WORKSHOP_FALLBACK=1` or offline, and backs off 5 min after a failure without touching the requests' 60 s gap. Guard: steam-selftest "warm-up", probe-steam `browse:warm`.
- Prefetch the next page only after the current one and only on the CM path; compare filters by value (`Key()`).
- Fallback (CM unreachable, or `LIASCAPE_WORKSHOP_FALLBACK=1`): the browse page via `SteamGate`, filtering the rest client-side with `WorkshopTags.Matches`.
- `QueryFiles` pages hold 100 (Steam's cap); `GetDetails` takes up to 1000 ids a request (both measured: docs/decisions.md § "Ask Steam for a whole library's details in one request").
- Tests never reach Steam's servers: `LIASCAPE_STEAM_CM_FIXTURE=<file.json>` answers `GetDetailsAsync` (item ids, with `title` and `children`), `QueryAsync` / `QueryChildrenAsync` (Browse's Workshop pages, `"@query"`; the child filter by each item's `children`) and `UserFilesAsync` (`"@userfiles"`) from a file (the UI matrix, `scripts/test-library-facts.sh`, `scripts/test-workshop-social.sh`). Guard: steam-selftest "fixture query", probe-steam `browse:fixture`.
- `LIASCAPE_TEST_NO_NETWORK=1` (`src/backend/Helpers/TestNetwork.cs`, set by the UI matrix) refuses every outbound connection but loopback before it is made, logging `test-network: REFUSED <call>`: the shared `HttpClientProvider` connect, `ApiSecurity.PublicOnlyHttp`, `SteamAnonymous`' session and the sign-in's `SteamClient`s. A new way out (another HttpClient, a socket, a SteamKit2 client) calls `TestNetwork.Check` first. Guard: steam-selftest "no network".

## Secrets (`Helpers/SecretStore.cs`)
- Every reader/writer of the Steam tokens goes through `SteamAuthService` → `SecretStore` (`steam-refresh-token`, `steam-access-token`, `steam-login-secure`).
- Primary: the Secret Service via `secret-tool`, value on stdin/stdout, never argv. Fallback: `~/.config/liascape/steam-auth.json` (0600, `AtomicFile.WritePrivate`), also forced by `LIASCAPE_SECRETS=file`.
- A failed or denied keyring lookup = signed out, and the keyring isn't asked again for 10 min (no prompt loop).
- Log which store is in use, never a value. Never write a token to settings.json.

## Sign-in (`SteamAuthService`, `Web/SteamOps.cs`)
- QR (`LoginViaQrAsync`) or account + password (`LoginViaCredentialsAsync`); both store through `SaveSignIn`.
- The password: bind the body to a class whose `ToString` prints nothing (`LoginReq`), take it once (`TakePassword`), hand it to SteamKit2 and drop it. Never log, broadcast or store it, and never put it in an exception message.
- Never retry a sign-in automatically. After a rate-limit result refuse new attempts for 15 min (`LoginHold`) without contacting Steam.
- Log lines name the step, never the account name.

## Workshop downloads (`Helpers/WorkshopDownloader.cs`, `WorkshopDownloadMode`)
- Modes: `steamapp` (the running Steam client through `Helpers/SteamClientUgc.cs`), `steampage` (always the item's page in the Steam app), `subscribe` (the sign-in, the default). Any other stored value (the dropped `steamcmd`) reads as `subscribe` (the `AppSettings.WorkshopDownloadMode` setter). Each mode does an action only its own way, never another mode's as a fallback (`docs/decisions.md` § "Offer three Workshop download modes, the user's choice").
- One rule says which Workshop actions (Download, Subscribe, Unsubscribe incl. "without deleting" and Delete from source, "Download without subscribing") a mode can't do now: `WorkshopDownloader.Blocked` / `BlockedFor`, mirrored by `components/subscribeMode.ts` `actionBlocked` (from `/steam/status` `usable`). `subscribe` without a usable sign-in: all of them, "Sign in to Steam to download / subscribe / unsubscribe / download without subscribing" (merged, auto-import on: a Download says "subscribe"); `steampage`: the one-off ("A Steam page can only subscribe"); `steamapp`: none (a client that can't answer fails at the click). Every control shows it disabled up front with those words; every endpoint (`/download`, `/workshop/subscribe`, `/unsubscribe`, `/unsubscribe-keep`, `/delete-from-source`) answers 400 with them before anything reaches Steam; a due unsubscribe the mode can't send is dropped like its Undo (`AppOps.DropUnsubscribes`, `SteamOps.SignInLost` inside the Undo window); Undo's re-subscribe sends nothing and says it. Nothing waits for a later sign-in, no page. Guard: steam-selftest "action rule", "unsub allowed", "unsub, signed out", "undo's re-subscribe"; `test-steam-signin.sh` § 2 (refused); probe-steam `side:blocked:*`, `side:unsub:signedOut`, `steam:subToggle:signedOut`.
- `steamapp` never switches method: when the Steam client can't do it (download, Subscribe, unsubscribe drain, undo's re-subscribe) it fails with `SteamClientUgc.FailureMessage` and leaves unsubscribes queued. Only the to-do's "Let the Steam app do all N" is the user's explicit switch. Guard: `test-steam-signin.sh` § 3.
- `SteamClientUgc` loads the Steam client's own `steamclient.so` in a short-lived child (`liascape-backend steam-ugc …`); never ship or load Valve's `libsteam_api.so`. One child at a time app-wide (`SteamClientUgc.Turn`); `ProbeAsync` is exempt.
- Every Steam page the user must click goes through ONE app-wide queue, one page at a time: the Steam to-do (`Web/SteamTodo.cs`). Never open several pages at once or the subscriptions list.
- A to-do subscribe entry ends by itself only when its item was absent at its turn and its files then appear (`ItemOnDisk`, `WatchDisk`); otherwise it waits for the user's Next. Unsubscribe entries always wait for Next.
- A queued unsubscribe stays `pending` until Next → `MarkBlocked`; Skip/Stop → `Unblock` (kept subscribed).
- `steampage`'s unsubscribe (`UnsubscribeInSteamApp`) opens a page only for ids with a folder in a Steam Workshop root; the rest are blocked at once, no page (an owned `workshop/<id>` copy was never a subscription).
- Poll every Workshop root for the media file, tracking stability PER PATH (Steam's folder may be reachable through a symlink); report phases, not a percent. Compare folders as real paths (`RealPath`).
- Dedup on both `SourceId == PageUrl` and `WorkshopId`.
- The Browse sidebar's Unsubscribe of a library item = Delete from source (trash + unsubscribe, undoable); its right-click "Unsubscribe without deleting" is its own route, `POST /workshop/unsubscribe-keep` (`WorkshopSubOps.UnsubscribeKeepAsync`), which never trashes or deletes: the library's copy is made first, and a failed copy unsubscribes nothing. Guard: `test-steam-signin.sh` § 3 i.
- "Download without subscribing" (the Browse sidebar's download buttons' right-click; `POST /download {oneOff}` → `WorkshopDownloader.AcquireOneOffAsync`) makes the library's own `workshop/<id>` copy (`DownloadHelper` `ownCopy`, even from the WE folder) by the download mode's own route (`OneOffRouteOf`, `GET /workshop/one-off`, asked before the menu opens; none = the entries disabled with the reason, `/download` 400): `steamapp` the client's `DownloadItem` (refused for an unsubscribed item → subscribe, copy, unsubscribe through the client); `subscribe` signed in: subscribe, wait for Steam's copy, copy, unsubscribe (`LetGoOfOneOff`: the queue's drain at once, no Undo window, and no `unsub-progress` for it: `AddPending(…, quiet: true)`, the top bar's "Unsubscribing" count is for the user's own unsubscribes), signed out none ("Sign in to Steam to download without subscribing"); `steampage` none (`Blocked`). Never a Steam page, a to-do entry or an `Unblock`; a subscription the user already had is copied and left alone; Steam's folder of an item that isn't a subscription is blocked (`WorkshopUnsubQueue.Block`), and `LibraryService.ReconcileDirectDownloads` skips blocked ids. Not the sign-in over Steam's content servers: those need a Steam-client logon and the sign-in's tokens are WebBrowser ones. Guard: `test-steam-signin.sh` § 2 (one-off), § 3 j., steam-selftest "one-off route", "reconcile", probe-steam `side:oneOff:*`.
- "Open on Steam" → `POST /steam/open-page` (`steam://url/CommunityFilePage/<digits>`); it is not a to-do entry.

## Workshop community: favourites, comments, creators (`Helpers/SteamCommunity.cs`, `Web/WorkshopSocialOps.cs`)
- Reading works signed out (comments, a profile's XML); favourite / unfavourite and posting a comment need the sign-in's cookie and answer 403 `{error, signIn: true}` without one, sending nothing.
- Every call goes through `SteamGate` (Interactive); the UI asks only for what the user looks at (WorkshopSocial.tsx: after the sidebar settles, comments once in view) and keeps answers for the session; the backend keeps profiles per run.
- Comment HTML is Steam's, untrusted: only plain text, a name, an http(s) avatar URL, ids and times leave the backend (`ParseComments`); the UI renders them as text only.
- A user's files (a creator's, the signed-in account's favourites) come from `PublishedFile.GetUserFiles` on the anonymous CM session: sorts `lastupdated` / `score` only, no search, tags matched client-side; a private profile's favourites fall back to its community page with the cookie.
- The item counts are Steam's current `subscriptions` / `favorited`, never the `lifetime_*` ones. Guard: `test-workshop-social.sh`.
- The Library sidebar shows the same pieces for a Workshop item (the Browse sidebar's components) plus its counts from `GET /workshop/counts` (`GetDetails` on the anonymous CM session, never the community site): one request per item however many asks land together (the creator's too), kept 15 min; a failed ask is not kept. Guard: `test-workshop-social.sh` § 1b.
- A preset's base, `GET /workshop/base?id=` → `{baseId, title, kind, libraryPath}` (`WorkshopSocialOps.BaseOfAsync`): the preset's first child in `GetDetails` (`includechildren`), the base's title and kind (`preset` first, else its type tag) through the same details cache, `libraryPath` = `Presets.BaseDirOf`; 404 = not a preset, 400 = a non-digit id. Guard: `test-workshop-social.sh` § 5.
- Tests point `LIASCAPE_STEAM_COMMUNITY` / `LIASCAPE_STEAM_API` at `scripts/test-fixtures/fake-steam-community.mjs` (the sign-in's subscribe / unsubscribe, `WorkshopDownloader.SubscribeAsync`, go there too); nothing in a test favourites, posts or subscribes on Steam.

## Verify
- `bash scripts/test-workshop-social.sh` — hermetic (`unshare -rn`, the fake community server, `LIASCAPE_STEAM_CM_FIXTURE` `@userfiles`).
- `bash scripts/test-steam-signin.sh` — hermetic (stub `xdg-open`, fake Workshop folder, fake `steamclient.so` from `scripts/test-fixtures/`); includes `liascape-backend steam-selftest`, which fails if the password appears anywhere or a token reaches settings.json.
