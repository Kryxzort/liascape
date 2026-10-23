//! Audio units: dB everywhere inside the player, with conversion only at the edges
//! (spec §5.3).
//!
//! **Why dB, not percent:** mpv's own `volume` property and PulseAudio/PipeWire-pulse
//! stream volumes are both **cubic** in the underlying linear amplitude, not linear —
//! ramping a raw percent produces a curve that sounds nothing like a steady fade and
//! clips unpredictably when gains are summed. Measured on this machine's mpv: `volume=50`
//! → **−18.07 dB**, `volume-gain=-6` → **−6.02 dB** (i.e. `volume-gain` *is* exact dB;
//! `volume` is cubic — `20*log10((50/100)^3) ≈ -18.06`). That is why the player keeps mpv
//! `volume` fixed at 100 and drives `volume-gain` for every in-player gain change, and why
//! every gain anywhere inside the player — user, override, normalization, mute, auto-mute,
//! crossfade, anti-click — is tracked and summed in dB and converted to a device's native
//! curve only at that device's edge.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Silence floor, in dB. Matches mpv's `volume-gain-min` — chosen as the project's single
/// "silent" value so every gain slot, clamp, and comparison across the player agrees on
/// what "silent" means instead of each edge inventing its own floor.
pub const SILENT_DB: f64 = -96.0;

/// Ceiling for a single gain slot or a summed [`Gains::effective_db`] — headroom above
/// 0 dB (unity) so a normalization or override boost can still go a bit "louder than
/// source" without the sum being unbounded.
const MAX_DB: f64 = 12.0;

/// Converts a dB value to linear amplitude: `10^(db/20)`.
///
/// For `db <= SILENT_DB` this returns `0.0` rather than the (tiny but nonzero) literal
/// power-of-ten value — below the silence floor there is no meaningful amplitude left to
/// represent, and callers that branch on "is this exactly silent" (e.g. deciding whether a
/// stream may be considered stopped) want a clean `0.0`, not `~1.58e-5`. This is the
/// inverse of [`lin_to_db`] only away from that floor; the two are not exact inverses
/// *at* the floor by design (see `lin_to_db`'s doc comment for the matching half of this
/// choice).
pub fn db_to_lin(db: f64) -> f64 {
    if db <= SILENT_DB {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// Converts linear amplitude to dB: `20*log10(lin)`.
///
/// `lin <= 1e-5` returns [`SILENT_DB`] directly rather than evaluating `log10` of a value
/// that is either zero (undefined) or close enough to it that the exact dB figure carries
/// no information the player ever acts on — anything this quiet is simply "silent".
pub fn lin_to_db(lin: f64) -> f64 {
    if lin <= 1e-5 {
        SILENT_DB
    } else {
        20.0 * lin.log10()
    }
}

/// Equal-power crossfade curve for position `x` in `[0, 1]` (typically a transition's
/// progress): returns `(out, in)` linear amplitudes, `out = cos(x*pi/2)`, `in =
/// sin(x*pi/2)`. Because `cos^2 + sin^2 == 1` for every `x`, the acoustic *power* of the
/// two streams summed stays constant across the whole crossfade — unlike a linear
/// (`1-x`/`x`) fade, which dips in perceived loudness at the midpoint.
pub fn equal_power(x: f64) -> (f64, f64) {
    let theta = x * std::f64::consts::FRAC_PI_2;
    (theta.cos(), theta.sin())
}

/// One contribution to a source's total gain. String form (used in property paths like
/// `gain.xfade` and in JSON) is the lowercase variant name — see the [`FromStr`]/
/// [`fmt::Display`] impls below for the exact mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GainSlot {
    /// The user-facing volume control.
    User,
    /// A per-item volume override (library "override" volume).
    Override,
    /// Loudness normalization (today's per-item measured `loudnorm` value).
    Normalize,
    /// The user's mute toggle.
    Mute,
    /// Auto-mute (automatic ducking when another app's audio is detected).
    AutoMute,
    /// The equal-power crossfade contribution during a transition.
    Xfade,
    /// The short anti-click ramp at a hold boundary (≤ 30 ms).
    AntiClick,
    /// The player-pause anti-click gate's own ramp (R88; final review I2): a slot of its
    /// own so the gate — wall-clock timed while the player clock is frozen — never
    /// shares a writer with the recipe/retire/park ramps on `anticlick`, and can gate any
    /// playing source whatever transition it's part of.
    Pause,
}

impl GainSlot {
    /// All eight slots, in declaration order — used by the round-trip test and by any
    /// future caller that needs to enumerate every slot (e.g. building a default
    /// `Gains` or listing `gain.*` property paths).
    pub const ALL: [GainSlot; 8] = [
        GainSlot::User,
        GainSlot::Override,
        GainSlot::Normalize,
        GainSlot::Mute,
        GainSlot::AutoMute,
        GainSlot::Xfade,
        GainSlot::AntiClick,
        GainSlot::Pause,
    ];

    /// The lowercase string form used in property paths (`gain.<slot>`) and JSON.
    pub fn as_str(&self) -> &'static str {
        match self {
            GainSlot::User => "user",
            GainSlot::Override => "override",
            GainSlot::Normalize => "normalize",
            GainSlot::Mute => "mute",
            GainSlot::AutoMute => "automute",
            GainSlot::Xfade => "xfade",
            GainSlot::AntiClick => "anticlick",
            GainSlot::Pause => "pause",
        }
    }
}

impl fmt::Display for GainSlot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error returned by [`GainSlot::from_str`] for a string that isn't one of the eight
/// lowercase slot names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseGainSlotError(pub String);

impl fmt::Display for ParseGainSlotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown gain slot: {:?}", self.0)
    }
}

impl std::error::Error for ParseGainSlotError {}

impl FromStr for GainSlot {
    type Err = ParseGainSlotError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(GainSlot::User),
            "override" => Ok(GainSlot::Override),
            "normalize" => Ok(GainSlot::Normalize),
            "mute" => Ok(GainSlot::Mute),
            "automute" => Ok(GainSlot::AutoMute),
            "xfade" => Ok(GainSlot::Xfade),
            "anticlick" => Ok(GainSlot::AntiClick),
            "pause" => Ok(GainSlot::Pause),
            other => Err(ParseGainSlotError(other.to_string())),
        }
    }
}

/// A source's total gain: every active contribution, each in dB, keyed by slot. A slot
/// absent from the map contributes `0 dB` (unity), so a freshly-`default()`ed `Gains` is
/// silent-free (`effective_db() == 0.0`) until something sets a slot.
///
/// Slots are summed in dB (equivalent to multiplying their linear amplitudes), which is
/// exactly how independent gain stages compose acoustically — this is *why* the player
/// tracks gain in dB instead of a linear 0..1 "volume" that would need to be multiplied
/// and then re-expressed non-linearly at each edge.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Gains(BTreeMap<GainSlot, f64>);

impl Gains {
    /// An empty `Gains` (every slot at the implicit 0 dB default).
    pub fn new() -> Self {
        Gains(BTreeMap::new())
    }

    /// Sets (replacing any previous value) the gain of one slot, in dB.
    pub fn set(&mut self, slot: GainSlot, db: f64) {
        self.0.insert(slot, db);
    }

    /// Returns the dB currently set for a slot, or `0.0` if it was never set.
    pub fn get(&self, slot: GainSlot) -> f64 {
        self.0.get(&slot).copied().unwrap_or(0.0)
    }

    /// The combined gain of every set slot: their dB values summed, clamped to
    /// `[SILENT_DB, MAX_DB]`. A single slot at or below `SILENT_DB` (e.g. `Mute`) always
    /// dominates the sum down to exactly `SILENT_DB`, because dB values only ever add
    /// downward from there once clamped — but more directly, summing any set of dB values
    /// where one term is already `<= SILENT_DB` and the rest are within the slots' sane
    /// range still lands at or below `SILENT_DB` before clamping, and the clamp then pins
    /// it to exactly `SILENT_DB`.
    pub fn effective_db(&self) -> f64 {
        let sum: f64 = self.0.values().sum();
        sum.clamp(SILENT_DB, MAX_DB)
    }
}

/// mpv edge: clamps a dB value to mpv's own `volume-gain` range (`[-96, 12]`, i.e.
/// `[SILENT_DB, MAX_DB]`) for the `volume-gain` property. `volume-gain` is already exact
/// dB (measured: `volume-gain=-6` → −6.02 dB) — unlike `volume`, which is cubic — so this
/// is purely a clamp, no curve conversion.
pub fn mpv_volume_gain(db: f64) -> f64 {
    db.clamp(SILENT_DB, MAX_DB)
}

/// PulseAudio/PipeWire-pulse software-volume edge: converts a dB value to a raw
/// `pa_volume_t` (the integer stream-volume unit where `65536` = 100% = 0 dB), via
/// PulseAudio's cubic `pa_sw_volume_from_linear` curve: `pa_volume = round(65536 *
/// cbrt(linear))`, where `linear = db_to_lin(db)`. Measured: 50% volume is −18.07 dB
/// (cubic), matching mpv's plain `volume` property — both follow the same PulseAudio
/// convention. Nothing in Phase 1 calls this (the player drives mpv via `volume-gain`,
/// not PulseAudio stream volumes, for in-player sources); it is kept `pub` because design
/// §5.3 names it as the PulseAudio/PipeWire-pulse edge conversion, and Phase 3 (direct
/// PulseAudio stream control, e.g. for scene/web worker audio) will consume it.
pub fn pulse_volume_from_db(db: f64) -> u32 {
    let linear = db_to_lin(db);
    (65536.0 * linear.cbrt()).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS_TIGHT: f64 = 1e-8;
    const EPS_DB: f64 = 1e-4;

    #[test]
    fn equal_power_mid() {
        let (out, in_) = equal_power(0.5);
        assert!(
            (out - std::f64::consts::FRAC_1_SQRT_2).abs() < EPS_TIGHT,
            "out = {out}"
        );
        assert!(
            (in_ - std::f64::consts::FRAC_1_SQRT_2).abs() < EPS_TIGHT,
            "in = {in_}"
        );

        let out_db = lin_to_db(out);
        let in_db = lin_to_db(in_);
        assert!((out_db - (-3.0103)).abs() < EPS_DB, "out_db = {out_db}");
        assert!((in_db - (-3.0103)).abs() < EPS_DB, "in_db = {in_db}");
    }

    #[test]
    fn equal_power_sums_to_unity_power() {
        let mut x = 0.0;
        while x <= 1.0 + 1e-9 {
            let (out, in_) = equal_power(x);
            let power = out * out + in_ * in_;
            assert!(
                (power - 1.0).abs() < 1e-12,
                "x = {x}, power = {power} (out={out}, in={in_})"
            );
            x += 0.1;
        }
    }

    #[test]
    fn gains_sum() {
        let mut g = Gains::new();
        g.set(GainSlot::User, -6.0);
        g.set(GainSlot::Normalize, -4.5);
        g.set(GainSlot::Xfade, -3.0103);
        let total = g.effective_db();
        assert!((total - (-13.5103)).abs() < EPS_DB, "total = {total}");

        g.set(GainSlot::Mute, -96.0);
        assert_eq!(
            g.effective_db(),
            -96.0,
            "Mute at SILENT_DB must dominate the sum down to exactly -96.0"
        );
    }

    #[test]
    fn pulse_cubic() {
        let half = pulse_volume_from_db(-18.0618);
        assert!(
            half.abs_diff(32768) <= 1,
            "pulse_volume_from_db(-18.0618) = {half}, want 32768 +/- 1"
        );

        let full = pulse_volume_from_db(0.0);
        assert_eq!(full, 65536);
    }

    #[test]
    fn mpv_clamp() {
        assert_eq!(mpv_volume_gain(-200.0), -96.0);
        assert_eq!(mpv_volume_gain(20.0), 12.0);
    }

    #[test]
    fn gain_slot_round_trip() {
        for slot in GainSlot::ALL {
            let s = slot.to_string();
            let parsed: GainSlot = s
                .parse()
                .expect("every slot's Display output must parse back");
            assert_eq!(parsed, slot, "round trip failed for {s:?}");
        }

        let expected = [
            (GainSlot::User, "user"),
            (GainSlot::Override, "override"),
            (GainSlot::Normalize, "normalize"),
            (GainSlot::Mute, "mute"),
            (GainSlot::AutoMute, "automute"),
            (GainSlot::Xfade, "xfade"),
            (GainSlot::AntiClick, "anticlick"),
        ];
        for (slot, name) in expected {
            assert_eq!(slot.as_str(), name);
            assert_eq!(slot.to_string(), name);
            assert_eq!(name.parse::<GainSlot>().unwrap(), slot);
        }
    }
}
