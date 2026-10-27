//! The synthetic test scene (plan D7): `lp-synthetic.json` in a scene folder makes
//! `lp-scene-worker` render a known pattern instead of LWE — exact, repeatable checks of the
//! transport, timing, crashes and every switch combo without WE's proprietary assets. Only
//! honoured when the worker's environment has `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` (production
//! never sets it). The pattern maths live here so tests predict every checked pixel exactly.

use serde::{Deserialize, Serialize};

/// Side of the top-left frame marker block (image coordinates, top = texture row 0).
pub const MARKER: u32 = 64;
/// Side of the far-corner (bottom-right) gradient probe.
pub const PROBE: u32 = 16;
/// The rest of a `frame_index` frame.
pub const BACKGROUND: [u8; 3] = [32, 32, 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Pattern {
    /// Top-left [`MARKER`]² = [`marker_rgb`]`(seq)`, bottom-right [`PROBE`]² =
    /// [`grad_rgb`], the rest [`BACKGROUND`] (the spike's stale/torn detector).
    #[default]
    FrameIndex,
    /// `rgb` everywhere.
    Solid,
    /// Top half `rgb`, bottom half `rgb2` (the R25 orientation pin).
    SplitTb,
    /// `rgb2` background with an `rgb` dot (radius 16 px) at the last `Pointer` position.
    PointerDot,
    /// Grey level = the mean of the tick's visualiser `input` (0–255).
    InputLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fail {
    /// `Start` fails as if `wp_project_load` returned NULL.
    Load,
    /// `Start` fails as if the scene's first render produced nothing (size ≤ 1).
    Build,
}

/// `lp-synthetic.json`. Every field has a default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SyntheticSpec {
    pub pattern: Pattern,
    pub rgb: [u8; 3],
    pub rgb2: [u8; 3],
    /// The scene's native size (what `wp_project_get_width/height` would say).
    pub native: [u32; 2],
    /// Alpha the pattern is drawn with — the worker must force 1 (LWE's core leaves 0).
    pub alpha: f32,
    /// A per-pixel loop of this many iterations that never changes a pixel: GPU load
    /// (4000 ≈ 6 ms per 1080p frame on an RTX 3070 Ti, the spike's saturation point).
    pub gpu_work: u32,
    pub tone_hz: f64,
    pub tone_dbfs: f64,
    pub has_audio: bool,
    pub crash_after_ms: Option<u64>,
    pub hang_after_ms: Option<u64>,
    pub fail: Option<Fail>,
}

impl Default for SyntheticSpec {
    fn default() -> Self {
        SyntheticSpec {
            pattern: Pattern::FrameIndex,
            rgb: [255, 0, 0],
            rgb2: [0, 0, 255],
            native: [1920, 1080],
            alpha: 1.0,
            gpu_work: 0,
            tone_hz: 440.0,
            tone_dbfs: -20.0,
            has_audio: false,
            crash_after_ms: None,
            hang_after_ms: None,
            fail: None,
        }
    }
}

/// The marker colour of frame `seq`: `(seq & 255, (seq >> 8) & 255, 0)`.
pub fn marker_rgb(seq: u64) -> [u8; 3] {
    [(seq & 255) as u8, ((seq >> 8) & 255) as u8, 0]
}

/// The probe pixel at probe-local `(x, y)` (0..[`PROBE`], y from the image top) of frame
/// `seq` — integer maths the shader reproduces bit-exactly.
pub fn grad_rgb(x: u32, y: u32, seq: u64) -> [u8; 3] {
    let n = (seq & 0xffff) as u32;
    [
        ((x * 16 + n) & 255) as u8,
        ((y * 16 + 2 * n) & 255) as u8,
        ((x + y + 3 * n) & 255) as u8,
    ]
}
