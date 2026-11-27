# Steam and the Workshop: how the backend talks to Steam

Covers `src/backend/Helpers/Steam*.cs`, `src/backend/Helpers/Workshop*.cs`, `src/backend/Services/SteamWorkshopService.cs`
and `src/backend/Web/Steam*.cs`, `WorkshopSubOps.cs`, `WorkshopSocialOps.cs`, `PresetDownloads.cs`. Rules (the musts,
the fallback order, the guards): `.claude/rules/backend/sources-steam.md`. Why behind the choices:
`docs/decisions.md` § Steam & sources.

## Client sessions and stopping

SteamKit2 runs a TCP session's network loop on a foreground thread, so an open session keeps a SIGTERMed backend
alive until the idle disconnect. `serve`'s stop therefore closes every Steam client session: the shared anonymous one
(`SteamAnonymous.Shutdown`, no new one after) and the sign-ins' and the token renewal's (their tokens link
`SteamAnonymous.Stopping`). The shared session closes off the stopping callback: SteamKit2's `Disconnect` waits for a
connect still asking Steam's directory for a server, which nothing cancels. A session Steam logs off is disconnected
at once, since SteamKit2 keeps the transport open after a logoff.

## Presets on the CM session

A scene's presets come from `QueryFiles` with `child_publishedfileid` + `return_children` on the anonymous session.
Steam honours the child filter there (measured: a scene with 29 Workshop presets → those 29 on page 1, `total` 29,
each naming it in its children), and `GetDetails` `includechildren` names a preset's base. Browse has no other route
for the list: lists never use the page fallback and no Browse query runs signed in.

## Test stand-ins for Steam

- `LIASCAPE_STEAM_CM_SERVER=<loopback ip:port>` points every `SteamClient` at a stand-in CM (`scripts/test-backend-stop.sh`'s
  accepts and never answers).
- `LIASCAPE_STEAM_DIRECTORY=<loopback ip:port>` stands in for Steam's directory web API, which a connect with no CM
  named asks first (the stop suite's "lookup": a connect held in that lookup).
- `LIASCAPE_STEAM_CM_FIXTURE=<file.json>` answers `GetDetailsAsync` (item ids, with `title` and `children`), `QueryAsync`
  / `QueryChildrenAsync` (Browse's Workshop pages, `"@query"`; the child filter by each item's `children`) and the
  user-files calls (`"@userfiles"`, ids-only and total-only answered as Steam does; `"@userfilestotal"` sets Steam's
  total apart from the list) from a file — used by the UI matrix, `scripts/test-library-facts.sh` and
  `scripts/test-workshop-social.sh`.
- `LIASCAPE_TEST_NO_NETWORK=1` (`src/backend/Helpers/TestNetwork.cs`) refuses every outbound connection but loopback
  before it is made and logs `test-network: REFUSED <call>`: the shared `HttpClientProvider` connect,
  `ApiSecurity.PublicOnlyHttp`, `SteamAnonymous`' session and the sign-in's `SteamClient`s. Every test backend outside
  a network namespace runs with it and fails the run on a refusal (`scripts/test-no-network.sh`).
- `LIASCAPE_STEAM_COMMUNITY` / `LIASCAPE_STEAM_API` point at `scripts/test-fixtures/fake-steam-community.mjs`, which
  also takes the sign-in's subscribe / unsubscribe (`WorkshopDownloader.SubscribeAsync`).

## "Download without subscribing"

`POST /download {oneOff}` → `WorkshopDownloader.AcquireOneOffAsync` makes the library's own `workshop/<id>` copy
(`DownloadHelper` `ownCopy`, even from the WE folder) by the download mode's own route (`OneOffRouteOf`, asked before
the menu opens through `GET /workshop/one-off`):

- `steamapp`: the client's `DownloadItem`; refused for an unsubscribed item → subscribe, copy, unsubscribe through the
  client. When the client can't and a sign-in is usable, the sign-in's way below; else the client's reason.
- `subscribe` signed in: subscribe, wait for Steam's copy, copy, unsubscribe (`LetGoOfOneOff`: the queue's drain at
  once, no Undo window, no `unsub-progress`: `AddPending(…, quiet: true)` — the top bar's "Unsubscribing" count is for
  the user's own unsubscribes). Signed out: no route.

A subscription the user already had is copied and left alone; Steam's folder of an item that isn't a subscription is
blocked (`WorkshopUnsubQueue.Block`), and `LibraryService.ReconcileDirectDownloads` skips blocked ids. The sign-in
can't fetch over Steam's content servers: those need a Steam-client logon and the sign-in's tokens are WebBrowser ones.

## A preset's base scene

After a preset's `/download`, `PresetDownloads.FetchBaseAsync` takes the base id from the file's `dependency`, else
`/workshop/base`'s. It reuses a base already in the library (`Presets.BaseDirOf`), never fetches one whose Steam kind
isn't `scene` (`LibMeta.BaseKind` saved → "Its base is a … wallpaper"), else gets it by the route the preset took
(`WorkshopDownloader.Took`):

- `Direct` (the mode's way): subscribed down the same order, or a one-off copy for a one-off preset.
- `Page`: the preset's page was the only one (Steam's required-items prompt), so it waits for the base's folder with no
  page or to-do entry (`WaitForSteamDeliveryAsync`, `MaxWaitMs`; `LIASCAPE_WORKSHOP_WAIT_MS` in tests).
- `SteamApp` ("Let the Steam app do all N" in the to-do): the client's subscribe shows no required-items prompt, so the
  base is subscribed through the client too.

The folder Steam delivered is imported as it is (`AppOps.DownloadAsync` `delivered`), never acquired again. A base it
can't get leaves "Needs its base scene" and its `download-progress {error}`. A "Download & apply" of a preset waits for
the base (`PresetDownloads.Pending`, the card's "Getting its base scene…"), then applies; one that still can't play
answers `notApplied: <reason>`. A Subscribe of a preset Steam took subscribes its base too (`SubscribeBaseAsync`; a
to-do entry handed to the client right after it through `SteamTodo.UseSteamAppAsync`); one subscribed on its page
leaves the base to the page's prompt. A preset folder is whole once its `project.json` parses as one
(`TryGetMediaPath`).

A local Wallpaper Engine preset naming a Workshop base adds its base from the same folder
(`PresetDownloads.AddLocalBaseAsync`: that source's detail through `AppOps.DownloadAsync`, no download mode;
`AddBaseFromAsync`, the helper folder imports share); no base there → "Needs its base scene", one that isn't a scene
→ its reason (when its project.json names the id).

## The Steam app connection and the favourite watch

`SteamClientHold` keeps the `steam-ugc` child from the first operation while the window beats
(`useSteamAppPresence` → `POST /steam/app-presence` on every tab at the `beatMs` its answer names, 5 s) until `Tail`
(three beats, 15 s) after the last beat or operation. A held child answers a ping (`{"op": "ping"}`, 3 s) before it is
reused, else a fresh one takes the operation; Steam's own answer (a refused DownloadItem, an unconfirmed unsubscribe)
never drops it.

The star's watch (`Helpers/SteamFavoriteWatch.cs`, `steamapp` only) reads the Steam app account's whole favourites
list (the child's `favorites`: ISteamUGC's favourited user list, every page) every 3 s for 3 min through the held
child (its reads hold it past a closed window to the watch's end); a flip goes to `WorkshopFavorites.Apply` for that
account. `Check` / `Sync` are not used: their 50 s / 10 min holds pace the page's asks, not a watch. No Steam app (not
running, offline, Wallpaper Engine not owned) → no watch, the page opened anyway.

## Community reads

- **A user's files** come from `PublishedFile.GetUserFiles` on the anonymous CM session
  (`SteamWorkshopDetails.UserFilesAsync`): sorts `lastupdated` / `score` only, no search, 100 a page; a creator's list
  matches the filter's tags client-side. `ids_only` pages bare ids, 1000 a request (`UserFileIdsAsync`); `totalonly`
  answers the count alone (`UserFilesTotalAsync`) — both measured honoured anonymously.
- **The Author field** (`GET /workshop/author?q=`, `Helpers/SteamAuthors.cs`): a Steam ID or a `/profiles/<id>` link
  asks nothing; an `/id/<name>` link reads that profile's XML once through `SteamGate` (`SteamCommunity.VanityAsync`,
  kept for the run, "no such profile" too; an answer that isn't a profile isn't kept); any other text is matched
  against the profiles and comment authors this run read and the library's saved creator names (from the details
  cache only). Unknown or shared name, another site's link → 400 `{error, reason}` saying what to paste; no profile → 404.
- **A private profile's favourites** come from its community page with the cookie
  (`SteamCommunity.MyFavoritesPageAsync`, 30 a page). A page's "of N entries" leaves mature items out, so ids are
  compared. A 200 page without the list's paging line (an expired sign-in's login page, a blank or error page) is no
  answer (`ParseFavoritesPage` `Listing`), except the account's own favourites tab listing nothing (`Empty`: served
  signed in as that account, naming `browsefilter=myfavorites`), which empties a kept list.
- **The details cache** (`Helpers/WorkshopDetailsCache.cs`, `$XDG_CACHE_HOME/liascape/workshop/details.json`): every
  item's details the app has seen, kept across runs, written by the serve process alone (at most once a second);
  `GetAsync` sends one `GetDetails` for only the ids it lacks; an id with no public item is remembered for the run,
  never on disk; a Library sidebar's counts refresh a cached copy. `POST /workshop/details {ids}` (≤ 2000 digit ids)
  gives the Library's set its details.
- **A preset's base** (`GET /workshop/base?id=`, `WorkshopSocialOps.BaseOfAsync`): the preset's first child in
  `GetDetails` (`includechildren`), the base's title and kind (`preset` first, else its type tag) through the details
  cache, `libraryPath` = `Presets.BaseDirOf`; 404 = not a preset, 400 = a non-digit id.

## The signed-in account's favourites (`Helpers/WorkshopFavorites.cs`)

`GET /workshop/my-favorites?sync=none|open|check`. An id list per account in `…/workshop/favorites-<steamid>.json`
(`{ids, viaPage, total}`, written only for a whole list, 0600 through `AtomicFile.WritePrivate`), the items from the
details cache. The first load reads full pages of 100 (a private profile: the community pages, Interactive, until one
adds no new id, then the details in chunks of 100) and streams `workshop-favorites {version, loading}` (never an id;
the version starts at the clock's milliseconds, so a restarted backend counts above what an open page holds); Steam
gone mid-load → the error, what came kept in memory, nothing written.

No timer: `open` runs the id diff (ids-only, keeping Steam's own total; details of new ids only; private: the community
pages, Background, or the count check instead within 10 min of a whole read); `check` compares the count (total-only;
private: page 1's ids against the cached first 30) at most once per 50 s, a change → the diff. A star set in Liascape
(`Apply`) changes the list at once and holds 10 min against a Steam answer that lacks it (Steam caches `GetUserFiles`
answers); once a diff that started after it agrees, the edit is settled and dropped. Known limit: a later stale answer
then takes Steam's word, so a settled unstar can come back until Steam catches up (`WorkshopFavorites.Settled`).
