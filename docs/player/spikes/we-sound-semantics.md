# Spike: how Wallpaper Engine plays a scene's sound objects

## Context

- Status: done 2026-10-29. Static analysis only: nothing here was observed running.
- Why: LWE `next-v2` ignores a sound object's `volume`, `startsilent`, `mintime` and `maxtime`, and plays every
  file of a multi-file object at once (docs/TODO.md, "LWE ignores a sound object's `volume`"). This spike
  specifies the fork patch and fixes the `we` model of `scene/loudness_estimate.rs`.
- Targets (the owner's install, copied out of the read-only ntfs3 drive before analysis):
  - `wallpaper64.exe`, `version.json` 2.8.485, sha256 `da37927fc77151429406ede43011a879798468c104d3d3801eaed5bfc045443a`.
  - `bin/mediaextensions64.dll`, sha256 `591c96b233d5636ca305917032b4732a6fc9bfa9a046184dc6200177549da463`.
- Tools: Ghidra 12.1.4 through REA 6.8.0 (MCP), which produced the `ev_…` Evidence ids. A headless Ghidra
  full-program decompile and `objdump` of the same bytes filled the gaps; those claims are tagged `GH 0x…`
  (the function address) or `asm 0x…` (the instruction).

### Status labels

- **Observed** means the claim is read from decompiled code, bytes or constants at the address given.
- **Inferred** means the claim follows from observed code plus the known behaviour of a library.
- **Unknown** means the analysis did not settle it.

## 1. Architecture (observed)

Scene sound does **not** use Media Foundation. That path (MF session, audio renderer) is video wallpapers and
video textures. Scene sound objects go through `mediaextensions64.dll`, which wraps **SFML 3 audio** (`sf::Music`,
`sf::SoundStream`, miniaudio WASAPI backend, libFLAC 1.5.0).

1. The exe loads the DLL with `LoadLibraryExW("mediaextensions64.dll")`. It checks
   `WallpaperEngineMediaExtensionVersion == "WallpaperEngineMediaExtensions0003"` and calls `CreateMediaExtensions()`
   (GH 0x1400f9550).
2. An exe-side audio host holds that interface at `+0xb30`. Its methods `0x1400f9890…0x1400f9990` are pure
   tail-jump forwarders: exe slot `X` maps to DLL slot `X − 0x58` (asm 0x1400f98ff `jmp [rax+0x78]`).
3. DLL vtable `0x18013d940`, by slot:

   | Slot | Function | What it does |
   |---|---|---|
   | `0x30` | `0x180001dd8` | create `sf::Music` from a memory buffer; the handle stores its duration, `µs / 1e6` s ([E2]) |
   | `0x40` | `0x180001f74` | return that duration |
   | `0x48` / `0x50` / `0x58` | `0x180001f7c` / `…f84` / `…f8c` | is playing / is paused / is stopped |
   | `0x60` | `0x180001f94` | `setLooping(arg)` + `play()` ([E2]) |
   | `0x68` | `0x180002018` | pause |
   | `0x70` | `0x180002084` | stop |
   | `0x78` | `0x1800020f0` | **setVolume(v)**: `sf::Music::setVolume(v·100)` → `ma_sound_set_volume(v·100·0.01)` ([E2]) |
   | `0x88` | `0x1800021d8` | attenuation (writes the miniaudio spatializer's `rolloff`, +0x2c) |
   | `0x90` | `0x18000224c` | min distance (spatializer `+0x24`) |
   | `0x98` / `0xa0` | `0x1800022c0` / `0x180002348` | set the position of one stream / of N streams |

4. The DLL's `sf::AudioDevice` initialises the engine's master volume to `100 · 0.01 = 1.0` (GH 0x1800090e0, the
   device init, constants `0x180149150 = 100.0`, `0x180092840 = 0.01`). **No DLL slot changes it.** The
   listener sits at the origin (`0x180149154…`, all 0).

## 2. The sound object (observed)

**Factory.** `FUN_1401be650` makes a sound object (type 7) for any scene object whose `"sound"` key is present
and not null ([E5], GH 0x1401be650). Its constructor defaults (asm 0x1401bed12 and the stores just before it):

| Field | Offset | Default |
|---|---|---|
| `volume` | +0x2f0 | 1.0 |
| `mintime` | +0x2f4 | 1.0 |
| `maxtime` | +0x2f8 | 5.0 |
| next-start timer | +0x2fc | 0 |
| current-file timer | +0x300 | 0 |
| `attenuation` | +0x304 | 1.0 |
| `mindistance` | +0x308 | 1.0 |
| `playbackmode` | +0x30c | 0 (`loop`) |
| flags | +0x310 | 0x88000000 |

The constructor also clears the base object's `visible` bit (+0x120 bit 0).

**Property table.** The table `0x14052aa00` is built by `FUN_140221b50` ([E1] `ev_febaad15…`). The same table
serves scene.json loading, user-property bindings and SceneScript.

| Field | Type | Offset | Notes |
|---|---|---|---|
| `volume` | float | +0x2f0 | on-change hook `0x14021fdd0` = `jmp FUN_140220490` |
| `mintime`, `maxtime` | float | +0x2f4, +0x2f8 | |
| `attenuation`, `mindistance` | float | +0x304, +0x308 | |
| `playbackmode` | enum (`loop` 0, `random` 1, `single` 2) | +0x30c | the static at `0x14052bae0` |
| `muteineditor` | bool | +0x310 bit 0 | |
| `startsilent` | bool | +0x310 bit 1 | |
| `spatialization` | bool | +0x310 bit 2 | |

Script methods: `play` (`jmp FUN_1402206b0`), `stop` (clears bit 27, then `FUN_140220610`), `pause`
(`FUN_140221a80`), `isPlaying`.

- **`sound` value.** A string (one file) or an array of strings ([E3], `FUN_1402206b0` reads `"sound"` as JSON type
  4 or 6). LWE's array-only rule misses the string form.
- **No `visible` and no `queuemode`.** Neither key is in the sound table. `queuemode` (`random` 0 / `sequential`
  1, +0x350) is registered on a different class, table `0x14052a900`, next to `visible`, `fov` and `zoom`
  (`FUN_14021e8b0`, [E0] `ev_97b7d331…`). It is not a sound field.
- **Float values are not checked.** `FUN_1401d1490` (from JSON or a binding) and `0x1401d1380` (from script)
  store the number as given, with no clamp, then call the hook (GH 0x1401d1490). The binding form is
  `{"user": "<name>" | {"name", "condition"}, "value": …}` (`FUN_1401d1740`).

### Runtime state bits in +0x310 (observed)

| Bit | Meaning |
|---|---|
| 31 | stopped / not started. Set at construction and by `FUN_140220610` (stop all). Cleared when a start is attempted. |
| 30 | paused by script. Set by `pause()`. A start clears it and resumes. |
| 29 | inhibits every start. No setter found. **Unknown**. |
| 27 | cleared by `stop` / `pause`. **Unknown** purpose. |

## 3. Answers

### Q1. The `volume` mapping

- **Observed: the gain on the stream is `volume² × M`.** Every gain write passes
  `volume * volume * X[+0x2d8]` to DLL `setVolume`, where `X = sound+0xc8` (the scene context):
  - the volume hook `FUN_140220490` ([E3] `ev_5692b91b…`);
  - every start branch of `FUN_1402206b0` ([E4] dossier `ev_a99946d0…`).

  The DLL then sets the miniaudio sound's volume to exactly that value (×100 then ×0.01, [E2]). So a literal or
  bound `volume` is a **squared amplitude**, not linear and not dB. Examples:

  | `volume` | amplitude | change |
  |---|---|---|
  | 0.5 | 0.25 | −12 dB |
  | 0.1 | 0.01 | −40 dB |

- **Observed: no clamp.** Not in WE's setters and not in the DLL path. A value above 1 boosts: 2 gives ×4.
  A negative value squares to a positive gain. The start test is `volume²·M <= 0`, so only an exact 0 (or
  M = 0) keeps a sound from starting.
- **Observed: M, the wallpaper level.** `FUN_1401b1ca0(holder, M)` stores M and re-runs `FUN_140220490` on
  every type-7 object ([E3]).
  - Callers pass `M = fade × wallpaperVolume`.
  - `wallpaperVolume` (+0x178) is the wallpaper's own `volume` property / 100 (`FUN_140145fa0`,
    `0x1404d448c = 100.0`, [E6] `ev_73b7562d…`).
  - `fade` (+0x174) ramps toward 0 when the wallpaper is muted or paused, and toward 1 otherwise
    (`FUN_140141520`, [E7] `ev_7400b05e…`; see Q5).
  - **Inferred:** the store lands at holder+0x2e8, the sound reads `X+0x2d8`, so `X = holder+0x10`. This is
    consistent with the immediate re-apply that follows the store.
- **Observed: object × wallpaper levels multiply.** The DLL engine's master volume stays 1.0 (§1).
  - **No limiter or normaliser** appears anywhere in the exe's or the DLL's sound path (bounded search: the
    gain sites above).
  - **Inferred:** miniaudio clips f32 output to ±1 when `noClip` is false (SFML's default). Windows' shared-mode
    mixer follows.
  - **Unknown:** the WE-wide "audio volume" setting in the UI. No path from it to the sound gain was found. If
    it exists it acts outside these stages, for example through the WASAPI session volume.
- **Inferred: user-property → number conversion.** The binding stores the property's JSON number as given.
  A slider is its value. The bool and `{name, condition}` conversions were not decompiled (the binding class
  `0x1404cbc78`). LWE's `DynamicValue` rule (bool 1/0, condition hit 1/0) is the working assumption.

### Q2. `playbackmode`

This is all in `FUN_1402206b0` ([E4]), the start/advance routine. It runs at load (`FUN_14021ff10` unless
`startsilent`), on script `play()`, on a volume change (see Q5), and when the next-start timer expires (tick
`FUN_14021ff40`, [E3]).

Each start does the following:

1. It stops all of the object's streams (`FUN_140220610`).
2. It picks **one index uniformly at random in `[0, n−1]`** (`FUN_14021fd90` → the scene RNG at `X+0x1f08`).
3. It sets the gain `volume²·M` and plays that one file.

Then, by mode:

| `playbackmode` | Behaviour (observed) |
|---|---|
| absent | the default is `loop` (constructor) |
| `loop`, 1 file | `play(loop=true)`. A seamless native loop with no timer. |
| `loop`, n > 1 | `play(loop=false)`. The timer is set to the file's duration. When it runs out, the next start picks again at random: **shuffle with replacement, back-to-back, no gap**. The same file can repeat. There is no sequential order. |
| `random` | Starts only when the timer is exactly 0. `play(loop=false)`, then timer = `U·(maxtime − mintime) + mintime + duration`, with `U` uniform in [0, 1) (`FUN_14021fd40`; `X+0x20/0x24` = 0/1 from the constructor `FUN_1401acae0`). So **each file is followed by a uniform `[mintime, maxtime]` s gap of silence**, and then a fresh random pick, with repeats possible. One file loops with gaps. |
| `single` | **One random file, once.** No timer, so there is no re-trigger. |

`sequential` and `queuemode` do not apply to sounds (§2).

**Timer rules (observed, [E3]).**

- The tick decrements the next-start timer by `dt / X[+0x154]` (1.0 by default; its meaning is **unknown**).
  It only does so while `volume²·M > 0`, the timer is above 0, and neither bit 30 nor bit 31 is set.
- So a muted object (volume 0) freezes its schedule.
- In random mode the gap is counted from the file's start, so its end is honoured only to frame accuracy
  (inferred).

### Q3. The other fields

- **`startsilent`** (bit 1). Observed: the object is not started at load (`FUN_14021ff10`). Volume changes do
  not start it either, because `FUN_140220490` requires bits 1 and 30 clear and bit 31 clear, and bit 31 is
  still set from construction. **Only a script `play()` starts it.** After any start attempt, bit 1 is
  cleared.
- **`muteineditor`** (bit 0). Observed: parsed. A bounded search for direct bit-0 tests on +0x310 in the exe
  found no reader. Inferred: editor-only, no effect on wallpaper playback.
- **`spatialization`** (bit 2). Observed: when set, each start and each tick call `FUN_140220040`.
  1. It computes the object's position relative to the camera, in camera axes.
  2. With an orthographic camera (`X+0x118` bit 10) it uses the unit direction × `max(0, (w+h)/4 − z) / ((w+h)/4)`.
  3. If `X+0x144 == 0` it uses `(0, 0, 99999)` (**unknown** meaning).
  4. It sends the result through DLL slot `0xa0`. On a start it also sends `attenuation` (slot `0x88` = rolloff)
     and `mindistance` (slot `0x90`).

  Inferred: miniaudio's inverse distance model and stereo panning, as SFML configures them. In a 2D scene the
  positions have length ≤ 1 ≤ `mindistance`, so the effect is **panning only**, with no distance loss.
- **Spatialization off.** Observed: no position is ever set, so the stream and the listener both stay at the
  origin. miniaudio's spatializer skips panning at distance ≤ 0.001 (`FUN_18003b180`, DLL constant
  `0x180095294 = 0.001`), and the distance gain is 1 inside `mindistance`. So a non-spatial sound plays at
  **unity** (observed code path; runtime not observed).
- **`attenuation` / `mindistance`** only matter with `spatialization` on (above).
- **`visible`.** Observed: not a sound property. The constructor clears the base visible bit, and no sound
  routine reads it. Inferred: no effect on audio.

### Q4. Mixing

- Each file is its own `ma_sound` on one `ma_engine` (SFML 3's single device).
- Inferred from miniaudio's node graph: the streams are **summed plainly**. There is no normalisation and no
  per-object limiter. The device master volume is 1.0 (observed, §1), followed by f32 clip at ±1 (inferred).
- Within one object only one file plays at a time, because every start stops all of the object's streams first
  (observed). Several objects play simultaneously and add.
- Decode: SFML resamples each file to the device format. Mono → stereo up-mix is miniaudio's (inferred), the same
  −3 dB question the estimator already models.

### Q5. Live changes

- **Object `volume`** (a bound user property, or a script assignment). Observed: the change goes through the
  property hook into `FUN_140220490`, which immediately calls `setVolume(volume²·M)` on every stream. WE adds
  no ramp.
  - Inferred: none on the miniaudio side either. `ma_sound_set_volume` (`0x18003a0d0`) interpolates only when the
    sound's `volumeSmoothTimeInPCMFrames ≠ 0`, and SFML builds the engine from a zeroed `ma_engine_config`. So
    the step is instant, at the next audio period.
  - The same hook starts a not-playing, non-`single`, not-startsilent object that was held back by volume 0.
    Raising a slider from 0 starts a `loop`/`random` sound with a fresh random file. A `single` sound never
    starts this way.
  - Lowering a playing object's volume to 0 keeps it running silently. Its timers freeze.
- **The wallpaper's own `volume` property.** Observed: `FUN_140145fa0` sets +0x178 and calls `FUN_1401b1ca0`
  immediately. This is instant.
- **Mute / pause fade** (`FUN_140141520`, [E7]). Observed: every frame,
  `fade += (target − fade) · min(6·dt, 1)` (`0x1404d43e8 = 6.0`). It snaps to the target once
  `|Δ| < 0.01` (`0x1404d4114`). That is an exponential approach with a ≈ 167 ms time constant, and M is
  re-sent on each change.
  - When M reaches ≤ 0, `FUN_140220490` pauses the playing streams. It also stops `random`/`single` streams
    whose current-file timer has run out.
  - When M rises again, it resumes the paused streams.

## 4. Spec for the LWE fork patch (`CSound` / `ObjectParser::parseSound`)

**Parsing.**

1. **`sound`:** accept a string or an array of strings.
2. **`volume`:** a `DynamicValue` float, default 1.0 (literal, or a `{user, value}` binding with the existing
   `DynamicValue` rules). Do not clamp.
3. **`playbackmode`:**
   - absent → `loop`;
   - `loop` | `random` | `single`;
   - an unknown string → `loop` (the default; WE's behaviour for an unknown string is **unknown**).
4. **`mintime` / `maxtime`:** floats, defaults 1.0 / 5.0.
5. **`startsilent`:** a bool, default false.
6. **Ignore** `muteineditor`, `visible` and `queuemode`. Parse `spatialization`, `attenuation` and `mindistance`
   but leave them as a no-op for now (see 11).

**Playback.** One `CSound` holds N file streams. At most one plays at a time.

7. **Gain.** Each stream's gain is `volume² × hostGain`, where `hostGain` is the wallpaper's own level (1 for
   liascape, whose player bus does the rest). Apply it in `HostAudioDriver::pull` as a multiply on that stream's
   samples. Mix streams by plain sum, as today, with no normalisation.
8. **Start(),** at load unless `startsilent`, and on script `play()`:
   1. If `volume² ≤ 0`, do nothing (clear the "pending" state).
   2. Otherwise stop all streams, pick `i` uniformly in `[0, N)`, rewind stream `i` and play it.
   3. Then, by mode:
      - `loop`, N == 1: loop natively, no timer.
      - `loop`, N > 1: play once, `next = duration_i`.
      - `random`: play once, `next = duration_i + mintime + U·(maxtime − mintime)`.
      - `single`: play once, no timer.
9. **Tick(dt),** on the host clock (patch 0005's timer source): while `volume² > 0` and `next > 0`, do
   `next −= dt`. When `next ≤ 0`, set `next = 0` and call Start(). A `random` object starts only from
   `next == 0`. Use a seedable RNG so tests are deterministic.
10. **The volume listener** (the `DynamicValue` callback, so `scene_props` reach it live). Set the new gain
    immediately, with no ramp, matching WE. If the object is not playing, its mode is not `single`, it is not
    `startsilent`-pending and no script stopped it, then call Start(). A move to 0 keeps the stream running
    silently.
11. **Later** (2D ≈ pan-only in WE): spatialization = pan by the object's screen x when `spatialization` is
    true. **Out of scope** for the first patch; note it in the patch message.
12. **Tests** (patches/lwe/tests):
    - a two-file `loop` plays one file at a time;
    - `random` waits `mintime..maxtime` between files;
    - `volume` 0.5 → amplitude 0.25;
    - a property change → an immediate gain step;
    - `startsilent` → silent;
    - volume 0 → 1 starts a `loop` sound but never a `single` one.

**liascape side.** After the patch, flip `scene-loudness`'s default model to `we`. The `we` model now uses
`volume²`, an absent mode = loop, defaults 1/5 s, and `single` = one random file (the first stands in).

## Evidence index

| Id | REA Evidence | Covers |
|---|---|---|
| E0 | `ev_97b7d33131ac26444cd24512feca7f09a41585d9a199372165702fdb527244ec` | `FUN_14021e8b0`: the `queuemode` table, not sound |
| E1 | `ev_febaad15f1a7a4e4d3a8088c6b4075e8246f359b25bda8338b2d687a2af69e0b` | `FUN_140221b50`: the sound property table, the enum, bits |
| E2 | `ev_fbd95fcf09b8751f7595560dacf54edb1cfa6e88507be796bcabd0f07d68d71d` | DLL: setVolume ×100 → ×0.01 → `ma_sound` volume; create/duration; play(loop) |
| E3 | `ev_5692b91b1e3e8f2435d7c21634b66c8ee0ea3b758c19996ef3162e56e4badcf4` | `FUN_140220490` (hook: v²·M), `FUN_14021ff10` (startsilent), `FUN_14021ff40` (tick), `FUN_140220610` (stop all), `FUN_1401b1ca0` (M), `FUN_14021fd40` (U[0,1)), `FUN_140221a80` (pause) |
| E4 | `ev_a99946d0039838751db19faf1c23cc950c84d9a4cd43b4810a3f33d04927917e` | `FUN_1402206b0` dossier: the start/advance per mode |
| E5 | `ev_7f6502e704b1eaa0c543d79f61f7db39f5751de975c46018125cf5de0e2d4e05` | `FUN_1401be650` dossier: the object factory, sound constructor defaults |
| E6 | `ev_73b7562d08f5b74d0317e82e3926e9c51967a902b7762c26c25bfb33858c4950` | `FUN_140145fa0` dossier: the wallpaper `volume` property / 100 → M |
| E7 | `ev_7400b05eacc78983a3057c2974fc1218e4a481615b2bdc26bef0b4405178fd1d` | `FUN_140141520` dossier: the mute/pause fade (rate 6/s, snap 0.01) |
| — | `ev_bd92c2a3…`, `ev_d51baf88…`, `ev_f72de2fd…`, `ev_b4648abf…`, `ev_5297a69d…`, `ev_0acaa494…` | field-string search and xrefs |
| — | `ev_616f5114…` | MF imports (video path, not scene sound) |

GH/asm claims (not in REA Evidence) are reproducible from the headless decompile of the same bytes. They are the
host forwarders `0x1400f98f0…`, the bit setters `0x1401c95a0` / `0x1401c9e80` / `0x14020f310`, the constructor
store at `0x1401bed12`, the DLL vtable `0x18013d940`, the device init and the spatializer `0x18003b180`.
