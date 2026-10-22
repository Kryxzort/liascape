# Debugging lp-player's audio

AI debug-mode recipe for "why was there silence/a glitch at roughly time T": which `ctl`
query or probe answers it, and what that answer usually means. See
`.claude/rules/player-core.md` § Command API → "Debugging with `ctl` (AI recipe)" for the
general (not audio-specific) version this extends, and § Audio bus for the bus/meter
themselves.

## Symptom → query → likely cause

| Symptom | Query | Likely cause |
|---|---|---|
| A fade/crossfade "feels" uneven — loud, then suddenly quiet, or vice versa, even though no gap is audible | `ctl probe '{"name":"sources"}'` → compare `gain_effective_db` (what the graph thinks) against `mpv_volume_gain` (what mpv actually runs) for the source mid-ramp | **Cubic volume sag.** mpv's `volume` property (and PulseAudio/PipeWire-pulse stream volumes) are **cubic** in linear amplitude, not linear — `volume=50` measures −18.07 dB, not −6. A gain pushed through `volume` instead of `volume-gain` sags hard in the middle of a ramp. lp-player never does this (`units::mpv_volume_gain`, `MpvSource` always drives `volume-gain` and pins `volume = 100` — § Units) — but a *regression* reintroducing a `volume` write anywhere, or a new edge (a future scene/LWE volume control) copying the wrong curve, reproduces exactly this. Fix: drive the device's gain knob in dB (`volume-gain` for mpv, `units::pulse_volume_from_db`'s cubic curve only at the PulseAudio edge, never both). |
| A glitch lands right at a speed change (a playlist speed override, a live `speed` set) | `ctl logs '{"kind_prefix":"source."}'` around the `speed` `set`'s `t_mono_ms`; `ctl probe '{"name":"dropout","args":{"corr":"<the nearest transition, if one is running>"}}'` if a transition is also in flight then | **Speed-step micro-gap.** Changing `speed` live re-times the audio resampler; mpv needs a brief settle window before its output is trustworthy again (the legacy engine's own constant for this was `AUDIO_SETTLE`). A `probe dropout` run straddling the moment shows it as a short `micro_gaps` entry (too brief to move a whole 10 ms bin's average into `drops` territory) rather than a `drops` entry — that's the expected shape of this bug, not evidence the detector is wrong. If it widens into an actual `drops` entry, the settle window itself has regressed. |
| Total silence for the first second or so after a transition starts, then it's fine | `ctl logs '{"corr":"<corr>"}'` — look for `transition.failed {reason}` vs a `transition.started` whose `start_ms` is much later than the request; `ctl probe '{"name":"dropout","args":{"corr":"<corr>"}}'` once `done` has fired | **Ready-timeout silence.** B must produce `Ready` before the effect can start; `recipes::transition::READY_TIMEOUT` (10 s today) is the cap before it's treated as failed (the legacy renderer's equivalent cap was 3.5 s). A slow decoder start, a cold network mount, or a corrupt file right at the edge of that window reads as "nothing happened for N seconds" rather than a clean failure. `transition.failed {path, reason}` names it; if instead the transition *did* start but late, the dropout window (`transition.started` − 500 ms … `done` + 500 ms) will show real silence before `start_ms` as content, not a bug — the recipe genuinely waited. |
| A wallpaper is silent after `ctl stop`/`quit` then being restored (e.g. by the backend's `--restore`), even though it was playing fine before | `ctl probe '{"name":"sources"}'` → `mpv_pause` / `paused` on the restored source; `ctl logs '{"kind_prefix":"source."}'` for `source.parked`/`source.unparked` | **Paused-after-kill silence (a parked wallpaper staying paused).** A wallpaper killed mid-playback must come back **unpaused** on restore — audio follows the picture (project invariant), so a picture that's playing but a source still flagged `paused` from the kill path is silent for no visible reason. `Runtime`'s park/unpark (§ Runtime → Outputs, R60) always unpauses on unpark unless it was paused *before* the kill; if a wallpaper comes back paused that wasn't paused when it went away, that's the bug this pattern is named for. |
| **Greatly reduced, not eliminated (Task 16c, R85).** A `method: frozen` (or `reveal`) transition's handoff used to have a ~15–35 ms gap of true digital silence (not a quiet ramp — a flat −96 dB floor) right as B unpauses, before B's audio jumped straight to a level already well into its 30 ms anti-click ramp (never caught gradually ramping through the gap itself) | `ctl probe '{"name":"dropout","args":{"corr":"<corr>"}}'` once `done` has fired → a `micro_gaps` entry a few ms after the effect's own end (handoff); `ctl logs '{"kind_prefix":"source.audio_flowing"}'` shows exactly when each onset's wait resolved (and `transition.onset_timeout` if one ever has to ramp unconfirmed) | **Real audio-out restart latency at an unpause handoff (owner's "flicker of silence" report).** B had been *paused* through the whole held period (frozen/reveal); unpausing it at handoff has to restart the mpv/PipeWire audio path, which takes longer than the ramp assumed was already flowing. **Fix (R85):** the ramp-in no longer starts at the instant of un-pause — `SourceEvent::AudioFlowing` (armed on the paused → un-paused edge; invariant #8) holds it. **Measured the signal itself is unreliable** (4 on-machine runs): `audio-pts`'s first post-un-pause change ("Current audio playback position... takes into account the audio driver delay", man mpv) is not the AO actually emitting samples — it fires anywhere 4–65 ms after un-pause, and real audio (the bus meter) then stays silent for a *further* 12–33 ms after that change specifically (one run: change at +65 ms, first real sample at +85 ms). Gating the ramp on the first change alone (tried first) reproduced the exact bug, just a few ms later. **Fixed further:** `MpvSource` requires `FLOWING_CONFIRM_MARGIN` (40 ms, measured) of real time *after* that first change before trusting it. Result (3 on-machine validation runs, post-fix): the ~15–35 ms unramped-click window is gone; a small ~5–7 ms residual `micro_gaps` entry remains at the same relative offset in all 3 runs (`at_ms` ≈ 1579–1596, `under_db` ≈ 59–61) — see the next row's root cause (same mechanism, opposite side of the transition) — raising the margin further (tried up to 40 ms from the original 0) did not shrink this residual, consistent with it being architectural rather than a confirmation-timing shortfall. |
| **Investigated; root cause found, not fixable within Task 16c's scope.** A reveal/frozen A-hold's ramp-to-silence shows a ~5–7 ms `micro_gaps` entry (occasionally escalating to a `drops` entry) right at its tail, in *every* on-machine run (7 runs across this task, with and without the fix below) | Raw `meter.window` samples spanning the gap: real audio holds at a *constant*, clearly-audible level (not decaying) for the gap's whole span, then snaps to exactly −96 dB within one 1 ms sample | **Originally suspected: requirement #2 (the recipe pausing the source at a fixed graph-clock deadline before the gain push had actually landed in the audio mpv was outputting).** Added `tr.pause_at = t0 + ANTICLICK + AUDIO_SETTLE_TAIL` (15 ms) expecting this to close the gap — **evidence ruled this out**: in every on-machine run, the gap occurs *before* `pause_at` even fires (computed from `transition.started`'s and the gap's own `t_mono_ms`: the gap ends several ms before `t0 + 45 ms`), so the source isn't paused yet when it happens — requirement #2's fix is real and correct (it's still needed, and `Runtime`'s player-pause gate R88 uses the same tail) but doesn't touch *this* gap. **Actual root cause (evidence-based): the `Animator`'s tick-rate coarseness, already documented as a known limitation** (`docs/player/invariants.md` #4: "the ramp is stepped once per loop iteration... a per-sample ramp would need the audio edge, Task 14"). A linear-*amplitude* 30 ms ramp converted to dB concentrates almost its entire audible range into the ramp's last ~1 ms (`lin_to_db`: at 29 ms/30 ms progress, amplitude 0.033 → −29.6 dB; at 30 ms, exactly −96 dB) — but at a 60 Hz tick rate a 30 ms ramp gets only 1–2 `Animator::tick` evaluations, so mpv's `volume-gain` (and so the real output) *holds* whatever was last pushed (measured: a steady ~−29 to −31 dBFS) for most of the ramp's final ~15 ms, then snaps directly to the final −96 dB push — never smoothly passing through the intervening values a continuously-evaluated curve (which is what the dropout detector reconstructs from the recorded ramp parameters, correctly, at finer resolution) would. The *onset* row above's small residual (same ~5–7 ms size, same mechanism, the mirror-image case — B's ramp-*in* snaps from its held intermediate value straight to full before real audio needs it to) is the same cause. **Not fixed here**: the real fix is a per-sample (audio-thread-driven) gain ramp — `docs/superpowers/specs/2026-10-20-utopia-player-design.md`'s "Task 14... audio edge" per invariants.md #4 — out of scope for Task 16c, which only fixes *when* a ramp starts/ends relative to real audio, not the ramp's own resolution. |

These five are the exact bugs the legacy (pre-lp-player) renderer had, or (the last row) a
real player-side latency this detector surfaced, when the original
`scripts/lp_audiowatch.py` (2026-10-20) was first pointed at it — proof this
reference-based technique finds real issues, not just confirms things are fine. It's now
native to lp-player as `probe dropout` (below) instead of an external sink monitor.

## The tools

- **`ctl probe '{"name":"dropout","args":{"corr":"tr-N"}}'`** — re-runs the
  reference-based dropout detector for a transition that has already reached
  `transition.done` (find a recent `corr` with `ctl logs
  '{"kind_prefix":"transition."}'`). Compares what the bus actually output (the meter)
  against what the sources + the *recorded* gain schedule say should have played, over
  `transition.started` − 500 ms … `.done` + 500 ms. Replies `{"status":"pending","corr"}`
  at once (it decodes with `ffmpeg` and analyses off the main loop — never blocks the
  player) and delivers the result as a `probe.dropout {corr, report}` event (`ctl
  subscribe probe.` to see it live). `report`: `lag_ms` (0–250, the best alignment found),
  `fit_db` (how good that alignment is — large means the window had little reliable
  overlap, not necessarily a bug), `offset_db` (a level mismatch, e.g. a miscalibrated
  bus gain — not itself a dropout), `drops` (10 ms-bin-granularity real gaps),
  `micro_gaps` (finer, sub-bin gaps too short to move a whole bin's average — see the
  speed-step row above for what a *legitimate* one looks like). When debug mode is on
  (`serve --debug`, or `set player.debug true` live) this also runs **automatically**
  after every `transition.done` (and after every plain source retire's 30 ms anti-click
  ramp — review fix round R79/R80: `source.retire`'s own log event carries the `corr` it
  minted, so `ctl logs '{"kind_prefix":"source.retire"}'` finds one to probe), so `ctl
  subscribe probe.` during normal use already surfaces a dropout the moment one happens.
  **Two different "nothing to report" shapes, don't confuse them:** the on-demand verb
  (`ctl probe '{"name":"dropout",…}'`) replies **synchronously** with an `unsupported`
  *error* only when it can't even start (no `transition.done`/retire window recorded yet,
  or the meter is down — the hint names which); once it *does* start, the result always
  arrives later as the async `probe.dropout` **event**, and that event's own `skipped`
  field (not an error) covers a start-time problem the auto-trigger can hit with nobody
  watching synchronously — meter down, or (R79) a third decode already in flight
  (`skipped: "busy"`; at most 2 run at once — try again shortly). A `report.fit:
  "insufficient"` (R77) is a third, still-different case: the analysis *ran*, but didn't
  have enough reliably-paired bins to trust any lag/offset — not an error, not skipped,
  just "couldn't check," with `drops`/`micro_gaps` both empty on purpose.
  **Not modeled:** a second audible wallpaper on another output sharing the same bus —
  the expected mix only ever weights the sources belonging to *this* corr's own window
  (one transition's A/B, or one retiring source), never anything else concurrently
  feeding the bus.
- **`ctl probe '{"name":"meter.window","args":{"last_ms":1000}}'`** (or
  `{"from_ms":…,"to_ms":…}`) — the bus meter's raw 1 ms dBFS samples (what the player's
  audio bus actually output, and nothing else — not the default sink, not another app).
  `median_db`/`min_db`/`max_db`/`max_gap_ms` first; add the full `samples` array only when
  you need to look at the shape yourself (it's left out with `"samples":false`).
- **`ctl probe '{"name":"bus"}'`** — is there a bus at all (`state`, `device`), its
  measured `latency_ms`, which sink it's really linked to (`target`, `overridden` if a
  session policy like EasyEffects moved it), and the meter's own health
  (`meter.available`/`streaming`/`dropped`). Check this *first* whenever `dropout` or
  `meter.window` says `unsupported`/`skipped` — it names the reason.
- **`ctl probe '{"name":"sources"}'`** — every live source's `gain_effective_db` (what
  the graph computed) next to `gains` (its own slots) and the synchronous mpv reads
  (`mpv_volume_gain`, `mpv_pause`, `mpv_audio_device`, `mpv_audio_delay`,
  `requests_in_flight`) — the single best place to see "what the graph wants" vs "what
  mpv is actually doing" side by side.
- **`ctl probe '{"name":"frames"}'`** — present timing per output; a dropout that
  coincides with a `missed` frame or an idle↔paced flip is more likely a GPU/compositor
  stall than an audio bug.
- **`ctl logs '{"corr":"tr-N"}'`** — one transition's whole story in order
  (`scheduled`→`started`→`handoff`→`done`, or where it stopped:
  `cancelled`/`failed {reason}`); `ctl logs '{"kind_prefix":"audio."}'` for the bus's own
  retarget/latency history; `ctl logs '{"min_level":"warn"}'` for everything that went
  wrong recently, unfiltered.
