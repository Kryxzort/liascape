<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Sources

`src/sources/` + `src/mpv/` (spec §4.2 "Source", §5.1 libmpv gotchas, §5.3 audio): the
frame producers the compositor samples (`Source::texture`) and the audio streams recipes
ramp (`gain.<slot>`). `trait Source { kind, update(&Gfx) -> bool, texture, size, apply,
read, poll_events }`; `SourceEvent::{Ready, Ended, Position(f64), Error{reason},
Rejected{prop, reason}}` — `Error` = the source is broken (load/decode failure, foreign
context, core gone); `Rejected` = one property write was refused and reverted, the source
plays on (R45).

**Contract every source keeps.**
- `update` **never blocks** and returns whether the texture changed. `texture()` keeps
  the last good frame forever (R19's other half — `gfx::compose` has no frame memory):
  a stalled/reloading/ended source shows its last frame, never black.
- `apply(prop, v)` first runs `graph::props::validate_value(Source, …)` — same codes and
  check order as `Graph::set` (`no_such_prop` > `read_only` > `bad_type`/`out_of_range`);
  a string with an interior NUL is `out_of_range` (never stripped — a stripped path would
  name a different file); a live `kind` change is `unsupported` (create a new source).
  Every writable property is live (project rule "settings apply live"), including `path`.
- `read(prop)` serves **cached/observed values only** — never a synchronous mpv call.
  `None` = unset/unknown (an image's `duration`, `time_pos` before playback,
  `width`/`height` before mpv reports a size). An applied value reads back immediately;
  if mpv later rejects it, it reverts (see "Async core calls").
- `update` only ever renders through the context the source was opened on:
  `GlKeepAlive::is_for(gfx)` (`Rc::ptr_eq` on `Shared`) — a different `Gfx` gets no
  render (libmpv through a foreign context is UB, `render.h`) and one `Error` event.
  `update` and `open` both take a `GlKeepAlive::make_current()` guard (a no-op when the
  context already is current), so another `Gfx` being current never misdirects GL calls.
- **Orientation (R25): a source texture holds the image's TOP row at texture row 0**
  (`t = 0`, GL's bottom row) — what `gfx::compose`'s single flip expects. `MpvSource`
  renders with `MPV_RENDER_PARAM_FLIP_Y = 0` into its FBO and that lands exactly so on
  this build (mpv's "normal" render orientation is top-down; FLIP_Y=1 is for a GL
  default framebuffer). Pinned by `tests/sources.rs::source_texture_holds_image_top_at_t0`
  (top-red/bottom-blue clip: low y red, high y blue). Never flip in a source.

**`MpvSource::open(gfx, path, opts)`** — one mpv core + one render context per source. Since
the final review (I5) it is two halves: **`MpvSource::prepare_core(opts)`** — eventfd,
`mpv_create`, the fixed options, `mpv_initialize`, the observers, the wakeup callback; no GL,
no node props; `Send` (`PreparedCore`, dropped unused = callback cleared + core to the reaper)
— and **`MpvSource::open_with_core(gfx, path, opts, core)`** on the loop thread (render
context, every property applied, `start`, `loadfile`). `SourceHost` runs the first half on an
`lia-open` worker thread in the real-clock runtime (§ Sources "`SourceHost`"); `open` = both in a
row (stepped mode, tests, the harness).
Fixed options: `vo=libmpv`, `config=no`, `terminal=no`, `keep-open=yes` (an ended video
holds its last frame) **with `keep-open-pause=no`** (keep-open's default also flips
`pause` at EOF — `read("paused")` would then disagree with the graph and a seek back
after the end would stay frozen), `idle=yes` (the core survives a load error / waits for
a `path` change), `volume=100`, `volume-gain-min=-96`, `image-display-duration=inf` (set
always — it only affects single-frame images), `keepaspect=no` (the texture *is* the
frame; fit is the compositor's), `opengl-pbo=no` (required by the fence stub, below),
`osd-level=0`, `ytdl=no`, `input-default-bindings=no`, `audio-client-name=liascape-player`,
**`dither=ordered`** (I5: the default `fruit` dither builds its blue-noise matrix on the CPU in
every new render context's first render — measured ~25–30 ms on the loop per switch; ordered
dithering of the same 8-bit target is visually equivalent), **`gpu-hwdec-interop=no`** (Task 20d:
no hwdec GL interop init on the loop; a render-worker attach that wants zero-copy sets the worker's
interop before its render context exists — "Hardware decoding" below), and with opt `shader_cache_dir`
(`serve` passes `<state>/shader-cache`) `gpu-shader-cache=yes` + `gpu-shader-cache-dir`.
**No built-in scripts or bindings (`sources::mpv::SCRIPT_TRIMS`, TODO "mpv's built-in Lua scripts
per core"):** `load-scripts=no`, `osc=no`, `load-stats-overlay=no`, `load-console=no`,
`load-auto-profiles=no`, `load-select=no`, `load-commands=no`, `load-positioning=no`,
`load-context-menu=no`, `input-builtin-bindings=no` (`ytdl=no` above covers `ytdl_hook`). Each
built-in script is a Lua VM on its own thread (`lua/<name>`) serving an OSD, console or menu no one
can open on a wallpaper. Set **best-effort** (`set_optional`): a libmpv that predates a name (older
mpv lacks some `load-*`) still opens — the skipped ones are logged once per process as
`mpv.options_skipped {skipped}` (info). **Measured** (mpv 0.41): a playing 1080p30 core had 28
threads, 6 of them scripts (`commands`, `console`, `context_menu`, `positioning`, `select`, `stats`
— `auto_profiles` stays out at `auto` without conditional profiles, `osc`/`ytdl_hook` were already
off in libmpv) → **22**; one core's create + initialize + destroy (libmpv via ctypes, 40 cores × 3
rounds) **37–47 → 3.7–5.7 ms CPU**, `mpv_terminate_destroy` median 0.8–1.3 → 0.4–0.6 ms; a live
idle core's RSS ~1.3 MiB (3.5 on first touch) → 0.1 MiB; the loop's open share
(`i5_switch_loop_busy` `max_open_ms`) 3.6–7.5 → 0.8–3.9 ms (open_with_core's synchronous
property sets no longer queue behind six script clients registering on the core). The scripts
used no measurable CPU in steady playback (0 ms in 10 s), so this is per-switch only; the switch's
loop busy is still the render context + first render (§ Runtime "Switch cost"). Guards:
`tests/sources.rs::builtin_scripts_are_not_loaded` (every option reads back `no`, no `lua/*`/`js/*`
thread in the test process; RED before: `load-scripts` `yes`, 6 script threads per core), unit
`unknown_trim_option_never_breaks_a_core`.
**No native clipboard (`sources::mpv::CLIPBOARD_OFF`: `clipboard-backends=` — an empty list, set
best-effort the same way).** mpv ≥ 0.40 starts a clipboard in every core at `mpv_initialize`
(default backends `wayland`, `x11`, `vo`): with `WAYLAND_DISPLAY` its own `ext-data-control`
connection to the compositor + a thread (fed every clipboard change of the session — every test
server inherited the owner's and so connected to the live Hyprland), without it and with a reachable
`DISPLAY` its own **X connection** + a thread (named after its creator, `lia-open`). That one crashed
the player (2026-10-26, rapid-switch repro, `--headless` without `WAYLAND_DISPLAY`): when the X
connection drops, mpv's clipboard thread `XCloseDisplay`s it → `XSync` fails → Xlib's *default* I/O
error handler `exit(1)`s from that thread → the atexit handlers tear NVIDIA's EGL down under the
loop's GL → **SIGSEGV** in `glBindFramebuffer` (stderr `X connection to :1 broken (explicit kill or
server shutdown)`; core dump: two cores' clipboard threads in `XCloseDisplay`, the reaper idle — both
live connections broke at once, 2 ms after an Electron's scope ended: most likely a UI-matrix shard's
private `Xvfb -displayfd`, which comes up as `:1` on this machine, going away with its shard; the
switches were incidental — 48 rapid-switch runs against a private Xvfb never broke a connection).
Nothing in the player needs X: with this set, a core has no X or Wayland connection of its own.
Guards: `tests/api.rs::losing_the_x_server_never_kills_the_player` (`DISPLAY` = a
private `Xvfb` on a display nothing uses — never `-displayfd`, which took the session's `:1` —, no
`WAYLAND_DISPLAY`, a playing `hwdec=auto` video; the X server killed →
the player plays on, switches, quits 0; RED before: SIGSEGV within ms; SKIP without `Xvfb`),
`tests/sources.rs::no_clipboard_backend_per_core` (`current-clipboard-backend` unavailable,
`options/clipboard-backends` empty; RED before: `wayland` under the session's environment). **Not
covered:** a decoder that talks to X itself (an explicit `vdpau`/`vdpau-copy`) opens its own
connection through its driver; `auto` resolves to `nvdec-copy` here (none — the guard runs it).
`opts` = any writable `Source` property (`position` → mpv `start`), plus `ao` (default
`pipewire`), `audio_device` (mpv `audio-device`; `serve` passes the bus, § Audio bus),
`audio_delay_bias` (seconds **added** to every `audio_delay` before it reaches mpv's
`audio-delay`; `serve` passes −`Bus::latency()`; `read("audio_delay")` stays the graph
value), `kind` (`video`|`image`, default from the
extension, then corrected by mpv's `current-tracks/video/image` flag after load).
**Every writable property not in `opts` is applied at its schema default**, so `read`
and mpv agree from the first moment. Error codes: a wrong-typed opt (`kind: 5`, `ao: 5`,
`position: "x"`) is `bad_type`; a bad value (`kind: "color"`) or one mpv rejects at open
(`af: "no_such_filter"`) is `out_of_range`; an unknown/unavailable mpv option/property is
`unsupported`; `io` is kept for real setup/load/I/O failures (mpv init, render-context
create, eventfd). `open` is synchronous only *before* the first `loadfile` (no VO exists
yet, so nothing can wait on the render thread); the load itself is async: a missing or
broken file is `Ok` from `open`, then `Error{reason}` naming the path plus mpv's last
error-log line.

**Async core calls (render thread).** `render.h` forbids the render thread from waiting
on core functions not marked render-thread-safe: the core can be waiting on the render
thread (vo_libmpv's flip waits for `mpv_render_context_render`; after a load/seek the
core waits for that first frame to be shown), so a synchronous `mpv_set_property`/
`mpv_command` stalls until vo_libmpv's timeout — **measured 4–72 ms per call** with the
first, synchronous version (`apply_never_blocks_the_render_thread`: 80 ms without
`update()`, a seek, 240 gain applies). After `open`, every `apply` uses
`mpv_set_property_async`/`mpv_command_async` (`client.h`: "Safe to be called from mpv
render API threads") with a reply id: measured worst apply 120–160 µs in that same test.
A reply with an error becomes `SourceEvent::Rejected{prop, reason}` (R45; `prop` = the
graph property, `gain` for the summed gain push) naming the mpv property/command, the value
and the graph property (`af=no_such_filter_lp (af): …`), and
`props` reverts to the previous value (only if no newer apply of that property is in
flight). **Gains are coalesced:** at most one `volume-gain` request is in flight; gain
changes while it is pending only mark it dirty and the latest sum is sent when the reply
arrives — a per-frame gain ramp can't flood mpv's 1000-entry reply queue, and the final
value always lands. `MpvSource::requests_in_flight()` (0 = everything applied has
reached mpv) is for probes/tests; `mpv_get_string`/`mpv_get_f64` are synchronous and
**tests/probes only**.

**Property map** (graph name → mpv): `loop` → `loop-file` `inf`/`no`; `paused` → `pause`
(observed `pause` changes are mirrored back into `read`); `speed`; `position` → `seek <t>
absolute exact` (or `start` before the current file has loaded; a `path` change resets
`start` to `none`); `hwdec` → `sources::mpv::mpv_hwdec(v, interop)` (copy modes unless the
source's render context loaded the render worker's GL interop — "Hardware decoding" below);
`fps_cap` → `vf` `fps=<n>` / `""` — **never on a still** (`want_vf`/`push_vf`, below); `cache` →
**`auto`** for `true` (mpv's normal policy — what the legacy engine runs with
DisableCache=false; `yes` would RAM-cache every local wallpaper) and `no` for `false`;
`demuxer_max_mib`/`demuxer_back_mib` → `demuxer-max-bytes`/`demuxer-max-back-bytes`
`<n>MiB` (a fractional MiB goes as exact bytes — mpv rejects `1.5MiB`; `0` = unset →
mpv's default 150/50 MiB, the legacy engine's convention); `af` → `sources::mpv::mpv_af(v)`
(below); `no_audio` → `aid`
`no`/`auto` (`auto` re-inits the AO even after a no-audio start — `current-ao` and
`audio-out-params` come up, `start_muted_then_unmute_live`; the `aid` *property* then
reads the picked track id, e.g. `"1"` — `options/aid` reads `"auto"`); `audio_delay` →
`audio-delay`.

**An fps cap never reaches a still (2026-10-28).** mpv's `fps` video filter (libavfilter's) emits a
frame only once it knows how long it lasts — the next frame's pts or a timed EOF; an image shown with
`image-display-duration=inf` gives neither, so its one frame went in and the chain reported EOF with
no frame out (mpv `--msg-level=vf=v`: `filter input EOF` → `filter output EOF`, nothing rendered).
With `VideoFpsCap` > 0 every image item stayed `ready: false` (size 0) and its switch sat in
`waiting_ready` until the 10 s failure. Now `MpvSource::want_vf` sends `fps=<n>` only when the
current load isn't a still (`vf_still`: the `kind` at open, `infer_kind` of a new `path` — set before
its `loadfile`, async requests run in order —, then mpv's `current-tracks/video/image` flag, which
re-pushes the `vf` when the guess was wrong: a misnamed still loses the filter and its frame comes
through, an animated "image" gets the cap); `push_vf` skips an unchanged value. The node keeps
`fps_cap` (`read` = the cap). Player-side, so any client is safe. Scenes and colours only store
`fps_cap` (unaffected). Guards: `tests/sources.rs::fps_cap_never_stalls_an_image` (open capped, live
cap, image → video (capped, `vf` has `fps`) → image by `path`, a `.dat` still; RED: never Ready;
the flag's re-push removed → the `.dat` case RED), `tests/api.rs::fps_cap_never_stalls_a_still_any_kind`
(both clocks: `srcs:*.fps_cap` + capped image/colour/scene/video B's each hand off and show; RED:
stepped `step: no frame within 2 s … waiting for ready`).

**A tempo filter is always in the chain (speed storm).** `mpv_af` hands mpv the graph's `af`
plus `@liascape-tempo:scaletempo2` (left out when the chain already has `scaletempo*`/`rubberband`).
With pitch correction on (mpv's default) mpv adds its own tempo filter only while `speed` ≠ 1 and
drops it at exactly 1×, and each add/drop rebuilds the audio chain (its `userspeed` stage and a
s16↔float `convert`, mpv's af log): **3–5 ms of digital silence each, ~200 ms later at the sink** —
measured on the bus meter, 22 holes in 40 s of 0.9↔1.0 toggles, none for 0.9↔1.1 (the UI's speed
slider steps 0.1, so every drag across 1× and every release at 1× lands there). mpv gives the speed
to the last filter of the chain that takes it, so with ours present the chain is built once and
never rebuilt; at 1× scaletempo2 is bit-exact (output identical to the source, zero lag).
`read("af")` keeps the graph value. Unit `af_always_carries_a_tempo_filter`, `tests/sources.rs::
defaults_applied_at_open_match_mpv`.

**Gains → `volume-gain`, `volume` stays 100.** Every `gain.<slot>` apply recomputes
`units::Gains::effective_db()` and sets mpv `volume-gain` = `units::mpv_volume_gain(db)`
(exact dB; `volume` is cubic — § Units; mpv stores it single-precision, so it reads back
within ~1e-6 dB). `volume-gain-min=-96` is what lets mpv accept the −96 dB floor. `open`
pushes the initial sum too, so mpv never runs at its own default.

**Hardware decoding (Task 20d, R107; zero-copy on the render worker since 2026-10-27).** Two
cases, by where the source's render context lives: **on the render worker** (the default for
every real-clock source) it decodes zero-copy through a GL interop — "Zero-copy on the render
worker" below; **on the loop** (worker off, stepped mode, the harness, any synchronous open) it
decodes in copy modes, never GL interop — the rest of this paragraph. Such a core runs
`gpu-hwdec-interop=no` and `apply("hwdec", v)` sends `mpv_hwdec(v, None)`: `""`/`no` → `no`;
`auto`/`auto-copy` → `nvdec-copy,vaapi-copy,auto-copy` (`auto-safe`/`yes`/`auto-copy-safe` → the
same with `auto-copy-safe`, `auto-unsafe`/`auto-copy-unsafe` → with `auto-copy-unsafe`); an interop
name (every mpv 0.41 decoder with a `-copy` twin: `nvdec`, `cuda`, `vaapi`, `vdpau`, `vulkan`,
`amf`, `v4l2m2m`) → its `-copy` twin; anything else (a `-copy` mode, or a name this mpv doesn't
know — e.g. `drm` isn't in 0.41's list: mpv rejects it and the prop reverts, R45) unchanged; lists
element by element (a unit test asserts no accepted value comes out as an interop decoder). On
AMD/Intel this turns `auto`'s zero-copy `vaapi` into `vaapi-copy` too (same trade-off below). `read("hwdec")` keeps the user's value;
the `sources` probe has `mpv_hwdec` (the request) and `mpv_hwdec_current` (the pick). **Why:**
(1) mpv's render context runs hwdec interop init on the render thread — our loop — and with
mpv's default `gpu-hwdec-interop=auto` it creates the **CUDA interop (a CUDA context) inside
`mpv_render_context_create`** whenever libmpv can load `libcuda.so.1`: 65–90 ms per switch,
*whatever `hwdec` says* (also `no`). libmpv's RUNPATH lacks `/run/opengl-driver/lib` (nixpkgs
adds it to `bin/mpv` only), so the dev/install binary fails that load (`ffmpeg: Cannot load
libcuda.so.1` once per source — harmless now) while the flake wrapper's
`LD_LIBRARY_PATH=/run/opengl-driver/lib` (R86) made it succeed; it also succeeds in any process
where libavutil already loaded libcuda for `nvdec-copy` (glibc matches the soname) — so before
this, `nvdec-copy` cost 66–138 ms per switch from its second switch on, and the UI's `nvdec`/`vaapi`
silently decoded in software in the dev binary. (2) mpv 0.41's own `auto` order is `vulkan, nvdec,
vaapi, vulkan-copy, nvdec-copy, …`, so without interop it picks `vulkan-copy`: each new core's
`vkCreateDevice` (mpv's core thread, `select_and_set_hwdec → av_hwdevice_ctx_create`) holds an
NVIDIA driver lock (a process-wide PI mutex) that every GL entry point on our loop waits on —
230–320 ms per switch — **only when no X server is reachable** (`DISPLAY` unset/dead: headless
tests, an Xwayland-less session; with the session's Xwayland reachable 7–22 ms, which is why the
live run and `cargo test` — both inherit `DISPLAY=:1` — never showed it; a nested headless sway
without `DISPLAY` does). Not layers/ICDs (`NODEVICE_SELECT`, `VK_LOADER_LAYERS_DISABLE`, an
NVIDIA-only ICD list changed nothing): driver-internal. An explicit `vulkan`/`vulkan-copy` keeps
that limit (driver; documented, not worked around). **Measured** (hermetic headless 2 × 1080p60,
1080p30 h264 clips, fade 500 ms, 6 switches per mode in one process, no `DISPLAY`; max loop busy
per switch, ms):

| `hwdec` | dev env before → after | libcuda on the path (flake wrapper) before → after |
|---|---|---|
| `no` | 10–34 → 10–47 | 74–157 (CUDA interop) → 14–49 |
| `auto` | 264–300 (`vulkan-copy`) → 12–42 (`nvdec-copy`) | 79–95 (`nvdec` interop) → 11–40 (`nvdec-copy`) |
| `nvdec` | 10–89, **software** → 8–42 (`nvdec-copy`) | 85–98 (`nvdec`) → 13–50 (`nvdec-copy`) |
| `vaapi` | 9–39, **software** → 10–43 (`vaapi-copy`) | 72–94, software → 18–40 (`vaapi-copy`) |
| `nvdec-copy` | 21, then 81–115 → 10–33 | 72–83 → 10–33 |
| `vulkan` / `vulkan-copy` | 72–82 (software) / 261–284 → 273–313 / 267–297 (no X; with X 7–22) | — |

**The trade-off (Phase 1):** copy modes download each frame and mpv uploads it like software
decoding (on the loop then; on the worker's lane since Phase 2). Steady state, one source on both
outputs, % of one core: 1080p30 `no` 27.7,
`nvdec-copy` 9.8, `vaapi-copy` 26.0 (nvidia-vaapi-driver), `vulkan-copy` 14.4, `nvdec` interop
7.4; 4K60 `no` 111, `nvdec-copy` 55.6, `vulkan-copy` 80.1, `nvdec` interop 11.3 (loop max busy at
4K60: `no` 8.1, `nvdec-copy` 12.8, interop 2.8 ms). First frame of a cold source (1080p): `no` 319,
`nvdec-copy` 438, `vaapi-copy` 642, `vulkan-copy` 698 ms — hence `nvdec-copy` ahead of mpv's
`vulkan-copy` in `auto`. Guards (the loop path): `tests/api.rs::t20d_hwdec_switch_never_stalls_the_loop`
(dev env + libcuda env, `DISPLAY`/`WAYLAND_DISPLAY` removed, both render modes; warm median < 50
ms — fixed medians 16–36 ms, the traps ≥ 65 — and never an interop mode on a loop-rendered source;
RED before: 286, 91, 85, 88 ms), `tests/sources.rs::property_map_reaches_mpv`, unit
`hwdec_maps_to_copy_modes_only`.

**Zero-copy on the render worker (2026-10-27; TODO "Zero-copy hwdec back").** A render context
on an `lia-render` lane (§ "Render worker" below) loads the GPU's GL interop, so nvdec/vaapi frames
go straight into GL textures — the interop's init (a CUDA context per render context on NVIDIA)
runs in `mpv_render_context_create` on the lane, which the loop never waits for.
- **Which interop** (`render_worker::hwdec_interop_for`, on lane 0's own context at start, logged
  `render_worker.hwdec_interop {gl_vendor, interop, libcuda}`): `GL_VENDOR` NVIDIA → `cuda`,
  AMD/Intel → `vaapi`, anything else (llvmpipe, nouveau) → none (copy modes, one lane). Never mpv's
  `auto`, which for the render API loads EVERY interop eagerly (no on-demand loading in libmpv) — on
  NVIDIA also `vaapi` via nvidia-vaapi-driver, a second CUDA context per source. Env
  `LIASCAPE_PLAYER_HWDEC_INTEROP`: unset/`on` = that, `off` = Task 20d's copy modes exactly (one lane, no
  preload — the A/B and escape hatch), `cuda|vaapi|drmprime|all` to force one.
- **libcuda.** The CUDA interop dlopens `libcuda.so.1` from libmpv, whose nixpkgs RUNPATH lacks
  `/run/opengl-driver/lib` (above), so lane 0 dlopens it first (by soname, else that path — a
  loaded soname satisfies every later lookup): the dev/install binary gets the interop from its
  first source on, like the flake wrapper; then `cuInit(0)` (`render_worker.cuda_init {result,
  ms}`, 20–32 ms measured) after the loop stopped waiting for the lane. No libcuda → no interop.
- **Which sources.** Only an attach the loop doesn't wait for: the `lia-open` job
  (`PreparedCore::attach_render(worker, true)`) of a source whose node `hwdec` (when the open is
  submitted) would decode zero-copy through that interop and that isn't an image
  (`host::wants_hwdec_interop` — `""`/`no`, `-copy`, `auto-copy*` and stills skip the 85–220 ms
  and ~60 MiB VRAM). It sets `gpu-hwdec-interop=<interop>` on the core (an option after
  `mpv_initialize` = the `options/` property, read when the render context is created) before the
  attach; an attach that falls back to the loop sets `no` again. A synchronous open (the loop
  waits for its attach: the harness, a pool that couldn't start a thread) never asks.
  `MpvSource::hwdec_interop` (probe `hwdec_interop`) then maps `hwdec` with `mpv_hwdec(v,
  Some(i))`: a decoder the interop can show first, **each followed by its copy twin** (an interop
  that failed to init, or a codec the GPU can't do zero-copy, falls back to the copy, never to
  software) — `cuda`: `auto` → `nvdec,nvdec-copy,vaapi-copy,auto-copy`, `nvdec` →
  `nvdec,nvdec-copy`, `vaapi` → `vaapi-copy`; `vaapi`: `auto` → `vaapi,nvdec-copy,vaapi-copy,
  auto-copy`; `auto-copy*` stays copy. A live `hwdec` change keeps working either way (a source
  opened without the interop maps to copy modes). **`vulkan` stays `vulkan-copy`**: mpv's GL
  renderer has no Vulkan interop (it needs mpv's Vulkan renderer), and the X-less driver lock
  above (`vkCreateDevice` on mpv's core thread) is process-wide: with the render worker the loop
  stays free (busy 1–29 ms per switch) but the lanes wait on it — A's longest frame interval
  270–790 ms per switch, the same on the pre-change binary (driver limit, unchanged; the default
  `auto` never picks it). In 2 of 11 such runs a `vulkan` B never showed a first frame (10 s;
  0 of 8 on the pre-change binary, same code path — not investigated). `vdpau` (GLX) and `amf`
  likewise stay copy.
- **GL state, fences, teardown.** The CUDA interop registers mpv's own plane textures with the
  lane's context current (current for the lane's whole life) and copies each decoded frame into
  them with CUDA — ordering that copy before its own GL sampling is mpv's job, exactly as in its
  VO; mpv then renders into our RGBA8 target on the lane, and our `glFenceSync` after that render covers
  every GL command of it — the loop only ever samples our target, adopted once that fence
  signalled. `reset_gl` touches bindings only (mpv rebinds what it needs). `Slot::free` drops the
  render context first — interop uninit, texture unregistration and its CUDA context, the lane's
  context current — then the weak client and textures, and only then hands the core to the reaper.
  The fence stub stays — zero-copy frames come out whole under it (the guards below) — and so
  does `opengl-pbo=no`.
- **Lanes.** One lane would run B's attach (85–220 ms) in front of A's renders: A's longest frame
  interval while B opened 34 → 66–74 ms at 30 fps (1–2 frames lost before every transition). With
  an interop the worker runs three (§ "Render worker" → Lanes): measured 34–54 ms again (copy
  modes 34–66).
- **Measured** (release, hermetic `serve --headless --clock real --ao null --outputs
  1920x1080@60`, no `DISPLAY`, synthetic testsrc2 h264 clips, the machine shared with other
  agents' suites; `LIASCAPE_PLAYER_HWDEC_INTEROP=off` vs on, alternated per run, 4 rounds at load
  10–20; `hwdec: auto`; median (range)):

  | | copy (`off`, Task 20d) | zero-copy (`on`) |
  |---|---|---|
  | 4K60 CPU, % of one core: process / loop / `lia-render` | 49.4 (33.2–56.3) / 4.8 / 26.5 | **6.8 (5.6–8.9)** / 1.1 / 1.9 |
  | 4K60 loop max busy, steady (ms) | 9.8 (3.8–16.9) | 1.4 (1.2–1.6) |
  | 1080p30 CPU, process | 7.8 (5.3–9.6) | **3.2 (2.4–4.1)** |
  | loop max busy per switch, warm (36) | 0.7 (0.2–6.3) | 0.3 (0.2–6.7) |
  | first frame (request → B `Ready`, 40) | 329.7 (300.5–500.6) | 326.3 (296.1–410.6) |
  | A's longest frame interval while B opens (30 fps) | 34.8 (33.9–65.7) | 34.3 (33.9–54.3) |
  | the attach on its lane | 1.9 (0.3–2.9) | 111.7 (91.9–155.3) |

  The same per switch in ONE server (copy and zero-copy blocks alternating, n = 30 each, load
  16–28): loop busy 0.3 (0.2–6.8) vs 0.4 (0.2–3.8) ms, first frame 319.5 vs 318.8 ms, A's longest
  interval 34.4 vs 34.6 ms. Under heavy load (40–48) both modes had loop stretches of 0.1 s to
  seconds (copy ≤ 0.65 s, zero-copy up to 5.6 s in one run); under `strace -ff` (7 runs, load
  23–46) the loop thread never waited ≥ 30 ms in a futex or ioctl while a lane attached or freed —
  CPU starvation, not the driver lock (the Task 20d trap showed the loop in `FUTEX_LOCK_PI`), but
  not excluded for every load. Memory, 1080p playing: RSS 395 → 370 MiB, VRAM +60 MiB per
  interop source. `loop.long_busy` (debug) puts such a stretch on the log timeline.
- **Guards:** `tests/api.rs::t20d_hwdec_switch_never_stalls_the_loop` (worker on: every hardware
  hwdec decodes `nvdec` with `hwdec_interop: cuda`, warm medians 2.2–3.0 ms against the 50 ms
  bound; off: copy modes, 7.7–19.1), `tests/sources.rs::hardware_decoding_matches_software_in_both_render_modes`
  (orientation, colours ±3, a seek's frame marker ±1, frames advancing — zero-copy on the worker,
  copy on the loop), `tests/api.rs::render_worker_never_composes_a_torn_frame` (its `hwdec: auto`
  cases, also under `slow-flush`), unit `hwdec_maps_to_the_loaded_interop_on_the_worker`,
  `hwdec_maps_to_copy_modes_only`, `render_worker::tests::hwdec_interop_follows_the_gpu_and_the_env`.
- **Costs / risks:** ~60 MiB VRAM per playing interop source (its CUDA context; RSS −25 MiB, no
  copy buffers), both sides of a transition; AMD/Intel `vaapi` interop is unmeasured here (NVIDIA
  only); a fourth wallpaper live at once (three outputs with different wallpapers + a switch)
  shares a lane, and the one sharing B's lane holds its frame for B's attach.

**Load fencing (live `path` changes).** Every `loadfile` is async; its reply carries the
new playlist entry id (`playlist_entry_id` from the result map), START_FILE/END_FILE carry
the entry they belong to, and FILE_LOADED / PLAYBACK_RESTART / observed properties are
attributed to the entry between its START_FILE and END_FILE. Only the **current** load
(newest `loadfile`'s entry, while mpv is playing it) counts: a superseded load's
FILE_LOADED, PLAYBACK_RESTART, END_FILE (incl. ERROR — never reported under the new path),
`eof-reached` and `time-pos` are ignored; `time-pos`/`eof-reached` count only after the
current load's PLAYBACK_RESTART (a value delivered right after a path change may still
describe the old file). Pinned by `path_change_before_first_pump_shows_only_new_file` and
`stale_load_error_is_not_reported_for_new_path` (both RED against the first version: Ready
fired on the old file's red frame; the old file's load error was reported under the new
path), plus `path_change_to_missing_then_back` and `path_change_is_live`.

**Events.** `Ready` once per load = the current load's PLAYBACK_RESTART **and** one of
its frames rendered after its FILE_LOADED, **in either order** — both happen (measured:
restart-first for paused clips and images; frame-first in 2 of 3 runs for a playing
video). Requiring "a render *after* the restart" could wait forever on a paused source or
an image whose single frame happened to render first. `Ended` once per play-through, from `eof-reached` (with `keep-open=yes` mpv
never sends END_FILE/EOF; that path is handled too) — re-armed when `eof-reached` goes
false (seek back/loop); never with `loop=true`, never for an image; a seek back after the
end plays again and ends again (`ended_holds_last_frame`). `Position(t)` from observed
`time-pos`, rate-limited to 100 ms. `Error` from END_FILE/ERROR of the current load, a
foreign-context `update`, or a core shutdown; a failed async property/command request is
`Rejected` (R45). **Looping files:** mpv's `time-pos` drops back to 0 while the *last*
frame is still on screen; the visible boundary (frame 0) follows one frame later (measured
33.9–34.3 ms at 30 fps).

**A dropped first frame is asked for again (`REFETCH_AFTER`).** mpv's VO waits 200 ms for the API
user to render a frame (vo_libmpv `flip_page`), then drops it — `mpv_render_context_update` stops
reporting `UPDATE_FRAME`, so the "level-triggered" pending frame is gone. A playing source sends its next
frame anyway; a **paused** one (a transition's pending B, held paused until Ready), an **image**, or a clip
already **at its end** (keep-open holds it — a short clip that played out unrendered) has no next frame: if its only frame went unrendered — the loop busy past 200 ms (a burst of switches and
teardowns with every `/settings`'s live sets landing on the opening B's, the debug build, a loaded
machine; the render worker can't render either until the loop has passed it the size) — it never became
Ready and the transition failed after 10 s (`no first frame within 10 s`). Measured: UI matrix
`race:settingsDuringApply` 4/4 on the debug player; a direct repro (8 transitions 5–80 ms apart + a `set`
of `gain.user`/`speed` on each B, hwdec auto, debug build) 3/8, render worker on or off. `refetch_lost_frame`
(every `update`): a paused source or image whose current load restarted `REFETCH_AFTER` (300 ms) ago with
no frame staged → `seek <time_pos> absolute exact` — the same frame again, a new `PLAYBACK_RESTART`, no
FILE_LOADED (the worker's frame tag still matches) — backing off ×2 up to 2.4 s; never a playing source
(re-seeking a merely slow one would restart its decode), never stepped mode. `source.frame_refetched
{path, pos, since_restart_ms, dsize}` (info, comp `mpv`), `sources` probe `frame_refetches`. After: repro
0/10 (6 of them needed one refetch, size already known — the loop simply hadn't rendered in time), the
matrix cell GREEN. Guard: `tests/sources.rs::dropped_first_frame_of_a_paused_source_or_image_still_readies`
(open, no `update` for 800 ms, then Ready with that frame; RED in both render modes: only `Position(0.0)`) and
`clip_ended_before_any_render_readies_then_ends` (a 1 s clip, no `update` for 1.8 s). **`Ended` waits for
`Ready` in both renderers** (`ended_held`, pushed right after Ready): the loop renderer used to report the end
of a source that never showed a frame first (`ended_holds_last_frame` failed once in a loaded run).

**`AudioFlowing` (Task 16c, R85, invariant #8) — real audio output confirmed, not just
un-paused.** `apply("paused", false)` on a source that was paused arms a wait
(`awaiting_flowing`) rather than assuming audio starts the instant mpv's `pause` flips:
the owner's "flicker of silence" report measured mpv/PipeWire's own audio-out restart
lagging an un-pause by ~19 ms (Task 15's dropout detector), so a caller that starts an
onset gain ramp at the instant of un-pause runs most of the ramp's early portion on no
audio at all. Fires immediately (never actually waits) for: stepped mode (`self.stepped`
— the core is paused for good there, § "Stepped mode" below; audio is always silent, so
nothing to confirm — including the stepped-logical `"paused"` branch itself, which still
arms/fires through the same `arm_audio_flowing` so a caller holding a ramp on a stepped
source's un-pause is never stuck), an image, or `no_audio`. Otherwise armed: the next
`audio-pts` property change (`OBS_AUDIO_PTS` — **observed only while armed** since the final
review (M4): `observe` on arm, `unobserve` on confirm/disarm; it changes at the audio-buffer
rate and woke the loop all day; the first notification after `observe` is the current value
and is skipped) reports it —
man mpv: "Current audio playback position... takes into account the audio driver delay"
— unlike `time-pos`, it doesn't move while held/paused, so the very next change after
arming is the real thing. `load` (a `path` change) resets `awaiting_flowing` — a new load
supersedes everything — and **arms it again when the load plays** (not paused; final review I6:
a restored source's fade-in waits for it), as does an audio re-route
(`MpvSource::set_audio_route`, I7). Callers (the transition recipe, `Runtime`'s player-pause gain)
bound the wait themselves (`recipes::transition::ONSET_TIMEOUT`) — the source itself
never times out; it either confirms or waits. **Two confirmations no further `audio-pts` change
brings** (`MpvSource::confirm_flowing_by_time`, after every pump — every tick; TODO "onset_timeout on
audio-less videos"): the margin is **real time** since the first change (it used to need a *later*
change, so a stream that stalls right after starting never confirmed), and **the picture plays on
without any audio** — `audio-pts` reported *unavailable* (mpv plays no audio: none selected yet —
an audio-less file whose `aid` hadn't resolved — or the selected track already ended, e.g. a 30 ms
track on a 4 s video) while the media position moved `NO_AUDIO_MEDIA_ADVANCE` (0.1 s, a wrap counts)
since arming — with audio playing, mpv's clock is the audio, so the picture can't run ahead of it.
Nothing will be heard, so the ramp may start. RED before: every onset onto such a B waited out the
150 ms and logged `transition.onset_timeout` (all 6 method × align cells with a 30 ms track);
`tests/api.rs::audio_less_b_never_times_out_its_onset_any_method_or_align` (no audio stream, a
short track, then a 16-request switch storm; also asserts no `runtime.onset_timeout`). A core that
never plays (no change, position stuck) still never confirms.

**`has_audio` (R92, review of Task 16c/16d) — does the *file* genuinely have an audio
track, mirrored into the graph like `kind`/`ready`.** Distinct from `no_audio` (our own
request, `aid=no`) and from `kind == "video"` (just "not a still): a video with no audio
*stream at all* used to be indistinguishable from one with audio merely disabled, so
every onset/R88 resume on it waited the full `ONSET_TIMEOUT` and logged a warning, every
time. Observed via `aid` (`OBS_AUDIO_SELECTED`, `Format::Str`) — not `current-tracks/
audio/id`, tried first and found to never re-notify for a genuinely audio-less file
(unavailable before *and* after load isn't a value transition mpv bothers to re-signal;
measured directly, `tests/sources.rs::has_audio_reflects_real_track_presence`). `aid`
always holds a real value (`"auto"` pre-resolution, then a track number or the literal
`"no"`), so it reliably transitions even on the very first load. The observation is
*ignored* while `no_audio` is on (an observed `"no"` then says nothing about the file,
only about our own request) — `has_audio` keeps whatever it last knew until `no_audio`
is off again and `aid` re-resolves for real. `None`/unknown (no file loaded yet, or no
notification seen for this load) reads `true` (the schema default) — the conservative
"don't falsely skip a real wait" choice. `arm_audio_flowing` fires immediately (no wait)
when `has_audio == Some(false)`, same bucket as `no_audio`/image/stepped above;
the one predicate, `crate::onset::has_audio` (`kind == video && !no_audio && has_audio !=
false`), carries the same check for the recipe and the runtime (final review M12 merged the
copies).

**Render targets: front + back.** `front` is what `texture()` returns. Until the current
load is `Ready`, every frame (including any leftover of a superseded load) renders into a
staging `back` target; at `Ready` the back is promoted to the front in the same `update`
that pushes the event — so the texture at `Ready` is the new file's first frame, and
until then the front still holds the old file's last frame (never a blank, never a stale
redraw). After `Ready`, frames render straight into the front. Size: native display size
(`dwidth`/`dheight`, observed), capped at 4096 on the long edge (aspect kept); a target is
reallocated on a size change — render into the new one, swap only on success (a failed
render keeps the old frame). After each render `reset_gl_state` unbinds FBO/program/VAO/
buffer/texture, disables blend + scissor, resets colour mask and pixel-store alignment —
libmpv leaves its own state behind.

**Wakeup contract (Task 12 polls this).** `mpv_set_wakeup_callback` and
`mpv_render_context_set_update_callback` both `write(2)` to one `EFD_NONBLOCK` eventfd
(the fd number is the callback context — no allocation, no mpv calls in the callback);
`MpvSource::wake_fd()` exposes it. On readability call `poll_events()` **and**
`update()`; each drains the fd first, then pumps every queued mpv event
(`wait_event(0)` — events and async replies), so a signal arriving mid-call re-arms the
fd and nothing is lost. `update` uses `mpv_render_context_update` (level-triggered
`UPDATE_FRAME`) and renders only when a frame is waiting, with
`BLOCK_FOR_TARGET_TIME=0`; no `ADVANCED_CONTROL`.

**Teardown with GL current (liascape-transition gotcha).** `mpv_render_context_free` must run
with its GL context current and before `mpv_terminate_destroy`. Sources get no `&Gfx` in
`Drop`, so they hold a `gfx::GlKeepAlive` (`Gfx::keep_alive()`): an `Rc<Shared>` clone
(same pattern as `WindowTarget`) that keeps the EGL context alive past the `Gfx`, plus
`make_current()` (a guard that restores whatever was current before; a no-op when the
context already is), `is_for(gfx)`, and `glDelete{Textures,Framebuffers}` pointers.
`MpvSource::drop`: make current → free render ctx → delete both FBOs/textures → clear
wakeup cb → **hand the core to the reaper** → close eventfd (in `open`, the eventfd is
created before the core so error-path locals drop in the same order). **Teardown never stalls the loop (R51), in
two phases.** (1) When a node goes, `SourceHost::sync` calls `Source::begin_teardown()`
(default: `true` = drop now). `MpvSource` sends `stop` (async) and returns `false`: the
host moves it to a `dying` list (no longer in `ids`/`texture`/`wake_fds`; silent from the
stop on). (2) `SourceHost::update` drops it once `teardown_ready()` — mpv idle after the stop
(idle ⇒ the VO is uninitialised), the core dead, or 500 ms (`TEARDOWN_MAX`). "Idle" is
decided from event order, never from a stale initial value (item 14): the `stop` is only
sent once the last gain push reached mpv (stopping cuts the audio — the final −96 dB lands
first); at its reply the core counts as idle if no START_FILE was ever seen (a START_FILE
would precede the reply, so no VO exists) or the last file ended and `idle-active` = true
was reported *after* that END_FILE; otherwise the stop's own END_FILE + an `idle-active`
notification after the reply are waited for. `rapid_create_destroy_never_stalls` (20×
create + destroy at once, before the VO is up) guards it. Then `Drop` frees the render
context — fast now: with the VO live, `mpv_render_context_free` waits on the playloop
(**measured 21–32 ms** for a playing 1080p clip) — and hands the core to the **reaper**
(`sources/reaper.rs`): one background thread runs `mpv_terminate_destroy` (30–240 ms
measured), started on first use, then `malloc_trim(0)` once its queue is empty (§ Memory); the wakeup callback is cleared first (mpv invokes it
under the same lock, so nothing writes the eventfd after that). `reaper::shutdown(timeout)`
(`quit`: after `SourceHost::finish_teardown(500 ms)`, ≤ 2 s) closes the queue, waits and
returns the stragglers (logged `mpv.reaper_stragglers`); later drops destroy
synchronously. **A straggler is a core not destroyed yet, never a trim (TODO "Reaper trim at
shutdown"):** once shutdown has started no batch is trimmed (the process is exiting), and a trim
already running when the wait ends doesn't count — `shutdown` reports `undestroyed`, while
`pending()` (probes, t20b) still drops only after its batch's trim. Before, `PENDING` dropped after
the trim, so a slow trim during `quit` read as a straggler (and the `_exit` path). The reaper is a
generic `Reaper<T>` (one `lia-mpv-reaper` instance) so its rules are unit-tested with slow fakes:
`a_trim_in_flight_at_shutdown_is_no_straggler` (RED: 1 straggler), `no_trim_once_shutdown_started`
(RED: waited 580 ms for a 200 ms destroy + a 400 ms trim), `a_destroy_slower_than_the_wait_is_a_straggler`,
`batches_trim_once_and_reap_after_shutdown_is_synchronous`. `reaper::pending()`/`SourceHost::dying()` for probes. Pinned by
`tests/api.rs::destroy_never_stalls_the_loop`: max loop busy around the destroy of a
playing video 1.7–3.0 ms (5 runs); RED with a synchronous core destroy 29.6 ms, with the
reaper but a one-phase drop 21–32 ms (flaky against the 20 ms bound). Drop order vs the `Gfx` is irrelevant —
pinned by `source_outlives_gfx_safely`; dropping with another context current switches
and restores (`update_with_foreign_context_is_refused`). If the context somehow can't be
made current, the core is sent `stop` (silent), both callbacks are cleared, and it's
leaked rather than freed against the wrong context.

**Fence-leak mitigation** (technique from mpvpaper 1.9, PR #132 by manv-3, GPL-3.0;
credited in Task 19): the `get_proc_address` given to `mpv_render_context_create` returns
a stub for `glFenceSync` that returns 0 (a null sync); everything else comes from
`eglGetProcAddress`. libmpv's render-API path otherwise accumulates sync objects. **Why
it's safe:** mpv null-checks the fence before storing it or calling `glClientWaitSync` on
it, and `glDeleteSync(0)` is a GL no-op — so the stub just turns fence bookkeeping off.
What mpv's fences actually guard is buffer reuse: (a) direct rendering (`vd-lavc-dr`),
which on the render API needs `MPV_RENDER_PARAM_ADVANCED_CONTROL` — never passed; (b) PBO
uploads (`opengl-pbo`), where a PBO could be rewritten while the GPU still reads it —
pinned `opengl-pbo=no` (mpv's default) in `open`. **Neither may be enabled while the stub
is in place.** `sources::mpv::fence_stub_calls()` counts stub calls;
`fence_sync_stub_is_used` proves libmpv really calls it, and `first_frame_and_ready`
checks no GL error is left behind.

**Stepped mode (`opts.stepped: true`, Task 12, R48).** The core is paused for good
(`pause=yes` set before the first load); `paused` and `position` applies are **stored
only** (logical — what the graph says, mirrored back unchanged; observed `pause` is not
mirrored), and `eof-reached`/EOF never emit `Ended`. The runtime drives frames:
`step_seek(t)` sends `seek <t:.6> absolute exact` (async), and `step_status()` is `Done`
once the seek's reply, then a PLAYBACK_RESTART and the target frame have been seen
(mpv completes the `seek` command before the playloop executes it, so the reply always
precedes that seek's restart). **The frame may come before the restart:** mpv queues it to
the VO in the playloop iteration that then emits PLAYBACK_RESTART, so the loop can render it
before it pumps the event (under load: every step) — a **new** frame (not
`next_frame_is_redraw`) rendered after the reply counts (`StepSeek::target_frame`), as does any
frame after the restart; a redraw before the restart is the previous step's picture and never
counts; completing on that early frame, the restart handler reads `time-pos` once
synchronously (stepped only: the core is paused and its frame rendered) so the step still
returns a settled state. Before, only a frame after the restart did — mpv's redraw of the
target, which didn't always follow (2.8 s into a 3 s clip with its loop off: `step` timed
out, 8/8 loaded runs). A source the step had to wait to **open** gets a fresh `STEP_TIMEOUT`
for its seek once ready (`StepWait::opened` — under load an open alone took ~2 s).
`Pending(what)` meanwhile, `Broken(reason)` for a load error
/ rejected seek / dead core (not waited on). `step_end(at_end)` queues `Ended` when the
virtual time first reaches a non-looping end (a paused exact seek to the end never sets
`eof-reached` — measured) and re-arms it once back before the end. `step_target()`,
`is_ready()`, `is_stepped()` for the runtime/probes. `Source::as_mpv`/`as_mpv_mut`
(default `None`) + `SourceHost::mpv`/`mpv_mut`/`wake_fds_by_id`/`open_failed` reach it.

**`ColorSource::new([r,g,b])`** (0–255, the graph's `color`): a 1×1 `RGBA8` texture
(LINEAR + CLAMP_TO_EDGE → the colour everywhere), created lazily on the first `update`
(construction has no `Gfx`) and repainted only when `color` changes (never through a
foreign context). `Ready` is queued at construction (first `poll_events`). Every other
writable property is accepted and stored (so an alias/global `set` never fails on a
colour layer) and does nothing.

**`SourceHost` (`sources/host.rs`, R32) — the only place a graph node becomes a live
source.** `SourceHost::new(base_opts)` (merged into every `MpvSource::open`, e.g. `{"ao":
"null"}` in tests). Per loop iteration, in this order: `sync(gfx, graph, changes)` drops
sources whose node is gone, opens one for every new `Source` node from `props_of` (`color` →
`ColorSource`, `snapshot` → `SnapshotSource` of `of`'s *current* texture, `scene` →
`SceneSource` (Phase 2 Task 5 — then every scene's demand, § Scene worker), else `MpvSource`;
colour/snapshot get every writable prop applied so `read` agrees with the node), then
forwards each drained change to `apply` (skipping sources it just opened — their props
already include it); a refused `apply` is logged (`source.rejected`) and queued as
`SourceEvent::Rejected` (R45), a failed open as `SourceEvent::Error` (not retried until the
node goes). `update(gfx, graph)` updates every source, collects its events, then mirrors
observed values (`kind` — MpvSource's inferred/corrected image|video —, `ready`,
`duration`, `time_pos`, `width`, `height`, `paused`) with `Graph::set_observed`. **`sync` must precede `update`** each iteration, or the mirror would
overwrite a command not yet forwarded. **Only changed values are written** (Phase 2 Task 14): each
hosted source remembers what it last mirrored per prop and skips an unchanged one; the memory is
cleared whenever a change is forwarded to that source (`sync`'s applies, `force_paused`, the R75
recompute), so a `set` the source refuses is still mirrored back. A scene updates every frame, and
nine `format!` + path-resolve + `set_observed`s per update were the largest share of the
compositor's CPU per scene worker (perf, on-machine); measured two synthetic workers at 240 + 144
fps, headless: process 19.2 / 19.6 % → 15.4 / 15.0 %. The mirror writes through
`Graph::set_observed_on(id, prop, v)` (exact id: no path `format!`/split/resolve — F6b).
`update_only(gfx, graph, ids)` is `update` for those ids only (F6b: a wake's update — below). `events()` drains `(node id, event)`; `texture(id)`
is the compositor's closure; `wake_fds()` (mpv sources) is what the runtime polls; `get`/
`ids` for probes/tests.

**Per-frame cost (F6b, 2026-10-29).** Each worker frame is a loop wake (twice when its fence
hadn't signalled at the `Frame`), so everything a wake does is paid per worker per frame — at
the refresh, ~200 times a second per worker. What a wake does now, and why:
- **Only the woken source updates.** The calloop callback of a source's wake fd records its id
  (`Runtime::woken`); `after_dispatch` runs `update_woken_sources` → `SourceHost::update_only`
  (+ those scenes' envelopes and visualiser input); the tick (every refresh of the fastest
  output) still updates every source (`update_sources`, which also forgets gone ids). Before,
  every wake updated every source — a `recvmsg`, an `epoll_wait`, the mirror reads per scene:
  work per worker that grew with the number of workers.
- **`sync_sources` only when due** (`Runtime::sync_due`): a pending graph change, a
  `picture_rev`/`demand_rev` move since the last sync, `SourceHost::sync_pending` (an async open
  in flight, a low-VRAM stop/resume), a pause gate, a retire or a settling park, or the stepped
  clock. Otherwise only `arm_gain_timer_if_needed` runs. The tick's own `sync_sources` is
  unconditional, so anything internal still runs at the tick rate.
- **What each output shows is cached** (`redraw::Routes`, rebuilt only when `Graph::demand_rev`
  moves): `mark_shown_gated`, `mark_nodes`, `animating_on` and `scene_paces_output` read each
  output's `shown`/`nodes`/`scene_fps`/`refresh_hz` from it instead of re-deriving them from the
  graph (path `format!`s, alias resolution, cloned strings) per output per wake — Wayland's
  `render_paced` asked on every iteration for every ready output.
- **A scene's update reads only what is ready** — `epoll_drain` says whether the worker host's
  epoll fd fired; `WorkerHost::poll_io(now, io)` then `epoll_wait`s its own set and reads only
  the socket / output pipe that are readable (before: a `read` and a `recvmsg` that found
  nothing on every poll), and `waitpid`s every poll only once the worker is ending (socket or
  pipe EOF, killed), else at most every `REAP_CHECK` (100 ms). The GL context is made current
  only for what needs it (events, a queued frame, the preview): on NVIDIA `eglGetCurrentContext`
  alone is a `getpid` syscall.
- **No `eglWaitSync` on an acquire fence that has signalled.** A `Frame` whose fence already
  polls readable drops it at once (no epoll entry to add and remove, no poll at the latch); a
  latched fence is only taken off the epoll set. The spike's "free safety net" cost ~10 syscalls
  (fd dups, `getpid`) and a semaphore ioctl per frame on NVIDIA.
- **A soundless scene's gain pushes are only folded** (`SceneSource::send_gain`: `has_audio`
  false → `WorkerHost::fold`, no message) — its worker never opens a stream, and a fade pushed it
  a message per millisecond; `gain_sent` stays what the worker last got, so a later `HasAudio
  {on: true}` (or a restart's `Ready`) sends the current value.
- **Fewer allocations per write:** `props::schema_for` reads a table built once per kind
  (`schema_table`) instead of rebuilding the whole schema per lookup; `Graph::apply_set`
  overwrites an existing key in place; the dropout probe's 1 kHz gain history reads
  `Graph::source_gains_db` (no id clones).
Measured (`scenes.sh transport`, 4 synthetic workers mid-fade at 144 + 240 Hz, headless, excess
user + kernel instructions over the colour fade): 0.40–0.42 → 0.14–0.21 G/s; main-thread
syscalls per worker frame ~56 → ~29 (`perf trace`). What is left per frame is the transport
itself: the `Frame` `recvmsg`, the `Tick` and `Release` `sendmsg`s, and the release fence —
NVIDIA's `eglCreateSync` + `eglDupNativeFenceFDANDROID` alone is ~12 syscalls (fd dups,
`getpid`) plus a semaphore ioctl. Tried and dropped: a worker thread that waits for each
frame's fence and sends the `Frame` after it (one compositor wake per frame instead of ~1.5) —
no gain left in the compositor's instructions once a wake was cheap, for +2 worker context
switches per frame.

**Async opens (final review I5).** With `SourceHost::set_async_open(Some(waker))` (the
real-clock runtime; its waker is a calloop ping) a new mpv node's core is made on an `lia-open`
thread (`MpvSource::prepare_core`, base opts only); the node is `opening` (not hosted: no
texture, no events, `open_failed` false) until a later `sync` finds the worker's result and
opens the source from the node's **current** props (so a change made meanwhile is never lost);
a worker error is the same `SourceEvent::Error` + `failed` as a synchronous one; a node gone
meanwhile drops the result (`PreparedCore::drop` → reaper). `finish_teardown` waits (bounded)
for outstanding workers; `host::opening_pending()` counts toward `mpv.reaper_stragglers`. R29
`Ready` semantics are unchanged (still the first frame of the current load). Stepped mode and
the harnesses open synchronously. **Bounded (TODO "No explicit cap on concurrent `lia-open`
worker threads"):** the cores are made by `host::OpenPool` — a FIFO queue served by at most
`MAX_OPEN_WORKERS` (2) `lia-open` threads, spawned on demand and gone once the queue is empty
(an idle player has none); before, every create spawned its own thread (a burst of 16 = 16 at
once). A queued job holds its slot **weakly**: a node destroyed before a worker gets to it is
skipped (no core made — `open_pool.skipped`), so a switch storm's superseded B's cost nothing; a
running one holds it strongly (a node gone meanwhile drops the result → reaper, as before); a
prop changed while queued lands because the source still opens from the node's current props.
`finish_teardown`'s wait is then the ≤ 2 cores in progress. A job that panics doesn't kill its
worker; a pool that can't start a thread with none running hands the open back (synchronous).
**Measured** (release, hermetic headless, a burst of 16 paused 1080p creates, 3 rounds per cap):
all made + opened 102–166 ms at cap 1, **61–80 at 2**, 58–71 at 4, 23–70 uncapped; all ready ~0.5 s
whatever the cap (first frames dominate); the loop's longest open share 3–5, **2–8**, 11–24, 13–29
ms (more finished cores land in one `sync` the higher the cap). Guards: `tests/api.rs::
i5_open_burst_is_capped_and_none_lost` (16 creates in one write: peak ≤ 2, every kept one opens
and readies, the 3 destroyed while queued are skipped or opened-and-retired — measured: all 3
skipped —, the one un-paused while queued plays, quit with a second burst queued exits in ~40 ms
with no straggler; RED before: 16 at once), unit `open_pool_caps_concurrency_in_order_and_loses_none`,
`open_pool_survives_a_panicking_job_and_restarts_after_idle`.

**Render worker (Phase 2, `sources/render_worker.rs`; `serve --render-worker on|off`, env
`LIASCAPE_PLAYER_RENDER_WORKER`; **default on** since 2026-10-26 — `off` renders every source on the loop as before).** `lia-render` threads (**lanes**, below) own
every *worker-mode* `MpvSource`'s render context — creation, the first render (shader compile,
LUTs), every later render, the free — so the loop only adopts finished textures and composes.
- **Context.** `Gfx::share_context` makes another context on the **same** `EGLDisplay` (one per
  process, refcounted terminate — § GFX / EGL), same config, `share_context` = the compositor's;
  each lane makes its own current **surfaceless** for its whole life and loads its **own** glow (real
  `glFenceSync`/`glClientWaitSync`). mpv still gets `get_proc_address` with the fence stub;
  `opengl-pbo=no` stays.
- **Lanes (2026-10-27, with zero-copy hwdec).** A render context is bound to the context it was
  created on, and its creation blocks that lane — with the hwdec GL interop that is the interop's
  init (a CUDA context, 85–220 ms per attach measured). On ONE thread the playing wallpaper froze
  for it at every switch (A's longest frame interval while B opened: 34 → 66–74 ms at 30 fps).
  So with an interop the worker runs `render_worker::RENDER_LANES` (3; env
  `LIASCAPE_PLAYER_RENDER_LANES` 1–6) lanes, each its own thread + context + eventfd, and
  `RenderWorker::attach` puts a new source on the lane with the fewest live sources (`Inner::live`,
  counted by the callers — an attach on its way counts; ties → the first): B's attach and later A's
  free (`mpv_render_context_free` destroys the CUDA context too) run beside A, never in front of it
  (A's longest interval back to 34–54 ms, as in copy mode). Two lanes cover one wallpaper on
  every output (ping-pong), the third a switch while the previous A still fades out or a second
  wallpaper on another output; a source never moves. Without an interop (`hwdec_interop` null:
  not NVIDIA/AMD/Intel, or `LIASCAPE_PLAYER_HWDEC_INTEROP=off`) an attach costs < 1 ms and the worker
  runs one lane, as before. Cost per extra lane: a thread, ~4.5 MiB RSS, 50–110 ms more at
  startup (its first `eglMakeCurrent`, before `player.started`). `Attached {id, lane, ex, worker}`
  frees/wakes on its own lane; `died`/`shutdown`/`stats` cover every lane (`stats` sums counts,
  maxes timings, and lists `lanes: [{slots, live, attaches, attach_ms_max, renders, frees,
  free_ms_max, exited}]`). `render_worker.attach` / `.free {lane, ms}` / `.first_render {lane,
  slot, ms}` (info from 100 ms, else debug); `ATTACH_WAIT` 10 s (was 3: the process's first interop attach once took > 3 s on a
  heavily loaded machine — the transition waits 10 s for B anyway).
- **Split.** The loop keeps the core: event pump, async applies, `read`, load fencing, Ready, the
  front/back textures it shows. The `lia-open` job hands its freshly prepared core to the worker
  (`RenderWorker::attach`, the job waits) which creates the render context with the update callback
  on the worker's eventfd, then the loop's `open_with_core` only applies props + `loadfile`.
- **Hand-off (per source `Exchange`, a mutex never held across an mpv call).** Loop → worker: the
  target size (observed `dwidth`/`dheight`, capped), textures given back. Worker → loop: the
  newest complete frame (an unadopted older one goes back to the free list — the latest COMPLETE
  frame wins), a render error. The worker renders only into textures it owns (never the loop's
  front/back/unadopted frame); after each render `glFenceSync` + `glFlush`, it waits on that fence
  itself (client wait, bounded) and only then publishes + writes a `dup` of the source's eventfd.
  The loop adopts a frame only when `glClientWaitSync(fence, 0, 0)` reports it signalled (else it
  keeps the previous one and re-checks next iteration) — never a half-rendered frame; the sampler
  re-binds the texture (GL share-group visibility rule). A texture the loop sampled (a replaced
  front) goes back with a **release fence** (+ `glFlush`) that the worker `glWaitSync`s before
  rendering into it again. `SnapshotSource` blits `texture()` = an adopted (complete) front.
- **Load fencing / Ready.** Every frame is tagged with the number of FILE_LOADED events mpv had
  emitted when its render started — counted by the worker through a **weak client** on the core
  (`mpv_create_weak_client`, every event but FILE_LOADED masked off, no observed properties, so its
  `wait_event(0)` never touches the core lock); the loop counts the same broadcast events and a
  frame is "of the current load, rendered after its FILE_LOADED" iff its tag equals the count at
  the current load's FILE_LOADED. Same rule as the loop renderer, but on mpv's own event order
  instead of the loop's pump time — a single-frame image/paused clip whose only frame the worker
  rendered before the loop pumped FILE_LOADED would otherwise never become Ready. front/back
  promotion, orientation (FLIP_Y = 0) and `reset_gl_state` (on the worker's context) unchanged.
  A size change re-renders mpv's current frame at the new size (tagged like the frame it redraws).
- **Teardown.** Two-phase as before; `Drop` clears the core's wakeup callback and hands the core +
  every texture it holds to the worker (`Free`): render context freed with the worker's context
  current, weak client destroyed, textures/FBOs deleted, then the core to the reaper — no GL on the
  loop. A `PreparedCore` dropped with a render context attached goes the same way. `quit`:
  `finish_teardown`, then `render_worker::shutdown`, then `reaper::shutdown`.
- **Real clock only** (like async opens): stepped mode and the harnesses render on the loop
  (`stepped_is_deterministic` untouched); a source opened synchronously in real-clock mode renders
  on the loop too — the two modes mix per source. Audio is untouched.

**Audio re-route (final review I7).** `SourceHost::set_audio_route(device, bias)` — the bus went
down (`None`: mpv's default device) or came back (`Some(bus device)`, bias = −latency): base
opts change for new sources, every hosted mpv source gets `MpvSource::set_audio_route` (async
`audio-device`, a changed `audio-delay`, then `aid no` + `aid auto` — a dead server takes mpv's
AO with it and mpv deselects the track, so an `audio-device` change alone left
`current-ao` unset; measured), and a core still being prepared with the old route is re-routed
when it opens.

**`SnapshotSource` (`sources/snapshot.rs`)** — a still copy (`glBlitFramebuffer`, row order
kept → image-top at `t = 0`) of another source's texture taken at creation; `Ready` at
once; never changes; no audio. It exists because pausing doesn't freeze a texture: a paused
mpv still presents its queued frames (measured 2–3 frames, ~100 ms after the pause, with
`time_pos` already frozen). The transition recipe holds reveal/frozen pictures with it.
Pinned by `tests/sources.rs::snapshot_copies_frame_and_orientation` (pixel-identical,
image top at low y, constant while the source advances).

**Tests (`tests/sources.rs`) — always `ao: "null"` (R26)**, so a run is silent on the
owner's speakers; `audio-params`/`current-ao` still populate with the null AO. Raw mpv
reads after an `apply` first `settle()` (pump until `requests_in_flight() == 0`). Media
come from `tests/common::ensure_clip(name, ClipSpec)`: ffmpeg from PATH →
`target/test-media/`, generated once (regenerated only if the `<name>.spec` stamp
differs), via a temp name + rename, serialised by a mutex. Videos are 1920×1080@30
`libx264` `yuv420p`, built in `rgb24` and converted once with an explicit BT.709
limited-range matrix **and tagged** so mpv decodes with the same matrix — solid colours
come back within ±3 (YUV round trip + mpv's output dither), `FrameIndex`'s neutral-grey
`(n,n,n)` marker within ±1 (ffmpeg itself decodes frame 119's marker as 118). Audio for
`Solid` is PCM s16le (exact level).
