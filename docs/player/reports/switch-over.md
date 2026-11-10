# Switch-over checklist — the design's §11 bar, measured

The design (`docs/superpowers/specs/2026-10-20-utopia-player-design.md` §11) says `PlayerEngine`'s default flips to
`liascape-player` and the legacy path is deleted (Phase 5) only when all of its criteria hold **on the owner's
machine**. This report turns each criterion into rows that can be checked, says how each is measured, and gives the
latest measured result with its evidence. Status: **pass** (measured, meets the bound), **fail** (measured, misses it
— with the fix or the plan), **owner-only** (needs the owner at the machine or their real outputs; the exact command
is in § 4).

Measured 2026-11-05 on `lp-player` [[HEAD]] (the switch-over branch: fd386d5 + the seam probe and test hardening of
§ 3). Machine: i9-12900K, RTX 3070 Ti (NVIDIA 595.84), Hyprland, DP-1 143.98 Hz + DP-2 239.76 Hz. Every run here is
**headless** (virtual outputs) on a **private PipeWire** (own runtime dir, one null sink): nothing touched the owner's
outputs or audio. The machine was shared throughout — the owner's live player (a 1.7 GB scene worker, the GPU at
100 %), the desktop apps, other agents' suites (load 10–24) — so timing numbers are upper bounds.

## 1. Summary

[[SUMMARY]]

## 2. The checklist

### Criterion 1 — zero dropouts and zero visible seams across the compose matrix (≥ 50 consecutive switches per mode)

"Dropout" = the built-in detector (`probe.dropout`, debug mode: the bus monitor against the gain schedule × the
decoded content; drops ≥ 35 dB under for ≥ 2 ms, 10 ms bins ≥ 15 dB under = `micro_gaps`). "Seam" = **the seam
probe**, new in this round (§ 3.1): a composed frame in which a source the visible layer points at had no texture
and was drawn transparent. Before it there was no on-machine seam measurement at all — only the headless invariant
test `handoff_no_seam`.

[[C1]]

### Criterion 2 — full parity (design §10), every setting verified live on a playing wallpaper

Measured by the adapter IT (`scripts/test-liascape-player-adapter.sh`: the real backend over HTTP against a private
headless player, every check against the player's own state), the UI × player-state matrix
(`scripts/test-ui-matrix.sh`: the real UI in a headless Electron, every control × every player state, the oracle
reading every live source) and the backend self-test. Web wallpapers are not a parity item: **the legacy app never
plays them** — both scrapers drop `web` items (`WallpaperEngineScraper.cs:25`, `SteamWorkshopScraper.cs:205`), so
"web items stay hidden as today" (design §3) holds; Phase 4 (the web worker) is additive and the order of Phase 4 vs
Phase 5 is the owner's call (§ 5).

[[C2]]

### Criterion 3 — crash isolation proven (probe-verified), recovery works

[[C3]]

### Criterion 4 — 8 h soak, flat RSS/VRAM, no stuck states (retires the restart daemon)

[[C4]]

### Criterion 4b — auto-mute ≤ 100 ms

**Parked by the owner (2026-10-28)** — not part of the bar. (The in-player Signal shipped anyway, Phase 3 Task 14,
on-machine parity run `phase3.md` § 7.)

### Criterion 5 — scene corpus no worse than current LWE (same scenes start, none newly blank)

[[C5]]

## 3. What this round changed

[[FIXES]]

## 4. Owner-only runs — exact commands

[[OWNER]]

## 5. Decisions made here, and the owner's calls

[[DECISIONS]]
