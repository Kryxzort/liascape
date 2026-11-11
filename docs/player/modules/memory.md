<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Memory

`src/mem.rs` + `src/probe/memory.rs` + the reaper (Task 20b). **The allocator policy**
(`mem::apply_policy`, the first line of `runtime::serve`, before any mpv core exists; the outcome is
logged as `mem.policy` right after `log::init`, Warn on an unknown `LIASCAPE_PLAYER_MALLOC` value):

- **Fixed mmap threshold, `mem::MMAP_THRESHOLD` = 128 KiB** (`mallopt(M_MMAP_THRESHOLD)`,
  which also turns glibc's dynamic adjustment off). glibc starts at 128 KiB but raises the
  threshold to the size of any mmapped chunk that is freed (≤ 32 MiB): after the first mpv
  core is destroyed, a 1080p frame-pool buffer (~3 MiB) or demuxer block no longer gets its
  own mapping but comes from one of ~57 per-thread arenas (8 × cores max), and an arena
  keeps what it frees. Fixed, an allocation ≥ 128 KiB that no free chunk of its arena fits
  gets its own mapping (fresh `mmap`, unmapped by `free`) instead of growing the arena. The caller's own choice wins (`MALLOC_MMAP_THRESHOLD_`, or
  `glibc.malloc.mmap_threshold` in `GLIBC_TUNABLES`).
- **`malloc_trim(0)` after each reaper batch** (`mem::trim_after_reap`, on the
  `lia-mpv-reaper` thread once its queue is empty — never the loop): the smaller chunks a
  destroyed core frees still fragment the arenas (+0.35 MiB retained per switch with the
  threshold alone); the trim returns those pages. Measured ≤ 2.4 ms (1.4 ms mean) per
  switch with the threshold in place; `mpv.trimmed {ms, released, rss_kib}` (debug). Skipped
  once `reaper::shutdown` has started (exiting — § Sources "Teardown").
- **No arena cap.** `M_ARENA_MAX` 4 on top changed little (373 vs 380 MiB after 300
  switches) and adds lock contention across the ~30 decoder/demux/audio threads.
- **`LIASCAPE_PLAYER_MALLOC=glibc`** skips the whole policy (A/B; the regression test's RED run);
  `memory` probe `policy.applied` says which is in effect.

**Measured** (hermetic headless, 2 × 1080p outputs, `--ao null`, a fade to an alternating
1080p30 clip every 1 s): 200 switches with glibc's defaults grew RSS 159 → 922 MiB while
malloc's in-use bytes stayed flat at ~300 MiB and its free (retained) bytes went 1 → 614
MiB — allocator retention, not a leak; `hwdec=auto` (mpv picks `vulkan-copy` here)
1.2–1.6 GiB. With the policy: 364 → 380 MiB over 300 switches (`hwdec=auto` 451 → 457 MiB
over 200). CPU: idle playback unchanged (13.75 vs 14.03 s per 60 s); a 1 s switch loop costs
~4 % more process CPU (161.7 → 168.1 s per 313 s, ~21 ms CPU per switch: fresh pages for each
new core's pools + the trim). Diagnose
with the `memory` probe: *live* (`in_use_bytes + mmap_bytes`) flat + `free_bytes` growing
= retention; live growing = a real leak (then `loop` → `bounds`, `reaper_pending`,
`dying_sources`, `opening`; growing on Wayland only, per *present* rather than per switch —
minutes without a switch grow as fast — = an event queue nobody dispatches, § Wayland →
NVIDIA notes, Task 20e). Guard: `tests/api.rs::t20b_switch_loop_rss_stays_flat` (20
fades between two 1080p clips: RSS growth over the last 16 < 10 % and an on-demand trim
gives back < 5 % of RSS — near-vacuous under the policy, growth is the meaningful check; with `LIASCAPE_PLAYER_MALLOC=glibc` 32 % / 13.6 % → fails).
`docs/player/debugging.md` row "RSS grows per switch".
