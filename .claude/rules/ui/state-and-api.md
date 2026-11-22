---
paths:
  - "app/ui/src/api/**"
  - "app/ui/src/store/**"
  - "app/ui/src/settingsLevel.ts"
  - "app/ui/src/views/**"
  - "app/ui/vite.config.ts"
---

# UI state and backend API (`app/ui/src/api`, `app/ui/src/store`)

The backend's side of every contract: `.claude/rules/backend/api.md`. Why behind the choices here: `docs/decisions.md` § UI
and § Settings & state.

## Talking to the backend
- Every request carries the API token: `fetch` through `authHeaders()` (`jget` / `jpost` do), every src/WS URL through `withToken(url)` (`img`, `media`, `anim`, `still`, the transition preview URLs, `useEvents` do). A hand-built API URL or a direct `fetch` that skips them gets 401.
- The token arrives as `?token=`; `api/client.ts` keeps it in `sessionStorage` (`liascape_token`) and removes it from the address bar.
- Remote images go through `img(url)` (the `/img` proxy); local files through `media(path)`; a Browse card's thumbnail through `thumb(u)` (local path → `/media`, http(s) → `/img`).
- Every media URL (`img`, `media`, `clip`, `anim`, `still`) starts with `MEDIA` (the backend's media listener, the API's port + 1), never `API`: on `API` it would share the API's 6 browser connections and queue API calls behind it. Guard: matrix `browse:mediaPool`.
- `/media` serves only library / cache / Workshop-folder paths — keep test fixtures under the stack's cache dir.
- Links open in the user's browser (`target=_blank` / `window.open` → main.js); the window never navigates away from the app's origin.
- A poll keeps one request open at a time (`components/WallpaperBg.tsx`): one stacked per tick behind a slow backend fills the page's 6 connections to the API and queues every other call. Guard: probe-settings `bg:onePoll`.
- Mark `// API:` where the UI depends on a backend contract.

## The store mirrors backend-owned state
- Every settings save posts the WHOLE `settings`; merge backend-made changes (WS `settings-changed` → `mergeSettings`) and post `get().settings` at fire time, not a snapshot.
- `library-item-changed` carries only changed fields: spread them into the item (`itemChangedByBackend`), never default the missing ones.
- Every POST carries the page's `X-Liascape-Client` id (`CLIENT_ID`) so the page skips the echo of its own save (`playlist-changed`).
- Trash/undo: drop the items from the playlist bar first, then re-read it (`syncPlaylist()`).
- ONE `resync()` (`readBackend`) reads everything the store mirrors, at start (retried while the backend is down) and on every WS reopen. Apply each piece only when ITS read succeeded — never `[]` for a failed read — and keep a local edit whose debounced save is pending (`playlistBarSavePending`, `settingsSavePending`). Guards: matrix `restart:backend`, `restart:midLibrary`, `restart:initDown`.
- The UI never guesses which item plays: the mark comes from `wallpaper-changed` (and `/current` for a Play that switches nothing; drop it if an event landed meanwhile). Guard: matrix `playlistMark:shufflePlay`.
- Ask `/current` only through `askCurrent()`: an answer applies while it is the newest asked and no `wallpaper-changed` landed since. The page asks once more when its first socket opens (`rereadPlaying`): the store's first reads race it. Guards: matrix `load:afterApply:*`.
- A Browse list reply belongs to its generation (`browseGen`): drop replies from an older `reload()`.
- An item that can't play (`unplayableReasonOf`: a preset's `presetReason`, and every scene and preset while
  `scenesBlocked`) is greyed with the reason, and `applyItem` plays nothing and says why. Guard: probe-sidebar
  `lib:preset:needsBase`, `lib:scenesBlocked`.
- Removing a scene that library presets play (Delete, the Delete key, Delete and unsubscribe, the Browse sidebar's
  Unsubscribe) asks first through `app/ui/src/components/baseConfirm.ts` `confirmBaseRemoval`, naming how many; a preset's own delete
  never asks. Guard: probe-sidebar `lib:baseDelete`.
- The production origin is `http://127.0.0.1:<port>`; the shell reuses the last port (`LIASCAPE_PORT`, when it and the media port after it are free) so localStorage prefs survive a relaunch.

## Settings page
- `views/Settings.tsx` reads `GET /player-engine` (the player's scene and low-VRAM status) and `/health/features`; the control of a broken feature stays usable with a `WarnIcon`.
- Settings levels live in `src/settingsLevel.ts`; the backend never reads `settingsLevel`, and a hidden changed value shows the "tucked away" note, never a reset. A section none of whose rows show hides with them, never a lone heading (`Section` `bare` opts out: a section whose content isn't rows). Guard: probe-settings `levels:*`.
- Card previews: `previewOnHover` / `previewNotHovered` (Advanced rows "On hover" / "Not hovered") are orders of `video` / `gif` / `image`; Basic's "Card previews" picks a pair from `PREVIEW_PRESETS` (`components/mediaAssets.ts`) and reads "Custom" when none matches by what each list reaches (up to `image`); orders a preset names are never "tucked away". Guard: probe-cardpreview `cardpv:preset`.
- Rotation rows: one interval field labelled "Switch every" (timer) or "Minimum play time" (advance-on-end), durations through `components/PlayTimeInput.tsx`. Semantics: `.claude/rules/backend/player-adapter.md` § Rotation.

## Workshop filter
- The filter contract is `{sort, trendDays, include[], exclude[], featureMatch, genreMatch}`; a tag is in include XOR exclude (`store.setTagState`). UI-only pseudo-tags start with `@` (`@library`, `@favorites`: `views/localSet.ts` `LIBRARY_TAG` / `FAVORITES_TAG`, their one home) and are never sent. Changes go through `setBrowseFilter` (debounced reload).
- Type offers Preset only while presets can play (`store/index.ts` `presetsOn`: `allowScenes`; `workshopFilter.ts` `groupsFor(scope, presets)`), unticked by default; when they stop, the store's `presetsOn` subscription drops a ticked or hidden Preset from every scope and leaves a presets list for the whole Workshop. A preset item's Type facet is `preset` alone, never `scene` or `video` though Steam tags it with its base's type (`facetsOf`): Scene and Preset filter apart, as the Workshop's query does. Guard: probe-filters `filter:preset:*`, `lib:preset`, `local:wePreset`.
- The Workshop's lists (`wsList`, sent by `wireList` as `{kind, id, sort}` only): `creator` (a person's items) and `presets` (a scene's, from the sidebar's `PresetsRow`; its `scene` is the UI's own, for the presets' "Uses" row). A preset's "Uses" row (`BaseRow`) opens the base's Library card, else its Browse card through `showBrowseItem` (the list's own, else `browseExtra`), never a Steam page. Guard: probe-steam `ws:presets*`, `ws:presetBase`.
- The Yours rows are sets, not lists (`docs/decisions.md` § "Show Favourites and In my library as sets in the filter column"): a ✓ on the Workshop (`localSetOn()`) shows the local set (`views/localSet.ts` `buildLocalSet`: the algebra of the favourites `wsFavs` and the library's Workshop items with their `wsLibDetails`, then the open list, the filter's tags, its own search and its own sort `localSort`, saved as `wsLocalSort` apart from `browseFilter.sort`, never the trend sort), and `reload` / `loadMore` send no `/browse`; ✕ alone hides the set from the Workshop's pages (`hideSets`). The Library's Favourites row filters its items the same way (`byFavorites`). Guard: probe-steam `yours:*`, `lib:yours:*`.
- The favourites come from `GET /workshop/my-favorites` through `loadFavorites` only (one read at a time): `open` when Browse mounts or the Library shows with a Favourites row on and when a row turns on, `check` every 60 s while Browse shows and `appActive`, `none` on a newer `workshop-favorites` version. Signed out (`favoritesUsable`) the Favourites row is dimmed with "Sign in to Steam", its saved state kept but without effect, and it can only be cleared; a change of the usable sign-in (signed out, turned down, another account) drops `wsFavs` and any read on its way at once. Guard: probe-filters `wf:yours:*`, probe-steam `yours:check`, `yours:signOut`.
- The Library and the local WE folder (`supportsLocalFilter`) have their own filters (`FilterScope`: `libFilter`, `weFilter`, each saved under its own key), matched in the page by `localMatcher` with the Workshop's semantics, never sent; one scope's change never touches another's.
