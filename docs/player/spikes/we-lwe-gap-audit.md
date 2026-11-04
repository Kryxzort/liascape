# Spike: what Wallpaper Engine scenes do that our LWE fork doesn't

## Context

- Status: done 2026-10-29. This is an audit and a porting plan. It contains no patches. Most claims come from static
  analysis. Where a scene was rendered to confirm a claim, the row says so (`--lwe-smoke`).
- Why: 92 of the owner's 96 scenes "play", but the sound spike (`we-sound-semantics.md`) showed that playing is not
  the same as playing right. 57 of 79 sound objects were wrong without any error. This audit looks for the same kind
  of quiet divergence everywhere else a scene can go, and orders the fixes by how much of the library they touch.
- Targets:
  - WE: `wallpaper64.exe` 2.8.485 (sha256 `da37927f…5a`, the same bytes as the sound spike).
    - `bin/scenescript64.dll` (sha256 `e1a0530f…e5`, the V8 SceneScript runtime). Only its strings were used.
    - WE's `assets/`: shaders, effects, materials, particles, `scripts/jsclasses` + `jsmodules`.
  - Ours: the LWE fork `livepaper/next-v2` at `45ed25c` (patches 0001–0018). LWE paths are relative to
    `src/core/WallpaperEngine/` of that tree unless written in full.
  - The library: the owner's 96 SFW scenes in Workshop folder `431960`. The pkgs were read with a Python port of
    `scene/pkg.rs`, and every text asset was extracted for counting.
- Tools:
  - Ghidra 12.1.4, through REA 6.8.0 (MCP), which produced the `ev_…` Evidence ids.
  - The sound spike's headless full-program decompile of the same bytes (`all.c`, 7957 functions). Claims from it are
    tagged `GH 0x…` (the function address), as in the sound spike.
  - A C preprocessor run over every material pass with the defines LWE would set. Uniform counts are for **live**
    code, not for declarations.
  - Docs at docs.wallpaperengine.io, tagged `D-…`.
  - Four parallel audit passes (scene graph, effects, particles, SceneScript). The lead did text, user properties,
    audio, clock and input, and cross-checked the headline claims.
- Scratch evidence (scripts, per-scene counts, extracted scripts): the session scratchpad's `audit/` directory, which
  the sections write as `$S/audit`. It is not in the repo. Every count can be regenerated from the Workshop folder with the scripts named in each section.

### Status labels

These are the same as in the sound spike:

- **Observed**: read from decompiled code, bytes, constants or a WE asset at the place given.
- **Documented**: stated by WE's public docs.
- **Inferred**: follows from what was observed plus known library behaviour.
- **Unknown**: not settled. Never used to justify a change without a WE capture.

### Columns

- **Scenes** counts the owner's 96 scenes that use the feature, resolved through user-property defaults where it
  matters. "Playing" means the 93 that load.
- **Port**: S is under a day, M is a few days, L is a week or more. The size is for a fork patch with a test.


## Summary

### Totals

185 rows. Three pairs describe one gap from two sides: E34 is T1, E1 is G14, and E30 is G33. That leaves about
182 distinct gaps.

| Area | Prefix | Rows | S | S–M | M | M–L | L | none / unknown |
|---|---|---|---|---|---|---|---|---|
| Scene graph, camera, 3D, puppet | G | 34 | 17 | 2 | 8 | – | 4 | 3 |
| Effects, materials, shaders, pipeline | E | 45 | 27 | – | 10 | 1 | 3 | 4 |
| Particles | P | 41 | 29 | – | 7 | 1 | 2 | 2 |
| Text objects | T | 9 | 5 | – | 3 | – | 1 | – |
| SceneScript | S | 38 | 29 | – | 8 | – | 1 | – |
| Audio (after 0018) | A | 6 | 3 | – | 2 | – | – | 1 |
| User properties | U | 7 | 5 | – | 1 | – | – | 1 |
| Clock, frame rate, cursor | C | 5 | 3 | – | – | – | – | 2 |
| **Total** | | **185** | **118** | **2** | **39** | **2** | **11** | **13** |

"none / unknown" means one of two things: the row is parity and is listed only to close the question, or WE's
behaviour has to be settled before anything can be sized.

### The quiet divergences that matter most

These are ranked by scenes × how visible the difference is.

| # | Rows | What is wrong today | Scenes |
|---|---|---|---|
| 1 | S1, S2, S3, S5 | **(Fixed by B1, patch 0020.)** **Property scripts never run.** LWE keeps the Promise that quickjs-ng returns for a module eval, instead of the module, so `update`/`init`/events are never found. Each script then writes null into its property, so layers jump to (0,0) and go invisible or black. Confirmed by a smoke render: 2890767643's media widget sits at the bottom-left corner. | 40 (25 visibly broken) |
| 2 | P1, P6, P5, P4, P3, P8 | **Particles are subtly wrong almost everywhere.** No `starttime` prewarm, so systems start empty (61). Colour randomness is per channel instead of shared (58). `colorn` multiplies instead of shifting hue (43). `count` and `rate` overrides mean different things (43, 36). Sprite-sheet frames step instead of cross-fading (33). | 61 |
| 3 | E2, E3 | **(Fixed by B2, patch 0022.)** **Image alpha and colour.** `g_Color4.w` is 1 instead of the layer alpha. Alpha, colour and brightness uniforms are frozen at setup, so fades, user sliders and scripts never reach the shader. | 30 + ~22 |
| 4 | G01, G02 | **(Fixed by B2, patch 0023; the SceneScript animation API is B10.)** **Keyframe animations (`alpha/origin/angles/scale.animation`) are ignored**, so fades, slides and spins are static. | 20 |
| 5 | T1–T5, T8, G04, G13, G30 | **(Fixed by B4, patches 0048–0050.)** **Text.** One line only, bytes not UTF-8, no alignment, no wrapping, no effects, no parent, no rotation, no parallax. A `systemfont_*` has no font on NixOS, so the text **vanishes**. | 45 |
| 6 | E27, E28 | **`colorBlendMode` layers sample the framebuffer they draw into**, a GL feedback loop with undefined output. | 28 |
| 7 | A1, A3, E8, S17, P20 | **Audio response.** u8 mono, only 0–5.4 kHz, linear bins, Right = Left. `registerAudioBuffers` is missing, so script visualisers throw. | 41 |
| 8 | G10, G11, G12, G14 | **(Fixed by B5, patch 0029.)** **Parallax.** `cameraparallaxdelay` is read as a bool, so 14 of 25 parallax scenes never move. The rest are off-centre, and `g_ParallaxPosition` is never fed. | 25 |
| 9 | P2 | **Particle `children` are ignored**, so whole sub-effects are missing. | 29 |
| 10 | G03, G04 | **Hierarchy.** A hidden parent doesn't hide its children (12 scenes). Text and particle children ignore `parent` (19). | 12 + 19 |
| 11 | S10, S11, S15 | **No cursor events, no media events, no `applyUserProperties`/`engine.userProperties`.** Interactive and "now playing" wallpapers are inert. | 22 / 19 / 18 |
| 12 | G06–G08 | **(Fixed by B12, patch 0054.)** **Puppet warp.** No skeletal animation. 7 of the 14 puppet scenes use MDLV versions LWE rejects. | 14 |

### Corrections to earlier notes

- **`g_Daytime`** (TODO "Deferred from Phase 2"): **no** shader in the library or in WE's stock assets reads it (C1).
  `engine.timeOfDay` (S18) is the same value and 2 scenes read that. WE's formula is now known.
- **The 2189783622 "godrays" item** (TODO): the effect that fails to compile is the packaged **foliagesway**. It reads
  `v_Bounds`, a varying that only its vertex unit declares (E19). Godrays itself maps correctly.
- **Upstream PR #625** (puppet warp), listed in UPSTREAM.md as an import candidate: it was **closed unmerged**. It does
  CPU skinning with one animation layer and covers MDLV 0013/0021/0023. The library also has 0016/0017/0019 (G06/G07).

## Porting plan

Each batch is one or a few fork patches, written in the usual way (`LWE_DEV_SRC=<checkout> bash scripts/lwe.sh build
test`, a test under `patches/lwe/tests` where the math allows). **After every batch:**

1. Run `bash scripts/lwe.sh patches verify`.
2. Run the corpus (`src/player/tests/onmachine/scene_corpus.sh`). It must show no newly failing or blank scene and no
   new crash.
3. Run the batch's own check below.

The "smoke" checks use `liascape-scene-worker --lwe-smoke <scene> --assets <WE assets> --out <dir> --seconds S`. It
writes PNGs at +1 s and at the end, and prints one JSON line. Keep a **before** set of PNGs for the batch's scenes and
diff them against the **after** set (`compare -metric AE`). A WE capture of the same scene from Windows is the
reference where one exists (see "Needs the owner").

Tooling notes:

- The corpus runner fails when `--out` sits under a long path: its Unix socket path exceeds 108 bytes. Run it from a
  short directory such as `/tmp/sc`.
- The smoke mode has no pointer. Pointer-dependent batches (B5, part of B10) need the player in
  `serve --headless`, driven with `ctl headless.pointer` and `ctl capture`.

Batches are ordered by library usage × impact, highest first.

| Batch | Rows | Scenes | Size | How | Verify |
|---|---|---|---|---|---|
| **B1 Make property scripts run** — **done 2026-10-29** (patches 0019–0021; see "B1 result" in § 5) | S1–S7, S9; S33, S34, S35, S38 by evaluating WE's own `scripts/jsclasses/baseclasses.js` + `jsmodules/*.js` as the prelude | 40 | M | `JS_EVAL_FLAG_COMPILE_ONLY` → `JS_EvalFunction` → `JS_GetModuleNamespace`. Skip the write on `undefined`. Call `init(value)`. Bind `thisLayer`/`thisObject` per call. Register scale/angles/visible on the live values. Replace the native Vec/WEMath adapters with WE's JS classes (keep the C++ side for marshalling only). | Smoke 2890767643, 3291729669, 2325974975: the widget is no longer in the corner, and stderr has no `TypeError: not a function`. Fork test: a module whose `update` returns `value+1` moves the property. Corpus: no new blank. |
| **B2 Layer alpha, colour, keyframe animation** — **done 2026-11-02** (patches 0022–0023; see "B2 result" in § 5) | E2, E3, G01, G02 (+ G05 once known) | ~50 | M | `g_Color4 = (color.rgb, alpha)`. Upload alpha/colour/brightness per draw from the live values. A keyframe evaluator for `c0..c2` bezier keys (`fps`, `length`, `mode` loop/mirror/single, `wraploop`, `startpaused`, `relative`), as decoded at GH 0x1401d1740/0x1401d4dd0/0x1401d5790. | Smoke two timestamps of 3 animated scenes: pixels change where WE animates. WE capture of 2388299037 (translucent layer). |
| **B3 Particle core semantics** — **done 2026-11-03** (patches 0024–0028; see "B3 result" in § 5) | P1, P3, P4, P5, P6, P7, P8, P13, P14, P18, P19, P38, P41 | 61 | M (mostly S rows) | Prewarm in 0.05 s / 0.2 s steps until `starttime`. One shared `t` for colorrandom. `pow(rand, exponent)`. `rate` scales the system's dt. `count` scales emitter rate. HSV `colorn` against the reference colour. Enable `SPRITESHEETBLEND`. Re-patch overrides live. One scene RNG. | Smoke at +1 s ≈ +60 s particle density (prewarm). Fork tests for colorrandom, rate, count and exponent math. WE capture of 1797172968 and 1155728109 (P5, P8/P9). |
| **B4 Text renderer** — **done 2026-11-04** (patches 0048–0050; see "B4 result" in § 5; T6/T7 unused, anchor not needed yet) | T1–T5, T8, T10, G04 (text part), G13, G30, E34, S28 | 45 | L | Render text into a texture: UTF-8, line breaking, `maxwidth`/`maxrows`/ellipsis, alignment/anchor/padding. Draw it as a CImage, so it gets effects, parent, rotation and parallax. fontconfig for `systemfont_*` with metric-compatible fallbacks. | Smoke 1884904087, 2134765860, 3028473503 (CJK), 2890767643 (system font on NixOS): text present, multi-line, aligned. WE captures of 2 clock scenes for size calibration (T10). |
| **B5 Parallax and camera** — **done 2026-11-03** (patch 0029; see "B5 result" in § 5; E6, the camera-object pan and paths left) | G10, G11, G12, G14 (= E1), G15, E6, G18, G19, G17, then G16 once its algorithm is decoded | 25 + 8 + 6 | M | WE's smoothing `k = min(1,(1−delay/3)·10·dt)`. A centred target with `mouseinfluence`. Publish `g_ParallaxPosition`. Per-draw effect texture-projection matrix. `general.zoom`/fov/nearz/farz from `general`. Camera-object zoom/pan. | Headless player: `ctl headless.pointer` to 4 corners, `ctl capture` each, layer offsets ∝ depth and depth-0 static. WE capture of 2679248947 (depthparallax) at rest and with the cursor moved. |
| **B6 Hierarchy** — **done 2026-11-03** (patch 0030; see "B6 result" in § 5; text parents stay in B4) | G03, G04 (particles), P36, G31 | 12 + 19 | S | Recursive "effectively visible". A parent transform for particle systems. The rotation pivot once confirmed. | Smoke 3163060610 / 3319542538 (hidden group). WE capture to confirm (G03). |
| **B7 Blend modes and the framebuffer** — **done 2026-11-04** (patches 0046–0047; see "B7 result" in § 5) | E27, E28, E30 (= G33), E31, E33 | 28 | M | Copy the scene FBO before a pass samples `_rt_FullFrameBuffer`. Honour `clampuvs`. Settle `copybackground` and `_rt_imageLayerComposite` parity from WE captures. | WE capture of 2883756643 (blend modes 7/8/11/12/14/31) vs smoke. `glGetError`/KHR_debug feedback-loop warnings gone. |
| **B8 Audio response** — **done 2026-11-03** on the fork side; liascape still feeds mono (patch 0045; see "B8 result" in § 5) | A1, A3, A4, A5, E8, S17, P20, P21 | 41 | M | C API: f32 stereo frames. Per-channel FFT, the observed pow band mapping, max-per-band, sqrt magnitude. Separate Left/Right. dt-based decay. `engine.registerAudioBuffers` (16/32/64 `left/right/average`) on the same buffers. Audio-driven emitter rate. Needs one more decompile pass for the weights and the 16/32 derivation (A3/A4 Unknowns). | Feed a log sine sweep through the input mix, dump the 64-band arrays per frame, and check that the band index follows the WE mapping and L≠R for a panned sweep. Smoke 2469881470 / 2134765860 with music. |
| **B9 Small uniform, property and shader fixes** — **done 2026-11-03** except E9, E11, E20, E38 (patches 0031–0036; E41 in patch 0037; see "B9 result" and "E41 result" in § 5) | E4, E5, C1, C3, E9, E11, E17, E18, E19, E20, E36, E37, E38, E40 (+ the property side of scenetexture), E41, U1, U2, U4, S18 | ≤ 10 each | S each | One patch per theme: engine uniforms (E4, E5, C1, C3, E9, E11), annotation parsing (E17, E18, E45), the varying fix-up (E19), bloom live/tint (E36, E37), textinput quotes (U1, U2), timeOfDay (S18). | Smoke 3184155462 (cursorripple, needs pointer), 2189783622 (foliagesway back), 2890767643 (bar spacing). Corpus. |
| **B10 SceneScript API surface** — **done 2026-11-03** except S16 (resize/animation events), S26 (video textures, puppet layers, …), S37 (createLayer) (patches 0038–0044; see "B10 result" in § 5) | S8, S10–S16, S19–S27, S29–S32, S36, S37 | 1–28 each | M–L | Cursor hit-test + events (`solid`). Media events from liascape's MPRIS (`wp_project_notify_*`). `applyUserProperties` + `engine.userProperties`. `getLayer` by index for all layer types. ISoundLayer `play/stop/pause` (unblocks `startsilent`, A7). Persistent `localStorage`. Layer writes. Missing engine/scene members. Needs B1. | Per feature, a fork test script. Smoke 2325974975 (sounds + menu), 2890767643 (media widget with a fake MPRIS). Headless pointer clicks for cursor events. |
| **B11 Particles, extended** | P2, P10, P15, P22, P24–P30, P34, P35, P37 | 29 | L | Child systems (static / eventfollow / eventspawn / eventdeath). The missing initializers and operators. Control-point overrides and transforms. Rope/trail combos. Needs the operator interpreter (GH 0x140265800) read from asm first (P31–P33). | Smoke the 29 child-system scenes before/after: sub-effects present. WE captures for 2 of them. |
| **B12 Puppet warp** | G06, G07, G08, G09 | 14 | L | Start from PR #625's MDL parsing (unmerged, so cherry-pick into our own commit). Add MDLV 0016/0017/0019. GPU skinning. Animation-layer mixing. Bone attachments. | Smoke the 14 puppet scenes at 2 timestamps: the mesh deforms. WE capture of 1 scene. |
| **B13 HDR bloom and FBO formats** — **done 2026-11-04** (see "B13 result" in § 5; E37 was B9) | E35, E23, E37 | 5 | M | WE's HDR chain (`hdr_downsample`, `combine_hdr_upsample`) with RGBA16F targets when `general.hdr`. | Smoke 2511663284 vs a WE capture. |
| **B14 3D scenes** — **done 2026-11-04** except shadows, cookies, volumetrics, shapes, skinned models (patch 0056; see "B14 result" in § 5) | G24–G29, G20–G22, E13, E14, E43 | 3 (+4 with `perspective` layers) | L | A perspective camera with optional `orthogonalprojection`. 3D image layers and depth/transparent sort (3276522107 first, M). Then the MDLV static-mesh loader + `generic4`. Then lights, shadow atlas, fog. | Corpus: 3276522107 → ok, then 3477054430 and 3509243656. WE captures. |

Rows not in a batch are parity, editor-only or not used by the library. Their rows say so, for example T6, T7, A6,
U5–U7 and E10.

### Unknowns to settle by more decompilation (no owner needed)

- The particle operator interpreter GH 0x140265800, and the particle parser GH 0x1401f3120. Ghidra fails on both, so
  they need manual asm work. This settles P31–P33 (movement drag, turbulence, vortex, oscillate, colour/size change).
- The spectrum's 16/32-band derivation, its weights and its temporal smoothing. They sit in blocks Ghidra marked
  unreachable in FUN_140103630 ([L6]); read the asm. This settles A3/A4.
- ~~The camera-shake algorithm (G16), the per-layer parallax offset with `cameraparallaxamount` (G12)~~ (settled by
  B5), the semantics
  of `camerafade` (G23) ~~and of `copybackground` (E30)~~ (settled by B7).

## Needs the owner

**WE captures on Windows**, a screenshot unless a clip is asked for, each at default settings next to a liascape
capture of the same scene:

| Scene | Settles | Batch |
|---|---|---|
| 2890767643, 3291729669, 2325974975 | property scripts in place (S1/S2) | B1 |
| 2388299037 | translucent genericimage4 layer (E2) | B2 |
| 1797172968, 3419466417, 1155728109 | particle colorn tint (P5), sprite-sheet timing/blend (P8/P9) | B3 |
| two clock scenes, e.g. 1884904087, 2134765860 | text size, line layout, font (T10) | B4 |
| 2679248947 at rest + cursor moved; 2921510865 (clip) | depth parallax (E1/G12); camera shake (G16) | B5 |
| 3042492564, 3490034653 | camera-object zoom framing (G17) | B5 |
| 3163060610 or 3319542538; 3013489778 | hidden group hides children (G03); parent alpha (G05) | B6 |
| 3243449890, 2469881470 | rotation pivot with alignment (G31); `perspective` layer (G21) | B6 / B14 |
| 2883756643; 3414858021 or 3432999904 | blend modes (E27/E28); `copybackground:false` (E30) | B7 |
| 2134765860 (cursor near the emitter) | controlpointattract threshold (P28) | B11 |
| 3395587987 or 3019192537, WE at post-processing **Ultra** | HDR bloom (E35): glow only on what is brighter than 1 | B13 |
| any scene, a clip of its first second | `camerafade` (G23) | — |
| a 16:9 scene on an ultrawide or portrait output | crop vs letterbox, and whether `anchor` moves layers (G32, C5) | B5 |

**Decisions:**

- ~~**Media integration** (S11–S14, 19 scenes): feed WE's media events from MPRIS? Which player?~~ Decided in B10: the scene worker reads MPRIS (the playing player, else the first paused one).
- ~~**`engine.openUserShortcut`** (S21, 1 scene, Windows app launchers): ignore, or map to `xdg-open`?~~ Decided in B10: ignored (returns false).
- **`scenetexture` properties** (E40, 9 scenes): the UI file picker the TODO already lists.
- **The cursor behind windows** (C6): WE tracks the cursor everywhere. liascape sees it only over the bare desktop.
  Accept that, or poll the compositor (Hyprland IPC) for a global cursor?

## 1. Scene graph, objects, camera, 3D, puppet (G)

Scope: object transforms and hierarchy, property keyframe animation, puppet warp, camera (parallax, shake, zoom,
camera objects), 3D/perspective. LWE paths are relative to `src/core/WallpaperEngine/` in `~/.cache/liascape/src/lwe-dev`.
Scene counts cover all 96 scenes. "playing" means the 93 scenes that load; the 3 that fail to load are
3276522107, 3477054430 and 3509243656. Counts resolve user-property defaults from each scene's project.json.
The scripts that produced the counts are in `audit/work-scenegraph/` (`gen.py`, `obj.py`, `par.py`, `par2.py`, `mdl.py`).

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| G01 | Property keyframe animations (`alpha/origin/angles/scale.animation`) are ignored | **Observed**: the binding parser `FUN_1401d1740` reads `animation` → `options` (`mode`, `name`, `parent.key`; mode `"timeofday"` is special-cased) and `relative`. When `relative` is set, `c0..c2` are offset by `value`. Curves `c0..c3` go through `FUN_1401d4dd0`. Each keyframe is `frame` (int), `value`, `back`/`front` `{enabled,x,y}` bezier handles, and `step` (GH 0x1401d1740, 0x1401d4dd0). `lockangle`/`locklength`/`magic` are not read at runtime (editor only). **Documented**: `single` plays once and holds; `mirror` ping-pongs (docs …/timeline/modes.html). | `Data/Parsers/DynamicValueParser.cpp:14-23` reads only `value`/`user`/`script`. The `animation` key is never read, so the property stays at `value`. | 22 (20 playing): alpha 16, origin 11, angles 6, scale 2; 22 use bezier handles; 13 use `relative`. e.g. 1864677589, 2325974975, 3289734539 | Animated fades, moves and rotations are static | M: parse the curves and evaluate a cubic bezier per component on the scene clock. Apply `relative` (add) and the modes, then feed the DynamicValue each frame. |
| G02 | Animation options: `fps`/`length`/`mode`/`wraploop`/`startpaused`/`random`/`events` | **Observed**: `FUN_1401d5790` reads `length`, `fps`, `mode`, `random`, `startpaused`, `wraploop`. `FUN_1401d4d00` sets the flag bits: mirror 1, single 2, random 4, wraploop 0x10, startpaused 0x20000000. With wraploop, `FUN_1401d5990` appends a wrap keyframe at `length` (GH 0x1401d5790, 0x1401d4d00, 0x1401d5990). SceneScript `getAnimation(name)` controls named tracks (Documented: ILayer page). | None (see G01). | startpaused 7, wraploop 9, named 5, events 1 (3163060610), single 12 | `startpaused` tracks that a script `play()`s never start; events never fire | S on top of G01; script side is SceneScript's |
| G03 | A hidden parent does not hide its children | **Observed**: `FUN_1401b50e0` is "effectively visible": the object's visible bit (+0x120 bit 0) AND, recursively, its parent's (parent ptr +0x180). About 15 render/update sites call it (ev_0e4f5eb3…, GH 0x1401b50e0; parent ptr from `getParent` = `mov rdx,[rcx+0x180]` asm 0x14020d915). | `Render/Objects/CImage.cpp:922` and `:862` test only the object's own `visible`. CText and CParticle never look at a parent. | 12 playing scenes have a visible child (image 11, text 7, particle 3) under a hidden ancestor (resolved default). e.g. 3042492564, 3163060610, 3319542538 | Layers that should be hidden draw on screen (wrong picture) | S: walk the parent chain in render() of image, text and particle |
| G04 | Text and particle objects ignore `parent` (transform) | **Inferred**: a child's origin is parent-local. Every object type shares one base table with `setParent`/`getParent`/`getChildren`/`getTransformMatrix` (GH 0x14020dcc0), and the data agrees (text children sit at origins like (81,-147) under a parent at (3200,1320)). LWE's own `CImage::resolveTransform` assumes local origins. | `Render/Objects/CImage.cpp:99-156` resolves the chain for images only. `CText.cpp:408` uses the raw local origin. `CParticle.cpp` has no parent handling. | 19 (text children 18, particle children 11; 290 objects). e.g. 3013489778, 3163060610, 3480481965 | Clocks, music titles and particle emitters land near the bottom-left (misplaced) | S: move `resolveTransform` to CObject and use it in CText and CParticle (upstream PR #625 did this for text) |
| G05 | Parent alpha is not inherited | **Unknown**: a bounded search found no parent read next to the image alpha (+0x33c) | No inheritance (`CImage::getAlpha` at `CImage.cpp:963`) | 11 playing scenes have children under an ancestor whose alpha ≠ 1 or is animated/scripted. e.g. 3013489778, 3289734539, 3319542538 | If WE inherits alpha, children are too opaque | ? (needs a WE check) |
| G06 | **(Fixed by B12, patch 0054; see "B12 result".)** Puppet warp: no skeletal animation | **Observed**: the model/puppet class table `FUN_14024da50` has `rootmotion`, `getAnimationLayer(Count)`, `createAnimationLayer`, `playSingleAnimation`, `destroyAnimationLayer` (GH 0x14024da50). The exe knows sections `MDLV0023`/`MDLS0004`/`MDLA0006`/`MDLE0002`. **Documented**: animation mixing, blend rules, IK, bone constraints, blend shapes (docs …/puppet-warp/*). | `Data/Parsers/ObjectParser.cpp:295-305` parses `animationlayers` (id, rate, visible, blend). Nothing reads them. `CImage.cpp:413-511` loads the MDLV mesh as a static bind-pose mesh. No MDLS/MDLA parsing and no skinning. | 14 have a puppet mesh; 11 have `animationlayers`. e.g. 2375914945, 3233141951, 3463520581 | Characters are frozen: no breathing, hair or arm motion | L: MDLS bones, MDLA tracks, CPU or GPU skinning (4 weights). Upstream PR #625 (closed, unmerged) did a single layer. |
| G07 | **(Fixed by B12, patch 0054; see "B12 result".)** Older puppet MDLV versions are rejected | **Observed**: the exe accepts the MDL family (strings above). Library files carry MDLV 0013/0016/0017/0019/0021/0023. | `CImage.cpp:430` accepts only `MDLV0021`/`MDLV0023` with an 80-byte stride. Any other version logs an error and falls back to the plain texture quad. | 7: 2375914945 (0013), 2679885269 (0013), 3013489778 (0019), 3022080536 (0016), 3042492564 (0017 ×9), 3233141951 (0019 ×4), 3243449890 (0019) | Puppet layers draw as the raw texture/sprite sheet (unassembled) where the mesh differs from the quad | S–M: per-version vertex stride (PR #625 found 0013 = 52 B stride) |
| G08 | **(Fixed by B12, patch 0054; see "B12 result".)** Animation-layer mixing (`additive`, `blend`, `rate`, multiple layers, `blendin/out/time`, bound `visible`) | **Documented**: puppet-warp/animationmixing.html, blendrules.html. Runtime fields Unknown beyond the parsed keys. | Parsed partly (`ObjectParser.cpp:298-304`), unused. `additive`, `blendin`, `blendout` and `blendtime` are not parsed. | additive 7, >1 layer 7, bound visible 5, user-bound rate/blend 2/1 | Wrong or missing motion once G06 exists | M (after G06) |
| G09 | **(Fixed by B12, patch 0054; see "B12 result".)** `attachment` (child pinned to a puppet bone) is ignored | **Documented**: ILayer `setParent(parent, attachment)`, `getAttachmentMatrix/Origin/Angles`. **Observed**: strings and the base-table methods (GH 0x14020dcc0). | Not parsed. The child follows the parent origin without the bone offset. | 3: 3363252053, 3414858021, 3463520581 | Attached parts drift off the character | M (needs G06 bones) |
| G10 | Parallax `cameraparallaxdelay` is used as a bool, which freezes parallax | **Observed** (camera update `FUN_1401b8af0`): when delay ≤ 0 the position snaps to the target. Otherwise `k = min(1, (1 − delay/3) · 10 · dt)` and `pos += (target − pos)·k` (constants 3.0 @0x1404d43a8, 10.0 @0x1404d43f0; GH 0x1401b8af0). | `Render/Wallpapers/CScene.cpp:315-321`: `min(float(delay->getBool()), dt)`. `getBool()` of 0.1 is false (`Data/Model/DynamicValue.cpp:94` casts to int), so k = 0 and the displacement never moves. With delay ≥ 1, k = dt. | Of 25 parallax-on scenes, 14 have delay < 1 (0.1 ×10, 0.3 ×2, 0.04, 0.94), so parallax is dead. The other 11 (delay 1–2) move, with the wrong smoothing. | No mouse parallax in 14 scenes | S: use the WE formula |
| G11 | Parallax target is not centred; mouse influence and y semantics differ | **Observed** (GH 0x1401b8af0): `target.x = W·(0.5·(1−infl) + mx·infl) + cam.x` and `target.y = H·(0.5·(1−infl) + (1−my)·infl) + cam.y`. `mx`/`my` are clamped 0..1. infl = `cameraparallaxmouseinfluence`, or 0 when some context flags `0x200200` are set. x is mirrored when a context flag (0x800) is set. | `CScene.cpp:320`: `disp = lerp(disp, mouse·amount·infl)` with mouse = px/size in 0..1, y down (`CScene.cpp:388-389`, the player's pointer is "y down"). A cursor at screen centre gives a constant offset of `(depth+amount)·0.5·amount·infl·W` (`CImage.cpp:1124-1126`). | 24 (25 minus influence 0 in 1556245028); visible today in the 11 with delay ≥ 1 | Layers sit off-centre and shift in the wrong direction or by the wrong amount; borders show | S |
| G12 | Per-layer `parallaxDepth` formula: depth 0 still moves | **Documented**: depth 0 turns parallax off for that layer; X or Y = 0 locks that axis (…/parallax/introduction.html). **Unknown**: WE's exact per-layer offset. **Inferred**: proportional to `depth · amount · (pos − 0.5)`. | `CImage.cpp:1124-1125` and `CParticle.cpp:1874-1876` use `(depth + amount)·disp·W`, so depth 0 moves by `amount` and the amount is applied twice | 17 of 25 parallax scenes have depth-0 layers (e.g. 3184155462: 12 of 15) | "Fixed" layers (UI, frames) wobble; depth ratios are wrong | S |
| G13 | Text objects never parallax | Inferred: WE gives every object `parallaxDepth` (base table GH 0x14020dcc0) | `TextData` has no `parallaxDepth` (`Data/Model/Object.h:600-625`). CText ignores parallax. | 13 parallax scenes contain text with depth ≠ 0. e.g. 2951169110, 3163060610 | Text slides relative to the image it sits on | S (handoff: lead/text) |
| G14 | `g_ParallaxPosition` shader uniform is missing | **Observed**: GH 0x1401b8af0 writes `ctx+0x9c/0xa0 = clamp(smoothedPos/W, 0, 1)` (the smoothed parallax, not the raw cursor). The uniform setter GH 0x14010a0e0 binds it to `g_ParallaxPosition` (enum 0x72, GH 0x140002a20). | Not in `Render/Objects/Effects/CPass.cpp:859-881`, so the uniform reads 0 and `prlxInput = 0·2−1 = −1`. | 11 scenes ship shaders using it (depthparallax effect). e.g. 2679248947, 3243449890, 3354740764 | Depth-parallax effect is stuck at a corner offset with no motion | S (handoff: effects) |
| G15 | Parallax enable checked as a pointer and not toggled live | Observed: WE reads the `cameraparallax` bit (+0xe0 0x100) every frame (GH 0x1401b8af0) | `CImage.cpp:1118` and `CParticle.cpp:1857` test the `UserSettingUniquePtr`, which is always true. When disabled, `CScene.cpp:311` stops updating, so the last offset sticks. | 8 bind `cameraparallax` to a user property | Turning parallax off leaves layers displaced | S |
| G16 | Camera shake is not implemented | **Observed**: general table (GH 0x1401c7880) has `camerashake` (bool), `camerashakespeed` +0x2e8, `camerashakeamplitude` +0x2ec, `camerashakeroughness` +0x2f0. **Unknown**: the shake algorithm (not located). | Parsed (`Data/Parsers/WallpaperParser.cpp:60-65`). Only SceneScript getters read it (`Scripting/SceneObject.cpp:88-109`). | 10 on (8 playing): 2542468435, 2672425887, 2921510865, 3019192537, 3354740764, 3463520581, 3480481965, 3490034653 (+3276522107, 3477054430) | Static camera where WE sways | M (needs the algorithm; noise offset on the view at speed/amplitude/roughness) |
| G17 | Camera objects (`"camera":"default"`: zoom, fov, scripted origin pan, `path`, `queuemode`) are ignored | **Observed**: the factory makes a camera object for a `camera` key (GH 0x1401be650). Its table has `visible`, `fov` +0x2d8, `zoom` +0x2dc, `queuemode` +0x350 (GH 0x14021e8b0). The camera update walks path lists (+0x2d0, index +0xe4) (GH 0x1401b8af0). **Inferred** (user-property labels): zoom and origin pan the 2D view: "Zoom (lossless)" g_zoom 0.73–1, "Lens size" 0.1–2. Every corpus `camera_paths_*.json` has `paths: []`. | `Data/Parsers/ObjectParser.cpp:86-95` returns a placeholder. `CScene.cpp:249` builds an empty CObject. | 11 (8 playing). Default zoom ≠ 1 in 3042492564 (0.73), 3479521040 (0.75), 3490034653 (0.65), 3516174947 (0.75). Scripted pan in 3042492564, 3163060610, 3326873240, 3363252053, 3414858021, 3516174947. | Wrong framing (zoom and pan); the zoom/offset user sliders do nothing | M: apply the camera object's zoom and origin to the view projection |
| G18 | `general.zoom` is ignored | **Observed**: general table `zoom` +0x154 (GH 0x1401c7880, name at 0x1404d014c). **Inferred**: it scales the view. | Not parsed (`WallpaperParser.cpp:24-83`) | 6 ≠ 1 (1.01–1.14): 2683776412, 3319542538, 2828233985, 2890767643, 2921510865, 2951169110. 2388299037 binds it to a user property. | Scene up to 14% less zoomed (edges show more) | S |
| G19 | `nearz`/`farz`/`fov` are read from `camera` instead of `general` | **Observed**: they are `general` fields: fov +0x140, nearz +0x14c, farz +0x150. The effective fov is clamped 0.1–179.9 (+0x148, GH 0x1401b8af0). | `WallpaperParser.cpp:75-77` reads `camera.user("nearz"…)`, so the defaults 0 / 1000 / 50 apply | 91 have them in `general` (fov 50 in 90, 42.43 in 3477054430) | None in 2D today. Wrong for 3D (G24) and any perspective use | S |
| G20 | `perspectiveoverridefov` is ignored | **Observed**: general +0x144 (GH 0x1401c7880). **Unknown**: its use. **Inferred**: FOV for perspective layers. | Not parsed | 42 (90 ×15, 95 ×14, 30 ×13) | Unknown until G21 | S |
| G21 | Image `perspective` flag is ignored | **Observed**: an image-table bit at +0x120 (GH 0x140219c60). **Unknown**: how it renders. | Not parsed | 4: 2469881470, 3354740764, 3422085307, 3479521040 (all flat: angles 0, z 0) | Likely small for flat layers (depth moves under parallax/camera) | M |
| G22 | Image `angles.x/y` (3D tilt) and `origin.z` are ignored | Inferred: WE has full 3-axis `angles` (base table +0x134, vec3) | `CImage.cpp:107` uses only `.z`. Vertices are written with z = 0 (`CImage.cpp:1025-1027`). | 1 playing (3219908811: tilt ±0.349 rad, z −333); +3 failing | Tilted card appears flat | M (with G21/G24) |
| G23 | `camerafade` is not implemented | **Observed**: a general-table bool (GH 0x1401c7880). **Unknown**: its behaviour. | Parsed (`WallpaperParser.cpp:47`), only a script getter | 92 true, 4 false | Unknown (likely a fade-in at start or on transitions) | ? |
| G24 | 3D scenes do not load | **Observed**: `orthogonalprojection` may be absent or null. The exe flags an ortho scene only when it is present (GH 0x14013f860, flag 0x20). A perspective camera comes from `camera.eye/center/up` plus general `fov/nearz/farz`. | `WallpaperParser.cpp:28-29,72-73` requires `orthogonalprojection.width/height`. The scene throws "Projection must have a width". | 3: 3276522107, 3477054430, 3509243656 | Black / not played | L (see Notes) |
| G25 | Model objects (`"model":"models/x.mdl"`): static meshes with `generic4` PBR shading | **Observed**: `model` is the first type the factory tries (GH 0x1401be650). The assets' `generic4.vert/.frag` need `a_Normal`, `g_ViewProjectionMatrix`, `g_EyePosition`, combos LIGHTING/FOG/REFLECTION/SKINNING/MORPHING, the shadow atlas `_rt_shadowAtlas`, the cookie `_alias_lightCookie`, `_rt_MipMappedFrameBuffer`. | Not handled. `ObjectParser.cpp:74` checks `image` first; a `model` object has `image: null`, so it falls through to the placeholder. | 2 (both failing): 3477054430 (5 meshes MDLV0023), 3509243656 (9 meshes, 0016/0023) | Missing 3D geometry | L |
| G26 | Light objects (`light: "lspot"`, `general.lightconfig {spot:4}`) | **Observed**: factory branch `light` (GH 0x1401be650). The shader uniforms `g_LightsColorPremultiplied`, `g_LightsPosition` exist (GH 0x140002a20). | `ObjectParser.cpp:82-83` logs "Light objects are not supported yet" | 1 (3477054430, 4 spots: cone, radius, intensity, volumetrics) | Unlit 3D | L (part of G24) |
| G27 | Shape objects (volumetric light quad, `"shape":"quad"`) | **Observed**: factory branch `shape` (GH 0x1401be650) | `ObjectParser.cpp:84-85` logs "VolumeLight … not supported" and skips it | 1 playing: 3319542538 ("Rayons lumineux", user-toggled) | Light rays missing | M |
| G28 | Fog (`fogdistance*`, `fogheight*`) | **Observed**: general table fog fields +0x344…+0x378 (GH 0x1401c7880). `common_fog.h` is used by generic4. | Not parsed | 2 (both failing: 3276522107, 3477054430) | Part of G24 | S–M |
| G29 | `transparentsorting` / `customsortorder` / per-object `sortorder` | **Observed**: general bools and a base-table `sortorder` int (+0x170, GH 0x14020dcc0) | Render order = file order, with dependencies hoisted (`CScene.cpp:268-301`) | transparentsorting 2 (both failing). sortorder/customsortorder: 0 | Part of G24; none in 2D | S |
| G30 | Text rotation (`angles`) is ignored | Inferred: shared base `angles` | CText registers no angles. The quad is built from origin/scale only (`CText.cpp:340-413`). | 16 (literal z ≠ 0 or scripted). e.g. 2047150134, 3219908811 | Rotated text draws upright | S (handoff: lead/text) |
| G31 | Rotation pivot for non-centre `alignment` | **Unknown**: WE pivot. **Inferred**: the origin (anchor point). | `CImage.cpp:1109-1111` rotates about the quad centre after the alignment shift | 3: 3243449890, 3326873240, 3414858021 | Rotated aligned layers are displaced | S (once confirmed) |
| G32 | `anchor` (text/image screen anchoring) is ignored | **Unknown**: semantics. **Inferred**: it re-positions on aspect change. | Not parsed | 7 non-`none` (center 6, bottomleft 1). e.g. 2890767643 | Only when the output aspect ≠ the scene aspect | S |
| G33 | `copybackground` image flag | **Observed**: an image-table bit (+0x304, GH 0x140219c60). **Unknown**: how it renders. | Not parsed | 49 true on images, 14 on text | Unknown (handoff: effects/compose) | ? **Done in B7**: flag 0x40, default true; see E30. |
| G34 | `instance` (combos/version, `instanced` models) only half-applied | **Unknown** | `ObjectParser.cpp:187-204` merges `instance.textures/usertextures` into the first pass. `instance.combos` and `id` are dropped. | 13. e.g. 2932157836, 3013489778 | Likely none (combos only carry `version: 2`) | S |

### Notes

- **Hierarchy, observed.** The parent pointer is +0x180 and the children vector +0x198..+0x1a0 (`getParent` is asm
  0x14020d910). `FUN_1401b50e0` (ev_0e4f5eb3…) gates visibility recursively. `disablepropagation` is base-table bit 0x8000
  of +0x120 and `solid` is bit 0x4000 (GH 0x1401c9b40, 0x1401c9970). What `disablepropagation` stops was not found. It is
  false in all 12 scenes that carry it.
- **What image transforms get right.** LWE recomputes image transforms every frame from the parent chain
  (`CImage.cpp:1101-1135`), so animated or scripted parent origin/scale/z-angle work for image children. Negative scale (a
  flip, 22 scenes) inverts the quad and probably matches WE.
- **Parallax evidence.** `FUN_1401b8af0` is the scene camera update. In order, it:
  - advances the camera path (+0xe4/+0xe8, list +0x2d0);
  - clamps the fov at +0x148 to 0.1..179.9;
  - smooths the parallax target into +0x300/+0x304;
  - publishes `g_ParallaxPosition`;
  - copies the camera origin (+0xf0) to the context;
  - builds the view (`FUN_1401cb340`).

  In it, `fVar17` = 1.0 (0x1404d4238), the centre weight = 0.5 (0x1404d41b8), and W/H = +0x318/+0x31c (ortho size).
  `cameraparallaxamount` (+0x2f4) and the per-layer depth are applied elsewhere and were not located, so the G12 formula is
  inferred. The project classifier `FUN_14013f860` marks a scene mouse-interactive only when `cameraparallax` is on and
  `mouseinfluence` ≠ 0.
- **Lead's figure.** Lead's "16 of 25 have delay < 1" ≠ my 14. I resolved user-bound values from project.json:
  3219908811's `miku`-bound delay resolves to 1, and 3363252053/3414858021 to 2. Both counts agree that most parallax
  scenes are dead.
- **Camera `eye` pans are cancelled.** 21 2D scenes have `camera.eye/center` panned (e.g. 3042865984 by −1458,−467). LWE
  cancels them (`Render/Camera.cpp:13,50`: `ortho·translate(eye)·lookAt(eye…)` = identity in xy). Published scenes look
  centred, so **Inferred**: WE ignores this editor camera in 2D. Not a gap row.
- **Keys with no visible effect in 2D (not rows):**
  - `locktransforms` (61) is editor-only (Inferred).
  - `ledsource` (3) drives RGB hardware.
  - `castshadow` matters only with lights.
  - `solid` is cursor hit-testing (lead/SceneScript).
  - `config.passthrough` (11): every one is on `models/util/composelayer.json`, which already has `passthrough: true`.
  - `clearenabled` is true or null in all scenes. `clearcolor` is applied once at `CScene.cpp:86-88` and none is bound.
  - Model-json `cropoffset` (32) is editor metadata according to PR #625. `autosize` is a TODO (`CImage.cpp:213`); it matters
    for animated puppets (PR #625 grows the canvas).
  - `dependencies` (4): LWE hoists a dependency ahead in render order. Only 3509243656 (failing) has a dependency later
    in the list, so nothing changes in playing scenes.
- **Upstream PR #625** (Almamu/linux-wallpaperengine, closed and unmerged, 2026-07-08 → 10-25, +715/−120). It adds:
  - MDLV v0013 (52 B) and v0021/23 (80 B) layouts, MDLS v1/v3 bones, MDLA v1/v6 tracks;
  - CPU skinning with 4 weights and a single animation layer by id/rate/visible, with skinned z flattened to 0;
  - `autosize` canvas growth, and `resolveTransform` moved to CObject for text parents.

  It leaves out layer blending/additive, cloth, IK and blend shapes. Our corpus also has MDLV 0016/0017/0019, MDLS 0002/0004,
  MDLA 0003–0005 and MDLE0002 (blend shapes?), which the PR does not mention.
- **What the 3 failing scenes need (G24 estimate).** Common to all: a perspective projection from `camera.eye/center/up`
  and general `fov/nearz/farz`, with `orthogonalprojection` made optional. Then:
  - **3276522107:** 11 image layers placed in 3D (origin z up to 12.7, size 1358–3840), fog, `transparentsorting`, camera
    shake, bloom, 6 particles, a fullscreen post layer. No meshes. It is the cheapest: about M once perspective image
    layers and depth sorting exist.
  - **3477054430:** 5 static MDLV0023 meshes with `generic4` (lit PBR, normal/PBR maps), 4 spot lights (cone, radius,
    volumetrics, shadow atlas), fog, a camera object, and a user-bound camera shake.
  - **3509243656:** 9 meshes (skyboxes ~2.9 MB each, a 28 MB sphere) with `generic4`, HDR + bloom, `solidlayer_depthtest`,
    `transparentsorting`, and heavily scripted origins (`input.cursorWorldPosition`).
  - **Total:** L, several weeks. Perspective camera + 3D image layers + depth/transparent sort (M). MDLV static mesh loader
    + `generic4` unlit/lit with ambient/skylight (M–L). Lights + shadow atlas + fog + volumetrics (L). Without lights the
    meshes render unshaded.

## 2. Effects, materials, shaders, render pipeline (E)

Method. Every scene's objects were resolved (scene.json → model → material → shader; effect.json → pass
materials → shaders; pkg first, then WE `assets/`), giving 96 scenes, 82 with image effects. For each material pass
the vertex and fragment units (includes inlined) were run through a real C preprocessor with the defines LWE would
set: material and scene-pass `combos`, the `[COMBO]` defaults, texture-slot combos and `GLSL=1`. A `g_*` name that
survives preprocessing outside its declaration counts as **active**. The scene counts below are for active use, not
for mere declaration. WE's engine-fed uniform set is the name→id table in `FUN_140002a20` (GH 0x140002a20). The
per-draw upload switch is `FUN_14010a0e0` (GH 0x14010a0e0, `switch(id)`), where the case numbers are those ids.
Scripts and data: `$S/audit/work-effects/{resolve,active,uniforms,ann,alpha,varying}.py`, `active.txt`,
`uniforms.txt`. LWE paths are relative to `src/core/WallpaperEngine/`.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| E1 | `g_ParallaxPosition` not fed | **Observed** id 0x72: vec2 from the draw context (+0x9c), uploaded every draw (GH 0x14010a0e0 case 0x72). **Documented** "Normalized parallax offset of current layer" (docs.wallpaperengine.io/en/scene/shader/variables.html). Shaders read it as 0..1 with 0.5 = centre (`prlx*2-1`, `x-0.5`) | never registered (CPass.cpp:855-893), so it reads 0 | 9: 2679248947, 3019192537, 3029971128 (depthparallax ×9 incl. workshop copy, clipping_mask in 3243449890) | depthparallax is static and also shifted, as if the cursor sat in a corner; the clipping_mask mask is offset by (−0.25, +0.25) | S: feed 0.5 + the camera parallax displacement, per layer with its parallaxDepth (exact formula Unknown) |
| E2 | `g_Color4.w` is not the image alpha | **Observed** case 2: `g_Color4 = (ctx+0x124, +0x128, +0x12c, ctx+0x120)`, i.e. `(g_Color.rgb, g_Alpha)` (cases 0/1 read the same fields) | `g_Color4` = the `color` DynamicValue as vec4. ColorBuilder sets alpha 1 (CImage.cpp:967, CPass.cpp:866) | 84 use g_Color4 (genericimage3/4 always, genericimage2 with `VERSION`); 30 of them have an image `alpha` ≠ 1: 2371103399, 2388299037, 1864677589 | layers that WE draws translucent, or fades in and out, are drawn fully opaque | S: build `vec4(color, alpha)` |
| E3 | Object uniforms frozen at setup | **Observed** cases 0/1/2 copy alpha and colour from the draw context on every draw | `g_Alpha`, `g_UserAlpha`, `g_Brightness`, `g_Color`, `g_Color4` and `g_CompositeColor` are passed as `const T&` and bind the by-value overloads (CPass.h:134-141), so `new T(value)` stores a copy (CPass.cpp:862-868) | 22 with a dynamic image alpha (animation, user or script), 22 with a dynamic colour; e.g. 1864677589, 2325974975, 3163060610 | alpha and colour animations, property changes and SceneScript writes never reach the shader (effect constants are pointer-bound, so they do stay live) | S: register pointers (`&getAlpha()` etc.) |
| E4 | `g_PointerState` not fed | **Observed** case 0x71: `.xy` = 1 while the button is down, `.z` = 1 on a down without flag bit 1 (pressed edge, Inferred), `.w` = 0 | not registered, so it reads 0 | 1: 3184155462 (cursorripple) | clicks inject no ripple | S |
| E5 | `g_Frametime` not fed | **Observed** case 4 (ctx+0x14c). **Documented** "Current frametime in seconds" | not registered, so it reads 0 | 1: 3184155462 | cursorripple's `timeAmt = min(1/30, g_Frametime)/0.02` = 0: no ripples at all, and the decay stalls | S: feed renderTime − renderTimeLast |
| E6 | `g_EffectTextureProjectionMatrix(Inverse)` is identity | **Observed** cases 0x17/0x18: a per-draw matrix at ctx+0x9f0. **Documented** "transform an effect vertex position into texture projection space" | constant `mat4(1)` (CPass.cpp:883-884) | 12: 2679248947, 3184155462, 3414858021 (depthparallax, cursorripple, iris_movement, dithering, halftone) | screen-space cursor → layer-UV mapping (`mul(pointer*2-1, inv)`) is right only for an unrotated layer that fills the screen. On other layers the cursor effect lands in the wrong place | M: build from the layer's screen MVP |
| E7 | `g_EffectModelViewProjectionMatrix` = the pass MVP | **Observed** case 0x15: its own matrix (ctx+0x9b0), separate from MVP (case 0xc, ctx+0x8f0). **Documented** "effect vertex position into world view projection space" | aliased to the pass MVP: ortho/identity in FBO passes, screen only on the last pass (CPass.cpp:876) | 4: 3042865984, 3354740764, 3419466417 | screen-coordinate lookups (COPYBG, dithering, halftone, dot_matrix) are misaligned in intermediate passes | M |
| E8 | Audio spectrum `Right` = `Left` | **Observed** cases 0x69-0x6e: Left = first half and Right = second half of separate 16/32/64 buffers (e.g. 0x6a reads +0x40..0x80) | both Left and Right get `recorder.audio16/32/64`, the same array (CPass.cpp:887-892) | 34 reference Right: 1556245028, 2134765860, 2388299037 | stereo visualizers become mirror-symmetric; nothing else changes (audio area owns the FFT) | M: stereo FFT |
| E9 | `g_TexelSize`/`Half` scale | **Observed** cases 6/7: `const / ctx+0x74` (vec2). The same field is `g_Screen.xy` (case 8). **Documented** "size of a screen pixel … (1/1920, 1/1080)" | `1/scene projection size`, frozen (CPass.cpp:885-886) | 11: 2134765860, 2883756643, 3013489778 (bokeh/gaussian/sharpen/dithering) | when the scene resolution ≠ the output resolution (e.g. 4K scene on 1080p), blur and sharpen kernels differ by that ratio | S (whether ctx+0x74 is the output or the current RT size: **Unknown**; its writer still not found, "Decode leftovers result") |
| E10 | `g_Screen` not fed | **Observed** case 8: `(w, h, w/h)` | not registered | 0 active (REFLECTION+NORMALMAP only) | none | S |
| E11 | `g_LayerModelMatrix` not fed | **Observed** id 0x19 (table). **Documented** "transform between layer local space and world space" | not registered: zero matrix | 1: 3516106265 (frame_builder_by_gariam) | `right`/`up` vectors = 0: frame geometry degenerate (Inferred) | S **Done (0100)**: the layer's world matrix (GH 0x1402176a0 copies image +0x384, the draw's model matrix) |
| E12 | `g_ModelViewProjectionMatrixInverse` in effect passes | **Observed** case 0xd: inverse of the ctx MVP. Its value inside effect passes: **Unknown** | identity in FBO passes, screen inverse on the last pass (CImage.cpp:815-847) | 5: 2469881470, 2815800031, 3479521040 (chromatic_aberration, lens_flare_sun) | the cursor-anchored centre may be off (unverified) | — |
| E13 | Lights / `LightingV1` | **Observed** ids 0x64-0x68 and 0x86-0x95 (g_LightsPosition, g_LightsColorPremultiplied, g_LCluster_*, g_LDirectional_*); `LIGHTING` and `LIGHTS_*` defines in the binary strings | `#require LightingV1` → a stub returning 0 (ShaderUnit.cpp:336-379); light uniforms are not fed; ambient/skylight are frozen copies (CPass.cpp:859-860) | 0 of the loadable scenes (LIGHTING=1 only in 3D 3276522107, 3509243656) | none today; blocks the 3D work | L |
| E14 | Fog | **Observed** `FOG_DIST`, `FOG_HEIGHT`, `FOG_COMPUTED` defines and g_Fog* ids 0x81-0x84 | not parsed or fed | 0 loadable (general.fogdistance only in 3D 3276522107, 3477054430) | none today | M |
| E15 | Per-slot texture uniforms > 0 | **Observed** g_Texture0-9 {Rotation, Translation, Texel, MipMapInfo} (ids 0x2b-0x5c) | only `g_Texture0Rotation`/`Translation` (CPass.cpp:690-691); `Texel`/`MipMapInfo` never fed; samplers only 0-7 (CPass.cpp:826-833) | 0 active | none | S |
| E16 | `g_TextureReductionScale` | **Observed** id 0x5d, fed per draw (value Unknown; Inferred 1 at full texture quality) | constant 1.0 (CPass.cpp:834) | 1: 3243449890 (skew) | none expected | — |
| E17 | Float uniform default given as a string | **Inferred** parsed as float (WE's editor shows 0.1) | `std::stoi("0.1")` = 0 (ShaderUnit.cpp:520) | 25 reference it; the default actually applies (no scene override) in ~5: 2890767643, 3028473503, 3432876246, 3013489778, 3042865984 | Simple_Audio_Bars spacing 0 (bars merge), cutout_vignette hard edge, dot_matrix size/smoothing 0 | S: `stof` |
| E18 | Malformed `[COMBO]` JSON | **Unknown** (WE's annotation parser may be lenient) | JSON parse error is logged and the combo is skipped, so its default is never defined (= 0) (ShaderUnit.cpp:444-449) | 5: 3243449890, 3414858021, 3516174947 (auto_sway `VERTICAL_RELATIVE_WIDTH` def 1), 2388299037, 3354740764 (procedural_noise `AD_PERSPECTIVE` def 1) | the combo branch flips unless the scene sets the combo | S: lenient parse / regex for `"default"` |
| E19 | Fragment uses a varying declared only in the vertex unit | **Unknown**/**Inferred**: WE compiles it (the scene works in WE), probably by building the PS input from the VS varyings | GLSL error, so the effect is left out (patch 0017) | 1: 2189783622: the effect lost is the packaged **foliagesway** (`v_Bounds`, frag line 51), not godrays as the TODO note says | foliage sway missing | S: copy VS-only `varying` decls into the frag unit |
| E20 | `TEXnFORMAT` for samplers ≠ 0 (`formatcombo`) | **Observed** `TEX0FORMAT` built in GH 0x1401fffb0; the other slots are **Inferred** from `"formatcombo":true` and `TEX1/2/4FORMAT` in shaders | only `TEX0FORMAT` for the renderable's texture (CPass.cpp:606-612) | 1: 3319542538 (lightshafts gradient r8, `TEX2FORMAT`) | an r8 gradient is read as RGBA (red tint), only when `RENDERING=1` | S **Done (0075)**: per bound texture (GH 0x1401d2a20) |
| E21 | Engine-set defines | **Observed** strings and uses: `SKINNING`/`BONECOUNT`/`MORPHING`/`PRELIGHTING`/`REFLECTION` (GH 0x140230ec0), `SHADERVERSION` (GH 0x14019cb90), `WRITEALPHA`/`OPACITYMASK` (GH 0x140201470), `HDR`, `REVERSEDEPTH`, `SPRITESHEETBLEND`, `CLIPPINGUVS`/`CLIPPINGTARGET` | only `GLSL 1` plus combos (ShaderUnit.cpp:21-51) | puppet objects in ≥ 4 scenes (77 puppet-model objects); the rest 0 active | puppet warp isn't skinned (puppet area owns it); `HDR` blocks affect EMISSIVE only (0) | M-L |
| E22 | `[COMBO]` / sampler `require` | **Observed** WE writes `require` in its own stock shaders (an editor and compile rule) | ignored for combos (ShaderUnit.cpp:442); the sampler-require logic looks inverted (ShaderUnit.cpp:553-590) | 0 (no used annotation has combo+require+default) | none today | S |
| E23 | FBO `format` ignored | **Observed** formats in effect.json: `rgba_backbuffer` (Inferred 16F when HDR), `rgba8888`, `rg88`, `r8` | always GL_RGBA8 (FBOProvider.cpp:9-16, CFBO.cpp:20) | rgba_backbuffer 38, rg88 5, r8 1 | precision loss in HDR scenes only (see E35) | S. **Done (B13)**: CFBO allocates the named format (rg88 RG8, r8 R8, the f formats half float); `rgba_backbuffer`/`rgb_backbuffer` are half float in an HDR scene (GH 0x140216080, names GH 0x1402116c0) |
| E24 | FBO `fit` / `width` / `height` / `uvs` ignored | **Observed** keys in stock effects (glitter: 256×256 r8 `uvs:repeat`; cursorripple `fit:512`) | parseFBOs reads name/format/scale/unique only (EffectParser.cpp:99-115); size = image size / scale; wrap taken from the image texture's flags | 2: 3445973124 (glitter), 3184155462 (cursorripple) | glitter tiles stretched (no repeat, wrong size); cursorripple simulates at layer resolution | S |
| E25 | Effect pass `"compose": true` ignored | **Observed** parsed: sets pass flag 0x200000000 and increments a compose counter (GH 0x1402131b0); semantics **Unknown** (old-format two-pass effects without binds) | not parsed (EffectParser.cpp:48-75) | 5: 2511663284, 2672425887, 2890767643 (+1 blurprecise, 3042865984 refraction) | old blurprecise / refraction may sample the wrong input in pass 2 | M (needs RE) |
| E26 | Pass `command:"swap"` | **Observed** `copy`=1, `swap`=2 (GH 0x1402131b0) | copy only (CImage.cpp:674) | 0 (copy in 3: motionblur) | none | S |
| E27 | `_rt_FullFrameBuffer` is the live scene target | **Inferred**: D3D11 cannot sample a bound RT, so WE must copy before sampling | `_rt_FullFrameBuffer` *is* the scene FBO (CWallpaper.cpp:245-249). A last pass that samples it (genericimage3 `BLENDMODE` g_Texture4) while drawing into it is a GL feedback loop (UB) | 28 with `colorBlendMode` > 0: 1864677589, 2371103399, 2883756643; plus COPYBG (1) | blend-mode layers may sample garbage or partly updated texels, which shows as noise or wrong blend colour (driver-dependent) | M: copy the scene FBO into a separate texture before such passes **Done in B7, now Observed**: WE copies `_rt_FullFrameBuffer` before the image or first pass that reads it (GH 0x140214b50; particles GH 0x14025bc30); a pass sampling its own target reads a copy. |
| E28 | `colorBlendMode` path | **Observed** an image property (table GH 0x140219c60); how it is applied is **Unknown** | appends an extra `effectpassthrough` (genericimage3) pass with `BLENDMODE=n`; the first pass's blending moves to the last pass (CImage.cpp:758-783) | 28 (values 1, 4, 6, 7, 8, 11, 12, 14, 20-25, 29-31) | blend result not verified; needs a WE capture | — **Done in B7**: mode 31 = additive last draw, no BLENDMODE pass (GH 0x140211f90, 0x140214b50); other modes read the copy (E27). Still no WE capture. |
| E29 | `_rt_MipMappedFrameBuffer` has no mips | **Observed** name + `g_TextureNMipMapInfo` ids | an alias of the full framebuffer, no mips, MipMapInfo not fed (CWallpaper.cpp:249) | 0 active (REFLECTION+NORMALMAP) | none | S |
| E30 | `copybackground:false` ignored | **Observed** image property `copybackground` (GH 0x140219c60); semantics **Unknown** | ignored; a compose layer always samples `_rt_FullFrameBuffer` (materials/util/composelayer.json) | 2: 3414858021, 3432999904 | the layer may show the background where WE shows nothing | S once the semantics are known **Done in B7, Observed**: a passthrough layer draws its subtree into itself, after a background copy (true) or a clear (false), and with false its last draw is translucent (GH 0x1402321d0, 0x140218260). |
| E31 | Image `clampuvs` ignored | **Observed** image property `clampuvs` (GH 0x140219c60) | wrap comes only from the .tex header flags (CTexture.cpp:177-183) | 9: 2388299037, 3354740764, 3463520581 | UV-shifting effects (waterripple, shake, scroll) bleed the opposite edge in at the borders | S: OR in the clamp flag **Done in B7, Observed**: flag 0x8000, **default true** (GH 0x140212c50), so every layer's composite clamps unless `clampuvs:false`; nointerpolation 0x4000 (GH 0x140214b50). |
| E32 | Image `nointerpolation` | **Observed** property (GH 0x140219c60) | ignored | 0 | none | S |
| E33 | Which of `_rt_imageLayerComposite_<id>_a/_b` holds the result | **Unknown** | ping-pong parity decides which buffer holds the final image; "TODO: determine when … is used" (CImage.cpp:254-257) | 9 reference it: 2189783622, 2469881470, 3243449890 | a layer that uses another layer as a mask/texture may get an intermediate pass | M **Done in B7, Observed**: the ping-pong starts by pass parity, so `_a` is what the last pass reads and `_b` the stage before (GH 0x140214b50). |
| E34 | Effects on non-image objects | **Inferred** WE renders them (the editor attaches effects to text) | `parseText` keeps no effects (ObjectParser.cpp:142-160); a group object with effects becomes a placeholder `CObject` | 25 text: 2134765860, 2325974975, 2890767643; 1 group: 3319542538 (lightshafts) | text drawn without its blurprecise/pulse/shift_hue/reflection/shine/godrays | L (text → FBO + effect chain) |
| E35 | `general.hdr` ignored | **Observed** HDR scenes load `hdr_downsample`, `hdr_downsample_bloom`, `hdr_upsample(_cubic)`, `combine_hdr_upsample`/`combine_srgb`; LDR scenes load `downsample_quarter_bloom`, `downsample_eighth_blur_v`, `blur_h_bloom`, `combine_ldr` (GH 0x1401afbf0); HDR params `bloomstrength`/`blend`/`bloomtint`/`scatter` from `bloomhdr*` (GH 0x1401b42b0, keys GH 0x1401c7880) | always the LDR chain with `bloomstrength`/`bloomthreshold` (CScene.cpp:117-165); RGBA8 everywhere; `hdr` and `bloomhdr*` never read (WallpaperParser.cpp:41-53) | 5 hdr=true: 2511663284, 2542468435, 3019192537, 3395587987 (+1); 4 of them bloom | HDR bloom (threshold 1.0, iterative scatter) replaced by LDR bloom with other params; values > 1 clip | L. **Done (B13)**: WE's HDR chain and half float targets when `general.hdr` (gate decoded in 0098: `bloom` and `hdr` both literal true, then Ultra post-processing; here unless WPENGINE_HDR=0) |
| E36 | `bloomtint` ignored | **Observed** set on the LDR chain too (GH 0x1401b42b0); shader `g_BloomTint` default "1 1 1" | not passed to the bloom passes (CScene.cpp:139-153) | 1 non-white (3490034653), 1 user-bound | bloom tinted white instead of warm | S |
| E37 | Bloom params frozen at load | **Observed** GH 0x1401b42b0 re-applies them to the materials | strength and threshold are written as JSON literals into the virtual effect at construction; the bloom object exists only if `bloom` was true at load (CScene.cpp:117-162) | `bloom`/`bloomstrength`/`bloomthreshold` user- or script-bound in 4-5 (e.g. 2 `bloom.script`) | changing the user property or script doesn't change bloom | S |
| E38 | Material `alphatocoverage` | **Observed** blending enum normal 0 / translucent 1 / additive 2 / alphatocoverage 3 (GH 0x140182410, parse GH 0x140182450) | logged and treated as `normal` (MaterialParser.cpp:73-87) | 1: 3354740764 | cutout edges opaque instead of A2C | **Done (0067).** Unblended + the ALPHATOCOVERAGE combo WE sets (GH 0x140183570): the stock shaders discard below 0.5 on GLSL; `additive` sets ADDITIVE likewise. |
| E39 | Material `alphawriting` | **Observed** key with values default / disabled / enabled (GH 0x140182450) | not parsed. Final pass masks alpha out; every other pass writes alpha (CImage.cpp:926, 948) | 32 have the key, "enabled" only in 1 (3184155462, cursorripple sim) | none visible beyond E4/E5 | S |
| E40 | Non-system `usertextures` | **Inferred**: the name is a project user property of type texture, resolved to the user's file or its default | the name itself is resolved as a texture path and fails, so the slot keeps its fallback (CPass.cpp:756-805) | 3: 2388299037, 3243449890, 3516106265 (usertexture1-24) | user-picked images missing (`$mediaThumbnail` and `$mediaPreviousThumbnail` do work: RenderContext.cpp:16-32) | M |
| E41 | Effect `visible` is evaluated once | **Inferred** live (SceneScript `getEffect().visible`, user properties; GH 0x140219c60 exposes `getEffect`) | invisible effects are not built; visible ones never skip per frame (CImage.cpp:633, 801-803 TODO) | 33 have `visible.user` (10 with condition) | toggling an effect at runtime does nothing | **Done** (patch 0037, "E41 result" in § 5): built when it can be visible, the chain re-picked on a change; `getEffect()` is B10 |
| E42 | Brightness under `VERSION`/genericimage4 | **Unknown** (WE has no brightness term in g_Color4 by the case-2 layout; it may premultiply the ctx colour) | `g_Brightness` only exists in non-VERSION genericimage2 | 3: 2511663284, 2542468435, 3509243656 | possible brightness mismatch | — |
| E43 | Object `perspective` / `depthtest` / `castshadow` | **Observed** image properties (GH 0x140219c60) | ignored | perspective=true 4 (2469881470, 3354740764, 3422085307); depthtest 29; castshadow false only | mostly 3D; the effect of the 4 perspective=true images is **Unknown** | M |
| E44 | `clearenabled` | **Observed** key (GH 0x1401c7880) | always clears with clearcolor (CScene.cpp:88, 364) | 0 (true or absent in all 96) | none | S |
| E45 | Uniform `default` given as a non-string vec | **Unknown** | `VectorBuilder::parse(*defvalue)` with a number (ShaderUnit.cpp:511-518) | 1: 3414858021 (`u_PrlxPos` default 0) | possible throw, which drops the effect | S |

### Notes

- **Fed by both** (no gap, active counts): `g_ModelViewProjectionMatrix` 96, `g_Texture0` 96, `g_Texture0Resolution` 89,
  `g_Time` 77, `g_TextureNResolution` (live pointer; xy = physical size, zw = image size, as documented), particle
  set `g_EyePosition`/`g_Orientation*`/`g_View*`/`g_RenderVar0-1`/`g_ModelMatrixInverse` (78, CParticle.cpp:1812-1820),
  `g_Alpha`/`g_Color` (flat, 26; frozen per E3), `g_PointerPosition`/`Last` (6/1; screen-space semantics belong to
  the input area), `g_Daytime` (fed, CPass.cpp:872; **0 scenes use it**). WE also exposes `g_RenderVar2-4`,
  `g_ViewForward`, `g_BlendMap`, `g_Bones`, `g_BonesAlpha` and `g_Morph*`; none is active in the 2D corpus outside
  puppet/morph objects.
- Dead references: genericimage4 declares `g_EyePosition`/`g_ModelMatrix` (44 scenes) but uses them only under
  `LIGHTING`. They're harmless, so they're not counted as gaps.
- `zcompat/scene/shaders/<wsid>` replacements are honoured (AssetLocator.cpp:13-30). All 144 referenced effect.json
  files resolve: stock effects are packaged in the pkgs, and no lookup needed `assets/effects/<name>/`.
- Commands, override indexing and the pass→override mapping (copy passes don't consume an override) agree with the
  scene.json shape (motionblur: 3 passes, 2 overrides).
- Effect usage (scenes; stock effects, workshop copies folded in): waterwaves 42, shake 40, opacity 29,
  waterripple 26, waterflow 23, tint 21, pulse 20, foliagesway 20, blurprecise 14, blendgradient 14, scroll 13,
  godrays 13, blur 12, iris 10, vhs 9, filmgrain 9, shine 9, depthparallax 9 (**E1/E6 broken**), spin 8, clouds 6,
  chromaticaberration 6, colorkey 5, blend 5, perspective 5, localcontrast 5, swing 3, transform 3, twirl 3,
  motionblur 3, cloudmotion 2, fire 1, nitro 1, edgedetection 1, fisheye 1, refraction 1 (E25), cursorripple 1
  (**E4/E5/E6/E24 dead**), skew 1, glitter 1 (E24), blurradial 1. Unused: depthshimmer, fluidsimulation,
  lightshafts (stock), reflection, shimmer, watercaustics, wateroverlay, xray. 50 non-stock effects in 38 scenes;
  audio ones (Simple_Audio_Bars etc.) are hit by E8 and E17.
- Spot checks. godrays: binds, half-size targets and `previous` map correctly; `godrays_combine` uses
  `_rt_FullFrameBuffer` only under `COPYBG` (1 scene). shake, water*, pulse, foliagesway, iris: only `g_Time`,
  textures and audio, all fed (E8 aside). iris doesn't use the pointer; `iris_movement` (workshop) does (E6).
- Blending: WE normal = no blend, which LWE matches (`GL_ONE, GL_ZERO`). Corpus material blends: translucent 96
  scenes, normal 82, additive 64, alphatocoverage 1.

## 3. Particles (P)

Scope: particle systems (`objects[].particle`), their emitters, initializers, operators, renderers, control points,
children, `instanceoverride`, timing. LWE = `~/.cache/liascape/src/lwe-dev` @45ed25c. `CP.cpp` =
`src/core/WallpaperEngine/Render/Objects/CParticle.cpp`, `OP.cpp` = `src/core/WallpaperEngine/Data/Parsers/ObjectParser.cpp`,
`Obj.h` = `src/core/WallpaperEngine/Data/Model/Object.h`.

Library: 78 of 96 scenes have particle systems; all 78 reference a JSON inside their own pkg (presets are copied in,
no stock `particles/…` references). 29 scenes also have child systems. Counts come from
`$S/audit/work-particles/{usage,sheets,colr,colorn,io}.py`, which follow children recursively.

WE architecture, observed: the particle JSON is compiled once per path (FNV-hash cache, GH 0x1401f1a70) by the
parser GH 0x1401f3120. Ghidra fails to decompile that function, so it was read from annotated asm
(`work-particles/parser.asm`). The parser emits typed byte-code streams for emitters, initializers and operators,
plus a patch list that binds instance-override fields into those streams. The spawn interpreter is GH 0x140260d80,
emission GH 0x14025cfe0 and the per-frame step GH 0x14025c2e0. The operator interpreter GH 0x140265800 also fails
to decompile, so most operator math is **Unknown**. The override patcher is GH 0x1401ff240, and the instance
property table GH 0x140273180 places overrides at object+0x760.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| P1 | `starttime` prewarm | **Observed**: if `starttime`>0, it runs `update(step)` until the accumulated time ≥ starttime. The step is 0.05 s when maxcount<500, otherwise 0.2 s. This happens on load and again for every newly spawned child (GH 0x140254cc0, ev_812f649b…; called from GH 0x14025c2e0). The value is parsed as a float (asFloat → template+0x10, parser asm 0x1401f3362). | Parsed as `uint32` (`OP.cpp:514-517`) and never read again. The system starts empty, and the first frame skips simulation (`CP.cpp:178-190`). | **61** have starttime>0 (208 systems; median 3 s, max 300 s; 36 scenes ≥5 s), e.g. 1155728109, 1174926427, 1726902114 | Rain/snow/dust/fog fill in over several seconds after load instead of being at steady state. Long-life systems look sparse for up to minutes. | S: on setup, loop `update(step)` the same way |
| P2 | Child systems (`children`) | **Observed**: child types `static`, `eventfollow`, `eventspawn`, `eventdeath` (strings in parser, asm 0x1401feff4). Event children are spawned per particle event. Each has a `probability` roll and a `maxcount` cap, and the child is cloned and prewarmed. Followers detach when their parent particle dies (GH 0x14025c2e0 lines handling types 2/4, GH 0x1402507e0). Fields read: `type, flags, controlpointstartindex, origin, angles, scale, probability, maxcount`. | Parsed into `ParticleChild` (`OP.cpp:437-444, 832-882`). Nothing in `CP.cpp` reads `children`. | **29** (static 18, eventfollow 13, eventspawn 7, eventdeath 0), e.g. 1195626192, 1556245028, 2288455459 | Whole sub-effects are missing: splashes, sparks, trails following particles, secondary glows. | L: a child CParticle per entry; static = always on, follow/spawn/death fed by parent particle events **Done in B11** (0052): static, eventfollow, eventspawn and eventdeath children run (WE's keys and defaults: the file is `name`, maxcount 10), sharing the object's overrides. **Inferred**: a child simulates in its parent's space; its instances are pooled until empty. |
| P3 | `instanceoverride.rate` meaning | **Observed**: `rate` (override+0xdc) is clamped to ≥0.01 and multiplies **the whole system's dt** (`dt *= rate`, GH 0x140255d00, ev_6c14a78d…). It is a playback-speed scale for motion, ageing and emission together. No parser binding uses offset 0xdc. | Multiplies only the emitter's `rate`, and only once at creation (`CP.cpp:371, 523`). Particle motion, lifetime and oscillation run at 1×. | **36** have rate≠1 (35 of them with motion operators), e.g. 1556245028, 1884904087, 2064316482 | Slowed systems (rate<1) move too fast but emit sparsely. Sped-up ones look the opposite. | S: scale dt by max(rate, 0.01) in `render()` |
| P4 | `instanceoverride.count` meaning | **Observed**: `count` (0xd0) is bound to every emitter's `rate` and `maxtoemitperperiod` (parser asm 0x1401f3efc/0x1401f3f37/0x1401f462e/0x1401f4b44), and to the `count` of mapsequence*. **Inferred**: no binding scales `maxcount` (none found; the pool stays at maxcount). | Multiplies the **pool size** `maxcount·count` (`CP.cpp:59-64`). Emission rate is unchanged. | **43** have count≠1, e.g. 1726902114, 1797172968, 1884904087 | count>1: WE spawns more particles, LWE shows the same density. count<1: LWE truncates the pool, so particles die early or bursts are clipped. | S: multiply emitter rate (and maxtoemitperperiod) by count; keep the pool at maxcount |
| P5 | `colorn` tint math | **Observed**: the parser computes a *reference* colour for each system (mid-point of colorrandom min/max ÷255, or the colorchange start value; GH 0x1401f2210, writes `colorn`/`hascolor`). Tint applies only if override colorn differs from the reference by >0.0035 (GH 0x140251f70). It is then an **HSV shift**: colorrandom/hsv/colorlist ranges are converted to HSV and offset by (override − reference) in H, S and V (GH 0x1401ff240 cases 0xb/0xc/0xd). | RGB **multiply** of every particle by colorn, both at spawn and in colorrandom (`CP.cpp:494, 643, 712-721`). | **43** set colorn: 41 ≠ reference (HSV shift in WE), 2 = reference but non-white (3419466417, 3490034653: WE untouched, LWE tints red) | Wrong hues: coloured particles get darkened or multiplied instead of hue-rotated. | M: port the reference-colour plus HSV-offset path |
| P6 | colorrandom distribution | **Observed**: one random `t` (pow'd by `exponent`) is shared by R, G and B: `c = min + t·(max−min)` (GH 0x140260d80 case 3). | Independent random per channel (`CP.cpp:712-721`, `Maths.cpp randomVec3`). | **58** have colorrandom with ≥2 differing channels, e.g. 1155728109, 1174926427, 1195626192 | Particles take off-palette colours (e.g. a red→blue range also yields green-free magentas and darks). Overall palette is noisier and greyer. | S: single t for all channels |
| P7 | Initializer `exponent` ignored | **Observed**: lifetimerandom, sizerandom, colorrandom, alpharandom, velocityrandom (per axis), rotationrandom and angularvelocityrandom all read `exponent` (parser string list) and apply `pow(rand, exponent)` (GH 0x140260d80 cases 1/2/3/6/7). | Only sizerandom and angularvelocityrandom read it (`OP.cpp:645-684`). | alpharandom 12, lifetimerandom 7, velocityrandom 5, rotationrandom 2, colorrandom 1 (e.g. 1195626192, 2064316482, 2288455459) | Distribution skew is lost: more bright/long-lived/fast particles than intended. | S |
| P8 | Sprite-sheet frame blending | **Observed**: the `SPRITESHEETBLEND` combo is 1 unless flags bit1 is set or `animationmode`=randomframe (GH 0x1401fffb0). `SPRITESHEETBLENDNPOT` is set when the texture is padded. The frag shader cross-fades the current and next frame (`genericparticle.frag:81-88`). | Never sets SPRITESHEETBLEND/NPOT (`CP.cpp:1651-1660`). Frames step. | **33** use a sheet texture with blending on (40 use sheets), e.g. 1155728109, 1195626192, 1556245028 | Flicker/stepping on fire, smoke and sparkle sheets instead of smooth animation. | S: set the combos with the WE rule |
| P9 | `animationmode` sequence timing | **Observed**: only `randomframe` is recognised (template+0x30, asm 0x1401f33a7). Anything else is "sequence", and `once` does not exist. The frame is `floor(frac(lifetimeValue)·frames)` in the shader. **Unknown**: how the CPU derives lifetimeValue (life fraction × sequencemultiplier vs texture fps). | Sequence uses the texture's frame **duration** × sequencemultiplier when the sheet has durations (`CP.cpp:294-301`). An extra `once` mode exists. | 14 explicit sequence plus 47 default (whenever a sheet exists) | Possibly wrong animation speed. | S once settled (needs the owner) |
| P10 | `instanceoverride.controlpointN` / `controlpointangleN` | **Observed**: the table has controlpoint0-7 (vec3, +0xf0+12i) and controlpointangle0-7 (+0x150+12i). They overwrite the CP offset or rotation unless the CP is mouse-locked or the value is the FLT_MAX sentinel (GH 0x140273180, GH 0x140251f70). | Not in `ParticleInstanceOverride` (`Obj.h:542-552`). Ignored. | **8** (cp1 6, cp2 5, cp7 3, cp3/4 2, cp6 1; 2 scripted), e.g. 2679248947, 2951169110, 3042492564 | Attractors, vortices and rope endpoints sit at the JSON default instead of where the author put them. Scripted CPs are static. | S **Done in B11** (0053): controlpoint0-7 replace the offsets, live, unless flags & 0x10005. controlpointangleN is not ported. |
| P11 | `instanceoverride.brightness` | **Observed**: multiplies the initial particle colour (and colorn) when the scene is HDR (scene flag 0x2000) and the system lacks template flag 8 (GH 0x1401ff240 head). | Not parsed. `getBrightness` returns the material `overbright` (`CP.cpp:325`); the shader doesn't read `g_Brightness`. | 2 (2511663284, 3509243656; both hdr) | HDR glow particles too dim. | S |
| P12 | `instanceoverride.color` (legacy) | **Observed**: if present, `colorn = color/255` is rewritten into the JSON (GH 0x140251200). `color` is not itself a table field. | Read as an RGB 0-1 vector and returned from `getColor()` (`CP.cpp:331-345`), which feeds `g_Color` (unused by the particle shader). The value is not converted to colorn. | 1 (1556245028) | Tint lost (colorn stays 1). | S |
| P13 | `instanceoverride.alpha` applied live | **Observed**: alpha (+0xc8) is written to the system's global alpha (+0x3ec) on every override update and copied into each particle's alpha at spawn (GH 0x1401ff240, GH 0x140260d80 init). Changes re-run the patcher (dirty flag, GH 0x140255d00). | Multiplied into alpha only at spawn (`CP.cpp:495, 644, 746-753`). `g_Alpha` is set but not used by the shader. | 40 with alpha≠1; dynamic or user-bound in 5 (1864677589, 2371103399, 3233141951…) | Fades or user changes lag by up to one particle lifetime. **Inferred**: a static alpha looks the same. | S |
| P14 | Overrides frozen at creation | **Observed**: override changes set a dirty flag that re-patches all bound values (GH 0x140255d00 → GH 0x140251f70 → GH 0x1401ff240). | Emitter rate, lifetime and pool size are captured at construction (`CP.cpp:59-64, 371, 523-524`). | user-bound or dynamic: count 9+3, size 14+3, rate 2+5, speed 6+1, lifetime 2 (e.g. 2469881470, 2932157836, 3042492564) | User-property sliders for count, rate and lifetime do nothing until reload. | S |
| P15 | Speed override targets | **Observed**: `speed` (0xd4) is bound to emitter speedmin/max, velocityrandom, inheritcontrolpointvelocity, turbulentvelocityrandom, angularvelocityrandom, mapsequence speeds, movement **gravity**, angularmovement force, oscillateposition, controlpointattract scale, turbulence speed and vortex speeds. **Not** to rotationrandom, and not to drag (parser bindings listed in Notes). | Also multiplies the initial **rotation** angle (`CP.cpp:780-789`). It scales angular velocity both at init and again in angularmovement (`CP.cpp:1056-1072`). | 16 have rotationrandom and speed≠1 (33 have speed≠1), e.g. 1797172968, 1884904087, 2064316482 | Wrong initial sprite rotations and doubled spin. | S **Done in B11** (0051): speed binds where the parser binds it (emitter speeds, velocity/angular/turbulent velocity, mapsequence, gravity, force, oscillateposition frequency, attract scale, turbulence and vortex speeds), not rotationrandom; flags 0x10/0x40/0x80 opt out. |
| P16 | Emitter `duration`/`delay`/periodic on sphererandom | **Observed**: a shared emitter base for all emitter types (GH 0x1401ef590): rate, duration, delay, instantaneous, flags, min/max periodic duration/delay, maxtoemitperperiod. The runtime (GH 0x14025cfe0) honours them for every type. | Only boxrandom has delay, duration and periodic (`CP.cpp:370-440`). sphererandom ignores them (`CP.cpp:522-560`). | sphere duration 3 (3445973124, 3479521040, 3490034653) | One-shot sphere emitters never stop, so effects keep spraying. | S: share the box timer code |
| P17 | `maxtoemitperperiod` | **Observed**: caps emission per periodic window, scaled by count (GH 0x1401ef590, GH 0x14025cfe0). | Not parsed (`OP.cpp:610-636`). | 0 (not in library) | none | S |
| P18 | `instantaneous` with periodic emission | **Observed**: the instantaneous burst is reloaded at the start of every periodic "on" window and on every reset (GH 0x14025cfe0 +0x44←+0x48; GH 0x140254f50). | Fires once per system lifetime (box `CP.cpp:441-446`). In sphere it *replaces* that frame's rate emission (`CP.cpp:559-562`). | instantaneous 9 (periodic+instantaneous: 0) | Mostly none. Sphere loses one frame of rate emission. | S |
| P19 | Visibility toggle resets the system | **Observed**: when the object is invisible, emitters are reset (duration, delay and burst reloaded) and all particles and child instances are cleared (GH 0x140255d00 → GH 0x140254f50, GH 0x140255430). On re-show it starts fresh. | `render()` returns early, freezing the simulation with live particles (`CP.cpp:172-175`). After re-show, dt is capped at 0.1. | **37** have user-bound `visible` on particle objects (+2 scripted), e.g. 1884904087, 1934084447, 2371103399 | Toggling an effect shows frozen stale particles, and one-shot bursts don't replay. | S |
| P20 | Audio-responsive emitters | **Observed**: if `audioprocessingmode`≠0, emitter rate is multiplied by an audio level (GH 0x14025cfe0 via GH 0x140250d80). Bands are clamped 0-15 and default bounds are "0.8 1.0" (GH 0x1401ef740). | `TODO` (`CP.cpp:439`). Always full rate. | 2 (1556245028, 3289734539) | Constant emission instead of music-driven pulses. Silence still emits. | M: needs the audio spectrum (see audio section) |
| P21 | Audio on operators (turbulence/vortex) | **Observed**: the audio block is parsed for turbulence, vortex and vortex_v2 (asm 0x1401fb3e9/0x1401fb9cf/0x1401fbf85). | turbulence: TODO. vortex: **skipped entirely** when audio mode>0 (`CP.cpp:1324-1327`). | 0 in operators (1 turbulentvelocityrandom has bounds only) | none in library | M |
| P22 | boxrandom `speedmin/speedmax` | **Observed**: read for boxrandom and bound to speed (asm 0x1401f4290-0x1401f4716). **Unknown**: velocity direction. | Parsed but unused by the box emitter (`CP.cpp:370-520`). | 5 (2511663284, 3276522107, 3414858021…) | Box-emitted particles start at rest. | S once the direction is known **Done in B11, Observed**: outward from the box's centre, a random direction when the particle is at it (GH 0x14025cfe0). |
| P23 | Emitter types `layerimage` | **Observed**: a third emitter type exists (speedmin/max, offsetmin/max, rate; emits from an image layer's pixels) (asm 0x1401f476d). | "Unknown emitter type", dropped (`CP.cpp:360`). | 0 | none | M |
| P24 | sphererandom `cone`, `sign`, distance as scalar | **Observed**: `distancemin/max` are read as **floats** for sphere and as vec3 for box. `cone` is converted (GH 0x140104cf0) and stored. `sign` is sphere only. | `cone` is parsed but unused. Distance is a vec3 and only `.x` is used (`CP.cpp:581-583`). | cone 0. Sign 17 (implemented). | none known | S |
| P25 | Unimplemented initializers | **Observed** (parser strings): `hsvcolorrandom`, `colorlist`, `inheritcontrolpointvelocity`, `positionoffsetrandom`, `mapsequencebetweencontrolpoints`, `remapinitialvalue`, `inheritinitialvaluefromevent`. | Unknown name → `nullptr` (`OP.cpp:642-693`). | 0 (not in library) | none | M each |
| P26 | Unimplemented operators | **Observed**: `maintaindistancetocontrolpoint`, `maintaindistancebetweencontrolpoints`, `reducemovementnearcontrolpoint`, `boids`, `capvelocity`, `remapvalue`, `inheritvaluefromevent`, `collisionplane/sphere/box/bounds/quad/model`. | Dropped (`OP.cpp:695-776`). | 0 | none | M-L |
| P27 | mapsequencearoundcontrolpoint extras | **Observed**: reads `count, bounds, limitbehavior, mirror, controlpoint, speedmin, speedmax, axis`, with count bound to the count override. | Reads controlpoint, count and speeds only. `bounds`, `limitbehavior`, `mirror` and `axis` are ignored (`OP.cpp:685-690`). | 3 use bounds+limitbehavior (2288455459, 3233141951, 3413117423) | Ring or sequence spacing differs. | S |
| P28 | controlpointattract keys | **Observed**: WE reads `offset, scale, threshold, deletethreshold, flags, controlpoint` (defaults GH 0x1401eb290). `origin` is not read. | Reads `origin` as the offset and halves `threshold` (`OP.cpp:749-752`, `CP.cpp:1463`). `deletethreshold` and `flags` are ignored. **Unknown**: WE force law. | 18. Nonzero `origin` in 1 (2679248947). | Attract radius likely half of WE's. Particles near the cursor are not deleted. | S (verify the threshold) **Done in B11, Observed**: `offset` (not `origin`), the full threshold, step = scale·fdt·(1 − d/threshold), flags 2 = never past the point, flags 1 = delete within deletethreshold (GH 0x140265800 case 0xa). |
| P29 | Sprite renderer `orientation`/`axis` | **Observed**: `orientation` = screen(0) / upright(1) / fixed(2), plus `axis` and `flags` (GH 0x1401efc50). | Not parsed. Always screen-facing (`CP.cpp:1847-1851`). | 1 uses upright/fixed (3174556087, rain splash children) | Splashes face the camera instead of lying flat (moot until P2). | S |
| P30 | Rope/trail shader combos | **Observed**: for rope types WE sets `TRAILSUBDIVISION`=subdivision and `ORIENTATION`, plus `TRAILSCROLLALPHA` (uvscrolling), `TRAILFADEALPHA` (fadealpha) and `TRAILFADESIZE` (fadesize) (GH 0x1401fffb0). | Only THICKFORMAT and TRAILRENDERER, with CPU Catmull-Rom geometry (`CP.cpp:1651-1660, 2098+`). | rope 11, ropetrail 9 (fade/scroll keys: 0) | **Unknown**: possibly a different ribbon shape or UV. | M **Done in the leftovers as far as the library goes** (0097): subdivision + 1 pieces per segment (TRAILSUBDIVISION in genericropeparticle.geom); every library rope is ORIENTATION 0, no fade/scroll keys. Left: WE's bezier from its CPU spline buffer. |
| P31 | colorchange semantics | **Observed**: WE uses colorchange `startvalue` as the system's reference colour (GH 0x1401f2210), which hints at absolute colours. **Unknown**: runtime math (operator interpreter not decompiled). | Multiplies the initial colour by lerp(start, end) (`CP.cpp:1199-1228`). | 4 (2679885269, 3022080536, 3233141951…) | Possibly wrong colours. | S once known **Observed in B11**: relative, as LWE had it (a ramp multiplying the spawn colour); its values are colorn-shifted (patch op 0xc). |
| P32 | sizechange × size override | **Observed**: sizechange start/end values are themselves bound to the size override (asm 0x1401f97d8; gated by template flag 0x80). **Unknown**: whether runtime size is absolute or relative. | Relative multiplier of the initial size, which already includes the size override (`CP.cpp:1138-1165`). | 32 sizechange; 51 size≠1 | **Unknown**: size could be off by a factor of the size override. | S once known **Observed in B11**: relative, and sizechange's values carry the size override too, so it applies twice (patch op 7, 0x1401f97d8). Done (0051). |
| P33 | Operator math unverified | **Unknown**: movement drag form, turbulence noise and scale, vortex, oscillate*, alphafade curve (defaults 0.5/0.5 match, GH 0x1401ea170). The interpreter GH 0x140265800 is not decompiled. | Hand-tuned heuristics: turbulence ×2 scale, one phase/speed per operator (`CP.cpp:1240-1300`); turbulentvelocityrandom position×0.1 and cone clamp (`CP.cpp:820-900`); oscillate phase range +2π (`CP.cpp:1523`). | turbulence 21, turbulentvelocityrandom 30, oscillate* 27/24/5, vortex 7 | Motion differs in unknown ways. | L: asm-level RE of GH 0x140265800 **Done in B11** (0051): GH 0x140265800 decoded (a fresh REA/Ghidra pass with no decompile timeout): movement and angularmovement drag, alphafade, the change ramps, oscillate*, controlpointattract, turbulence, vortex. Turbulence's noise is a standard simplex (WE's gradient hash not ported); vortex_v2 not decoded (0 scenes). |
| P34 | Control-point flags | **Observed**: per-CP flags mask 0x10005 (bits 0, 2, 16) gates override application. bit0 = follow mouse (GH 0x140251f70). CPs also have `parentcontrolpoint` and `angles`. | bit0 = mouse and bit1 = "world space" (`CP.cpp:146-165`). `parentcontrolpoint` and `angles` are ignored. A `locktopointer` key is parsed and unused (`OP.cpp:828`). | bit0 24, bit1 3 (3042492564, 3163060610, 3479521040) | **Unknown** for bit1 scenes. | S **Done in B11** (0053): bit1 = the offset is in the scene's space, unrotated and unscaled into the system's (not control point 0, GH 0x1402504f0). Local offsets are now mirrored like emitter origins. |
| P35 | Mouse CP vs object transform | **Inferred**: WE stores CP matrices (stride 0xd0) and transforms them with the object. | Mouse CP = screen px − origin, ignoring object `scale` and `angles`, but rendered through the scaled and rotated model matrix (`CP.cpp:235-255, 1828-1841`). | 24 mouse-CP scenes. scale≠1 in 59 and angles≠0 in 54 particle scenes overall. | Cursor-follow effects offset or rotated away from the cursor when the system is scaled or rotated. | S: inverse model matrix **Done in B11** (0053): the inverse of the system's rotation and scale. |
| P36 | Parented particle systems | **Unknown** for particles specifically (parenting is generic in WE). | `updateMatrices` uses only the object's own origin, angles and scale (`CP.cpp:1828-1841`). | 13 (3042492564, 3163060610, 3174556087…) | Effects don't follow the moving or animated parent. | M (shared with the hierarchy section) |
| P37 | Frame-time handling | **Observed**: no dt clamp seen in GH 0x140255e50 or GH 0x14025c2e0. When the scene FPS setting is 1-20, each frame is simulated as two half steps (GH 0x14025c2e0 tail). | dt capped at 0.1 s (`CP.cpp:197`). No substeps. | all 78 | At <10 fps (or on hitches) LWE sim time runs slower than wall time. | S |
| P38 | Random source | **Observed**: one scene-level RNG (`*scene+0x1f08`, GH 0x140223090). | `std::random_device` per system (`CP.cpp:31`). randomframe uses the particle *address* as seed (`CP.cpp:283-287`). | 21 randomframe | randomframe frames repeat per pool slot (patterned). | S |
| P39 | Particle-level `flags` | **Observed**: only the low 8 bits are kept (`movzx`, asm 0x1401f3379). bit1 or randomframe disables sheet blend. Bit 0x4 sets template+4=0x80. 0x10/0x20/0x40/0x80 opt out of speed/count/lifetime/size override binding. | Uses only bit2 (perspective: 3D spawn shell, separate projection) (`CP.cpp:578, 904, 1883`). | bit0 16, bit1 11, bit2 36 | **Unknown** for bit0 (WE meaning not identified). | S **Done in the leftovers** (0092): bit 0 is the editor's "Worldspace" (wallpaperui.exe's flag strings); its particles stay where they were emitted (the carry inferred). |
| P40 | Scene gravity/wind | **Unknown**: `general.gravitydirection/strength`, `windenabled/direction/strength` live in the scene property table (GH 0x1401d…; scene+0x3a8…). No particle-side reader found. Likely bone or puppet physics. | Not parsed. | 22 particle scenes set gravitystrength | Probably none for particles. | n/a |
| P41 | `maxcount` absent / default size | **Observed**: maxcount absent → 0. The spawn default size is 0.5 and is multiplied by sizerandom (GH 0x140260d80 init: lifetime 1, size 0.5), so LWE's `/2` (`CP.cpp:738`) matches. | Default pool is 1000 when 0. Default size is 20×override (no sizerandom). | 0 (all 78 set maxcount and sizerandom) | none | — |

### Notes

- Override bindings in the parser asm (`mov [rec+0x18],<field>`): speed 0xd4 at 0x1401f3fe4/4716/4c2c (emitters),
  0x1401f61ef (velocityrandom), 0x1401f639f (inheritcpvelocity), 0x1401f6903 (turbulentvelocityrandom),
  0x1401f758f (angularvelocityrandom), 0x1401f7de1 (mapsequence), 0x1401f91bf (movement gravity), 0x1401f94ee
  (angularmovement force), 0x1401fa0a6 (oscillateposition), 0x1401faa1b (cpattract scale), 0x1401fb512 (turbulence),
  0x1401fba7c/0x1401fc03b (vortex/v2). size 0xcc at 0x1401f512b (sizerandom) and 0x1401f97d8 (sizechange).
  lifetime 0xd8 at 0x1401f4f50 (lifetimerandom). count 0xd0 is listed in P4. rate 0xdc has no binding.
  Patch-record ops are in GH 0x1401ff240: 1=int×, 2=float×, 3=1/(x·o), 6/7=min/range×, 0xb-0xd=HSV colour.
- Emitter runtime record (GH 0x14025cfe0/0x140254f50): +0x10 rate, +0x14/+0x1c duration (live/reload), +0x18/+0x20
  delay, +0x24 accumulator, +0x28..0x34 periodic min/max, +0x38 maxtoemitperperiod, +0x44/+0x48 instantaneous,
  +0x4c flags (bit1 one per frame, bit2 periodic, bit31 finished), +0x50 audio. Defaults (GH 0x1401e5930): rate 10,
  duration 0, delay 0, periodic duration 2-3 s and delay 1-2 s. All match LWE except where noted above.
- Spawn init order (GH 0x140260d80): age 0, lifetime 1, size 0.5, colour = brightness·colorn vector, alpha = global
  alpha, then the initializer stream. Colour, size and alpha initializers **multiply** these values. Lifetime is
  clamped ≥ DAT_1404d40fc.
- Shared REA Evidence: ev_812f649b… (GH 0x140254cc0, prewarm), ev_6c14a78d… (GH 0x140255d00, dt×rate, visibility reset).
- 13 particle objects have script- or animation-driven instanceoverride values. Whether LWE's `it.user()` evaluates
  scripts or animations there belongs to the scripting section. P14 only covers values being frozen at construction.
- Not gaps: emitter defaults (directions "1 1 0", distancemax "256 256 0"), alphafade defaults, the sizerandom ½,
  spritetrail g_RenderVar0 (length/max/min), sphererandom `sign`, emitter flags bit1 (one per frame).

## 4. Text objects (T)

T9 (text parent/rotation/parallax) was folded into G04, G13 and G30. T1 is E34's text part. WE's text property table is FUN_14027e130 ([L1]): `backgroundbrightness`, `opaquebackground`, `limitwidth`, `limitrows`, `limituseellipsis`, `blockalign`, `backgroundcolor`, `pointsize`, `padding`, `spacing`, `maxwidth`, `outline*`, `dropshadow*`, `blursize`, `depthtest`, plus the unnamed alignment/rows slots.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| T1 | Text objects take no effects | **Observed**: the text class registers its own property table (FUN_14027e130, [L1]) on top of the image object's (effects, materials, `depthtest`); text renders through `shaders/font.frag` as a layer like an image. **Inferred**: effects apply to the rendered text quad. | `parseText` never reads `effects` (Data/Parsers/ObjectParser.cpp:142-159); CText draws with its own two-line shader (Render/Objects/CText.cpp:34-55) | 25 (2134765860, 2325974975, 2890767643) | Glow, shake, scroll, waterripple etc. on clocks and labels are missing; the text is drawn flat | L — render text into an FBO texture and feed it through CImage's effect chain (same as an image with a generated texture) |
| T2 | One line only; `\n` is not a line break | **Observed**: `maxrows`, `limitrows`, `limitwidth`, `maxwidth`, `spacing`, `blockalign` are text properties ([L1]). **Inferred**: multi-line layout | `rebuildTextureFrom` lays every byte on one baseline (CText.cpp:233-270); a newline becomes a missing glyph | 11 literal + 23 scripted text with `\n` (1884904087, 2134765860, 3174556087) | Clock/date layouts (time over date) collapse into one line | M — line breaking + per-line alignment |
| T3 | No UTF-8 decoding | **Inferred** (Windows WE renders Unicode; fonts in the library are CJK) | iterates `unsigned char` bytes (CText.cpp:245, 259) | 14 literal + 12 scripted non-ASCII (3028473503, 3233141951, 2932157836) | CJK/accented text renders as garbage glyphs or nothing | S — decode UTF-8 → `FT_Load_Char(codepoint)` |
| T4 | `horizontalalign` / `verticalalign` / `anchor` ignored | **Observed**: properties of the text class ([L1]); values in the library: left 49, right 32 objects; top 13, bottom 17 | parsed into `alignment`/`verticalalign` (ObjectParser.cpp:154-155) but the quad is always centred on `origin` (CText.cpp:345-350, 424) | 45 have the keys; non-centre in ~20 | Right/left-aligned clocks drift as the string width changes; mis-placed labels | S |
| T5 | `padding`, `maxwidth`, `limitwidth`, `limitrows`, `maxrows`, `limituseellipsis` ignored | **Observed**: text properties ([L1]) | `padding` parsed (ObjectParser.cpp:156), unused; the rest not parsed | limit*: 17 (2134765860, 2890767643, 2932157836); padding non-zero in 45 | Long text overflows where WE wraps/truncates with "…"; box placement differs | M |
| T6 | `backgroundcolor`, `backgroundbrightness`, `opaquebackground` | **Observed**: text properties ([L1]) | not parsed | `opaquebackground` true in 0 scenes | none in the library | S (skip until used) |
| T7 | `outline*`, `dropshadow*`, `blursize` | **Observed**: text properties ([L1]) | not parsed | 0 | none in the library | M (skip) |
| T8 | `systemfont_*` maps to DejaVu Sans | **Inferred**: WE resolves `systemfont_arial`, `systemfont_comicsans`, … to the Windows font | any `systemfont_*` → first of 4 hard-coded DejaVu/Liberation paths (CText.cpp:27-32, 156-158); on NixOS none of those paths exist → the object is dropped (CText.cpp:190-192; **observed**: `--lwe-smoke` of 2890767643 on the owner's NixOS logs `CText: no usable system font found`) | 19 (1884904087, 2047150134, 2561227934) | Wrong typeface; on NixOS the text may vanish entirely | S — fontconfig lookup with a metric-compatible map (Arial→Liberation Sans, Times→Liberation Serif, Courier→Liberation Mono, Comic Sans→Comic Neue if present) |
| T10 | Pixel size heuristic | **Unknown** exact WE rasterisation size (pointsize × scale × output DPI) | rasterises at `pointsize / avg(scale)` capped ×32 (CText.cpp:204-213) | 45 | Possible blur/size mismatch vs WE | S — needs a WE screenshot to calibrate |

## 5. SceneScript (S)

Path shorthands for LWE (repo `~/.cache/liascape/src/lwe-dev`): `Scr/` = `src/core/WallpaperEngine/Scripting/`,
`Ren/` = `src/core/WallpaperEngine/Render/`, `QJS/` = `src/External/quickjs/` (quickjs-ng 0.13.0).
WE sources:
- `D-<page>` is a page under `https://docs.wallpaperengine.io/en/scene/scenescript/reference/` (`class/<X>.html`, `event/<x>.html`).
- `bc:N` is `weassets/scripts/jsclasses/baseclasses.js` line N.
- `ss64` is `strings` of `we/scenescript64.dll`, the V8 runtime (it contains "V8.js" and "2.8.485.SceneScript").

Usage counts come from all 1464 `"script"` strings in the 96 `scene.json` files, which sit in 50 scenes. The
extractor is `work-scenescript/extract_scripts.py`, and the per-API counts are in `work-scenescript/api.txt`.
- 40 scenes have **property scripts**: every `script` except `text` objects' `.text`.
- 41 scenes have **text-layer scripts**: `.objects[].text.script`, 247 scripts.
- No pkg ships separate `.js` files. Two `models/*.json` mention `"script"`, both in scenes that don't load (3477054430, 3509243656).

### Two script paths in LWE (read this first)

- **Property scripts.** `ScriptableObject::registerProperty` → `ScriptEngine::queueScript` evaluates the source with
  `JS_Eval(…, JS_EVAL_TYPE_MODULE)` (Scr/ScriptEngine.cpp:570). It stores the **return value** as the "module" and
  then calls `JS_GetPropertyStr(module, "update")` on it each frame (:591, :630). The same happens for queued
  events (:615). In quickjs-ng, `JS_Eval` of a module returns a **Promise**, not the namespace. See
  QJS/quickjs.c:30783-30834, where `js_evaluate_module` returns `m->promise`, and QJS/api-test.c:576-579, which
  asserts `JS_IsPromise(ret)` for a module eval. A Promise has no `update`, so `call()` returns `undefined`
  (:544-554). `jsToDynamicValue(undefined)` then calls `DynamicValue::update(Script)`, which sets the type to
  Null and **all components to 0** (Scr/ScriptEngine.cpp:116-118, src/core/WallpaperEngine/Data/Model/DynamicValue.cpp:227-237).
  - The top-level module code does run once, at Eval time. `export function update/init/cursor*/media*` never runs.
  - This is inferred from the source plus quickjs-ng's own test. A live run was attempted with
    `scene_corpus.sh --only 3291729669,3445973124` and failed before playing anything: the socket path under the
    scratchpad is longer than SUN_LEN. So it is **not runtime-confirmed**.
- **Text-layer scripts.** `CText` → `createLayerScript` (Scr/ScriptEngine.cpp:314-431). The script is wrapped in an
  IIFE with `export`/`'use strict'` stripped. It sees private shims `thisLayer={text}`, `thisScene={time,
  currentTime,dt,fps}` and `engine={frametime,time}`, which shadow the real globals (:365-379). `init()` and
  `update()` are called from `CText::render` (Ren/Objects/CText.cpp:377-394). This path **works**. It covers the
  library's clock, date and FPS texts.

### Gaps

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| S1 | Property scripts never execute | **Documented**: `update(value)` runs every frame for every script that exports it, and `init(value)` runs once (D-event/update, D-event/init, reference.html). **Observed**: the event names `update resizeScreen destroy applyUserProperties … mediaTimelineChanged` (ss64). | **Observed (source)**: the module is a Promise, so `update`, `init` and every event lookup are undefined (Scr/ScriptEngine.cpp:570,591,615,630; QJS/api-test.c:576-579). | 40 (1464 − 247 scripts; e.g. 2890767643, 3042492564, 3163060610) | Every scripted property is static or zeroed (S2-S4). All script interactivity, audio reactivity and animation logic is dead. | **Done (0020).** Was: S: eval with `JS_EVAL_FLAG_COMPILE_ONLY`, then `JS_EvalFunction`, then `JS_GetModuleNamespace(ctx, m)`. Look `update`, `init` and the events up on the namespace. |
| S2 | Scripted registered property is set to 0 each frame | **Documented**: a property changes only by update's return. "You can choose to not return any value, then the property will not be modified" (D-event/update). | **Observed (source)**: `update(Null)` every tick zeroes it. This hits image `origin/alpha/color/parallaxDepth` (Ren/Objects/CImage.cpp:166-172), text `origin/color/alpha/pointSize` (Ren/Objects/CText.cpp:78-85) and particle `origin/parallaxDepth`. | 25 (22 load: e.g. 3291729669 text origin, 2325974975 image alpha, 3354740764 text color) | Layers jump to scene (0,0), at the bottom-left corner. Scripted-alpha images are invisible. Scripted colours turn black. | **Done (0020).** Was: S: fixed by S1+S5 |
| S3 | `scale`/`angles`/`visible` scripts on image/text/particle bind to a dead copy | **Documented**: these are ILayer props, and scripts on them drive the layer (D-class/ILayer). | **Observed**: the `ScriptableObject` ctor registers `scale/angles/visible` first, on `object.groupScale/groupAngles/groupVisible` (Scr/ScriptableObject.cpp:11-17; parsed separately, Data/Parsers/ObjectParser.cpp:44-47). The typed `registerProperty("scale", image.scale)` is then ignored (emplace, :33-43), and rendering reads `image->scale`/`image->visible` (Ren/Objects/CImage.cpp:99-117, :862, :922). | 30 (image visible 20, image scale 14, text scale 15, text visible 11; e.g. 2469881470, 2932157836) | Scripted show/hide, pulsing and rotation never happen. Layers keep their JSON value. | **Done (0020).** Was: S: register the typed DynamicValue for typed objects, and keep `group*` only for plain groups |
| S4 | Property scripts outside the registered set are never queued | **Documented**: any scriptable property takes a script. `thisObject` is an IEffect for effect props (D-class/IThisPropertyObject). **Observed**: material/particle hooks `setMaterialProperty`, `instanceoverride` and `emitParticles` exist in wallpaper64.exe. | **Observed**: only `registerProperty` queues scripts. Nothing registers `effects[].passes[].constantshadervalues.*`, `effects[].visible`, `instanceoverride.*`, `maxwidth`, `animationlayers[].rate/visible`, `brightness`, `.general.bloom*` or sound `volume`. Group and model objects are plain `CObject` (Ren/Wallpapers/CScene.cpp:250). | 30 (effect uniforms 21, effect visible 6, instanceoverride 10, maxwidth 7, group objects 9; e.g. 2134765860, 3219908811) | Script-driven shader uniforms (11 scenes feed audio into them), effect toggles, particle rate/size/count and text wrap width stay at their JSON value. | **Partly done (0037, 0038, 0040).** Scripts now run on effect `visible`, effect shader constants (`constantshadervalues`), general `bloom`/`bloomstrength`/`bloomthreshold`, sound `volume`, and group objects' scale/angles/visible. Left: `instanceoverride.*`, `maxwidth`, `animationlayers[].rate/visible`, `brightness`. Was: M: a `ScriptHost` for effect/material/particle/scene values and for group objects |
| S5 | A missing `update` or a return of `undefined` zeroes the value | **Documented**: when nothing is returned, the property is not modified (D-event/update, D-event/init). | **Observed**: `call()` returns `undefined` when there is no `update`, and `jsToDynamicValue` maps that to Null/0 (Scr/ScriptEngine.cpp:116-118, 544-554). | 22 export no `update` (only init/cursor/media); 8 have an `update` without `return` (e.g. 2325974975, 2469881470) | Once S1 is fixed, these properties still go to 0. | **Done (0020).** Was: S: skip the write on undefined/null |
| S6 | `init(value)` not called for property scripts | **Documented**: `init(value)` is called once after creation, and its return sets the property (D-event/init). | **Observed**: only `update` is ever looked up (Scr/ScriptEngine.cpp:591, 630). | 27 (e.g. 2134765860, 2290002190, 2679248947) | Initial-state capture (e.g. `initialValue = value`) is missing, so `update` misbehaves. | **Done (0020).** Was: S |
| S7 | `thisLayer` is one global set at registration; `thisObject` is missing | **Documented**: `thisLayer` is "the layer the script is loaded on" and `thisObject` is the owning object (reference.html). **Observed**: both are globals in ss64. | **Observed**: `globalThis.thisLayer` is overwritten on each `queueScript` and never restored per call (Scr/ScriptEngine.cpp:584). Every script sees the last-registered object, and `thisObject` is undefined (ReferenceError). | thisLayer 25+, thisObject 18 (e.g. 2134765860, 2388299037) | Once S1 is fixed, scripts move or read the wrong layer, and `thisObject.getAnimation()` throws. | **Done (0020).** Was: S: bind both per module before each call |
| S8 | `scriptProperties` of property scripts bind to the wrong module and lose defaults | **Observed** (bc:1423-1455, 1389-1399): `createScriptProperties()` returns defaults from `addX({value})` (combo: `options[0].value`). `_Internal.updateScriptProperties` overlays only the stored keys. | **Observed**: `finish()` captures `getRunningModule()` during Eval, which is the *previous* script or null, because `m_runningModule` is set later (Scr/ScriptEngine.cpp:587; Scr/ScriptPropertiesObject.cpp:64-84). Keys absent from scene.json read `undefined` (:37-42), and the builder ignores `value` (:57-62). | 27 use it in property scripts. 4 have keys missing from scene.json (3219908811, 3233141951, 3243449890, 3432999904) | Once S1 is fixed, sliders/combos read another layer's values or `undefined`, giving NaN positions/speeds. | **Done (0020).** WE's builder gives the defaults, the stored values of the module being evaluated lie over them, live. Was: S: build a plain JS object per module and overlay the stored values (user-bound live) |
| S9 | A returned Vec3/Vec4 loses z (and w) | **Documented**: the vector return is applied, and numbers broadcast to Vec2/Vec3 (D-event/update). | **Observed**: `zVal`/`wVal` are never read, so the vec3 is written as `(x,y,0)` (Scr/ScriptEngine.cpp:159-174). Numbers broadcast correctly. | color 11, scale 20, origin 25 (latent behind S1) | Once S1 is fixed, scripted colours lose blue and scale z becomes 0. | **Done (0020).** Was: S |
| S10 | No cursor events and no `CursorEvent` | **Documented**: `cursorEnter/Leave/Move/Down/Up/Click(event)` fire per object hit, with `worldPosition`, `localPosition` and `hitBox` (D-class/CursorEvent, reference.html). **Observed**: `cursorHitTest` and `button` in ss64. | **Observed**: nothing in LWE produces cursor events. Grep finds no `cursorClick` outside the corpus, and `m_queuedEvents` only gets media events. | 22 (e.g. 2325974975, 3104056709, 3219908811) | Click and hover interactions (menus, drag widgets, click sounds) do nothing. | **Done (0041, 0043).** Enter/leave/move to every solid image layer under the cursor (shown or hidden), down/up/click to the shown ones; text and particle layers aren't hit-tested. See "B10 result". |
| S11 | Media events never reach scripts | **Documented**: `mediaPlaybackChanged/PropertiesChanged/ThumbnailChanged/TimelineChanged/StatusChanged` (reference.html). | **Observed**: the events are queued only to property "modules", which are Promises (S1) (Scr/ScriptEngine.cpp:610-623). They are never delivered to text-layer IIFEs. liascape never calls `wp_project_notify_*`; the only hits are the headers in include/linux-wallpaperengine/project.h:444-469. | 19 (16 in text scripts: e.g. 2134765860, 3013489778, 3042492564) | "Now playing" title/artist texts stay at the placeholder, and media widgets stay hidden. | **Done (0039, 0040; worker `media.rs`).** Property and text-layer scripts get them, in a fixed order; liascape's worker reads MPRIS. |
| S12 | `MediaThumbnailEvent` colours are hard-coded and `textColor` is missing | **Documented/Observed**: `primaryColor secondaryColor tertiaryColor textColor highContrastColor hasThumbnail` (ss64; D-class/MediaThumbnailEvent). | **Observed**: fixed greys 0.12/0/0.25/1 and no `textColor` (Scr/ScriptEngine.cpp:666-686). | 10 (e.g. 2890767643, 3042492564, 3243449890) | Album-art tinted UI is grey, and `textColor` is undefined, which leads to a NaN colour. | **Done (0039).** Colours from the art (most common + next distinct; WE's extraction not decoded), textColor ≥ 4.5 contrast, highContrastColor black/white. |
| S13 | `MediaPropertiesEvent` fields missing | **Documented**: `title artist contentType albumTitle subTitle albumArtist genres` (D-class/MediaPropertiesEvent). | **Observed**: only `title`, `artist` and `albumTitle` (Scr/ScriptEngine.cpp:653-657). | 3 use the missing fields (3013489778, 3291729669, 3291745179) | The album-artist line is "undefined". | **Done (0039).** `wp_project_notify_track_metadata_extra`; the worker sends album artist and genres, contentType "music". |
| S14 | `mediaStatusChanged`/`MediaStatusEvent.enabled` never sent | **Observed**: `mediaStatusChanged` and `enabled` in ss64. | **Observed**: no producer. | 1 (2890767643) | The widget never learns that media integration is on. | **Done (0039).** `wp_project_notify_media_status`; the worker sends `true` with a session bus. |
| S15 | `applyUserProperties` is never called and `engine.userProperties` is missing | **Documented**: it is called once on load and on every change, with the changed props. `engine.userProperties` holds the current values, with colours as Vec3 (D-class/IEngine; bc:1401-1418). | **Observed**: neither exists. EngineObject has no `userProperties` (Scr/EngineObject.cpp:169-221, "TODO: ADD THE REST"), and the text shim `engine` has none either (Scr/ScriptEngine.cpp:376-379). | applyUserProperties 18; engine.userProperties 7 (4 in text scripts: 1884904087, 2325974975, 3042492564, 3163060610) | User options handled in script (12/24h clock, language, colour themes, toggles) are ignored. Text scripts that read `engine.userProperties.x` in `update` throw every frame, so the text never updates. | **Done (0038).** `applyUserProperties` gets the changed properties on every change; `engine.userProperties` is live. |
| S16 | Other events missing: `resizeScreen`, `applyGeneralSettings`, `destroy`, `animationEvent` | **Observed** in ss64; **Documented** in reference.html. | **Observed**: not dispatched. `destroy` exists only for text layers (Scr/ScriptEngine.cpp:509-542). | resizeScreen 1 (3042492564), animationEvent 1 (3163060610), applyGeneralSettings 0, destroy 0 | Layout on resize and animation-end callbacks are missing. | **Partly done (0038; coverage batch 0068).** `applyGeneralSettings` (once, the locale's language), `animationEvent` (keyframe `options.events`) and `destroy` are sent now; `resizeScreen` still not (no resize reaches the core). See `we-coverage.md`. |
| S17 | `engine.registerAudioBuffers` missing | **Documented**: it returns AudioBuffers with `left/right/average` Float32Array of length 16/32/64, values about 0..1, index 0 = bass (D-class/AudioBuffers). **Observed**: "Resolution must be either 16, 32 or 64." and "registerAudioBuffers can only be called from global scope." (ss64). | **Observed**: only the `AUDIO_RESOLUTION_*` constants exist (Scr/EngineObject.cpp:190-201), so the top-level call throws TypeError and the module fails. | 20 (11 feed effect uniforms; e.g. 2134765860, 2290002190, 2469881470) | Audio visualisers driven by script (bars, pulsing scale, uniform audio) are static. | M: an FFT bins → Float32Array per frame, the same data as `g_AudioSpectrum16Left…` |
| S18 | `engine.timeOfDay` is always 0 | **Documented**: 0.00..1.00 over 24 h local time (D-class/IEngine). | **Observed**: it returns `Context::daytime`, which is initialised to 0 (src/core/WallpaperEngine/Context.cpp:15) and never written. The text shim lacks it entirely. | 2 (2134765860, 3046119914) | Day/night logic is stuck at midnight. | S: `(h*3600+m*60+s)/86400` from localtime |
| S19 | `engine.canvasSize` and `engine.screenResolution` missing | **Documented**: both are Vec2 (D-class/IEngine). | **Observed**: absent (Scr/EngineObject.cpp:158-222). | canvasSize 14, screenResolution 2 (e.g. 3042492564, 3219908811) | Layout, drag clamping and bounce code throws. | **Done (0038).** `screenResolution` is the scene's size (the core doesn't know the output's). |
| S20 | `engine.is*()`, `registerAsset`, `isObjectValid` and `clearTimeout` missing | **Documented/Observed**: `isDesktopDevice isMobileDevice isWallpaper isScreensaver isPortrait isLandscape isRunningInEditor registerAsset isObjectValid clearTimeout` (D-class/IEngine; ss64). | **Observed**: absent. | isRunningInEditor 3, isScreensaver 1 (3163060610, 3363252053, 3414858021, 2890767643) | TypeError, so the guarded script aborts. | **Done (0038).** Constants (desktop, wallpaper, not editor); `registerAsset` returns `{file}`. `clearTimeout` is not added (no library scene calls it; setTimeout's stop function works). |
| S21 | `engine.openUserShortcut` is a stub | **Documented**: opens the bound User Shortcut property, allowed only inside cursor callbacks, and returns a bool (D-class/IEngine). | **Observed**: returns `undefined` and does nothing (Scr/EngineObject.cpp:16-18). | 1 (3516106265) | Click-to-launch does nothing (also blocked by S10). | **Decided (0038): ignored.** Returns false ("no shortcut was called"). |
| S22 | Timer bugs | **Documented**: `engine.setTimeout/setInterval(cb, ms)` return a stop function (D-class/IEngine). **Observed**: "setTimeout cannot be called from global scope." (ss64). | **Observed**: the callback is stored without `JS_DupValue` and freed on clear/fire (Scr/EngineObject.cpp:121,151,246,255,267,279,317), which risks use-after-free or a double free. Callback exceptions and return values are dropped (:300,:315). The text shim `engine` has no timers (Scr/ScriptEngine.cpp:376-379). | 14 (3 from text scripts: 2932157836, 3042492564, 3163060610) | Text: `engine.setInterval` throws, so blinking separators and rotating texts break. Property path: possible crash once S1 is fixed. | **Done (0020).** Callbacks are owned and their errors logged; the stop function works; text scripts reach the real timers. Was: S |
| S23 | `input` is mostly stubbed | **Documented**: `cursorWorldPosition` Vec3 in scene units, `cursorScreenPosition` from top-left, `cursorLeftDown` (D-class/IInput). The units of the screen position are **Unknown**. | **Observed**: world position is always (0,0,0) (Scr/InputObject.cpp:9-15). Screen position is normalised 0..1 (:17-28). `cursorLeftDown` is always false (:30-33). | world 7, screen 1, leftDown 0 (e.g. 3104056709, 3243449890, 3326873240) | Cursor-follow and parallax-by-script layers don't move. | **Done (0041).** `cursorWorldPosition` in scene pixels (y up), `cursorLeftDown`; `cursorScreenPosition` is normalised 0..1 (it read 0 0). |
| S24 | `thisScene.getLayer(n)` semantics | **Documented**: `getLayer(name or index)`. Any layer type works (D-class/IScene). | **Observed**: a number is treated as an object **id**, not an index. Only image/text/particle objects are returned, so sound, group and light give undefined (Scr/SceneObject.cpp:136-187). | getLayer 11 (numeric 0) (e.g. 2325974975, 3104056709) | `getLayer('sound').play()` and group handles throw. | **Done (0038).** A number is the layer index (scene.json order); every type is a layer (groups, sounds). |
| S25 | ILayer writes silently ignored | **Documented**: `origin angles scale visible parallaxDepth` are read/write. Image `alpha/color` and text `text/pointsize…` are writable (D-class/ILayer, D-class/IImageLayer, D-class/ITextLayer). | **Observed**: the exotic `set_property` returns 0 without storing anything (Scr/Adapters/ScriptableObjectAdapter.cpp:50-68). Gets return only registered names, and other names are `undefined` (:23-48). | 28 assign layer props (e.g. 2134765860, 2325974975, 2469881470) | Scripts that move, hide or recolour *other* layers (or `thisLayer` from event handlers) do nothing. | **Done (0038).** Registered properties write live; other names are kept on the layer's one JS object; `solid` writes. |
| S26 | ILayer/IImageLayer methods missing | **Documented**: `getAnimation getParent getChildren setParent getAttachment* getTransformMatrix rotateObjectSpace`, plus `getTextureAnimation getVideoTexture getEffect getEffectCount getAnimationLayer* playSingleAnimation`, bones and blend shapes (D-class/ILayer, D-class/IImageLayer). `size` and `solid` are props. | **Observed**: none are defined. The adapter only exposes property DynamicValues (Scr/Adapters/ScriptableObjectAdapter.cpp:23-48), so calls throw TypeError. | getAnimation 18, size 16, getTextureAnimation 7, getParent/getTransformMatrix 5, getAnimationLayer 3, getVideoTexture 2, getEffect 1 | Sprite-frame control (`setFrame`/`getFrame`, e.g. 2325974975 waits for frame 165), puppet animation layers and timeline animations scripted from code are dead. | **Partly done (0038, 0040).** getEffect/getEffectCount, getTextureAnimation, getParent/getChildren, size, getAnimation/IAnimation. **Coverage batch (0065, 0068):** getVideoTexture, getAnimationLayer* / create / playSingle / destroy, bones, getTransformMatrix, setParent, getAttachment*, IMaterial stub, setMaterialProperty. Left: bone physics, blend shapes, transformAttachmentToTexture (`we-coverage.md`). |
| S27 | Sound layers not scriptable | **Documented**: `ISoundLayer.volume`, `play()` (only if not playing), `stop()` (rewinds), `pause()`, `isPlaying()` (D-class/ISoundLayer). Spike § Q3: `startsilent` only starts through `play()`. | **Observed**: `CSound` is not a `ScriptableObject` (Ren/Objects/CSound.h:35). `CSound::play()` exists but has no caller (CSound.h:51-55), and `getLayer` can't return sounds (S24). | startsilent + script play 2 (2325974975, 3289734539); sound controlled from script 1 (3432999904) | Click and event sounds never play, and script mute/play toggles do nothing. | **Done (0038).** play/stop/pause/isPlaying/volume. |
| S28 | Text-layer props other than `text` are not script-visible | **Documented**: ITextLayer `text color alpha opaquebackground backgroundcolor pointsize font padding horizontalalign verticalalign anchor limitrows maxrows limitwidth maxwidth` (D-class/ITextLayer). | **Observed**: in a text IIFE, `thisLayer={text}` only (Scr/ScriptEngine.cpp:365). Through getLayer, only the registered names are visible, and the key is `pointSize`, not `pointsize` (Ren/Objects/CText.cpp:83). | 6 (horizontalalign/verticalalign 5, pointsize 1: 2134765860) | Auto-shrinking song titles and alignment switches have no effect. | S |
| S29 | Text-script shims shadow the real `engine`/`thisScene` | **Inferred**: WE gives every script the same globals (reference.html). | **Observed**: the IIFE-local `engine={frametime,time}` and `thisScene={time,currentTime,dt,fps}` hide the real objects (Scr/ScriptEngine.cpp:366-379). `engine.runtime`, `userProperties`, `setInterval`, `setTimeout`, `registerAudioBuffers`, `timeOfDay`, `canvasSize` and `thisScene.getLayer` all throw. | 8 (userProperties 4, setInterval 3, runtime 1, getLayer 1, setTimeout 1: 3042492564, 3163060610, 3509243656, 2325974975) | Clock and lyric texts with options or timers freeze on the placeholder or the last value. | **Done (0038).** `thisLayer` is the real layer too. |
| S30 | Text-script lifecycle differences | **Documented**: `init` runs once after creation, with `(value)` for property-attached scripts (D-event/init). **Inferred**: updates run while the layer is hidden. | **Observed**: `init()` is called with no argument on the first *visible* render. `update` is skipped while `visible` is false (Ren/Objects/CText.cpp:377-394). `'use strict'` is stripped, so the IIFE is sloppy mode (Scr/ScriptEngine.cpp:344-352). The same text is also evaluated a second time as a module via `registerProperty("text")` (Ren/Objects/CText.cpp:84), so top-level code runs twice. | init(value) 2 (2932157836, 3042492564); all 41 text scenes get the double eval | Small: top-level side effects (`shared.*`) run twice. | **Done (0038).** `init (value)`; the script runs while the layer is hidden. |
| S31 | Text-script `scriptproperties` are snapshotted at creation | **Observed**: WE overlays stored values on every update (`_Internal.updateScriptProperties`, bc:1389-1399) and re-applies on user-property change (Inferred). | **Observed**: `createLayerScript` copies the values once (Scr/ScriptEngine.cpp:328-336). | 21 have user-bound text scriptproperties (e.g. 2134765860, 2511663284) | Changing a bound user property (24h, colour, format) in the UI doesn't reach the text until reload. | **Done (0038).** Script properties are read live. |
| S32 | `addCombo` default | **Observed**: the default is `options[0].value` (bc:1443-1447). | **Observed**: the text shim uses `o.value`, which is undefined for combos (Scr/ScriptEngine.cpp:384). | 1 has a combo absent from scene.json (3163060610); 19 use addCombo | Rarely visible: the combo reads `undefined`. | **Done (0038).** A combo's default is its first option. |
| S33 | `Vec2/3/4` constructor semantics | **Observed** (bc:238-261): `new Vec3(x,y,z)`; `new Vec3()` = 0; `new Vec3(n)` = (n,n,n); `new Vec3("x y z")`; `new Vec3(vec2)` with z=0; missing args become 0. | **Observed**: only `argv[0]` is used and broadcast, so `new Vec3(1,2,3)` = (1,1,1) (Scr/Adapters/VectorAdapter.cpp:372-392, 89-104). `new VecN()` throws (:373-375). String/Vec2 arguments throw a C++ `std::runtime_error` through a C callback, which risks terminate (:146). | multi-arg 20, no-arg 4 (e.g. 2469881470, 2932157836) | Once S1 is fixed, every computed vector is wrong, giving diagonal motion and grey colours. | **Done (0020).** WE's `baseclasses.js`, loaded from the user's assets. Was: S: replace with WE's own `baseclasses.js` (JS classes) |
| S34 | Vec instance methods unreachable | **Observed**: Vec2/3/4 are JS classes with about 30 methods each, including `reflect`, `distance`, `negate`, `clamp`, `mix`, `angle`, `rotate` and `toSpherical` (bc:4-785). Mat3/Mat4 too (bc:786-1363). | **Observed**: the exotic `get_property` returns `JS_EXCEPTION` for every name except x/y/z/w (Scr/Adapters/VectorAdapter.cpp:160-193), and quickjs-ng consults it before the prototype (QJS/quickjs.c:8737-8745). So `v.add()`, `.copy()`, `.length()` and `toString` all throw. `lengthSqr` is bound to `length` (:856-857). `reflect` and the others don't exist, and there is no Mat3/Mat4. | 26 call vector methods (e.g. 2469881470, 2679248947, 3219908811); reflect 6; Mat 0 | Any vector math aborts the script. | **Done (0020).** Was: S: load `scripts/jsclasses/baseclasses.js` from WE assets, as WE does (ss64 names it) |
| S35 | `WEVector` module missing | **Observed**: `jsmodules/wevector.js` exports `angleVector2` and `vectorAngle2` (weassets). ss64 loads `scripts/jsmodules/`. | **Observed**: only `WEMath` and `WEColor` are native modules (Scr/ScriptEngine.cpp:211-215), so `import … from 'WEVector'` fails module resolution. | 3 (3219908811, 3233141951, 3243449890) | The whole script fails to load. | **Done (0020).** `scripts/jsmodules/<name>.js` from the user's assets. Was: S: load the `.js` modules from the WE assets |
| S36 | `localStorage` semantics | **Documented**: `get/set/delete/clear(key, location)`, `LOCATION_GLOBAL` (`"global"`) and `LOCATION_SCREEN` (`"screen"`, the default). It persists across sessions, up to 100 KB per wallpaper, and is cleared on Reset (D-class/ILocalStorage). **Observed**: the persistent `LSKV0001` store in ss64. | **Observed**: an in-memory JS object, lost on every load. `set` stores `String(value)`, so numbers come back as strings and objects as "[object Object]". It has a non-WE `remove`, no `delete`, and no `LOCATION_*` (Scr/resources/builtins.js:2-11). | 8 (e.g. 3163060610, 3243449890, 3319542538) | Saved positions and settings reset on every start, and `get()+1` string-concatenates. | **Done (0042).** Persists in the host's storage dir (liascape: `~/.local/state/liascape/scene-storage/<id>.json`). |
| S37 | `thisScene` methods and setters | **Documented**: `getLayerCount enumerateLayers createLayer destroyLayer sortLayer getLayerIndex getInitialLayerConfig get/setCameraTransforms createModelData`. All properties are writable (D-class/IScene). | **Observed**: only `getLayer` exists (Scr/SceneObject.cpp:303-307). Setters return `JS_EXCEPTION` with no pending exception (:190). Getter bugs: `clearenabled` returns bloom (:34-38), `skylightcolor` returns ambient (:56-62), and `bloomstrength`/`bloomthreshold` are truncated to int (:22-32). | sortLayer 5, getLayerIndex 5, createLayer 4, enumerateLayers 1 (e.g. 2469881470, 2828233985, 2890767643) | Layer reordering and spawned layers (cursor trails, particles) are missing. | **Partly done (0038).** getLayerCount, enumerateLayers, getLayerIndex, sortLayer, writable properties, getter fixes. **Coverage batch (0065, 0069):** createLayer / destroyLayer, get/setCameraTransforms, getInitialLayerConfig, getLayerByID, getAnimation. Left: createModelData (`we-coverage.md`). |
| S38 | WEMath/WEColor signature strictness | **Observed**: plain JS functions (`mix(a,b,v)=a+(b-a)*v`, `smoothStep` clamps; jsmodules/*.js). | **Observed**: native functions throw unless they get exactly 3 numbers (Scr/Modules/MathModule.cpp:23-61). WEColor returns Vec3 adapters, which inherit S34. | WEMath 16, WEColor 2 | An extra or undefined argument aborts the script. | **Done (0020).** Was: S: load the WE `.js` modules instead (with S35) |

### Notes

- **What works today.** The text-layer path (S29-S32 aside) runs the library's clocks, dates and FPS counters.
  - The commonest scripts are the WE "24h/12h clock" template (17 scenes) and the FPS counter (5).
  - `new Date()` (40 scenes) uses QuickJS's local time (`localtime_r`, TZ honoured), the same as WE's V8 on the
    Windows timezone. No `toLocale*`/`Intl` is used in the library.
  - `engine.frametime` in text scripts is the scene dt in seconds.
  - `shared` (`globalThis.shared`) is one object for all scripts, as in WE (bc:1457).
  - `console.log/error` exist.
- **Inside S1, what is inferred and what is observed.** That a module eval returns a Promise is observed in quickjs-ng's own tests.
  The zeroing chain is read from LWE source. The live check (`scene_corpus.sh`) could not start because the
  results path was over the Unix-socket limit, so S1/S2 are **not runtime-confirmed**. A capture of 3291729669 (a text whose
  `origin` has a script) should show its text at the bottom-left corner if S2 holds.
- **Rows behind S1.** S5-S9, S22 (property path), S25-S26 and S33-S34 sit behind S1. They become visible the moment S1 is
  fixed, so fix them together. Porting WE's own `baseclasses.js` + `jsmodules/*.js` (evaluated as the
  prelude, as ss64's `scripts/jsclasses/baseclasses.js` and `_Internal` strings show) removes S8 (builder), S33,
  S34, S35 and S38 in one step. LWE's native Vec adapters would then only be needed for property marshalling.
- **WE's API registration is in scenescript64.dll** (V8, `CreateSceneScriptEngine` export), not in wallpaper64.exe.
  The exe only carries the layer field names (`getEffect getMaterial setMaterialProperty executeMaterialFunction
  emitParticles instance getTextureAnimation setFrame isPlaying frameCount …`). No GH/REA decompile was needed for
  the rows above. Every WE claim is a docs page, a WE asset file or a dll/exe string.
- **Not verified / Unknown.**
  - What WE does with a non-string return from a text update.
  - Whether WE runs `update` for hidden layers.
  - The units of `cursorScreenPosition`.
  - WE's `localStorage` missing-key result.
- **Evidence files.** `work-scenescript/{extract_scripts.py,stats.py,api.py,textcls.py,scripts.json,api.txt,ss_strings.txt}`.

**Lead's runtime check of S1/S2** (`--lwe-smoke`, LWE 45ed25c):

- **2890767643:** the scripted media widget (`playerplay`, `playervolume`, the progress bar, all with `origin` scripts) is absent, except for a white bar at the bottom-left corner. That is what S2 predicts: origin zeroed to (0,0).
- **2325974975:** stderr repeats `ScriptEngine [layer.update]: TypeError: not a function` every frame, the S33/S34 class of failure.

This is consistent with S1/S2. The WE captures under "Needs the owner" still have to confirm the WE side.

**Correction (B1, 2026-10-29).** Both readings above were wrong about the cause. In 2890767643 the white bar at the
bottom-left is `progress_bar` (id 225) at its own JSON origin (129.8, 188.0): it is the year-progress widget, drawn
where its author put it. The media widget's layers are `visible: false` in scene.json and are shown by their scripts
through layer writes, cursor events and media events (S10, S11, S25, S37), so they stay hidden until B10. The
`layer.update` TypeError in 2325974975 came from the text script's `thisScene.getLayer(…)` on the text shim (S29), not
from the vector classes.

### B1 result (fork patches 0019–0021, pin `e78d94d`, 2026-10-29)

- **What runs now.** Every property script is compiled as a module, evaluated on the first tick (in queue order),
  then gets `init(value)`, `applyUserProperties(<all user properties>)` once, and `update(value)` every tick. Its
  namespace is kept, not the Promise. An `undefined`/`null` return writes nothing. `thisLayer`/`thisObject` are
  bound per module. scale/angles/visible drive the rendered values. The prelude is **WE's own
  `scripts/jsclasses/baseclasses.js`**, and `import 'WEMath' | 'WEColor' | 'WEVector'` loads
  `scripts/jsmodules/<name>.js`. Both are read **at run time from the user's WE assets** (they sit under
  `assets/scripts/`, which LWE already mounts at `/`), so no WE JS is copied into this repo or the fork. Without
  them, bare documented-API Vec constructors stand in. The native Vec/WEMath/WEColor adapters are deleted.
- **Bugs found on the way** (in 0020 unless noted). These were invisible while nothing ran:
  - The layer adapter's exotic get/set was never installed, so every `thisLayer.x` and `getLayer(…).x` read
    `undefined`.
  - The engine object never registered itself, and its functions were plain `JS_CFUNC_generic` with a magic
    argument, so every `engine.*` call failed without an error.
  - Timer callbacks were not `JS_DupValue`d.
  - The stop function read its id from `argv`.
  - **0019:** `Configuration` left `noSolidFinal` uninitialised. Heap garbage dropped every solid layer's final draw,
    so a solid layer showed in one process and not in another.
  - **0021:** the getter logged once per missing name.
- **Smoke** (`--lwe-smoke … --seconds 3`, 3 s frame, before = 45ed25c):
  - **3291729669:** the "Written Date" text (origin/scale/angles scripts) sat at the top-left corner (0,0), mostly
    off-screen. It now sits at its origin (246, 190), above the clock. Its scale script needs `applyUserProperties`
    to set `speed`; without it, `mix(…, undefined)` = NaN would hide it. No script errors.
  - **2890767643:** the frame is pixel-identical (AE 0). As corrected above, nothing was at (0,0), and the widget
    needs B10. stderr has 7 `TypeError: not a function`, all B10 APIs: `engine.registerAudioBuffers` (S17,
    `visible_35`, `alpha_118` at load), sound-layer calls (S27, `origin_118`), and
    `thisLayer.size`/`createLayer` (S26/S37, `visible_225`).
  - **2325974975:** the frame is identical apart from 5 px of clock text. The text script's per-frame TypeError is
    gone: it now reaches the real `thisScene.getLayer` (S29 partly). 3 property scripts still throw
    `TypeError: not a function` from `thisLayer.getTextureAnimation()` (S26). Each is logged 5 times, then
    silenced.
  - So the B1 check "stderr has no `TypeError: not a function`" can't hold for 2890767643/2325974975 before B10. The
    remaining TypeErrors are missing APIs, logged now (they were silent before B1).
- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`): 8x8 solid squares in a 64x32 scene, read back
  from the centre row. All three are RED on 45ed25c.
  - `update_moves_the_property`: `value.add(new Vec3(1,0,0))` moves 1 px per tick. A `visible` script reading
    `thisLayer.origin.z == 5` keeps it shown (z kept, own `thisLayer`). A second object's
    `return thisLayer.origin` stays put.
  - `init_runs_first_and_modules_load`: `init` runs once before `update`, `WEMath.mix` imports, and
    `applyUserProperties` gets the user properties. `init`'s Vec3 return scales a square 2x.
  - `undefined_leaves_the_property`: no `return`, `return null`, and a module whose top level throws all leave the
    origin alone.
- **Corpus** (`scene_corpus.sh --results /tmp/lc-b1`, 96 scenes, same release player/worker + the B1 core): ok 92,
  static 1, blank 0, load_failed 3, renderer_failed 0, crashed 0, broken 0, timeout 0. The report (90 ok, 2 timeout)
  differs only in 2883756643 and 2890767643, which went from timeout to ok. Their first frames came in 7.8 s and 1.5 s this run.
  The report's timeouts were a slow, shared machine. B1 doesn't touch the load. No scene is newly blank, broken,
  crashed or timed out. The static (2783122117) and the 3 load failures are the same as before.

### B2 result (fork patches 0022–0023, pin `ccb545d`, 2026-11-02)

Rows E2, E3, G01 and G02 are done. G05 is still Unknown. The animation half of G02 (SceneScript `getAnimation`,
play/stop, events) is left to B10.

- **0022: object uniforms are live, and `g_Color4` is (colour, alpha).** `g_Brightness`, `g_UserAlpha`, `g_Alpha`,
  `g_Color`, `g_Color4` and `g_CompositeColor` are now bound to the live values' addresses. Before, CPass stored a
  copy taken at setup (E3). `g_Color4` is (`g_Color.rgb`, `g_Alpha`) as in WE's draw-context case 2 (E2). CImage
  keeps it in a member that `render()` refreshes. Before, it was the colour's own w, which was 1, or 0 after a
  script wrote a Vec3.
- **0023: keyframe animations play.** These were decoded further from the same wallpaper64.exe. Besides
  0x1401d1740, 0x1401d4dd0 and 0x1401d5790, which were already known:
  - `FUN_1401d5c50` bakes a curve into one float per whole frame.
  - `FUN_1401d6a00` is the clock.
  - The sampler sits in `FUN_1401a19e0`.

  What was settled:
  - **Keys.** A key is 28 bytes: frame, value, flags (bit 0 back enabled, bit 1 front enabled, bit 2 `step`),
    back x/y and front x/y. A handle is enabled unless `"enabled": false`, and a disabled handle is (0, 0). Keys
    must move forward in frame, and one that doesn't is dropped.
  - **Segment shape.** The control points are (A.front.x / 2, A.value + A.front.y) and (1 + B.back.x / 2,
    B.value + B.back.y). The x handle is in half-segments, not frames, and is not divided by the segment length.
    The y handle is in value units. x is solved by Newton steps inside a bisection bracket: at most 24 steps,
    tolerance max(0.01 / segment frames, FLT_EPSILON).
  - **Linear and step segments.** A segment is linear when all four handle numbers are 0, or when both control
    points lie on the line. A `step` on B holds A's value. Before the first key and after the last, the end
    values hold.
  - **Sampling.** The value at time t is a linear blend of whole frames ⌊t·fps⌋ and that frame + 1, clamped to
    [0, length].
  - **Clock.** `loop` wraps by fmod. `mirror` reflects at both ends. `single` stops at `length` and sets a
    finished bit. `startpaused` never advances. `wraploop` drops keys past `length`, then sets a key at `length`
    to a copy of the first key: same value and step, with its front handle negated as the back handle.
  - **`relative`.** It adds the value to c0..c2 only when the value is an "x y z" string. A number adds nothing,
    as observed.

  The animated values are collected while the scene is parsed (`Scene::animatedValues`). Each frame they are
  advanced by the host clock's dt and written before the script tick. This covers object properties and effect
  constants alike. In the library that is 179 animated values: alpha 63, origin 28, effect constants 85 (most
  are `multiply`), angles 9, scale 3, and 3 particle instance overrides.
- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`). Every value below matches the decoded maths.
  All three tests fail on e78d94d, and the whole suite is 19/19 on ccb545d.
  - `object_uniforms_are_live`: an alpha script returning 0.25 gives r = 64 (255 before), and a colour script
    reaches the shader. The test ships its own `gl_FragColor = g_Color4` layer, which reads alpha 0.5 as r = 127
    (255 before).
  - `keyframes_drive_alpha` checks white squares at tick 15:
    - linear 0→1 over 30 frames: 127;
    - the bezier ease (front x 0.6, back x −0.2): 104, which is 0.408 against 0.5 linear;
    - `single`: holds 0.2 (51);
    - `startpaused`: stays at frame 0 (191 = 0.75);
    - `step`: holds 0.9 (229), then drops to 0.1 (25) at its key;
    - `wraploop`: 127 on the way back;
    - the loop wraps (42 at tick 35).
  - `keyframes_move_origin`: a `relative` origin moves from 8 to 23 in 15 ticks. A `mirror` origin reaches 50 at
    frame 10 and is back at 45 at tick 15.
- **Smoke** (`--lwe-smoke`, 12 animated or translucent scenes, at 3 s and 6 s, before = e78d94d). 11 of the 12
  differ from before (AE at 3 s, out of 2.07 M or 8.3 M px). The exception is 2134765860, with 57 px: its
  animated `multiply` constants are `startpaused` and played by a `mediaThumbnailChanged` script (B10), and its
  one free-running track is a small `angles` loop. Where WE animates, the 3 s→6 s difference grew:
  - **3028473503:** its smoke failed "not animating" before, with 0 px changing from 3 s to 6 s. Now 38.8 k px
    change and the check passes. It is a 4K video scene whose image layers fade.
  - **3516174947:** 100 k → 430 k px change between 3 s and 6 s.
  - **3042492564:** 27 k → 115 k px change between 3 s and 6 s.
  - **2325974975:** a layer's alpha loop (1 → 0.52 → 1) and its origin bob now play: 66 k px differ at 3 s.
  - **2371103399:** the cloud layer (alpha < 1, genericimage4) was drawn as opaque white puffs. It now blends into
    the sky, and its 3 s→6 s change dropped from 60 k to 12 k px. Its scrolling clouds are translucent now, so
    they change less.
  - **3289734539:** the yellow "appear" panel at the bottom-left is gone. Its track is `startpaused` with alpha 0
    at frame 0, and WE shows it only when a `cursorClick` script calls `getAnimation("appear").play()` (B10). So it
    is correct for WE until the click exists.
  - **2388299037:** the translucent layer (the audit's E2 example) is now translucent. The owner's WE capture is
    still the reference.
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b2`, 96 scenes, a release player and worker on the B2 core): ok
  93, static 0, blank 0, load_failed 3, renderer_failed 0, crashed 0, broken 0, timeout 0. Against B1 (ok 92,
  static 1), **2783122117 went from static to ok.** It has two `origin` animations, and they now move it. The
  same 3 scenes fail to load: 3276522107, 3477054430 and 3509243656. No scene is newly blank, broken, crashed or
  timed out.
- **Left of B2:** `timeofday` mode (not used in the library). `options.parent`/`children` shared timelines (29/18
  tracks): each property runs its own clock from the same start, so they agree until a script drives one. Also
  `random`, animation `events` (1 scene), and the SceneScript animation API. `thisObject.getAnimation()` is called
  by 18 scenes, mostly from media/cursor events, so it belongs to B10. Particle `g_Color4` still has w = the
  colour's own w (particles draw through CParticle). G05 parent alpha is still Unknown.

### B3 result (fork patches 0024–0028, pin `4c75eae`, 2026-11-03)

Rows P1, P3, P4, P5, P6, P7, P8 (without NPOT), P13, P14, P18, P19 and P38 are done. So is P16, which was in no
batch: sphererandom now has duration, delay and periodic emission through the shared emitter timer. P41 needed
no change: every system in the library sets maxcount and sizerandom, and LWE's `/2` default size already matches.

- **0024: one particle RNG per scene** (P38). `CScene::getParticleRng` is WE's scene+0x1f08. Every system draws
  from it, and a `randomframe` frame is one draw from it. Before, it was seeded by the particle's slot address, so
  frames repeated per slot. `WPENGINE_PARTICLE_SEED` seeds it for tests.
- **0025: initializers draw as in WE** (P6, P7). `colorrandom` draws one `t` for R, G and B. `exponent`
  (`pow(rand, exponent)`) is now read by lifetimerandom, colorrandom, alpharandom, velocityrandom and
  rotationrandom (per axis) too. Lifetimes are at least 0.001 s.
- **0026: particle timing** (P1, P3, P4, P13, P14, P18, P19).
  - `starttime` is a float. On setup the system steps in 0.05 s steps (0.2 s from maxcount 500) until it reaches
    it, at least once.
  - The `rate` override scales the system's whole step, at least 0.01: motion, ageing and emission together.
  - `count` multiplies every emitter's rate and a mapsequence count, unless the flags have 0x20. The pool stays
    `maxcount`.
  - The overrides are read every frame, so sliders and animations on them are live. Alpha and size still apply
    at spawn, which is also what WE does (P13: +0x3ec is read by the spawn interpreter only).
  - Box and sphere emitters share one timer: delay, duration, and periodic windows that reload the
    instantaneous burst. The burst adds to the frame's rate emission (sphere replaced it).
  - A hidden system with particles is cleared and its emitters reloaded, so it starts fresh when shown and
    bursts replay. Before, it froze and caught up 0.1 s on its first visible frame.
  - The operators run on the system's own clock (prewarm included), not the render time.
- **0027: `colorn` is an HSV shift** (P5). The reference colour is the system's first colorrandom mid-point,
  else its colorchange startvalue, else white. A `colorn` the object sets, that differs from it by ≥ 0.9/255
  with flags lacking 8, moves colorrandom's min and max by (colorn − reference) in H, S and V. A system without a
  colour source spawns at colorn. It is re-evaluated every step.
- **0028: `SPRITESHEETBLEND`** (P8) unless the particle flags have bit 1 or `animationmode` is randomframe.
  `SPRITESHEETBLENDNPOT` (6 padded sheets) is not done: its shader path needs the sheet's unpadded width in
  `g_Texture0Resolution.z`, which is the frame width in LWE.
- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`). Additive grey particles stack at fixed points
  of a 64×32 scene, so the red channel counts them. All four fail on ccb545d (0 of 4), and the whole suite is
  23/23 on 4c75eae.
  - `particle_count_rate_and_prewarm`: before the first step, a starttime-1 system has 10.0 particles (0 before).
    After 1.5 s: plain 14.0, count 2 29.0 (14.0 before), rate 0.5 with 0.6 s lives 6.0 (3.0 before), and the
    prewarmed one 24.0.
  - `particle_colorrandom_one_t`: a 0 0 0 → 255 0 255 range with exponent 4 gives 0 of 651 px with r ≠ b (664 of
    680 before) and a mean r of 49.3 (51 expected, 124.6 before).
  - `particle_colorn_hsv_shift`: red + colorn blue is 0 0 252 (black before). Grey 128 + colorn 0.5, its own
    reference, stays 126 (63 before). No colour source + colorn red is 252 0 0.
  - `particle_hide_resets_and_overrides_live`: a 5-particle burst hidden and shown at 1.1 s is alive again at
    2.7 s (0 before). A `count` slider moved 1 → 3 adds 30 particles in 1 s (10 before).
- **Smoke** (`--lwe-smoke … --seconds 60`, 10 particle scenes, before = ccb545d with the same worker through
  `LD_LIBRARY_PATH`). The particle count came from a throwaway instrumented core of each rev (one `PSTAT` line per
  system per frame, not committed), summed over all systems at +1 s and +60 s:

  | Scene | Systems | Before +1 s / +60 s | After +1 s / +60 s |
  |---|---|---|---|
  | 1155728109 | 3 | 12 / 175 (0.07) | 156 / 171 (0.91) |
  | 1174926427 | 1 | 23 / 299 (0.08) | 299 / 300 (1.00) |
  | 1195626192 | 2 | 10 / 45 (0.22) | 38 / 42 (0.90) |
  | 1556245028 | 7 | 12 / 33 (0.36) | 23 / 29 (0.79) |
  | 1726902114 | 2 | 4 / 17 (0.24) | 8 / 19 (0.42) |
  | 1797172968 | 3 | 11 / 97 (0.11) | 8 / 17 (0.47) |
  | 1884904087 | 1 | 3 / 16 (0.19) | 7 / 8 (0.88) |
  | 1934084447 | 2 | 36 / 461 (0.08) | 458 / 477 (0.96) |
  | 2064316482 | 5 | 403 / 842 (0.48) | 2129 / 2130 (1.00) |
  | 3419466417 | 12 | 289 / 1317 (0.22) | 1371 / 1436 (0.95) |

  So the check "+1 s ≈ +60 s" holds for 8 of the 10. The other 2 follow WE's own rule, since the prewarm stops at
  `starttime`:
  - **1726902114:** leaves2 has starttime 3 and lives 8–10 s, so it starts at about a third of steady state.
  - **1797172968:** its snow has starttime 15 and lives of 16–40 s (lifetime override 2). Its leaves (count
    0.01) dropped from 88 to 1 at +60 s. Before, `maxcount·count` = 0 fell back to LWE's 1000 pool at the full
    rate. WE emits 5 × 0.01 per second.

  **1884904087** went from 16 to 8 at +60 s: its leaves have count 0.38, rate 0.72 and lifetime 0.5. Visually
  (1934084447) the snow covers the frame at +1 s now, as at +60 s.
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b3`, 96 scenes, a release player and worker on the B3 core):
  ok 91, static 0, blank 0, load_failed 3, renderer_failed 0, crashed 0, broken 0, timeout 2. The 2 timeouts,
  2883756643 and 2921510865, ran while another agent's scene runs loaded the machine (load average ~15). Rerun
  alone (`--only`), both are ok, Ready in 6.5 s and 5.0 s. Their smoke build time is the same on ccb545d and
  4c75eae (3.9/3.6 s and 4.8/4.9 s), so the prewarm doesn't slow them. That makes it ok 93, the same as B2. The
  same 3 scenes fail to load: 3276522107, 3477054430 and 3509243656. No scene is newly blank, broken or crashed.
- **Left of B3:** `SPRITESHEETBLENDNPOT` (P8, 6 sheets). The owner's WE captures of 1797172968 and 1155728109
  (P5, P8/P9) are still the reference for the hues and the sheet timing. The rest of the particle rows stay in
  B6 (P36), B8 (P20, P21) and B11 (child systems P2, P10, P15, P22, P24–P30, P34, P35, P37: the 0.1 s dt cap stays).

### B5 result (fork patch 0029, pin `d7a9f34`, 2026-11-03)

Rows G10, G11, G12, G14 (= E1), G15, G16, G18, G19 and the zoom half of G17 are done. E6 and the pan half of G17
are left (below). Everything was decoded from the same wallpaper64.exe, with the sound spike's `all.c`:

- **The camera update** (GH 0x1401b8af0), each scene tick before the render:
  - **Shake** (`FUN_1401c7680`, when `camerashake`): `t = speed² · g_Time`, the vector is `(cos t, sin 1.333 t, sin t)`.
    In 2D z is 0 and the scale is `amplitude · 0.01 · H` (3D: `amplitude · 0.1`). With `r = roughness³`, unless
    `r ≤ 0.001` or `r = 1`, the vector is rescaled to `length^r`. The eye and the centre both move by it.
    `cos`/`sin` are `FUN_14044fd70`/`FUN_140450450` (read from the Euler matrix at GH 0x14020af40), `powf` is
    `FUN_140453e00`.
  - **Parallax target**, while the `cameraparallax` bit is set (read every frame): `target = (W · (0.5 (1 − i) +
    mx · i), H · (0.5 (1 − i) + (1 − my) · i)) + the camera position`, `mx`/`my` the cursor over the window, clamped
    0..1, `i` = `cameraparallaxmouseinfluence`. A delay ≤ 0 snaps, else `k = min(1, (1 − delay/3) · 10 · dt)`. The
    smoothed position starts at the centre (GH 0x1401b6c60). `g_ParallaxPosition = clamp(pos / (W, H), 0, 1)`,
    initially 0.5 0.5, so **one value for the whole scene**, frozen while parallax is off. Not ported: an x
    mirror (context flag 0x800) and influence 0 under flags 0x200200; neither source was found.
  - **In 2D the editor camera is reset**: with an ortho projection and no camera paths the loader sets eye 0 0 0,
    centre 0 0 −1, up 0 1 0 (GH 0x1401b6c60 at 0x1401b8171). That confirms the § 1 note: `camera.eye` pans are
    ignored.
- **The per-object offset** (render loop GH 0x1401b9b50, only with flags 0x100 and 0x8, parallax and ortho): every
  object's view is translated by `(root.origin − pos) · cameraparallaxamount · root.parallaxDepth`, root being
  its topmost ancestor (origin +0x128, depth +0x170 of the base object table). So **depth 0 stays put**, the offset
  grows with the layer's distance from the target, and a subtree moves as one. `parallaxDepth` defaults to 1 1
  (base constructor GH 0x14020b5d0); many layers in the library omit it.
- **Zoom** (scene tick GH 0x1401afbf0): the 2D matrix becomes `M · T(W/2, H/2) · S(z, z, 1) · T(−W/2, −H/2)` with
  `z = general.zoom · camera zoom`. The camera zoom is the active camera object's `zoom` (+0x2dc), else 1. The
  active camera object is the last `"camera"` object that is visible with visible parents. Zoom < 1 shows more:
  3490034653 calls its 0.65 camera "Panorama".
- **Defaults** (scene constructor GH 0x1401b6c60): fov 50, perspectiveoverridefov 95, nearz 0.1, farz 10000,
  zoom 1; parallax amount 0.5, delay 0.1, influence 0.5; shake speed 3, amplitude 0.5, roughness 1.

The port (0029):
- `CScene::updateCamera` does the above each frame and writes a view adjustment (`Camera::setViewAdjust`: scale,
  then the shake, in world space).
- `CScene::getParallaxOffset` is used by CImage, now translating before its rotation as WE does, and CParticle,
  whose 0.65 minimum depth is gone.
- `g_ParallaxPosition` is registered in every pass.
- Camera objects are parsed (`zoom`, `visible`) instead of logged as unknown.
- fov/nearz/farz come from `general`; the 2D ortho keeps its 0..1000 depth.
- **The worker** keeps LWE's pointer at the scene centre until the host sends one. At (0, 0), a parallax scene in
  the smoke mode, or before the first Wayland pointer event, sat pulled towards a corner.

- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`, a fake `wp_mouse_input`). All three fail on
  4c75eae, and the suite is 26/26 on d7a9f34.
  - `parallax_follows_the_pointer`: a depth 0.5 square at x 32 with amount 1, delay 0 and influence 1 sits at 28 with
    the pointer centred, 12 with it at the right edge and 44 at the left. A depth 0 square never moves. Turning the
    bound `cameraparallax` off puts it back at 28. With delay 1.5 the edge follows `28 − 16 · (1 − (5/6)ⁿ)`: 25, 23,
    21, 20, 18, 17. Before: 28 throughout.
  - `parallax_position_uniform`: a `g_ParallaxPosition` shader reads 127 127 centred and 191 191 (0.75) top-right
    with influence 0.5. Before: 0 0.
  - `camera_zoom_and_shake`: `general.zoom` 2 doubles a square; a camera object's 0.5 cancels it; a later camera
    object shown live (zoom 4) takes over; a shake at speed 0 and amplitude 50 moves the view by 16 px.
- **Headless pointer** (a private `serve --headless`, 1920×1080, `ctl headless.pointer` then `ctl capture` after
  2.5 s): 3289734539 (amount 0.5, delay 0.1, influence 0.5). Each corner moves about 12 % of the pixels against the
  centred capture, and back at the centre it matches the first capture again (0.4 %, its animation). The layers
  move against the pointer: left pointer, content right; top pointer, content down. No border shows. Before, its
  delay of 0.1 read as false and nothing moved.
- **Smoke** (`--lwe-smoke`, the 36 parallax, shake, zoom and camera-object scenes at 3 s, before = 4c75eae with the
  B3 worker). The same 3 fail to load, the same 4 report "not animating", and no scene got blank. Pixel changes
  are 0–28 %, mostly the at-rest re-centring: before, the 11 scenes with delay ≥ 1 sat displaced towards the
  pointer at (0, 0). In these the black-pixel share stayed within 0.2 %. The exception is **3516174947**, which
  goes from 1 % to 32 % black: its camera object's "Lens size" defaults to 0.75, and at 0.75 its 3618×1731 layers
  no longer cover the 3440×1440 canvas. That follows the decoded formula, and 3042492564's "Zoom (lossless)"
  0.73–1 slider (its 6000×2805 background, and its pan range growing with the zoom) agrees with it. An owner's WE
  capture of 3516174947 settles it.
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b5`, 96 scenes, a release player and worker on the B5 core): ok
  93, static 0, blank 0, load_failed 3, renderer_failed 0, crashed 0, broken 0, timeout 0. That is the same as B3.
  The same 3 scenes fail to load: 3276522107, 3477054430 and 3509243656.
- **Left of B5:**
  - **E6** (`g_EffectTextureProjectionMatrix`): WE writes it from the image renderer (GH 0x1402176a0, image +0x384),
    which needs its own decode.
  - **The camera object's origin (G17 pan).** The library suggests that it is relative to the scene centre:
    3042492564 pans by ±offset, and 3516174947/3363252053 set `x·canvasSize` with sliders from −1 to 1 that
    default to 0. But the decode reads the plain origin as the eye, so the projection side is still open.
  - **Camera paths** (all `paths: []` in the library).
  - **Text** (CText) ignores the offset and the shake's y. It is redrawn in B4.
  - The parallax x mirror and influence-off flags.
  - The owner's WE captures of 2679248947, 2921510865, 3042492564 and 3516174947. 2679248947 has parallax off, so
    its depthparallax now reads a fixed 0.5 0.5, centred, where it read 0 before.

### B6 result (fork patch 0030, pin `c959e7a`, 2026-11-03)

Rows G03, G04 (the particle half), P36 and G31 are done. G04's text half stays in B4 (CText is redrawn there).
Decoded from the same wallpaper64.exe with the sound spike's `all.c`:

- **Effectively visible** (`FUN_1401b50e0`): the object's visible bit (+0x120 bit 0) AND, recursively, its parent's
  (+0x180). About 15 sites ask it: the particle step (GH 0x140255d00, its reset of a hidden system), the scene
  tick, the render loops, a function next to the text property table and the lights, so a hidden group or image
  hides its whole subtree. No call site
  found ties it to sound objects.
- **The image model matrix** (`FUN_1402277d0`): the object's transform (`FUN_1401b5170`, T(origin) · R · S, the same
  base transform every object type has) times a translation by the alignment offset at +0x2f8/+0x2fc. That offset
  is set at GH 0x140230a80 from the alignment enum (+0x4b1; the table of names is built in GH 0x14023ac30: center 0,
  top 1, topright 2, right 3, bottomright 4, bottom 5, bottomleft 6, left 7, topleft 8) as ±size/2 per side. So an
  aligned layer turns and scales **about its origin**, its anchor point. That settles G31: the inferred pivot was
  right.

The port (0030):
- `CScene::isEffectivelyVisible` is the one test. CImage, CText and CParticle (render, and the reset of a hidden
  system) use it, and so does the active camera object (B5's loop). Live: a user property or script that shows the
  parent shows the children on the next frame.
- **A bug found on the way:** `CImage::shouldRenderFinalPass` read the visibility while the passes were built. An
  image hidden at load, by itself or a parent, sent its last pass into an FBO for good, so showing it later never
  drew it. render () skips a hidden image every frame, so the build no longer asks.
- `CObject::resolveTransform`/`localTransform` moved from CImage. A particle's own scale and angles now count. CParticle
  resolves its place every frame (`refreshTransform`): its origin, scale and z angle under its parents, so a moving,
  animated or scripted parent (or origin) carries the system along. Before, the raw local origin was read once at
  setup. World-space control points stay put in the world. The system's own x/y angles stay its own.
- CImage rotates about the origin (`m_scenePivot`), not the shifted quad's centre. Centred layers are unchanged.

- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`). All three fail on d7a9f34, and the suite is 29/29
  on c959e7a.
  - `hidden_parent_hides_children`: a hidden group's child and a hidden square's child don't draw, an unparented square
    does. Turning the group's user property on shows its child on the next frame. Before, both children drew.
  - `particle_follows_its_parent`: a group at 20 16 turned 90° and scaled 2 puts its system at local 0 3 at x 14 (10
    particles after 1 s, 0 before); a square parent whose script moves it from 48 to 32 carries its system to 32 (10,
    0 before); a hidden group's system has 0 (10 before).
  - `aligned_layer_turns_about_its_origin`: a left-aligned square at 24 turned by π covers 16..23 (24..31 before); a
    centred one turned by π stays put.
- **Smoke** (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`, the 17 playing scenes with a hidden ancestor, a
  parented particle system or a turned aligned layer; before = d7a9f34 with the B5 worker through `LD_LIBRARY_PATH`).
  2 are pixel-identical (3042492564, 3480481965: their hidden children are covered or text). The rest change 0.006–6 %
  of the frame. What changed, all following the decoded rules:
  - **3243449890:** the character is gone. She is the "simple" variant (group 2662, `visible` = combo
    `newproperty4` == 1), whose 14 puppet parts drew under the hidden group. The combo's default is 2, "detailed",
    whose layer (2002, a video shown by a start-delay script) is what WE shows. So WE shows the detailed variant
    where we now show neither until that layer plays. **Unconfirmed without a WE capture.**
  - **3326873240:** the "Media Info (ROUND)" widget at the left (its parent 131 is off by default,
    `newproperty67` false) no longer draws. With it gone the smoke frame is nearly black, because the scene's video
    layers (shown by a SceneScript `getVideoTexture` call, B10) don't play; the smoke check reports it "not
    animating or blank". The scene's own toggle for the widget is off, so WE hides it too.
  - **3490034653:** three "光束" (light beam) particle systems under image parents now sit next to their parents
    (around x 570, y 990 of 3440×1440) instead of at the bottom-left corner: yellow shafts appear on the left.
    **Unconfirmed without a WE capture** (the owner's capture of 3490034653 is already asked for, G17).
  - **3414858021:** its rain systems are children of a group at the scene centre, with local origins such as
    (−428, 507): they now sit around the centre instead of off towards the bottom-left corner.
  - 3163060610, 3319542538, 3354740764, 3463520581, 3516106265, 3516174947: hidden-group layers (UI panels,
    alternative variants, toggled extras) gone; 3174556087, 3233141951, 3363252053, 3479521040, 3489263099: parented
    particles moved.
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b6`, 96 scenes, a release player and worker on the B6 core): ok
  93, static 0, blank 0, load_failed 3, renderer_failed 0, crashed 0, broken 0, timeout 0, the same as B5. The same
  3 scenes fail to load: 3276522107, 3477054430 and 3509243656. 3326873240 is ok there (the player's check sees
  its animated layers over the run; only the 3 s smoke frame is near-black).
- **Left of B6:** text parent transforms (B4, with G13/G30); whether a sound object under a hidden parent goes silent
  (no call site found); G05 (parent alpha) is still Unknown; the owner's WE captures of 3243449890, 3163060610 or
  3319542538, and 3490034653.

### B9 result (fork patches 0031–0036, pin `cc6f1c9`, 2026-11-03)

Done: E4, E5, C1, S18, C3 (engine uniforms), E36, E37 (bloom), E17, E45 (annotation defaults; E18 is parity),
E19 (varyings), U1, U2, U4 (properties), and the property side of E40. Left: E9, E11, E20, E38, E41 (below).
One patch per theme:

- **0031: engine uniforms**, from the uniform switch GH 0x14010a0e0 and the tick GH 0x1401afbf0.
  - `g_Frametime` (case 4) is the frame's dt.
  - `g_PointerState` (case 0x71): xy is 1 while the left button is down, z is 1 on the frame it went down (WE's
    flags at ctx+0xa4: bit 0 down, bit 1 already seen), w is 0. The worker already passes the buttons.
  - `g_Daytime` (case 5) and `engine.timeOfDay` are the local time of day, h/24 + m/1440 + s/86400 + ms/86400000,
    from the wall clock each frame (GH 0x14013f370).
  - `g_Time` wraps at 432000 s. Scripts, particles and sounds keep the host clock.
- **0032: bloom.** The passes' strength, threshold and tint are connected to `general`'s values, so a user
  property moves them live. `bloomtint` was never parsed. The bloom chain is built when `bloom` is on or bound to a
  user property, and skipped each frame while off. Before, it existed only when on at load. A chain that can't be
  built (no WE assets) is logged and left out. A `bloom` driven by a script (2325974975, 2134765860's strength) needs
  a script host for `general` (S4, B10).
- **0033: annotation defaults.** A float `default` written as a string is that float (`std::stoi("0.1")` was 0).
  A vector default written as a number broadcasts; it threw, which lost the pass. **E18 is parity:** WE parses
  `[COMBO]` lines with a strict JSON parser (RapidJSON, by its error strings) and skips the combo when the parse
  fails (GH 0x14019ba90 → GH 0x140195900), as LWE does. So 3243449890's `VERTICAL_RELATIVE_WIDTH` and the
  procedural_noise combos stay undefined, which is 0, in WE too.
- **0034: varyings.** A varying that a fragment unit uses but only its vertex unit declares is now declared in the
  fragment. WE's mechanism is not decoded; that it compiles them is inferred from the scene working in WE.
- **0035: properties.** A textinput default has no JSON quotes. The listing API lists it as
  `WP_PROPERTY_TYPE_TEXT_INPUT`; it threw "Unknown property type". Combo values keep non-integer numbers.
  `WP_PROPERTY_TYPE_FILE` was 4, the same as BOOLEAN, and is now 5. liascape reads project.json itself, so none of
  this changes what the player sends.
- **0036: usertextures (E40, property side).** A non-system usertexture is the value of the scenetexture property
  it names. With nothing picked, which is every default in the library, the slot keeps its fallback quietly. Before,
  the property's name was looked up as a texture, which failed with a log line.

- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`). All six fail on c959e7a (built against the new
  headers), and the suite is 35/35 on cc6f1c9.
  - `engine_uniforms_are_fed`: frametime 1/30 → r 127, daytime → g = the local time × 255, pointer up / pressed /
    held → b 0 / 255 / 127, and `g_Time` at 432005 s reads 5. Before: 0 0 0 and no wrap.
  - `bloom_is_live_and_tinted`: off at load, then on through its property, glows green only (tint 0 1 0, g 7, r 0).
    Strength 0 through its slider: no glow. Before: no glow at all.
  - `annotation_defaults_parse`: "0.25" → r 64; a vec2 `default: 0.5` → 127 127. Before: 0, and the pass lost.
  - `fragment_gets_vertex_varyings`: a vertex-only `v_Bounds` (0.5, 0.25) reaches the fragment.
  - `properties_list_as_written`: the listing has the textinput "YOURNAME", the combo key "0.5", file 5 and boolean 4.
  - `usertexture_reads_its_property`: a pass's `usertextures [null, "picked"]` samples the property's util/white.
- **Smoke** (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`, before = c959e7a): 3184155462 (cursorripple),
  2189783622, 2890767643, 3490034653, 2388299037, 3414858021, 3028473503, 3013489778, 3042865984.
  - **2189783622:** its foliagesway effect is built again ("Leaving out effect" 1 → 0). 0.4 % of the frame changes,
    the swaying foliage.
  - 3490034653's bloom tint (1 1 0.878) changes 0.09 % of the frame.
  - The rest are within 0.01 %. The smoke mode has no pointer or audio, so cursorripple and the audio bars show
    nothing new there.
  - 3414858021 still leaves out 5 effects, for a different reason: "must write to gl_Position", a vertex unit that
    doesn't compile (not E45).
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b9`, 96 scenes, a release player and worker on the B9 core, the
  machine at load ~27 from another agent's run): ok 93, static 0, blank 0, load_failed 3, renderer_failed 0, crashed
  0, broken 0, timeout 0, the same as B6. The same 3 scenes fail to load.
- **Left of B9:**
  - **E9** `g_TexelSize`: whether WE's ctx+0x74 is the output or the render-target size is not decoded.
  - **E11** `g_LayerModelMatrix` (ctx+0xa30): not decoded (1 scene).
  - **E20** `TEXnFORMAT` for samplers ≠ 0 (1 scene, only with `RENDERING=1`).
  - **E38** `alphatocoverage` (1 scene): it needs a decision for single-sampled targets.
  - ~~**E41** effect `visible` live (33 scenes)~~: done in patch 0037 ("E41 result" below).
  - **E40's other half:** loading a picture the user picks (not a `.tex`), and the UI picker.
  - The 3414858021 vertex units that don't write `gl_Position`.

### E41 result (fork patch 0037, pin `3eaac6e`, 2026-11-03)

An effect's `visible` now turns it on and off live, from a user property or a script.

- **The patch.** `CImage::setup` builds every effect that can be visible: visible now, bound to a user property, or
  with a script on `visible` (a literal `false` with neither stays unbuilt, as before). Each pass knows its effect.
  `render ()` compares the effects' `visible` with the values the chain was set up for. On a change it picks the
  passes that run again and sets their targets up from the image's main FBO: the ping-pong, which pass draws to the
  scene, and the layer's blending moved from the first to the last running pass. So a hidden last effect hands the
  screen draw to the pass before it. A script on an effect's `visible` is queued like a layer property's
  (`thisLayer` = the image). A passthrough layer with no visible effect draws nothing, as when none could be.
- **What's not done.** `thisLayer.getEffect(name).visible` in SceneScript (B10; 1 scene, 2325974975, which also needs
  cursor events). The 6 scenes with a script on an effect's `visible` (21 effects) now run it. 17 of those 21 wait
  on media-thumbnail events (B10) and keep their literal `false`.
- **Cost.** Hidden effects are now compiled at load. Total build time over the 29 loading scenes: 28.8 s vs 28.6 s
  before. Hidden effects whose shaders don't compile now log "Leaving out effect" at load: 3516106265 +24,
  3479521040 +2. These are the known "must write to gl_Position" and vec4 `?:` units, and they would fail the same
  way when shown.
- **Fork test** `effect_visible_is_live`: a red layer, a "green" effect (property `fx`, false at load), then a
  "blue" effect (property `last`, true). Readings: off 255 0 255 → on 255 255 255 → blue off 255 255 0 → both off
  255 0 0 → both on 255 255 255. On cc6f1c9 it stays 255 0 255 (RED). The suite is 36/36.
- **Smoke, 32 of the 33 scenes** (3556794116's only binding names a deleted property, U7; `--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`, a release worker on the dev
  core vs the same worker on cc6f1c9 by `LD_LIBRARY_PATH`).
  - Per scene, one property bound to an effect's `visible` is flipped (bool negated; a combo to a value that
    changes which condition matches). Three runs: (B) flipped at load, (C) flipped live at 1.5 s, (A) not flipped.
  - The metric is the % of pixels differing by > 8 at the 3 s frame.
  - **New core, live = at load (B~C):** 0.00 % on all 28 scenes that load and draw. 3516174947 is 3.34 % only with
    the combo set to "0": that also shows hidden ash particle layers, and a layer shown live restarts its particles
    (B6 behaviour), so that difference isn't the effect.
  - **Cc6f1c9 (B~C):** 0.03–99.7 % wherever the flip matters. A live flip did nothing there.
  - **What the flips change (A~C, new core):** 2134765860 lightson 100 %; 2388299037 pulse 93 %; 3163060610 ts
    (hidden at load, turned on) 99 %; 3354740764 nostalgia (on) 67 %; 3013489778 54 %; 3516174947 50 %;
    3419466417 (on) 33 %; 3490034653 23 %; 3029971128 22 %; 3463520581 12 %; 3445973124 4.5 %; 3042492564 2 %;
    3174556087 1.8 %; 3489263099 (on) 1.1 %; 3432876246 1.1 %; 2951169110 0.15 %; 2375914945 0.03 %.
  - The rest change nothing visible in a 3 s smoke with no pointer or audio. Audio pulses and bars: 3042865984,
    3184155462, 3233141951, 3480481965. Also 2932157836, 3219908811, 3243449890, 3363252053, 3414858021,
    3479521040, 3516106265,.
  - **Can't be checked here:** 3276522107 and 3477054430 fail to load (the known 3). 3046119914 and 3432999904 draw
    black on both cores (lit 0), a separate fault.
- **Left:** `getEffect()` (B10). The media-event scripts (B10). The black 3046119914 / 3432999904. The hidden
  effects' shader faults (with 3414858021's `gl_Position` units).

### B10 result (fork patches 0038–0044, pin `c60fd2e`, 2026-11-03)

Done: S10, S11, S12, S13, S14, S15, S19, S20, S21 (decided: ignored), S23, S24, S25, S27, S29, S30, S31, S32, S36;
partly S4, S16, S26, S37 (below). S8 was done in B1.

- **0038, the layer and scene API.** `getLayer (n)` is the n-th layer of scene.json, and every type is a layer
  (groups and camera objects are `CGroup`, sounds are scriptable). One JS object per layer. ILayer `id`, `solid`,
  `size`, `getParent`, `getChildren`, `getEffect` (name or index, `visible` live through E41; every effect is built
  when the scene's scripts name `getEffect`), `getTextureAnimation` (the layer's own clock once a script changes it,
  as WE's docs say). ISoundLayer `play` (only if not running; resumes a pause; starts a `startsilent` sound, A7),
  `stop`, `pause`, `isPlaying`, `volume`. IScene `getLayerCount`, `enumerateLayers`, `getLayerIndex`, `sortLayer`,
  writable properties, `clearenabled`/`skylightcolor`/bloom float getters fixed; scripts on general's bloom values
  run. `engine.canvasSize`, `screenResolution` (= the scene's size: the core renders at it and the host scales),
  `userProperties` (live), the `is*()` constants, `registerAsset`, `isObjectValid`; `openUserShortcut` returns
  false (S21 decided: Windows shortcuts have no meaning here). `applyUserProperties` gets the changed properties on
  every change. Text scripts: `thisLayer` is the real layer, `init (value)`, live script properties, a combo's first
  option, the events, and they run while hidden or without a font.
- **0039, media.** MediaPropertiesEvent's `albumArtist`/`subTitle`/`genres`/`contentType`, thumbnail colours from
  the art (the most common colour and the next distinct ones; textColor at WCAG contrast ≥ 4.5 with the primary,
  else black/white; highContrastColor black/white), `mediaStatusChanged`, sent once per image, replayed to a scene
  built after the host reported. **The decision "which player"**: liascape's scene worker reads MPRIS itself
  (`media.rs`, once a second, only for scenes that take media events): the playing player (the one chosen before
  while it plays), else the first paused one; playerctld skipped. http(s) art (Spotify) is fetched once with
  `curl`.
- **0040.** A script on an effect's `visible` has `thisObject` = that effect (it was the layer: 2134765860's
  `thisObject.visible = e.hasThumbnail` hid the whole cover layer). Shader-constant scripts run (S4 for effects).
  `getAnimation`/IAnimation (play, pause, stop, isPlaying, get/setFrame) on keyframe animations. Media events in the
  order status, properties, thumbnail, playback, timeline.
- **0041 + 0043, the cursor.** Enter/leave/move reach every solid image layer under the cursor, shown or hidden;
  down/up/click reach the shown ones. Decided from 2325974975, since WE's docs don't say: its "Buttons Trigger"
  hides itself on cursorEnter and covers the buttons (so not topmost-only, and a hidden layer keeps its hover), and
  its "Hide" button shows a hidden full-width trigger whose own click would undo it (so no click on a hidden
  layer). `CursorEvent.localPosition` is 0..size, y up. `input.cursorWorldPosition`/`cursorLeftDown` work, and
  `cursorScreenPosition` read a value never written. Text and particle layers are not hit-tested; the camera zoom
  is not undone in the hit test.
- **0042, localStorage.** Locations, typed values (a stored vector comes back a Vec2/3/4), one JSON file per
  project under `wp_config_set_storage_dir` (liascape: `~/.local/state/liascape/scene-storage`), 100 KB cap. A
  missing key is `undefined` (WE's not documented; the library reads it with `||`/`??`).
- **0044.** `console.log = () => {}` (3363252053, 3414858021) threw "'log' is read-only"; console.warn/info/debug.

- **Fork tests** (`host_api_test`, need `LIASCAPE_WE_ASSETS_DIR`): 45/45 on c60fd2e (36 before + 9). They use the
  new C API, so they don't build against 3eaac6e; what each checks was absent there.
  - `layer_api_reaches_layers`: 19 checks of the layer/scene/engine API in one script, and a write through
    `getLayer (2)` moves that square.
  - `script_effect_and_property_changes`: `getEffect ('g').visible = …` shows a literal-false effect (255 0 0 →
    255 255 0); applyUserProperties sees `fx,other` then `fx`.
  - `text_script_is_a_real_layer`: a hidden, fontless text's script gets `init ('hello')`, its combo default, and
    shows another layer.
  - `media_events_reach_scripts`: status reported before the first frame, all property fields, a red PPM's
    colours (primary red, black high contrast), the thumbnail once for the same URL twice, state, timeline; a text
    script gets the properties too.
  - `effect_script_this_object_is_the_effect`, `script_plays_a_keyframe_animation` (a startpaused fade a script
    plays reaches 0; without the script 191), `cursor_events_reach_layers` (log `enter1 down1 up1 click1:4,4:8,24
    leave1 enter2`: local/world positions, a hidden layer hovered but not clicked, a non-solid one nothing),
    `local_storage_persists` (two loads: 41 + 1 = 42, a Vec3 back as a Vec3, global apart from screen),
    `script_controls_a_sound` (peaks: startsilent 0, play 0.400, pause 0, play 0.400, volume 0.5 → 0.100, stop 0).
- **Smoke** (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`, `LIASCAPE_SCENE_MEDIA=0`, a release worker on
  the B10 core vs one built on lp-player with the 3eaac6e core), 20 scripted scenes: script errors in stderr 867 →
  183 (before 0044). The rest are mostly `engine.registerAudioBuffers` (S17, B8) at module load, `getVideoTexture`
  (S26) and `createLayer` (S37). No scene newly fails to load or draw (2890767643 and 3326873240 report "not
  animating" on both cores). Pixel differences at 3 s: 0–4.2 %.
  - **2325974975:** 15 → 0 errors; its window sprites now follow the script's `setFrame` (0.27 % at 12 s).
  - **3414858021:** its date texts now take `engine.canvasSize` positions, and leave the screen: a text's
    `parent` is not applied yet (G04, B4), so that is B4's to fix, not a B10 fault.
  - **2134765860 with a fake MPRIS player** (`examples/fake_mpris.rs` under `dbus-run-session`, synthetic art): the
    album cover on the shelf shows the art (old core: the placeholder). The cover's fade scripts reach their
    constants' animations (0040).
  - **2890767643 with the fake player:** the media handlers run without the playback-before-title error; its media
    widget still needs `registerAudioBuffers` (S17) and has no `.mp3` sound layers its script expects.
- **Headless pointer** (a private `serve --headless`, 1920×1080, `ctl headless.pointer`, `ctl capture`),
  2325974975: hovering "Mute" lights it (0.24 % of the frame); a click on "Hide" hides the text box and buttons
  (8.3 %), a click over the restored trigger brings them back (0.29 % from the start, the window animation).
- **Corpus** (`scene_corpus.sh --results /tmp/sc-b10`, 96 scenes, a release player and worker on the B10 core): ok
  92, static 0, blank 0, load_failed 3 (the same 3), renderer_failed 0, crashed 0, broken 0, timeout 1. The timeout
  is 2883756643, which was a timeout in the B1 report too; run alone (`--only 2883756643`) it is ok, ready in
  6.7 s. So 93 ok as B9, nothing newly blank, broken or crashed.
- **Player tests** (`cargo test -q`, debug, on the pinned c60fd2e core): 737 passed, 0 failed, 3 ignored.
- **Left of B10:**
  - S16: `resizeScreen`, `applyGeneralSettings`, `animationEvent` are not sent.
  - S26: `getVideoTexture` (2 scenes), puppet animation layers / `playSingleAnimation` (B12), bones, blend shapes,
    `getTransformMatrix`, `setParent`, IMaterial (`setMaterialProperty` is a no-op).
  - S37: `createLayer`/`destroyLayer` (4 scenes; needs the loader at run time), get/setCameraTransforms,
    getInitialLayerConfig.
  - Cursor: text and particle layers, the camera zoom in the hit test. The cursor behind windows (C6) is unchanged.
  - S4: `instanceoverride.*`, `maxwidth`, animation layers, `brightness` scripts.
  - S17 `registerAudioBuffers` is B8 and is now the most common script error left.

### Coverage batch (fork patches 0065–0070, 2026-11-04)

The item-by-item audit of everything WE supports is now `we-coverage.md` (the master gap list): the d.ts of
SceneScript 2.8 went from 329 of 453 items implemented to 421 (17 missing, all render features or unknowns), plus
`alphatocoverage`. That page lists what each patch did, the tests, and the future batches (shadows, volumetrics,
bone physics, skinned models, perspective layers, stock-only particle operators).

## 6. Audio after patch 0018 (A)

A2 (Left = Right) is E8.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| A1 | Spectrum source format | **Observed**: WASAPI shared-mode **loopback** (`AUDCLNT_STREAMFLAGS_LOOPBACK` 0x20000), **32-bit float**, device channel count kept (FUN_1401027f0, [L5]) | host feeds 1024 **u8** mono samples (`WP_AUDIO_INPUT_FRAME_SIZE`, Audio/PlaybackRecorder.cpp:51-54; liascape `lwe.rs:54`) | 41 audio-reactive scenes (combo `AUDIOPROCESSING` 16, custom spectrum shaders 27, `registerAudioBuffers` 21, particle `audioprocessingmode` 2) | 8-bit quantisation; quiet music barely moves bars | M — change the C API to f32 stereo frames (liascape already has f32 from PipeWire) |
| A3 | Band mapping and magnitude | **Observed**: bins `1..n-1` → band `pow((i−1)/(n−1), e)·k & 63` (non-linear), magnitude `sqrt(re²+im²)` × a per-bin weight, **max** per band, × `audioinputvolume·0.02·0.001·n/(rate·0.5)` ([L6]; `audioinputvolume`/`audioinputthreshold` are WE app settings, FUN_14006e2xx) | 64 **linear** bins `0,2,…,126` only (≈ 0–5.4 kHz at 44.1 kHz), `0.35·log10(mag²)` with an ad-hoc tilt; the 32/16 arrays are overwritten sub-samples whose tilt uses the wrong index (PlaybackRecorder.cpp:61-78) | 41 | Bars cluster in the bass, treble never moves; different dynamics than WE | M — port the observed mapping; the exponent/weight constants need one more decompile pass |
| A4 | Temporal smoothing | **Unknown**: the 16/32 derivation and any decay happen in code Ghidra marked unreachable/inlined in FUN_140103630 ([L6]); not settled | `movetowards(…, 0.3)` **per rendered frame** (PlaybackRecorder.cpp:20-30) — frame-rate dependent | 41 | Response speed changes with fps | S (make it dt-based) + Unknown for parity |
| A5 | Capture only when the project opts in | **Observed**: the capture thread starts only when a wallpaper's `general.supportsaudioprocessing`/`audioprocessing` value is true (FUN_14006fff0 near "audioprocessing", all.c 83102-83217) | liascape feeds audio when the worker reports `wants_audio_input` | 41 declare it (matches the 41 users) | parity once liascape keys `wants_audio_input` on it (check) | S |
| A6 | Sound `spatialization` (2D pan) | **Observed** (sound spike §Q3): pan-only in 2D | not implemented (0018 parses but ignores, per spike §4 item 11) | 0 | none in the library | S (skip) |
| A7 | `startsilent` sounds started by script | **Observed** (sound spike §Q3): only `play()` starts them | see SceneScript rows (S…) for `play()` | 2 (2325974975, 3289734539) | silent if the script API is missing | see S |

## 7. User properties (U)

U3 (scenetexture) is E40.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| U1 | `textinput` default keeps its JSON quotes | **Inferred**: WE shows the string value | `PropertyTextInput` is built from `value.dump()` → `"YOURNAME"` with quotes (Data/Parsers/PropertyParser.cpp:144-151); a value set through the C API has none | 18 have a textinput, 13 bind it to text | Text shows `"Name"` with quotes unless liascape sends a value at open | S — `get<std::string>()` |
| U2 | Property listing API throws on textinput | — | `propertyListNext` has no `PropertyTextInput` branch → `sLog.exception ("Unknown property type")` (Project.cpp:247-295) | 18 | none for liascape (it reads project.json itself); a C-API caller crashes | S |
| U4 | Combo option values are truncated to int | **Inferred**: WE keeps the option value as given | `value.get<int>()` for numeric options (PropertyParser.cpp:65, 78) — `0.5` becomes `"0"` | 0 float-valued options; 22 scenes have numeric-string options (string path, fine) | none in the library | S |
| U5 | A combo bound without a condition to a number field reads 0 | **Inferred**: WE converts | `DynamicValue::update(string)` zeroes every numeric view (Data/Model/DynamicValue.cpp:166-188) | 0 (every combo binding in the library uses `{name, condition}`) | none in the library | S |
| U6 | `condition` on a non-combo property is ignored | **Unknown** (only combos seen) | condition is applied only when the source is a string (DynamicValue.cpp:176, 213) | 0 (all 22 conditional bindings target combos) | none | S |
| U7 | Bindings to properties missing from project.json | **Inferred**: the literal `value` stays | same (UserSettingParser.cpp:33-47) | 22 scenes have such dangling bindings (deleted properties) | none (parity) | — |
| U8 | Live change of a property that needs a rebuild (effect `visible`, shader combo, text font) | **Inferred** WE rebuilds/re-evaluates | `DynamicValue` listeners update values only; anything read once at setup (combos, `font`, `alignment`) stays at its load value | effect `visible` bound in 33 scenes (live: see E rows); combos bound in 0 | A user toggle may not apply until reload | M — audit per field; reload the scene as a fallback (liascape can) |

## 8. Clock, frame rate, cursor (C)

C2 (`g_Frametime`) is E5. C4 (`g_PointerState`) is E4.

| ID | Gap | WE behaviour | LWE behaviour | Scenes | Impact | Port |
|---|---|---|---|---|---|---|
| C1 | `g_Daytime` is always 0 | **Observed**: per frame `scene+0x150 = FUN_14013f370()` = local `h/24 + m/1440 + s/86400 + ms/86400000` ∈ [0,1) (FUN_140141520 [E7] → FUN_14013f370 [L2]); the uniform setter reads it as `g_Daytime` (case 5, [L3]) | `Context::daytime` is initialised to 0 and never written (Context.cpp:15); bound at CPass.cpp:872 | **0** shaders in the library or WE's stock shaders reference `g_Daytime` | none today (the TODO item is low priority) | S — set it in `Context::update` |
| C3 | `g_Time` wraps every 5 days | **Observed**: `time += dt` in a double, reset to 0 when > 432000 s (FUN_1401afbf0 [L4], const `0x1404d44fc` = 432000.0) | `renderTime` = host clock, float, no wrap (Context.cpp:35) | all | after days of uptime float precision degrades (ulp 7.8 ms at 1 day, 31 ms at 5) — jitter in slow animations; WE has the same until its wrap | S — wrap at 432000 like WE |
| C5 | Pointer normalisation | **Observed**: `g_PointerPosition = client px / window size` (x/+0x84, y/+0x88) per frame ([E7] → setter case 0x70 [L3]) | position / camera (scene) width/height (Render/Wallpapers/CScene.cpp:379-390); liascape sends native scene px mapped through fill+viewport (`scene/pointer.rs`) | 10 pkg shaders + 6 stock (cursor ripple, parallax-to-cursor) | equivalent when liascape's mapping is right; when a scene is cropped (cover fit) WE's value is relative to the **window**, LWE's to the **scene** — they differ at the edges | S — decide and document; compare with a WE capture |
| C6 | Cursor feed on a wallpaper layer | **Observed**: WE polls `GetCursorPos` every frame regardless of focus ([E7]) | liascape forwards Wayland pointer events from its background layer surface (`ToWorker::Pointer`, sources/scene.rs:1340) — only while the pointer is over the bare desktop; no events when a window covers it | 10–25 (cursor uniforms, parallax with mouse influence, cursor scripts) | parity on an empty desktop; frozen behind windows (WE keeps tracking) — a platform limit, not an LWE gap | — (document; a compositor-wide cursor would need a Hyprland IPC poll) |
| C7 | Frame pacing / dt | **Observed**: the scene tick takes the measured dt (FUN_1401afbf0 `param_2`) | renderTime − renderTimeLast from the host clock (CScene.cpp:400-402) | all | parity | — |

## Evidence index

The lead's REA Evidence. Each is a function dossier from `analyze_function` on wallpaper64.exe 2.8.485:

| Id | Function | Covers | REA Evidence |
|---|---|---|---|
| L1 | FUN_14027e130 | the text object property table | `ev_68c1d174d25734d35fa3e236649f1bb972694f112b569faa4c19107bba11fec7` |
| L2 | FUN_14013f370 | local time of day `h/24+m/1440+s/86400+ms/86400000` | `ev_5aa1d9ceff9f1f8630052501239e3d6727aa14080b02c58adfb5c3d3b60c9e2f` |
| L3 | FUN_14010a0e0 | the per-draw uniform upload switch (ids from the name table at FUN_140002a20) | `ev_d86504d734dd16653710d189067f06474573e01f96b4fbe20fe1f87c0e2099b1` |
| L4 | FUN_1401afbf0 | the scene tick: `g_Time` += dt in a double, wraps at 432000 s; `g_Frametime` = dt | `ev_be41322cf19ab41a393d8951c03597f0b41b9ae470f06f0643c930374543d90c` |
| L5 | FUN_1401027f0 | WASAPI loopback init (32-bit float, `AUDCLNT_STREAMFLAGS_LOOPBACK`) | `ev_943d5e6d546732fd0dc7d5ac12112cd638a7f438e41b6344e2ff45b363ce663a` |
| L6 | FUN_140103630 | the audio capture/FFT thread (per-channel 64 bands, pow mapping, max per band) | `ev_385c86b1a631060ad653fb6c5fac8b179f722c16b571533e94039fa48f0ea6a2` |
| E7 | FUN_140141520 | the wallpaper frame tick: daytime, `GetCursorPos`, the desktop-only click test (from the sound spike) | `ev_7400b05eacc78983a3057c2974fc1218e4a481615b2bdc26bef0b4405178fd1d` |

The sections cite their own Evidence ids inline (`ev_0e4f5eb3…` hierarchy visibility, `ev_812f649b…` particle
prewarm, `ev_6c14a78d…` particle dt × rate, and others). Every `GH 0x…` claim is reproducible from the headless decompile
of the same bytes, the sound spike's `all.c`.

The scripts behind the counts are in the session scratchpad's `audit/`:

- `tools/` (extract, keys, text, props);
- `work-scenegraph/`, `work-effects/`, `work-particles/`, `work-scenescript/`.

They are not committed. Re-run them against the Workshop folder to refresh the counts after the library changes.

### B8 result (fork patch 0045, pin `592fdff`, 2026-11-03)

Done: A1, A3, A4, A5, E8, S17, P20, P21 on the fork side. The decode (GH 0x140103630 capture thread, GH 0x140141520
frame tick, GH 0x14025cfe0 / 0x140250d80 emitters, scenescript64.dll for `registerAudioBuffers`) is in the
PlaybackRecorder.h comment and the fork commit message.

- **The spectrum.** Per channel a complex FFT of N = max (rate / 44100, 1) · 1920 points, 2N/3 fresh frames per
  analysis; bins 1..639 → 64 bands by pow ((i−1)/639, 0.25)·64 (max per band) of sqrt (w·|X|²) with WE's window
  weight; per rendered frame an auto-gain per group of 8 bands, a dt-based low-pass and a rise/fall-limited follow;
  the average channel and 32/16 bands as the max of pairs. A size with a factor above 5 runs as a Bluestein
  convolution, as WE's FFT does.
- **Consumers.** `g_AudioSpectrum{16,32,64}{Left,Right}` read their own channel. `engine.registerAudioBuffers
  (16|32|64)` returns left/right/average Float32Arrays refreshed every frame, only from a module's top level, with
  WE's errors; `engine.AUDIO_RESOLUTION_*`. Emitters with `audioprocessingmode` scale their rate by the loudest band
  of their range through bounds, a smoothstep and the exponent (a float now).
- **C API.** `wp_context_audio_input_push (ctx, f32 interleaved, frames, channels, rate)` and
  `wp_context_audio_spectrum (ctx, resolution, channel, out)`. The u8 mono input mix (`wp_context_set_audio_input_mix`)
  still works, taken as 44.1 kHz mono; nothing runs for a context never fed.
- **Fork tests** (`host_api_test`): 49/49, 4 new — `audio_tones_land_in_we_bands`, `audio_left_right_and_resolutions`,
  `audio_smoothing_is_dt_based`, `audio_reaches_shaders_scripts_and_emitters`.
- **Smoke** (`--lwe-smoke --tone 110`, a synthetic sine in the input mix, vs silence, 3 s, % of pixels differing):
  of the 41 `supportsaudioprocessing` scenes, 39 load (3477054430 and 3509243656 are the known 3D load failures);
  22 respond — 2542468435 36 %, 3029971128 32 %, 2890767643 22 %, 1556245028 19 %, 2134765860 10 %, the rest
  0.02–1.3 % (bars, pulses); 17 show no change to a 110 Hz tone in 3 s. One `registerAudioBuffers` error is left:
  3163060610 passes `engine.AUDIO_RESOtime_switchingION_16` (the author's find-and-replace typo → undefined), and
  WE throws the same RangeError.
- **Player tests** (debug): 737 passed, 0 failed, 3 ignored.

Left:
- **Stereo from liascape.** The worker still feeds the 1024-sample u8 mono mix SysMon builds, so Left = Right and
  the input is resampled to 44.1 kHz u8. Feed SysMon's f32 stereo through `wp_context_audio_input_push` instead
  (protocol: f32 frames instead of the u8 frame).
- The 17 scenes that showed no change: check with music (a sweep, not one tone) before calling them done.


### B7 result (fork patches 0046–0047, pin `c4eea29`, 2026-11-04)

Done: E27, E28, E30 (= G33), E31, E33. Patch 0047 is the batch; 0046 fixes a B8 bug the fork suite caught
(below). Every claim was decoded from the sound spike's `all.c` (the same wallpaper64.exe 2.8.485); the addresses
are in the fork commit message.

**Decoded (Observed):**

- **The image flags at +0x304.** The constructor (GH 0x140212c50) sets 0x8040, so `copybackground` (0x40) and
  `clampuvs` (0x8000) are both **true by default**. `nointerpolation` is 0x4000. The property setters are
  GH 0x14021a8a0 / 0x1401c9b40 / 0x1401c9970. The model's flags are fullscreen 2, nopadding 4, autosize 8,
  passthrough 0x20, solidlayer 0x200, projectlayer 0x400 and instanced 0x800 (the model parse, GH 0x140225660).
- **E31.** A layer's composite FBOs clamp per `clampuvs` and sample nearest with `nointerpolation` or a
  point-filtered texture (GH 0x140214b50: flags = noInterp | clamp << 1). They used to take the texture's flags, so
  solid layers and most textures wrapped. **Every layer with effects now clamps** unless it says `clampuvs: false`,
  which no scene in the library does. The audit's "9 scenes" was those that write the key.
- **E27.** WE copies `_rt_FullFrameBuffer` (the registry at scene+0x18a0, vtable +8) before an image whose
  material or blend mode reads it, or before the first pass whose material has the "reads the framebuffer" bit
  (GH 0x140214b50). Particles copy once per frame (GH 0x14025bc30). Ours: a pass that **samples the FBO it draws
  into** reads a copy taken just before its draw (`CWallpaper::copyForSampling`, one copy per size and flags). Only
  a sampler the program uses counts. genericimage4 and genericparticle declare `g_Texture3 = _rt_MipMappedFrameBuffer`
  for REFLECTION/REFRACT, but it's compiled out otherwise. A pass that samples the scene while drawing into the
  layer's own FBO needs no copy, since the scene can't change before the layer's last pass.
- **E28, mode 31.** Mode 31 (A + B·opacity) is **additive blending of the layer's last draw** with no BLENDMODE pass.
  The combo is 0 for modes 0 and 31 (GH 0x140211f90), and the final draw's blend is 2 (GH 0x140214b50, 0x1402321d0;
  text: GH 0x14027d4e0). The other modes keep genericimage3's BLENDMODE pass, which now reads the copy.
- **E30 / G33, compose layers.** A passthrough layer **renders its subtree into itself** (GH 0x140218260 → 0x1402181b0,
  recursing down to a nested compose layer, which renders its own). That happens after it copies the background
  (`copybackground`) or clears to transparent (`false`; GH 0x1402321d0, renderer +0x108/+0x110). Its effects then
  apply to the background and its children together. With `false` its last draw is translucent. The scene loop skips
  those children.
  - Ours: a scene-sized group target that the compose layer's base pass reads instead of `_rt_FullFrameBuffer`. The
    subtree's last passes, text and particles draw into it.
  - With `copybackground: false` the children write alpha (coverage). Into the scene or a copying compose layer,
    alpha stays masked as before.
  - With no effect running, the group target is blitted back. composelayer's base pass covers its whole destination,
    and WE never draws it straight to the screen.
- **E33.** WE starts the composite ping-pong at the parity of the passes that write it (GH 0x140214b50: start
  index = (passes − 1 + extra) & 1). So **`_rt_imageLayerComposite_<id>_a` is always what the layer's last pass
  reads**, and `_b` holds the stage before it. The final draw and the BLENDMODE pass read `_a` too. We started at
  `_a` regardless, so with an even number of composite writes the names were swapped.
- The scene clear now writes alpha. The previous frame's last pass left alpha masked, so the scene's alpha was
  whatever the first frame cleared. Compose layers and blend passes read it.

**Inferred / not checked against WE:** no WE capture yet (2883756643, 3414858021 and 3432999904 are still on the
owner list). The blend shader maths is WE's own (`common_blending.h`). Two things here are our reading of the decoded
code: the alpha that the children of a `copybackground: false` layer write, and cropping the subtree to the layer's
quad (WE renders it in the layer's local ortho space; we render it in scene space and the base pass samples the
layer's region).

- **Fork tests** (`host_api_test`): 53/53, 4 new. On 592fdff the three that test behaviour fail. The fourth,
  `color_blend_modes_read_the_scene`, also passes there, because NVIDIA happens to read the old texels through the
  loop.
  - `clampuvs_clamps_the_composite`: an effect sampling at u + 0.5 gets the edge (green); `clampuvs:false` wraps (red).
    On 592fdff the default wrapped.
  - `composite_a_is_what_the_last_pass_reads`: with two effects, `_a` = base + green and `_b` = base. On 592fdff
    they were swapped.
  - `compose_layer_draws_its_children`: the child goes through the layer's tint (yellow). `copybackground` tints the
    background; `false` leaves it alone; with no effect the layer is just background + child. On 592fdff the child
    stayed red.
  - `color_blend_modes_read_the_scene`: mode 31 adds (255 127 0) and mode 2 multiplies the scene (127 0 0).
- **Smoke:** all 96 scenes, `--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`. The same release worker ran on
  592fdff (`we-b8/build/lwe-core-b8`) and on the new core. The metric is the % of pixels differing by more than 8 at
  the 3 s frame.
  - **88 scenes load on both. None was newly blank and none newly failed.** Total mean frame time over the 88 is
    171.3 ms on the old core and 170.2 ms on the new one. A first build that copied for unused samplers cost
    +2–3 ms per frame on 2371103399 and 3163060610; the sampler check fixed that.
  - What changed: 2883756643 85 % (blend modes 7/8/11/12/14/31: the bokeh is now additive and brighter);
    3184155462 80 % (mode 31: lit 90.5 → 97.7 %); 3490034653 50 % (see the next item); 3219908811 15.7 % (modes
    1/4/6/31); 3419466417 4 % (clamping); 3243449890 1.6 % (also 5.5 → 2.5 ms a frame); 3042492564 0.4 %;
    3479521040 0.3 %. The rest are ≤ 0.24 %.
  - 3490034653 is compose layers 930 and 712 with light-shaft particle children and an `opacity` effect that has a
    mask. The shafts are now drawn through the layer and masked as the author set them up: they cover 14 % of the
    frame vs 57 % unmasked before. With their property (`newproperty24`) off, the two cores differ by 0.06 %.
  - 3233141951 (compose layers 378/393 with text children and no effects) is unchanged (0.00 %). Its first build
    drew composelayer's base pass straight to the screen, which hid the dragon; that is fixed and covered by the
    "no effect" case of the compose test.
  - The 8 compose-reference scenes are at 0.00–1.6 %. Their references are masks whose last stage differs little.
- **Can't be checked here:** 8 scenes are blank or fail on both cores, including the pinned 592fdff from the store.
  These are 3276522107, 3477054430 and 3509243656 (the known 3D failures); 3046119914 and 3432999904 (black, as in
  E41); and 3426575339, 3432876246 and 3556794116. The last three are blank at 3 s and at 10 s on every core with no
  error logged. That is new since the E41 smoke, so a pre-B7 fault, and it needs a look. 3414858021's compose layers
  have effects bound to a property that is off by default, so they draw background + children, which is unchanged.
- **0046 (B8 fix).** `engine.registerAudioBuffers` inside `update ()` didn't throw "can only be called from global
  scope". callModule also sets the running module, so the check never fired. The fork's
  `audio_reaches_shaders_scripts_and_emitters` failed on 592fdff, and B8's "49/49" was not reproducible. The engine
  now tracks the module's evaluation.

Left:
- WE captures of 2883756643 (blend modes) and 3414858021 / 3432999904 (copybackground: false) to confirm the inferred
  parts.
- ~~Re-check 2883756643 with its video showing~~ (2026-11-04). Paced, c4eea29 vs 592fdff, two runs each:
  - the cores differ on 81–83 % of pixels, against 0.4–0.9 % between runs of the same core;
  - the frame is brighter (pixels over 200: 30.6 → 35.6 %; mean RGB 161/142/143 → 177/154/148);
  - the bokeh adds over the sky and the hill instead of tinting it, and the rim light glows;
  - no seams or black blocks.

  B7's change still looks right.
- ~~The 3 newly blank scenes (3426575339, 3432876246, 3556794116) and the 2 black ones (3046119914, 3432999904,
  the second of which is a B7 target: compose + blend 12 + `copybackground: false` + text children).~~ All five
  were the smoke, not the core: see "Blank-scene result" below.
- The compose subtree is rendered in scene space at scene resolution rather than in the layer's ortho space. This
  matters only for a rotated or scaled compose layer whose children's texel density differs.

### Blank-scene result (liascape commit, no fork change, 2026-11-04)

- **Not a regression.** The three scenes are blank in `--lwe-smoke` on 3eaac6e (the E41 pin) and c4eea29 alike
  (E41's worker on both cores by `LD_LIBRARY_PATH`: 3426575339 lit 0, 3432876246 lit 118 188 px of 11.2 M = its
  particle trail only, 3556794116 lit 0, nothing changed 1 s → 3 s). E41's own smoke has 3432876246 at `ok: false`
  too, and B5's (`/tmp/claude-1000/b5sm`) 3426575339. They never rendered in a smoke; 0038–0045 aren't involved.
  The scenes on disk are unchanged since 2025.
- **Cause.** Each one's main layer is a video texture (an mp4 inside the `.tex`, 50–560 MB pkgs). The core's
  `CTexture` plays it through libmpv (`GLPlayer`, untimed), which decodes on its own thread in real time. The smoke
  rendered 3 s of scene time in under 0.1 s of wall time, so no frame had been decoded before the last one and the
  layer drew black. The player is paced by the compositor and was never affected (the corpus has them changing
  93–99 %).
- **Fix** (`liascape-scene-worker`, `lwe.rs`): the smoke paces frame f to (f−1)/30 s of wall time after the
  first; `--unpaced` keeps the old run. A 3 s smoke now takes about 3 s per scene.
- **Smoke, all 96 scenes** on c4eea29 (`--seconds 3`, `WPENGINE_PARTICLE_SEED=7`), the same worker unpaced vs
  paced:
  - **Unpaced 88 ok, paced 93 ok.** The only failures left are the three 3D load failures (3276522107,
    3477054430, 3509243656). No scene got worse.
  - The three: 3426575339 lit 0 → 99.3 %, 3432876246 1.1 → 100 %, 3556794116 0 → 100 %; all animate. Also
    rendering now: 3046119914 (0 → 99.8 %) and 3432999904 (0 → 100 %), the two "black" ones, which are video
    scenes too.
  - 12 scenes in the corpus have a video texture, and they are the ones that changed: the five above plus
    2886313155 (lit 0.7 → 100 %), 3028473503 (13 → 100 %), 3326873240 (0.2 → 99.7 %), 3089687436, 2890767643,
    3413117423 (≈0 → ≈100 %) and 2883756643 (56 % of pixels differ). So earlier smoke numbers for these 12,
    including B7's blend-mode comparison of 2883756643, were taken with the video layer black.
  - The other 81: ≤ 0.06 % except 3419466417 at 1.7 % (no video; it varied 4 % between cores in B7 too).
  - Player tests (DEBUG): 737 passed, 0 failed, 3 ignored.
  - Frame time rises with pacing: +0.47 ms median on the 81 without video (the GPU clocks down between paced
    frames) and more on the video scenes, whose frames now include libmpv's work. Compare frame times only
    within one mode.


### B4 result (fork patches 0048–0050, pin `e372e44`, 2026-11-04)

Done: T1 (= E34's text part), T2, T3, T4, T5, T8, T10, G04 (text), G13, G30, S28. Text objects are image layers now,
laid out the way WE lays them out. Everything below was decoded from the sound spike's `all.c` (wallpaper64.exe
2.8.485); the addresses are in the fork commits.

**Decoded (Observed):**

- **Text is an image.** WE's text class extends its image class: its constructor (GH 0x14027c1b0) calls the image's
  (GH 0x140212c50). With effects, WE draws the glyphs into the layer's own FBO (`composelayer_clearalpha`, GH
  0x14027dd90) and runs the image's effect chain on it, its last pass `effectpassthrough` (GH 0x14027ce30). Ours:
  `Text : Image` in the model, and CText is a CImage whose texture `_rt_textLayer_<id>` holds the laid-out text. So
  effects, parent, angles, parallax, alpha, brightness, colour and blend modes all come from CImage.
- **The property table** (GH 0x14027e130) and the constructor's defaults: font `systemfont_arial`, pointsize 32,
  padding 32 32, spacing 0 0, maxwidth 500, maxrows 1. horizontalalign is left 0 / center 1 / right 2, and
  verticalalign is bottom 0 / center 1 / top 2. The flags at +0x594 are opaquebackground 2, limitwidth 4, limitrows 8,
  limituseellipsis 0x10 and blockalign 0x20. anchor runs none 0 … topleft 9.
- **T10, size: 300 dpi.** `FT_Set_Char_Size (face, 0, pointsize · 64, 300)` with pointsize clamped to 1..256 (GH
  0x1401d94c0, 0x1401dd330). A 32 pt text is 133 px in the layer, and the layer's scale (often 0.2–0.3) shrinks it.
  The old renderer used pointsize / scale.
- **Layout** (GH 0x1401dd330, now `TextLayout`):
  - Lines split at `\n`. A glyph advances by `advance >> 6` + spacing.x. The line height is the size's
    `metrics.height >> 6` + spacing.y.
  - limitwidth: a glyph (not the line's first, not a space) whose right edge passes maxwidth breaks the line at the
    last space before it, or at that glyph in a longer word. The rest, less its leading spaces, becomes the next
    line, and the line's trailing spaces go.
  - limitrows: lines past maxrows are dropped. A wrap past maxrows ends the line instead. With limituseellipsis it is
    shortened one character at a time until it fits with "…" after it. Without it, it is cut at the glyph.
  - blockalign justifies a wrapped line: its spaces share what it lacks of maxwidth.
  - Each line is aligned within the widest line. The block spans the glyphs' ink and 0..ascender on every line,
    down to ascender − rows · line height.
- **Placement** (GH 0x14027c600): the quad sits at an offset from the origin, in the layer's own pixels, and turns and
  scales with it.
  - x: +width/2 for left alignment, −width/2 for right.
  - y: the block's centre minus a reference height. That height is the ascender (top), (ascender − (rows−1) · line
    height)/2 (center), or descender − (rows−1) · line height (bottom).
- **The layer's size** (GH 0x14027dd90): the block, plus the padding (clamped to 512) on each side, but only while
  the layer has effects. The glyphs are drawn at padding − min (GH 0x14027d250). An empty text is 2 × 2.
- **T8, fonts.**
  - A `systemfont_*` name is a Windows file in WE: arial.ttf, calibri.ttf, cambria.ttc, comic.ttf, consola.ttf,
    micross.ttf, segoeui.ttf, verdana.ttf (the table read by GH 0x1401dd330).
  - A font that doesn't open falls back to arial.ttf (GH 0x1401d9d70).
  - WE builds a fallback chain for characters the font lacks (GH 0x1401d94c0, 0x1401da3c0) and shapes with
    HarfBuzz.
- **anchor** (GH 0x14027da50) shifts the layer by the visible area's insets: 0 when the scene fills the output. That
  is the case for every output liascape draws today, so it isn't ported (it belongs with G32/C5).

**How the fonts are found on NixOS:** scene-bundled and WE `fonts/…` files are read through the asset locator first.
A `systemfont_*` name goes to fontconfig (the core now links `fontconfig`; the flake adds `pkgs.fontconfig` to
`lwe-core`) with the Windows family first, then metric-compatible and generic ones:

| WE name | Families asked for | Resolved on the owner's NixOS |
|---|---|---|
| `systemfont_arial` | Arial, Liberation Sans, Arimo, sans-serif | `Arimo[wght].ttf` |
| `systemfont_comicsans` | Comic Sans MS, Comic Neue, Comic Relief, sans-serif | `ComicNeue-Regular.ttf` |
| `systemfont_consolas` | Consolas, Inconsolata, DejaVu Sans Mono, monospace | `Inconsolata-Regular.ttf` |
| `systemfont_calibri` | Calibri, Carlito, sans-serif | Carlito |
| `systemfont_cambria` / `segoe` / `sansserif` / `verdana` | Cambria, Caladea, serif / Segoe UI, Selawik, Noto Sans, Open Sans, sans-serif / Microsoft Sans Serif, Liberation Sans, Arimo / Verdana, DejaVu Sans | not used by the library |

The fonts come from the system's `google-fonts`. The nix-built libfontconfig reads `/etc/fonts/fonts.conf`, so it
sees the same fonts as `fc-match`. A character the font lacks comes from the first scalable fontconfig font that has
it (`FcFontSort`). The log line `CText: '<name>' (<id>) font <font> -> <file>` records each choice. "no usable system
font" no longer appears in the smoke.

**Two parse faults found on the way (0049):**

- A text of 2–4 space-separated words ("Sinner #8", "ART MADE BY @Minau_") went through the generic value parser,
  which read it as a zero vec2/3/4. It laid out as nothing, with the old renderer too. Text now stays a string.
- A colour user property written with whole numbers (`"1 1 1"`) was read as 0..255, so it came out near black. That
  covers 117 of the library's colour properties, none with a component above 1: e.g. 2134765860's clock, bound to
  `clock1` = "1 1 1", drew at 1/255. Colour properties now read whole 0/1 as 0..1. Object and particle colours keep
  0..255 (particle colorrandom writes it).

**Inferred / not WE's:**

- Glyphs come from FreeType with the font's kern table. WE shapes with HarfBuzz, so there are no ligatures and no
  GPOS kerning (most of the width differences below).
- The glyph fallback is fontconfig's choice, not WE's chain.
- The text texture is mipmapped. The colour is baked into it, because genericimage2 doesn't take g_Color4 in LWE;
  alpha and brightness stay live in the pass, and a colour change redraws the texture.
- The text with effects starts from colour × coverage, as WE's font pass does, but through the image's own base pass.
- Not ported: `opaquebackground`, `backgroundcolor` and `backgroundbrightness` (T6, used by 0 scenes); `outline*`,
  `dropshadow*`, `blursize` and the MSDF path (T7, 0 scenes); `anchor` (above). On the WE side, `depthtest` picks a
  `_depth` material variant.

**Fork tests** (`host_api_test`): 58/58, 5 new. All five fail on c4eea29.

| Test | What it checks | On c4eea29 |
|---|---|---|
| `text_follows_its_parent_and_turns` | a child text at the group's origin + (20, 0) is at x 180; a 90° text is tall | not drawn; upright |
| `text_lays_out_like_we` | a 10 pt H is 29 px (300 dpi: 29.8); "H\nH" is two lines (34 px); left/right alignment puts the ink at the origin (42 / 215 for 40 / 216); "éé" is as wide as "ee" | 1 px H, no lines, "ee" 0 px |
| `text_takes_effects_and_colour` | an effect turns the text red, in place; colour 1 0 1 reaches it | white, flat |
| `colour_property_whole_numbers` | text bound to a colour property "1 0 0" is red | black |
| `text_wraps_and_limits` | "HHH HHH HHH" is 113 px on one line, wraps at maxwidth 100 to 73 × 34, and is cut to one row with "…" (86 × 12); spacing 10 adds 10 px; a script's `thisLayer.horizontalalign = 'left'` applies | nothing drawn (the vector parse) |

**Size check against the editor.** The editor saves each text layer's laid-out `size`. `WPENGINE_TEXT_DEBUG=1` logs
ours next to it at load; for scripted texts both come from the placeholder. Across the 45 text scenes, 260 objects
load; the other 54 are in the two 3D scenes that fail to load. Of the 50 literal texts with a saved size:

- **44 match in height within 2 px**: 36 of 39 in scene fonts, 8 of 11 in system fonts.
- 34 match in width within 3 %.
- The width misses are CJK and Latin texts in scene fonts with no kern table (shaping), and Comic Neue / Arimo for
  Comic Sans / Arial.
- The height misses: 2561227934 "ART MADE BY @Minau_" (Comic Neue's line height 144 vs Comic Sans' 174), a
  two-line Comic Sans label in 3354740764, and 3480481965's single CJK glyphs, which take a fallback font.
- With 0048 alone, 20 of these 50 laid out as nothing because of the vector parse; with 0049, none do. The one
  2 × 2 left is a genuinely empty text whose saved size is the same 66 × 66.

**Smoke, all 96 scenes**, paced (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`). The same worker ran on
c4eea29 (the store core) and on e372e44, one run after the other with nothing else running. The metric is the % of
pixels differing by more than 8 at the 3 s frame.

- **93 ok on both. No scene newly blank or failed.** The 3 failures are the known 3D ones.
- The text scenes that changed most:
  - 2890767643, 56 % (its VHS time/date in Inconsolata; it also has a video);
  - 3480481965, 52 % (lit 49.9 → 100 %: the white half and "LIFE / DEATH" now match the author's preview; the white
    half is a colour property);
  - 3326873240, 19 %; 3028473503, 19 % (its 58 pt clock was a speck under the notice and is now at its place);
  - 3163060610, 9.5 %; 2932157836, 7.9 %; 2883756643, 3.7 %.
  - 1884904087's greeting and clock and 2134765860's wall clock now show (0.4–0.5 % of pixels: the text is small in
    the frame).
- Of the 50 scenes without text, 46 are within 0.3 %. The other four:
  - 2886313155 (25 %), 3046119914 (16 %) and 3432876246 (1.7 %) are video scenes, whose frame at 3 s varies with
    decode timing;
  - 3419466417 (4.2 %) varied 4 % between cores in B7 too, and its `embercolor` "1 0 0" is now red.
- Mean frame time over the 93: 3.70 → 3.86 ms. On the 43 text scenes it is 4.57 → 4.93 ms (median +0.35 ms): their
  effects run now, and each text is an image's passes.

Player tests (DEBUG, the pinned e372e44): 737 passed, 0 failed, 3 ignored.

Left:
- WE captures of 1884904087 and 2134765860 to confirm size and layout against WE itself. The editor's saved sizes
  already agree on height.
- HarfBuzz shaping (ligatures, GPOS kerning), WE's own fallback chain, T6/T7, and `anchor` with G32/C5.
- Cursor hit tests reach text layers now (they are CImages); B10 listed them as missing.

### B11 result (fork patches 0051–0053, pin `2559b88`, 2026-11-04)

Done: P2, P10, P15, P22, P28, P31, P32, P33, P34, P35. Decoded from wallpaper64.exe 2.8.485. The operator interpreter
GH 0x140265800, which the audit's headless decompile couldn't do, decompiled in REA's Ghidra with the decompile
timeout lifted (REA Evidence `ev_f2306217434a69653a5428555d60f1183bc49a221e48a046ecfc1ffd5d22eadb`). It is a byte-code
loop over 4-wide particle arrays (SoA at system +0x258…+0x338; count +0x340). The record layouts come from the
parser's stores (GH 0x1401f3120): every record allocator at GH 0x1402060b0…0x140206be0 writes its opcode and size.

**Opcodes** (operator stream): 1 movement, 2 angularmovement, 3 alphafade, 4 sizechange, 5 colorchange, 6 alphachange,
7 oscillateposition, 8 oscillatealpha, 9 oscillatesize, 0xa controlpointattract, 0xb maintaindistancetocontrolpoint,
0xc maintaindistancebetweencontrolpoints, 0xd reducemovementnearcontrolpoint, 0xe turbulence, 0xf vortex,
0x10 vortex_v2, 0x11 boids, 0x12 capvelocity, 0x13 remapvalue, 0x14 inheritvaluefromevent, 0x15–0x1a collision
plane/sphere/box/bounds/quad/model. The jump table is at 0x140271798.

**Decoded (Observed):**

- **The interpreter's head** resets size from its base array every step, and alpha and colour too when the system has
  an operator on them (flags +0x24 bits 0x10 / 8). Each operator then **multiplies**, so alphafade × alphachange ×
  oscillatealpha compose. Before, alphachange overwrote alphafade and the oscillators kept their own base.
- **Two dts.** The interpreter's second argument is the step's dt. The third, "fdt", scales drag and every force:
  fdt = dt · min (0.025 / x, 1)^0.7 (GH 0x14025c2e0). x is a host float at +0x14c, **inferred** to be the frame time,
  so the forces weaken below 40 fps. Below a frame-rate setting of 20 the step runs as two halves.
- **movement** (rec +0x10 gravity, +0x1c flags, +0x20 drag): v' = v + g·dt, p += v'·dt, v = v'·(1 − min (drag·fdt,
  0.9999999)). **angularmovement** does the same on rotation (force +0x10/+0x20/+0x30, drag +0x80). Only gravity and
  force carry the speed override.
- **alphafade**: ×life/in before `in`, ×(1 − life)/(1 − out) after `out`. **sizechange / alphachange / colorchange**:
  a clamped life ramp (start +0x10, end − start +0x20, starttime +0x30, 1/(endtime − starttime) +0x40). Both are
  relative (P31, P32).
- **Override bindings** are patch records (op 7 = start/range ×, GH 0x1401ff240):
  - sizechange's start and end carry the **size** override, and sizerandom does too. A system with both takes the
    override squared (P32), unless the particle flags have 0x80.
  - colorchange's values are colorn-shifted (op 0xc).
  - turbulence's timescale carries the **rate** override.
  - oscillateposition's frequency carries **speed** (P15).
- **One random per particle** (the array at +0x338, drawn at spawn) drives the oscillators and turbulence:
  - oscillatealpha / oscillatesize (freqmin +0x10, range +0x20, phasemin +0x30, range +0x40, scalemin +0x50, range
    +0x60): f = fmin + r·Δf, φ = pmin + r·Δp, value ×= smin + Δs·r·(sin (f·(age + φ)) + 1)/2.
  - oscillateposition (mask +0x10/+0x20/+0x30, then freq, phase and scale): the offset s·sin (f·(age + φ)) applied as
    this step's difference. y uses φ + 2πr; z reuses x's.
- **controlpointattract** (offset +0x10, scale +0x40 × speed, threshold +0x50, deletethreshold² +0x60, flags +0xb0,
  controlpoint +0xb4; keys GH 0x1401eb290):
  - within FLT_MIN < d < threshold, v moves toward the point by scale·fdt·(1 − d/threshold);
  - flags 2: never past it; flags 1: a particle within deletethreshold dies (GH 0x1402505d0 tests the step's swept
    segment; ours tests the point);
  - `origin`, which 17 systems write, is not read. LWE's halved threshold was wrong.
- **vortex** (offset, axis, inner +0x70, 1/(outer − inner) +0x80, speedinner +0x90, speed range +0xa0, infinite-axis
  mask +0xb0, cp +0xc0): v += (r̂ × axis)·(speedinner + t·Δspeed)·fdt. Plain vortex reads only flag bit 0. LWE applied
  vortex_v2's ring and centre-force bits (2, 4), which 4 scenes set, to it.
- **turbulence** (mask +0x10…, scale +0x40, speedmin +0x50, range +0x60, phase range +0x80, timescale +0xd0, masked
  axes +0xd4):
  - per masked axis, a 3D simplex noise of (position + r·Δphase + time·timescale)·scale, the coordinates rotated per
    axis (x: xyz, y: zxy, z: yzx), × (speedmin + r·Δspeed)·mask·fdt;
  - the noise is the SSE object at 0x1405272a8, vtable slot 2 → GH 0x14012c280;
  - phasemin is never read.
- **boxrandom speed** (P22): the velocity points outward from the box's centre, in a random direction when the
  particle is at it (GH 0x14025cfe0).
- **Children** (P2):
  - parser 0x1401fe52a with defaults GH 0x1401eec40: the file is `name`, type static, probability 1, maxcount 10.
    Types (0x1401feff4): static 1, eventfollow 2, eventspawn 3, eventdeath 4.
  - Follow and spawn children are taken per spawned particle in emission (GH 0x14025cfe0), death children per dead
    particle (GH 0x14025c2e0). Each takes a probability roll from the scene RNG under maxcount. A reused instance is
    reset (GH 0x140254f50) and prewarmed (GH 0x140254cc0).
  - A follow child is rebound to its particle every step (GH 0x1402507e0: translate (particle) × the child's
    origin/angles/scale). When the particle dies, its emitters stop (bit 31, GH 0x140254ed0).
  - Children share the object's override table (GH 0x140251f70 recurses into them).
- **Control points** (GH 0x140251f70, GH 0x1402504f0):
  - instanceoverride controlpointN replaces the offset unless the flags have 0x10005;
  - flags bit 1 = the offset is in the scene's space, turned into the system's by the inverse of its transform;
    control point 0 ignores the bit;
  - system flags bit 0 = world-space simulation (not ported).

**Inferred / not WE's:**

- A child simulates in its parent's space. Its particles spawn at its offset and stay where they were emitted. Event
  instances are pooled until they have no particles and no emitter left (GH 0x1402524c0, not read). One renderer per
  event child entry draws all its instances: 3174556087's 350 rain-splash instances had compiled a pass each (439 ms
  frames).
- A child with a controlpointstartindex takes its parent's control points from there on. Children draw after their
  parent.
- Control point offsets are now mirrored in y like emitter origins, since both are WE's y-up particle space. 8 scenes
  have a control point with y ≠ 0. A pointer control point's offset is mirrored too.
- Turbulence uses a standard simplex, not WE's gradient hash. vortex_v2 keeps LWE's model; it wasn't decoded and no
  library scene uses it.

**Fork tests** (`host_api_test`): 61/61, 3 new, all failing on e372e44.

| Test | What it checks | On e372e44 |
|---|---|---|
| `particle_operators_as_we` | two alphachange 0.5 → 62/255 (0.25); box particles 10 px from a point with threshold 15 pulled in; sizechange with size 2 is 16 px; a box particle with speed 40 leaves its spawn point | 125/255; stay at their spawn points; 8 px; at rest |
| `particle_children_run` | a static child at its origin; an eventfollow trail x 10…30 behind a moving particle; an eventdeath child where its particle died; an eventspawn child only at the spawn point | nothing drawn |
| `particle_control_points` | controlpoint1 override puts the spawn at x 20; a scene-space point (flags 2) of a scale-2 system at x 56; point "0 8 0" on the same row as origin "0 8 0" | x 8; off; rows 23 vs 7 |

**Smoke, all 96 scenes**, paced (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`), e372e44 then 2559b88. The
second run partly overlapped a `nix build`.

- **93 ok on both. No scene newly blank or failed.** The 3 failures are the known 3D ones.
- Lit pixels match within 1 % on all but 3419466417 (98.98 → 99.99 %).
- 29 scenes differ by under 0.3 % of pixels. The rest are particle scenes: different RNG draws, operators and
  children. The largest movers are videos and animated scenes (2886313155, 3478602089, 3414858021's rain).
- Mean frame time 3.82 → 3.61 ms. 3174556087 is 6.0 → 7.2 ms with its 350 splash children.

Player tests (DEBUG, the pinned 2559b88): 737 passed, 0 failed, 3 ignored.

Left (in TODO):
- WE captures of a child-system scene (3174556087 splashes, 2288455459 firefly trails) and an oscillating one to
  confirm the decoded forms visually.
- P29 (sprite `orientation`, 3174556087's splashes) and P30 (rope/trail combos).
- P27 (mapsequence bounds/limitbehavior/mirror/axis, 3 scenes).
- controlpointangleN, system flag bit 0 (world-space simulation, 16 scenes), WE's simplex hash, vortex_v2.
- P24 cone, P25/P26 (0 scenes).
- The fdt frame-time source (+0x14c) and the child "alive" test (GH 0x1402524c0) to read.

### B12 result (fork patch 0054, pin `36ad6a0`, 2026-11-04)

Done: G06, G07, G08, G09. Decoded from wallpaper64.exe 2.8.485 with the sound spike's `all.c` (the loader decompiled
there in full; no REA session was needed). The decoded format parses every one of the library's 50 puppet `.mdl`
files to each section's exact end (a Python port of the loader, scratchpad `b12/mdl.py`).

**The MDL loader (GH 0x1402873f0, Observed):**

- `MDLV00NN` (WE takes NN ≤ 23), then a default format word, strings per mesh, mesh count. Per mesh: the strings (the
  material first), flags from v4 (bit 0 = 32-bit indices; bit 1 adds an influence count), six bounds floats from v17,
  the format word from v15 (before, the header's), a vertex blob and an index blob. v21 adds two optional blobs, v23
  a list of groups.
- **The vertex layout is the format word**, not the version: components in the order of the tables at 0x1404c4da0
  (masks) / 0x1404c4e10 (sizes): position 0x1 (12 B) or 0x10000 (vec4, 16 B; exactly one of the two), 0x2000000
  rejected, normal 0x2 (12), tangent 0x4 (16), blend indices 0x800000 (4 × u32), weights 0x1000000 (4 × f32),
  texcoord 0..5 (0x8/0x10/0x20, 0x40…: 8/12/16 B each), colour 0x8000 (16). The library has 0x1800009 (52 B: MDLV
  0013/0016), 0x180000f (80 B: 0017–0023), 0x181000e (84 B, vec4 position: 3490034653's 人物1), 0x9 and 0xf (static).
  PR #625's "per-version stride" was right only for the formats it met.
- Then sections, each a tag and the absolute offset of its end (GH 0x1402872e0 skips by it): MDLS, MDLA, MDAT, MDMP,
  MDLE.
- **MDLS** (bones ≤ 0x80): name, flags, parent (−1 or earlier), the bind matrix as a sized blob (≤ 64 B, relative to
  the parent: column-major, translation at 12–14), a JSON string (physics settings). From v2: a u16 list of 0x80-byte
  IK targets, a flag + explicit matrices, a u32 constraint list (v4 adds flags), then more IK/physics data.
- **MDLA**: per animation an 8-byte id (the low u32 is `animationlayers[].animation`), name, mode string, fps, frame
  count F, flags, track count = bones. A track is its flags + (F + 1) × 9 floats (position, Euler angles, scale; the
  loader turns the angles into a quaternion with `cosf`/`sinf` of the halves, GH 0x14028a10a: glm's `quat (vec3)`,
  R = Rz·Ry·Rx). Per version after the tracks: v2 the targets' and constraints' tracks, v3 up to 16 curves and the
  bones' alpha tracks, v4 blend-shape weights per mesh, v5 six u32s, v6 another per-bone float track, flags bit 0 an
  18-byte root-motion record, then the events (frame, name). PR #625's "zero footer" was these blocks empty.
- **MDAT**: u16 count; bone (u16), name, 64-byte matrix relative to the bone.

**The animation (Observed unless marked):**

- Bind world = parent world · local (GH 0x1402261c0); skin = world(pose) · bindWorld⁻¹, applied as
  Σ weight · skin · position like genericimage2's SKINNING path. **No angle negation**: the bones and the mesh share
  the image's y-up space (PR #625 negated x and z, mirroring every 2D rotation).
- A layer's clock (GH 0x1401d4d00): frame 1/fps, length F/fps, mode loop / mirror (bit 0, bounces) / single (bit 1,
  stops). It runs at dt · rate (GH 0x1401d6a00). Frames a = clamp (⌊t·fps⌋, 0, F − 1), b = min (a + 1, F), the
  fraction within the frame (GH 0x1401a00a0); samples are lerped (position, scale) and nlerped on the shorter arc.
- The layer object (GH 0x140291d20, properties GH 0x140292030): rate +0xc8 (1), blend +0xcc (1), flags +0xd0 (bit 0
  visible, default on; bit 1 additive; bit 2 blendin; bit 3 blendout), blendtime +0x18c (0.5). Weight
  (GH 0x140291f60) = blend × min (t / min (length/2, blendtime), 1) while blendin (cleared once 1 unless single) ×
  min ((length − t) / that, 1) with blendout. Not clamped: the library has blends −1, −0.5 and 2.
- Mixing (GH 0x140228470): from the bind pose (decomposed local matrices), each visible layer in order. Normal
  (GH 0x140223b90): pose = lerp (pose, sample, w), rotation nlerp. Additive (GH 0x140224390): position += (sample −
  bind) · w; rotation by nlerp (1, sample · bind⁻¹, w). A track whose flags have bit 0 leaves its bone alone (the
  blendvps mask). **Inferred:** the additive scale (taken as position) and the product order of the additive
  rotation (they commute for the 2D z turns these files use).
- **Attachments**: `attachment` is looked up by name on the parent (GH 0x14020be30) and the world transform
  (GH 0x1401b5170) is parent world · attachment · local. **Inferred**: the attachment is the bone's posed world · the
  MDAT matrix (the vtable call +0x78 that builds it wasn't read).
- Skinned z flattened, and `autosize` growing the canvas to the mesh's extent over every frame: **inferred**, kept
  from PR #625.

**What LWE did wrong (changed):**

- `CImage::loadPuppetMesh` took only MDLV0021/0023, byte-scanned for a block that looked like 80-byte vertices and
  read 16-bit indices: 7 scenes (MDLV 0013/0016/0017/0019) drew the whole sprite sheet. It drew the bind pose only.
- `animationlayers`' `visible` defaulted to false, and `additive`, `blendin`, `blendout`, `blendtime` weren't parsed.
- `attachment` wasn't parsed: 3463520581's hair, 3414858021's body parts and 3363252053's head sat on the parent's
  origin (Asuna was bald).
- A puppet layer without effects draws its only pass to the scene; LWE gave that pass the mesh in layer pixels
  under the scene's projection, so it landed in the wrong place (only puppets with an effect looked right).

**Fork tests** (`host_api_test`): 62/62, 1 new, failing on 2559b88.

| Test | What it checks | On 2559b88 |
|---|---|---|
| `puppet_warp_as_we` | an MDLV0016 puppet (52-byte vertices) skinned by its animation to x 22..25; an MDLV0023 one (80-byte vertices, 32-bit indices) with a normal layer to +4 and an additive one to +8 at blend 0.5 at +8 (x 54..57); a square attached to its "tip" 8 px up at x 54..57 | the whole 32 px quad; nothing (misread); the square on the parent's origin (x 46..49) |

**Smoke, all 96 scenes** (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`), 2559b88 then 36ad6a0, with B13
and B14 building on the machine:

- **93 ok on both, none newly blank or failed**; the 3 failures are the known 3D ones. 2883756643 came out with its
  video black in the new run only (lit 100 → 60 %); alone it is 100 % lit (a video start under load, as in the
  blank-scene result).
- The puppet scenes change most: 3233141951 29.6 % of pixels (the girl's face and the dragon's eye are drawn now),
  3490034653 22 %, 3013489778 17 %, 3414858021 17 %, 2375914945 16 %, 3463520581 11 % (attached hair and head in
  place), 3022080536 9 %, 3363252053 6 %. 3042492564 (MDLV0017 × 9) 0.9 %.
- Frame time is within the load's noise (puppet scenes run alone: 2375914945 4.4 → 3.3 ms, 3233141951 6.2 → 7.2 ms
  with 9 000 skinned vertices, 3243449890 12.1 → 9.6 ms).

Left (in TODO):
- A WE capture of 3463520581 or 3233141951 to compare poses (and the attachment's inferred form) against WE itself.
- GPU skinning (SKINNING, `g_Bones`), bone alpha (SKINNING_ALPHA, MDLA v3's alpha tracks), blend shapes (MDLE, MDMP;
  13 files), IK and physics bones (MDLS v2+, bone flag 2), root motion, animation events, the scripted layer API
  (`getAnimationLayer`, `playSingleAnimation`, S26), `autosort`/`index` layer order.
- Read the attachment builder (vtable +0x78 of the puppet image) and the additive scale.

### B13 result (fork patch 0055, pin `c62d777`, 2026-11-04)

Done: E35, E23 (E37 was B9's patch 0032). Decoded from wallpaper64.exe 2.8.485 with the sound spike's `all.c` and
`all.asm`; constants and strings read from the same bytes. The pin also carries B12's 0054.

**Decoded (Observed):**

- **Keys and defaults.** `hdr` is general flag 0x400 (setter GH 0x1401c95e0). `bloomhdrstrength`, `…threshold`,
  `…feather`, `…scatter`, `…iterations` are general +0x388/+0x38c/+0x390/+0x394/+0x398 (key table GH 0x1401c7880).
  The scene constructor GH 0x1401b6c60 sets them to 2, 1, 0.1, 1.619, 8, and `bloomstrength`/`bloomthreshold` to
  2 / 0.65. LWE's LDR defaults were 0 / 0; they are WE's now.
- **Which chain.** The scene tick GH 0x1401afbf0 reads the renderer's flag 0x2000. With it, it loads
  `combine_hdr_upsample` (`combine_dhdr_upsample` with 0x4000, an HDR display), `combine_srgb`, `hdr_downsample`,
  `hdr_downsample_bloom`, `hdr_upsample` and `hdr_upsample_cubic`, and not the LDR materials. With bloom on it runs the
  chain (GH 0x1401b3b10) and the combine; with bloom off, `combine_srgb`.
- **Targets** (GH 0x1401af5b0). With the flag the scene FBO is RGB161616f. One bloom level per halving of the smaller
  side, up to 8, is named `"_rt_" + (2 << level) + "FrameBuffer"` (strings 0x1404cf9b0) and is RGB161616f. Without it
  the LDR `_rt_4FrameBuffer`, `_rt_8FrameBuffer` and `_rt_Bloom` are made instead.
- **The chain** (GH 0x1401b3b10):
  - level 0 = `hdr_downsample_bloom` from the scene; level i = `hdr_downsample` from level i − 1;
  - g_RenderVar0 = (1, 1, −1, −1) · 2^i / the scene size (constants 0x1404d4238 = 1, 0x1404d4548 = −1): one source
    texel for the four taps;
  - then from the last level up, each onto the one above, additive: `hdr_upsample_cubic` for the two coarsest steps,
    `hdr_upsample` after, g_RenderVar0 · 2^level (half a source texel);
  - the combine reads the scene (g_Texture0) and level 0 (slot +0xd8).
- **Parameters** (GH 0x1401b42b0, re-run when general changes):
  - levels n = min (`bloomhdriterations`, levels made), at least 1;
  - g_BloomStrength = strength / (scatter^(max (n, 2) − 2) + 1). The call at 0x1401b436a takes (scatter, n − 2) and
    has a CRT powf's shape: **inferred** powf;
  - `blend` = (t, t − t·f, 2·t·f, 0.25 / (t·f + 1e-5)), a soft knee (0x1404d4184 = 0.25, 0x1404d40e0 = 1e-5);
  - `bloomtint`; both upsample materials' `scatter`.
- **FBO formats** (E23). The effect FBO parse (GH 0x140216080) maps `rgba_backbuffer` to 0xe (RGBA16161616f) with the
  flag, else 0; `rgb_backbuffer` to 0xf / 1; other names through GH 0x1402116c0's table, which is the .tex enum
  (`rgba8888` 0, `rgb888` 1, `rgb565` 2, `rg88` 8, `r8` 9, `rg1616f` 10, `r16f` 11, `rgba16161616f` 14,
  `rgb161616f` 15, `rgba1010102` 13, …). Image composites are 0xe with the flag, else 0.

**Ours:**

- CFBO allocates the format it is given: RG8, R8, RG16F, R16F, RGBA16F, RGB10_A2. An RGB format is RGBA16F with alpha
  read as 1. Before, every FBO was RGBA8.
- An HDR scene's FBO, composites, compose-layer targets and sampling copies are RGBA16F. LWE keeps alpha (compose layers
  and blend modes read it). The output copy into the host's framebuffer converts to its format and clamps, as WE's
  saturate does, so the dmabuf the compositor imports is unchanged.
- The HDR chain is a bloom image like the LDR one, from a virtual effect per level count (`bloomhdr<n>.json`). CScene
  points its passes at g_RenderVar0, the strength, knee, tint and scatter, and recomputes them every frame.
- The combine is `combine_hdr_upsample_linear` (no `lin ()`). WE's `combine_hdr` and `combine_srgb` apply `lin ()`
  and × g_RenderVar0.x. That only round-trips through an sRGB backbuffer view, which is **inferred** (an HDR scene
  without bloom would otherwise look darker in WE than in its editor). We write to a plain RGBA8 target.

**Inferred / not WE's:**

- **The gate.** WE sets the renderer's 0x2000 from its "postprocessing" setting `ultra` (0x6000 for `displayhdr`;
  GH 0x14013f860, passed to the renderer at GH 0x140141520). How `general.hdr` gates it was not found. Below Ultra,
  WE shows these scenes with the LDR chain. LWE has no quality setting: a `general.hdr` scene renders HDR unless
  `WPENGINE_HDR=0`.
- `bloomhdriterations` is read at load. `hdr` is read at load.
- g_TexelSize stays LWE's 1 / scene size. WE's is 1 / the current target (renderer +0x74).

**Fork tests** (`host_api_test`): 64/64 with B12's, 2 new, both failing on 2559b88.

| Test | What it checks | On 2559b88 |
|---|---|---|
| `hdr_bloom_is_wes_chain` | two additive 0.6 squares (1.2) glow 3 px out (11 11); a single 0.6 one doesn't (0 0); the same scene with `hdr: false` blooms both through the LDR chain | 6 6 past the dim square: LDR chain, threshold 0.3, 1.2 clipped |
| `fbo_formats_as_written` | an rg88 FBO of (0.2 0.4 0.6) reads 51 102 0; `rgba_backbuffer` of 2.0 read × 0.25 is 127 in an HDR scene, 64 otherwise | 51 102 153; 64 in both |

**Smoke**, paced (`--lwe-smoke … --seconds 3`, `WPENGINE_PARTICLE_SEED=7`), 2559b88 then the B13 core (before the
rebase onto B12):

- **All 96: 93 ok on both, the same 3 known 3D failures, none newly blank.** Lit pixels within 1 % everywhere but
  2883756643, whose video frame differs between runs (60 vs 100 %; same on reruns of the old core).
- Mean frame time 4.24 → 4.63 ms, with another agent loading the machine. The outliers (3489263099, 3243449890,
  2375914945) are LDR scenes; interleaved reruns show them within noise.
- The 4 HDR scenes that load (3509243656 is a 3D failure):

| Scene | bloom | frame ms old → new | Look |
|---|---|---|---|
| 2511663284 | off | 2.8 → 4.0 | unchanged (half float targets only) |
| 2542468435 | on, 2 levels | 1.3 → 2.4 | close; the LDR wash on mid-tones is gone |
| 3019192537 | on, 8 levels | 1.7 → 2.4 | glow only on the brightest parts |
| 3395587987 | on, 8 levels | 0.7 → 1.2 | the LDR chain's threshold 0 washed the whole frame; now the snow and highlights glow |

Half float targets cost about 1 ms per frame at 4K here. VRAM rises by half the size of each RGBA8 target they replace:
for a 3840 × 2160 scene, ~33 MB for the scene FBO, the same per composite.

Left (in TODO):
- A WE capture of 3395587987 or 3019192537 at post-processing **Ultra**, to check the look and the inferred gate.
- Whether `general.hdr` alone gates WE's HDR path (the renderer flag's link to it wasn't found).
- `combine_dhdr_upsample` (HDR displays) and `combine_video_hdr` (flag 0x10000) are not ported.

### B14 result (fork patch 0056, pin `157c111`, 2026-11-04)

Done: G24 (3D scenes load), G22 (3-axis angles, origin z, full parent matrices for world-placed layers), G25 (static
MDL meshes with `generic4`), G26 point and spot lights (E13), G28 fog (E14), the `transparentsorting` part of G29, and
the 3D camera (camera objects, shake). Decoded from wallpaper64.exe 2.8.485 with the headless `all.c`; every function
below decompiled there, so no REA session was needed. The three corpus scenes that failed to load now load and draw.

**Decoded (Observed):**

- **Perspective or orthographic.** The scene loader GH 0x1401b6c60 sets the ortho flag (scene +0xe0 bit 0x8) only
  when `general.orthogonalprojection` is an object with a width and height (or `auto`). An absent or null member
  means a 3D scene. LWE required it and threw "Projection must have a width".
- **Projection** (GH 0x1401b3f70). Without the ortho flag it calls the renderer's perspective (vtable +0x10) with:
  - the effective fov (scene +0x148) × π/180;
  - the target's aspect, width / height;
  - general nearz (+0x14c) and farz (+0x150).

  The effective fov is general.fov (+0x140), or perspectiveoverridefov (+0x144) in an ortho scene. The active camera
  object's fov replaces it, and it is clamped to 0.1–179.9 (camera update GH 0x1401b8af0). The camera then reads back
  2·atan (1 / m[1][1]), so the fov is the vertical one.
- **View** (GH 0x1401b8af0, lookAt GH 0x1401cb340). The lookAt is right-handed and the same as glm::lookAt
  (s = normalize (f × up), the third column −f).
  - The active camera object is the last one in the list that is effectively visible.
  - From its world matrix: eye = the translation, centre = eye − the z axis (row 2), up = the y axis (row 1).
  - With no camera object it is camera.eye/center/up.
  - All three corpus scenes have a camera object. In 3276522107 it puts the eye inside the train. The scene camera
    looked at the train from 2 units behind it, which made the train look small.
- **Shake in 3D** (GH 0x1401c7680). The offset is (cos t, sin 1.333 t, sin t) with t = speed² · time. Its length is
  raised to roughness³ (unless that is ≤ 0.001 or 1), then × amplitude · 0.1. It is added to both the eye and the
  centre. In 2D, z is 0 and the amplitude is × height · 0.1 (B5).
- **Object matrix** (GH 0x1401b5170): world = parent world · local. The local matrix is the rotation rows scaled per
  axis, then the origin. The rows come from the angles (GH 0x14020af40), (cy·cz, cy·sz, −sy), …, which in column form
  is R = Rz · Ry · Rx. The multiply GH 0x14005ff00 is local · parent in row vectors.
- **Lights.**
  - Properties (GH 0x140283df0): color +0x2cc, intensity +0x2e4, radius +0x2e8, exponent +0x2ec, innercone +0x2f0,
    outercone +0x2f4.
  - Packing (GH 0x1401bf270), per visible point or spot light (type byte +0x2c0: 0 point, 1 spot):
    - `g_LCluster_Origin` = (world translation, radius);
    - `g_LCluster_Color` = (colour · intensity, exponent);
    - for a spot, `g_LCluster_Direction` = (its normalised world x axis, 1 / (cos inner − cos outer)), the cones in
      degrees;
    - `g_LCluster_Extra.x` = −cos outer / (cos inner − cos outer).
  - The generated `PerformLighting_V1` (GH 0x140197e20) loops over the point and spot lights. Per light: spotCookie =
    smoothstep (0, 1, −dot (normalize (delta), dir) · dir.w + extra.x), then `ComputePBRLightShadow` with radius =
    origin.w and exponent = color.w. LWE's stub returned 0.
- **Fog.** The general fields fogdistancecolor +0x344, fogheightcolor +0x350, fogdistancestart/end/startdensity/
  enddensity +0x35c…+0x368 and fogheight* +0x36c…+0x378 are registered in GH 0x1401c7880. GH 0x1401ba300 builds
  `g_FogDistanceParams` = (start, end − start, startdensity, enddensity − startdensity), and the height params the
  same way.

**Ours (not decoded):**

- A 3D scene renders at 1920x1080. WE uses its output's size; LWE builds the scene before it knows the output.
- `transparentsorting`: every run of world-placed objects (models, particles, layers that aren't full screen) is drawn
  back to front by the distance of its origin from the eye. Full-screen layers and the bloom keep their place in the
  order. WE's sort key was not read.
- A model material without `depthtest`/`depthwrite` gets both enabled. The scene's target gets a depth buffer.
  Culling is off for models, because the target's y flip reverses the winding.
- A point light's direction terms are (0, 1), so its spotCookie is 1. At most 8 lights, without clusters.
- A world-placed layer draws its quad in its own pixels: `alignment` anchors the quad at the origin, as in 2D.
  Particles use the 3D camera through LWE's scene space (x − w/2, h/2 − y).
- A texture with flag bits LWE doesn't know now loads. 3509243656's PBR masks carry 0x800000 and were rejected.

**What was wrong in LWE:**

- The parser required `orthogonalprojection`.
- `Camera` had only the ortho projection, translated by the eye.
- Layers used only `angles.z` and drew at z 0.
- `model` objects fell through to placeholders, and lights were logged as unsupported.
- `PerformLighting_V1` returned 0, and nothing fed the fog uniforms.
- `parseTextureFlags` threw for any value ≥ `TextureFlags_All`.

**Fork tests** (`host_api_test`): 68/68 on `157c111` (B12 + B13 + this patch), 4 new, all failing on 36ad6a0
("load/build failed").

| Test | What it checks |
|---|---|
| `perspective_scene_loads` | a null `orthogonalprojection` scene loads; a 2-unit layer 10 units away is 232 px (2 / (20 · tan 25°) · 1080), centred; a layer 3 units up is on the same side as a 2D scene's high y |
| `layer_tilts_and_moves_in_depth` | 60° about y is about half as wide (114 vs 230 px); at z 5 it is twice the size; a 2 x 1 child of a z-turned parent at z 5 stands upright, 230 x 462 |
| `model_draws_and_lights` | an MDLV0016 quad with generic4: unlit it is white; lit with no light it is black; a point light, and a spot whose x axis points at it, light it; a spot pointing away doesn't |
| `fog_and_depth` | fog from 0 to 5 at density 0 → 1 turns a model 10 units away red; a nearer model drawn first stays in front of a farther one drawn after it (depth test) |

**Smoke, all 96 scenes**, paced (`--seconds 3`, `WPENGINE_PARTICLE_SEED=7`), 36ad6a0 then this patch on it:

- **93 → 96 ok. No scene newly blank or failed**; lit pixels match within 1 % on every scene that loaded before.
- The pixel differences above 3 % are videos and clock/animated scenes (2883756643, 2886313155, 2890767643,
  3028473503, 3326873240, 3556794116, 3046119914, 3419466417), as in B11's runs: timing, not this patch (nothing a
  2D scene runs changed, except texture flags none of them carry and a lighting loop with no lights).
- Mean frame time of the 93: 3.61 → 3.79 ms (the second run overlapped builds). The 3D scenes: 7.6, 1.0 and 11 ms.
- The 3 scenes also load and draw the same on `157c111` (B13's HDR on top; 3509243656 is an HDR scene).

- 3276522107 (metro car): matches its preview. The car's interior fills the view, the passing buildings show through
  the windows, and the girl sits on the right.
- 3477054430 (rooftop kitty): the lit town meshes, the moon, the star field and the kitty's head and body are drawn,
  the head lit by its spot lights. The preview frame shows a different camera angle (a scripted turn and the shake).
- 3509243656 (space HUD): its texts fade in from 3.5 s (an alpha script), so a 3 s frame is nearly black. At 10 s
  the clock, the date, the log texts, the skybox's Milky Way and an unlit planet sphere are drawn. The sphere is black:
  the scene has no lights and its material's PBR mask combos aren't set.

Player tests (DEBUG, pin `157c111`): 737 passed, 0 failed, 3 ignored.

Left (in TODO):
- Shadows (`_rt_shadowAtlas`, PerformShadowMapping), light cookies, volumetrics, tube and directional lights.
- Shape objects (G27, the volume-light quad of 3319542538).
- Skinned and morphed MDL models; the PBR-mask component combos (METALLIC_MAP … EMISSIVE_MAP) from a mask texture;
  REFLECTION.
- Fog on image and particle shaders (genericimage4 and genericparticle have FOG_DIST paths).
- The 3D camera's parallax, zoom and camera paths. `perspectiveoverridefov` (G20) for 2D scenes. The image
  `perspective` flag (G21, E43). `depthtest` on layers (E43). `camerafade` (G23). `sortorder` / `customsortorder`.
- Hit-testing world-placed layers (cursor events in 3D). WE's transparent sort key. The output-sized render target.
- WE captures of the three scenes.

### 3414858021 result (fork patches 0057–0060, pin `b6e2878`, 2026-11-04)

The owner reported the scene with the girl's head missing and the cursor trail going up when the pointer went down.
Both were there before the day's batches (a smoke on the B4-era core shows the head off the bottom and the same trail
direction); B12's attachments only changed how the head went missing. Four causes, none of them a batch regression:

- **SceneScript angles are degrees (Observed in scene scripts; the binding not located in the decompile).** The scene
  file and LWE's renderer keep radians; scripts read and write degrees: 2679248947 writes
  `value.z = newAngle * WEMath.rad2deg`, 2134765860 spins by `(t · 2) % 1 · 360`, 3477054430 labels a slider
  "Max Rotation (degrees)", 3219908811 swings by ±30. 3414858021's `angles` scripts sway the body by
  `cursorWorldPosition.x · −0.0005`, the head by −0.0015 and the arm by −0.001: about a degree at the screen's
  centre. Read as radians the body turned 55°, so the neck attachment (and the head on it) and the arm left the
  screen; the grey arch in the owner's screenshot is the turned body. Fix (0057): property scripts' value in and out
  and `thisLayer.angles` / `layer.angles` get and set scale by 180/π (`ScriptEngine::scriptScaleOf`). The
  float constants 57.29578 / 0.017453292 are in `.rdata` at 0x1404928d0 / 0x140492628, referenced from
  FUN_1401fdf90 and 20 other places; which of them is the binding was not read.
- **The pointer trail (0058).** A control point linked to the pointer (flags bit 0) took the host's pointer (y down)
  as y up in a space that is centred and y down like the system's origin, so it was mirrored about the middle row.
  The conversion is upstream's (#400); B11's 0053 only added the inverse transform after it.
- **The compose layer didn't build (0059).** The head, eyes, fringe and hair are children of a compose layer (id 672,
  `deformer_simulation` + `iris_movement__`); four HLSL-isms in their shaders failed glslang, the layer was dropped,
  and with it everything under it: a backslash line continuation (depthparallax.frag), a fragment unit writing to a
  varying (`v_Depth +=`), a vec4 × vec2 truncated to vec2 (iris_movement__.vert) and a stray `#endif`
  (iris_movement__.vert). Each now compiles the way WE's path accepts it (GLSLContext: splice, truncation retry,
  unmatched #endif dropped; ShaderUnit: written varyings read into a global copy).
- **A failed parent orphaned its children (0060).** `resolveTransform` stopped at the first parent that wasn't a
  built render object, so the failed compose layer's children were placed from the scene's origin. It continues
  through the scene data now. The hard-edged bright band across the lower screen (y ≈ 800–935 of 1080) went away
  with the compose layer building.

Not ours / left: the date text "WEDNESDAY" still reaches the right edge (its group's x is a script on user property
`x8` = 0.967 of the canvas; not checked against WE). The `auto_sway` hair/cloth effect (3235948233) still fails: its
helper functions use `M_PI` from `common.h` above the point LWE pastes includes (before main, after the last
varying). Moving the include's `#define`s to the `#include` line builds it, but then the left white cloth (左白巾)
vanished, so that change is not in; it needs the effect itself read (TODO). **Done:** see "Shader preprocessing
result" below — the vanish was 0059's writable-varying copy filled only in the first of the unit's three `main`s.

Tests (host_api_test, all RED on 157c111): `particle_pointer_is_y_down`, `script_angles_are_degrees`,
`shaders_compile_like_hlsl`. The smoke has `--pointer X0,Y0:X1,Y1` (a scripted pointer path) for direction checks.

### Shader preprocessing result (fork patches 0063–0064, 2026-11-04)

The scene health report (fork patch 0061) found 21 of 96 scenes degraded, most by shaders LWE's glslang path refused
but WE builds. Instead of more one-off retries, WE's own shader path was read (in the sound spike's `all.c`; the
addresses are its functions) and ported (`Render/Shaders/WEShaderRules.{h,cpp}`, `ShaderUnit`, `GLSLContext`).

**WE's path (Observed in the decompile).**
- **Includes (GH 0x140191050, GH 0x1401917f0).** A unit is read line by line; a line that *starts* with the eight
  bytes `#include` (no indent — a `// #include` is a comment) is blanked and the quoted name recorded with the output
  offset it was at. Each include (`shaders/<name>`, expanded the same way, recursively) is pasted at that offset: in
  place. A missing file is skipped. LWE pasted every include before `main`, after the unit's last declaration, and
  matched `#include` anywhere on a line.
- **The translator (GH 0x140125e80).** Lines starting `attribute` / `varying` / `in` / `out` / `uniform` are taken
  out of the text: uniforms become cbuffer members and `Texture2D` + `SamplerState` pairs (the 15-entry type table
  `float…uvec4` → `float…uint4`, `sampler2D` → `sampler`, `sampler2DComparison` → `samplerComparison`), attributes the
  `VS_INPUT` struct (the 26-name attribute table `a_Position…a_Color` → POSITION/NORMAL/TANGENT/BLENDINDICES/…/COLOR),
  varyings `VS_OUTPUT`; every use is rewritten `IN.x` / `OUT.x` (a token pass over the text; `gl_FragColor` →
  `OUT.gl_FragColor`, `gl_Position` added to the outputs). The fragment unit's input struct **is the vertex unit's
  output list** (`param_6`: its own varying lines are dropped). A global line starting `const` gets `static `. The
  header it prepends: `#define vec2 float2 … mix lerp, mod(x,y) …, CASTI/CASTU/CASTF/CAST2/3/4/CAST4U/CAST3X3,
  DECLARE_SAMPLER2D_PARAMETER / MAKE_SAMPLER2D_ARGUMENT (+ _COMPARE_), texSample2D / Lod / Compare, texLoad2D,
  texSample3D, MapTexCoordToFrameBuffer, MapNDCToFrameBuffer (y flipped), MapEffectSpaceToFrameBuffer`, and one of two
  `texSample2DBackBuffer`s; plus `#define HLSL 1\n#define HLSL_SM40 1` (GH 0x140106780).
- **The compile (GH 0x140106780).** `D3DCompile (src, len, name, NULL defines, NULL include handler, "main",
  vs_5_0 / gs_5_0 / ps_5_0, 0x8800 = optimization level 3 | strictness, 0)`; a unit that fails is replaced by
  `shaders/HLSL/dx11fallback.{vert,frag}` — solid `(0.5, 0, 0, 1)` red. So a shader a published scene uses compiles in
  FXC with that scene's combos; its HLSL semantics are what authors relied on.
- **Combos (GH 0x14019b330)** become `#define NAME value` for every entry of the pass's combo map, zeros included.
  **WE's preprocessor (GH 0x140199cf0, its `#if` reader GH 0x140196ce0)** handles `define / undef / if / ifdef /
  ifndef / elif / else / endif / require` with the regex `^\s*#\s*([a-z]+)\b\s*(.*)`; an `#endif` with no open `#if`
  is passed over.

**Ported** (each rewrite is a `compat` record in the health report):
| rule | WE / HLSL | was in LWE | e.g. |
|---|---|---|---|
| include in place, line-start only | GH 0x140191050 / 0x1401917f0 | before main; anywhere on a line | 3235948233 auto_sway (`M_PI` above main) |
| declarations hoisted above the includes (inside copies of their `#if` chain; kept in place when the chain or an array size reads a name the unit `#define`s below the hoist point) | GH 0x140125e80 (cbuffers / structs ahead of code) | implied by the before-main placement | common_blur.h samples `g_Texture0` declared below it |
| fragment varyings take the vertex's types | GH 0x140125e80 (`VS_OUTPUT` is the PS input) | own types; glslang linked vec2-in to vec4-out, SPIRV-Cross wrote `vec2 = vec4`, NVIDIA C7011 | 2846673187 audio ring, 2844906964 / 2342779250 test_shader |
| fragment varyings and vertex attributes writable, the copy filled in **every** `main` | IN struct members are locals | first `main` only (0059) | 3235948233 auto_sway has one `main` per `AA_VERSION` |
| WE's header macros + HLSL type names (`half*`, `uint2…`, `float2x2…`) | GH 0x140125e80 header | CAST2/3/4 only | stock fur4 (`CASTF`), chroma4 / foliage4 (`DECLARE_SAMPLER2D_PARAMETER`), volumetricsfront (`sampler2DBackBuffer`) |
| declared `gl_` built-ins dropped | system-value struct members (Inferred: SV_InstanceID / SV_ViewportArrayIndex) | redeclaration error | stock shadowcaster* |
| unmatched `#endif` dropped | GH 0x140199cf0 | 0059 (kept) | 2973943998 iris_movement__ |
| an `#if` a preprocessor can't read is false | GH 0x140196ce0 (Inferred: the guarded block has a missing `;`) | glslang error | 3042492564 aa_gaussian `#if g_Texture0Resolution.y <= 640` |
| `formatcombo` samplers get `TEX<n>FORMAT` (0 = RGBA8888 for any decoded texture) | Inferred (the engine defines it per bound texture) | only TEX0FORMAT | stock fur4 `TEX8FORMAT` |

HLSL's semantics, applied from glslang's error on the line it names (`GLSLContext.cpp`; HLSL's documented rules —
Inferred as WE's only in that FXC is its compiler):
| rule | e.g. |
|---|---|
| an assignment / initializer converts: truncates (`(x).xy`), promotes a scalar, changes base (`int(a < b)`), each assignment on the line | 2846673187 `vec2 fragPos = v_TexCoord`, 3021673417 Simple_Audio_Bars `barLeft *= isLeftChannel` |
| an operand truncates — the variable of the error's storage (in / uniform / temp), never a name being declared (0059 swizzled `vec4 clip` itself) | 2800594362 clipping_mask, 3414858021 iris_movement__ |
| a call's arguments convert to its (single) user definition's parameter types; int literals of a built-in call become floats | 3370055069 depthparallax `getDepthMapDataX (vec2, int)` |
| a local `const` takes any initializer; a global one is a static const set at the top of every main | 2795521260 color_grading, 2799421411 oscilloscope |
| a function with no return on the combo's path returns its type's zero | 2821337237 shadow_map (SHADOWMASK 0 "None"), 3082978660 Simple_Audio_Bars |
| a scalar is a condition (ternary, if, while) | 3573886911 frame_builder |
| GLSL-reserved names renamed `_wp_<name>` (input, output, filter, common, …; `texture` when the unit declares a variable of that name) | 3573886911 custom_user_texture, stock effects/blend |
| a user function named like a header macro (log10, saturate, frac, fmod, lerp, atan2, ddx, ddy) gets the macro #undef'd and real overloads for the other types | 2812601803 / 3360740962 tone_mapping (`float log10 (float)`) |
| `clip()` | stock volumetricsfront |

Also Inferred: a uniform with neither a default nor a material constant starts at 0 (was an exception: the stock
shadowcasterfoliage4); a vector default with too few components fills with 0 (the stock editorpaintbrush's vec4 `"0
0"`); an include already pasted in the unit isn't pasted again. **Why 左白巾 vanished** when only the defines were
moved (the earlier attempt): auto_sway's fragment unit writes `v_TexCoord` in `calNode (inout vec4 texCoord …)`, so 0059
copies it into a global filled at the start of `main` — but the unit has three `main`s, one per `AA_VERSION`, and the
fill went into the first (AA_VERSION 3, inactive). The active one read the copy as 0, so every pixel sampled the
texture's corner (alpha 0). Measured with the extracted scene: a magenta output showed the geometry in place,
`gl_FragColor = vec4 (v_TexCoord.xy, …)` read black.

**The shader sweep** (fork patch 0063 `wp_project_shader_check`, `liascape-scene-worker --shader-sweep`,
`src/player/tests/onmachine/shader_sweep.py`): every stock shader (`assets/shaders/**` and `assets/effects/*/shaders/**`,
124) and every custom shader in the library's pkgs and folders (272 after de-duplicating identical copies), each with
its defaults, every single combo at each declared value (texture-slot combos only as 1, with their texture), every
combination the library's materials / effects / scene overrides use, and 4 seeded random combinations: **4085
compiles** through the core's own preprocessing, glslang + SPIRV-Cross and the GL compile and link, nothing drawn.
**Before: 313 failed, in 35 shaders. After: 47 failed, in 7 shaders, 0 newly failing** — each explained:
- stock `shadowcaster`, `shadowcasterfoliage4`, `shadowcasterfur4` (41): the vertex unit writes `gl_ViewportIndex`
  (layered cube/cascade shadow maps), which GLSL allows from 4.10 and LWE compiles at 3.30. LWE has no shadow-casting
  pass, so no scene compiles them.
- stock `puppettexturechannels` (2): `BLENDROWCOUNT` is set by WE's puppet-warp tool, not by any material.
- 3235948233 `auto_sway` with `AA_VERSION 1` and DEBUG (2: a full-width `；` ends a line) and `AA_VERSION 3` +
  `AUTO_TIMEOFFSET 0` (1: `thisOffset` undeclared) — options the shader labels beta / "in verification"; FXC refuses
  the same text. No scene uses them.
- 3370055069 `depthparallax` with `MODE 1` + `OVERLAY_LOCATOR` (1, a random combination): `g_Texture2` is declared
  only for another MODE. No scene uses it.

Tests (host_api_test, all four red on `42f301d`): `shaders_include_in_place`, `fragment_varying_takes_vertex_type`,
`hlsl_conversions_compile`, `hlsl_names_and_leftovers_compile`; `shaders_compile_like_hlsl` (0059) still passes.

### F1 result: shadows, light cookies, tube and directional lights (fork patch 0071, pin `4b85ae7`, 2026-11-04)

No library scene uses any of it. 3477054430 is the only scene with lights: four spots, all `castshadow: false`,
no `usecookie`, and its `lightconfig` is `{"spot": 4}`. No scene has a tube or directional light. Of the 44 objects
with a `castshadow` key, all are false. So the visual check is a synthetic scene (a floor, four cubes, a spot with
castshadow + usecookie and the stock `cookie/flashlight1`, a point light with castshadow). Everything was decoded
from wallpaper64.exe 2.8.485 (`all.c` plus the unpacked exe for constants and asm). The owner's Linux install ships
2.8.42's assets and a packed exe, so 2.8.42's generator itself could not be read.

**Decoded (Observed):**

- **Light properties** (GH 0x140283df0's table):
  - `castshadow` sets bit 0 of the flags at +0x2c4, `usecookie` bit 1 (GH 0x1401c9430), `castvolumetrics` bit 2.
  - `controlpoint` is a vec3 at +0x2d8 (parser GH 0x1401d0bc0: "x y z"). It is a tube's far end, in the light's
    own space.
  - `lightsourcesize` +0x314, `penumbra` +0x318, `distance` and `cascadedistance0–2` (directional cascades).
  - The type byte at +0x2c0 indexes a table: `lpoint` 0, `lspot` 1, `ltube` 2, `ldirectional` 3.
  - A light with usecookie loads its `cookie` texture, by default `cookie/flashlight1` (GH 0x140282140).
- **Shadow quality.** The app setting `shadows` is parsed by GH 0x14013f3f0: disabled 0, low 1, medium 2 (the
  default), high 3, ultra 4. A light's tile size comes from GH 0x140282540 (asm): 256 px below high, 512 at high,
  1024 at ultra.
- **The atlas** (GH 0x1401bf270):
  - `_rt_shadowAtlas` is created at 2 x 2 and recreated larger when the tiles don't fit.
  - Tiles are skyline-packed. `ProjectionTransform` = (x / W, y / H, size / W, size / H).
  - The texel is (1 / W, 1 / H).
  - At most 16 projections.
- **Packing**, per point or spot light (GH 0x1401bf270):
  - `g_LCluster_Extra.y` holds the flags: 1 shadow, 2 cookie, 4 projected. A spot with a shadow or a cookie gets
    `4 | cookie·2 | shadow·1`. A point light with a shadow gets 1.
  - `.z` is the projection index. `.w` is the penumbra term (only 2.8.485's PCSS reads it).
  - For a shadowed point light, `g_LCluster_Direction.xy` holds the faces' projection scale.
  - `g_LCluster_Counts` = (point and spot lights, tubes, projections).
  - Tubes come after the point and spot lights:
    - origin = (the light's position, radius);
    - direction = (world · (controlpoint, 1), 0);
    - extra.x = 1.
  - Directional lights fill `g_LDirectional_Color` = (rgb · intensity, 0) and `g_LDirectional_Direction` = the zero
    vector minus the light's x axis. Their count is the `LIGHTS_DIRECTIONAL` combo; 2.8.485's `lightconfig` reads only
    `directional` (≤ 3) and `directionalshadow`.
- **The light's projection** (FUN_140282580):
  - Spot: a perspective with fov = 2 · outercone and aspect 1, looking down its x axis with its y axis up.
  - Point: six faces. Each face's fov is 94° at low and medium, 92° at high, 91.2° at ultra (DAT_1404d4488/84/80),
    which matches common_pbr_2.h's `viewportPointCompensation` of 0.47 / 0.48 / 0.49.
  - Near = 0.05, or the light source size if larger (point lights). Far = max (radius, near + 0.01).
  - `g_LCluster_PointProjection` = the projection's (m22, m32, m23, m33): D3D, row vectors.
- **The pass** (GH 0x1401c4f30): the atlas is bound and its depth cleared once. The casters are drawn in batches of
  up to six viewports, one instance per viewport: the casters read `g_ViewportViewProjectionMatrices[gl_InstanceID]`
  and write `gl_ViewportIndex`.
- **Casters.** The caster material is `materials/util/shadowcaster.json`, with its shader taken from a
  table keyed by the mesh material's shader (GH 0x140185230).
- **The generated lighting** (GH 0x140197e20): as below. It emits the shadow code only when
  `LIGHTS_SHADOW_MAPPING_QUALITY` is non-zero, and the cluster form only for clustered scenes.

**Ported:**

| Piece | LWE now | Was |
|---|---|---|
| Light keys | castshadow, usecookie, cookie, controlpoint, lightsourcesize; `ltube`, `ldirectional` | point and spot only, no flags |
| Model key | `castshadow` | ignored |
| `_rt_shadowAtlas` | a 24-bit depth texture with comparison (GL_LEQUAL, linear: hardware 2 x 2 PCF), 2 x 2 until a light casts a shadow, then one 256 px tile per projection, four per row, grown and never shrunk | a scene-sized RGBA8 target nothing drew (8 MB at 1080p in *every* scene) |
| `_alias_lightCookie` | a 1 x 1 placeholder; a model pass that samples it gets the scene's cookie (the last spot with usecookie, as WE keeps one) | an alias of the RGBA8 atlas |
| The shadow pass | before the scene's clear, each caster into each viewport | none |
| Receivers | `LIGHTS_SHADOW_MAPPING` 1 + `_QUALITY` 2 when a light casts a shadow, `LIGHTS_COOKIE` when there's a cookie, `LIGHTS_DIRECTIONAL` n | none |
| PerformLighting_V1 | the point/spot loop with the cookie and shadow lookups, the tube loop (`PointSegmentDelta`), the directional loop (`ComputePBRLightShadowInfinite`) | the point/spot loop only |
| `texSample2DCompare` | `vec4(texture(…))` (the header reads `.r`) | a float: `.r` failed |

**Ours (not decoded, or adapted):**

- **One draw per viewport.** WE's six-instance draw needs `gl_ViewportIndex` from the vertex unit: GLSL 4.10, or
  `GL_ARB_shader_viewport_layer_array`. The NVIDIA EGL context has it (GL 4.6, plus `GL_NV_viewport_array2` and
  `GL_AMD_vertex_shader_viewport_index`), but LWE compiles at 3.30. LWE instead draws each viewport separately: its
  rect bound with `glViewportIndexedf` (GL 4.1, else `glViewport`), its matrix in
  `g_ViewportViewProjectionMatrices[0]`, and the vertex unit's `gl_ViewportIndex` write dropped (a health `compat`
  record). This builds on any GL, including Mesa. The cost is six draws per point-light caster instead of one.
- **The render matrices** are built so that what the lit material's header computes lands on what was drawn:
  - `CalculateProjectedCoords` takes `g_LCluster_Projection` = a D3D right-handed perspective (depth 0 … 1) · the
    spot's lookAt;
  - the caster draws through the same matrix with y negated (the header's v grows down the texture, the tile's
    first row) and z remapped to GL's −1 … 1, so the depth buffer holds the D3D depth the header compares;
  - a point light's faces use the header's own view matrices, with x and y scaled by 2 · 0.47. WE renders them at
    94°, which is about equal.
- **The bias** is `glPolygonOffset (4, 16)`. WE's rasterizer state for the pass wasn't read. 1.5 / 8 left acne at
  grazing angles: the 9-tap filter reaches about two texels.
- **The caster table.** foliage4 → shadowcasterfoliage4 and fur4 → shadowcasterfur4 (from the names), anything else →
  shadowcaster. The mesh material's combos are copied (ALPHATOCOVERAGE and the like). Depth test and write are on,
  culling off.
- **Quality** is medium, WE's default (LWE has no setting).
- **The directional direction.** The "zero minus the axis" is read from the packer's FUN_140060830 being the zero
  vector, which is inferred.
- **Two header versions.** The generator follows the common_pbr_2.h the assets ship. With 2.8.42's (the owner's
  Linux install) it calls `PerformShadowMapping (coords, transform)`, `CalculateProjectedCoordsPoint (pos, origin,
  info, transform)` and `PerformPointShadowMapping (coords)`. With 2.8.485's (it has `vec2 projectionScale`) it uses
  the 2.8.485 generator's calls, passing zero for the PCSS receiver-plane terms. Both compile (`shadow_casters_compile`
  against 2.8.42, and a sweep job against the Windows install's 2.8.485 assets).

**Not done (Left):**

- WE's light clusters (LWE takes the first 16 point, spot and tube lights).
- The directional cascades (`g_LFeature_Shadow*`, `CalculateProjectedCoordsCascades`, `cascadedistance*`,
  `directionalshadow`).
- 2.8.485's PCSS (quality 4: penumbra, noise, receiver-plane).
- The `shadows` quality as a setting.
- `lightconfig`'s counts.
- Skinned or morphed casters: SKINNING / MORPHING, with F4.
- Volumetrics: `castvolumetrics`, F2.

**Fork tests** (`host_api_test`): 89/89 on the new commit. The 4 new tests fail on `deeb4da`.

| Test | What it checks | On `deeb4da` |
|---|---|---|
| `shadow_casters_compile` | the 3 stock casters (defaults; ALPHATOCOVERAGE) and generic4 with shadows + cookie, and with 2 directional lights | `'gl_ViewportIndex' : undeclared identifier` |
| `shadow_occludes_a_lit_point` | a spot, then a point light, over a floor with an invisible 1 x 1 occluder between them: the centre is dark, 1.6 units away it's lit exactly as without the caster (no acne); without the occluder's castshadow nothing changes | centre 255 |
| `cookie_projects_its_texture` | a red / green 2 x 1 cookie on a spot lights the floor's left red and its right green; without usecookie both are white | white both sides |
| `tube_and_directional_lights` | a tube light 1 unit over the quad lights it (dimmer 18 units away), a directional light lights it from its −x axis and not when turned away | 0 (an `Other` light) |

**The synthetic scene** (a floor, four cubes, a spot with castshadow + usecookie, a point light with castshadow;
smoke, old core vs new):

- Old core: the cubes are lit with no shadows, and the spot is a plain disc.
- New core: each cube casts a shadow from both lights (a warm one from the spot, a blue one from the point light),
  and the spot shows flashlight1's ring pattern.
- At a 1.5 / 8 bias there were acne stripes at grazing angles; at 4 / 16 there are none.
- Shadow edges are stair-stepped at 256 px per tile, as WE's medium quality.

**Cost** (6 s smokes, VRAM sampled at 4 s with nvidia-smi, two runs each, old → new):

| Scene | Frame (mean) | VRAM |
|---|---|---|
| the synthetic shadow scene (5 casters, 7 viewports) | 0.9–1.0 → 1.2 ms | 57 → 49 MiB |
| the same without lights | 0.7–1.0 → 0.5–0.9 ms | 57 → 47 MiB |
| 3477054430 (spot-lit, no shadows) | ~0.9 → ~0.9 ms | 149 → 139 MiB |
| 2182433068 (2D) | 0.5–0.7 → 0.65–0.74 ms | 92 → 82 MiB |
| 3042865984 (2D, 6880 x 2880) | 12.3 → 12.1 ms | 2141 → 2065 MiB |

- **A scene without shadow lights does no extra work.** The pass returns at once; `updateLights` runs only in 3D
  scenes, as before.
- **Every scene saves the old scene-sized RGBA8 atlas:** about 8 MB at 1080p, 79 MB at 6880 x 2880.
- **A shadow scene pays one draw per caster per viewport:** 35 draws here.

**Health** (`scene-health.md`, 96 scenes, this core): 86 clean / 10 degraded / 0 failed, the same as on `deeb4da`.

- No scene is worse, newly blank or failed.
- No scene's lit pixels moved by more than 3 %.
- 3593587273 exits 1, as before: a still image, by design.
- In the report 3042865984's frame reads 11.7 → 28.8 ms. The isolated runs above show that was load: its first old
  run took 41 ms.

**Shader sweep** (4085 compiles): 47 → 16 failures, 31 fixed, 0 newly failing.

- The 10 shadow-caster checks left are SKINNING with BONECOUNT 0 (`g_Bones[0]`), and MORPHING
  (`g_Texture1Texel`, and 2.8.42's `ApplyMorphPosition` overload in fur4). Both are skinned / morphed mesh
  combos, which LWE's static meshes never set (F4).
- The other 6 are as before.

Pin `4b85ae7`. Player tests (DEBUG): 740 passed, 0 failed, 3 ignored. In the full run, the timing test
`four_workers_latch_independently` failed once and passed alone.

### F3/F4 result: blend shapes, bone alpha, skinned and morphed models, createModelData (fork patches 0078–0081, pin `1072720`, 2026-11-04)

Decoded from wallpaper64.exe 2.8.485 with the sound spike's `all.c` (the MDL loader GH 0x1402873f0 and the puppet
combo builder GH 0x140230ec0 decompiled there), the stock shaders of the owner's 2.8.42 assets (genericimage4,
generic4, the casters, `base/model_vertex_v1.h`) and 2.8.485's `base/morph_vertex_v1.h` from the Windows install. No
REA session was needed. Library numbers come from the Python MDL port (B12's `b12/mdl.py`, extended in the scratchpad's
`f3/`), over every `.mdl` in the 16 Workshop scenes that have one.

**What the library has** (the 50 puppet files and the 3D models):

| Feature | Library | Notes |
|---|---|---|
| MDMP0001 blend shapes | 1 file: 3490034653's 人物1, one target "Shape 895" (25 eyelid points) | its "眨眼" (blink) animation weights it |
| MDLA v4 blend-shape weight tracks | 3490034653's 眨眼 | weight 1 at frames 0–10, about 0.5–0.6 at 199–218 (of 450) |
| MDLA v3 bone alpha tracks | 0 | |
| target alphas below 1 | 0 | 人物1's alpha blob is all 32767 (1.0) |
| MDLE0002 | 13 files | not blend shapes (B12 guessed so): a byte count and a copy of the bones' local matrices |
| IK (`"ik":true` in a bone's JSON) | 1 bone: 3042492564's 海果-手臂 (`ikd` 2, two IK targets) | not ported (below) |
| bone physics | 0 enabled | every bone JSON with physics keys has `se` / `re` / `ge` false, `s` 0 |
| root motion (MDLA flags bit 0) | 0 | |
| a 3D model with a skeleton or blend shapes | 0 | 3276522107, 3477054430, 3509243656's models are static |
| `autosort` / `index` on layers | 0 | no scene.json has either |
| applyBonePhysicsImpulse, createModelData, get/setBlendShape* | 0 scripts | |

**Decoded (Observed):**

- **MDMP0001** (the loader's 4th section branch): per mesh a u16 target count (≤ 0x100). With targets: an f32 position
  scale (mesh +0x60) and a u32 point count N (+0x64). Per target: a u64 id, a name, a blob of N · 6 bytes (WE takes
  min (N, blob / 6) and requires them equal). By the mesh's flags (+0x18): 0x400 another N · 6 (normal deltas),
  0x1000 N · 2 (alphas), 0x2000 a u32 bone (< the bone count), a u32, two f32s (MORPHING_MODIFIERS' rule).
- **The values are snorm16**: 2.8.485's `DecodeMorphSnorm16` is max (int16 / 32767, −1), × `g_MorphPositionScale`
  (= the mesh's scale; 2.8.42 passes it as `g_MorphWeights[0]`, `MORPH_POSITION_SCALE (weights)`).
- **A puppet vertex's point** is its vec4 position's w (format 0x10000): genericimage4 indexes the morph map with
  `CASTU (a_PositionVec4.w) + g_MorphOffsets[1 + t]` and skips w 0. 人物1's 4787 vertices: w 1..25 on 25, 0 on the rest.
  A 3D mesh (generic4, the casters) indexes it with `gl_VertexID` (a dense target).
- **MDLA v4 weights**: per mesh u32 flags; with bit 0, an f32 (the scale again), a u16 count, per track a u16 target
  index and frames + 1 floats. MDLA v3's alpha tracks: a flag byte, then per bone a u32 and frames + 1 floats. MDLA v6's
  last per-bone float track is present in 人物1 (53 bones 0, 2 bones 1): not decoded.
- **The combos** (GH 0x140230ec0, the puppet image's material): BONECOUNT = the bone count (vtable +0xd8), SKINNING 1,
  SKINNING_ALPHA when the model's flags +0x18 bit 2, MORPHING when the mesh format has 0x10000 (with texture slot 5
  set to the model's morph texture), MORPHING_MODIFIERS when MORPHING and flags bit 0x2000.
- **The shaders**: morph first, then skin; v_VertexAlpha = Π (morphAlpha · w + 1 − w) × saturate (Σ weight ·
  g_BonesAlpha[bone]); `color.a *= v_VertexAlpha`. generic4 / model_vertex_v1.h read their map as a float stream, 3
  floats a (vertex, target) entry (6 with MORPHING_NORMALS), at (vertex + offset) · 3, packed into RGBA texels, y =
  index / height (a square texture).
- **g_Texture0Texel … g_Texture9Texel** are engine uniforms (WE's name table GH 0x140002a20, ids 0x49–0x52), like
  the Resolution ones.

**Ported** (fork patches, in order):

| Patch | What |
|---|---|
| 0078 shader | The casters' SKINNING / MORPHING compile: BONECOUNT ≥ 1 under SKINNING; an undeclared g_Texture<n>Texel is declared (CPass feeds (1 / w, 1 / h, w, h)); the call-argument rule reads parameter lists with macro calls (`DECLARE_SAMPLER2D_PARAMETER`) and leaves array parameters alone (fur4's `ApplyMorphPosition (gl_VertexID, …)`) |
| 0079 render | Puppet blend shapes, their weight tracks and bone alpha (CPU, before the skin, as genericimage4 orders them); `getBlendShapeIndex` / `getBlendShapeWeight` / `setBlendShapeWeight` |
| 0080 render | 3D models with a skeleton: `animationlayers` on the model object, posed like a puppet, skinned on the GPU (SKINNING, g_Bones as mat4x3, a_BlendIndices / a_BlendWeights); blend shapes through MORPHING over a morph map in g_Texture5 (the casters' g_Texture1) |
| 0081 script | `createModelData`, `IModelData` (applyData, replaceData, POSITION … COLOR), `createLayer ({ model })`, `destroyModelData`; model layers are scriptable and draw in 2D scenes |

**Ours / Inferred:**

- **Puppets stay on the CPU** (B12's path): morph, then skin, per vertex. The vertex alpha reaches genericimage4's
  fragment through its VERTEXCOLOR (`a_Color` = 1 1 1 alpha; `color *= v_Color` comes right after WE's `color.a *=
  v_VertexAlpha`). Only a puppet with an alpha track or a target alpha below 1 gets the combo: no library puppet does.
  genericimage2 (15 of the library's 77 puppet layers) has neither path, in WE too.
- **How layers mix weights and alphas** (Inferred; the mixer GH 0x140228470 wasn't read that far): as positions,
  normal lerps toward the sample (weights from 0, alphas from 1), additive adds (sample − rest) · weight.
- **A script's weight** (`setBlendShapeWeight`) holds over the animations' until set again (Inferred), as the bone
  overrides do.
- **Which targets draw** when more than 11 are weighted (the uniforms hold 11): the first 11 weighted ≠ 0 (ours).
- **The model morph map** is half float (RGBA16F) holding the snorm values; WE 2.8.485 reads a snorm16 buffer.
- **createModelData in a 2D scene**: WE's world pixels (y up) through the layers' projection, z squashed into its
  depth range; the 2D target has no depth buffer, so faces draw in index order. COLOR is read past; the bounding box
  members are ignored.
- **A model layer is a ScriptableObject** now, so getLayer / createLayer return it (it was undefined).

**Not done (Left):**

- IK and bone physics. The bone JSON's keys are known (`ik`, `ikd` chain depth, `ikrd`, `ikrmin/max`, `ikce`, `ikg`,
  `ikr`; `r`/`t` rotation / translation simulation with `rs`/`ts` stiffness, `rf`/`tf` friction, `ri`/`ti`, `m` mass,
  `gd` gravity direction, `ge`/`re`/`se` enables, `la`/`lamin`/`lamax`/`lt`/`ltmax` limits; parser GH 0x14028bbd0),
  and MDLS v2's IK target records, but the solver and the simulation live in the 4500-line mixer GH 0x140228470,
  which wasn't read. One library bone uses IK (3042492564's arm), none physics. applyBonePhysicsImpulse /
  resetBonePhysicsSimulation stay no-ops; gravity / wind (`general.gravity*`, `wind*`) aren't read by anything.
- MORPHING_MODIFIERS (the 0x2000 bone rule: parsed, not applied), MORPHING_NORMALS' normal deltas on puppets.
- Root motion (MDLA flags bit 0: 18 bytes, a 0xc0-byte runtime record; not decoded), `IModelLayer.rootmotion`.
- The IModelLayer script API on models (getAnimationLayer … go through the puppet layer API, which a model lacks).
- MDLA v6's per-bone float track, MDLE's role (a copy of the local matrices: perhaps physics' rest pose).
- `autosort` / `index` layer order (no library user; not found in the exe's strings either).

**Fork tests** (`host_api_test`): 99/99 on `1072720`, 4 new, each failing on 24adeff.

| Test | What it checks | On 24adeff |
|---|---|---|
| `skinned_casters_compile` | shadowcaster, shadowcasterfoliage4, shadowcasterfur4 with SKINNING, MORPHING, MORPHING + MORPHING_NORMALS (BONECOUNT 1) and SKINNING + MORPHING (BONECOUNT 4): 12 builds | 10 of 12 fail (array size 0, `g_Texture1Texel` undeclared, no `ApplyMorphPosition` overload) |
| `puppet_blend_shapes_and_alpha` | four genericimage4 puppets (vec4 positions, MDMP with "stretch" +6 px and "fade" alpha 0): an animation's stretch weight widens A to x 4..13; B's script sets stretch by name and reads the weights back (x 24..33); C's bone alpha 0 and D's fade weight 1 hide them | A and B 4 px wide, C and D drawn, the script checks fail |
| `model_skins_and_morphs` | a 3D model's skeleton moved +2 units by its animation layer (x 0..4, ±4 px), and with the stretch weight 1 its right edge at 10 units | nothing drawn where expected (the static quad) |
| `create_model_data_draws` | createModelData (POSITION, NORMAL, UV; a Uint16Array) + createLayer ({ model, origin 48 24 }) is the 8 px square at x 44..51, rows 4..11; applyData moves it 30 px left | nothing drawn |

**Library scenes, old core (24adeff) vs new** (6 s smokes, `WPENGINE_PARTICLE_SEED=7`, the same release worker with
each core on its LD_LIBRARY_PATH; scratchpad `f3/pairs/`):

| Scene | Kind | ok | lit px old → new | frame ms old → new | pixels changed (1 s, 6 s) |
|---|---|---|---|---|---|
| 3490034653 | puppet, MDMP blink | True / True | 4953522 → 4953522 | 4.3 → 4.7 | 0, 0 |
| 3463520581 | puppet (MDLE) | True / True | 8294390 → 8294390 | 4.3 → 2.9 | 0, 0 |
| 3233141951 | puppet, 6 files | True / True | 9404239 → 9404239 | 67.7 → 66.5 | 0, 0 |
| 3414858021 | puppet (MDLE) | True / True | 8292354 → 8292354 | 9.7 → 10.3 | 0, 0.018 % (a 138 × 39 px box at the right edge) |
| 3363252053 | puppet (MDLE) | True / True | 8294387 → 8294387 | 7.4 → 5.6 | 0, 0 |
| 3013489778 | puppet (MDLE) | True / True | 2073566 → 2073566 | 4.6 → 3.6 | 0, 0 |
| 3479521040 | puppet (MDLE) | True / True | 8293845 → 8293845 | 5.1 → 5.2 | 0, 0 |
| 3042492564 | puppet with the IK bone | True / True | 8294136 → 8294136 | 8.4 → 8.0 | 0, 0 |
| 2375914945 | puppet, MDLV0013 | True / True | 8294305 → 8294305 | 3.5 → 3.7 | 0, 0 |
| 3276522107 | 3D (static models) | True / True | 357607 → 357607 | 8.4 → 8.4 | 0, 0 |
| 3477054430 | 3D (static models, spots) | True / True | 905142 → 905142 | 1.2 → 1.3 | 0, 0 |
| 3509243656 | 3D (static models) | True / True | 2057791 → 2057806 | 7.5 → 8.2 | 0, 0.012 % (a box over the planet: its texts fade in) |

- **No library scene changes visibly.** The only blend shape (3490034653's blink) moves its 25 eyelid points by at
  most 4.5 layer px, weighted 1 at frames 0–10 and 0.5–0.6 at 199–218 of 450; captured at 0.3 s, 1 s, 6 s and 6.9 s the
  frames are identical to the old core's (the deltas are applied: the per-vertex log showed them; on screen they are
  under a pixel or covered). The two 6 s differences are animated content, the same size on reruns of one core in
  earlier batches.
- **Cost: none measurable.** A puppet without blend shapes or alpha tracks runs B12's path; one with them adds a
  per-vertex morph (25 points here). Static models are unchanged (no SKINNING / MORPHING combos). 3233141951 ran at
  67 ms on both cores in this run (machine load; B12 measured 6–7 ms).

**Shader sweep** (4085 compiles, the new core): 16 → 6 failures, the 10 SKINNING / MORPHING caster checks fixed, 0 newly
failing; the 6 left are as in F1 (`puppettexturechannels`' BLENDROWCOUNT, two workshop `auto_sway`, one `depthparallax`).
"WE: an engine texel uniform declared" applies to 3 checks.

**Health** (`scene-health.md`, 96 scenes, pin `1072720`): 86 clean / 10 degraded / 0 failed, as on 24adeff; no
scene's class, loss, errors, warnings or built objects changed. In the full run 2883756643 (a video scene) timed out
at the 90 s limit under load; alone it is clean in 15 s, and the report carries that rerun (the timed-out run is kept
in the scratchpad's `f3/health-2883-timeout`).

Player tests (DEBUG, pin `1072720`): 740 run, 729 passed, 3 ignored, 11 failed in the full run under a load of 10–26
(another agent's build): `align_end_hands_off_as_a_last_frame_ends`, `i5_open_burst_is_capped_and_none_lost`,
`i6_every_onset_waits_for_flowing_audio`, `outbox_is_bounded`, `outbox_persists_across_restart_and_acks`,
`render_worker_never_composes_a_torn_frame`, `render_worker_quit_is_bounded`, `scene_over_vram_limit_is_stopped_not_crashed`,
`scene_path_changes_and_folder_spellings_share_one_measurement`, `scene_reopen_continues_the_end_of_play_measurement`,
`scene_worker_exit_never_skips_bus_cycles` (timeouts and timing). Each passed alone.

### F5/F6 result: perspective layers, camera paths, the transparent sort, the stock particle operators (fork patches 0082–0085, 2026-11-04)

Decoded from wallpaper64.exe 2.8.485 (`all.c`, the asm `all.asm`, the B11 decompile of the operator interpreter
`op265800.c`; the particle parser GH 0x1401f3120 doesn't decompile — "response buffer exceeded" in REA too — so its
stores were read from the asm with a script, `pk.py`/`pall.py` in the session scratchpad `persp/`). **Observed**
unless marked inferred.

**F5 — decoded:**

- **`perspectiveoverridefov`** (scene +0x144, default 95, GH 0x1401b6c60). The camera update GH 0x1401b8af0 takes
  +0x144 as the effective fov (+0x148) when the scene is orthographic (+0x140, general.fov, otherwise); a camera
  object's fov applies only in 3D. In an orthographic scene the effective fov reaches only the perspective camera
  below (the orthographic projection GH 0x1401b3f70 doesn't read it).
- **The orthographic scene's perspective camera** (GH 0x1401b4fd0). From the current orthographic view and
  projection: view.z = −1 / (tan (fov / 2) · proj[1][1]) — the eye at d = (h / 2) / tan (fov / 2), so z 0 maps as the
  orthographic camera maps it —, view.xy −= scene size · the visible area's crop fraction (renderer +0x108/+0x10c: the
  axis on the visible area's centre), then the renderer's perspective (vtable +0x10) with fov, aspect w / h, near 5
  (DAT_1404d43e0), far max (15000, d + 1000). The y flip of the render target (renderer flag 0x800) is applied after.
- **Who draws through it.** The image draw GH 0x140214b50 swaps it onto the matrix stacks when the layer's object
  flag 0x80 (+0x120, `perspective`, its setter FUN_1401ca270; registered in two object tables, GH 0x140219c60 and GH
  0x14024da50) is set; the particle render GH 0x14025bc30 when the system's flags have bit 2. Hit-testing
  (GH 0x140219260) unprojects through it for such a layer (renderer flag 0x400 = orthographic).
- **Camera paths.** The loader reads `camera.paths` — a list of file names; each string entry is parsed into the same
  list (cleared first), so the last wins — with GH 0x1401c6ef0: `{"paths": [{"duration", "disabled", "transforms":
  [{"eye", "center", "up", "zoom" (default 1), "timestamp" (else i / (n − 1) · duration), "disabled"}]}]}`; a path
  without transforms ends the list. Records: path 0x20 bytes (keys, duration +0x18), key 0x2c (time, eye, centre, up,
  zoom). GH 0x1401b8af0 plays them only while no camera object is active (the last effectively visible one wins
  first): state path +0xe4, key +0xe8, time +0xec; before a key's time the key holds; between keys a cubic Hermite
  (h00 = 2s³ − 3s² + 1 …) with both tangents (b − a) · 0.5; the boundaries and the wrap as in the asm (ported
  literally, including the hold boundaries' odd sums). The eye/centre/up feed the view; the key's zoom replaces
  general.zoom (+0x114 ← key zoom, else +0x13c).
- **camerafade** (general flag 4, FUN_1401c9d10). GH 0x1401b1ef0 loads `materials/util/fade.json` when it is set
  and paths exist; GH 0x1401afbf0 draws it when alpha > 0: rem = duration − t; alpha = 1 − 2 · rem over the last
  0.5 s, 1 − 2 · t over the first. fade.frag is `vec4 (color · 0.7, g_Alpha)`, `color` the material's tint (default
  0.315 0.135 0.1125) bound to the user property `schemecolor` (usershadervalues).
- **The transparent sort** (GH 0x1401b6660, called by the scene render GH 0x1401b9b50 when (flags & 0x1008) ==
  0x1000, i.e. transparentsorting in a 3D scene). Per object: key = dot (origin, the renderer's view vector +0x160),
  −∞ for an object with flag 0x400; then a stable merge/insertion sort (GH 0x1401cc640 / 0x1401cc550) by `sortorder`
  (base object int +0x124, table GH 0x14020dcc0) ascending, then key descending.
- **Not read:** where `customsortorder` (general flag 0x2000) is consumed — no test of it on the scene struct in
  `all.asm`; the 3D zoom — GH 0x1401b3f70's perspective branch doesn't read +0x114, its other reader wasn't found;
  WE's 3D parallax block (GH 0x1401b8af0 bit 0x100 — 0 3D library scenes use parallax).

**F5 — ported** (0082, 0083):

| Item | LWE now | Was |
|---|---|---|
| `perspectiveoverridefov` | parsed (user-bindable), Camera::getPerspective2DViewProjection | ignored |
| image / text `perspective` | a perspective layer of a 2D scene: its own x/y angles and z about its pivot, drawn through that camera with the frame's zoom/shake adjustment; an IEffectLayer property | ignored: flat |
| perspective particles (flags 4) in 2D | that camera, eye (0, 0, d) | general.fov from an eye at z 1000 (z 0 drawn 1.16 x at fov 50) |
| `camera.paths` + camerafade | parsed, played while no camera object is active (3D: eye/centre/up; 2D: zoom and the eye's offset); the fade overlay | ignored |
| `sortorder` | the transparent sort's first key; then dot (origin − eye, forward) descending | the distance from the eye |

Inferred / ours: the parents' x/y angles of a perspective layer (the 2D transform resolves z turns only);
full-screen and compose layers stay flat (no library scene turns one); the fade colour's binding; LWE keeps its
world-placed runs for the sort (WE sorts its transparent list after drawing the opaque objects, flag 0x202 — not
ported).

**F5 — what it changes in the library.** No scene has camera paths (all 11 camera objects' `path` files are
`{"paths": []}`, and no scene has `camera.paths`), so camerafade (true in 92 scenes) never draws, as in WE. The
transparent sort's key applies to 3477054430 and 3509243656 (`transparentsorting` true). Four 2D scenes have
`perspective` image layers (2469881470 milk1, 3354740764 three `Shadow` layers and a compose layer, 3422085307, 3479521040
人物, a puppet); all at z 0 with no x/y turn, so they draw where they did. **35 2D scenes have perspective particle
systems**: their particles at z 0 are now the size WE draws them (LWE drew them 1.16 x at fov 50, or as general.fov
gave), and particles off z 0 grow or shrink with depth. In the 96-scene smoke (3 s, `WPENGINE_PARTICLE_SEED=7`, the
pinned core's parent 24adeff vs this one) no scene is newly blank or failed and no scene's lit share moved by more
than 0.4 %. The largest pixel differences are videos, clocks and rain (3028473503 22 %, 3046119914 21 %, 3243449890
6 %: its clock moved 22:22 → 22:30 between the runs); the three 3D scenes match (3477054430 and 3509243656 0.00 %,
3276522107 2.6 %: its passing buildings).

**F6 — decoded** (opcodes from B11's jump table; record keys from the parser's stores; defaults from the default
functions, which take a second, pixel-unit value when the parser's flag [rbp+0x2238] is set — inferred: a 2D system):

| Type | WE | Ported |
|---|---|---|
| capvelocity (0x12) | v ×= min (1, maxspeed / |v|); maxspeed (1 / 100) bound to the speed override | as WE |
| maintaindistancetocontrolpoint (0xb) | p += cp − cp_last; p = cp + (p − cp)(1 + k (distance / |M (p − cp)| − 1)), k = 1 or clamp (variablestrength · dt, 0, 1) (GH 0x140206c00); distance 1 / 200 | as WE, M (a control point matrix, GH 0x14024e870) taken as identity (inferred) |
| maintaindistancebetweencontrolpoints (0xc) | the last step's segment S₀E₀ → this step's: p += (S − S₀) + clamp (t) (E − S) − t (E₀ − S₀), t = dot (p − S₀, E₀ − S₀) / |E₀ − S₀|²; nothing below 1.42e-14 | as WE |
| reducemovementnearcontrolpoint (0xd) | v ×= 1 − clamp ((rin + clamp ((d − din) / (dout − din)) (rout − rin)) · dt); 0.5/1 or 100/350, 100/0 | as WE |
| collisionbox (0x17) | its jump-table entry 0x140265eb9 is the next-operator label: nothing runs | a no-op |
| boids (0x11) | every s-th particle per step from the system's frame counter (s = n / 200 + 1), factors × s; separation 0.02/20, neighbor 0.2/50, maxspeed 1/500, factors 0 / 1 / 2 | the stagger as WE; the forces Reynolds' rules (inferred: 1.5 KB of SIMD not read through) |
| remapvalue (0x13), remapinitialvalue | operation remap/multiply/add/subtract; 20 values (lifetimefraction … layerorigin); components all/x/y/z/sum/average/max/min; functions none/sine/square/saw/triangle/simplexnoise/fbmnoise (GH 0x140286d90…0x140286f60); defaults output size, ranges 0..1, cps 0/1, inputscale 2, octaves 3 | WE's enums and defaults; the function shapes and the clamp inferred (case 0x13 is 21 KB) |
| collisionplane / sphere / bounds / quad (0x15/16/18/19) | collisionbehavior bounce / slide / delete, bouncefactor kept as −1 − b (GH 0x1401edab0); plane "0 1 0" distance −150; sphere "0 −200 0" r 50; quad "0 −150 0", size 200 200 | bounce v −= (1 + b)(v·n)n; the geometry from the keys (inferred: the default bounce 0.5, bounds = the scene rectangle, the sphere keeps particles out) |
| collisionmodel (0x1a) | a model's triangles | parsed, reported unsupported |
| inheritvaluefromevent (0x14), inheritinitialvaluefromevent | the event particle's value by GH 0x140287030's 15 names (setcolor … all) | from the event particle (now kept by an event child; a follow child's every step); set/multiply/add from the names (inferred) |
| hsvcolorrandom | hue 0..1, saturation / value 0.5..1, huesteps | uniform draws (inferred) |
| colorlist | colors, hue/saturation/valuenoise | one at random, jittered (inferred) |
| positionoffsetrandom | scale 1 / 0.001, distance 0.1 / 100, timescale 1, directions "1 1 1" / "1 1 0", sign, octaves | a simplex offset (random at scale 0) (inferred) |
| inheritcontrolpointvelocity | controlpoint, min 0.1, max 0.2 | the control point's velocity this step × U (min, max) (inferred) |
| mapsequencebetweencontrolpoints | count 32, cps 0/1, arcamount 0.3, sizereductionamount 0.9, bounds, limitbehavior, mirror | evenly along the segment in turn (inferred; no arc, no size reduction) |
| emitter layerimage | — | not done (it needs the layer's pixels on the CPU) |

**F6 — what it changes in the library:** nothing: no library scene uses these types (the 20 were stock-only). The
check is synthetic (host tests) plus WE's own element previews (`assets/scenes/particleelementpreviews/*`).
WE's element previews, old core vs new (3 s smokes): boids flock
into clumps; capvelocity's particles slow once half their life is gone (its blendinstart 0.5 … blendinend 0.6);
collisionbounds piles them on the floor; collisionplane stacks them on the plane; collisionsphere slides them round
the sphere (before: through it); colorlist and hsvcolorrandom colour them (before: white); the inherit pair's
children take their parents' colours; maintaindistancetocontrolpoint holds a ring; maintaindistancebetween and
mapsequencebetween lay a line between the control points; positionoffsetrandom scatters the bolt; remapvalue /
remapinitialvalue colour by the distance to control point 1 (red near, blue far — the first port drew them black,
its output range being "x y z": fixed in 0085). collisionmodel and layerimage exit 1 on both cores (their scenes
need a model / an image layer emitter LWE doesn't run).

**Fork tests** (`host_api_test`, each RED on `24adeff`):

| Test | What it checks |
|---|---|
| `perspective_layers_in_2d` | at fov 90 on 64 x 32 (d 16): a perspective layer at z 0 is where a flat one is (also at the default 95); at z 8 twice the size, a flat one unchanged; 60° about y about half as wide (a flat one ignores it); zoom 2 doubles it again; a perspective particle at z 0 is the flat size, at z 8 twice |
| `camera_paths_and_fade` | a path's zoom 2 doubles a square; a camera object takes precedence; the eye from 0 to 16 over 2 s is at 8 after 1 s (the Hermite midpoint); camerafade darkens the start (blue 34 vs 127 mid-path) |
| `transparent_sort_takes_sortorder` | two world layers: back to front by depth; the far one with sortorder 1 draws last |
| `particle_stock_motion_operators` | capvelocity 10, the reduction near a control point, boids' cohesion, maintaindistancetocontrolpoint 4, remapvalue → opacity 0.5 |
| `particle_stock_collisions` | a plane stops a falling particle, a sphere deletes, a particle beside a quad falls past, the bounds keep a fast one on screen |
| `particle_stock_initializers` | hsv green, colorlist blue, a position offset spread, remapinitialvalue size × 2, a sequence 12 / 32 / 52 between control points that maintaindistancebetween carries as the end moves, inheritcontrolpointvelocity from the moving pointer, an event child taking its particle's colour |

**Shader sweep** (4085 checks, against the merged F1 + F7–F9 core's results): 16 failing before and after, 0 newly
failing.

**Health** (`scene-health.md`, 96 scenes, pin `78128d1`): 86 clean / 10 degraded / 0 failed; every scene's class,
loss, errors, warnings and built objects the same as on F3/F4's `1072720`. In the full run 2883756643 timed out once
(exit 124); alone it took 15 s and is clean, as before (the report carries the rerun).

**Patch 0085** (after the preview smokes): remap output ranges as vectors, and the operators' blendinstart /
blendinend as a clamped life ramp (inferred).

Pin `78128d1` (which also carries the rig agent's F3/F4 0078–0081). host_api_test 101/101 on it (105/105 with the
rig agent's tests merged in). Player tests (DEBUG): 738 passed, 2 failed, 3 ignored; the 2
(`no_trim_once_shutdown_started`, `align_end_hands_off_as_a_last_frame_ends`) are timing tests and passed alone.

### F2 result: shape objects, volumetric lights, puppet IK (fork patches 0086–0090, pin `f4aa7c5`, 2026-11-05)

Decoded from wallpaper64.exe 2.8.485 (the sound spike's `all.c` plus the exe for vtables, constants and asm; no REA
session was needed) and the stock assets (2.8.42's `effects/lightshafts`, `materials/util/volumetrics_*`,
`shaders/volumetrics{back,front}`). Library scan of the Workshop folder: one `shape` object (3319542538's layer 895,
"Rayons lumineux - linéaire", `shape: quad` with the stock lightshafts effect), no light with `castvolumetrics`
(3477054430's four spots carry the editor's `density` 2 / `volumetricsexponent` 1 defaults, off), one IK bone
(3042492564's 海果-手臂), no bone with physics enabled.

**What "VolumeLight" was.** Upstream LWE logged every `shape` object as "VolumeLight objects are not supported yet".
WE's object factory (GH 0x1401be650) builds a `shape` as its own class (vtable 0x1404d36e8, 0x460 bytes, on the
effect-object base 0x1404d2168 of GH 0x140212c50): no light at all. Volumetric light is the lights' `castvolumetrics`.

**Shape objects (0086, Observed):**

- Its size is a square of the scene's orthographic height, both sides (GH 0x140285b40 reads the render context's
  +0x88 twice; GH 0x1401b6c60 stores the ortho height there).
- Its mesh (GH 0x1402861b0): its first effect's first pass's `point0`..`point3` (vec2; all four, else the plain quad
  GH 0x140219570), vertex = (S · (p.x − 0.5), S · (0.5 − p.y), 0), uv = p, triangles 0 2 1 / 0 3 2; the bounding radius
  (+0x450) culls it.
- Every pass gets combo DIRECTDRAW 1 (vtable +0xc8, GH 0x140285f40). lightshafts under DIRECTDRAW reads no layer
  picture and maps the quad's corners back to its unit square (`inverse (squareToQuad (p0..p3))`).
- Its draw (GH 0x140285b70): the layer's world matrix, then the LAST effect's passes (GH 0x1402176a0 with param 5 = 1),
  straight into the scene. On that effect's last pass GH 0x1402176a0 calls the shape's vtable +0x108 (GH 0x1402866d0),
  which sets the pass's blending to 2 = additive (GH 0x140182410's names).
- LWE: a shape is an Image with no base pass, no colour-blend/tint pass, 1 x 1 composites and a 1 x 1 placeholder
  picture (0090); its 6-vertex quad is
  recomputed per frame on the layer's scene rectangle (as the puppets'). Not ported: the radius cull, the object's
  flag 0x80 path (FUN_1401b4fd0, a perspective variant).

**Volumetric lights (0088):**

- Observed: `castvolumetrics` is flags +0x2c4 bit 2; `density` +0x2f8 (default 2), `volumetricsscattering` +0x2fc
  (0.5), `volumetricsexponent` +0x300 (1) (GH 0x140283df0, the factory's defaults). The app setting `volumetrics`
  defaults to "medium" (GH 0x140048ca0); quality 0 skips the pass.
- Observed, the pass (GH 0x1401c56e0, per light): targets `_rt_volumetricsBack` (the scene's depth),
  `_rt_volumetricsSingle` (the light volume's back faces' depth, volumetrics_back) and `_rt_volumetricsLightBuffer`
  (+ `B`), a divisor of 8 up to medium, 4 above; blur_h / blur_v (blur_depthaware above high) and volumetrics_combine
  (DEPTHAWARE when quality > 1); combos QUALITY, POINTLIGHT, SHADOW (castshadow and shadows on), COOKIE (usecookie).
  The eye's probe (eye + forward · 0.2) inside the volume picks volumetrics_fullscreen, else volumetrics_front.
- Observed, the volume mesh (GH 0x140282d40): a point light's sphere (GH 0x1402813c0) of its radius; a spot's 32-step
  cone in its own clip space (a frustum cube with usecookie).
- Observed, the packing: g_RenderVar1 = (radius · 0.99, cos inner, cos outer, intensity), 2 = (origin, density),
  3 = the spot's x axis (a point light: its projection info), 4 = (colour · scattering, volumetricsexponent),
  0 = the shadow map transform; g_AltViewProjectionMatrix = the volume's matrix, g_AltModelMatrix = the light's
  projection, g_EffectModelMatrix = the inverse view-projection.
- Ours: the front shader compares GL depth-texture values with D3D clip depth: the march draws through the
  view-projection with z remapped to 0 … w (and unprojects through its inverse); the depth targets are y-flipped
  (the shader's screen uv grows down): the scene's depth is blitted flipped, the back faces drawn through a y-flipped
  view-projection. Half float light buffers. Where the pass runs in WE's frame is Inferred (after the objects).
- Not done: SHADOW and COOKIE volumetrics, fog in the march, directional volumetrics (2.8.485's
  volumetrics_directional; 2.8.42's assets lack it), the `volumetrics` quality as a setting (medium).

**Puppet IK (0087):**

- Observed: the bone JSON (GH 0x14028bbd0) sets settings flags: `ik` 0x4000, `ikce` 0x8000, `se` 0x1000, `re`
  0x2000, `r` 1, `t` 2, `ikg` 0x20, `ikr` 0x40, `ikse` 0x80, `ikfe` 0x100, `rax/ray/raz` 0x100000/0x200000/0x400000,
  `tax/tay/taz` 0x800000…; `ikd` (≥ 1) at +0x5c, `ikrminl`/`ikrmaxl` +0x64/+0x68 (with `ikce`). MDLS v2's IK targets:
  a name, the bone, a type, a 64-byte matrix in the mesh's space; MDLA v2 has one key track per target.
  3042492564's arm: the hand's type-0 target sits on the hand and its track moves 24 px (y −76.7 … −52.7 … −76.7 over
  6 s) while every bone track is still; a type-1 target sits by the elbow.
- Inferred: the solver. It isn't in the mixer GH 0x140228470 (which holds the Euler wraps of `rax`… and a physics
  world, the 0x14023f… helpers); not found elsewhere. LWE: two-bone chains by the law of cosines with the elbow on the
  type-1 target's side, longer ones CCD, in the puppet's plane, after the layers mix (the target tracks mix as the
  bones'), before a script's bone overrides; `ikr` turns the end bone to the target's rotation.
- Not done: `ikce` / `ikrmin`/`ikrmax` limits, `ikg`, `ikse`/`ikfe`.

**Not done (Left):**

- Bone physics, applyBonePhysicsImpulse / resetBonePhysicsSimulation (no-ops), `general.gravity*` / `wind*`: no library
  bone enables physics (`se`/`re`/`ge` false, `s` 0 everywhere); the simulation is built on a rigid-body helper family
  (GH 0x14023f030…0x14023fc00, the world at the puppet's +0x4b8) reached from the mixer, unread. Porting it without a
  user would be invention.
- Root motion (MDLA flags bit 0, 0 users), MORPHING_MODIFIERS (0 users), MDLA v6's per-bone float track.

**Fork tests** (`host_api_test`): 108/108; the 3 new ones fail on `78128d1`.

| Test | What it checks | On `78128d1` |
|---|---|---|
| `shape_draws_its_effect_in_place` | two shapes in a 64 x 32 scene: A's corners (x 0.25..0.75, y 0.25..0.5 of its 32 px square) land in the rows of a white marker 8 px up, red (DIRECTDRAW) left, red + green (uv.x > 0.5) right, nothing outside; B with two effects draws only the second (green) on the first's corners (x 48..63); both add to the blue clear though their materials say `normal` | nothing drawn (blue) |
| `volumetric_lights_glow` | a point light (radius 3) glows white at the centre, not at the corner; off without castvolumetrics; a spot along +x glows on its axis, not 2.5 units above; from inside the sphere the full-screen march glows; a black depth-writing wall in the sphere cuts the glow (135 → 22) | the clear colour everywhere |
| `puppet_ik_reaches_its_target` | a three-bone MDLV0016 arm whose hand's IK target is animated to (0, 8): the hand's square at x 30..33, 8 px up | the square at its bind (x 38..41, centre row) |

**Scenes, old core (`78128d1`) vs new** (6 s smokes, `WPENGINE_PARTICLE_SEED=7`, the release worker with each core on
LD_LIBRARY_PATH; VRAM at 4 s; scratchpad `f2/pairs/`):

| Scene | What changes | Frame ms old → new | VRAM old → new |
|---|---|---|---|
| 3319542538 (shape) | pink light rays rising from the horizon right of the tree (448 841 px differ at 1 s, inside x 1895..3840, y 304..1541) | 5.3 → 5.0–5.4 | 530 → 530 MiB (548 before 0090) |
| 3042492564 (IK arm) | the hand on the rail moves with its target (a 94 x 122 px box at 1 s, 1520 px at 4 s) | 8.0 → 7.1 | — |
| the synthetic F1 scene with castvolumetrics on both lights | the point light's blue haze and the spot's shaft over the floor (no shadows in the shaft: SHADOW not done) | 0.96 → 1.19 | 49 → 71 MiB (the full-size depth copy, the light buffers, the shaders) |
| 3477054430 (3D, spots, castvolumetrics off) | nothing | 1.33 → 1.37 | 139 → 139 MiB |
| 2182433068 (2D) | nothing | 0.79 → 0.89 | 82 → 82 MiB |

- A scene without volumetric lights builds nothing for them (no targets, no pass). One with them pays, per light, a
  back-face depth draw and a march at an eighth of the scene, then a full-size depth blit, two blurs and an
  additive full-screen draw.

**Shader sweep** (4085 compiles, the new core, compared with F5/F6's run): 16 → 6 failures, 10 fixed (F4's caster
fixes, absent from that run's core), 0 newly failing; the 6 are as in F1.

Player tests (DEBUG, pin `f4aa7c5`): 740 passed, 0 failed, 3 ignored.

**Health** (`scene-health.md`, 96 scenes, pin `f4aa7c5`): 86 clean / 10 degraded / 0 failed, as on `78128d1`. The one
change: 3319542538 loses its "unsupported: VolumeLight (shape) object" error (6 → 5 errors, loss 2 → 1 %: the `Text`
user property is what's left); no other scene's class, loss, errors or warnings moved. VolumeLight is gone from the
report.

### Leftovers result: stereo audio feed, HarfBuzz text, world-space particles, health findings (fork patches 0091–0097, pin `262d97b`, 2026-11-05)

The remaining "Left:" items of B1–B14, F1–F9, the health report and the coverage doc, worked in order of library
usage (scan of `~/.local/share/Steam/steamapps/workshop/content/431960`, 96 scenes). Decoded from the same
wallpaper64.exe 2.8.485 with the sound spike's `all.c`, plus wallpaperui.exe's and mediaextensions64.dll's
strings/asm. **Observed** = read in the binary; **Inferred** = ours, marked.

**B8 stereo feed (41 audio scenes; player side + no fork change).** The worker fed LWE's legacy `wp_audio_input_mix`:
SysMon's mono average of every stream as 1024 u8 samples, a snapshot of the newest 1024 per tick, taken as
44.1 kHz. Now:

- SysMon keeps each stream's frames in **stereo** on the graph clock (`pw_buffer.time` → a 48 kHz frame index; a
  buffer within a quantum of the ring's end continues it, a skipped one leaves silence, a jump back starts over) and
  mixes them by their place on that clock up to the settled point (the oldest stream's end, never > 4096 frames behind
  the newest), into one stereo stream every reader takes from its own cursor (`SysMon::visual_since`).
- Each scene source appends what it gets (newest 4096 frames kept); a `Tick` carries the frames since the last one
  (`AudioInput`: 48 kHz s16 stereo, base64 — JSON carries a tick's floats badly; protocol 4 → 5).
- The worker pushes them in order through `wp_context_audio_input_push` (2 channels, 48 kHz), so LWE's WE-exact
  analysis (B8, 0045) runs per channel on a continuous stream: `g_AudioSpectrum*Left` ≠ `*Right` now.
- `--lwe-smoke --tone HZ` feeds the same way (48 kHz stereo, in order); `--tone-channel left|right`, `--tone noise`,
  `--tone-sweep HZ1`; the JSON reports the 16-band left/right spectrum.

**The audio scenes that didn't react to a 110 Hz tone (B8: 17 of 39 loading scenes).** With the in-order stereo feed,
37 of the 41 react to 110 Hz or white noise (was 22). Why the old feed missed them (**Inferred**): each 1280-sample
analysis window was spliced from two overlapping 1024-sample snapshots with a phase jump, so a pure tone's band level
fell under the scenes' `audiobounds` (pulse/shake smoothstep 0.5..1, Simple Audio Bars' thresholds). Of the rest:

- 2290002190: its audio is a script on the particle system's `instanceoverride.rate` — **such scripts never ran**
  (CParticle registered only scale/angles/visible/parallaxDepth). Fixed in 0094 for all 11 library scenes that script
  an override (rate 4, size 3, count 3, speed 1, controlpoint1 2, colorn 2, alpha 1).
- 2388299037, 3509243656: every audio effect in the default configuration has `AUDIOPROCESSING` 0 (off), or the
  visualiser sits under a hidden-by-default layer; content, not ours.
- 3445973124: `background`'s pulse has `AUDIOPROCESSING` 1 (left), bands 0–1, bounds 0.5–1, visible: by the shader
  (and the spectrum the smoke reports, left 0.65 / 0.96) it should tint; the 3 s frames differ by ≤ 1 level. Not
  explained by static reading — a WE capture with music is the check.

**Scene sound peaks (`volume²` above 1).** **Observed** (mediaextensions64.dll, SFML 3's miniaudio): after the data
callback (and the master volume, 0x18002b000), `noClip` off (device +0x66) and an f32 device (+0x334 == 5) run the
in-place clip loop 0x180029cb0 (`minps`/`cmpltps` against ±1.0) over frames × channels — WE hard-clips its summed
output at ±1, after each sound's `volume²` and the wallpaper's level. The worker now clamps its output to ±1 **after**
the stream's own gain (the wallpaper level, a transition, the normalization) — WE's order, so a lower gain still leaves
peaks whole; 2375914945 at `musicvolume` 2 (peaks 2.04) clips at 0 dBFS as in WE. Inferred: SFML leaves `noClip` at
its default (false).

**B4 HarfBuzz shaping + WE's fallback chain (45 text scenes, 0091).** **Observed** (GH 0x1401da3c0): each line is cut
into runs of one face — every character's face from the font, else the chain; tab, LF, CR, space and ZWJ stay in the
run before them (mask 0x100002600, 0x200d) — and each run is shaped (FUN_1401e1c00 / 0x1401e0eb0, not read further).
The chain is the table at 0x1404c5030, in order, a slot opened when no open face has the character: arial.ttf,
seguiemj.ttf, arialuni.ttf, segoeui.ttf, `fonts/TwemojiMozilla.ttf` (WE's own asset), seguisym.ttf, msyh.ttc,
Malgun.ttf (flag 1 = the Windows fonts folder). LWE now shapes each run with `hb_shape` on an `hb_ft` font of the
face (advances `x_advance >> 6`, offsets applied), and resolves each Windows slot by its family, then families
fontconfig commonly has in its place, accepted only under that exact name (Liberation Sans / Arimo, Noto Emoji, Noto
Sans / DejaVu Sans, Selawik / Noto Sans / Open Sans, Noto Sans Symbols 2, Noto Sans CJK SC …, Noto Sans CJK KR …);
TwemojiMozilla from the assets; fontconfig's own choice stays as a last resort (ours). Inferred: hb_ft's default load
flags, script and direction guessed per run.

Size check (as B4's: `WPENGINE_TEXT_DEBUG=1`, the editor's saved `size`, 66 literal texts now that the 3D scenes load):

| | f4aa7c5 | 0091 |
|---|---|---|
| width and height within 0 px | 4 | 22 |
| within 2 px | 12 | 29 |
| width within 3 % | 46 | 53 |
| mean width error | 3.5 % | 2.5 % |

Scene fonts now match the editor to the pixel in most texts (Atami, Mikodacs, TAHOMAB0, 书法字体, NotoSans, 2.ttf);
the misses left are Arimo / Comic Neue standing in for Arial / Comic Sans (metric substitutes kern differently) and
3480481965's Gogh-ExtraBold.

**World-space particles (system flags bit 0, 16 scenes, 0092).** **Documented** (wallpaperui.exe's particle-system
strings: `worldspace` among the disable-colour/lifetime/count/speed/size overrides = flags 8/0x40/0x20/0x10/0x80;
bit 1 the sheet-blend opt-out, bit 2 perspective, so "Worldspace" is bit 0 by elimination). Its particles stay where
they were emitted when the system moves, turns or scales: 3104056709's `zzz` follows the cursor layer by script and
now leaves its trail. **Inferred** (the simulation's world-space branch wasn't read): the particles stay in the
system's space and are carried across each change of its transform (M_now⁻¹ · M_last; the parallax, a view offset,
excluded). The other 15 scenes' systems don't move.

**Health-report findings (0093).**

- 3516106265's 24 missing `materials/launcherN.tex`: a usertexture naming a `usershortcut` property — WE binds the
  picked shortcut's icon (**Observed**: GH 0x140184980 names it `"usershortcut_" + property`, type 2); none picked
  keeps the slot's texture (**Inferred**: the author's `default_dock_icon` there). A picked Windows shortcut's icon
  can't be read on Linux: the slot keeps its texture (logged).
- 3042865984's `materials/.tex`: refract's `g_Texture2` annotation `"default": ""` names no file; the pass sets the
  texture. Not looked up any more.
- 3319542538's `unsupported: user property type Text` ×5: value-less link labels; read as `text` labels (nothing in a
  scene reads a label, so no picture depends on WE's spelling rule, which wasn't read).
- The 10 remaining script errors, each checked against WE (content, they throw in WE too): 3432999904's two `export
  function update` (a module SyntaxError in any engine); 3219908811 / 3243449890 `value.x =` on a boolean (strict-mode
  TypeError); 3326873240's global `scene` (WE's globals are thisScene/thisLayer/thisObject/engine/input/shared/
  console/localStorage); 3042492564's `event` in `applyUserProperties` (no such parameter); 3163060610's
  `engine.AUDIO_RESOtime_switchingION_16` (undefined → WE's own `RangeError: Resolution must be either 16, 32 or 64.`,
  a string in scenescript64.dll); 2890767643's lookups of layers the scene doesn't have (`playeroutlineanim` and the
  `.mp3` sound layers).

**Particle instanceoverride scripts (0094).** Above: the overrides an object sets are registered as script
properties; their keyframe animations already played.

**Shared parent/children timelines (5 scenes, 0095).** **Observed** (GH 0x1401d1740): an animation's `options.parent.key`
is read; the editor writes it on the child with `options.children` on the parent. The parser records each animation
with the JSON object holding it and its key; after the scene parse a child is linked to the parentless sibling it
names, and its time is the parent's (held at its own length), advanced after the parents. 3163060610's Size and opacity
now wait for their scripted, `startpaused` Radius timeline instead of running at load. **Inferred**: the shared clock.

**WE's simplex hash (B11, 21 turbulence scenes, 0096 comment only).** **Observed**: GH 0x14012c280 is Gustavson's 3D
simplex noise (skew 1/3, unskew 1/6, 0.6 − r², t⁴, × 32, the 12 edge gradients) with Perlin's permutation (0x1404c3520,
512 bytes, equal to LWE's `PERLIN_PERM`) and permMod12 = perm % 12 (0x1404c37b0): what LWE computes. Nothing to port.

**Rope subdivision (P30, rope 11 + ropetrail 9 scenes, 19 in all, 0097).** **Observed**: WE sets `TRAILSUBDIVISION` = the
renderer's `subdivision` (defaults 4 rope / 1 ropetrail, GH 0x1401ee560 / 0x1401ee8c0) and genericropeparticle.geom
emits that many points between a segment's ends: subdivision + 1 pieces (LWE drew max (1, subdivision)). `ORIENTATION`
is 0 in every library rope (eye-facing, what LWE's CPU ribbon does in 2D); no library rope sets uvscrolling /
fadealpha / fadesize. Not ported: WE's per-segment bezier (control points `start + CP · 0.15` from the CPU buffer's
spline points, whose builder wasn't read) — LWE keeps its Catmull-Rom.

**`SPRITESHEETBLENDNPOT` (B3, 2 sheets in 3 scenes: 3445973124, 3479521040, 3490034653's birds).** **Observed**: WE sets
it for a sheet padded to a power-of-two texture; common_particles.h's NPOT walk wraps a row at the image's width
(`g_Texture0Resolution.z / .x`). Tried and reverted: LWE uploads a mip at its stored size, and these two sheets are
stored at their image size (2048 × 1024 / 1024² headers over 1603 × 616 / 516² images), so LWE's plain walk
(frameWidth = 1 / cols) already is WE's; the NPOT walk over that upload cut the birds up (smoke pair). Comment in 0097.

**Fork tests** (`host_api_test`, 108 → 113 passed): the 5 new ones fail on `f4aa7c5`.

| Test | What it checks | On `f4aa7c5` |
|---|---|---|
| `text_shapes_with_harfbuzz` | NotoSans 20 pt "AVAVAVAV" 24 px narrower than "AAAAVVVV" (GPOS kerning; 384 vs 408) | 412 = 412 |
| `particle_world_space_stays` | a flags-1 system moved 20 → 50 by script leaves its particle at x 25; a flags-0 one carries it to x 49 | both at x 49 |
| `unset_slots_are_not_missing` | a `"default": ""` sampler + a `usershortcut` usertexture keep the pass's white texture with no missing asset; a `Text` label property isn't "unsupported" | `materials/.tex` missing |
| `particle_override_scripts_run` | an instanceoverride `size` scripted to 3 draws the particle 3 × wide (6 px) | 2 px |
| `animation_follows_its_parent` | an alpha fade with `parent.key` origin holds at its first key under a paused origin timeline, ends under a playing one | both ended (r 0) |

Player units (new; the first two can't exist before — the old mix was a mono u8 average): sysmon
`visual_mix_is_stereo_and_clock_aligned`, `ring_follows_the_clock`; proto `audio_input_keeps_both_channels`; worker
`output_clips_at_full_scale_after_the_gain` (fails on the old Dsp: peak 2.0).

**Gates.**

- Health (`scene-health.md`, 96 scenes): 86 clean / 10 degraded → **89 clean / 7 degraded** / 0 failed. 3042865984,
  3319542538 and 3516106265 are clean (missing assets 25 → 0, unsupported 5 → 0); no scene worse in class or errors;
  the 7 left are the content script errors above.
- The 96-scene smoke (the health run's PNGs vs F2's): none newly blank (lit pixels within 50 % on all 95 that render).
- Shader sweep (4085 checks vs F2's): 6 failed before, 6 still failing, 0 fixed, 0 newly failing.
- Audio: 110 Hz and white-noise runs of the 41 audio scenes (`--tone`, scratchpad `lo/t110`, `lo/tnoise`).
- Player tests (DEBUG, pin `262d97b`): 743 passed, 0 failed, 3 ignored (740 on `f4aa7c5`).

**Listed, not ported (no library user and no readable WE code, or no library user and nothing visible):**

- `controlpointangle0`–`7` (0 library users; their reader is in the unread spawn interpreter GH 0x140260d80),
  vortex_v2 (operator case 0x10, 0 library users, 5 stock presets; not decoded), P24 cone and P25/P26 (0 scenes), P27's
  non-default bounds / limitbehavior / axis (0 scenes: all on WE's defaults), the `layerimage` emitter and
  `collisionmodel` (0 library users; the CPU layer-pixel path wasn't found), `customsortorder` (0 users; reader not
  found), the 3D camera's zoom / parallax (0 3D scenes use either), a camera object's own `path` / `queuemode` (all 11
  files are `{"paths": []}`).
- Directional shadow cascades, light clusters (> 16 lights; no library scene has that many), 2.8.485's PCSS (quality 4),
  the `shadows` / `volumetrics` quality settings, SHADOW / COOKIE / fog / directional volumetrics: 0 library scenes cast
  shadows or volumetrics. `lightconfig`: 3477054430's `{"spot": 4}` is an older form 2.8.485 doesn't read (it reads only
  `directional` / `directionalshadow`): WE ignores it too, nothing to port.
- Root motion (MDLA flags bit 0), MORPHING_MODIFIERS, MDLA v6's per-bone float track, bone physics (no library bone
  enables it), IK limits (`ikce`, `ikrmin`/`ikrmax`: 0 users), puppet hit boxes (`CursorEvent.hitBox`: 0 readers; the
  layout isn't in MDLE/MDMP), `transformAttachmentToTexture` (0 callers), ITextLayer writes re-laying the text (0
  writers), `timeofday` animations (0 users), T6/T7 text background / outline / shadow / MSDF (0 scenes), text
  `depthtest` (2D only: no depth to test).

**Still open (users or readable code, not done in this run):** the `.tex` flags 2²¹ (1 library texture) and 2²³ (2):
their reader wasn't looked for in this run; `general.hdr`'s gate on the post-processing setting (GH 0x14013f860,
5 HDR scenes); E9 / E11 (`g_LayerModelMatrix`, 3516106265) / E20 / E38; the fdt frame-time source and the child
"alive" test (GH 0x1402524c0); the puppet attachment builder and the additive scale; WE's rope bezier; the SceneScript
angles binding's address. WE captures (owner): 3414858021's "WEDNESDAY" (centred at the scripted x8 = 0.967 × canvas,
it reaches the edge here; whether WE's layout does the same needs WE), 3445973124 with music, the B-batch captures.

### Decode leftovers result: the HDR gate, .tex component flags, g_LayerModelMatrix, and what the rest decode to (fork patches 0098–0100, pin `f50bc82`, 2026-11-05)

The "Still open" items above that have library users or readable code. Decoded from the same wallpaper64.exe 2.8.485
(`all.c` / `all.asm`), resourcecompiler64.exe 2.8.485 (objdump) and WE's own `assets/`. **Observed** = read in the
binary; **Inferred** = ours, marked. Where the decode confirms what LWE already inferred, that is said.

**The HDR gate (B13; 0098; 5 HDR scenes, 1 changes).** **Observed** (GH 0x14013f860, the project classifier): it reads
the scene file's `general` (raw JSON) and finds `bloom` and `hdr` (string 0x1404c9650) with GH 0x14013f170; each
counts only with rapidjson's bool flag (`value +0xe & 8`) and true (GH 0x1401476c0). With both, the "postprocessing"
setting `ultra` sets the renderer flag 0x2000 (`displayhdr`: 0x6000). So **an `hdr` scene without bloom renders LDR
in WE**, and a `bloom` bound to a user property (a JSON object) or written as a number never turns HDR on. LWE now
gates on the literal pair; WPENGINE_HDR=0 still stands for a setting below Ultra (LWE has no quality setting:
Inferred that the owner's WE runs at Ultra). The library: 2511663284 (`hdr` true, `bloom` false) gets RGBA8 targets
again; the other four have `bloom: true` and are unchanged. The renderer is rebuilt when the flags differ from the
running ones (GH 0x140144b40), so the gate is per load.

**The `.tex` flags 2²⁰–2²³ (0099; 2 scenes, 5 textures).** **Observed**: resourcecompiler64.exe builds a texture's
channels from separate "component" images and sets `0x100000 << channel` for each one it fills (the copy loop at
0x140060ee0, then `or [flags], 0x100000 << esi` at 0x140060f1c); the TEXI reader (GH 0x14018b1f0) accepts any flags
below 0x2000000. WE's shader preamble (GH 0x14019b550) walks every sampler bound to a texture: its `combo` gets
`#define … 1`, and each entry `i` of the sampler's `components` list gets its `combo` defined when the bound texture's
flags (texture +0x1c) have `0x100000 << i`. The stock PBRMASKS sampler (generic3/4, genericimage2/3/4, foliage4,
fur4, chroma4) lists METALLIC_MAP, ROUGHNESS_MAP, REFLECTION_MAP, EMISSIVE_MAP — the shaders read
`componentMaps.x/y/z/a` only under those combos, else g_Metallic / g_Roughness and no emission. Library: 3477054430's
`masks/Image_3_mask` is 0xa00002 (roughness + emissive), 3509243656's four `Material__50` / `DefaultMaterial` masks are
0x800002 (emissive). LWE ignored the bits; the format resolver now also returns the bound texture's flags and
ShaderUnit defines the component combos (unless the material sets them). Flag 64 (GH 0x14018b1f0: one more u32 in the
header, 1..128, a slice count: `slice3d`) has 0 library users.

**E11 `g_LayerModelMatrix` (0100; 3516106265).** **Observed**: uniform 0x19 (GH 0x14010a0e0) reads the render context
+0xa30; GH 0x1402176a0 copies image +0x384 there for the layer's effect passes, and the layer's draw (GH 0x140214b50)
stores at +0x384 the matrix it pushes as its model matrix, the object's vtable +0x80 (GH 0x1401b5170: T · Rz · Ry · Rx ·
S with the parents' and the attachment). LWE never registered it (zero): frame_builder's FIXSCALE (default on) takes
the layer's scale from the matrix's first two columns and collapsed. It is now `CScene::worldMatrixOf` of the layer,
updated each frame. WE fills it only for passes with flag bit 0 (`piVar12[… + 5] & 1`); LWE feeds every pass of the
layer (a shader that doesn't declare it doesn't see it).

**E9 `g_TexelSize` (not decoded).** Uniform cases 6/7 divide (1, 1) / (0.5, 0.5) by the render context's +0x74 (8
bytes), the same pair as g_Screen (case 8: w, h, w/h). Its writer wasn't found: no float, 8-byte or 16-byte store to a
render context's +0x74 in `all.asm` (the stores at +0x74 that exist are other classes: a CRT stream, a matrix
transpose, the regex lexer). LWE keeps 1 / the scene size. **E20** (`TEX<n>FORMAT` for `formatcombo` samplers) was
done in F9 (0075, GH 0x1401d2a20) and **E38** (`alphatocoverage`) in 0067; the rows are updated.

**The fdt frame time (B11; confirms the inference).** **Observed**: the interpreter call (GH 0x14025c2e0, 0x14025ce6a)
takes `rbx = *system` and divides 0.025 by `rbx +0x14c`, with `rbx +0x148` the frame-rate setting (`fps − 1 ≤ 19`:
two half steps). That host is the render context: the instance update that calls the alive test (GH 0x140255e50) sets
`*instance +0x1ca` (the matrix stack's dirty byte) and pops `+0x30` by 0x40 (the model matrix stack), the fields the
uniform setter reads from its context (cases 9 / 0xb). Its +0x14c is uniform case 4, `g_Frametime`. So fdt =
dt · min (0.025 / frametime, 1)^0.7 with the frame's own frame time, what LWE does.

**The child "alive" test (GH 0x1402524c0; confirms, one nuance).** **Observed**: alive = any static child (+0x468,
16-byte entries) alive, or any event instance (+0x480, 0x38-byte entries, vectors of instances) alive (recursively),
or the system's particle count (+0x344) ≠ 0, or its live-emitter count (+0x3f4) ≠ 0. The count is the emitters of
types 1–3 at reset (GH 0x140254e40 / 0x140254ed0) and drops when one stops (GH 0x14025cfe0 at 0x140260715): its delay run out and its
duration run out, or — without a duration — a rate ≤ 0 and not (instantaneous ≠ 0 with the periodic flag 4). LWE's
`childAlive` is this, except a periodic emitter with instantaneous 0 and rate 0 stays alive in LWE (WE stops it);
no library child has one. Not changed.

**B12: the additive scale and the attachment builder.** **Observed** (GH 0x140224390, the additive mix, SoA blocks of
10 floats per bone): components 7–9 (scale) get exactly the position's rule, pose + (lerp (a, b, f) − bind) · w —
LWE's inference holds. The attachment (vtable +0x78 of the puppet image, 0x1404d2cb0: GH 0x14024b480 finds it by name
in 0x68-byte entries, name +0, matrix +0x20, bone u32 +0x60; GH 0x14024b530 applies it): local ← (bone matrix · the
MDAT matrix) · local, then world = parent world · local (GH 0x1401b5170). The bone matrix comes from the puppet's
animator (image +0x2d8, its +0x30 array of 64-byte matrices); whether that array holds the posed world (LWE's
reading) or the skinning matrix wasn't traced to its writer. WE applies the whole product; LWE keeps its translation
and z turn (2D: the library's attachments). Not changed.

**P30 rope bezier (the shader side decoded, the CPU side not).** genericropeparticle.vert/.geom: per segment the CPU
gives start (a_PositionVec4), end (a_TexCoordVec4.xyz) and two spline points CP0 (a_TexCoordVec4C1.xyz) and CP1
(a_TexCoordVec3C2 / C2.xyz); the bezier's inner control points are start + 0.15 · (end − CP0) and end + 0.15 · (start −
CP1). With CP0 / CP1 the neighbouring particles (i − 1, i + 2: **Inferred**, the buffer's builder wasn't found) this is
a Catmull-Rom-shaped curve with tangent factor 0.15 where Catmull-Rom's is 1/6: LWE's ribbon is within 10 % of it.
Not changed.

**SceneScript angles in degrees (confirms 0057).** The constants 57.29578 / 0.017453292 are at 0x1404d4460 /
0x1404d411c in this exe (the addresses 0x1404928d0 / 0x140492628 noted under the 3414858021 result hold other bytes).
**Observed**: the script object table (GH 0x14020dcc0) registers `angles` as a vec3 at object +0x140 with the same
script getter as `origin` / `scale` (LAB_1401d0ef0) plus descriptor flag bit 2 (`+0x60 |= 4`), which no other
property sets; `getAttachmentAngles` (GH 0x14020db20) returns Euler angles × 57.29578; WE's own
`scripts/jsclasses/baseclasses.js` (Vec2 angle, Mat4 rotation and decomposition, Vec3 spherical) works in degrees
throughout. The bridge's use of flag 4 (where `thisLayer.angles` is scaled) wasn't located; scenescript64.dll's own
copies (0x1812ed0a0 / 0x1812ed080) are read only by four V8 builtins.

**Fork tests** (`host_api_test`, 113 → 116 passed): the 3 new ones fail on `262d97b`.

| Test | What it checks | On `262d97b` |
|---|---|---|
| `hdr_needs_literal_bloom` | an rgba_backbuffer FBO of 2.0 read × 0.25: `hdr` + `bloom` false 64, `hdr` + user-bound bloom 64, `hdr` + `bloom` true 127 | 127 / 127 / 127 |
| `texture_components_define_combos` | a 4-component sampler bound to a 1 × 1 .tex: flags 3 defines none, 0x800002 the 4th, 0xa00002 the 2nd and 4th | none defined |
| `layer_model_matrix_is_fed` | an effect on a layer scaled 2 × 3 and turned 0.5 reads its matrix columns' lengths 2 and 3 | 0 0 |

`fbo_formats_as_written` now runs its HDR half with `bloom` on (strength 0), as the gate needs.

**Gates.**

- Health (`scene-health.md`, 96 scenes): **89 clean / 7 degraded / 0 failed**, as before; no scene worse in class or
  errors, none newly blank (lit pixels within 50 % on all).
- 3 s frames vs the `262d97b` run: 2511663284 25 % of pixels differ (RGBA8 targets, no HDR; its video frame also
  varies run to run), 3477054430 7 % (the mask's roughness + emission under its lights), 3516106265 2.5 % (the frame
  builder's frame), 3509243656 0 % (generic4 reads EMISSIVE_MAP only under LIGHTING / REFLECTION; why its frame is unchanged wasn't checked further); every
  other scene as before.
- Shader sweep (4085 checks vs the leftovers'): 6 failing before, 6 still failing, 0 fixed, 0 newly failing.
- Player tests (DEBUG, on this core): 743 passed, 0 failed, 3 ignored.
