//! The pointer over an output → a scene's own coordinates (mouse on): the
//! inverse of [`fit_rect`](crate::gfx::compose::fit_rect) for a plain source layer, so a
//! scene filled (cropped) or fitted (letterboxed) onto an output still sees the cursor where
//! it is drawn. Pure.

use crate::gfx::compose::UvRect;

/// Output surface pixel `(px, py)` (origin top-left, like `out:<c>.pointer`) → the source's
/// normalised `(u, v)` (origin = the image's top-left), or `None` when the point is
/// outside the drawn rectangle (a letterbox bar).
///
/// `rect` is [`fit_rect`](crate::gfx::compose::fit_rect)'s result for that layer. Its `dst`
/// is GL bottom-left based, but `fit_rect` always centres the drawn rectangle on both axes,
/// so its distance from the top equals `dst.y`; the plain-source draw maps the output's top
/// to `uv.y` (the flip in `compose::draw_rect`), so `v` grows downwards like `py`.
pub fn to_source_uv(rect: &UvRect, px: f64, py: f64) -> Option<(f64, f64)> {
    let [dx, dy, dw, dh] = rect.dst;
    if dw <= 0.0 || dh <= 0.0 {
        return None;
    }
    let fx = (px - dx) / dw;
    let fy = (py - dy) / dh;
    if !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
        return None;
    }
    let [ux, uy, uw, uh] = rect.uv;
    Some((ux + fx * uw, uy + fy * uh))
}

/// [`to_source_uv`] without the bounds: a point off the drawn rectangle (another monitor, a
/// letterbox bar) maps on along the same line — the desktop pointer, like WE's `ScreenToClient`
/// ÷ the window size, which goes outside 0..1 off the window. `None` only for an empty rect.
pub fn to_source_uv_unclamped(rect: &UvRect, px: f64, py: f64) -> Option<(f64, f64)> {
    let [dx, dy, dw, dh] = rect.dst;
    if dw <= 0.0 || dh <= 0.0 {
        return None;
    }
    let [ux, uy, uw, uh] = rect.uv;
    Some((ux + (px - dx) / dw * uw, uy + (py - dy) / dh * uh))
}

/// `(u, v)` → the scene's native pixels (what LWE's mouse callbacks hand `CScene`, which
/// divides by its own width/height).
pub fn to_native_px(uv: (f64, f64), native: [u32; 2]) -> (f64, f64) {
    (uv.0 * native[0] as f64, uv.1 * native[1] as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gfx::compose::fit_rect;
    use crate::graph::Fit;

    const FULL: [f64; 4] = [0.0, 0.0, 1.0, 1.0];

    #[test]
    fn pointer_maps_through_fill_and_viewport() {
        // A 2:1 scene filled into 16:9: the sides are cropped.
        let r = fit_rect((3840, 1920), (1920, 1080), Fit::Fill, FULL);
        let (u, v) = to_source_uv(&r, 960.0, 540.0).unwrap();
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u} {v}");
        let (u, v) = to_source_uv(&r, 0.0, 540.0).unwrap();
        assert!((u - 0.0556).abs() < 1e-3, "left edge u {u}");
        assert!((v - 0.5).abs() < 1e-9);
        let (_, v) = to_source_uv(&r, 960.0, 0.0).unwrap();
        assert!(v.abs() < 1e-9, "the output's top is the image's top: {v}");
        // Fitted (letterboxed): a point in the top bar is outside the picture.
        let r = fit_rect((3840, 1920), (1920, 1080), Fit::Fit, FULL);
        assert_eq!(to_source_uv(&r, 960.0, 10.0), None);
        let (_, v) = to_source_uv(&r, 960.0, 60.0).unwrap();
        assert!(
            v.abs() < 1e-9,
            "the picture starts below the 60 px bar: {v}"
        );
        // A viewport (the right half of a source spanned over two outputs).
        let r = fit_rect((3840, 1080), (1920, 1080), Fit::Fill, [0.5, 0.0, 0.5, 1.0]);
        let (u, _) = to_source_uv(&r, 0.0, 540.0).unwrap();
        assert!((u - 0.5).abs() < 1e-9, "{u}");
        let (u, _) = to_source_uv(&r, 1920.0, 540.0).unwrap();
        assert!((u - 1.0).abs() < 1e-9, "{u}");
        assert_eq!(to_native_px((0.5, 0.25), [3840, 2160]), (1920.0, 540.0));
    }

    #[test]
    fn unclamped_goes_on_past_the_edges() {
        let r = fit_rect((3840, 1920), (1920, 1080), Fit::Fill, FULL);
        let inside = to_source_uv(&r, 960.0, 540.0).unwrap();
        assert_eq!(to_source_uv_unclamped(&r, 960.0, 540.0), Some(inside));
        // One output width to the left (the cursor on the other monitor): u < 0, same line.
        let (u0, _) = to_source_uv_unclamped(&r, 0.0, 540.0).unwrap();
        let (u1, v1) = to_source_uv_unclamped(&r, -1920.0, 540.0).unwrap();
        assert!(
            u1 < 0.0 && (u0 - u1 - (inside.0 - u0) * 2.0).abs() < 1e-9,
            "{u0} {u1}"
        );
        assert!((v1 - 0.5).abs() < 1e-9);
        assert_eq!(to_source_uv(&r, -1920.0, 540.0), None);
    }
}
