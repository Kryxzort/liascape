# Upstream tracking

`lp-player` (`src/player/`, `docs/player/architecture.md`) absorbs techniques from other GPL-3.0
Wayland wallpaper tools and compiles the MIT `gl-transitions` GLSL catalogue. This file is the
single source of truth for what came from where, how recently it was reviewed, and how to catch
up — `scripts/gen-credits.py` reads it (plus `patches/*/*.patch` headers, once any exist) to
generate `CREDITS.md`. Layout and crediting rules: design spec
`docs/superpowers/specs/2026-10-20-utopia-player-design.md` §7.

Do not hand-edit `CREDITS.md`; edit this file (or a patch header) and run
`python3 scripts/gen-credits.py`.

---

## mpvpaper

- **Project**: <https://github.com/GhostNaN/mpvpaper>
- **License**: GPL-3.0
- **Relationship**: **absorbed, not vendored.** mpvpaper is small (~2k lines of C); its value to
  this project is proven techniques, not code to pull in wholesale. No mpvpaper source file is
  copied into this repo — each row below is reimplemented in Rust against its own measured
  constraints, documented in full in `.claude/rules/player-core.md`.
- **Last reviewed**: commit `fc5ed28` (2026-08-28). A periodic look at mpvpaper's changelog
  replaces a code sync — there is nothing to merge, only techniques to notice.

### Adopted techniques

| Technique | Where (file:symbol) | Source | License |
|---|---|---|---|
| Fence-leak mitigation: hand libmpv's render API a `get_proc_address` whose `glFenceSync` always returns a null sync, so mpv's fence bookkeeping for buffer reuse (direct rendering / PBO uploads) turns into a no-op instead of accumulating real GL sync objects — safe only because neither direct rendering nor PBO uploads are enabled here | `src/player/src/sources/mpv.rs:stub_fence_sync` | mpvpaper 1.9, [PR #132](https://github.com/GhostNaN/mpvpaper/pull/132) by manv-3 | GPL-3.0 |
| One `wlr-layer-shell` surface per output, each independently configurable | `src/player/src/wl.rs:WlState::make_surface` | mpvpaper's per-monitor launch model | GPL-3.0 |
| Configurable layer-shell layer (background / bottom / top / overlay) | `src/player/src/wl.rs` (`out:<connector>.layer` property, `.claude/rules/player-core.md` § Wayland) | mpvpaper's `-layer` flag | GPL-3.0 |
| Auto-pause / auto-stop when the wallpaper is hidden, and pause when a window is fullscreen/maximized/active (`wlr-foreign-toplevel`) | **not implemented yet — Phase 3**, `docs/player/architecture.md` § 6 | mpvpaper's `--auto-pause` / `--auto-stop` | GPL-3.0 |

### How to resync

1. Check mpvpaper's commit log past `fc5ed28` for anything touching: the render-API fence
   workaround, layer-shell surface setup, `-layer`, or the auto-pause/auto-stop toplevel logic —
   those are the only parts of mpvpaper this project tracks.
2. If a technique above changed (e.g. the fence stub becomes unnecessary on a newer libmpv, or
   mpvpaper adds a new per-output capability worth having): update the row above, re-verify the
   corresponding Rust code against the new measurement (the "why it's safe" reasoning in
   `.claude/rules/player-core.md` § Sources "Fence-leak mitigation" must still hold), and bump this file's
   *Last reviewed* commit + date.
3. Nothing here is a patch to re-apply — there is no mpvpaper source in this tree to diff against.
   "Resync" means re-reading mpvpaper's source for the four techniques above, not merging commits.

---

## linux-wallpaperengine (LWE)

- **Project**: <https://github.com/Almamu/linux-wallpaperengine>
- **License**: GPL-3.0
- **Status**: **vendored in Phase 2 at `next-v2`** — see `docs/player/spikes/lwe-core.md` for the
  Phase 0 spike that proved building LWE's `core` library offscreen and the local patches it
  already found necessary (CMake version detection without `.git`, a stray `gmpxx.h` include, a
  glm include dir, a host audio-output driver for dB gains). Nothing is vendored into this repo
  yet; today scenes are simply skipped under `PlayerEngine=lp-player`
  (`docs/player/architecture.md` § 2, § 6).

### Adopted techniques

*(none yet — nothing is vendored. This section is populated once Phase 2 vendors `third_party/lwe/`
and patches start landing in `patches/lwe/`.)*

### How to resync (once vendored)

1. Pin the exact upstream commit of the `next-v2` branch (today `ddea3b4`, 2026-08-03) in
   `third_party/lwe/` and this file.
2. Bump the pin → re-apply every `patches/lwe/NNNN-*.patch` in order (scripted) → fix conflicts.
3. Rebuild the scene worker and run the scene corpus runner (design spec §11 "Testing approach")
   over the owner's Workshop folder `431960` — same set of scenes must start, none newly blank.
4. Re-check the candidate upstream PRs worth importing as patches (design spec §7): #692
   (particle "None" on text objects), #625 (puppet-warp skeletal animation), #677 (Wayland
   outputs locked to half refresh), #631 (hardening binary parsers against malformed Workshop
   assets), #694 (PulseAudio capture-stream leak) — upstream has merged nothing since 2026-06-20,
   so these likely still apply as-is.
5. Record the new pinned commit and date here.

---

## gl-transitions

- **Project**: <https://github.com/gl-transitions/gl-transitions>
- **License**: MIT (`transitions/LICENSE.gl-transitions`; per-effect license in `transitions/manifest.json`, MIT when none is given)
- **Relationship**: **bundled, not vendored as source.** `transitions/` holds the already-bundled
  GLSL effect catalogue (122 of 125 upstream effects), regenerated from a gl-transitions checkout
  by `scripts/generate_transitions.py` (strips headers into `transitions/manifest.json`, rewrites each
  `uniform` into a `const` with its parsed default, wraps with the shared GLES/WebGL2 template,
  validates with `glslangValidator`). `lp-player` is a second consumer of that same bundle
  (`transitions/` is shared with the Electron UI's live previews) — it never edits `transitions/`
  itself, only adapts the bundle at load time.

### Adopted techniques

| Technique | Where (file:symbol) | Source | License |
|---|---|---|---|
| Compile the bundled gl-transitions catalogue as desktop-GL 3.3 core programs: rewrite the shared `#version 300 es` header to `#version 330 core`, splice each effect body into the wrapper template, bind `fromTex`/`toTex`/`progress`/`ratio` per the manifest | `src/player/src/gfx/effects.rs:Catalogue::{load,program}` | gl-transitions catalogue via `transitions/` (122 effects, see `transitions/README.md`) | MIT |

### How to resync

1. Re-run `scripts/generate_transitions.py <path to a fresh gl-transitions checkout>` to refresh
   `transitions/` (this regenerates the bundle every consumer shares — do this once, not per
   consumer).
2. Run `src/player/tests/effects_all.rs` (`cargo test --test effects_all`, from `src/player/`) — it compiles every
   catalogue entry under desktop GL 3.3 core and fails loudly if a new effect body needs a
   compatibility shim `Catalogue::program`'s assembly step doesn't yet provide
   (`.claude/rules/player-core.md` § Effects "Measured: no compatibility shim needed...").
3. Re-run the UI's own effect preview check (`app/ui`) — the same regenerated `transitions/` feeds
   both consumers from one source of truth.
