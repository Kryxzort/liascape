//! Pure scene helpers (Phase 2; `.claude/rules/player-core.md` § Scene worker): the export
//! size of a scene's frame ring ([`cover_size`]), the synthetic test scene's spec
//! ([`synthetic`], D7), WE's assets dir ([`assets`], Task 7), the pointer → scene mapping
//! ([`pointer`], Task 7) and the worker GPU budget ([`budget`], Task 8). No GPU.

pub mod assets;
pub mod budget;
pub mod pointer;
pub mod synthetic;

/// Longest edge a scene's ring is ever exported at (same cap as `MpvSource`'s targets).
pub const MAX_EDGE: u32 = 4096;

/// The size a scene with `native` size is rendered/exported at for outputs needing `demand`
/// (the largest output showing it): the scene's aspect kept, the smallest size whose scale
/// covers `demand` on both axes (`fill`), never above `native`, long edge ≤ [`MAX_EDGE`].
/// A degenerate input (0 on any axis) gives `native` clamped to ≥ 1.
pub fn cover_size(native: (u32, u32), demand: (u32, u32)) -> (u32, u32) {
    let (nw, nh) = (native.0.max(1), native.1.max(1));
    if native.0 == 0 || native.1 == 0 || demand.0 == 0 || demand.1 == 0 {
        return cap((nw, nh));
    }
    let scale = (demand.0 as f64 / nw as f64)
        .max(demand.1 as f64 / nh as f64)
        .min(1.0);
    let w = ((nw as f64 * scale).round() as u32).clamp(1, nw);
    let h = ((nh as f64 * scale).round() as u32).clamp(1, nh);
    // Rounding must never undercover the demand (it could by < 1 px on the minor axis).
    let w = w.max(demand.0.min(nw));
    let h = h.max(demand.1.min(nh));
    cap((w, h))
}

fn cap((w, h): (u32, u32)) -> (u32, u32) {
    let long = w.max(h);
    if long <= MAX_EDGE {
        return (w, h);
    }
    let s = MAX_EDGE as f64 / long as f64;
    (
        ((w as f64 * s).round() as u32).max(1),
        ((h as f64 * s).round() as u32).max(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_size_examples() {
        let d = (1920, 1080);
        assert_eq!(cover_size((3840, 2160), d), (1920, 1080));
        assert_eq!(cover_size((2048, 1423), d), (1920, 1334));
        assert_eq!(cover_size((3840, 1080), d), (3840, 1080));
        assert_eq!(cover_size((7467, 4200), d), (1920, 1080));
        assert_eq!(cover_size((1280, 720), d), (1280, 720));
        // Portrait scene on a landscape output: width covers, height follows (and is capped).
        assert_eq!(cover_size((1080, 1920), d), (1080, 1920));
        assert_eq!(cover_size((2160, 3840), d), (1920, 3413));
        // Long edge cap.
        assert_eq!(cover_size((8192, 2048), (8192, 2048)), (4096, 1024));
        // Degenerate.
        assert_eq!(cover_size((0, 0), d), (1, 1));
        assert_eq!(cover_size((640, 360), (0, 0)), (640, 360));
    }
}
