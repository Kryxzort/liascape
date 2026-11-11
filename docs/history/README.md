# History and the old rule files

On 2026-11-11 the agent rules were rebuilt (`.claude/rules/writing-rules.md` says how they are written now). The old
rule files were moved here verbatim — with their incidents, measurements, dated owner decisions and Task/Phase/R
numbers — so nothing is lost. They are NOT loaded automatically and may be stale; the code and the current rules win.

Code comments and older docs still cite the old paths. Where each one went:

| old path (cited as) | archived text | current rule |
|---|---|---|
| `CLAUDE.md` (before the rework) | `docs/history/CLAUDE-before-2026-11-11.md` | `CLAUDE.md` |
| `.claude/rules/player-core.md` § <Module> | `docs/player/modules/<module>.md` (one file per old `##` section; the Scene worker's `###` subsections are `scene-*.md`) | `.claude/rules/player/*.md` |
| `.claude/rules/player-adapter.md` | `docs/player/adapter.md` | `.claude/rules/backend/player-adapter.md` |
| `.claude/rules/web-backend.md` | `docs/history/backend-web.md` | `.claude/rules/backend/api.md`, `.claude/rules/backend/sources-steam.md` |
| `.claude/rules/web-ui.md` | `docs/history/ui.md` | `.claude/rules/ui/*.md` |
| `.claude/rules/player.md` | `docs/history/legacy-engine.md` | `.claude/rules/backend/legacy-engine.md` |
| `.claude/rules/session.md` | `docs/history/session-settings.md` | `.claude/rules/backend/state-files.md` (rotation: `backend/player-adapter.md`) |
| `.claude/rules/sources.md` | `docs/history/sources.md` | `.claude/rules/backend/sources-steam.md` |
| `.claude/rules/library.md` | `docs/history/library.md` | `.claude/rules/backend/library.md` |
| `.claude/rules/distribution.md` | `docs/history/distribution.md` | `.claude/rules/build-and-packaging.md` |

`player-core.md` section → module file: liascape-player → `overview`, Module map → `module-map`, Event log →
`event-log`, Units → `units`, Clocks and Animation → `clocks-animation`, Graph & properties → `graph-properties`,
GFX / EGL → `gfx-egl`, Effects → `effects`, Composition → `composition`, Sources → `sources`, Transition recipe →
`transitions`, Programs → `programs`, Signals → `signals`, Runtime → `runtime`, Command API → `command-api`, Wayland →
`wayland`, Audio bus → `audio-bus`, Supervisor → `supervisor`, Snapshot → `snapshot`, Outbox → `outbox`, Memory →
`memory`, Scene worker → `scene-worker` (+ `scene-frame-transport`, `scene-lwe-core`, `scene-source`,
`scene-real-scenes`, `scene-audio`, `scene-loudness`, `scene-gpu-budget`, `scene-transitions`, `scene-crash-policy`,
`scene-corpus`, `scene-health`).

New history goes in the commit message, or in a `docs/history/<area>.md` file when it needs more room.
