<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Units

`src/units.rs` (spec §5.3): **gains are dB everywhere inside the player; convert only at
the edge, with that edge's own curve.** mpv's `volume` and PulseAudio stream volumes are
cubic (measured `volume=50` → −18.07 dB), so the player drives mpv via `volume-gain`
(exact dB) and keeps `volume` at 100 — see `units::mpv_volume_gain` /
`units::pulse_volume_from_db`. `units::SILENT_DB` (−96) is the one floor everything
clamps to; `units::Gains` sums `GainSlot`s (`user`/`override`/`normalize`/`mute`/
`automute`/`xfade`/`anticlick`/`pause`, lowercase in `gain.<slot>` paths and JSON) in dB.
`pause` is the player-pause gate's own slot (final review I2, § Runtime) — like `xfade`/
`anticlick` it is transient and never saved in the snapshot.
Crossfades use `units::equal_power` (cos/sin). See `docs/player/invariants.md` #2–#4.
