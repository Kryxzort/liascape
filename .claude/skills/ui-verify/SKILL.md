---
name: ui-verify
description: Verify a Liascape UI change (app/ui, app/shell) in the hermetic UI matrix or one probe — run the cells, look at mid-animation screenshots, sample motion per frame. Use after changing anything visible in the Electron/React UI and before calling it done.
---

# Verifying a UI change

Everything runs in the hermetic stack of `scripts/test-ui-matrix.sh` (own HOME, backend, player, audio, Xvfb). Never
drive the owner's running app. Run long jobs in the background and wait on their exit.

## 1. Pick the run
- Before a commit: `bash scripts/test-ui-matrix.sh --changed` (only the cells the change can affect; `scripts/matrix-cells-for.sh` explains the mapping).
- One area: `bash scripts/test-ui-matrix.sh --probe probe-sidebar.js` (or `probe-layout.js`, `probe-plbar.js`, `probe-filters.js`, `probe-steam.js`, `probe-health.js`, `probe-expert.js`, `probe-plmenu.js`, `probe-preview.js`); `--only '<regex>'` narrows to cells.
- Layout at many sizes: add `LIASCAPE_MATRIX_SCREEN=2560x1440`.
- Before a merge or a release build: the full run (`--jobs 6` default; `--jobs 2` + `LIASCAPE_MATRIX_NICE=1` while the owner works).
- Last line `MATRIX …`; results and screenshots in `$LIASCAPE_MATRIX_OUT` (default: a dir printed at the end).

## 2. A new element needs its own cell
- Add a cell to the probe of its area covering motion on, motion off (`no-motion` and `prefers-reduced-motion`), `no-glow` and `bg-live` (`.claude/rules/ui/design.md` § Every new UI element).
- Use real input events (`webContents.sendInputEvent`) for hover, drag and right-click; find elements by `data-*` attributes or labels.
- Show it RED on the old UI where you can: `--ui-dir <a build of the base commit>`.

## 3. Motion: sample per frame, don't trust a still
- A still screenshot can't show a missing animation. In the probe, sample the property per animation frame (`requestAnimationFrame` loop reading `getComputedStyle(el).transform` / `opacity` / box) and assert it passes through in-between values for ≥ 3 frames — and with motion off, that it jumps.
- Check that only transform / opacity / filter animate (`el.getAnimations()`).

## 4. Look at it
- Capture mid-animation shots (`win.webContents.capturePage()` during the transition, as the probes' `shot()` helpers do) and OPEN them with the Read tool — at least the start, the middle and the end, plus `no-glow` and `bg-live` variants.
- Look for: hard-coded colours on a theme switch, a glow missing next to glowing neighbours, an element popping in, a white native control, an off-centre icon, text unreadable over the live wallpaper.

## 5. Report
- Name the cells/probes run, their pass counts, and which screenshots you looked at.
