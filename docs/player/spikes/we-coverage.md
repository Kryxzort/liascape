# Wallpaper Engine coverage: what WE supports vs what our LWE fork implements

## Context

- Status: audit 2026-11-04 on fork pin `06cd48b` (patches 0001–0062); the SceneScript part implemented the same day
  (fork patches 0065–0070 on pin `cbe4445`, after the shader agent's 0063–0064; see "Implemented"). This is the
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

| Area | Items | Before (06cd48b): impl / partial / missing / n/a | 0065–0070 (cbe4445) | 0071 F1, 0072–0077 | Now (0082–0085: F5, F6) |
|---|---|---|---|---|---|
| SceneScript: every member, event, module export and global of the d.ts | 453 | 329 / 3 / 120 / 1 | 421 / 14 / 17 / 1 | **424 / 12 / 16 / 1** | **425 / 11 / 16 / 1** (IEffectLayer.perspective) |
| Scene and object keys the library uses | 162 | 137 / 3 / 16 / 6 | 137 / 3 / 16 / 6 | **138 / 3 / 15 / 6** (F1: castshadow) | **140 / 4 / 12 / 6** (perspectiveoverridefov, perspective; camera `path`/`queuemode` partial: their files are empty) |
| Effect keys the library uses | 41 | 25 / 0 / 2 / 14 | 25 / 0 / 2 / 14 | **27 / 0 / 0 / 14** | 27 / 0 / 0 / 14 |
| Material keys the library uses | 13 | 12 / 0 / 1 / 0 | 12 / 0 / 1 / 0 | **13 / 0 / 0 / 0** | 13 / 0 / 0 / 0 |
| Model keys the library uses | 19 | 16 / 1 / 1 / 1 | 16 / 1 / 1 / 1 | 16 / 1 / 1 / 1 | 16 / 1 / 1 / 1 |
| Particle keys the library uses | 100 | 97 / 0 / 3 / 0 | 97 / 0 / 3 / 0 | **98 / 2 / 0 / 0** | 98 / 2 / 0 / 0 (system flags bit 2, perspective, now drawn as WE); **99 / 1 / 0 / 0** after the leftovers (0092: system flags bit 0, world space) |
| Particle emitter / initializer / operator / renderer types (library + stock) | 48 | 28 / 0 / 20 / 0 | 28 / 0 / 20 / 0 | 28 / 0 / 20 / 0 (all 28 the library uses are impl) | **32 / 16 / 1 / 0** of 49: the stock-only list below is 21 types, not 20 (F6: capvelocity, maintaindistancebetweencontrolpoints, reducemovementnearcontrolpoint as WE and collisionbox a no-op as in WE; 15 with inferred parts, vortex_v2 still LWE's own model; layerimage missing) |
| Material blend modes | 4 | 3 / 0 / 1 / 0 | 4 / 0 / 0 / 0 | 4 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |
| .tex formats | 14 | 14 / 0 / 0 / 0 | 14 / 0 / 0 / 0 | 14 / 0 / 0 / 0 (+ TEX<n>FORMAT per bound texture, 0075) | 14 / 0 / 0 / 0 (+ TEX<n>FORMAT per bound texture, 0075) |
| .tex flags (known + seen) | 9 | 6 / 0 / 3 / 0 | 6 / 0 / 3 / 0 | 6 / 0 / 3 / 0 | 6 / 0 / 3 / 0 |
| FBO formats | 13 | 12 / 1 / 0 / 0 | 12 / 1 / 0 / 0 | 12 / 1 / 0 / 0 | 12 / 1 / 0 / 0 |
| Object types | 12 | 9 / 2 / 1 / 0 | 9 / 2 / 1 / 0 | **10 / 1 / 1 / 0** (F1: lights) | 10 / 1 / 1 / 0 (F1: lights) |
| Effect pass options | 7 | 6 / 0 / 1 / 0 | 6 / 0 / 1 / 0 | **7 / 0 / 0 / 0** | 7 / 0 / 0 / 0 |

The SceneScript count is every member of every class/interface in the d.ts, the 17 events, the 3 modules' exports
and the globals (`tools/sstatus.py` holds the per-item status). Vec2/3/4/Mat3/Mat4 (175 members) are WE's own JS, so
they count as implemented whenever WE's assets are found (the core falls back to a minimal Vec2/3/4 without them).
Key counts are the distinct key paths the library uses (`classify.py`; the wrappers `value`/`user`/`script`/
`animation` folded into their property; a key whose literal LWE builds, like `controlpoint` + n, checked by hand).
Keys didn't change in this batch: it was the SceneScript surface and one blend mode.

**What still costs the library something** (scenes): SceneScript — `IModelLayer` animation (0), CursorEvent
`hitBox` (0 readers; the hit boxes' MDL layout isn't decoded); keys — sound `queuemode` is not a sound key (WE
ignores it too, sound spike), text background box (`opaquebackground` true in 0 scenes); render features listed
under "Future batches". `perspectiveoverridefov` and `perspective` were done in F5 (0082: the perspective camera of
an orthographic scene, which 35 scenes' perspective particle systems also draw with), camera paths in 0083.
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
| IImageLayer | 25 | 7 | partial | partial | alignment, getVideoTexture, animation layers, bones, blend shapes (`getBlendShapeIndex/Weight`, `setBlendShapeWeight`: F3, 0079) now; `applyBonePhysicsImpulse`/`resetBonePhysicsSimulation` are no-ops (LWE has no bone physics; no library bone enables it); puppet IK chains follow their targets (F2, 0087) |
| IModelLayer | perspective, rootmotion, animation layers | 0 | missing | partial | a model's scene `animationlayers` pose its skeleton (F4, 0080) and a model layer is a script layer; the IModelLayer animation-layer methods, `rootmotion` and `perspective` are missing |
| ICamera {fov zoom} | 2 | 0 | missing | impl | a camera object's zoom/fov are layer properties (scriptable) |
| IModelData / createModelData | 7 | 0 | missing | impl | createModelData, applyData, replaceData, the format constants, createLayer ({ model }), destroyModelData (F4, 0081); COLOR is read past, the bounding box ignored |
| ILayer | origin angles scale parallaxDepth name visible + 13 methods | 22 / 5 (getTransformMatrix) | partial | impl | getTransformMatrix, rotateObjectSpace, lookAt, lookAtYaw (the layer's −z towards the target: **inferred**), setParent (adjustTransforms, attachment), getAttachment*; getParent is undefined unparented (was null) |
| IScene | 15 methods + 19 properties | 11 (getLayer), 4 (createLayer) | partial | impl | createLayer/destroyLayer, getLayerByID, getInitialLayerConfig, get/setCameraTransforms, getAnimation now; createModelData/destroyModelData (F4) |
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
| general.`perspectiveoverridefov` | 42 | 77 | impl (F5, 0082) | [G20] an orthographic scene's effective fov (+0x144, default 95, GH 0x1401b8af0): the perspective camera of GH 0x1401b4fd0 that `perspective` layers and perspective particles draw with |
| objects.`ledsource` | 34 | 11 | n/a | RGB-device lighting (iCUE/Chroma) |
| general.`gravity*` / `wind*` | 27 | 69 | missing | [P40] no particle reader in WE; likely puppet/cloth physics (future) |
| objects.`perspective` (images, text) | 37 (true in 4) | 14 | impl (F5, 0082) | [E43/G21] flag 0x80 at +0x120: the layer's x/y angles and z through that camera; the 4 library layers are at z 0, unturned (drawn as before). Parents' x/y angles not followed (inferred) |
| objects.`depthtest` (text) | 29 | 0 | missing | [E43] only on text objects (248, all "enabled", all in 2D scenes); WE registers it at +0x5a0 of the text table (GH 0x14027e130). Nothing in a 2D scene writes depth, so it can't change a library scene; not ported |
| objects.`disablepropagation` | 12 | 0 | missing | always false in the library |
| objects.`queuemode` (camera objects) | 11 | 0 | partial | [G17] the camera object's path order (random 9, sequential 2); its `path` files are all `{"paths": []}`. The scene's `camera.paths` play in order (0083); a camera object's own path isn't read (empty everywhere) |
| objects.`path` (camera objects) | 11 | 0 | partial | [G17] a camera paths file each, all `{"paths": []}` (the format: GH 0x1401c6ef0, done for `camera.paths` in 0083) |
| objects.`instanceoverride.controlpoint1..7` | 6 | 34 | impl | (literal built from the index: the classifier misses it) |
| objects.`particlesrc` | 3 | 21 | n/a | editor source reference |
| objects.`effects.username` | 1 | 2 | n/a | editor label |
| objects.`density`, `volumetricsexponent` (VolumeLight) | 1 | 1 | impl | light keys, not a VolumeLight's: with `castvolumetrics` and `volumetricsscattering` (GH 0x140283df0) they drive the volumetrics pass (F2, 0088). 3477054430's four spots carry the editor's defaults, castvolumetrics off |
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

All 28 emitter/initializer/operator/renderer types the library uses are implemented (B3/B11). **F6 (0084–0085) ported the
stock-only ones** below except the `layerimage` emitter (the audit's "F5/F6 result": per type, WE's form or inferred;
collisionbox is a no-op in WE 2.8.485 too). Stock-only types (`ptypes_class.tsv`; stock files in brackets): emitter
`layerimage` (1); initializers `mapsequencebetweencontrolpoints`
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
| | `shape` (VolumeLight) | 1 (3319542538) | 3 | missing | **impl** (F2, 0086): not a light — WE's shape class (vtable 0x1404d36e8): a square of the scene's height whose corners are its first effect's point0..3, its last effect drawn into the scene with DIRECTDRAW, additively |
| | light `castvolumetrics` | 0 | 0 | missing | **impl** (F2, 0088): point and spot volumes marched with WE's volumetrics shaders (no SHADOW / COOKIE / fog in the march, no directional) |
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

Tests (host_api_test, each RED on 06cd48b): `layer_transform_api`, `create_layer_builds_layers`,
`script_strings_and_regexp`, `video_texture_api`, `animation_layer_api`, `particle_system_api`,
`script_events_reach_scripts`, `blending_sets_combos`, `scene_camera_and_config_api`.

Health (`scene-health.md`, 96 scenes) before → after, on pin `cbe4445` (which also carries the shader agent's
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
- **Tests** (host_api_test; each RED on `cbe4445`): `shadow_casters_compile`, `shadow_occludes_a_lit_point`,
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

Tests (host_api_test, each RED on cbe4445): `sprite_orientation_as_we`, `alphawriting_masks_alpha`,
`effect_fbo_fit_and_swap`, `texture_format_combos_per_slot`, `resize_screen_reaches_scripts`,
`puppet_animation_events`.

Health (pin `bdafdde`, with F1): 86 clean / 10 degraded / 0 failed, every scene's class, loss, errors, warnings and
built objects the same as on `cbe4445` and on F1's `d338e97`. Shader sweep: 4085 checks, 16 failing (F1's), 0 newly
failing (47 → 47 on these patches alone). host_api_test 95/95; player tests 739 passed, 1 timing failure
(`mpv_source_teardown_never_skips_bus_cycles`, passed alone).

## Implemented: F3 blend shapes and bone alpha, F4 skinned models and createModelData (fork patches 0078–0081, 2026-11-04)

Decoded from wallpaper64.exe 2.8.485 (`all.c`: the MDL loader GH 0x1402873f0, the puppet combos GH 0x140230ec0) and
the stock shaders (genericimage4, generic4, the casters, `base/model_vertex_v1.h`; 2.8.485's `base/morph_vertex_v1.h`);
what isn't is marked **Inferred**. The full write-up is the audit's "F3/F4 result".
- **0078 shader: the casters' SKINNING / MORPHING compile.** BONECOUNT ≥ 1 with SKINNING (WE sets it to the bone count,
  GH 0x140230ec0); g_Texture<n>Texel declared when a unit reads it undeclared (engine uniforms, GH 0x140002a20 ids
  0x49–0x52; value (1 / w, 1 / h, w, h): **Inferred**); fur4's `ApplyMorphPosition (gl_VertexID, …)` converts its int.
  Shader sweep: the 10 caster checks pass.
- **0079 render: puppet blend shapes and bone alpha.** MDMP0001 (per mesh: targets, an f32 scale, N points; per
  target snorm16 xyz deltas, by mesh flags normals 0x400, alphas 0x1000, a bone rule 0x2000), a vertex's point = its
  vec4 position's w − 1; MDLA v4 weight tracks and v3 bone alpha tracks; morph before skin, vertex alpha as
  genericimage4's v_VertexAlpha (through its VERTEXCOLOR: LWE's puppets are CPU-posed). get/setBlendShapeWeight,
  getBlendShapeIndex. **Inferred**: the layers' blend of weights and alphas, a script weight holding. Library:
  3490034653's 人物1 blink ("眨眼": 25 eyelid points, up to 4.5 layer px).
- **0080 render: skinned and morphed 3D models.** A model's `animationlayers` pose its MDLS skeleton (the puppet's
  clock and mixing); generic4's SKINNING (g_Bones mat4x3, a_BlendIndices / a_BlendWeights, BONECOUNT) and MORPHING
  (model_vertex_v1.h's float-stream morph map in g_Texture5, the casters' g_Texture1); the casters get the same. No
  library model has a skeleton.
- **0081 script: createModelData.** IModelData (applyData, replaceData, POSITION/NORMAL/TANGENT_SIGNED/UV/COLOR),
  createLayer ({ model }) / createLayer (data), destroyModelData; model layers are scriptable and draw in 2D scenes in
  world pixels (**ours**: z squashed, no depth buffer). 0 library users.

Not done: IK (3042492564's arm: one bone with `"ik":true`), bone physics and applyBonePhysicsImpulse (no library bone
enables it), root motion, MORPHING_MODIFIERS, IModelLayer's animation-layer API, `autosort` / `index` (0 users).

Tests (host_api_test, each RED on bdafdde): `skinned_casters_compile`, `puppet_blend_shapes_and_alpha`,
`model_skins_and_morphs`, `create_model_data_draws`.

## Implemented: F5 perspective layers and F6 the stock particle operators (fork patches 0082–0085, 2026-11-04)

Decoded addresses and what's inferred: the audit's "F5/F6 result".
- **0082 render: perspective layers and particles in orthographic scenes.** `perspectiveoverridefov` is an ortho
  scene's effective fov; GH 0x1401b4fd0's perspective camera (eye at d = (h / 2) / tan (fov / 2), near 5, far max
  (15000, d + 1000)) draws `perspective` image/text layers (with their x/y angles and z) and perspective particle
  systems (flags bit 2: 35 library scenes; LWE drew them from general.fov at an eye at z 1000).
- **0083 render: camera paths, camerafade, the transparent sort's sortorder.** `camera.paths` files (GH 0x1401c6ef0)
  played while no camera object is active (Hermite keys); fade.json's overlay; transparentsorting by `sortorder`,
  then depth along the view (GH 0x1401b6660).
- **0084–0085 particle: the stock presets' operators and initializers** (all but `layerimage`; collisionmodel parsed
  and reported), with remap's vector ranges and the operators' blend-in.

No library scene changes except the perspective particles' size/depth (the four `perspective` layers are at z 0,
unturned; no scene has camera paths). Tests (host_api_test, each RED on `bdafdde`): `perspective_layers_in_2d`,
`camera_paths_and_fade`, `transparent_sort_takes_sortorder`, `particle_stock_motion_operators`,
`particle_stock_collisions`, `particle_stock_initializers`.

## Future batches (render features, not done here)

| Batch | What | Library | Size |
|---|---|---|---|
| ~~F1 Shadows and light cookies~~ **done** (0071, below) | `castshadow`, the shadow atlas, spot cookies, tube and directional lights; left: directional cascades, clusters, `lightconfig` | 0 (3477054430's spots don't cast) | L |
| F2 Volumetric lights | **done (0086, 0088)**: `shape` objects, `castvolumetrics` / `density` / `volumetricsscattering` / `volumetricsexponent`; left: SHADOW / COOKIE / fog volumetrics, directional, the quality setting | 1 (3319542538) | L |
| F3 Bone physics + blend shapes | blend shapes, their weight tracks, bone alpha **done (0079)**; IK **done (0087, solver inferred)**; left: bone physics (0 enabled), `applyBonePhysicsImpulse`, gravity/wind (`general.gravity*`/`wind*`, 27 scenes set them, all wind off), root motion, MORPHING_MODIFIERS | 1 (3490034653's blink), 1 (3042492564's arm) | L |
| F4 Skinned / animated 3D models | skinned / morphed models, the casters' combos, `createModelData` **done (0078, 0080, 0081)**; left: IModelLayer's animation-layer methods, `rootmotion` | 0 | L |
| ~~F5 World-space perspective layers~~ **done (0082–0083)** | `perspectiveoverridefov`, image/text `perspective`, perspective particles in 2D, camera paths + camerafade, `sortorder`; left: text `depthtest`, `customsortorder`'s reader, the 3D zoom / parallax, a camera object's own path | 4 layers + 35 particle scenes | M |
| ~~F6 Stock-only particle operators~~ **done (0084–0085)** | the stock-only types above; left: `layerimage`, collisionmodel, the inferred parts (boids' forces, remap's shapes, the initializers' runtime) | 0 (stock presets) | M |
| F7 Puppet hit boxes + MDLA events | CursorEvent.hitBox (left: layout not decoded); puppet animationEvent **done (0077)** | 0 known | S–M |
| F8 Resize events | `resizeScreen` when the output size changes — **done (0076)** | 1 | S |
| F9 Small parser keys | **done (0072–0075)**: `alphawriting`, `fbos.fit/uvs`, sprite `orientation`, mapsequence bounds (defaults), `command: swap`; left: texture flags 64/2²¹/2²³ (meaning not decoded) | 31 / 1 / 5 / 3 / 0 / 3 | S each |

## Implemented: F2 shape objects and volumetric lights, F3's puppet IK (fork patches 0086–0090, 2026-11-05)

Decoded addresses and what's inferred: the audit's "F2 result".
- **0086 render: shape objects.** What upstream called a VolumeLight is WE's shape class (factory GH 0x1401be650,
  vtable 0x1404d36e8): a square of the scene's orthographic height (GH 0x140285b40), its corners its first effect's
  point0..point3 (GH 0x1402861b0), every pass with DIRECTDRAW 1 (GH 0x140285f40), the last effect's passes drawn
  straight into the scene (GH 0x140285b70), the last pass additively (GH 0x1402866d0). 3319542538's light shafts.
- **0088 render: volumetric point and spot lights.** `castvolumetrics` (flags bit 2), `density`,
  `volumetricsscattering`, `volumetricsexponent` (GH 0x140283df0); WE's pass (GH 0x1401c56e0) with its materials:
  back faces' depth, the march (front faces, or full screen from inside), an eighth-size light buffer, blur_k3, added
  to the scene. **Ours**: the depth convention (D3D clip depth over GL depth textures, y-flipped targets). Not done:
  SHADOW / COOKIE in the march, fog, directional, the quality setting. 0 library users (a synthetic check).
- **0087 render: puppet IK.** `ik` / `ikd` / `ikr` bones, MDLS v2's IK targets and MDLA v2's target tracks (Observed);
  the solver is **Inferred** (two-bone law of cosines toward the pole, CCD for longer chains). 3042492564's arm now
  follows its animated hand target.
- **0089, 0090**: the factory address in the comments; a shape's placeholder picture 1 x 1 (it was the square: 18 MB at 4K).

Not done: bone physics and applyBonePhysicsImpulse / gravity / wind (0 library bones enable physics; WE's simulation
sits on an unread rigid-body helper family), root motion, MORPHING_MODIFIERS.

Tests (host_api_test, each RED on 5e65da4): `shape_draws_its_effect_in_place`, `volumetric_lights_glow`,
`puppet_ik_reaches_its_target`.

## Implemented: the leftovers (fork patches 0091–0097 + the worker's stereo feed, 2026-11-05)

Decoded addresses and what's inferred: the audit's "Leftovers result".
- **Stereo visualiser input (player + worker, protocol 5).** SysMon mixes every stream in stereo on the graph clock;
  each scene gets every frame in order (`Tick.input` = `AudioInput`, 48 kHz s16 stereo), pushed through
  `wp_context_audio_input_push`: `g_AudioSpectrum*Left` and `*Right` differ. 37 of the 41 audio scenes react to a
  110 Hz tone or white noise (22 of 39 on the u8 mono snapshots).
- **The worker's output clips at ±1 after its gain**, as WE's miniaudio device does (mediaextensions64.dll
  0x180013c35 → 0x180029cb0).
- **0091 text: HarfBuzz shaping + WE's fallback chain** (GH 0x1401da3c0, table 0x1404c5030). 22 of 66 literal texts
  now match the editor's saved size to the pixel (was 4), 53 within 3 % of its width (46).
- **0092 render: world-space particle systems** (system flags bit 0, "Worldspace" in the editor; 16 scenes, 1 moving:
  3104056709's cursor trail). The carry across the system's transform is inferred.
- **0093 render: slots WE leaves to the pass** — `"default": ""` samplers, `usershortcut` usertextures (GH
  0x140184980), the `Text` label type. Health: 3042865984, 3319542538, 3516106265 clean.
- **0094 render: instanceoverride scripts run** (11 scenes script rate / size / count / speed / controlpoint1 /
  colorn / alpha).
- **0095 render: `options.parent` timelines** (GH 0x1401d1740; 5 scenes). The shared clock is inferred.
- **0096: the turbulence's simplex is WE's** (GH 0x14012c280 = Gustavson + Perlin's permutation, the tables equal).
- **0097 render: rope subdivision** = TRAILSUBDIVISION + 1 pieces (genericropeparticle.geom; 19 rope/ropetrail scenes).
- `SPRITESHEETBLENDNPOT` (2 padded sheets, 3 scenes): not needed — LWE uploads those sheets at their image size, where
  the plain frame walk is WE's NPOT walk (tried; a comment in 0097).

Tests (host_api_test, each RED on 127d63b): `text_shapes_with_harfbuzz`, `particle_world_space_stays`,
`unset_slots_are_not_missing`, `particle_override_scripts_run`, `animation_follows_its_parent`; player units
`visual_mix_is_stereo_and_clock_aligned`, `ring_follows_the_clock`, `audio_input_keeps_both_channels`,
`output_clips_at_full_scale_after_the_gain`. 0096–0097: no host test (a comment; 0097 checked by smoke pairs).
