<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Scene loudness (learned on first play, refined on every play)

Owner decision (Phase 2 plan, "Loudness: learn on first play"): a scene's integrated loudness is measured
over its first ~60 s of play from its worker's own stream, stored in the item's index like a video's
`loudness*`, and normalizes the scene from then on — set once per play (2026-11-06: "Applying it" below). **Refined (owner 2026-10-28: "60s to normalize for
rest of scene, keep measuring to get a more accurate measure when the scene is played in future (probably
add a max cap for people who will never change wallpaper)")**: measuring goes on past the window and on
every later play, continuing ONE integration over all of them, until a cap. The player measures and
reports; the backend stores and applies (player-adapter.md § Scenes → "Loudness"). Code:
`audio/loudness.rs` (pure), the worker's `audio.rs` (`Dsp`), `sources/scene.rs` (`Learner` per source),
`PROTOCOL` **5** (3: `FromWorker::Loudness`; 4: `Start.loudness` + `ToWorker::LoudnessMeter`; 5: `Tick.input` is
`AudioInput`, stereo).

- **BS.1770-4 / EBU R128, split across the two processes.** The worker's `SegmentMeter` K-weights (the
  standard's 48 kHz shelf + RLB high-pass biquads; the worker's stream is always 48 kHz stereo) the
  scene's sound **after the time stretch, before the gate and the gain** — what it really plays, never
  biased by a user volume, a mute or the normalization itself — and sends one `Segment {power, peak}`
  per 100 ms (channel-summed K-weighted mean square + sample peak) as `FromWorker::Loudness {segments}`
  (sent from the audio thread's main loop, taken from the RT callback through the `Outbox` by
  `try_lock`, like the envelope). **Only buffers that pulled the scene's sound into a real stream
  count:** `plays` (not paused — the worker's `paused` is the effective one, player pause included —,
  not `no_audio`, not a fade-out, not quitting) and `real` (a PipeWire stream or the `--ao null` timer,
  never the PipeWire-down fallback). A stepped clock never plays sound, so it never measures. The
  compositor's `Learner` (one per scene **path**, shared by its sources through the `Book` — "One
  measurement per path" below —, **kept across worker restarts**) forms the 400 ms gating blocks from 4 consecutive segments (75 % overlap), keeps
  those above the absolute gate (−70 LUFS) and integrates with the relative gate (−10 LU):
  `lufs = −0.691 + 10·log10(mean of the gated blocks)`. A stereo 1 kHz sine at −20 dBFS peak reads
  −20.0 LUFS (EBU Tech 3341 case 1 −23 → −23.0; a 997 Hz 0 dBFS mono sine −3.01).
- **What's kept: a histogram, not the blocks** (the standard trick for a continuable integration).
  BS.1770's relative gate is computed from the mean of ALL blocks, so two sessions can't be combined
  from their results (a quiet play then a loud one: the loud one gates the quiet out — −20, where a
  seconds-weighted energy mean of the two results says −25.8). Each block's loudness goes into a
  **0.1 LU bin over −70…+5 LUFS** (750 counts; louder → the last bin); the integration runs over the
  bins at their centres (±0.05 LU per block), and two histograms simply add. The **state** = `{v: 1,
  first, counts: [the non-zero span], peak_dbfs}` (`Learner::state_json`, typically a few hundred
  numbers) — what the backend stores and hands the next play back.
- **Seeded plays.** Source prop **`loudness_seed`** (Map; `{}` = none) = a stored state: a `Learner`
  starts from it (`with_seed`: its counts, peak, audible seconds) and continues the SAME integration.
  Read at open — and used only when the player holds less of that path itself (next bullet); a live
  set follows the same rule (`Book::reseed`: adopted only if it covers more audible play, who measures
  unchanged — never counted twice, never shrunk; the backend only sets it at create); a `path` change
  drops it (the old folder's). A malformed seed is ignored (measured from nothing).
  Each session forms its own first block (its first 3 segments start none: 0.3 s less than one long
  run).
- **One measurement per path (`audio::loudness::Book`, 2026-10-29).** The backend reads the seed from
  its index at create, which can lag the player: `stop_now` → `/apply` of the same scene created the new
  source before the backend had stored the stopped one's end-of-play report (stored off its event
  thread), so it continued the report before — the stretch between the two lost (adapter IT, 2 of 3
  runs); a rest too short to report at the end (< a twelfth of the window) never reached the index at
  all. So the compositor keeps its own: `SourceHost` owns one `Book` (path → `Learner` + the live
  sources of the path, in open order), every `SceneSource` joins its path at open / `path` change and
  leaves it at teardown / `path` change / drop. **The key is the canonical folder**
  (`sources::scene::loudness_key`: `fs::canonicalize`, else the path as given — computed at the join, never
  per segment), so `/home/…` vs its physical path, a trailing slash and a `local/<id>` symlink are one entry.
  **A source opening with no seed** (`loudness_seed` absent — and every `path` change) **on a folder no
  source plays drops that folder's idle entry first** (`Book::forget_idle`): the backend has nothing for the
  item — deleted and re-added, a Workshop update —, so a stale measurement isn't continued; a stale-but-present
  seed keeps the reopen-continues rule. Trade-off (decided by the review): a first play shorter than its first
  report (no index state yet) reopened right away starts over instead of continuing — nothing double-counted,
  at most that rest lost. **A source continues the path's measurement** — live
  (a transition A → A' of one scene: A''s open takes A's live state; also a reopen during a real-clock `stop`'s
  fade-out, when the stopped source is still a node — then it makes no end report) or last left (a reopen: no wait,
  no index round trip — the bound on a switch is 0 ms) — **unless its seed covers more audible play**
  (another lineage: after a compositor restart, the index edited) — then the seed is adopted. A seed is
  never merged into a learner, only one of the two kept, and every report the backend stored came from
  the book's lineage (or the one adopted): **no block is ever counted twice**. **One live source of a path
  measures — the head** (`Book::push`): a source joining a path that plays is **pending until its first
  segment** — A measures on while A' loads its worker, is paused or waiting, is restored broken or past its
  restart budget (no worker: it never sounds) — and only then takes over (A's segments are dropped from
  A''s first one on: the same sound twice — A's leave then reports nothing). A member that joined *before*
  the head never takes over by sounding. When the head leaves, the newest member that joined before it
  measures on (it was playing), else the newest pending one; a pending member leaving reports nothing and
  starts no session; a source alone on its path measures at once. A meter switched off at the cap comes
  back on if the path's measurement stops being capped (`update` re-checks every 250 ms while it's off).
  Taking over starts a session (`Learner::begin_session`: `seed_s` = what's measured so far, the block
  forming and `played_s` start over, the unreported rest stays unreported — the next report includes
  it, once). The measuring source's leave reports what's left (`finish`, the thresholds below); the
  learner stays for a reopen — up to `BOOK_IDLE_KEEP` (64) paths without a live source, the least
  recently left dropped beyond (that one falls back to the backend's seed). In memory only: a
  compositor crash/restart behaves as before (below).
- **Per audio configuration (`loudness_key`, 2026-10-29; docs/TODO.md "Offline scene loudness → integration").**
  Source prop **`loudness_key`** (Str, `""` = unknown) = the backend's fingerprint of the scene's sound under its
  `scene_props` (the offline estimator's, below). The book's entry is **(canonical path, key)**
  (`sources::scene::book_key`: the path alone for `""`, else `path\u{1f}key`), so two configurations of one scene
  never share a histogram. Read at open; a **live change** (`change_loudness_key`): `leave` the old key (its rest
  reported WITH the old key — `finish`, the usual thresholds), `join` the new one WITHOUT `forget_idle` (a
  configuration played earlier — toggled back — continues its own measurement), the seed cleared (it was the old
  configuration's; the backend sends the new one's right after: `reseed`, adopted only if it covers more), the meter
  re-checked, and **the worker's segments of the next `KEY_CHANGE_SETTLE` (500 ms, wall clock from the `set`) dropped**
  (the worker applies the new `scene_props` within a frame, but the stream's buffers still carry the old mix). The
  same key again changes nothing. A `path` change clears it (the old folder's). `hello.capabilities` carries
  **`scene_loudness_key`** (the backend sends the prop only to a player that has it). `scene.loudness` carries `key`;
  the `workers` probe's `loudness` carries `key` + `dropped` (segments dropped while settling). Api
  `scene_loudness_key_change_never_shares_a_histogram` (k1 → k2: k1's end report with key k1, k2 from 0 s, 3 segments
  dropped in the first 350 ms, k2's window report = its own play minus the settle; k2 → k1 continues k1's 3.0 s; the
  same key again: no report) — RED before (no `key`, one measurement per path).
- **The window = audible play.** `LIASCAPE_PLAYER_LOUDNESS_WINDOW_S` (default 60; tests 1–6) seconds of
  blocks **above the absolute gate** — a silent stretch doesn't count, a paused or muted one isn't
  even measured. **Reports** (`scene.loudness {id, path, key, lufs, peak_dbfs, seconds, session_s, seed_s,
  played_s, complete, capped, window_s, cap_s, state}`, info, comp `scene` — each one cumulative over
  every play): when the audible seconds over every play (seed included) reach the window; then after
  **each further window** of audible play (60 s); **at the end** (`finish` — destroyed, switched away,
  retired, its `path` changed) for what's left unreported if ≥ a twelfth of the window (5 s — a quick
  switch costs no index write) and the total is ≥ a third of the window (20 s); and once **at the cap**.
  `seconds` = audible seconds over every play, `session_s` = this source's, `seed_s` = the seed's,
  `played_s` = segments this source received (audible or not) — `seed_s`/`session_s`/`played_s` are of
  the measuring source's session (since it joined or took over), `complete` = `seconds` ≥ the window
  (else a partial: switched away early on a first play), `peak_dbfs` = the sample peak over every play
  (≤ the true peak; null if none). So a first play normalizes after 60 s (as before) and keeps refining.
- **The cap.** `LIASCAPE_PLAYER_LOUDNESS_CAP_S` (default **1800** = 30 min of audible play over every play;
  never below the window; tests 3): reached → one last report (`capped: true`) and measuring stops for
  good: the compositor sends **`ToWorker::LoudnessMeter {on: false}`** (folded into a restart's
  `Start.loudness`) and the worker stops K-weighting (`Dsp`: `st.meter`) — no `Loudness` message any
  more. A seed already at the cap → `Start.loudness: false` from the first moment, nothing metered,
  nothing reported. Why 30 min: the integrated loudness of a scene's sound has converged long before
  (its loops/variations are minutes long at most); past that the bins only grow, a wallpaper that's
  never switched away would accumulate and keep a (small) DSP + 10 messages/s going forever.
- **Silence:** a scene without sound (no stream: `has_audio` false) sends no segments; a stream of
  digital silence or anything under −70 LUFS has no gated block → never an event, nothing stored,
  never normalized.
- **Edge cases.** Speed ≠ 1: measured after the pitch-kept stretch, which keeps the level (2×
  measured −19.99 for the −20 tone); the window is wall seconds of audio. A worker crash/hang loses at
  most the partial segment in flight (the `Learner` lives in the compositor; the restarted worker's
  segments continue it). A **compositor** crash/restart loses what this source measured since its last
  report (the restored source — its `loudness_seed` is the one it was created with — continues from
  that seed; the backend keeps whichever report covers more seconds, so until the restored one passes
  the stored one its reports are ignored, then it replaces it: bounded loss, never a double count).
  Two sources of one scene at once (a transition to the same item): the newer continues the older's
  live measurement from its first segment and only it measures from then (the `Book` — the older one's
  part after the hand-over isn't measured: the same sound; nothing is lost or added twice). Paused/`no_audio`: not
  measured (above); `gain.mute`/`gain.user` −96: still measured (the content plays, pre-gain).
- **Applying it** is the backend's: the scene source's **`gain.normalize`** slot (the summed `Gains`
  → the worker's stream; § Units) — set at create from the stored value, live through `animate` (a
  setting slot: `Runtime::setting_anim`, unpaused clock — it lands while paused too). **Set once per play**
  (owner 2026-11-06, "not … real-time … checks for 60s and calculates rest of the scene for future"; player-adapter.md
  § Scenes → "Loudness"): a playing source keeps the value it opened with; the only automatic change is the one ramp
  when its configuration's first window completes (the report that makes the stored measurement complete), and every
  report after that refines the NEXT play's value. Nothing changes here — the reports, their cadence and the book
  are the same; the worker has no gain of its own besides the slots (no AGC, no limiter: the ±1 clip after the gain,
  WE's own device clip).
- **Probe `workers` → `loudness`**: `{seconds (audible, every play), session_s, seed_s, played_s,
  lufs (so far, null = nothing audible), done (capped or ended), capped, window_s, cap_s, measuring
  (this source is its path's measuring one — the `Book`; the other values are the path's), received
  (segments the worker sent, measured or not — stands still once the meter is off), meter (the worker
  meters), key (its `loudness_key`), dropped (segments dropped settling after a key change)}`.
- **Tests.** Units `audio::loudness` (`stereo_1khz_sine_reads_its_level_in_lufs`,
  `k_weighting_shapes_the_spectrum`, `gating_excludes_silence_and_quiet_passages`,
  `silence_learns_nothing_and_the_window_is_audible_play`,
  `a_source_ending_early_reports_a_partial_from_a_third_of_the_window`, `window_knob` — RED by
  mutation: K-weighting bypassed + gates off → 5 of 6 fail); worker `loudness_segments_count_only_played_sound`
  (pre-gain, none paused / on the fallback timer). `tests/api.rs` (`--ao null --clock real`, the
  window 1–6 s): `scene_loudness_is_learned_once_after_its_window` (−20 ± 1 LUFS, once, after ≥ the
  window; at 2× with a −30 dB `gain.user` too), `silent_scene_learns_no_loudness` (no stream /
  digital silence), `paused_and_muted_play_never_counts_toward_loudness` (player pause and
  `no_audio`: audible time still), `scene_ended_early_reports_a_partial_loudness`,
  `scene_loudness_survives_a_worker_restart` (SIGKILL at 1.5 of 3 s: learned < 2.8 s after) — RED
  before: 5 of 5 failed (no event / no progress). **Refinement (2026-10-28):** units
  `histogram_merge_across_sessions_equals_one_long_integration` (5 levels incl. silence, 4 splits:
  seeded session 2 vs one exact block integration < 0.1 LU), `relative_gate_is_recomputed_across_quiet_and_loud_sessions`
  (−38 for 30 s then −20 for 10 s → −20, either order), `reports_each_further_window_and_at_the_end`,
  `cap_stops_measuring`, `state_round_trips_and_a_bad_seed_is_ignored` (RED against the API with the old
  semantics: 5 of 5); worker `loudness_segments_count_only_played_sound` + meter off; lib
  `restart_start_folds_live_changes` + `LoudnessMeter`; api `scene_loudness_is_learned_once_after_its_window`
  (now: not again before the next window, and a report at the end; 2026-11-06: a report never moves the source's
  `gain.normalize` — created at 4.5, still 4.5, no `anim.start` on its gains, the stream's gain = the create sum), `scene_loudness_accumulates_over_two_plays`
  (−20 then −23 dBFS plays of one folder, the second seeded with the first's state → `seed_s`/`session_s`,
  the energy mean of both within 0.3 LU), `scene_loudness_stops_at_the_cap` (window 1, cap 3: reports at
  1/2/3 s, `capped`, `received` stands still, nothing at the end; seeded at the cap → nothing metered) —
  RED by mutation: seed ignored + cap off → both fail; the meter-off message suppressed → the cap test
  fails (`received` 36 → more). **The book (2026-10-29):** units `book_reopen_continues_the_last_source_never_twice`
  (seeded with the window's report → continues the end; the up-to-date seed → the same, not twice; a
  rest too short to report kept and reported once; a longer seed adopted), `book_hands_a_live_measurement_to_the_newest_source`,
  `book_keeps_a_bounded_number_of_idle_paths`; api `scene_reopen_continues_the_end_of_play_measurement`
  (destroy → a create seeded with the window's report continues the end's 3.0 s, not 2.0; the up-to-date
  seed doesn't double it; a second source beside a playing one continues its live 4.0 s, `measuring`
  moves to it, its report = `seed_s` + `session_s`, the first reports nothing at its end) — RED before:
  the reopen read 2.0 s. **Review fixes (2026-10-29):** units `book_hands_a_live_measurement_over_at_the_newest_sources_first_segment`,
  `book_head_leaving_passes_to_an_older_member_first_then_a_pending_one`, `book_reseed_adopts_only_more_and_keeps_the_head`,
  `book_forgets_an_idle_path_only_without_live_sources`, `book_idle_eviction_is_least_recently_left`; api
  `scene_silent_second_source_leaves_the_playing_one_measuring` (A' paused on VIRTUAL-2: A measures on, A' takes over
  at its first sound with everything so far as its seed, A measures again after A' goes),
  `scene_live_seed_on_a_two_source_path_never_shrinks_it`, `scene_path_changes_and_folder_spellings_share_one_measurement`
  (a symlink + trailing slash = X's measurement; `path` onto X pending then measuring, back onto Y afresh, X back to A),
  `scene_reopen_continues_the_end_of_play_measurement` (C pending until shown); harness `tests/scene.rs`
  `dropped_scene_source_hands_its_loudness_over` (`Drop`), `scene_meter_comes_back_on_when_the_path_is_no_longer_capped`
  (per-source caps — only `SceneOpts` can make a path uncap).

**Offline estimate (2026-10-29; `scene/loudness_estimate.rs`, `scene/pkg.rs`, `liascape-player scene-loudness`).**
What the learner above would measure, computed from the scene's files before it plays — so a scene can be
normalized from its first second. Wired into the backend 2026-10-29 (player-adapter.md § Scenes → "Loudness" → "Per
audio configuration"; web-backend.md § Scene loudness): run on import / at startup / from Settings, and on every
property commit (its fingerprint = the source's `loudness_key`).
- **`scene.pkg`** (`scene::pkg::Pkg`, read-only; LWE's `PackageParser`): little-endian `u32 n + n bytes` header
  `PKGV00xx`, `u32 count`, `count × {u32 n + name, u32 offset, u32 length}`, then the data — an entry is
  `[end of the table + offset, + length)`. Every `scene.pkg` of the owner's library (96, headers `PKGV0001`…`0024`)
  parses with one layout: entries contiguous from offset 0, the last ending exactly at EOF. Lookup exact, else
  ASCII-case-insensitive (fork patch 0016's rule). `pkg::build` writes one (fixtures).
- **What plays, by [`Model`]** — both models play Wallpaper Engine 2.8.485's decompiled rules
  (`docs/player/spikes/we-sound-semantics.md`), which LWE plays since fork patch 0018 (§ "LWE core"): stream
  amplitude = `volume²` (unclamped), a bound property's value (slider = its value, bool = 1/0, `{name,
  condition}` = 1 iff equal: LWE's `DynamicValue` rule — WE's own conversion not decompiled), `sound` a string
  or a list, absent/unknown `playbackmode` = `loop`, `loop` = one random file at a time back-to-back
  (time-weighted like a playlist, in listed order), `random` = one random file at a time + the mean of
  `mintime`/`maxtime` (defaults 1 / 5 s) of silence, `single` = one random file once (the first stands in),
  `startsilent` = silent. `lwe` (default) = what the player plays; `we` = the same plan, kept for the
  fingerprint's prefix and its notes (a `startsilent` under `we` is `low` — a WE script could start it; under
  `lwe` certain: LWE's SceneScript has no sound methods; the scripts note is `we`'s). Before 0018 `lwe` was
  LWE's old behaviour (every file of an object at once, unity gain, `volume` and user properties ignored).
- **Per-file stats, cached** (`FileStats`, `Cache`): each file decoded ONCE by ffmpeg (`PATH`; a package entry
  piped through stdin; `-ac 2 -ar 48000 f32le`, so a mono file is at −3 dB per channel like LWE's resampler;
  ≤ 1800 s; 120 s timeout, PDEATHSIG) and reduced through the live `SegmentMeter` to per-100 ms K-weighted powers +
  peaks; kept in memory and in `$XDG_CACHE_HOME/liascape/scene-loudness/<fnv64(key)>.json` (key = path + size +
  mtime, + entry name/offset/length for a package). A re-estimate for other properties is a re-mix: no decode.
- **Mix → the live learner.** Segment power of the mix = Σ gain² · power (K-weighting is linear; unrelated sounds'
  cross terms average out over 100 ms — the same tone twice would be under-read by up to 3 dB, a documented limit),
  peak = Σ gain · peak (a bound), simulated over ≥ 60 s (several loops of different lengths: 4 × the longest, so
  their phases mix; ≤ 1800 s; `--horizon S` = exactly the first S s), fed to `Learner` itself → the SAME
  `state_json` (`state`) the live learner continues, + `seed.state` scaled to `--seed-seconds` (default 10 s,
  largest-remainder counts) — the weight an estimated seed should carry.
- **Fingerprint** (`fingerprint`): `<model>-<fnv64>` over `SOUND_SEMANTICS` and the active tracks (object,
  pattern, files, gain to 1e-4), order-free: property changes that don't touch audio (colours, visual toggles)
  never change it, one that changes a sound's level or which sounds play always does. **`SOUND_SEMANTICS`** = how
  the player plays sound objects: 1 = LWE before 0018, **2** = 0018 (2026-10-29) — every fingerprint changed
  with it, so nothing keyed by a fingerprint continues a measurement of the old sound. Bump it whenever the
  player's sound semantics change. The backend stores every scene's loudness by it (`sceneLoudness[<fingerprint>]`,
  library.md § Loudness) and keys the player's measurement with it (`loudness_key`, above).
- **CLI** `liascape-player scene-loudness <scene dir> [--assets <dir>] [--props '<scene_props json>'] [--model
  lwe|we] [--seed-seconds S] [--horizon S] [--cache <dir>|--no-cache]` → one JSON line `{path, estimated: true,
  model, fingerprint, lufs, peak_dbfs, audible_s, horizon_s, state, seed {weight_s, state}, confidence {level
  high|medium|low, notes}, sounds [{id, name, files, playbackmode, volume, gain, active, silent}], files [{file,
  duration_s, lufs}], cache {hits, disk_hits, decodes}, ms}`; exit 1 = not a scene / unreadable (`{path, error}`).
  Measured: 80–250 ms per scene with one 1.5–4 min mp3 (decode), a re-mix from the disk cache 0.2–1.9 ms in-process (`ms`; + the process start).
- **Validated (since 0018, 2026-10-29)** against the patched LWE's real output: `WPENGINE_SOUND_SEED=7
  liascape-scene-worker --lwe-smoke <scene> --assets … --out … --audio-dump 45` (the 1× dump = what the worker's
  meter sees; the dump renders at 30 fps meanwhile, so playlists advance) of 20 scenes, measured through the same
  estimator (the dump as a one-shot WAV) vs `--horizon 45`: within ±0.10 LU in 17, ±0.25 in 18, median −0.05;
  the two outliers are random picks, not rules — 3174556087 (`random`, 11 files) −0.91 and 3013489778 (`loop`, 5)
  −0.65: the estimate's 45 s is the FIRST listed file, the player picked another; with the picked file
  (identified by correlation) −0.08 / −0.04 → all 20 within ±0.15, 19 within ±0.10, median −0.04. The old
  outlier 3289734539 (vocal + instrumental at once, −2.64) is −0.06 (it plays one of them: the dump = 0.49 ×
  the instrumental, residual −147 dB). Over a full horizon a multi-file object's estimate is the time-weighted
  expectation; a first live report reflects one pick. Behaviour checks on real scenes (dump fits, same tools):
  2951169110 = "believe in you" × 1.0 + the orchestral × 0 until `--prop-at 15 orchestralversion=1` → both × 1.0
  from 15 s; 3276522107 (LWE can't load it — corpus `load_failed`; its sound objects in a bare scene): wind/inside
  0.49, rain 0.25, train 0 → × 1.0 after `--prop-at 10 musictrainride1000eyes=1`; 2375914945 `musicvolume` 0.8 vs 2
  = ×6.250 = +15.92 dB (peak 2.04: the raw scene sound goes over 0 dBFS, the worker's gain stage follows);
  2886313155 (`random`, 1..5 s) over 480 s: gaps 1.98 / 4.85 s from each file's end.
  *Before 0018* (the old `lwe` model vs the unpatched LWE, 53 scenes): ±0.10 LU in 46, the vocal+instrumental
  case −2.64. Against the live learner's stored state (pre-0018 sound): 2375914945 −16.59 vs −16.58,
  3422085307 −5.11 vs −5.12, 2371103399 −14.57 vs −15.18 — those stored states are stale for 8 of the 10
  measured scenes now (docs/TODO.md).
- **`lufs_if_coherent`**: tracks of equal length (± 0.5 s, ≥ 5 s) of different objects start together and may be
  versions of one recording (since 0018 the files of ONE object never play together); `mix_with(…, coherent: true)` sums them in amplitude (`(Σ gain·√power)²`) — the upper bound; a
  `low` note says so.
- **Tests** (units, `scene::pkg` + `scene::loudness_estimate`): `generated_pkg_round_trips`,
  `reads_an_entry_from_a_file`, `garbage_and_truncation_are_refused`; `sine_at_minus_20_dbfs_reads_minus_20_lufs`,
  `simultaneous_sounds_mix_as_a_power_sum` (vs the really summed signal ≤ 0.05 LU),
  `volume_forms_and_property_bindings`, `audio_property_changes_the_fingerprint_a_visual_one_never` (a bool bound
  to one of two sounds: fingerprint changes, the estimate drops by that sound's power; a colour: unchanged; `lwe`:
  follows it the same way), `fingerprint_carries_the_sound_semantics`, `lwe_plays_like_we_and_loops_mix_over_the_horizon`
  (equal plans; a multi-file loop is one track at volume²; `single` once; an unknown mode loops; the string form),
  `random_mode_is_a_time_weighted_mix` (vs the real concatenation ≤ 0.05 LU), `startsilent_and_zero_volume_are_silent`, `scaled_seed_is_a_valid_learner_state`,
  `cache_reuses_stats_in_memory_and_on_disk`, `packaged_scene_end_to_end` (ffmpeg; SKIP without it: a generated
  `scene.pkg` with a stereo and a mono WAV, −20.0 LUFS, the property turning the second on, no re-decode),
  `equal_length_files_get_a_coherent_bound` (one recording twice: power sum +3.01, the bound +6.02 = the real mix);
  `tests/scene_loudness.rs::scene_loudness_cli_estimates_a_packaged_scene` (the binary: `state`/`seed.state` load as
  learner seeds, a colour keeps the fingerprint and decodes nothing in a new process — the disk cache —, the bool
  changes it to the files' power sum, `lwe` follows it like `we`, exit 1 / 2).
