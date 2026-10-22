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
| A `method: frozen` (or `reveal`) transition's handoff has a ~15–20 ms gap of true digital silence (not a quiet ramp — a flat −96 dB floor) right as B unpauses, before B's audio jumps straight to a level already well into its 30 ms anti-click ramp (never caught gradually ramping through the gap itself) | `ctl probe '{"name":"dropout","args":{"corr":"<corr>"}}'` once `done` has fired → a `micro_gaps` entry a few ms after the effect's own end (handoff); confirm with `ctl probe '{"name":"meter.window",...}'` spanning the gap — raw 1 ms samples go straight from `-96.0` to a loud value with no intermediate steps | **Real audio-out restart latency at an unpause handoff (owner's "flicker of silence" report), reproduced twice (review fix round, R80) after the detector's own 1 ms-resolution fix removed the comparison artifact that used to hide it at a different offset.** B had been *paused* through the whole held period (frozen/reveal); unpausing it at handoff most likely has to restart the mpv/PipeWire audio path, which takes longer than the 1 ms the anti-click ramp assumes is already flowing — the gain graph starts ramping on schedule, but no samples actually reach the bus until the output restarts, so the ramp's early portion is simply never produced; once audio starts, it reflects wherever the (unheard) ramp had already reached. A plain `Runtime::retire` ramp-down (a source that was never paused, so nothing needs to restart) shows none of this on the same machine/build — consistent with the unpause restart, not the ramp math, being the cause. **Not fixed here** (Task 15 is the detector, not the player's audio path); a candidate fix is priming/unpausing B's audio output slightly before the anti-click ramp actually starts rather than in the same instant. |

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
