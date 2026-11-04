# Wallpaper Engine coverage: what WE supports vs what our LWE fork implements

## Context

- Status: audit 2026-11-04 on fork pin `42f301d` (patches 0001–0062); the SceneScript part implemented the same day
  (fork patches 0065–0070 on pin `deeb4da`, after the shader agent's 0063–0064; see "Implemented"). This is the
  **master gap list**: the B1–B14 audit (`we-lwe-gap-audit.md`) went batch by batch from what the library visibly
  lost; this one goes item by item through what WE *supports*, so a gap is closed before a scene hits it.
- Sources:
  - **SceneScript:** WE's official type definitions `lib.sceneScript.d.ts` ("OFFICIAL SCENESCRIPT TYPE DECLARATION -
    VERSION 2.8", linked from https://docs.wallpaperengine.io/en/scene/scenescript/reference.html) and the 46
    reference sub-pages (classes, events, modules). The d.ts is the complete list: every class, member and event below
    comes from it. WE's own `assets/scripts/jsclasses/baseclasses.js` (Vec2/3/4, Mat3, Mat4, `_Internal`,
    `createScriptProperties`) and `jsmodules/*.js` (WEMath, WEColor, WEVector), which the fork evaluates as the prelude
    (B1), were diffed against the d.ts.
  - **WE's parsers:** `wallpaper64.exe` 2.8.485 strings (`exe_strings.txt`) and the Ghidra full decompile `all.c`
    (both from the B-batch audit; `GH 0x…` = function address). WE's script binding registration sits in
    `scenescript64.dll` (V8), whose strings the audit already read; nothing in them names an API the d.ts lacks.
  - **Usage:** the owner's 96 scenes in Workshop folder 431960 (every `scene.json`, `models/`, `materials/`, `effects/`,
    `particles/` file, pkgs unpacked; 1466 scripts in 50 scenes) and WE's stock `assets/` (presets, effects,
    materials, particles: 11 scripts). Counts are **scenes** for the library and **files** for the stock assets.
  - **Ours:** the fork's parsers (`Data/Parsers/*`) and renderers, by the string literals they read, then by hand for
    every gap row.
- Scratch (not in the repo): `cov/` in the session scratchpad — `docs/` (the d.ts and pages), `tools/` (extractors:
  `allkeys.py`, `classify.py`, `api_usage.py`, `texscan.py`), `keys_class.tsv`, `api_usage.tsv`, `ptypes_class.tsv`.
- Sizes as in the gap audit: **S** under a day, **M** a few days, **L** a week or more (a fork patch with a test).
- Status: **impl** implemented, **partial** some of it or not WE-exact, **missing**, **n/a** editor-only / not
  applicable on Linux (with the reason).

## Summary

| Area | Items | Before (42f301d): impl / partial / missing / n/a | 0065–0070 (deeb4da) | Now (0071 F1, 0072–0077) |
|---|---|---|---|---|
| SceneScript: every member, event, module export and global of the d.ts | 453 | 329 / 3 / 120 / 1 | 421 / 14 / 17 / 1 | **424 / 12 / 16 / 1** |
| Scene and object keys the library uses | 162 | 137 / 3 / 16 / 6 | 137 / 3 / 16 / 6 | **138 / 3 / 15 / 6** (F1: castshadow) |
| Effect keys the library uses | 41 | 25 / 0 / 2 / 14 | 25 / 0 / 2 / 14 | **27 / 0 / 0 / 14** |
| Material keys the library uses | 13 | 12 / 0 / 1 / 0 | 12 / 0 / 1 / 0 | **13 / 0 / 0 / 0** |
| Model keys the library uses | 19 | 16 / 1 / 1 / 1 | 16 / 1 / 1 / 1 | 16 / 1 / 1 / 1 |
| Particle keys the library uses | 100 | 97 / 0 / 3 / 0 | 97 / 0 / 3 / 0 | **98 / 2 / 0 / 0** |
| Particle emitter / initializer / operator / renderer types (library + stock) | 48 | 28 / 0 / 20 / 0 | 28 / 0 / 20 / 0 | 28 / 0 / 20 / 0 (all 28 the library uses are impl) |
| Material blend modes | 4 | 3 / 0 / 1 / 0 | 4 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |
| .tex formats | 14 | 14 / 0 / 0 / 0 | 14 / 0 / 0 / 0 | 14 / 0 / 0 / 0 (+ TEX<n>FORMAT per bound texture, 0075) |
| .tex flags (known + seen) | 9 | 6 / 0 / 3 / 0 | 6 / 0 / 3 / 0 | 6 / 0 / 3 / 0 |
| FBO formats | 13 | 12 / 1 / 0 / 0 | 12 / 1 / 0 / 0 | 12 / 1 / 0 / 0 |
| Object types | 12 | 9 / 2 / 1 / 0 | 9 / 2 / 1 / 0 | **10 / 1 / 1 / 0** (F1: lights) |
| Effect pass options | 7 | 6 / 0 / 1 / 0 | 6 / 0 / 1 / 0 | **7 / 0 / 0 / 0** |

The SceneScript count is every member of every class/interface in the d.ts, the 17 events, the 3 modules' exports
and the globals (`tools/sstatus.py` holds the per-item status). Vec2/3/4/Mat3/Mat4 (175 members) are WE's own JS, so
they count as implemented whenever WE's assets are found (the core falls back to a minimal Vec2/3/4 without them).
Key counts are the distinct key paths the library uses (`classify.py`; the wrappers `value`/`user`/`script`/
`animation` folded into their property; a key whose literal LWE builds, like `controlpoint` + n, checked by hand).
Keys didn't change in this batch: it was the SceneScript surface and one blend mode.

**What still costs the library something** (scenes): SceneScript — `IModelLayer` animation (0), CursorEvent
`hitBox` (0 readers; the hit boxes' MDL layout isn't decoded); keys — sound `queuemode` is not a sound key (WE
ignores it too, sound spike), text background box (`opaquebackground` true in 0 scenes), `perspectiveoverridefov`
(42 scenes, unknown use, G20), camera-object `path` (11, G17); render features listed under "Future batches".
`resizeScreen`, MDLA `animationEvent`s, sprite `orientation` and the F9 keys were done in 0072–0077 (below).

## 1. SceneScript (d.ts 2.8)

Library = scenes whose scripts use the name (a common name like `play` is counted for every interface that has it,
so those counts are upper bounds, marked ~). Stock = WE asset files.

### Events (IComponent)

| Event | Lib | Stock | Before | Now | Notes |
|---|---|---|---|---|---|
| init (value) | 27 | 1 | impl | impl | B1 |
| update (value) | 49 | 1 | impl | impl | B1 |
| destroy () | 0 | 0 | partial (text layers) | impl | before the scene goes, and for a layer `destroyLayer` takes |
| resizeScreen (size) | 1 | 0 | missing | **impl** | 0072+: the host's output size (`wp_project_hint_size`, the worker's `max_size`) is the screen; a change after the first frame sends it (WE: never on creation, d.ts) — 3042492564 recomputes its scale there |
| applyUserProperties (changed) | 18 | 0 | impl | impl | B10 |
| applyGeneralSettings (changed) | 0 | 0 | missing | impl | `{ language }` from LC_ALL/LC_MESSAGES/LANG (`en-us`, `zh-chs` …), once on load |
| cursorEnter/Leave/Move/Down/Up/Click (event) | 11–16 | 0 | impl | impl | B10 (text/particle layers not hit-tested) |
| mediaStatus/Playback/Properties/Thumbnail/TimelineChanged | 1–17 | 0 | impl | impl | B10 |
| animationEvent (event, value) | 1 | 0 | missing | **impl** | keyframe timelines' `options.events` (3163060610) fire; puppet animations' MDLA events too (0072+: to the layer's scripts as the clock passes them; **Inferred**: the event's u32 is its frame, the delivery) |

### Classes and interfaces

| Class | Members (d.ts) | Lib use | Before | Now | Left |
|---|---|---|---|---|---|
| Vec2 / Vec3 / Vec4 | 36 / 39 / 34 methods + x y z w | 28 (vector math in 26) | impl (WE's JS) | impl | — (bc-only: `toConfigString`) |
| Mat3 / Mat4 | 25 / 31 | Mat4.m 5 | impl (WE's JS) | impl | — (WE's Mat3 also has right/up/forward) |
| CameraTransforms {eye center up zoom} | 4 | 0 | missing | impl | `thisScene.getCameraTransforms` builds one |
| AnimationEvent {name frame} | 2 | 1 | missing | impl | |
| CursorEvent {worldPosition localPosition hitBox} | 3 | 15 | partial | partial | `hitBox` (a puppet's hit box name) missing: the hit boxes' MDL layout isn't decoded (scenescript64.dll names `hitBox`, wallpaper64 has no string for them; not MDLE/MDMP, likely the unread rest of MDLS); 0 library scripts read it |
| MediaProperties/Thumbnail/Playback/Timeline/StatusEvent | 7/6/4/2/1 | 1–16 | impl | impl | B10 |
| WEMath / WEVector / WEColor | 4 / 2 / 4 | 16 / 3 / 2 | impl (WE's JS) | impl | |
| AudioBuffers {left right average} | 3 | 21 | impl | impl | B8 |
| IObject.getAnimation | 1 | 18 | impl (layers) | impl | on IEffect/IMaterial a stub (undefined) |
| IEffect | getMaterial, getMaterialCount, setMaterialProperty, executeMaterialFunction, visible, name | 16 (visible) | partial (stubs) | partial | `setMaterialProperty` sets the effect's shader constant of that name, live (a name the scene doesn't set is not added); `getMaterial` gives a stub IMaterial; `executeMaterialFunction` is undocumented: no-op |
| ITextureAnimation | 10 | ~22 | impl | impl | B10 |
| IVideoTexture | 10 | 2 | missing | impl | play/pause/stop/isPlaying/get-setCurrentTime/duration/rate/loop/addEndedCallback on the layer's mpv player |
| IAnimationLayer | 14 | 3 | missing | impl | puppet layers; scripts on a layer's rate/visible/blend run with it as thisObject |
| ISoundLayer | 5 | ~22 | impl | impl | B10 |
| IEffectLayer | getEffect, getEffectCount, transformAttachmentToTexture, size, perspective, solid | 16 (size) | partial | partial | `transformAttachmentToTexture` (Mat3 attachment → texture space; S once its convention is decoded) and `perspective` (G21/E43, the flag itself isn't parsed) missing |
| ITextLayer | 15 | 7 | partial | partial | font, anchor, padding, limitrows, limitwidth, opaquebackground now read; writes to those (and `backgroundcolor`) are kept on the layer but don't re-lay the text (S) |
| IParticleSystemInstance | 15 | 0–16 | missing | impl | the instanceoverride values, live (controlpoint0..7 made from the control point when the scene sets none) |
| IParticleSystem | play pause stop isPlaying emitParticles instance | ~22 | missing (sound only) | impl | |
| IImageLayer | 25 | 7 | partial | partial | alignment, getVideoTexture, animation layers, bones now; `applyBonePhysicsImpulse`/`resetBonePhysicsSimulation` and blend shapes are no-ops (LWE has no bone physics, no blend shapes) |
| IModelLayer | perspective, rootmotion, animation layers | 0 | missing | partial | LWE's models are static meshes: 0 animation layers; rootmotion/perspective missing (with skinned models, L) |
| ICamera {fov zoom} | 2 | 0 | missing | impl | a camera object's zoom/fov are layer properties (scriptable) |
| IModelData / createModelData | 7 | 0 | missing | **missing** | stubs return undefined: building meshes from script data is a render feature (L) |
| ILayer | origin angles scale parallaxDepth name visible + 13 methods | 22 / 5 (getTransformMatrix) | partial | impl | getTransformMatrix, rotateObjectSpace, lookAt, lookAtYaw (the layer's −z towards the target: **inferred**), setParent (adjustTransforms, attachment), getAttachment*; getParent is undefined unparented (was null) |
| IScene | 15 methods + 19 properties | 11 (getLayer), 4 (createLayer) | partial | impl | createLayer/destroyLayer, getLayerByID, getInitialLayerConfig, get/setCameraTransforms, getAnimation now; createModelData/destroyModelData stubs |
| IConsole | log, error | 14 | impl | impl | + warn/info/debug |
| IRenderContext | (empty) | 0 | missing | impl | `renderContext = {}` |
| IInput | cursorWorldPosition, cursorScreenPosition, cursorLeftDown | 7 | impl | impl | cursorScreenPosition in screen pixels (d.ts "on the screen in pixels"; 3509243656 centres it with screenResolution / 2; it was 0..1): the scene covering the host's screen, y down (**Inferred**) |
| ILocalStorage | 6 | 10 | impl | impl | B10 |
| IEngine | 21 | 23 | impl | impl | `openUserShortcut` false (decided), `registerAsset` a `{file}` handle (createLayer takes it); `screenResolution` the host's screen (was the scene's size) |
| IAnimation | 11 | 18 | partial (no rate) | impl | `rate` read/write; `fps` exact |
| shared | 1 | — | impl | impl | |

**Engine compatibility, not in the d.ts:** V8's legacy `RegExp.$1…$9`, `lastMatch`, `leftContext`… are now provided
(quickjs leaves them out; 2932157836's clock formats with them). Script properties a scene stores as strings stay
strings (WE converts only for vector defaults; 3477054430, 3509243656 split an `addText` value).

**Binary vs docs.** `scenescript64.dll`'s strings (B10) name nothing the d.ts lacks; the d.ts names `hitBox`,
`transformAttachmentToTexture`, `createModelData` and the IModelData constants, which the dll strings don't show
(they may be built at run time). `wallpaper64.exe` carries the layer-side field names (`emitParticles`, `instance`,
`setMaterialProperty`, `executeMaterialFunction`, `getTextureAnimation`, `setFrame`, `frameCount`): all covered.

### Library scripts that fail in WE too (content, not ours)

Left in the health report on purpose; each throws in WE's V8 the same way:

- 3432999904 sound `volume`: the script declares `export function update` twice (a module SyntaxError in V8).
- 3219908811 / 3243449890 `部件` / `Media Info` `visible`: `value.x = …` on a boolean (strict mode TypeError).
- 3326873240 `myLayer`: `scene.getLayer` (no global `scene`).
- 3042492564 `Music Title (on cover)`: `event` used in `applyUserProperties`, which has no event.
- 3163060610 `封面`: `engine.AUDIO_RESOtime_switchingION_16` (a find-and-replace accident) → WE's own RangeError.
- 2890767643 `playerplay`: expects `.mp3` sound layers and a `playeroutlineanim` layer the scene doesn't have.

## 2. Scene, object, effect, material, particle keys

Full per-key tables: `keys_class.tsv` (category, key path, library scenes, stock files, value types, read by LWE, in
WE's exe strings). The rows below are every key the **library** uses that LWE doesn't read, plus the stock-only ones
worth a row. Row ids in brackets are the gap audit's.

### Scene and object keys

| Key | Lib | Stock | Status | Notes / size |
|---|---|---|---|---|
| `version` (scene, effect) | 80 | 87 | n/a | format version; WE reads it, nothing to apply |
| objects.`locktransforms`, `muteineditor` | 61, 55 | 18, 0 | n/a | editor-only |
| objects.`castshadow` | 44 | 19 | impl (F1) | always false in the library; models and point/spot lights cast into the shadow atlas (fork patch 0071) |
| objects.`backgroundcolor` / `opaquebackground` / `backgroundbrightness` (text box) | 43 / 43 / 40 | 3 | missing | `opaquebackground` is false in all 278 uses; S when one is true |
| general.`perspectiveoverridefov` | 42 | 77 | missing | [G20] use unknown (default 95); with `perspective` layers |
| objects.`ledsource` | 34 | 11 | n/a | RGB-device lighting (iCUE/Chroma) |
| general.`gravity*` / `wind*` | 27 | 69 | missing | [P40] no particle reader in WE; likely puppet/cloth physics (future) |
| objects.`perspective` (images) | 37 (true in 4) | 14 | missing | [E43/G21] M |
| objects.`depthtest` (images) | 29 | 0 | missing | [E43] 2D layers draw in order anyway; matters with `perspective` |
| objects.`disablepropagation` | 12 | 0 | missing | always false in the library |
| objects.`queuemode` (camera objects) | 11 | 0 | missing | [G17] camera path order; `path` lists are empty in the library |
| objects.`path` (camera objects) | 11 | 0 | missing | [G17] all `[]` |
| objects.`instanceoverride.controlpoint1..7` | 6 | 34 | impl | (literal built from the index: the classifier misses it) |
| objects.`particlesrc` | 3 | 21 | n/a | editor source reference |
| objects.`effects.username` | 1 | 2 | n/a | editor label |
| objects.`density`, `volumetricsexponent` (VolumeLight) | 1 | 1 | missing | with the `shape` object (below) |
| general.`lightconfig` | 1 | 2 | missing | 2.8.485 reads only `directional` (≤ 3) and `directionalshadow`; 3477054430's `{"spot": 4}` is an older form. LWE counts the directional lights itself (F1) |
| general.`camerapreview`, `hdr`, `fov`, `farz`, `zoom`, objects.`fov`/`zoom` | — | — | impl | (not in the exe's narrow strings: wide strings) |

### Material / effect / model keys

| Key | Lib | Stock | Status | Notes / size |
|---|---|---|---|---|
| material pass `alphawriting` | 31 | 59 | **impl** | [E39] default 0 / enabled 1 / disabled 2 (GH 0x140186aa0); enabled/disabled set the pass's alpha write (**Inferred**: the colour mask); "enabled" in 1 (3184155462) |
| model `cropoffset` | 32 | 0 | n/a | editor crop tool (not in the exe) |
| model `instanced` | 13 | 0 | partial | [G34] instance textures merged, combos dropped (they only carry `version`) |
| effect `replacementkey`, `gizmos.*`, `performance`, `editable`, `preview`, `group` | 35–78 | 2–143 | n/a | editor metadata |
| effect `fbos.fit`, `fbos.uvs` (+ `width`, `height`) | 1 | 1–2 | **impl** | GH 0x1402131b0 / 0x140216080: width/height replace the layer's, fit caps the longer side (aspect kept), then ÷ scale; `uvs: repeat` wraps (**Inferred**) |
| material pass `usershadervalues`, `usertextures.keepaspect`, `culling` | 0 | 1 | missing | stock only; S each |
| model `projectlayer` | 0 | 1 | missing | stock only |

### Particles

All 28 emitter/initializer/operator/renderer types the library uses are implemented (B3/B11). Stock-only types
missing (`ptypes_class.tsv`; stock files in brackets): emitter `layerimage` (1); initializers `mapsequencebetweencontrolpoints`
(12), `hsvcolorrandom` (5), `positionoffsetrandom` (5), `remapinitialvalue` (3), `colorlist`,
`inheritcontrolpointvelocity`, `inheritinitialvaluefromevent` (1 each); operators `remapvalue` (9), `boids`,
`maintaindistancebetweencontrolpoints`, `reducemovementnearcontrolpoint`, `vortex_v2` (5 each),
`maintaindistancetocontrolpoint`, `capvelocity` (3 each), the five `collision*` (1 each), `inheritvaluefromevent`
(1). Each is S–M once WE's operator code is read (the interpreter GH 0x140265800 needs asm work, gap audit).

Particle keys the library uses that LWE didn't read, now done: sprite renderer `orientation` + `axis` + `flags` (5
scenes; screen / upright / fixed, [P29]: GH 0x1401efc50 parses, GH 0x14024fd30 builds g_Orientation* — implemented
as WE does it); mapsequence `limitbehavior` + `bounds` (3, [P27]): the library uses exactly WE's defaults (bounds
"0 1", limitbehavior "repeat", axis "0 0 1", GH 0x1401e8c90), which is what LWE does; other values are reported to
the health report (their runtime is in the operator interpreter, not read). Stock-only: `controlpoint.parentcontrolpoint`
(24 files), the remap / boids / collision operators' keys above.

## 3. Blend modes, texture formats and flags, FBO formats, object types, pass options

| Item | Values | Lib | Stock | Before | Now |
|---|---|---|---|---|---|
| material `blending` | normal / translucent / additive | 82 / 96 / 66 | most | impl | impl; `additive` now also sets the ADDITIVE combo (generic4, foliage4, fur4, chroma4 read it) |
| | alphatocoverage | 1 (3354740764) | 0 | missing ("as normal") | impl: unblended + ALPHATOCOVERAGE combo (the stock shaders discard below 0.5 on GLSL), GH 0x140183570 |
| image `colorBlendMode` | 1–31 | 67 | 31 | impl (B7) | impl |
| .tex format | ARGB8888 0, RGB888, RGB565, DXT5 4, DXT3 6, DXT1 7, RG88 8, R8 9, RG1616f, R16f, BC7, RGBa1010102, RGBA16f, RGB16f | 0: 94, 4: 24, 6: 3, 7: 11, 8: 38, 9: 52 | 0, 4, 8, 9 | impl | impl |
| .tex container | TEXB0001–0004, FreeImage JPEG/PNG/raw, mp4 | 0002–0004 | 0001–0004 | impl | impl |
| .tex flags | 1 nointerp, 2 clampuvs, 4 gif, 8 clamp border, 32 video, 0x80000 alpha priority | 1: 10, 2: 96, 4: 22, 32: 13 | 1, 2, 4, 0x80000 | impl | impl |
| | 64 (bit 6), 0x200000 (bit 21), 0x800000 (bit 23) | 0, 1, 2 | 28, 0, 0 | missing | missing: meaning not decoded (parsed, ignored) |
| FBO `format` | rgba_backbuffer, rgba8888, rgb888, rg88, r8, rgb565, rgba16161616f, rgb161616f, rg1616f, r16f, rgba1010102 | 41 / 9 / – / 5 / 1 | 7 / 81 / … | impl | impl |
| | normalmap | 0 | 2 | partial (as rgba8888) | partial |
| object type | image, compose (passthrough), fullscreen, solidlayer, text, particle, sound, camera, group, model (static MDL) | 96 / 11 / … / 45 / 78 / 55 / 11 / 16 / 2 | | impl | impl |
| | light `lpoint` / `lspot` / `ltube` / `ldirectional` | 0 / 1 / 0 / 0 | 2 / 0 / 0 / 0 | impl (F1: shadows, spot cookies, tubes, directional; no directional cascades, no clusters) | impl |
| | `shape` (VolumeLight) | 1 (3319542538) | 3 | missing | missing (L: volumetrics) |
| effect pass | material, target, bind, compose, source, command copy (3) | 5–82 | | impl | impl |
| | command `swap` | 0 | 2 | missing (refused) | **impl**: WE's command 2 (GH 0x1402131b0); the two FBOs exchange their storage, swaps after the last draw run after it (**Inferred** from the stock fluid simulation's ping-pong) |

## Implemented (fork patches 0065–0070, 2026-11-04)

- **0065 script: the layer transform API, createLayer and destroyLayer.** `getTransformMatrix` (5 scenes),
  rotateObjectSpace, lookAt, lookAtYaw, setParent, getAttachment*; IImageLayer.alignment (3); ITextLayer reads;
  createLayer from a path, an IAssetHandle or a configuration (WE's `_Internal.stringifyConfig`), destroyLayer
  (3 scenes' visualiser bars + WE's clock preset), getLayerByID; the draw loop walks a copy (a text script may
  create/destroy/sort layers while it renders).
- **0066 script: stored script-property strings stay strings; V8's RegExp.$1.**
- **0067 material: alphatocoverage and additive set their combos.**
- **0068 script: video textures, puppet animation layers, particle systems, the other events.** IVideoTexture (2),
  IAnimationLayer + bones (3), IParticleSystem(+Instance), IEffect.setMaterialProperty/getMaterial,
  applyGeneralSettings, animationEvent, destroy; the scene's clear colour every frame (mpv left black behind: every
  scene with a video texture cleared black).
- **0069 script: IScene's camera, initial configs and timelines; ICamera.** Plus IAnimation.rate (0070).

Tests (host_api_test, each RED on 42f301d): `layer_transform_api`, `create_layer_builds_layers`,
`script_strings_and_regexp`, `video_texture_api`, `animation_layer_api`, `particle_system_api`,
`script_events_reach_scripts`, `blending_sets_combos`, `scene_camera_and_config_api`.

Health (`scene-health.md`, 96 scenes) before → after, on pin `deeb4da` (which also carries the shader agent's
0063–0064): 75 → 86 clean, 21 → 10 degraded, 0 failed; script errors 38 → 11 (all 11 fail in WE too: § 1), layers
dropped 3 → 0, effects dropped 57 → 0 (the shader patches, not this batch), no scene worse. By eye (smoke 1 s/3 s):
3243449890 now draws its triangle clock and the character; 3219908811 its cherry-blossom background and ring;
3516174947, 3516106265 and 2890767643 unchanged apart from animation. One run timed out 3432876246 once (exit
124); five reruns alone took 4–5 s, so a one-off.

## Implemented: F1 shadows and light cookies (fork patch 0071, 2026-11-04)

- **0071 render: shadows, light cookies, tube and directional lights.**
  - Lights read `castshadow`, `usecookie`, `cookie` (default `cookie/flashlight1`), `controlpoint` (a tube's far
    end) and `lightsourcesize`; `ltube` and `ldirectional` are lights now. Models read `castshadow`.
  - The shadow atlas is a depth texture (2 x 2 until a light casts a shadow, then one 256 px tile per light). It was
    a scene-sized RGBA8 target that nothing drew: every scene saves about 8 MB of VRAM at 1080p.
  - The casters (the stock shadowcaster, shadowcasterfoliage4 and shadowcasterfur4) draw into each viewport, a spot's
    one or a point light's six cube faces.
  - PerformLighting_V1 samples the shadows and the spot cookies and adds the tube and directional lights.
  - Decoded addresses, and what's inferred, are in the audit's "F1 result".
- **No library scene uses it.** 3477054430's four spots have castshadow false. The check is a synthetic scene.
- **Tests** (host_api_test; each RED on `deeb4da`): `shadow_casters_compile`, `shadow_occludes_a_lit_point`,
  `cookie_projects_its_texture`, `tube_and_directional_lights`.
- **Shader sweep:** 47 → 16 failures, 0 new. The 10 caster checks left are SKINNING / MORPHING combos, which no static
  mesh sets (F4).
- **Left:** the directional cascades, WE's light clusters, 2.8.485's PCSS, the `shadows` quality setting,
  `lightconfig`.

## Implemented (fork patches 0072–0077, 2026-11-04: the small gaps F7–F9)

Each decoded from the same wallpaper64.exe 2.8.485 with `all.c` (`GH 0x…`) and the d.ts; what isn't is marked
**Inferred**.
- **0072 particle: sprite orientation.** GH 0x1401efc50 parses `orientation` (screen 0 / upright 1 / fixed 2),
  `axis` (default "0 0 0" = y, normalised; a fixed quad's in-plane up b = axis × normalize (y × axis), (0 0 −1) when
  the axis is ±y) and `flags` (asUInt, bit 0). GH 0x14024fd30 builds g_OrientationForward/Right/Up each frame: in the
  world, screen F = −view forward, U = the view's up (bit 0) or the system's y, made ⟂ F; upright U = world y (bit 0)
  or the system's axis, R = view forward × U, F = R × U; fixed F = axis, U = b, as given (bit 0) or the system's;
  then F and U go into the system's space by the transpose of its model matrix's 3×3, normalised, R = U × F. LWE
  always drew the system's own axes; a child copied its parent's. LWE's particle space is WE's with y flipped: R and
  F cross with Fy, U with −Fy, so every mode is LWE's old identity for an unrotated system. Ropes and trails keep the
  identity (their parsers weren't read). 3174556087's rain splashes (upright and fixed, flags 1, in turned, squashed
  systems) now follow WE's axes. mapsequencearoundcontrolpoint: WE's defaults (GH 0x1401e8c90) are what LWE does and
  all the library uses; other values are reported.
- **0073 material: alphawriting** (GH 0x140186aa0: default 0, enabled 1, disabled 2): the pass writes alpha or
  doesn't, whatever the layer decided; **Inferred**: the colour-mask effect.
- **0074 effect: FBO fit / width / height / uvs, and swap.** GH 0x1402131b0 reads `fit`, `width`, `height` (uint16,
  ≤ 4096), `unique`, `clear`, `uvs` ("repeat" → flag 4) and the pass command (copy 1, swap 2); GH 0x140216080 sizes
  the FBO: width/height for the layer's size, fit caps the longer side keeping the aspect (the other truncated),
  then ÷ scale. `swap` exchanges two FBOs' storage in place; swaps after the last draw run after it. **Inferred**:
  `uvs` repeat = wrap sampling, swap's runtime (from the stock fluid simulation's ping-pong).
- **0075 shader: TEX<n>FORMAT per bound texture.** GH 0x1401d2a20 defines "TEX" + n + "FORMAT" for every slot 0..9
  whose sampler has `formatcombo`, to the bound (or default) texture's format: a bind, the effect's and the pass's
  (user) textures, the default, in setupTextureUniforms' order; a JPEG/PNG .tex is 0 (RGBA8). TEX0FORMAT stays LWE's
  (RG88/R8 of the layer's texture). Fixes DXT / RG88 normal maps (DecompressNormal reads TEX1FORMAT) and fur4's
  TEX8FORMAT.
- **0076 script: resizeScreen, screenResolution, cursorScreenPosition.** `wp_project_hint_size` (the worker passes
  `max_size`, before the first frame and on every resize) is the screen: `engine.screenResolution`, `resizeScreen
  (size)` on a change after the first frame (d.ts: never on creation), `input.cursorScreenPosition` in its pixels
  (the scene covering it, y down: **Inferred**).
- **0077 script: puppet MDLA events.** The MDLA event list (u32 + string each: **Inferred** frame, name) fires
  animationEvent (event, value) on the layer's scripts as an animation layer's clock passes a frame (forward, a
  loop's wrap, a mirror's way back; frame 0 on the first step). **Inferred**: the delivery (WE's runtime not traced).

Not done: CursorEvent.hitBox (the hit boxes' MDL layout: not in MDLE/MDMP; likely MDLS's unread rest — an asm read),
ITextLayer writes re-laying the text (0 library writers), IEffectLayer.transformAttachmentToTexture.

Tests (host_api_test, each RED on deeb4da): `sprite_orientation_as_we`, `alphawriting_masks_alpha`,
`effect_fbo_fit_and_swap`, `texture_format_combos_per_slot`, `resize_screen_reaches_scripts`,
`puppet_animation_events`.

## Future batches (render features, not done here)

| Batch | What | Library | Size |
|---|---|---|---|
| ~~F1 Shadows and light cookies~~ **done** (0071, below) | `castshadow`, the shadow atlas, spot cookies, tube and directional lights; left: directional cascades, clusters, `lightconfig` | 0 (3477054430's spots don't cast) | L |
| F2 Volumetric lights | `shape` objects (VolumeLight), `density`, `volumetricsexponent` | 1 (3319542538) | L |
| F3 Bone physics + blend shapes | `applyBonePhysicsImpulse`, gravity/wind (`general.gravity*`/`wind*`, 27 scenes set them), blend-shape weights | 0 scripted; physics data unknown | L |
| F4 Skinned / animated 3D models | IModelLayer animation layers, `rootmotion`, `createModelData` (script meshes) | 0–2 | L |
| F5 World-space perspective layers | image `perspective`/`depthtest`, `perspectiveoverridefov` (G20/G21/E43) | 4 (+42 with the fov key) | M |
| F6 Stock-only particle operators | the 20 types above (boids, collisions, remap, mapsequencebetweencontrolpoints …) | 0 (stock presets) | M (after the operator asm read) |
| F7 Puppet hit boxes + MDLA events | CursorEvent.hitBox (left: layout not decoded); puppet animationEvent **done (0077)** | 0 known | S–M |
| F8 Resize events | `resizeScreen` when the output size changes — **done (0076)** | 1 | S |
| F9 Small parser keys | **done (0072–0075)**: `alphawriting`, `fbos.fit/uvs`, sprite `orientation`, mapsequence bounds (defaults), `command: swap`; left: texture flags 64/2²¹/2²³ (meaning not decoded) | 31 / 1 / 5 / 3 / 0 / 3 | S each |
