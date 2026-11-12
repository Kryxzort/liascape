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
- Mark `// API:` where the UI depends on a backend contract.

## The store mirrors backend-owned state
- Every settings save posts the WHOLE `settings`; merge backend-made changes (WS `settings-changed` → `mergeSettings`) and post `get().settings` at fire time, not a snapshot.
- `library-item-changed` carries only changed fields: spread them into the item (`itemChangedByBackend`), never default the missing ones.
- Every POST carries the page's `X-Liascape-Client` id (`CLIENT_ID`) so the page skips the echo of its own save (`playlist-changed`).
- Trash/undo: drop the items from the playlist bar first, then re-read it (`syncPlaylist()`).
- ONE `resync()` (`readBackend`) reads everything the store mirrors, at start (retried while the backend is down) and on every WS reopen. Apply each piece only when ITS read succeeded — never `[]` for a failed read — and keep a local edit whose debounced save is pending (`playlistBarSavePending`, `settingsSavePending`). Guards: matrix `restart:backend`, `restart:midLibrary`, `restart:initDown`.
- The UI never guesses which item plays: the mark comes from `wallpaper-changed` (and `/current` for a Play that switches nothing; drop it if an event landed meanwhile). Guard: matrix `playlistMark:shufflePlay`.
- A Browse list reply belongs to its generation (`browseGen`): drop replies from an older `reload()`.
- The production origin is `http://127.0.0.1:<port>`; the shell reuses the last port (`LIASCAPE_PORT`, when it and the media port after it are free) so localStorage prefs survive a relaunch.

## Settings page
- `views/Settings.tsx` reads `GET /player-engine` and `/health/features`; liascape-player-only rows (`liascapeActive`) and legacy-only rows hide per engine; the control of a broken feature stays usable with a `WarnIcon`.
- Settings levels live in `src/settingsLevel.ts`; the backend never reads `settingsLevel`, and a hidden changed value shows the "tucked away" note, never a reset.
- Rotation rows: one interval field labelled "Switch every" (timer) or "Minimum play time" (advance-on-end), durations through `components/PlayTimeInput.tsx`. Semantics: `.claude/rules/backend/player-adapter.md` § Rotation.

## Workshop filter
- The filter contract is `{sort, trendDays, include[], exclude[], featureMatch, genreMatch}`; a tag is in include XOR exclude (`store.setTagState`). UI-only pseudo-tags start with `@` (`@library`) and are never sent. Changes go through `setBrowseFilter` (debounced reload).
