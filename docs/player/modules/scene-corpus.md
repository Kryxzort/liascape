<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Scene corpus (Task 13)

`src/player/tests/onmachine/scene_corpus.sh` (+ `scene_corpus_report.py`, hand-written diagnoses in
`scene_corpus_notes.json`) plays every `type: scene` item of a Workshop folder (default the 431960
library; **refuses `~/.cache/liascape/steamcmd_workshop`**, also after resolving each item's
symlinks) on a **private** `serve --no-supervise --headless --outputs 1920x1080@60 --clock real
--ao null` (own runtime/state/cache/config dirs + socket under the results dir, no Wayland/X,
PipeWire/Pulse/D-Bus pointed at nothing, `LIASCAPE_PLAYER_VRAM_PROBE=none`, `prlimit --core=1:1`), one
scene at a time: destroy the previous one and wait for its worker pid to go, `create {kind: scene,
path}` with **no preview** (a crash can't pass for a picture), `set lay:*:main.content` (a cut),
poll `probe workers` until `ready` / `broken` / `last_error` / 20 s, capture the source at Ready
+1 s, +2.3 s and +4 s (the off-grid middle one: ticks run on a 30 fps grid of scene time, so a loop
whose period divides 3 s — found: 3593587273 — repeats its +1 s frame at +4 s), read the rates
(`fps_actual`, `gpu_ms_p50`) **before** the +4 s capture (a `capture` encoded its PNG on the loop until 2026-10-28 — kept, harmless),
then `probe workers
{"log_tail": true}` + the worker's VmHWM + its `nvidia-smi` line. A background `ctl subscribe
source. worker. scene.` gives `ready_ms` = `worker.spawned` → `source.ready`. Classes (first match):
`load_failed` (fatal `load failed` / never opened), `renderer_failed`, `broken`, `timeout`, `crashed`
(Ready but restarted), `blank` (+4 s luma stddev < 2 or ≥ 99 % one colour), `static`,
`ok` (`static` = all three captures identical). Results (captures, records.jsonl, events.jsonl, serve.log) go to `/tmp/liascape-scene-corpus-<stamp>`
(never the repo — captures aren't committed); the report to `docs/player/reports/scene-corpus.{md,json}`
(items by Workshop id only). `--only`, `--limit`, `--reuse <results>` (re-report / legacy only),
`--no-build`, `--bin`, `--assets`. **`--ab-legacy --legacy-output <out>`** runs the installed
`linux-wallpaperengine --screen-root <out> --screenshot …` per scene — it draws on the real output,
so it is **owner-run only**; the report then lists scenes that start there but not here.
**The report's run (2026-10-28, LWE `bab619b`, 96 scenes, 506 s):** 92 ok, 1 static (a still image + a sound
— by design), 3 load_failed (3D/perspective scenes next-v2 can't parse), 0 blank/broken/crashed/timeout. The
first run (LWE `c902d06`: 86 ok, 1 blank, 4 load_failed, 4 broken) found five LWE causes, every one reproducing
with `--lwe-smoke` (LWE's core alone); four are fixed by fork patches 0012/0014–0017 (§ "LWE core"), the 3D
one is a Phase 6 item in `docs/TODO.md`. The runs also found three
player fixes: the stopped worker's last stderr line (§ `WorkerHost` "Log tail"), the core handler
(above) and `capture`'s PNG compression (§ GFX / EGL `write_png`) — the 0.85 s capture stall had
even made the GPU budget throttle two heavy 4K scenes (15–17 ms/frame) in an earlier run: the loop's
stall read as missed frames; with `Fast` none is throttled. Diagnosing a
scene LWE kills: `nix shell nixpkgs#gdb` + `liascape-scene-worker --lwe-smoke <dir> --assets <dir> --out
<dir>` under gdb (`catch throw` shows LWE's caught load failures; ignore the throws under
`Configuration::detectSteamDir`, LWE's Steam-dir probe, which also prints the harmless `Cannot find
appmanifest_431960.acf …` lines in every tail).
