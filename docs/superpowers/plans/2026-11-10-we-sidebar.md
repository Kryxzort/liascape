# WE-style sidebar — plan

Spec: `docs/superpowers/specs/2026-11-10-we-sidebar-design.md`. Worktree `.claude/worktrees/we-sidebar` (branch `we-sidebar`).
Stack reuse: debug player + scene worker + backend build reflink-copied from another worktree, matrix runs with `--no-build`.

1. **Before.** `scripts/test-ui-matrix.sh --no-build --probe probe-layout.js` (`LIASCAPE_MATRIX_SCREEN=2560x1440`) on the
   untouched tree → the modal screenshots `layout-modal-<w>x<h>.png` (kept in the scratchpad as "before").
2. **RED.** Write `app/shell/probe-sidebar.js` (cells in the spec's Tests section) + `probe-layout.js` `resize:side:*`; run
   both on the old UI → every sidebar cell FAILs (no `.side-panel`).
3. **Store.** `libFocus` / `browseFocus` + `focusLib` / `focusBrowse`; drop `cardSettings*`; `itemChangedByBackend` loses the
   modal copy.
4. **Components.** `SidePanel.tsx` (shell: aside, head + close, enter/exit, scrim, Escape), `SideMedia.tsx` (layered picture),
   `LibrarySide.tsx` (the modal's logic: volume/speed drag contract, duration, loudness, whitelist, scene props, the
   actions, levels, the ready gate), `BrowseSide.tsx` (detail fetch, download state, In library). `ScenePropsEditor`:
   no morph wait, a per-path cache, `onReady`.
5. **Views.** Library: focus on click / ctrl / shift / right-click, keyboard, renders `LibrarySide`; `LibraryCard`:
   `focused`, menu without Settings. Browse: click = focus, double-click = download & apply, corner download button,
   keyboard, renders `BrowseSide`; `Card` likewise. PlaylistBar: "Settings" → `focusLib`. App: `--topbar-h`, no modals,
   no `modal-open`, Show in Library → tab switch. `autoplay.ts`: no modal gate.
6. **CSS.** `.side-panel` docked / overlay, scrim, enter / exit / swap animations, `.card.focused`, `no-motion` + `no-glow`
   overrides; drop the modal / morph rules.
7. **Delete** `CardSettingsModal.tsx`, `PreviewModal.tsx`, `useMorph`'s flight, the flight half of `morph.ts`,
   `probe-morph.js`.
8. **GREEN.** probe-sidebar + probe-layout; port `probe-matrix.js` helpers (`openSide`, slider lookups, close) and the
   other probes that opened the modal; `matrix-cells-for.sh` mapping; full matrix (`--jobs 6`) unless the owner's battery
   is running (then `--changed` single cells only).
9. **Docs.** web-ui.md (the sidebar section replaces the modal / morph sections), TODO.md (item closed → TODO-done.md),
   NIGHT-NOTES.md. Screenshots after (same sizes). Merge lp-player, ff-only main checkout, push.
