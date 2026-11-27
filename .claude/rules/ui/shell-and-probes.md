---
paths:
  - "app/shell/**"
  - "scripts/test-ui-matrix.sh"
  - "scripts/matrix-cells-for.sh"
  - "scripts/freeze-monitor.sh"
  - "scripts/agent-window.sh"
  - "scripts/shell-runtime-files.sh"
---

# Electron shell and UI probes (`app/shell`)

## Shell (`app/shell/main.js`, `preload.js`)
- Keep `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`. Every webContents denies new windows (http(s) → `shell.openExternal`), blocks navigation away from the app's origin, sends a page's embedded frame that navigates itself (the trailer's title link) to `shell.openExternal` instead, and refuses `<webview>` (`app/shell/outside-links.js`; Guard: `--probe probe-sidebar.js preview:ytLink`). Permissions: only `clipboard-sanitized-write` and `fullscreen`.
- The `liascape:pick` IPC (the native folder picker `window.liascape.pickFolder()`, or files: `pickFiles()`) answers only the app's own frame; a dropped file's path comes from `pathForFile` (`webUtils`). The UI reads `window.liascape` when used (`components/importPick.ts`) and falls back to a text input when it is undefined.
- The shell deletes `serve.token` before starting its own backend (a new token per launch), waits for `serve.port`, and opens `http://127.0.0.1:<port>/?token=…`; with Liascape's Vite running it opens `http://localhost:5173/?api=5174&token=…` (`app/shell/vite-detect.js`: the `X-Liascape-Vite` marker on `/__liascape/token`, so another project's server on :5173 doesn't count; `LIASCAPE_VITE` is trusted unasked).
- A renderer that dies (any reason but a clean exit) or stays hung is brought back by `app/shell/renderer-recovery.js`: reloads with backoff, a plain Reload notice after repeated deaths, every event logged to stderr. Reload through its `pageUrl()` (`withToken` fresh), never `webContents.reload()`: the page drops `?token=` from its address. Guard: `--probe probe-recover.js`.
- GPU: NVIDIA defaults to hardware GL via ANGLE `--use-angle=gles-egl`; `LIASCAPE_SOFTGL=1` forces SwiftShader, `LIASCAPE_ANGLE=<backend>` picks another ANGLE backend. The "'--ozone-platform=wayland' is not compatible with Vulkan" log line is harmless.
- Load a shell module only through `require("./…")`, or from `main.js` with `path.join(__dirname, "<file>")`: installs ship just what `scripts/shell-runtime-files.sh` finds that way (install.sh and the flake), so the probes and CDP helpers stay out.
- `LIASCAPE_DEBUG=1` opens CDP on :9222 (`LIASCAPE_CDP_PORT` = another port); anyone local can drive the window meanwhile.
- Drive the agent window, never the owner's: `bash scripts/agent-window.sh up` (a private headless gamescope compositor, sandboxed backend, Vite and CDP port; `down` stops all of it). `app/shell/cdp.js`, `drive.js` and `scripts/bench-live-ui.mjs` target it by default; `--owner` targets the owner's window (:9222). Never give it an output in the session's Hyprland: removing one snaps the user's cursor to another monitor (the script's header).

## Probes and the UI matrix
- Probes load pages with `withToken(U + "/")` and send `authHeaders()` from `app/shell/api-auth.js`; in-page fetches read `sessionStorage.liascape_token`.
- The window's opening (`app/ui/src/components/Intro.tsx`) plays only on a page whose address carries `intro` (main.js adds it), once per window, so no probe waits for it; a probe that tests it adds it (Guard: `--probe probe-intro.js`).
- `scripts/test-ui-matrix.sh` is hermetic (own HOME/XDG dirs, backend, player, PulseAudio, Xvfb, network namespace: `.claude/rules/testing.md` § No network); never point a probe at the owner's running app. Usage, `--only`, `--jobs`, `--changed`, `--fuzz`, `--probe` and `LIASCAPE_MATRIX_SCREEN`: the script's header.
- A matrix run reaches no real server: Browse's sources answer from the stack's fixtures (the Workshop: `LIASCAPE_STEAM_CM_FIXTURE` `"@query"`; the web sources: `LIASCAPE_WEB_SOURCES_FIXTURE`, `src/backend/Services/WebSourcesFixture.cs`), and the backend refuses anything else (`LIASCAPE_TEST_NO_NETWORK`, `.claude/rules/backend/sources-steam.md`); a refused call fails the run ("FAIL real network", naming it). Give a probe that needs other answers its own in-page stub or extend a fixture; never lift the guard.
- Use `--changed` before a commit; the full run before a merge or a release build.
- The matrix window is SHOWN on the private Xvfb and focused: a hidden BrowserWindow renders no frames (rAF never fires — exits never finish, `appActive` stays false). Drags that need real hit-testing go through `webContents.sendInputEvent`.
- Find items by `data-*` attributes and labels (`data-title`, `m.row(label)`), never by a tooltip; a renamed label updates the probes.
- A new control gets a cell; a new family must be mapped in `scripts/matrix-cells-for.sh` (unknown files mean FULL).
- `--ui-dir <older build>` drives an older bundle (show a fix RED first: `.claude/rules/testing.md`).
- How to verify a visual change (screenshots, per-frame samples): the `ui-verify` skill.
