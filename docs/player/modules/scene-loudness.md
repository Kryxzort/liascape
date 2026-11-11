# Scene loudness: learned live, estimated offline

Covers `src/player/src/audio/loudness.rs` (`SegmentMeter`, `Learner`, `Book`), the worker's metering in
`bin/liascape-scene-worker/audio.rs`, the learner wiring in `sources/scene.rs`, and the offline estimate in
`scene/loudness_estimate.rs` + `scene/pkg.rs` (`liascape-player scene-loudness`). Rules:
`.claude/rules/player/scenes.md` § Scene loudness. The backend stores and applies it:
`.claude/rules/backend/library.md` § Loudness and `.claude/rules/backend/player-adapter.md` § Scenes and loudness;
why it is applied once per play: `docs/decisions.md` § Set scene normalization once per play.

The player measures and reports; the backend stores the result in the item's index and sets the source's
`gain.normalize` at create. A report never moves the playing source's gain.

## Measuring (BS.1770-4 / EBU R128 across two processes)

The worker K-weights its stream after the time stretch, before the gate and the gain — what it really plays, never
biased by a user volume, a mute or the normalization itself — and sends one segment `{power, peak}` per 100 ms.
Only buffers that pulled the scene's sound into a real stream count: not paused (the effective pause), not
`no_audio`, not a fade-out, not the PipeWire-down fallback timer; a stepped clock never plays sound. The
compositor's `Learner` forms 400 ms gating blocks from 4 consecutive segments, keeps those above −70 LUFS and
integrates with the −10 LU relative gate. A stereo 1 kHz sine at −20 dBFS reads −20.0 LUFS (EBU Tech 3341 case 1:
−23.0).

**A histogram, not results.** The relative gate depends on all blocks, so two sessions can't be combined from their
results (a quiet play then a loud one: the loud one gates the quiet out — −20, where averaging the two results says
−25.8). Each block's loudness goes into a 0.1 LU bin over −70…+5 LUFS; histograms simply add. The state
(`Learner::state_json`: first bin, the non-zero counts, peak) is what the backend stores and hands back as the next
play's `loudness_seed`.

## One measurement per (folder, key): the `Book`

The backend reads the seed from its index at create, which can lag the player (a stop then an immediate re-apply
created the new source before the stopped one's report was stored). So `SourceHost` keeps its own `Book`: entry →
`Learner` + the live sources on it, in open order. Rules:

- **Key** = the canonical folder (`fs::canonicalize`, so a symlink, a trailing slash and a physical path are one
  entry) plus `loudness_key`, the backend's fingerprint of the scene's sound under its `scene_props`
  (`book_key`: path alone for `""`). Two audio configurations never share a histogram.
- **One live source measures — the head.** A source joining an entry that plays is pending until its first
  segment (A measures on while A' loads, is paused or restored broken), then takes over; A's segments are dropped
  from then (the same sound twice). When the head leaves, the newest member that joined before it measures on,
  else the newest pending one.
- **Continue, never count twice.** A source continues the entry's live or last-left measurement unless its seed
  covers more audible play (another lineage: after a compositor restart, an edited index) — then the seed is
  adopted. Seeds are never merged into a learner, only one of the two kept; a live `loudness_seed` set follows the
  same rule (`Book::reseed`).
- **Stale entries.** A source opening with no seed on a folder nothing plays drops that folder's idle entry first
  (`Book::forget_idle`: the backend has nothing for the item — deleted and re-added, a Workshop update). Trade-off:
  a first play shorter than its first report, reopened at once, starts over (nothing double-counted, at most that
  rest lost). Up to `BOOK_IDLE_KEEP` (64) idle entries are kept, least recently left dropped. In memory only.
- **Key change while playing:** the old key's rest is reported with the old key, the new key joins without
  `forget_idle` (a configuration toggled back continues), the seed clears (the backend sends the new one), and
  segments for the next `KEY_CHANGE_SETTLE` (500 ms) are dropped — the worker applies new `scene_props` within a
  frame, but buffers still carry the old mix.

## Window, reports, cap

The window is audible play: `LIASCAPE_PLAYER_LOUDNESS_WINDOW_S` (default 60) seconds of blocks above the absolute
gate, so silence doesn't count and a paused or muted stretch isn't measured. `scene.loudness` (an outbox fact,
cumulative over every play) is reported when the window is first reached, after each further window, at the end
(destroyed, switched away, path or key changed) if the unreported rest is ≥ a twelfth of the window and the total ≥
a third, and once at the cap. `LIASCAPE_PLAYER_LOUDNESS_CAP_S` (default 1800 s of audible play) ends measuring for
good: `ToWorker::LoudnessMeter {on: false}` and the worker stops K-weighting. By then the integration has long
converged; past it the bins only grow and a never-switched wallpaper would keep a DSP and 10 messages/s going
forever. A seed already at the cap starts with the meter off.

Edge cases: speed ≠ 1 is measured after the pitch-kept stretch, which keeps the level. A worker crash loses at most
the segment in flight (the learner lives in the compositor). A compositor crash loses what was measured since the
last report; the restored source continues from the seed it was created with, and the backend keeps whichever
report covers more seconds. `gain.mute`/`gain.user` at −96 still measure (pre-gain). A scene with no sound or under
−70 LUFS never reports.

## Offline estimate

What the learner would measure, computed from the scene's files before it plays, so a scene is normalized from its
first second; the backend runs it on import, at startup and on every property commit.

- **`scene.pkg`** (`scene::pkg::Pkg`, read-only): `u32 n + PKGV00xx`, `u32 count`, `count × {name, offset, length}`,
  then the data; every library package parses with that layout. Lookup is exact, else ASCII-case-insensitive like
  LWE's patched resolver.
- **What plays** follows Wallpaper Engine's decompiled sound-object rules (`docs/player/spikes/we-sound-semantics.md`),
  which the patched LWE also plays: amplitude = `volume²` (unclamped; a bound property's value), `sound` a string or
  a list, unknown `playbackmode` = `loop`, `loop` = one random file at a time back to back (time-weighted),
  `random` = plus the mean `mintime`..`maxtime` gap, `single` = once, `startsilent` = silent. Model `lwe` (default) =
  what the player plays; `we` = the same plan with WE-only confidence notes.
- **Per-file stats**: each file is decoded once by ffmpeg (stereo 48 kHz f32, so a mono file is −3 dB per channel
  like LWE's resampler) and reduced through the same `SegmentMeter`; cached in memory and in
  `$XDG_CACHE_HOME/liascape/scene-loudness/` keyed by path, size, mtime (and the package entry). A re-estimate for
  other properties is a re-mix, no decode.
- **Mix**: segment power = Σ gain² · power (unrelated sounds' cross terms average out over 100 ms; the same tone
  twice would be under-read by up to 3 dB), simulated over ≥ 60 s (4 × the longest loop) and fed to `Learner`
  itself — so the output `state` is one the live learner continues, plus a `seed.state` scaled to `--seed-seconds`.
  `lufs_if_coherent` sums equal-length tracks of different objects in amplitude as an upper bound.
- **Fingerprint** = `<model>-<fnv64>` over `SOUND_SEMANTICS` and the active tracks (object, pattern, files, gain),
  order-free: a visual property never changes it, one that changes which sounds play or their level always does.
  It is the backend's `loudness_key`.
- Measured: 80–250 ms per scene with one 1.5–4 min mp3; a re-mix from the disk cache 0.2–1.9 ms. Against the patched
  LWE's real output over 45 s on 20 scenes: within ±0.15 LU once the random file pick is matched, median −0.04; a
  first live report reflects one random pick, the estimate the time-weighted expectation.
