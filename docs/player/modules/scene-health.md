<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Scene health (2026-11-04)

The corpus asks "does it load and isn't it blank"; 3414858021 passed it for months with its head's compose layer
dropped (glslang rejected four HLSL-isms, the layer went, its children were placed off-screen). The health report
asks **what each scene silently loses**. **Core side — fork patches 0061–0062 `WPENGINE_HEALTH=<path>`**
(`src/core/WallpaperEngine/Health.{h,cpp}`): read per project load (`Project`'s constructor calls
`Health::configure`); unset = off, every call site is `WPENGINE_HEALTH (…)` = one relaxed atomic load, nothing the
renderer does depends on it. On, it appends JSON lines (identical lines once, ≤ 50 000) carrying the open
thread-local scopes — `object`/`object_name` (CScene::dispatchObjectType, ObjectParser::parse), `effect`/
`effect_name` (CImage's effect loop), `shader` (CPass::setupShaders) — so a glslang error names its layer, effect
and shader file. Events: `scene` (size, objects, built, perspective, hdr) and one `object` per scene object after the
build (type image/text/compose/particle/sound/model/light/camera/group, built, visible, effectively_visible, for an
unbuilt image its scene-data box `estimated_bbox`/`estimated_on_canvas_px`); `dropped` (setup threw / particle
without material: reason); `effect_dropped` (`takes_layer`: a passthrough/fullscreen layer's effect failing takes
the layer); `shader_error` (`stage` glslang|gl, `unit` vertex|fragment|link — a glslang failure is followed by GL's
"must write to gl_Position" on the empty source: secondary); `missing_asset` (`kind` texture/usertexture/font/model/
puppet/particle/material/sound/shader_module/script, `path`); `asset_error`; `script_error` (object, property = the
module key without its `_<id>`, `phase` compile/load/init/update/<event>/timer/engine, `line`/`column`/`source_line` of the stack's first frame (0062: QuickJS names no callee in "not a function"), first 5 per module like the
log); `unsupported` (VolumeLight, unknown particle initializer/operator/emitter/renderer, material modes, pass
commands, user property types, a model in a 2D scene); `unknown_object` (its JSON keys — mostly plain groups);
`parse_error`, `pass_error`, `shader_warning` (unparsable combo/parameter metadata), `script_console_error`, `font`
(requested → file used); `compat` (the HLSL-lenient rewrites of 0034/0059, case-insensitive file matches 0016,
zcompat shaders — informational); `layers` at render frames 1 and 31 for every built image/text/particle/model
(`CImage::healthLayer`: the quad's corners through the screen MVP → canvas px, x right, **y down** — NDC +y is the
canvas bottom, the scene draws upside down into its target; `area_px`, `on_canvas_px`, `alpha`, `finite` over the
resolved transform + MVP, `behind_camera`; particles/models: `origin_px`, `origin_on_canvas`, `finite`;
`effectively_visible`, `drawn_by` scene | its compose layer); `load_failed` / `renderer_failed` (then rethrown). Test:
host_api_test `health_reports_what_was_dropped` (a layer whose fragment doesn't parse → `dropped` + attributed
`shader_error`; a throwing origin script → `script_error` object 4 property origin; frame-1 bbox 12 20 20 28 of an
8×8 at WE (16, 8) in 64×32; an off-canvas layer `on_canvas_px` 0; unset → nothing written).
**Runner — `src/player/tests/onmachine/scene_health.sh`** (+ `scene_health_report.py`): every `type: scene` item of
the 431960 folder (the corpus's steamcmd-cache guard), one `--lwe-smoke --seconds 3` each (`prlimit --core=1:1`,
`timeout -k 10 90`, PipeWire/Pulse/D-Bus pointed at nothing, no Wayland/X), results in
`/tmp/liascape-scene-health-<stamp>/scenes/<id>/` (PNGs, health.json, stderr.log), report
`docs/player/reports/scene-health.{md,json}`. Classes: `failed` (no scene: load/renderer failure, crash, timeout,
nothing lit), `degraded` (any error), `clean` (warnings allowed: a visible layer off the canvas / zero size / alpha 0
at both frames, a script's own console.error, unparsable shader metadata). Ranked by `loss` ≈ the canvas share gone
(the report script's docstring has the weights); causes tallied across scenes by a normalised signature (glslang's
first real error, line numbers out; `missing <kind>: <path>`; `script: x.y is not a function`), so fixes batch.
`--only`, `--limit`, `--reuse`, `--no-build`, `--bin`, `--assets`. Report only — it fixes nothing.
