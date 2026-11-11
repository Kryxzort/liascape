<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## liascape-player (the "utopia player")

`liascape-player` is the Rust crate (binary + lib, edition 2024) that will replace mpvpaper +
`liascape-transition` + per-monitor LWE + `liascape-audio` with one process that owns every wallpaper
type, on every monitor, with every transition. Design: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`.
This file covers only what exists in the crate so far; later tasks append their own
sections below as they add modules (clock, graph, gfx, mpv, sources, recipes, api,
wl, headless, audio, probe, supervise, runtime — see the design's §file map).

**The core invariant (everything else follows from this):** never hand an audible or
visible stream from one owner to another — only ramp gains/opacities on streams that keep
running. A stream that will be heard starts silent and ramps up; a stream is only
destroyed after being ramped to silence. If this holds, dropouts and visual seams can't
happen regardless of timing.
