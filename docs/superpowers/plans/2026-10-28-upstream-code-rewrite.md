# Upstream Code Rewrite — Plan

**Goal:** no line of upstream livepaper (sunwoo101, MIT) remains in the tree, so the project is GPL-3.0 code of its
own and `LICENSE.upstream-MIT` can go. Owner request, 2026-10-28 ("our project has become something different
entirely").

**When:** after Phase 3 deletes the legacy engine — about a third of the remaining upstream lines sit in
`PlayerHelper.cs`'s legacy mpvpaper paths and disappear with it for free.

**Measured 2026-10-28** (`git blame -w -M -C`, `src` + `app` + `scripts`): 1,837 of ~96,000 lines are upstream's.

| File | Upstream lines |
|---|---|
| `src/backend/Helpers/PlayerHelper.cs` | 601 (mostly legacy) |
| `src/backend/Scrapers/MotionBgsScraper.cs` | 231 |
| `src/backend/Helpers/ImportService.cs` | 112 |
| `src/backend/Scrapers/MoewallsScraper.cs` | 92 |
| `src/backend/Scrapers/WallpaperEngineScraper.cs` | 83 |
| `src/backend/Scrapers/DesktophutScraper.cs` | 81 |
| `src/backend/Helpers/DownloadHelper.cs` | 56 |
| `src/backend/Models/AppSettings.cs` | 50 |
| `PlaylistService.cs`, `AudioMonitor.cs`, `Program.cs`, `MotionBgsService.cs`, `build-appimage.sh`, `WallpaperEngineService.cs`, `SettingsService.cs`, … | < 50 each |

## Rules

- **A real rewrite, not a reshuffle:** each piece is re-implemented from what it has to do (its inputs/outputs, the
  site's HTML, the tests), never by editing upstream's lines into a different shape. Renames/reformatting don't count.
- **Behaviour is pinned first:** before rewriting a file, its observable behaviour is covered by tests (scraper
  fixtures from saved HTML, the adapter IT, the UI matrix); the rewrite must pass the same tests.
- **Git history stays untouched.** Upstream's commits keep their author. Rewriting history to erase authorship
  misrepresents who wrote what, and would break every published hash (the NixOS pin, clones).

## Steps

1. Re-run the blame count after Phase 3; list the files left.
2. Per file (scrapers first — biggest, most isolated): pin behaviour with tests → rewrite → tests green → blame shows
   0 upstream lines in it.
3. When the count is 0: delete `LICENSE.upstream-MIT`; `scripts/PKGBUILD` → `license=('GPL-3.0-only')`; move the
   acknowledgement out of the README into `UPSTREAM.md` (→ `CREDITS.md` via `scripts/gen-credits.py`) as a
   history note ("started in 2026 as a fork of sunwoo101/livepaper; no upstream code remains") — or drop it, owner's
   call at that point.
