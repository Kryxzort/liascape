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
  - "scripts/test-steam-signin.sh"
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
- Filter semantics (`Helpers/WorkshopTags.cs` `Build`): a group's includes are ONE taggroup (OR); Features are ANDed unless `featureMatch: "any"`; Genres ORed unless `genreMatch: "all"`; any age filter drops untagged items; Type always excludes Web / Application / Preset (and Scene with `AllowScenes` off).
- Prefetch the next page only after the current one and only on the CM path; compare filters by value (`Key()`).
- Fallback (CM unreachable, or `LIASCAPE_WORKSHOP_FALLBACK=1`): the browse page via `SteamGate`, filtering the rest client-side with `WorkshopTags.Matches`.
- `QueryFiles` pages hold 100 (Steam's cap); `GetDetails` takes up to 1000 ids a request (both measured: docs/decisions.md § "Ask Steam for a whole library's details in one request").
- Tests never reach Steam's servers for item details: `LIASCAPE_STEAM_CM_FIXTURE=<file.json>` answers `GetDetailsAsync` from a file (the UI matrix, `scripts/test-library-facts.sh`).

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
- Modes: `steamapp` (the running Steam client through `Helpers/SteamClientUgc.cs`), `steampage` (always the item's page in the Steam app), `subscribe` (the sign-in; without a usable one it falls back to the page), `steamcmd`.
- `steamapp` never switches method: when the Steam client can't do it (download, Subscribe, unsubscribe drain, undo's re-subscribe) it fails with `SteamClientUgc.FailureMessage` and leaves unsubscribes queued. Only the to-do's "Let the Steam app do all N" is the user's explicit switch. Guard: `test-steam-signin.sh` § 3.
- `SteamClientUgc` loads the Steam client's own `steamclient.so` in a short-lived child (`liascape-backend steam-ugc …`); never ship or load Valve's `libsteam_api.so`. One child at a time app-wide (`SteamClientUgc.Turn`); `ProbeAsync` is exempt.
- Every Steam page the user must click goes through ONE app-wide queue, one page at a time: the Steam to-do (`Web/SteamTodo.cs`). Never open several pages at once or the subscriptions list.
- A to-do subscribe entry ends by itself only when its item was absent at its turn and its files then appear (`ItemOnDisk`, `WatchDisk`); otherwise it waits for the user's Next. Unsubscribe entries always wait for Next.
- A queued unsubscribe stays `pending` until Next → `MarkBlocked`; Skip/Stop → `Unblock` (kept subscribed).
- The no-sign-in unsubscribe (`UnsubscribeInSteamApp`) opens a page only for ids with a folder in a Steam Workshop root; the rest are blocked at once, no page (an owned `workshop/<id>` copy was never a subscription).
- Poll every Workshop root for the media file, tracking stability PER PATH (Steam's folder may be reachable through a symlink); report phases, not a percent. Compare folders as real paths (`RealPath`).
- `steamcmd` never stores the password; the one-time sign-in runs in a terminal with values as `$1..$3`.
- Dedup on both `SourceId == PageUrl` and `WorkshopId`.
- The Browse sidebar's Unsubscribe of a library item = Delete from source (trash + unsubscribe, undoable); its right-click "Unsubscribe without deleting" is its own route, `POST /workshop/unsubscribe-keep` (`WorkshopSubOps.UnsubscribeKeepAsync`), which never trashes or deletes: the library's copy is made first, and a failed copy unsubscribes nothing. Guard: `test-steam-signin.sh` § 3 i.
- "Open on Steam" → `POST /steam/open-page` (`steam://url/CommunityFilePage/<digits>`); it is not a to-do entry.

## Verify
- `bash scripts/test-steam-signin.sh` — hermetic (stub `xdg-open`, fake Workshop folder, fake `steamclient.so` from `scripts/test-fixtures/`); includes `liascape-backend steam-selftest`, which fails if the password appears anywhere or a token reaches settings.json.
