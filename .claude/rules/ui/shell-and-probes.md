---
paths:
  - "app/shell/**"
  - "scripts/test-ui-matrix.sh"
  - "scripts/matrix-cells-for.sh"
  - "scripts/freeze-monitor.sh"
---

# Electron shell and UI probes (`app/shell`)

## Shell (`app/shell/main.js`, `preload.js`)
- Keep `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`. Every webContents denies new windows (http(s) → `shell.openExternal`), blocks navigation away from the app's origin and refuses `<webview>`. Permissions: only `clipboard-sanitized-write` and `fullscreen`.
- The `liascape:pick` IPC (native pickers, `window.liascape.pickFolder()/pickFile()`) answers only the app's own frame; the UI falls back to a text input when `window.liascape` is undefined.
- The shell deletes `serve.token` before starting its own backend (a new token per launch), waits for `serve.port`, and opens `http://127.0.0.1:<port>/?token=…`; with Vite running it opens `http://localhost:5173/?api=5174&token=…`.
- GPU: NVIDIA defaults to hardware GL via ANGLE `--use-angle=gles-egl`; `LIASCAPE_SOFTGL=1` forces SwiftShader, `LIASCAPE_ANGLE=<backend>` picks another ANGLE backend. The "'--ozone-platform=wayland' is not compatible with Vulkan" log line is harmless.
- `LIASCAPE_DEBUG=1` opens CDP on :9222 (`node app/shell/cdp.js "<expr>"`) — read-only inspection; anyone local can drive the window meanwhile.

## Probes and the UI matrix
- Probes load pages with `withToken(U + "/")` and send `authHeaders()` from `app/shell/api-auth.js`; in-page fetches read `sessionStorage.liascape_token`.
- `scripts/test-ui-matrix.sh` is hermetic (own HOME/XDG dirs, backend, player, PulseAudio, Xvfb); never point a probe at the owner's running app. Usage, `--only`, `--jobs`, `--changed`, `--fuzz`, `--probe` and `LIASCAPE_MATRIX_SCREEN`: the script's header.
- Use `--changed` before a commit; the full run before a merge or a release build.
- The matrix window is SHOWN on the private Xvfb and focused: a hidden BrowserWindow renders no frames (rAF never fires — exits never finish, `appActive` stays false). Drags that need real hit-testing go through `webContents.sendInputEvent`.
- Find items by `data-*` attributes and labels (`data-title`, `m.row(label)`), never by a tooltip; a renamed label updates the probes.
- A new control gets a cell; a new family must be mapped in `scripts/matrix-cells-for.sh` (unknown files mean FULL).
- `--ui-dir <older build>` drives an older bundle (show a fix RED first: `.claude/rules/testing.md`).
- How to verify a visual change (screenshots, per-frame samples): the `ui-verify` skill.
