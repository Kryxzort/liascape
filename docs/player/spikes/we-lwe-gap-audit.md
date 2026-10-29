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
| 3 | E2, E3 | **Image alpha and colour.** `g_Color4.w` is 1 instead of the layer alpha. Alpha, colour and brightness uniforms are frozen at setup, so fades, user sliders and scripts never reach the shader. | 30 + ~22 |
| 4 | G01, G02 | **Keyframe animations (`alpha/origin/angles/scale.animation`) are ignored**, so fades, slides and spins are static. | 20 |
| 5 | T1–T5, T8, G04, G13, G30 | **Text.** One line only, bytes not UTF-8, no alignment, no wrapping, no effects, no parent, no rotation, no parallax. A `systemfont_*` has no font on NixOS, so the text **vanishes**. | 45 |
| 6 | E27, E28 | **`colorBlendMode` layers sample the framebuffer they draw into**, a GL feedback loop with undefined output. | 28 |
| 7 | A1, A3, E8, S17, P20 | **Audio response.** u8 mono, only 0–5.4 kHz, linear bins, Right = Left. `registerAudioBuffers` is missing, so script visualisers throw. | 41 |
| 8 | G10, G11, G12, G14 | **Parallax.** `cameraparallaxdelay` is read as a bool, so 14 of 25 parallax scenes never move. The rest are off-centre, and `g_ParallaxPosition` is never fed. | 25 |
| 9 | P2 | **Particle `children` are ignored**, so whole sub-effects are missing. | 29 |
| 10 | G03, G04 | **Hierarchy.** A hidden parent doesn't hide its children (12 scenes). Text and particle children ignore `parent` (19). | 12 + 19 |
| 11 | S10, S11, S15 | **No cursor events, no media events, no `applyUserProperties`/`engine.userProperties`.** Interactive and "now playing" wallpapers are inert. | 22 / 19 / 18 |
| 12 | G06–G08 | **Puppet warp.** No skeletal animation. 7 of the 14 puppet scenes use MDLV versions LWE rejects. | 14 |

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
| **B2 Layer alpha, colour, keyframe animation** | E2, E3, G01, G02 (+ G05 once known) | ~50 | M | `g_Color4 = (color.rgb, alpha)`. Upload alpha/colour/brightness per draw from the live values. A keyframe evaluator for `c0..c2` bezier keys (`fps`, `length`, `mode` loop/mirror/single, `wraploop`, `startpaused`, `relative`), as decoded at GH 0x1401d1740/0x1401d4dd0/0x1401d5790. | Smoke two timestamps of 3 animated scenes: pixels change where WE animates. WE capture of 2388299037 (translucent layer). |
| **B3 Particle core semantics** | P1, P3, P4, P5, P6, P7, P8, P13, P14, P18, P19, P38, P41 | 61 | M (mostly S rows) | Prewarm in 0.05 s / 0.2 s steps until `starttime`. One shared `t` for colorrandom. `pow(rand, exponent)`. `rate` scales the system's dt. `count` scales emitter rate. HSV `colorn` against the reference colour. Enable `SPRITESHEETBLEND`. Re-patch overrides live. One scene RNG. | Smoke at +1 s ≈ +60 s particle density (prewarm). Fork tests for colorrandom, rate, count and exponent math. WE capture of 1797172968 and 1155728109 (P5, P8/P9). |
| **B4 Text renderer** | T1–T5, T8, T10, G04 (text part), G13, G30, E34, S28 | 45 | L | Render text into a texture: UTF-8, line breaking, `maxwidth`/`maxrows`/ellipsis, alignment/anchor/padding. Draw it as a CImage, so it gets effects, parent, rotation and parallax. fontconfig for `systemfont_*` with metric-compatible fallbacks. | Smoke 1884904087, 2134765860, 3028473503 (CJK), 2890767643 (system font on NixOS): text present, multi-line, aligned. WE captures of 2 clock scenes for size calibration (T10). |
| **B5 Parallax and camera** | G10, G11, G12, G14 (= E1), G15, E6, G18, G19, G17, then G16 once its algorithm is decoded | 25 + 8 + 6 | M | WE's smoothing `k = min(1,(1−delay/3)·10·dt)`. A centred target with `mouseinfluence`. Publish `g_ParallaxPosition`. Per-draw effect texture-projection matrix. `general.zoom`/fov/nearz/farz from `general`. Camera-object zoom/pan. | Headless player: `ctl headless.pointer` to 4 corners, `ctl capture` each, layer offsets ∝ depth and depth-0 static. WE capture of 2679248947 (depthparallax) at rest and with the cursor moved. |
| **B6 Hierarchy** | G03, G04 (particles), P36, G31 | 12 + 19 | S | Recursive "effectively visible". A parent transform for particle systems. The rotation pivot once confirmed. | Smoke 3163060610 / 3319542538 (hidden group). WE capture to confirm (G03). |
| **B7 Blend modes and the framebuffer** | E27, E28, E30 (= G33), E31, E33 | 28 | M | Copy the scene FBO before a pass samples `_rt_FullFrameBuffer`. Honour `clampuvs`. Settle `copybackground` and `_rt_imageLayerComposite` parity from WE captures. | WE capture of 2883756643 (blend modes 7/8/11/12/14/31) vs smoke. `glGetError`/KHR_debug feedback-loop warnings gone. |
| **B8 Audio response** | A1, A3, A4, A5, E8, S17, P20, P21 | 41 | M | C API: f32 stereo frames. Per-channel FFT, the observed pow band mapping, max-per-band, sqrt magnitude. Separate Left/Right. dt-based decay. `engine.registerAudioBuffers` (16/32/64 `left/right/average`) on the same buffers. Audio-driven emitter rate. Needs one more decompile pass for the weights and the 16/32 derivation (A3/A4 Unknowns). | Feed a log sine sweep through the input mix, dump the 64-band arrays per frame, and check that the band index follows the WE mapping and L≠R for a panned sweep. Smoke 2469881470 / 2134765860 with music. |
| **B9 Small uniform, property and shader fixes** | E4, E5, C1, C3, E9, E11, E17, E18, E19, E20, E36, E37, E38, E40 (+ the property side of scenetexture), E41, U1, U2, U4, S18 | ≤ 10 each | S each | One patch per theme: engine uniforms (E4, E5, C1, C3, E9, E11), annotation parsing (E17, E18, E45), the varying fix-up (E19), bloom live/tint (E36, E37), textinput quotes (U1, U2), timeOfDay (S18). | Smoke 3184155462 (cursorripple, needs pointer), 2189783622 (foliagesway back), 2890767643 (bar spacing). Corpus. |
| **B10 SceneScript API surface** | S8, S10–S16, S19–S27, S29–S32, S36, S37 | 1–28 each | M–L | Cursor hit-test + events (`solid`). Media events from liascape's MPRIS (`wp_project_notify_*`). `applyUserProperties` + `engine.userProperties`. `getLayer` by index for all layer types. ISoundLayer `play/stop/pause` (unblocks `startsilent`, A7). Persistent `localStorage`. Layer writes. Missing engine/scene members. Needs B1. | Per feature, a fork test script. Smoke 2325974975 (sounds + menu), 2890767643 (media widget with a fake MPRIS). Headless pointer clicks for cursor events. |
| **B11 Particles, extended** | P2, P10, P15, P22, P24–P30, P34, P35, P37 | 29 | L | Child systems (static / eventfollow / eventspawn / eventdeath). The missing initializers and operators. Control-point overrides and transforms. Rope/trail combos. Needs the operator interpreter (GH 0x140265800) read from asm first (P31–P33). | Smoke the 29 child-system scenes before/after: sub-effects present. WE captures for 2 of them. |
| **B12 Puppet warp** | G06, G07, G08, G09 | 14 | L | Start from PR #625's MDL parsing (unmerged, so cherry-pick into our own commit). Add MDLV 0016/0017/0019. GPU skinning. Animation-layer mixing. Bone attachments. | Smoke the 14 puppet scenes at 2 timestamps: the mesh deforms. WE capture of 1 scene. |
| **B13 HDR bloom and FBO formats** | E35, E23, E37 | 5 | M | WE's HDR chain (`hdr_downsample`, `combine_hdr_upsample`) with RGBA16F targets when `general.hdr`. | Smoke 2511663284 vs a WE capture. |
| **B14 3D scenes** | G24–G29, G20–G22, E13, E14, E43 | 3 (+4 with `perspective` layers) | L | A perspective camera with optional `orthogonalprojection`. 3D image layers and depth/transparent sort (3276522107 first, M). Then the MDLV static-mesh loader + `generic4`. Then lights, shadow atlas, fog. | Corpus: 3276522107 → ok, then 3477054430 and 3509243656. WE captures. |

Rows not in a batch are parity, editor-only or not used by the library. Their rows say so, for example T6, T7, A6,
U5–U7 and E10.

### Unknowns to settle by more decompilation (no owner needed)

- The particle operator interpreter GH 0x140265800, and the particle parser GH 0x1401f3120. Ghidra fails on both, so
  they need manual asm work. This settles P31–P33 (movement drag, turbulence, vortex, oscillate, colour/size change).
- The spectrum's 16/32-band derivation, its weights and its temporal smoothing. They sit in blocks Ghidra marked
  unreachable in FUN_140103630 ([L6]); read the asm. This settles A3/A4.
- The camera-shake algorithm (G16), the per-layer parallax offset with `cameraparallaxamount` (G12), the semantics
  of `camerafade` (G23) and of `copybackground` (E30).

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
| 2511663284 | HDR bloom (E35) | B13 |
| any scene, a clip of its first second | `camerafade` (G23) | — |
| a 16:9 scene on an ultrawide or portrait output | crop vs letterbox, and whether `anchor` moves layers (G32, C5) | B5 |

**Decisions:**

- **Media integration** (S11–S14, 19 scenes): feed WE's media events from MPRIS? Which player?
- **`engine.openUserShortcut`** (S21, 1 scene, Windows app launchers): ignore, or map to `xdg-open`?
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
| G06 | Puppet warp: no skeletal animation | **Observed**: the model/puppet class table `FUN_14024da50` has `rootmotion`, `getAnimationLayer(Count)`, `createAnimationLayer`, `playSingleAnimation`, `destroyAnimationLayer` (GH 0x14024da50). The exe knows sections `MDLV0023`/`MDLS0004`/`MDLA0006`/`MDLE0002`. **Documented**: animation mixing, blend rules, IK, bone constraints, blend shapes (docs …/puppet-warp/*). | `Data/Parsers/ObjectParser.cpp:295-305` parses `animationlayers` (id, rate, visible, blend). Nothing reads them. `CImage.cpp:413-511` loads the MDLV mesh as a static bind-pose mesh. No MDLS/MDLA parsing and no skinning. | 14 have a puppet mesh; 11 have `animationlayers`. e.g. 2375914945, 3233141951, 3463520581 | Characters are frozen: no breathing, hair or arm motion | L: MDLS bones, MDLA tracks, CPU or GPU skinning (4 weights). Upstream PR #625 (closed, unmerged) did a single layer. |
| G07 | Older puppet MDLV versions are rejected | **Observed**: the exe accepts the MDL family (strings above). Library files carry MDLV 0013/0016/0017/0019/0021/0023. | `CImage.cpp:430` accepts only `MDLV0021`/`MDLV0023` with an 80-byte stride. Any other version logs an error and falls back to the plain texture quad. | 7: 2375914945 (0013), 2679885269 (0013), 3013489778 (0019), 3022080536 (0016), 3042492564 (0017 ×9), 3233141951 (0019 ×4), 3243449890 (0019) | Puppet layers draw as the raw texture/sprite sheet (unassembled) where the mesh differs from the quad | S–M: per-version vertex stride (PR #625 found 0013 = 52 B stride) |
| G08 | Animation-layer mixing (`additive`, `blend`, `rate`, multiple layers, `blendin/out/time`, bound `visible`) | **Documented**: puppet-warp/animationmixing.html, blendrules.html. Runtime fields Unknown beyond the parsed keys. | Parsed partly (`ObjectParser.cpp:298-304`), unused. `additive`, `blendin`, `blendout` and `blendtime` are not parsed. | additive 7, >1 layer 7, bound visible 5, user-bound rate/blend 2/1 | Wrong or missing motion once G06 exists | M (after G06) |
| G09 | `attachment` (child pinned to a puppet bone) is ignored | **Documented**: ILayer `setParent(parent, attachment)`, `getAttachmentMatrix/Origin/Angles`. **Observed**: strings and the base-table methods (GH 0x14020dcc0). | Not parsed. The child follows the parent origin without the bone offset. | 3: 3363252053, 3414858021, 3463520581 | Attached parts drift off the character | M (needs G06 bones) |
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
| G33 | `copybackground` image flag | **Observed**: an image-table bit (+0x304, GH 0x140219c60). **Unknown**: how it renders. | Not parsed | 49 true on images, 14 on text | Unknown (handoff: effects/compose) | ? |
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
| E9 | `g_TexelSize`/`Half` scale | **Observed** cases 6/7: `const / ctx+0x74` (vec2). The same field is `g_Screen.xy` (case 8). **Documented** "size of a screen pixel … (1/1920, 1/1080)" | `1/scene projection size`, frozen (CPass.cpp:885-886) | 11: 2134765860, 2883756643, 3013489778 (bokeh/gaussian/sharpen/dithering) | when the scene resolution ≠ the output resolution (e.g. 4K scene on 1080p), blur and sharpen kernels differ by that ratio | S (whether ctx+0x74 is the output or the current RT size: **Unknown**) |
| E10 | `g_Screen` not fed | **Observed** case 8: `(w, h, w/h)` | not registered | 0 active (REFLECTION+NORMALMAP only) | none | S |
| E11 | `g_LayerModelMatrix` not fed | **Observed** id 0x19 (table). **Documented** "transform between layer local space and world space" | not registered: zero matrix | 1: 3516106265 (frame_builder_by_gariam) | `right`/`up` vectors = 0: frame geometry degenerate (Inferred) | S |
| E12 | `g_ModelViewProjectionMatrixInverse` in effect passes | **Observed** case 0xd: inverse of the ctx MVP. Its value inside effect passes: **Unknown** | identity in FBO passes, screen inverse on the last pass (CImage.cpp:815-847) | 5: 2469881470, 2815800031, 3479521040 (chromatic_aberration, lens_flare_sun) | the cursor-anchored centre may be off (unverified) | — |
| E13 | Lights / `LightingV1` | **Observed** ids 0x64-0x68 and 0x86-0x95 (g_LightsPosition, g_LightsColorPremultiplied, g_LCluster_*, g_LDirectional_*); `LIGHTING` and `LIGHTS_*` defines in the binary strings | `#require LightingV1` → a stub returning 0 (ShaderUnit.cpp:336-379); light uniforms are not fed; ambient/skylight are frozen copies (CPass.cpp:859-860) | 0 of the loadable scenes (LIGHTING=1 only in 3D 3276522107, 3509243656) | none today; blocks the 3D work | L |
| E14 | Fog | **Observed** `FOG_DIST`, `FOG_HEIGHT`, `FOG_COMPUTED` defines and g_Fog* ids 0x81-0x84 | not parsed or fed | 0 loadable (general.fogdistance only in 3D 3276522107, 3477054430) | none today | M |
| E15 | Per-slot texture uniforms > 0 | **Observed** g_Texture0-9 {Rotation, Translation, Texel, MipMapInfo} (ids 0x2b-0x5c) | only `g_Texture0Rotation`/`Translation` (CPass.cpp:690-691); `Texel`/`MipMapInfo` never fed; samplers only 0-7 (CPass.cpp:826-833) | 0 active | none | S |
| E16 | `g_TextureReductionScale` | **Observed** id 0x5d, fed per draw (value Unknown; Inferred 1 at full texture quality) | constant 1.0 (CPass.cpp:834) | 1: 3243449890 (skew) | none expected | — |
| E17 | Float uniform default given as a string | **Inferred** parsed as float (WE's editor shows 0.1) | `std::stoi("0.1")` = 0 (ShaderUnit.cpp:520) | 25 reference it; the default actually applies (no scene override) in ~5: 2890767643, 3028473503, 3432876246, 3013489778, 3042865984 | Simple_Audio_Bars spacing 0 (bars merge), cutout_vignette hard edge, dot_matrix size/smoothing 0 | S: `stof` |
| E18 | Malformed `[COMBO]` JSON | **Unknown** (WE's annotation parser may be lenient) | JSON parse error is logged and the combo is skipped, so its default is never defined (= 0) (ShaderUnit.cpp:444-449) | 5: 3243449890, 3414858021, 3516174947 (auto_sway `VERTICAL_RELATIVE_WIDTH` def 1), 2388299037, 3354740764 (procedural_noise `AD_PERSPECTIVE` def 1) | the combo branch flips unless the scene sets the combo | S: lenient parse / regex for `"default"` |
| E19 | Fragment uses a varying declared only in the vertex unit | **Unknown**/**Inferred**: WE compiles it (the scene works in WE), probably by building the PS input from the VS varyings | GLSL error, so the effect is left out (patch 0017) | 1: 2189783622: the effect lost is the packaged **foliagesway** (`v_Bounds`, frag line 51), not godrays as the TODO note says | foliage sway missing | S: copy VS-only `varying` decls into the frag unit |
| E20 | `TEXnFORMAT` for samplers ≠ 0 (`formatcombo`) | **Observed** `TEX0FORMAT` built in GH 0x1401fffb0; the other slots are **Inferred** from `"formatcombo":true` and `TEX1/2/4FORMAT` in shaders | only `TEX0FORMAT` for the renderable's texture (CPass.cpp:606-612) | 1: 3319542538 (lightshafts gradient r8, `TEX2FORMAT`) | an r8 gradient is read as RGBA (red tint), only when `RENDERING=1` | S |
| E21 | Engine-set defines | **Observed** strings and uses: `SKINNING`/`BONECOUNT`/`MORPHING`/`PRELIGHTING`/`REFLECTION` (GH 0x140230ec0), `SHADERVERSION` (GH 0x14019cb90), `WRITEALPHA`/`OPACITYMASK` (GH 0x140201470), `HDR`, `REVERSEDEPTH`, `SPRITESHEETBLEND`, `CLIPPINGUVS`/`CLIPPINGTARGET` | only `GLSL 1` plus combos (ShaderUnit.cpp:21-51) | puppet objects in ≥ 4 scenes (77 puppet-model objects); the rest 0 active | puppet warp isn't skinned (puppet area owns it); `HDR` blocks affect EMISSIVE only (0) | M-L |
| E22 | `[COMBO]` / sampler `require` | **Observed** WE writes `require` in its own stock shaders (an editor and compile rule) | ignored for combos (ShaderUnit.cpp:442); the sampler-require logic looks inverted (ShaderUnit.cpp:553-590) | 0 (no used annotation has combo+require+default) | none today | S |
| E23 | FBO `format` ignored | **Observed** formats in effect.json: `rgba_backbuffer` (Inferred 16F when HDR), `rgba8888`, `rg88`, `r8` | always GL_RGBA8 (FBOProvider.cpp:9-16, CFBO.cpp:20) | rgba_backbuffer 38, rg88 5, r8 1 | precision loss in HDR scenes only (see E35) | S |
| E24 | FBO `fit` / `width` / `height` / `uvs` ignored | **Observed** keys in stock effects (glitter: 256×256 r8 `uvs:repeat`; cursorripple `fit:512`) | parseFBOs reads name/format/scale/unique only (EffectParser.cpp:99-115); size = image size / scale; wrap taken from the image texture's flags | 2: 3445973124 (glitter), 3184155462 (cursorripple) | glitter tiles stretched (no repeat, wrong size); cursorripple simulates at layer resolution | S |
| E25 | Effect pass `"compose": true` ignored | **Observed** parsed: sets pass flag 0x200000000 and increments a compose counter (GH 0x1402131b0); semantics **Unknown** (old-format two-pass effects without binds) | not parsed (EffectParser.cpp:48-75) | 5: 2511663284, 2672425887, 2890767643 (+1 blurprecise, 3042865984 refraction) | old blurprecise / refraction may sample the wrong input in pass 2 | M (needs RE) |
| E26 | Pass `command:"swap"` | **Observed** `copy`=1, `swap`=2 (GH 0x1402131b0) | copy only (CImage.cpp:674) | 0 (copy in 3: motionblur) | none | S |
| E27 | `_rt_FullFrameBuffer` is the live scene target | **Inferred**: D3D11 cannot sample a bound RT, so WE must copy before sampling | `_rt_FullFrameBuffer` *is* the scene FBO (CWallpaper.cpp:245-249). A last pass that samples it (genericimage3 `BLENDMODE` g_Texture4) while drawing into it is a GL feedback loop (UB) | 28 with `colorBlendMode` > 0: 1864677589, 2371103399, 2883756643; plus COPYBG (1) | blend-mode layers may sample garbage or partly updated texels, which shows as noise or wrong blend colour (driver-dependent) | M: copy the scene FBO into a separate texture before such passes |
| E28 | `colorBlendMode` path | **Observed** an image property (table GH 0x140219c60); how it is applied is **Unknown** | appends an extra `effectpassthrough` (genericimage3) pass with `BLENDMODE=n`; the first pass's blending moves to the last pass (CImage.cpp:758-783) | 28 (values 1, 4, 6, 7, 8, 11, 12, 14, 20-25, 29-31) | blend result not verified; needs a WE capture | — |
| E29 | `_rt_MipMappedFrameBuffer` has no mips | **Observed** name + `g_TextureNMipMapInfo` ids | an alias of the full framebuffer, no mips, MipMapInfo not fed (CWallpaper.cpp:249) | 0 active (REFLECTION+NORMALMAP) | none | S |
| E30 | `copybackground:false` ignored | **Observed** image property `copybackground` (GH 0x140219c60); semantics **Unknown** | ignored; a compose layer always samples `_rt_FullFrameBuffer` (materials/util/composelayer.json) | 2: 3414858021, 3432999904 | the layer may show the background where WE shows nothing | S once the semantics are known |
| E31 | Image `clampuvs` ignored | **Observed** image property `clampuvs` (GH 0x140219c60) | wrap comes only from the .tex header flags (CTexture.cpp:177-183) | 9: 2388299037, 3354740764, 3463520581 | UV-shifting effects (waterripple, shake, scroll) bleed the opposite edge in at the borders | S: OR in the clamp flag |
| E32 | Image `nointerpolation` | **Observed** property (GH 0x140219c60) | ignored | 0 | none | S |
| E33 | Which of `_rt_imageLayerComposite_<id>_a/_b` holds the result | **Unknown** | ping-pong parity decides which buffer holds the final image; "TODO: determine when … is used" (CImage.cpp:254-257) | 9 reference it: 2189783622, 2469881470, 3243449890 | a layer that uses another layer as a mask/texture may get an intermediate pass | M |
| E34 | Effects on non-image objects | **Inferred** WE renders them (the editor attaches effects to text) | `parseText` keeps no effects (ObjectParser.cpp:142-160); a group object with effects becomes a placeholder `CObject` | 25 text: 2134765860, 2325974975, 2890767643; 1 group: 3319542538 (lightshafts) | text drawn without its blurprecise/pulse/shift_hue/reflection/shine/godrays | L (text → FBO + effect chain) |
| E35 | `general.hdr` ignored | **Observed** HDR scenes load `hdr_downsample`, `hdr_downsample_bloom`, `hdr_upsample(_cubic)`, `combine_hdr_upsample`/`combine_srgb`; LDR scenes load `downsample_quarter_bloom`, `downsample_eighth_blur_v`, `blur_h_bloom`, `combine_ldr` (GH 0x1401afbf0); HDR params `bloomstrength`/`blend`/`bloomtint`/`scatter` from `bloomhdr*` (GH 0x1401b42b0, keys GH 0x1401c7880) | always the LDR chain with `bloomstrength`/`bloomthreshold` (CScene.cpp:117-165); RGBA8 everywhere; `hdr` and `bloomhdr*` never read (WallpaperParser.cpp:41-53) | 5 hdr=true: 2511663284, 2542468435, 3019192537, 3395587987 (+1); 4 of them bloom | HDR bloom (threshold 1.0, iterative scatter) replaced by LDR bloom with other params; values > 1 clip | L |
| E36 | `bloomtint` ignored | **Observed** set on the LDR chain too (GH 0x1401b42b0); shader `g_BloomTint` default "1 1 1" | not passed to the bloom passes (CScene.cpp:139-153) | 1 non-white (3490034653), 1 user-bound | bloom tinted white instead of warm | S |
| E37 | Bloom params frozen at load | **Observed** GH 0x1401b42b0 re-applies them to the materials | strength and threshold are written as JSON literals into the virtual effect at construction; the bloom object exists only if `bloom` was true at load (CScene.cpp:117-162) | `bloom`/`bloomstrength`/`bloomthreshold` user- or script-bound in 4-5 (e.g. 2 `bloom.script`) | changing the user property or script doesn't change bloom | S |
| E38 | Material `alphatocoverage` | **Observed** blending enum normal 0 / translucent 1 / additive 2 / alphatocoverage 3 (GH 0x140182410, parse GH 0x140182450) | logged and treated as `normal` (MaterialParser.cpp:73-87) | 1: 3354740764 | cutout edges opaque instead of A2C | S: alpha test or blend |
| E39 | Material `alphawriting` | **Observed** key with values default / disabled / enabled (GH 0x140182450) | not parsed. Final pass masks alpha out; every other pass writes alpha (CImage.cpp:926, 948) | 32 have the key, "enabled" only in 1 (3184155462, cursorripple sim) | none visible beyond E4/E5 | S |
| E40 | Non-system `usertextures` | **Inferred**: the name is a project user property of type texture, resolved to the user's file or its default | the name itself is resolved as a texture path and fails, so the slot keeps its fallback (CPass.cpp:756-805) | 3: 2388299037, 3243449890, 3516106265 (usertexture1-24) | user-picked images missing (`$mediaThumbnail` and `$mediaPreviousThumbnail` do work: RenderContext.cpp:16-32) | M |
| E41 | Effect `visible` is evaluated once | **Inferred** live (SceneScript `getEffect().visible`, user properties; GH 0x140219c60 exposes `getEffect`) | invisible effects are not built; visible ones never skip per frame (CImage.cpp:633, 801-803 TODO) | 33 have `visible.user` (10 with condition) | toggling an effect at runtime does nothing | M: build all, skip per frame |
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
| P2 | Child systems (`children`) | **Observed**: child types `static`, `eventfollow`, `eventspawn`, `eventdeath` (strings in parser, asm 0x1401feff4). Event children are spawned per particle event. Each has a `probability` roll and a `maxcount` cap, and the child is cloned and prewarmed. Followers detach when their parent particle dies (GH 0x14025c2e0 lines handling types 2/4, GH 0x1402507e0). Fields read: `type, flags, controlpointstartindex, origin, angles, scale, probability, maxcount`. | Parsed into `ParticleChild` (`OP.cpp:437-444, 832-882`). Nothing in `CP.cpp` reads `children`. | **29** (static 18, eventfollow 13, eventspawn 7, eventdeath 0), e.g. 1195626192, 1556245028, 2288455459 | Whole sub-effects are missing: splashes, sparks, trails following particles, secondary glows. | L: a child CParticle per entry; static = always on, follow/spawn/death fed by parent particle events |
| P3 | `instanceoverride.rate` meaning | **Observed**: `rate` (override+0xdc) is clamped to ≥0.01 and multiplies **the whole system's dt** (`dt *= rate`, GH 0x140255d00, ev_6c14a78d…). It is a playback-speed scale for motion, ageing and emission together. No parser binding uses offset 0xdc. | Multiplies only the emitter's `rate`, and only once at creation (`CP.cpp:371, 523`). Particle motion, lifetime and oscillation run at 1×. | **36** have rate≠1 (35 of them with motion operators), e.g. 1556245028, 1884904087, 2064316482 | Slowed systems (rate<1) move too fast but emit sparsely. Sped-up ones look the opposite. | S: scale dt by max(rate, 0.01) in `render()` |
| P4 | `instanceoverride.count` meaning | **Observed**: `count` (0xd0) is bound to every emitter's `rate` and `maxtoemitperperiod` (parser asm 0x1401f3efc/0x1401f3f37/0x1401f462e/0x1401f4b44), and to the `count` of mapsequence*. **Inferred**: no binding scales `maxcount` (none found; the pool stays at maxcount). | Multiplies the **pool size** `maxcount·count` (`CP.cpp:59-64`). Emission rate is unchanged. | **43** have count≠1, e.g. 1726902114, 1797172968, 1884904087 | count>1: WE spawns more particles, LWE shows the same density. count<1: LWE truncates the pool, so particles die early or bursts are clipped. | S: multiply emitter rate (and maxtoemitperperiod) by count; keep the pool at maxcount |
| P5 | `colorn` tint math | **Observed**: the parser computes a *reference* colour for each system (mid-point of colorrandom min/max ÷255, or the colorchange start value; GH 0x1401f2210, writes `colorn`/`hascolor`). Tint applies only if override colorn differs from the reference by >0.0035 (GH 0x140251f70). It is then an **HSV shift**: colorrandom/hsv/colorlist ranges are converted to HSV and offset by (override − reference) in H, S and V (GH 0x1401ff240 cases 0xb/0xc/0xd). | RGB **multiply** of every particle by colorn, both at spawn and in colorrandom (`CP.cpp:494, 643, 712-721`). | **43** set colorn: 41 ≠ reference (HSV shift in WE), 2 = reference but non-white (3419466417, 3490034653: WE untouched, LWE tints red) | Wrong hues: coloured particles get darkened or multiplied instead of hue-rotated. | M: port the reference-colour plus HSV-offset path |
| P6 | colorrandom distribution | **Observed**: one random `t` (pow'd by `exponent`) is shared by R, G and B: `c = min + t·(max−min)` (GH 0x140260d80 case 3). | Independent random per channel (`CP.cpp:712-721`, `Maths.cpp randomVec3`). | **58** have colorrandom with ≥2 differing channels, e.g. 1155728109, 1174926427, 1195626192 | Particles take off-palette colours (e.g. a red→blue range also yields green-free magentas and darks). Overall palette is noisier and greyer. | S: single t for all channels |
| P7 | Initializer `exponent` ignored | **Observed**: lifetimerandom, sizerandom, colorrandom, alpharandom, velocityrandom (per axis), rotationrandom and angularvelocityrandom all read `exponent` (parser string list) and apply `pow(rand, exponent)` (GH 0x140260d80 cases 1/2/3/6/7). | Only sizerandom and angularvelocityrandom read it (`OP.cpp:645-684`). | alpharandom 12, lifetimerandom 7, velocityrandom 5, rotationrandom 2, colorrandom 1 (e.g. 1195626192, 2064316482, 2288455459) | Distribution skew is lost: more bright/long-lived/fast particles than intended. | S |
| P8 | Sprite-sheet frame blending | **Observed**: the `SPRITESHEETBLEND` combo is 1 unless flags bit1 is set or `animationmode`=randomframe (GH 0x1401fffb0). `SPRITESHEETBLENDNPOT` is set when the texture is padded. The frag shader cross-fades the current and next frame (`genericparticle.frag:81-88`). | Never sets SPRITESHEETBLEND/NPOT (`CP.cpp:1651-1660`). Frames step. | **33** use a sheet texture with blending on (40 use sheets), e.g. 1155728109, 1195626192, 1556245028 | Flicker/stepping on fire, smoke and sparkle sheets instead of smooth animation. | S: set the combos with the WE rule |
| P9 | `animationmode` sequence timing | **Observed**: only `randomframe` is recognised (template+0x30, asm 0x1401f33a7). Anything else is "sequence", and `once` does not exist. The frame is `floor(frac(lifetimeValue)·frames)` in the shader. **Unknown**: how the CPU derives lifetimeValue (life fraction × sequencemultiplier vs texture fps). | Sequence uses the texture's frame **duration** × sequencemultiplier when the sheet has durations (`CP.cpp:294-301`). An extra `once` mode exists. | 14 explicit sequence plus 47 default (whenever a sheet exists) | Possibly wrong animation speed. | S once settled (needs the owner) |
| P10 | `instanceoverride.controlpointN` / `controlpointangleN` | **Observed**: the table has controlpoint0-7 (vec3, +0xf0+12i) and controlpointangle0-7 (+0x150+12i). They overwrite the CP offset or rotation unless the CP is mouse-locked or the value is the FLT_MAX sentinel (GH 0x140273180, GH 0x140251f70). | Not in `ParticleInstanceOverride` (`Obj.h:542-552`). Ignored. | **8** (cp1 6, cp2 5, cp7 3, cp3/4 2, cp6 1; 2 scripted), e.g. 2679248947, 2951169110, 3042492564 | Attractors, vortices and rope endpoints sit at the JSON default instead of where the author put them. Scripted CPs are static. | S |
| P11 | `instanceoverride.brightness` | **Observed**: multiplies the initial particle colour (and colorn) when the scene is HDR (scene flag 0x2000) and the system lacks template flag 8 (GH 0x1401ff240 head). | Not parsed. `getBrightness` returns the material `overbright` (`CP.cpp:325`); the shader doesn't read `g_Brightness`. | 2 (2511663284, 3509243656; both hdr) | HDR glow particles too dim. | S |
| P12 | `instanceoverride.color` (legacy) | **Observed**: if present, `colorn = color/255` is rewritten into the JSON (GH 0x140251200). `color` is not itself a table field. | Read as an RGB 0-1 vector and returned from `getColor()` (`CP.cpp:331-345`), which feeds `g_Color` (unused by the particle shader). The value is not converted to colorn. | 1 (1556245028) | Tint lost (colorn stays 1). | S |
| P13 | `instanceoverride.alpha` applied live | **Observed**: alpha (+0xc8) is written to the system's global alpha (+0x3ec) on every override update and copied into each particle's alpha at spawn (GH 0x1401ff240, GH 0x140260d80 init). Changes re-run the patcher (dirty flag, GH 0x140255d00). | Multiplied into alpha only at spawn (`CP.cpp:495, 644, 746-753`). `g_Alpha` is set but not used by the shader. | 40 with alpha≠1; dynamic or user-bound in 5 (1864677589, 2371103399, 3233141951…) | Fades or user changes lag by up to one particle lifetime. **Inferred**: a static alpha looks the same. | S |
| P14 | Overrides frozen at creation | **Observed**: override changes set a dirty flag that re-patches all bound values (GH 0x140255d00 → GH 0x140251f70 → GH 0x1401ff240). | Emitter rate, lifetime and pool size are captured at construction (`CP.cpp:59-64, 371, 523-524`). | user-bound or dynamic: count 9+3, size 14+3, rate 2+5, speed 6+1, lifetime 2 (e.g. 2469881470, 2932157836, 3042492564) | User-property sliders for count, rate and lifetime do nothing until reload. | S |
| P15 | Speed override targets | **Observed**: `speed` (0xd4) is bound to emitter speedmin/max, velocityrandom, inheritcontrolpointvelocity, turbulentvelocityrandom, angularvelocityrandom, mapsequence speeds, movement **gravity**, angularmovement force, oscillateposition, controlpointattract scale, turbulence speed and vortex speeds. **Not** to rotationrandom, and not to drag (parser bindings listed in Notes). | Also multiplies the initial **rotation** angle (`CP.cpp:780-789`). It scales angular velocity both at init and again in angularmovement (`CP.cpp:1056-1072`). | 16 have rotationrandom and speed≠1 (33 have speed≠1), e.g. 1797172968, 1884904087, 2064316482 | Wrong initial sprite rotations and doubled spin. | S |
| P16 | Emitter `duration`/`delay`/periodic on sphererandom | **Observed**: a shared emitter base for all emitter types (GH 0x1401ef590): rate, duration, delay, instantaneous, flags, min/max periodic duration/delay, maxtoemitperperiod. The runtime (GH 0x14025cfe0) honours them for every type. | Only boxrandom has delay, duration and periodic (`CP.cpp:370-440`). sphererandom ignores them (`CP.cpp:522-560`). | sphere duration 3 (3445973124, 3479521040, 3490034653) | One-shot sphere emitters never stop, so effects keep spraying. | S: share the box timer code |
| P17 | `maxtoemitperperiod` | **Observed**: caps emission per periodic window, scaled by count (GH 0x1401ef590, GH 0x14025cfe0). | Not parsed (`OP.cpp:610-636`). | 0 (not in library) | none | S |
| P18 | `instantaneous` with periodic emission | **Observed**: the instantaneous burst is reloaded at the start of every periodic "on" window and on every reset (GH 0x14025cfe0 +0x44←+0x48; GH 0x140254f50). | Fires once per system lifetime (box `CP.cpp:441-446`). In sphere it *replaces* that frame's rate emission (`CP.cpp:559-562`). | instantaneous 9 (periodic+instantaneous: 0) | Mostly none. Sphere loses one frame of rate emission. | S |
| P19 | Visibility toggle resets the system | **Observed**: when the object is invisible, emitters are reset (duration, delay and burst reloaded) and all particles and child instances are cleared (GH 0x140255d00 → GH 0x140254f50, GH 0x140255430). On re-show it starts fresh. | `render()` returns early, freezing the simulation with live particles (`CP.cpp:172-175`). After re-show, dt is capped at 0.1. | **37** have user-bound `visible` on particle objects (+2 scripted), e.g. 1884904087, 1934084447, 2371103399 | Toggling an effect shows frozen stale particles, and one-shot bursts don't replay. | S |
| P20 | Audio-responsive emitters | **Observed**: if `audioprocessingmode`≠0, emitter rate is multiplied by an audio level (GH 0x14025cfe0 via GH 0x140250d80). Bands are clamped 0-15 and default bounds are "0.8 1.0" (GH 0x1401ef740). | `TODO` (`CP.cpp:439`). Always full rate. | 2 (1556245028, 3289734539) | Constant emission instead of music-driven pulses. Silence still emits. | M: needs the audio spectrum (see audio section) |
| P21 | Audio on operators (turbulence/vortex) | **Observed**: the audio block is parsed for turbulence, vortex and vortex_v2 (asm 0x1401fb3e9/0x1401fb9cf/0x1401fbf85). | turbulence: TODO. vortex: **skipped entirely** when audio mode>0 (`CP.cpp:1324-1327`). | 0 in operators (1 turbulentvelocityrandom has bounds only) | none in library | M |
| P22 | boxrandom `speedmin/speedmax` | **Observed**: read for boxrandom and bound to speed (asm 0x1401f4290-0x1401f4716). **Unknown**: velocity direction. | Parsed but unused by the box emitter (`CP.cpp:370-520`). | 5 (2511663284, 3276522107, 3414858021…) | Box-emitted particles start at rest. | S once the direction is known |
| P23 | Emitter types `layerimage` | **Observed**: a third emitter type exists (speedmin/max, offsetmin/max, rate; emits from an image layer's pixels) (asm 0x1401f476d). | "Unknown emitter type", dropped (`CP.cpp:360`). | 0 | none | M |
| P24 | sphererandom `cone`, `sign`, distance as scalar | **Observed**: `distancemin/max` are read as **floats** for sphere and as vec3 for box. `cone` is converted (GH 0x140104cf0) and stored. `sign` is sphere only. | `cone` is parsed but unused. Distance is a vec3 and only `.x` is used (`CP.cpp:581-583`). | cone 0. Sign 17 (implemented). | none known | S |
| P25 | Unimplemented initializers | **Observed** (parser strings): `hsvcolorrandom`, `colorlist`, `inheritcontrolpointvelocity`, `positionoffsetrandom`, `mapsequencebetweencontrolpoints`, `remapinitialvalue`, `inheritinitialvaluefromevent`. | Unknown name → `nullptr` (`OP.cpp:642-693`). | 0 (not in library) | none | M each |
| P26 | Unimplemented operators | **Observed**: `maintaindistancetocontrolpoint`, `maintaindistancebetweencontrolpoints`, `reducemovementnearcontrolpoint`, `boids`, `capvelocity`, `remapvalue`, `inheritvaluefromevent`, `collisionplane/sphere/box/bounds/quad/model`. | Dropped (`OP.cpp:695-776`). | 0 | none | M-L |
| P27 | mapsequencearoundcontrolpoint extras | **Observed**: reads `count, bounds, limitbehavior, mirror, controlpoint, speedmin, speedmax, axis`, with count bound to the count override. | Reads controlpoint, count and speeds only. `bounds`, `limitbehavior`, `mirror` and `axis` are ignored (`OP.cpp:685-690`). | 3 use bounds+limitbehavior (2288455459, 3233141951, 3413117423) | Ring or sequence spacing differs. | S |
| P28 | controlpointattract keys | **Observed**: WE reads `offset, scale, threshold, deletethreshold, flags, controlpoint` (defaults GH 0x1401eb290). `origin` is not read. | Reads `origin` as the offset and halves `threshold` (`OP.cpp:749-752`, `CP.cpp:1463`). `deletethreshold` and `flags` are ignored. **Unknown**: WE force law. | 18. Nonzero `origin` in 1 (2679248947). | Attract radius likely half of WE's. Particles near the cursor are not deleted. | S (verify the threshold) |
| P29 | Sprite renderer `orientation`/`axis` | **Observed**: `orientation` = screen(0) / upright(1) / fixed(2), plus `axis` and `flags` (GH 0x1401efc50). | Not parsed. Always screen-facing (`CP.cpp:1847-1851`). | 1 uses upright/fixed (3174556087, rain splash children) | Splashes face the camera instead of lying flat (moot until P2). | S |
| P30 | Rope/trail shader combos | **Observed**: for rope types WE sets `TRAILSUBDIVISION`=subdivision and `ORIENTATION`, plus `TRAILSCROLLALPHA` (uvscrolling), `TRAILFADEALPHA` (fadealpha) and `TRAILFADESIZE` (fadesize) (GH 0x1401fffb0). | Only THICKFORMAT and TRAILRENDERER, with CPU Catmull-Rom geometry (`CP.cpp:1651-1660, 2098+`). | rope 11, ropetrail 9 (fade/scroll keys: 0) | **Unknown**: possibly a different ribbon shape or UV. | M |
| P31 | colorchange semantics | **Observed**: WE uses colorchange `startvalue` as the system's reference colour (GH 0x1401f2210), which hints at absolute colours. **Unknown**: runtime math (operator interpreter not decompiled). | Multiplies the initial colour by lerp(start, end) (`CP.cpp:1199-1228`). | 4 (2679885269, 3022080536, 3233141951…) | Possibly wrong colours. | S once known |
| P32 | sizechange × size override | **Observed**: sizechange start/end values are themselves bound to the size override (asm 0x1401f97d8; gated by template flag 0x80). **Unknown**: whether runtime size is absolute or relative. | Relative multiplier of the initial size, which already includes the size override (`CP.cpp:1138-1165`). | 32 sizechange; 51 size≠1 | **Unknown**: size could be off by a factor of the size override. | S once known |
| P33 | Operator math unverified | **Unknown**: movement drag form, turbulence noise and scale, vortex, oscillate*, alphafade curve (defaults 0.5/0.5 match, GH 0x1401ea170). The interpreter GH 0x140265800 is not decompiled. | Hand-tuned heuristics: turbulence ×2 scale, one phase/speed per operator (`CP.cpp:1240-1300`); turbulentvelocityrandom position×0.1 and cone clamp (`CP.cpp:820-900`); oscillate phase range +2π (`CP.cpp:1523`). | turbulence 21, turbulentvelocityrandom 30, oscillate* 27/24/5, vortex 7 | Motion differs in unknown ways. | L: asm-level RE of GH 0x140265800 |
| P34 | Control-point flags | **Observed**: per-CP flags mask 0x10005 (bits 0, 2, 16) gates override application. bit0 = follow mouse (GH 0x140251f70). CPs also have `parentcontrolpoint` and `angles`. | bit0 = mouse and bit1 = "world space" (`CP.cpp:146-165`). `parentcontrolpoint` and `angles` are ignored. A `locktopointer` key is parsed and unused (`OP.cpp:828`). | bit0 24, bit1 3 (3042492564, 3163060610, 3479521040) | **Unknown** for bit1 scenes. | S |
| P35 | Mouse CP vs object transform | **Inferred**: WE stores CP matrices (stride 0xd0) and transforms them with the object. | Mouse CP = screen px − origin, ignoring object `scale` and `angles`, but rendered through the scaled and rotated model matrix (`CP.cpp:235-255, 1828-1841`). | 24 mouse-CP scenes. scale≠1 in 59 and angles≠0 in 54 particle scenes overall. | Cursor-follow effects offset or rotated away from the cursor when the system is scaled or rotated. | S: inverse model matrix |
| P36 | Parented particle systems | **Unknown** for particles specifically (parenting is generic in WE). | `updateMatrices` uses only the object's own origin, angles and scale (`CP.cpp:1828-1841`). | 13 (3042492564, 3163060610, 3174556087…) | Effects don't follow the moving or animated parent. | M (shared with the hierarchy section) |
| P37 | Frame-time handling | **Observed**: no dt clamp seen in GH 0x140255e50 or GH 0x14025c2e0. When the scene FPS setting is 1-20, each frame is simulated as two half steps (GH 0x14025c2e0 tail). | dt capped at 0.1 s (`CP.cpp:197`). No substeps. | all 78 | At <10 fps (or on hitches) LWE sim time runs slower than wall time. | S |
| P38 | Random source | **Observed**: one scene-level RNG (`*scene+0x1f08`, GH 0x140223090). | `std::random_device` per system (`CP.cpp:31`). randomframe uses the particle *address* as seed (`CP.cpp:283-287`). | 21 randomframe | randomframe frames repeat per pool slot (patterned). | S |
| P39 | Particle-level `flags` | **Observed**: only the low 8 bits are kept (`movzx`, asm 0x1401f3379). bit1 or randomframe disables sheet blend. Bit 0x4 sets template+4=0x80. 0x10/0x20/0x40/0x80 opt out of speed/count/lifetime/size override binding. | Uses only bit2 (perspective: 3D spawn shell, separate projection) (`CP.cpp:578, 904, 1883`). | bit0 16, bit1 11, bit2 36 | **Unknown** for bit0 (WE meaning not identified). | S |
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
| S4 | Property scripts outside the registered set are never queued | **Documented**: any scriptable property takes a script. `thisObject` is an IEffect for effect props (D-class/IThisPropertyObject). **Observed**: material/particle hooks `setMaterialProperty`, `instanceoverride` and `emitParticles` exist in wallpaper64.exe. | **Observed**: only `registerProperty` queues scripts. Nothing registers `effects[].passes[].constantshadervalues.*`, `effects[].visible`, `instanceoverride.*`, `maxwidth`, `animationlayers[].rate/visible`, `brightness`, `.general.bloom*` or sound `volume`. Group and model objects are plain `CObject` (Ren/Wallpapers/CScene.cpp:250). | 30 (effect uniforms 21, effect visible 6, instanceoverride 10, maxwidth 7, group objects 9; e.g. 2134765860, 3219908811) | Script-driven shader uniforms (11 scenes feed audio into them), effect toggles, particle rate/size/count and text wrap width stay at their JSON value. | M: a `ScriptHost` for effect/material/particle/scene values and for group objects |
| S5 | A missing `update` or a return of `undefined` zeroes the value | **Documented**: when nothing is returned, the property is not modified (D-event/update, D-event/init). | **Observed**: `call()` returns `undefined` when there is no `update`, and `jsToDynamicValue` maps that to Null/0 (Scr/ScriptEngine.cpp:116-118, 544-554). | 22 export no `update` (only init/cursor/media); 8 have an `update` without `return` (e.g. 2325974975, 2469881470) | Once S1 is fixed, these properties still go to 0. | **Done (0020).** Was: S: skip the write on undefined/null |
| S6 | `init(value)` not called for property scripts | **Documented**: `init(value)` is called once after creation, and its return sets the property (D-event/init). | **Observed**: only `update` is ever looked up (Scr/ScriptEngine.cpp:591, 630). | 27 (e.g. 2134765860, 2290002190, 2679248947) | Initial-state capture (e.g. `initialValue = value`) is missing, so `update` misbehaves. | **Done (0020).** Was: S |
| S7 | `thisLayer` is one global set at registration; `thisObject` is missing | **Documented**: `thisLayer` is "the layer the script is loaded on" and `thisObject` is the owning object (reference.html). **Observed**: both are globals in ss64. | **Observed**: `globalThis.thisLayer` is overwritten on each `queueScript` and never restored per call (Scr/ScriptEngine.cpp:584). Every script sees the last-registered object, and `thisObject` is undefined (ReferenceError). | thisLayer 25+, thisObject 18 (e.g. 2134765860, 2388299037) | Once S1 is fixed, scripts move or read the wrong layer, and `thisObject.getAnimation()` throws. | **Done (0020).** Was: S: bind both per module before each call |
| S8 | `scriptProperties` of property scripts bind to the wrong module and lose defaults | **Observed** (bc:1423-1455, 1389-1399): `createScriptProperties()` returns defaults from `addX({value})` (combo: `options[0].value`). `_Internal.updateScriptProperties` overlays only the stored keys. | **Observed**: `finish()` captures `getRunningModule()` during Eval, which is the *previous* script or null, because `m_runningModule` is set later (Scr/ScriptEngine.cpp:587; Scr/ScriptPropertiesObject.cpp:64-84). Keys absent from scene.json read `undefined` (:37-42), and the builder ignores `value` (:57-62). | 27 use it in property scripts. 4 have keys missing from scene.json (3219908811, 3233141951, 3243449890, 3432999904) | Once S1 is fixed, sliders/combos read another layer's values or `undefined`, giving NaN positions/speeds. | **Done (0020).** WE's builder gives the defaults, the stored values of the module being evaluated lie over them, live. Was: S: build a plain JS object per module and overlay the stored values (user-bound live) |
| S9 | A returned Vec3/Vec4 loses z (and w) | **Documented**: the vector return is applied, and numbers broadcast to Vec2/Vec3 (D-event/update). | **Observed**: `zVal`/`wVal` are never read, so the vec3 is written as `(x,y,0)` (Scr/ScriptEngine.cpp:159-174). Numbers broadcast correctly. | color 11, scale 20, origin 25 (latent behind S1) | Once S1 is fixed, scripted colours lose blue and scale z becomes 0. | **Done (0020).** Was: S |
| S10 | No cursor events and no `CursorEvent` | **Documented**: `cursorEnter/Leave/Move/Down/Up/Click(event)` fire per object hit, with `worldPosition`, `localPosition` and `hitBox` (D-class/CursorEvent, reference.html). **Observed**: `cursorHitTest` and `button` in ss64. | **Observed**: nothing in LWE produces cursor events. Grep finds no `cursorClick` outside the corpus, and `m_queuedEvents` only gets media events. | 22 (e.g. 2325974975, 3104056709, 3219908811) | Click and hover interactions (menus, drag widgets, click sounds) do nothing. | M: a hit test against layer bounds plus dispatch, which needs mouse input from the host |
| S11 | Media events never reach scripts | **Documented**: `mediaPlaybackChanged/PropertiesChanged/ThumbnailChanged/TimelineChanged/StatusChanged` (reference.html). | **Observed**: the events are queued only to property "modules", which are Promises (S1) (Scr/ScriptEngine.cpp:610-623). They are never delivered to text-layer IIFEs. liascape never calls `wp_project_notify_*`; the only hits are the headers in include/linux-wallpaperengine/project.h:444-469. | 19 (16 in text scripts: e.g. 2134765860, 3013489778, 3042492564) | "Now playing" title/artist texts stay at the placeholder, and media widgets stay hidden. | M: an MPRIS feed in the host plus dispatch to both paths |
| S12 | `MediaThumbnailEvent` colours are hard-coded and `textColor` is missing | **Documented/Observed**: `primaryColor secondaryColor tertiaryColor textColor highContrastColor hasThumbnail` (ss64; D-class/MediaThumbnailEvent). | **Observed**: fixed greys 0.12/0/0.25/1 and no `textColor` (Scr/ScriptEngine.cpp:666-686). | 10 (e.g. 2890767643, 3042492564, 3243449890) | Album-art tinted UI is grey, and `textColor` is undefined, which leads to a NaN colour. | M: extract a palette from the album art |
| S13 | `MediaPropertiesEvent` fields missing | **Documented**: `title artist contentType albumTitle subTitle albumArtist genres` (D-class/MediaPropertiesEvent). | **Observed**: only `title`, `artist` and `albumTitle` (Scr/ScriptEngine.cpp:653-657). | 3 use the missing fields (3013489778, 3291729669, 3291745179) | The album-artist line is "undefined". | S |
| S14 | `mediaStatusChanged`/`MediaStatusEvent.enabled` never sent | **Observed**: `mediaStatusChanged` and `enabled` in ss64. | **Observed**: no producer. | 1 (2890767643) | The widget never learns that media integration is on. | S |
| S15 | `applyUserProperties` is never called and `engine.userProperties` is missing | **Documented**: it is called once on load and on every change, with the changed props. `engine.userProperties` holds the current values, with colours as Vec3 (D-class/IEngine; bc:1401-1418). | **Observed**: neither exists. EngineObject has no `userProperties` (Scr/EngineObject.cpp:169-221, "TODO: ADD THE REST"), and the text shim `engine` has none either (Scr/ScriptEngine.cpp:376-379). | applyUserProperties 18; engine.userProperties 7 (4 in text scripts: 1884904087, 2325974975, 3042492564, 3163060610) | User options handled in script (12/24h clock, language, colour themes, toggles) are ignored. Text scripts that read `engine.userProperties.x` in `update` throw every frame, so the text never updates. | **Partly done (0020):** `applyUserProperties(<all user properties>)` runs once after `init`. Changes and `engine.userProperties` are still open. Was: S |
| S16 | Other events missing: `resizeScreen`, `applyGeneralSettings`, `destroy`, `animationEvent` | **Observed** in ss64; **Documented** in reference.html. | **Observed**: not dispatched. `destroy` exists only for text layers (Scr/ScriptEngine.cpp:509-542). | resizeScreen 1 (3042492564), animationEvent 1 (3163060610), applyGeneralSettings 0, destroy 0 | Layout on resize and animation-end callbacks are missing. | S |
| S17 | `engine.registerAudioBuffers` missing | **Documented**: it returns AudioBuffers with `left/right/average` Float32Array of length 16/32/64, values about 0..1, index 0 = bass (D-class/AudioBuffers). **Observed**: "Resolution must be either 16, 32 or 64." and "registerAudioBuffers can only be called from global scope." (ss64). | **Observed**: only the `AUDIO_RESOLUTION_*` constants exist (Scr/EngineObject.cpp:190-201), so the top-level call throws TypeError and the module fails. | 20 (11 feed effect uniforms; e.g. 2134765860, 2290002190, 2469881470) | Audio visualisers driven by script (bars, pulsing scale, uniform audio) are static. | M: an FFT bins → Float32Array per frame, the same data as `g_AudioSpectrum16Left…` |
| S18 | `engine.timeOfDay` is always 0 | **Documented**: 0.00..1.00 over 24 h local time (D-class/IEngine). | **Observed**: it returns `Context::daytime`, which is initialised to 0 (src/core/WallpaperEngine/Context.cpp:15) and never written. The text shim lacks it entirely. | 2 (2134765860, 3046119914) | Day/night logic is stuck at midnight. | S: `(h*3600+m*60+s)/86400` from localtime |
| S19 | `engine.canvasSize` and `engine.screenResolution` missing | **Documented**: both are Vec2 (D-class/IEngine). | **Observed**: absent (Scr/EngineObject.cpp:158-222). | canvasSize 14, screenResolution 2 (e.g. 3042492564, 3219908811) | Layout, drag clamping and bounce code throws. | S |
| S20 | `engine.is*()`, `registerAsset`, `isObjectValid` and `clearTimeout` missing | **Documented/Observed**: `isDesktopDevice isMobileDevice isWallpaper isScreensaver isPortrait isLandscape isRunningInEditor registerAsset isObjectValid clearTimeout` (D-class/IEngine; ss64). | **Observed**: absent. | isRunningInEditor 3, isScreensaver 1 (3163060610, 3363252053, 3414858021, 2890767643) | TypeError, so the guarded script aborts. | S: constants true/false |
| S21 | `engine.openUserShortcut` is a stub | **Documented**: opens the bound User Shortcut property, allowed only inside cursor callbacks, and returns a bool (D-class/IEngine). | **Observed**: returns `undefined` and does nothing (Scr/EngineObject.cpp:16-18). | 1 (3516106265) | Click-to-launch does nothing (also blocked by S10). | M: map to xdg-open, only if the owner wants it |
| S22 | Timer bugs | **Documented**: `engine.setTimeout/setInterval(cb, ms)` return a stop function (D-class/IEngine). **Observed**: "setTimeout cannot be called from global scope." (ss64). | **Observed**: the callback is stored without `JS_DupValue` and freed on clear/fire (Scr/EngineObject.cpp:121,151,246,255,267,279,317), which risks use-after-free or a double free. Callback exceptions and return values are dropped (:300,:315). The text shim `engine` has no timers (Scr/ScriptEngine.cpp:376-379). | 14 (3 from text scripts: 2932157836, 3042492564, 3163060610) | Text: `engine.setInterval` throws, so blinking separators and rotating texts break. Property path: possible crash once S1 is fixed. | **Done (0020).** Callbacks are owned and their errors logged; the stop function works; text scripts reach the real timers. Was: S |
| S23 | `input` is mostly stubbed | **Documented**: `cursorWorldPosition` Vec3 in scene units, `cursorScreenPosition` from top-left, `cursorLeftDown` (D-class/IInput). The units of the screen position are **Unknown**. | **Observed**: world position is always (0,0,0) (Scr/InputObject.cpp:9-15). Screen position is normalised 0..1 (:17-28). `cursorLeftDown` is always false (:30-33). | world 7, screen 1, leftDown 0 (e.g. 3104056709, 3243449890, 3326873240) | Cursor-follow and parallax-by-script layers don't move. | S once the host gives cursor positions |
| S24 | `thisScene.getLayer(n)` semantics | **Documented**: `getLayer(name or index)`. Any layer type works (D-class/IScene). | **Observed**: a number is treated as an object **id**, not an index. Only image/text/particle objects are returned, so sound, group and light give undefined (Scr/SceneObject.cpp:136-187). | getLayer 11 (numeric 0) (e.g. 2325974975, 3104056709) | `getLayer('sound').play()` and group handles throw. | **Partly done (0020):** a name it doesn't find is `undefined`, not an exception. Numbers are still ids. Was: S |
| S25 | ILayer writes silently ignored | **Documented**: `origin angles scale visible parallaxDepth` are read/write. Image `alpha/color` and text `text/pointsize…` are writable (D-class/ILayer, D-class/IImageLayer, D-class/ITextLayer). | **Observed**: the exotic `set_property` returns 0 without storing anything (Scr/Adapters/ScriptableObjectAdapter.cpp:50-68). Gets return only registered names, and other names are `undefined` (:23-48). | 28 assign layer props (e.g. 2134765860, 2325974975, 2469881470) | Scripts that move, hide or recolour *other* layers (or `thisLayer` from event handlers) do nothing. | **Partly done (0020):** writing a registered property (origin, scale, angles, visible, alpha, color, …) sets it; `name` reads. Other names are dropped. Was: M: route sets to the DynamicValues plus typed fields |
| S26 | ILayer/IImageLayer methods missing | **Documented**: `getAnimation getParent getChildren setParent getAttachment* getTransformMatrix rotateObjectSpace`, plus `getTextureAnimation getVideoTexture getEffect getEffectCount getAnimationLayer* playSingleAnimation`, bones and blend shapes (D-class/ILayer, D-class/IImageLayer). `size` and `solid` are props. | **Observed**: none are defined. The adapter only exposes property DynamicValues (Scr/Adapters/ScriptableObjectAdapter.cpp:23-48), so calls throw TypeError. | getAnimation 18, size 16, getTextureAnimation 7, getParent/getTransformMatrix 5, getAnimationLayer 3, getVideoTexture 2, getEffect 1 | Sprite-frame control (`setFrame`/`getFrame`, e.g. 2325974975 waits for frame 165), puppet animation layers and timeline animations scripted from code are dead. | L: IAnimation, ITextureAnimation (`frameCount duration rate play stop pause isPlaying getFrame setFrame join`), IAnimationLayer, IEffect/IMaterial |
| S27 | Sound layers not scriptable | **Documented**: `ISoundLayer.volume`, `play()` (only if not playing), `stop()` (rewinds), `pause()`, `isPlaying()` (D-class/ISoundLayer). Spike § Q3: `startsilent` only starts through `play()`. | **Observed**: `CSound` is not a `ScriptableObject` (Ren/Objects/CSound.h:35). `CSound::play()` exists but has no caller (CSound.h:51-55), and `getLayer` can't return sounds (S24). | startsilent + script play 2 (2325974975, 3289734539); sound controlled from script 1 (3432999904) | Click and event sounds never play, and script mute/play toggles do nothing. | S: a sound adapter with `play/stop/pause/isPlaying/volume` |
| S28 | Text-layer props other than `text` are not script-visible | **Documented**: ITextLayer `text color alpha opaquebackground backgroundcolor pointsize font padding horizontalalign verticalalign anchor limitrows maxrows limitwidth maxwidth` (D-class/ITextLayer). | **Observed**: in a text IIFE, `thisLayer={text}` only (Scr/ScriptEngine.cpp:365). Through getLayer, only the registered names are visible, and the key is `pointSize`, not `pointsize` (Ren/Objects/CText.cpp:83). | 6 (horizontalalign/verticalalign 5, pointsize 1: 2134765860) | Auto-shrinking song titles and alignment switches have no effect. | S |
| S29 | Text-script shims shadow the real `engine`/`thisScene` | **Inferred**: WE gives every script the same globals (reference.html). | **Observed**: the IIFE-local `engine={frametime,time}` and `thisScene={time,currentTime,dt,fps}` hide the real objects (Scr/ScriptEngine.cpp:366-379). `engine.runtime`, `userProperties`, `setInterval`, `setTimeout`, `registerAudioBuffers`, `timeOfDay`, `canvasSize` and `thisScene.getLayer` all throw. | 8 (userProperties 4, setInterval 3, runtime 1, getLayer 1, setTimeout 1: 3042492564, 3163060610, 3509243656, 2325974975) | Clock and lyric texts with options or timers freeze on the placeholder or the last value. | **Partly done (0020):** `thisScene`/`engine` in text scripts are the real objects behind the text clock fields; `thisLayer` is still `{text}`. Was: S: drop the shims and pass the real globals plus a per-layer `thisLayer` |
| S30 | Text-script lifecycle differences | **Documented**: `init` runs once after creation, with `(value)` for property-attached scripts (D-event/init). **Inferred**: updates run while the layer is hidden. | **Observed**: `init()` is called with no argument on the first *visible* render. `update` is skipped while `visible` is false (Ren/Objects/CText.cpp:377-394). `'use strict'` is stripped, so the IIFE is sloppy mode (Scr/ScriptEngine.cpp:344-352). The same text is also evaluated a second time as a module via `registerProperty("text")` (Ren/Objects/CText.cpp:84), so top-level code runs twice. | init(value) 2 (2932157836, 3042492564); all 41 text scenes get the double eval | Small: top-level side effects (`shared.*`) run twice. | **Partly done (0020):** the text script no longer runs a second time as a property script. `init()` without `value` and the hidden-layer skip remain. Was: S |
| S31 | Text-script `scriptproperties` are snapshotted at creation | **Observed**: WE overlays stored values on every update (`_Internal.updateScriptProperties`, bc:1389-1399) and re-applies on user-property change (Inferred). | **Observed**: `createLayerScript` copies the values once (Scr/ScriptEngine.cpp:328-336). | 21 have user-bound text scriptproperties (e.g. 2134765860, 2511663284) | Changing a bound user property (24h, colour, format) in the UI doesn't reach the text until reload. | S |
| S32 | `addCombo` default | **Observed**: the default is `options[0].value` (bc:1443-1447). | **Observed**: the text shim uses `o.value`, which is undefined for combos (Scr/ScriptEngine.cpp:384). | 1 has a combo absent from scene.json (3163060610); 19 use addCombo | Rarely visible: the combo reads `undefined`. | S |
| S33 | `Vec2/3/4` constructor semantics | **Observed** (bc:238-261): `new Vec3(x,y,z)`; `new Vec3()` = 0; `new Vec3(n)` = (n,n,n); `new Vec3("x y z")`; `new Vec3(vec2)` with z=0; missing args become 0. | **Observed**: only `argv[0]` is used and broadcast, so `new Vec3(1,2,3)` = (1,1,1) (Scr/Adapters/VectorAdapter.cpp:372-392, 89-104). `new VecN()` throws (:373-375). String/Vec2 arguments throw a C++ `std::runtime_error` through a C callback, which risks terminate (:146). | multi-arg 20, no-arg 4 (e.g. 2469881470, 2932157836) | Once S1 is fixed, every computed vector is wrong, giving diagonal motion and grey colours. | **Done (0020).** WE's `baseclasses.js`, loaded from the user's assets. Was: S: replace with WE's own `baseclasses.js` (JS classes) |
| S34 | Vec instance methods unreachable | **Observed**: Vec2/3/4 are JS classes with about 30 methods each, including `reflect`, `distance`, `negate`, `clamp`, `mix`, `angle`, `rotate` and `toSpherical` (bc:4-785). Mat3/Mat4 too (bc:786-1363). | **Observed**: the exotic `get_property` returns `JS_EXCEPTION` for every name except x/y/z/w (Scr/Adapters/VectorAdapter.cpp:160-193), and quickjs-ng consults it before the prototype (QJS/quickjs.c:8737-8745). So `v.add()`, `.copy()`, `.length()` and `toString` all throw. `lengthSqr` is bound to `length` (:856-857). `reflect` and the others don't exist, and there is no Mat3/Mat4. | 26 call vector methods (e.g. 2469881470, 2679248947, 3219908811); reflect 6; Mat 0 | Any vector math aborts the script. | **Done (0020).** Was: S: load `scripts/jsclasses/baseclasses.js` from WE assets, as WE does (ss64 names it) |
| S35 | `WEVector` module missing | **Observed**: `jsmodules/wevector.js` exports `angleVector2` and `vectorAngle2` (weassets). ss64 loads `scripts/jsmodules/`. | **Observed**: only `WEMath` and `WEColor` are native modules (Scr/ScriptEngine.cpp:211-215), so `import … from 'WEVector'` fails module resolution. | 3 (3219908811, 3233141951, 3243449890) | The whole script fails to load. | **Done (0020).** `scripts/jsmodules/<name>.js` from the user's assets. Was: S: load the `.js` modules from the WE assets |
| S36 | `localStorage` semantics | **Documented**: `get/set/delete/clear(key, location)`, `LOCATION_GLOBAL` (`"global"`) and `LOCATION_SCREEN` (`"screen"`, the default). It persists across sessions, up to 100 KB per wallpaper, and is cleared on Reset (D-class/ILocalStorage). **Observed**: the persistent `LSKV0001` store in ss64. | **Observed**: an in-memory JS object, lost on every load. `set` stores `String(value)`, so numbers come back as strings and objects as "[object Object]". It has a non-WE `remove`, no `delete`, and no `LOCATION_*` (Scr/resources/builtins.js:2-11). | 8 (e.g. 3163060610, 3243449890, 3319542538) | Saved positions and settings reset on every start, and `get()+1` string-concatenates. | S: persist JSON per project/screen under the state dir |
| S37 | `thisScene` methods and setters | **Documented**: `getLayerCount enumerateLayers createLayer destroyLayer sortLayer getLayerIndex getInitialLayerConfig get/setCameraTransforms createModelData`. All properties are writable (D-class/IScene). | **Observed**: only `getLayer` exists (Scr/SceneObject.cpp:303-307). Setters return `JS_EXCEPTION` with no pending exception (:190). Getter bugs: `clearenabled` returns bloom (:34-38), `skylightcolor` returns ambient (:56-62), and `bloomstrength`/`bloomthreshold` are truncated to int (:22-32). | sortLayer 5, getLayerIndex 5, createLayer 4, enumerateLayers 1 (e.g. 2469881470, 2828233985, 2890767643) | Layer reordering and spawned layers (cursor trails, particles) are missing. | M (createLayer: L) |
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
