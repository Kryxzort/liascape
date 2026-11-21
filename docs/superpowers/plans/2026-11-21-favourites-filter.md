# Favourites as a Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Browse's Favourites pill with a "Favourites" three-way row beside "In my library" (group "Yours"), where ✓ shows
a cached set directly with local search, sorts and switches, ✕ hides the set from the Workshop's pages, and the Library tab
gets the Favourites row too.

**Architecture:** The backend keeps two caches under the user's cache dir: one shared per-item Workshop details cache
(`WorkshopDetailsCache`, keyed by item id) and one favourites ID list per Steam account (`WorkshopFavorites`, kept current by
an ID diff on Browse open, a count check about once a minute and a star set in Liascape applied at once). The UI reads the
favourites through `GET /workshop/my-favorites` (re-read on the `workshop-favorites` event) and the library set's details
through `POST /workshop/details`, then builds the local set in the page (`views/localSet.ts`): set algebra, the filter
column's matcher, search and its own sort. With no ✓ on, Browse pages the Workshop as today and ✕ hides IDs client-side.

**Tech Stack:** C# (.NET 10, SteamKit2 3.4.0, ASP.NET minimal API), React + zustand (TypeScript), Electron CDP probes.

**Spec:** `docs/superpowers/specs/2026-11-21-favourites-filter-design.md`

## Global Constraints

- Group name **Yours**; row labels **In my library** and **Favourites**; pseudo-tags `@library` and `@favorites`, never sent
  to Steam (`wireFilter` strips every `@` tag; `WorkshopFilter.Effective` ignores them).
- Row semantics, both rows, every scope that has them: ✓ = show that set directly; ✕ = browse as usual and hide that set;
  – = no effect. Both ✓ = the intersection; one ✓ + the other ✕ = that set minus the other; ✕ only = the Workshop's paged
  query with the sets' IDs removed client-side.
- With a ✓ on, Browse sends no `/browse` and shows no placeholder cards; the whole result shows at once.
- Local sort menu (exact labels, in this order): Most Recent, Recently Updated, Most Subscribed, Top Rated, Most
  Favourited, Title A–Z, and Date Added only while In my library is ✓. Never "Most Popular · period". Default Most
  Subscribed. Persisted separately from `browseFilter.sort`; turning the last ✓ off brings the Workshop's sort back
  untouched (its trend period included).
- Search on a local set: case-insensitive on title, author and tags.
- Signed out: the Favourites row is dimmed with "Sign in to Steam", its saved ✓ / ✕ kept but without effect; it can be
  cleared to – but not set. Favourites ✓ as the only ✓ then shows the Workshop as if –.
- Load line copy: "Loading your favourites — 120 of 450" (total unknown: "Loading your favourites — 120 so far"; nothing
  yet: "Loading your favourites…").
- A library item Steam has nothing on still shows under Library ✓, built from the library's own data, sorted after items
  that have the sort's field; tag switches use the library's tags.
- In a creator's or a scene's presets list, ✓ shows the set's items in that list (details' creator ID / base dependency),
  ✕ hides the set from the list's pages client-side.
- Cache files live under `$XDG_CACHE_HOME/liascape/workshop/` (else `~/.cache/liascape/workshop/`), written with
  `AtomicFile.WriteAllText`, read with `AtomicFile.ReadJson`. No log line names a Steam ID or a favourite's item ID
  (counts only); the hermetic fixtures' own log lines are exempt.
- No timed refresh: the ID diff runs on Browse open (with a Favourites row ✓ / ✕ on) and when a Favourites row turns ✓ /
  ✕; the count check about once a minute only while Browse shows and the window is active.
- The repo is public: no personal details; code comments say why, never history (`.claude/rules/writing-rules.md` §
  Code comments); every new behaviour names its guard (`Guard: <suite> <cell>`).
- Every new UI element passes `.claude/rules/ui/design.md`'s checklist (theme vars, glow / `no-glow`, motion / `no-motion`,
  `bg-live`, themed controls, a probe cell).
- Tests are hermetic: fake Steam servers only (`LIASCAPE_STEAM_CM_FIXTURE`, `scripts/test-fixtures/fake-steam-community.mjs`,
  in-page stubs in probes); every new check shown RED before GREEN.
- Commit messages title-case, no period; each commit carries `Claude-Agent: <model id>, effort <…>, <role>` per writer.
- Long runs (`test-workshop-social.sh`, `test-steam-signin.sh`, the UI probes) go in the background; they queue on
  `scripts/test-lock.sh`.

## Review Focus

1. **A fresh star undone by a stale Steam answer.** Steam may serve a cached `GetUserFiles` answer for a while, so a diff that
   starts after a star can still lack it. Expect the star to hold: a Liascape edit stays until a diff that started after it
   agrees, or 10 minutes pass. Test: Task 5 selftest "favourites merge: a later diff without the star keeps it for 10 min".
2. **Switching Steam accounts.** Expect account B never to see account A's favourites, even for one frame. Test: Task 4
   § 7 j (backend) and Task 8 `yours:signOut` (UI clears the set at once on `steam-status` signed out).
3. **Steam unreachable on the first load or mid-load.** Expect the line to say so with Retry, the partial grid kept, nothing
   half-written to disk. Test: Task 4 § 7 k, Task 8 `yours:loadError`.
4. **Scene support or the engine changes while a local set shows.** Expect scenes to leave at once with scenes off, presets
   with presets off, and presets hidden unless Type's Preset is ticked, like the Workshop's own list. Test: Task 7
   `yours:scenes`.
5. **A very large favourites list (2,000).** Expect typing in the search to send no request and the grid to stay
   virtualised. Test: Task 7 `yours:big`.

---

### Task 1: Verify Steam's IDs-only and total-only options (spike, no commit)

The outcome picks the branches later tasks name: **A** (`ids_only` and `totalonly` honoured anonymously) or **B** (not);
**C1** (the community favourites page states its total) or **C2** (it doesn't).

**Files:**
- Create (scratch only, never in the repo): `<scratchpad>/spike-userfiles/Spike.csproj`, `Program.cs`

**Interfaces:**
- Consumes: `Liascape.Helpers.SteamAnonymous.UseAsync`, `SteamWorkshopDetails.QueryAsync` / `UserFilesAsync`,
  `SteamGate.SendAsync`, `HttpClientProvider.Client` from `src/backend/bin/Debug/net10.0/liascape-backend.dll`; SteamKit2
  3.4.0 (`CPublishedFile_GetUserFiles_Request` has `ids_only`, `totalonly`, `return_vote_data`, `return_children`,
  `cache_max_age_seconds`).
- Produces: a findings block in the task report: branch A or B, C1 or C2, the largest `numperpage` `ids_only` honours, how
  the community page orders page 1, and whether `time_created` / `vote_data.score` come back on `GetUserFiles` and
  `GetDetails` (`includevotes`). Task 2 copies the measured facts into `SteamWorkshopDetails`' comments.

- [ ] **Step 1: Build the backend** — `dotnet build src/backend` → "Build succeeded".
- [ ] **Step 2: Write the scratch console app** referencing the built dll and SteamKit2 3.4.0. Run it with its own
  `HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` under the scratch folder (SteamGate's cooldown file lands there), with
  `LIASCAPE_TEST_NO_NETWORK`, `LIASCAPE_STEAM_CM_FIXTURE` and `LIASCAPE_WORKSHOP_FALLBACK` unset. It prints counts and
  booleans only, never a Steam ID or item ID.
  1. Find a public profile with favourites: `QueryAsync` page 1 (trend), then for up to 20 distinct creators
     `UserFilesAsync(creator, "myfavorites", "lastupdated", 1, 100)` until `Total > 0`. Call it P.
  2. Full list of P: page through `UserFilesAsync` (100 a page); keep the ID set S and order.
  3. `ids_only = true`, `numperpage` 100, 500 and 1000, page 1 onward: items per page, `total`, whether any item has a title,
     and whether the union equals S.
  4. `totalonly = true`: `total` equals |S|, item count 0.
  5. `return_vote_data` + `return_children` on a full page and `includevotes` on `GetDetails` of 5 of S:
     `time_created > 0` and `vote_data.score` present.
  6. The community page signed out (a public profile's page is the same template as a private one's):
     `GET {SteamCommunity.Base}/profiles/{P}/myworkshopfiles/?appid=431960&browsefilter=myfavorites&numperpage=30&p=1`
     through `SteamGate.SendAsync(…, Kind.Background)`; at most 3 such requests. Record whether the paging text
     (`workshopBrowsePagingInfo`, "Showing 1-30 of N entries") is there and N = |S|, and compare page 1's order with
     `lastupdated` and `score` orders of S.
- [ ] **Step 3: Run it** (background, ≤ 3 min). Expected: one findings block.
- [ ] **Step 4: Decide.** A = steps 3 and 4 both behave as described (S whole, no titles; total with no items); else B.
  C1 = step 6 shows N = |S|; else C2. Delete the scratch project. Nothing is committed.

### Task 2: Steam calls the caches need

**Files:**
- Modify: `src/backend/Scrapers/SteamWorkshopScraper.cs` (`PublishedFileDetail`, `GetDetailsBatchAsync`)
- Modify: `src/backend/Helpers/SteamWorkshopDetails.cs` (`Details`, `GetDetailsAsync`, `UserFilesAsync`, `ToDetail`, the fixture readers)
- Modify: `src/backend/Helpers/SteamCommunity.cs` (`MyFavoritesPageAsync`)
- Modify: `src/backend/Services/SteamWorkshopService.cs:205` (the one caller: `.Ids`, `SteamGate.Kind.Interactive`)
- Modify: `scripts/test-fixtures/fake-steam-community.mjs`
- Test: `src/backend/Web/SteamSelfTest.cs` (beside the "fixture query" checks)

**Interfaces:**
- Consumes: Task 1's branch and measured page size.
- Produces:
  - `PublishedFileDetail` gains `DateTime TimeCreated` and `double? VoteScore` (Steam's `vote_data.score`, 0–1).
  - `SteamWorkshopDetails.Details` gains a last parameter `PublishedFileDetail? File = null`, set for every found item (the
    same `ToDetail` mapping).
  - `Task<List<ulong>?> UserFileIdsAsync(ulong steamId, string type, TimeSpan timeout, CancellationToken ct = default)`:
    the whole list's IDs in Steam's `lastupdated` order; null = Steam unreachable.
  - `Task<uint?> UserFilesTotalAsync(ulong steamId, string type, TimeSpan timeout, CancellationToken ct = default)`.
  - `UserFilesAsync` (signature unchanged) asks `return_vote_data` and `return_children`; `GetDetailsAsync` asks `includevotes`.
  - `public sealed record FavoritesPage(List<string> Ids, int? Total)`; `SteamCommunity.MyFavoritesPageAsync(int page,
    SteamGate.Kind kind, CancellationToken ct = default) : Task<FavoritesPage>`; `public static FavoritesPage
    ParseFavoritesPage(string html)` (C1: total from "of N entries", thousands separators allowed; C2: `Total` null).
  - Fixture (`LIASCAPE_STEAM_CM_FIXTURE`): `"@userfiles"` items and top-level id entries accept `time_created`,
    `time_updated`, `preview_url`, `score`; a top-level entry's `File` is `ToDetail(FixtureDetails(e))` with its id set.
    Branch A: `ids_only` returns items with only `publishedfileid`, `totalonly` returns no items, both with `total`.
  - Log lines (no IDs): A `steam-cm: GetUserFiles <type> ids-only page N — k of T`, `steam-cm: GetUserFiles <type>
    total-only — T`; B the existing full-page line (`UserFilesTotalAsync` = page 1 with `numperpage` 1).
  - Fake community: `POST /__myfavs {ids: string[]}` sets the signed-in account's favourites page list (default: the
    current three IDs), 30 a page; C1 also prints `<div class="workshopBrowsePagingInfo">Showing a-b of N entries</div>`.

- [ ] **Step 1: Write the failing selftest checks** in `SteamSelfTest` against a temp fixture of 230 `@userfiles` items
  for `"7656119…:myfavorites"`:
  ```csharp
  Check(ids?.Count == 230 && ids.SequenceEqual(expectedOrder), "user files: ids only = the whole list in Steam's order");
  Check(total == 230, "user files: total only");
  Check(page.Items[0].TimeCreated == T0 && page.Items[0].VoteScore == 0.75 && page.Items[0].Children.SequenceEqual(new[] { 1003UL }), "user files: created / score / children");
  Check(d[1003].File is { TimeCreated: var c, PreviewUrl: "https://images.example.invalid/1003.jpg" } && c == T0, "details: File carries created / preview");
  Check(SteamCommunity.ParseFavoritesPage(SamplePage(65, 1)) is { Ids.Count: 30, Total: 65 }, "favourites page: ids + total parsed"); // C2: Total null
  ```
- [ ] **Step 2: Run it to see it fail** — `bash scripts/test-steam-signin.sh` (background). Expected: build errors for the
  missing members, then (once stubbed) FAIL on each line above.
- [ ] **Step 3: Implement** the members above. A: `UserFileIdsAsync` pages with `ids_only` at Task 1's measured page size;
  B: full pages of 100. Put Task 1's measurements in the comment above `UserFilesAsync` (dated nowhere, "measured on an
  anonymous session"). Map `time_created` in `GetDetailsBatchAsync` too.
- [ ] **Step 4: Run** `dotnet build src/backend` and `bash scripts/test-steam-signin.sh` (background). Expected: the five
  checks `ok`, `RESULT … fail=0`. Then `bash scripts/test-workshop-social.sh` (background): still all PASS.
- [ ] **Step 5: Commit** `Add Steam Calls For The Favourites Cache`.

### Task 3: The shared Workshop details cache and `POST /workshop/details`

**Files:**
- Create: `src/backend/Helpers/WorkshopDetailsCache.cs`
- Modify: `src/backend/Models/WallpaperResult.cs`, `src/backend/Scrapers/SteamWorkshopScraper.cs` (`MapToResults`)
- Modify: `src/backend/Web/WorkshopSocialOps.cs` (`Ask` writes through; new `DetailsBatchAsync`), `src/backend/Web/ServerHost.cs` (route)
- Modify: `scripts/matrix-cells-for.sh` (map the new file: "nothing in the matrix (bash scripts/test-workshop-social.sh)")
- Test: `scripts/test-workshop-social.sh` (new § 6)

**Interfaces:**
- Consumes: Task 2's `PublishedFileDetail.TimeCreated` / `VoteScore`, `Details.File`.
- Produces:
  - `WallpaperResult` gains `DateTime? CreatedAt`, `double? Score`, `string[]? Children`; `MapToResults` fills them.
  - `public static class WorkshopDetailsCache` (one serve process writes it):
    - `Task<Dictionary<string, PublishedFileDetail>> GetAsync(IReadOnlyCollection<string> ids, CancellationToken ct)`:
      cached ones at once, the missing ones in ONE `GetDetailsAsync` call; Steam unreachable → only what's cached; an ID Steam
      has no public item for is remembered for this run (not asked again, not persisted).
    - `void Put(IEnumerable<PublishedFileDetail> details)`; `void Refresh(PublishedFileDetail d)` (only an ID already cached);
      `bool TryGet(string id, out PublishedFileDetail d)`.
    - File `<cache>/liascape/workshop/details.json` = `{ "<id>": PublishedFileDetail }`, read once lazily, writes coalesced to at most one a second.
  - `POST /workshop/details {ids}` → `{items: WallpaperResult[]}` in the asked order, through `MapToResults(…, allowScenes:
    true, allowPresets: true)`; more than 2000 IDs or a non-digit ID → 400, nothing asked. Endpoint body in
    `WorkshopSocialOps.DetailsBatchAsync(List<string>? ids, CancellationToken ct) : Task<IResult>`.
  - `WorkshopSocialOps.Ask` → `WorkshopDetailsCache.Refresh(d.File)` when found (an opened Library sidebar refreshes the
    counts a local sort uses).

- [ ] **Step 1: Write the failing test** (§ 6 in `drive.mjs`; fixture top-level entries 5001–5003 with `time_created`,
  `score`, `preview_url`):
  ```js
  r = await post("/workshop/details", { ids: ["5001", "5002", "9999"] });
  out(r.status === 200 && J(wids({ json: r.json.items })) === J(["5001", "5002"]) && r.json.items[0].createdAt && r.json.items[0].score === 0.75,
    "details: the found items in order, with created / score", J(r));
  out(count(/GetDetails of 3 id/) === 1, "details: one GetDetails for the missing ids");
  r = await post("/workshop/details", { ids: ["5001", "5002"] });
  out(count(/GetDetails of/) === before, "details: a second ask sends nothing");
  out(fs.existsSync(`${XDG_CACHE_HOME}/liascape/workshop/details.json`), "details: kept on disk");
  // restart the backend (factor the start into start_backend), then: the same ask sends nothing
  out((await post("/workshop/details", { ids: Array.from({ length: 2001 }, (_, i) => String(i + 1)) })).status === 400, "details: 2001 ids → 400");
  // a Library sidebar's counts (fixture 5001 subscriptions 10 → 99) refresh the cached copy
  ```
- [ ] **Step 2: Run to see it fail** — `bash scripts/test-workshop-social.sh` (background). Expected: FAIL "details: …" (404).
- [ ] **Step 3: Implement** the interfaces above (`ServerHost`: `app.MapPost("/workshop/details", (IdsReq r, HttpContext ctx) => WorkshopSocialOps.DetailsBatchAsync(r.Ids, ctx.RequestAborted))`).
- [ ] **Step 4: Run** `dotnet build src/backend`, `bash scripts/test-workshop-social.sh` (background). Expected: `RESULT pass=N fail=0`.
- [ ] **Step 5: Commit** `Cache Workshop Item Details On Disk`.

### Task 4: The favourites cache: first load, persistence and `GET /workshop/my-favorites`

**Files:**
- Create: `src/backend/Helpers/WorkshopFavorites.cs`
- Modify: `src/backend/Web/WorkshopSocialOps.cs` (`MyFavoritesAsync`), `src/backend/Web/ServerHost.cs` (route)
- Modify: `src/backend/Helpers/SteamCommunity.cs` (`KnownName(string steamId) : string?`, from the run's profile cache, never a request)
- Modify: `scripts/matrix-cells-for.sh` (map the new file like Task 3's)
- Test: `scripts/test-workshop-social.sh` (new § 7 a–d, i–k)

**Interfaces:**
- Consumes: Task 2's `UserFilesAsync`, `MyFavoritesPageAsync(page, kind)`; Task 3's `WorkshopDetailsCache.Put` / `GetAsync` / `TryGet`.
- Produces:
  - `public static class WorkshopFavorites`:
    - `public sealed record Progress(int Done, int? Total)`; `public sealed record View(long Version, Progress? Loading, string? Error, IReadOnlyList<string> Ids)`.
    - `View Get(ulong steamId)` (loads that account's file once); `void Sync(ulong steamId)` (single-flight, background; this
      task: the first load when no file exists, else nothing; Task 5 adds the diff).
    - After each page or details batch and at the end: `EventBus.Broadcast("workshop-favorites", new { version, loading })`
      (no IDs in the event).
    - File `<cache>/liascape/workshop/favorites-<steamId>.json` = `{ids, viaPage, total}`, written only for a complete list.
  - First load: client protocol full pages of 100 (`UserFilesAsync(id, "myfavorites", "lastupdated", n, 100, …)`), each page
    `Put` into the details cache, `Progress(done, page.Total)`. Page 1 with `Total == 0` → a private profile (`viaPage`):
    community pages (`Kind.Interactive`: the user is waiting) until a page adds no new ID, then details via
    `WorkshopDetailsCache.GetAsync` in chunks of 100 with progress.
  - Steam unreachable or a refusal: `Error = "Couldn't load your favourites from Steam. Try again in a moment."`, the IDs
    loaded so far kept in memory, nothing written.
  - `GET /workshop/my-favorites?sync=none|open|check` → `WorkshopSocialOps.MyFavoritesAsync(string? sync, CancellationToken ct)`:
    no usable sign-in → `{signedIn: false}`, nothing sent; else `{signedIn: true, version, loading, error, items}`, `items` =
    the IDs with cached details through `MapToResults(…, allowScenes: true, allowPresets: true)` (Web / Application left
    out), list order, `authorName` = `SteamCommunity.KnownName(creator)`. `open` and `check` call `Sync` (Task 5 splits them).

- [ ] **Step 1: Write the failing tests** (§ 7; fixture `@userfiles` `ME:myfavorites` = 250 items, 2 of them Web; a WS
  client on `/events?token=` counts `workshop-favorites`):
  ```js
  // a. signed out
  r = await get("/workshop/my-favorites?sync=open");
  out(r.json?.signedIn === false && (await since(n0)).length === 0 && !/GetUserFiles myfavorites/.test(log()), "my-favorites signed out: nothing asked");
  // b. signed in, first load: progress events rising to 250, then 248 items in Steam's order (web left out)
  out(evs.length >= 3 && evs.at(-1).loading === null && evs.some((e) => e.loading?.total === 250), "first load: progress streamed");
  out(r.json.items.length === 248 && r.json.items[0].title === "fav-0" && r.json.items.every((w) => w.createdAt), "first load: the list, web left out");
  out(!log().includes(ME) && !log().includes("3200000500"), "first load: no Steam ID or item ID in the log");
  // c. sync=none: no Steam call; d. after a backend restart: same items, no Steam call
  // i. private (ME:myfavorites removed; POST /__myfavs 65 ids): 3 community pages with the cookie, details via GetDetails, 65 items
  // j. another account (steam-auth.json for ME2): none of ME's items; signed out again → {signedIn:false}
  // k. no fixture file mid-load → error text, items so far kept, no favorites-<id>.json written
  ```
- [ ] **Step 2: Run to see it fail** — `bash scripts/test-workshop-social.sh` (background). Expected: FAIL on § 7 (404).
- [ ] **Step 3: Implement** the interfaces above; a `// Guard: test-workshop-social § 7` comment above `Sync`.
- [ ] **Step 4: Run** `dotnet build src/backend` and `bash scripts/test-workshop-social.sh` (background). Expected: all PASS.
- [ ] **Step 5: Commit** `Cache The Signed-In Account's Workshop Favourites`.

### Task 5: Keeping the favourites current

**Files:**
- Modify: `src/backend/Helpers/WorkshopFavorites.cs`, `src/backend/Web/WorkshopSocialOps.cs` (`SetFavoriteAsync` → `Apply`; `sync=check` → `Check`)
- Test: `src/backend/Web/SteamSelfTest.cs` (merge rule), `scripts/test-workshop-social.sh` (§ 7 e–h)

**Interfaces:**
- Consumes: Task 2's `UserFileIdsAsync` / `UserFilesTotalAsync` / `MyFavoritesPageAsync(…, Kind.Background)`; Task 4's state.
- Produces:
  - `public readonly record struct Edit(bool Favorite, long Stamp, DateTime At)`.
  - `internal static List<string> Merge(IReadOnlyList<string> fromSteam, IReadOnlyDictionary<string, Edit> edits, long
    diffStarted, DateTime now)`: Steam's list and order, except an edit wins (a starred ID kept, first if new; an unstarred
    one dropped) while `edit.Stamp > diffStarted` or Steam disagrees and `now - edit.At < 10 min`. The caller drops an edit
    once a diff that started after it agrees.
  - `void Apply(ulong steamId, string workshopId, bool favorite)`: from a successful `SetFavoriteAsync`; the list changes at
    once, version + broadcast; a new ID's details fetched in the background (another broadcast when they land).
  - `void Check(ulong steamId)`: at most once per 50 s per account. A: `UserFilesTotalAsync`; B: the same call (page 1,
    `numperpage` 1); private C1: `MyFavoritesPageAsync(1, Background).Total`; private C2: page 1's IDs against the cached
    first 30. A change → `Sync`.
  - `Sync` with a file: the ID diff. A: `UserFileIdsAsync`; B: full pages; private: community pages (`Kind.Background`)
    until a page adds no new ID. Added IDs → `WorkshopDetailsCache.GetAsync` (missing only); removed dropped; `Merge`.
  - `sync=open` → `Sync`; `sync=check` → `Check`.

- [ ] **Step 1: Write the failing tests.** Selftest:
  ```csharp
  Check(Merge(["a","b"], new() { ["c"] = new(true, 5, now) }, diffStarted: 4, now).SequenceEqual(["c","a","b"]), "favourites merge: a star newer than the diff stays");
  Check(Merge(["a","b"], new() { ["c"] = new(true, 3, now.AddMinutes(-2)) }, 4, now).Contains("c"), "favourites merge: a later diff without the star keeps it for 10 min");
  Check(!Merge(["a","b"], new() { ["c"] = new(true, 3, now.AddMinutes(-11)) }, 4, now).Contains("c"), "favourites merge: after 10 min Steam wins");
  Check(!Merge(["a","b"], new() { ["a"] = new(false, 5, now) }, 4, now).Contains("a"), "favourites merge: an unstar newer than the diff stays");
  ```
  `test-workshop-social` § 7: e. fixture edited (an old ID added at the end, one removed) → `sync=open` → A: one
  `ids-only` line, B: full pages; one `GetDetails of 1 id`; the items follow. f. `sync=check` twice in a row → one
  `total-only` (B: one page-1 line); count changed → a diff runs. g. `POST /workshop/favorite` true for a non-favourite →
  the next `sync=none` lists it first with no Steam call, a `workshop-favorites` event arrived; h. false → gone at once.
  Private: `sync=check` reads page 1 only (fake log: one `myworkshopfiles` request); `/__myfavs` grown → a re-page.
- [ ] **Step 2: Run to see them fail** — `bash scripts/test-steam-signin.sh`, `bash scripts/test-workshop-social.sh` (background).
- [ ] **Step 3: Implement**; `// Guard:` comments name the selftest checks and § 7 e–h.
- [ ] **Step 4: Run** both suites (background). Expected: all PASS / `fail=0`.
- [ ] **Step 5: Commit** `Keep The Favourites Cache Current`.

### Task 6: The Yours group and its rows in the filter column

**Files:**
- Modify: `app/ui/src/components/workshopFilter.ts` (`FAVORITES_TAG`, the group, `groupsFor`, `LIB_GROUPS`)
- Modify: `app/ui/src/components/WorkshopFilterColumn.tsx` (`TagRow` reason, `GROUP_ICON`)
- Modify: `app/ui/src/store/index.ts` (`favoritesUsable`, the `setTagState` guard)
- Modify: `app/ui/src/index.css` (the disabled row, its reason, `no-glow` / `bg-live`)
- Test: `app/shell/probe-filters.js` (groups list `yours`, `wf:emblem`'s glyph, new cells)

**Interfaces:**
- Produces:
  - `export const FAVORITES_TAG = "@favorites"`; the first group `{ id: "yours", name: "Yours" }`: Workshop scope
    `[@library "In my library", @favorites "Favourites"]`, `weLocal` `[@library]`, `library` `[@favorites]`.
    `groupsFor(scope, presets)` keeps its signature.
  - `export const favoritesUsable = (steam: State["steam"]) => !!steam?.signedIn && !steam.rejected` (store).
  - `setTagState(FAVORITES_TAG, st)` with `st !== null` while `!favoritesUsable` changes nothing.
  - `TagRow` prop `why?: string | null`: set → `data-wf-off`, the reason as text under the name (`.wf-why`,
    `data-wf-why`, "Sign in to Steam"), ✓ and ✕ `aria-disabled` and inert, – usable; a name click or right-click only clears.
  - `GROUP_ICON.yours = UserRound`.

- [ ] **Step 1: Write the failing cells** in `probe-filters.js` (the stack is signed out):
  - `wf:yours:rows`: Workshop column's first group `yours` named "Yours" with rows `@library`, `@favorites` in that
    order; the WE folder's with `@library` only; the Library's with `@favorites` only.
  - `wf:yours:signedOut`: the Favourites row `data-wf-off`, "Sign in to Steam" shown (no `title`), ✓ / ✕ `aria-disabled`; a
    click on ✓, the name and a right-click leave it off; a saved `@favorites` ✓ (localStorage `browseFilter`, reload)
    shows dimmed ✓ and – clears it; Glow effects off: no glow on its segments; `bg-live`: the reason has the drop-shadow;
    motion off: the state change only fades (`motion-off.js`). Shots `wf-yours-signedout*.png`.
  - Update `wf:workshopOnly`'s groups list and `wf:emblem` (`UserRound` for `yours`).
- [ ] **Step 2: Run to see them fail** — `LIASCAPE_MATRIX_SCREEN=2560x1440 bash scripts/test-ui-matrix.sh --probe probe-filters.js --only '^wf:(yours|workshopOnly|emblem|library)'` (background). Expected: FAIL (group `library`, no `@favorites`).
- [ ] **Step 3: Implement**; a `// Guard: probe-filters wf:yours:*` comment above the guard in `setTagState`.
- [ ] **Step 4: Run** `cd app/ui && npm run build && npm run lint`, then the probe command above, then the whole
  `--probe probe-filters.js` (background). Expected: all PASS; look at the shots.
- [ ] **Step 5: Commit** `Add The Yours Filter Group`.

### Task 7: Local sets in Browse (set algebra, search, sorts, no paging)

**Files:**
- Create: `app/ui/src/views/localSet.ts`
- Modify: `app/ui/src/api/client.ts` (`Wallpaper` fields, `FavoritesState`, `api.workshopMyFavorites`, `api.workshopDetails`)
- Modify: `app/ui/src/store/index.ts` (the slice below; `reload` / `loadMore` / `setTagState`)
- Modify: `app/ui/src/views/Browse.tsx`, `app/ui/src/App.tsx` (search + sort), `app/ui/src/components/WorkshopSocial.tsx` (`WsListNote` hidden on a local set)
- Modify: `scripts/matrix-cells-for.sh` (`views/localSet.ts` beside `views/Browse.tsx`)
- Test: `app/shell/probe-steam.js` (STUB answers `/workshop/my-favorites` from `window.__favs`, `/workshop/details` from `window.__libDetails`, each call recorded; new cells)

**Interfaces:**
- Consumes: Task 3's `POST /workshop/details`, Task 4's `GET /workshop/my-favorites`, Task 6's tags and `favoritesUsable`.
- Produces:
  - `Wallpaper` gains `createdAt?: string | null; score?: number | null; children?: string[] | null`.
  - `export type FavoritesState = { signedIn: boolean; version: number; loading: { done: number; total: number | null } | null; error: string | null; items: Wallpaper[] }`;
    `api.workshopMyFavorites(sync: "none" | "open" | "check"): Promise<FavoritesState>`;
    `api.workshopDetails(ids: string[]): Promise<{ items: Wallpaper[] }>`.
  - `views/localSet.ts`:
    - `export type SetMode = "inc" | "exc" | null; export type SetModes = { lib: SetMode; fav: SetMode }`
    - `setModesOf(f: WorkshopFilter, favUsable: boolean): SetModes` (fav null while signed out)
    - `isLocalSet(m: SetModes): boolean` (either `inc`)
    - `export type LocalSort = "mostrecent" | "lastupdated" | "totaluniquesubscribers" | "toprated" | "mostfavorited" | "title" | "added"`
    - `localSortOptions(libInc: boolean): Opt[]`, `effectiveLocalSort(saved: LocalSort, libInc: boolean): LocalSort` ("added" without Library ✓ → "totaluniquesubscribers")
    - `libraryCards(items: LibraryItem[], details: Record<string, Wallpaper>): Wallpaper[]` (Workshop items only; a card
      from its details, else from the library: title, `thumbnailPath` / `animatedThumbnailPath`, tags, resolution,
      ageRating, isScene, isPreset, `pageUrl = steamPageUrl(id)`, `children = [baseWorkshopId]` for a preset)
    - `buildLocalSet(a: { modes: SetModes; favs: Wallpaper[]; lib: Wallpaper[]; libAdded: Map<string, number>; list: WsList;
      query: string; match: ((facets: Set<string>) => boolean) | null; scenesOn: boolean; presetsOn: boolean;
      presetTicked: boolean; sort: LocalSort }): Wallpaper[]` — algebra by Workshop ID, then the list (creator:
      `authorId === list.id`; presets: `children` includes `list.id`), scenes / presets as the Workshop lists them (a preset
      only with Type's Preset ticked), `match(facetsOf(w, w.pageUrl))`, the search, the sort (missing field last, ties by title)
    - `hideSets(list: Wallpaper[], modes: SetModes, favIds: Set<string>, libKeys: Set<string>): Wallpaper[]` (✕ only)
  - Store: `wsFavs: (FavoritesState & { ids: Set<string> }) | null`; `loadFavorites(sync: "none" | "open" | "check"): Promise<void>`
    (one request in flight; read once more if a newer version arrived meanwhile); `wsLibDetails: Record<string, Wallpaper>`;
    `loadLibDetails(): Promise<void>` (only IDs not held yet); `localSort: LocalSort` (localStorage `wsLocalSort`, default
    `"totaluniquesubscribers"`), `setLocalSort(v)`; `setModes(): SetModes`; `localSetOn(): boolean`.
    `reload()` / `loadMore()` send no `/browse` while `localSetOn()` (`browseFor` = a local key, `hasMore: false`); an
    `@`-tag change that flips `localSetOn()` reloads; Favourites turning ✓ / ✕ → `loadFavorites("open")`; Library ✓ on →
    `loadLibDetails()`.
  - `App.tsx`: the search shows on a local set even inside a creator / presets list; the sort half is
    `{ value: effectiveLocalSort(…), options: localSortOptions(libInc), onChange: setLocalSort }` while `localSetOn()`.

- [ ] **Step 1: Write the failing cells** in `probe-steam.js` (stub: 6 favourites, 4 library Workshop items, 2 shared,
  distinct created / updated / subscriptions / score / favourites; one library item with no details):
  - `yours:combos`: per row state pair, the shown Workshop IDs: lib ✓ = the 4; fav ✓ = the 6; both ✓ = the 2; fav ✓ lib ✕
    = 4 favourites; lib ✓ fav ✕ = 2; both ✕ = the stub's Workshop page minus all 8; lib ✕ / fav ✕ alone = the page minus
    that set; – – = the page. Each pair asserts the expected list, so a dead position fails.
  - `yours:noScan`: with a ✓ on, no `POST /browse` while toggling tags, searching, sorting and scrolling to the end; no
    `.skel-card`; the last ✓ off → one `/browse` with the Workshop's own sort.
  - `yours:search`: a word from a title, an author name and a tag each narrow it; case-insensitive.
  - `yours:sort`: the menu's labels exactly as Global Constraints (Date Added only with Library ✓); each option orders the
    stub as its field says, the library item with no details last; every option changes the order (none a no-op).
  - `yours:trendSort`: Workshop sort "Most Popular · Week"; Favourites ✓ → the menu reads "Most Subscribed", no "Most
    Popular" option; ✓ off → "Most Popular · Week" and the next `/browse` carries `trend` / 7.
  - `yours:switches`: Type Video, an age and a genre narrow the local set; any age filter drops untagged items.
  - `yours:inList`: inside a creator's list ✓ shows only that creator's favourites; inside a scene's presets list only its
    presets among the favourites; ✕ hides them from the list's pages.
  - `yours:scenes`: scene support off → scenes leave at once; presets shown only with Type's Preset ticked.
  - `yours:big`: 2,000 stubbed favourites; typing a search sends no request; card count right; content-visibility kept.
- [ ] **Step 2: Run to see them fail** — `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^yours:'` (background).
- [ ] **Step 3: Implement**; `// Guard: probe-steam yours:*` above `buildLocalSet` and the `reload` skip; `// API:` on the two client calls.
- [ ] **Step 4: Run** `cd app/ui && npm run build && npm run lint`, then the probe command (background), then
  `--probe probe-steam.js` whole and `--probe probe-filters.js` whole (background). Expected: all PASS.
- [ ] **Step 5: Commit** `Show Favourites And Library Sets Directly In Browse`.

### Task 8: The load line and live updates

**Files:**
- Create: `app/ui/src/components/WsSetLoad.tsx`
- Modify: `app/ui/src/api/events.ts` (`workshop-favorites`), `app/ui/src/App.tsx` (the event; `steam-status` / `steam-signed-in` → favourites), `app/ui/src/views/Browse.tsx` (the line, open sync, minute check), `app/ui/src/index.css`
- Modify: `scripts/matrix-cells-for.sh` (`WsSetLoad.tsx` beside `views/Browse.tsx`)
- Test: `app/shell/probe-steam.js`

**Interfaces:**
- Consumes: Task 7's store slice.
- Produces:
  - Event `{ type: "workshop-favorites"; payload: { version: number; loading: { done: number; total: number | null } | null } }`
    → `loadFavorites("none")` when the payload's version is newer than `wsFavs.version` and a Favourites row is ✓ / ✕.
  - `WsSetLoad` (top of Browse's grid, `data-ws-set-load`): the copy in Global Constraints; a 2 px bar in `--accent`
    easing its `scaleX`; `error` → its text + a Retry button (`loadFavorites("open")`); leaves with `useLinger`; `bg-live`:
    text drop-shadow; `no-glow`: no glow; motion off: appears / leaves by opacity only, the bar changes at once.
  - Browse mounted with the Workshop and a Favourites row ✓ / ✕ → `loadFavorites("open")` once; while mounted and
    `appActive`, every 60 s `loadFavorites("check")`.
  - `steam-status` / `steam-signed-in` with `signedIn: false` → `wsFavs` cleared at once; signed in → `loadFavorites("open")`
    if a Favourites row is on.

- [ ] **Step 1: Write the failing cells** (the STUB's `__favs` can hold its answer, and its `setInterval` shortens a
  60,000 ms interval for the probe only):
  - `yours:loadLine`: a first Favourites ✓ with the answer held → the line shows within one frame of the click, reading
    "Loading your favourites…", then "… — 120 of 450" after a `workshop-favorites` event; the grid fills; at the end it
    fades out. Per frame: opacity / transform only. Shots `steam-yours-load*.png`.
  - `yours:loadLineOff`: motion off → opacity-only frames (`motion-off.js`); Glow off → no glow; `bg-live` → drop-shadow.
  - `yours:loadError`: an error answer → its text and Retry; Retry asks `sync=open`; the partial grid stays.
  - `yours:starLive`: Favourites ✓; the sidebar star on a non-favourite (stubbed POST) then a `workshop-favorites` event →
    the card joins the grid; unstar → it leaves; no reload.
  - `yours:check`: Browse open, Favourites ✕ on → one `sync=open`, then `sync=check` per (shortened) interval; none
    while the window is inactive; none with no Favourites row on.
  - `yours:signOut`: a `steam-status` signed-out event → the favourites leave the grid at once, the row dims with its reason.
- [ ] **Step 2: Run to see them fail** — `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^yours:(load|star|check|signOut)'` (background).
- [ ] **Step 3: Implement**; `// COOL:` on the line's motion, `// Guard:` naming the cells.
- [ ] **Step 4: Run** the UI build + lint, the probe command, then `--probe probe-steam.js` whole (background). Look at the shots.
- [ ] **Step 5: Commit** `Show The Favourites Load And Follow Stars Live`.

### Task 9: The Library tab's Favourites row

**Files:**
- Modify: `app/ui/src/views/Library.tsx` (the `filtered` memo; `loadFavorites("open")` when the Library shows with the row on)
- Test: `app/shell/probe-steam.js`

**Interfaces:**
- Consumes: Task 6's Library group, Task 7's `wsFavs` / `loadFavorites`, `favoritesUsable`.
- Produces: in `Library.tsx`, `@favorites` ✓ keeps items whose `workshopId` is in `wsFavs.ids`, ✕ keeps the rest
  (non-Workshop items included); signed out, no effect.

- [ ] **Step 1: Write the failing cell** `lib:yours:fav`: library with 3 Workshop items (one starred) and one non-Workshop
  item; ✓ → the starred one only; ✕ → the other three; – → all four; signed out → all four, row dimmed; the Library's
  own sort and search still apply; a `workshop-favorites` event adding a second star updates ✓ live.
- [ ] **Step 2: Run to see it fail** — `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^lib:yours'` (background).
- [ ] **Step 3: Implement**; `// Guard: probe-steam lib:yours:fav`.
- [ ] **Step 4: Run** the UI build + lint, the probe command, `--probe probe-filters.js --only '^lib:'` (background).
- [ ] **Step 5: Commit** `Add The Favourites Row To The Library`.

### Task 10: Remove the Favourites pill and list; end-to-end cell; rules and docs

**Files:**
- Modify: `app/ui/src/components/SourcePills.tsx` (the Favourites pill and `Star` import go), `app/ui/src/api/client.ts`
  (`WsList` loses `favorites`), `app/ui/src/store/index.ts` (`listId`, `setWsList`), `app/ui/src/components/WorkshopSocial.tsx`
  (`WsListNote` favourites text), `app/ui/src/App.tsx` (comments), `app/ui/src/components/workshopFilter.ts` (`WS_LIST_SORTS` comment)
- Modify: `src/backend/Models/WorkshopList.cs` (`IsFavorites`), `src/backend/Services/SteamWorkshopService.cs`
  (`ListAsync`'s favourites path and `_favoritesViaPage`), `src/backend/Web/ServerHost.cs` (the `/browse` 403 catch's comment)
- Modify: `app/shell/probe-steam.js` (`ws:pills` rewritten, the STUB's favourites list branch, header lines), `scripts/test-workshop-social.sh`
  (§ 1 and § 3 favourites-list asserts rewritten to `/workshop/my-favorites`; header)
- Modify: `.claude/rules/backend/sources-steam.md` (§ Workshop community: the favourites cache, its files and checks, the
  details cache; § Verify), `.claude/rules/ui/state-and-api.md` (§ Workshop filter: `@favorites`, local sets, the lists
  without `favorites`), `docs/decisions.md` (one entry: "Show Favourites and In my library as sets in the filter column",
  ruling out the pill and page scanning), `docs/TODO.md` (#114 deleted)
- Delete: `docs/superpowers/specs/2026-11-21-favourites-filter-design.md` and this plan (their still-true facts moved above)

**Interfaces:**
- Consumes: everything above.
- Produces: `/browse` `list.kind` `"favorites"` is no longer a list (the whole Workshop answers); no `[data-ws-pill="favorites"]`.

- [ ] **Step 1: Rewrite the tests first.** `ws:pills`: no Favourites pill; the strip holds the source pills plus a creator
  pill once opened; the Workshop pill reads its plain source name and is lit; × goes back. `test-workshop-social` § 1:
  `/workshop/my-favorites` signed out → `{signedIn: false}` (replaces "favourites list → 403"); § 3: the signed-in
  and private-profile favourites asserts read `/workshop/my-favorites` (titles fav-a / fav-b; the community page + details).
  New `yours:stack` in `probe-steam.js` against the stack's own backend: a fake cookie written to the stack's
  `$XDG_CONFIG_HOME/liascape/steam-auth.json` and `@userfiles` added to `$LIASCAPE_STEAM_CM_FIXTURE` (both undone at the
  cell's end); Favourites ✓ lists them, no `/browse`, the backend log shows no refused network call.
- [ ] **Step 2: Run to see them fail** — `bash scripts/test-ui-matrix.sh --probe probe-steam.js --only '^(ws:pills|yours:stack)'`,
  `bash scripts/test-workshop-social.sh` (background).
- [ ] **Step 3: Remove** the pill and the list kind; edit the rules, decision and TODO.
- [ ] **Step 4: Run** `dotnet build src/backend`; `cd app/ui && npm run build && npm run lint`; `bash scripts/test-workshop-social.sh`;
  `bash scripts/test-steam-signin.sh`; `--probe probe-steam.js`, `--probe probe-filters.js` (with
  `LIASCAPE_MATRIX_SCREEN=2560x1440`); `bash scripts/test-ui-matrix.sh --changed`; `bash scripts/check-rules.sh` (all in
  the background, one at a time). Expected: all PASS, check-rules clean.
- [ ] **Step 5: Commit** `Turn Favourites Into A Filter Row`.

## Self-review notes

- **Spec coverage:** set rows and semantics (Tasks 6, 7), lists composition (7), two sorts and trend fallback (7), signed
  out (6, 8, 9), library items without details (7 `libraryCards`), cache contents / first load / streaming (2–4, 8),
  staying current (5, 8), sign-out (4 j, 8), search and sorts (7), UI pill removal and look (6, 8, 10), Library row (9).
- **Deferred to TODO #115:** the few-minute watch of one item after "Favourite on Steam". #115 adds that trigger; it can call
  `WorkshopFavorites.Check` on a short interval for its window. No endpoint is built for a caller that doesn't exist yet.
- **Author search:** Steam's details carry only the creator's Steam ID. The name is matched where known (a library item's
  `authorName`, a profile this run already read: `SteamCommunity.KnownName`), never by reading one profile per favourite
  (that would trip steamcommunity.com's per-IP limit).
