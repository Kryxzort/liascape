//! The desktop pointer (audit C6, 2026-11-06): where the cursor is on the whole desktop, over
//! windows and other monitors too — what WE's render loop reads every frame with `GetCursorPos`
//! (FUN_140141520 → `ScreenToClient` of the wallpaper's window ÷ its size; a point off the
//! window is outside 0..1). A Wayland client sees the pointer only over its own surface, so
//! without this the scenes' cursor freezes under windows and its return is a jump.
//!
//! - **Source:** Hyprland's read-only `cursorpos` request on `.socket.sock` (global layout
//!   coordinates, logical pixels — the same space as each output's xdg-output logical position).
//!   No Wayland protocol gives a client the global pointer (wlr-virtual-pointer is write-only,
//!   libinput needs root) and socket2 has no cursor events, so it is polled — on the `lia-cursor`
//!   thread, never on the loop. `LIASCAPE_PLAYER_POINTER_SOURCE` = `hyprland` | `surface` forces
//!   one; default: Hyprland when `HYPRLAND_INSTANCE_SIGNATURE` is set and the backend is Wayland,
//!   else the surface (headless tests force `hyprland` against a fake socket).
//! - **Rate:** like WE (one read per frame), the thread polls at the fastest rate of the scenes
//!   it serves ([`Desktop::set_rate`]: the highest `demand_hz` of the unpaused scenes); no scene
//!   → it parks (no request at all). A reading is published only when the position changed, so
//!   the loop's per-iteration check is one atomic load.
//! - **Fallback:** until the first reading (or after a failure: no socket, a dead Hyprland) the
//!   runtime keeps the surface pointer (`wl_pointer` over the wallpaper's own surface, entries
//!   as jumps — the behaviour before). It retries every [`RETRY`].
//!
//! See `docs/player/modules/scene-source.md` § Assets, properties, inputs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::hypr;

/// Retry after a failed request.
pub const RETRY: Duration = Duration::from_secs(2);
/// How long the idle thread parks between checks of the rate (a rate set unparks it at once).
const IDLE: Duration = Duration::from_millis(500);
/// The fastest the thread ever polls.
pub const MAX_HZ: f64 = 1000.0;

#[derive(Debug, Default, Clone)]
pub struct Status {
    /// The newest desktop position (logical pixels).
    pub pos: Option<(f64, f64)>,
    /// `None` = no reading yet; `Some(false)` = the last request failed (`reason`).
    pub ok: Option<bool>,
    pub reason: Option<String>,
    pub polls: u64,
    pub changes: u64,
    pub fails: u64,
    /// Wall time spent in requests (connect + write + read), for the cost.
    pub busy: Duration,
}

#[derive(Default)]
struct Inner {
    version: AtomicU64,
    rate_bits: AtomicU64,
    st: Mutex<Status>,
    thread: OnceLock<std::thread::Thread>,
}

/// What the `lia-cursor` thread publishes and the runtime reads.
#[derive(Clone, Default)]
pub struct Desktop(Arc<Inner>);

impl Desktop {
    fn lock(&self) -> std::sync::MutexGuard<'_, Status> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bumped on every new position and every status change: one atomic load per check.
    pub fn version(&self) -> u64 {
        self.0.version.load(Ordering::Acquire)
    }

    pub fn status(&self) -> Status {
        self.lock().clone()
    }

    /// A reading works and there is a position: the runtime uses it instead of the surface's.
    pub fn usable(&self) -> Option<(f64, f64)> {
        let st = self.lock();
        if st.ok == Some(true) { st.pos } else { None }
    }

    /// The rate the thread polls at (0 = parked). Wakes it when it changes.
    pub fn set_rate(&self, hz: f64) {
        let hz = if hz.is_finite() {
            hz.clamp(0.0, MAX_HZ)
        } else {
            0.0
        };
        let old = self.0.rate_bits.swap(hz.to_bits(), Ordering::AcqRel);
        if old != hz.to_bits()
            && let Some(t) = self.0.thread.get()
        {
            t.unpark();
        }
    }

    pub fn rate(&self) -> f64 {
        f64::from_bits(self.0.rate_bits.load(Ordering::Acquire))
    }

    /// A reading (`took` = the request's wall time).
    pub fn publish(&self, pos: (f64, f64), took: Duration) {
        let mut st = self.lock();
        st.polls += 1;
        st.busy += took;
        if st.pos != Some(pos) || st.ok != Some(true) {
            st.changes += 1;
            st.pos = Some(pos);
            st.ok = Some(true);
            st.reason = None;
            self.0.version.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub fn fail(&self, reason: String) {
        let mut st = self.lock();
        st.fails += 1;
        if st.ok != Some(false) || st.reason.as_deref() != Some(reason.as_str()) {
            st.ok = Some(false);
            st.reason = Some(reason);
            self.0.version.fetch_add(1, Ordering::AcqRel);
        }
    }
}

/// Hyprland's `cursorpos` reply (`"1440, 540"`) → the position.
pub fn parse_cursorpos(s: &str) -> Option<(f64, f64)> {
    let (x, y) = s.trim().split_once(',')?;
    let (x, y) = (x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Desktop point `g` (logical) → output pixels, for an output at `rect` = `[x, y, w, h]`
/// (logical, its xdg-output position and size) drawn at `size` pixels — WE's `ScreenToClient`
/// ÷ the window size × our surface's pixels. Not clamped: a point on another monitor lies
/// outside `0..size`, as WE's does outside 0..1.
pub fn desktop_to_output(g: (f64, f64), rect: [f64; 4], size: (f64, f64)) -> Option<(f64, f64)> {
    let [x, y, w, h] = rect;
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some(((g.0 - x) / w * size.0, (g.1 - y) / h * size.1))
}

/// The dir of `.socket.sock` among `dirs` (re-resolved on every retry).
fn pick(dirs: &[PathBuf]) -> Result<&Path, String> {
    dirs.iter()
        .map(PathBuf::as_path)
        .find(|d| d.join(".socket.sock").exists())
        .ok_or_else(|| {
            format!(
                "no Hyprland IPC socket (.socket.sock) in {}",
                dirs.iter()
                    .map(|d| d.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

/// Start `lia-cursor` polling Hyprland instance `sig`'s `cursorpos`.
pub fn spawn_hyprland(sig: &str, feed: Desktop, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    let dirs = hypr::dirs(sig);
    let f = feed.clone();
    let h = std::thread::Builder::new()
        .name("lia-cursor".into())
        .spawn(move || run(&dirs, &f, &stop))?;
    let _ = feed.0.thread.set(h.thread().clone());
    Ok(())
}

fn run(dirs: &[PathBuf], feed: &Desktop, stop: &AtomicBool) {
    let mut next = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let hz = feed.rate();
        if hz <= 0.0 {
            std::thread::park_timeout(IDLE);
            next = Instant::now();
            continue;
        }
        let t0 = Instant::now();
        let got = pick(dirs)
            .map(Path::to_path_buf)
            .and_then(|d| hypr::request(&d, "cursorpos"))
            .and_then(|r| parse_cursorpos(&r).ok_or_else(|| format!("cursorpos replied {r:?}")));
        match got {
            Ok(p) => feed.publish(p, t0.elapsed()),
            Err(e) => {
                feed.fail(e);
                let end = Instant::now() + RETRY;
                while !stop.load(Ordering::Relaxed) && Instant::now() < end {
                    std::thread::park_timeout(end.saturating_duration_since(Instant::now()));
                }
                next = Instant::now();
                continue;
            }
        }
        next += Duration::from_secs_f64(1.0 / hz);
        let now = Instant::now();
        if next <= now {
            next = now; // behind (a slow reply): no burst to catch up
        } else {
            std::thread::sleep(next - now);
        }
    }
}

/// Which source the runtime uses ([`choose`]).
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Hyprland(String),
    Surface(String),
}

/// `forced` (`LIASCAPE_PLAYER_POINTER_SOURCE`) first; else Hyprland on Wayland when its
/// signature is set; else the surface (with why).
pub fn choose(headless: bool, forced: Option<&str>, hypr_sig: Option<&str>) -> Choice {
    let sig = hypr_sig.filter(|s| !s.is_empty());
    match forced.filter(|s| !s.is_empty()) {
        Some("surface" | "none" | "off") => {
            Choice::Surface("LIASCAPE_PLAYER_POINTER_SOURCE=surface".into())
        }
        Some("hyprland") => match sig {
            Some(s) => Choice::Hyprland(s.into()),
            None => Choice::Surface("HYPRLAND_INSTANCE_SIGNATURE is not set".into()),
        },
        _ if headless => Choice::Surface("headless outputs (the headless.pointer verb)".into()),
        _ => match sig {
            Some(s) => Choice::Hyprland(s.into()),
            None => Choice::Surface(
                "not Hyprland: no compositor gives a client the global pointer — the scene sees it \
                 only over the bare desktop"
                    .into(),
            ),
        },
    }
}

pub fn choose_from_env(headless: bool) -> Choice {
    let var = |k: &str| std::env::var(k).ok();
    choose(
        headless,
        var("LIASCAPE_PLAYER_POINTER_SOURCE").as_deref(),
        var("HYPRLAND_INSTANCE_SIGNATURE").as_deref(),
    )
}

// ---------------------------------------------------------------- the runtime's side

/// How often the runtime re-derives the poll rate and re-places the pointer on every scene
/// (a new scene, an output moved) even when the cursor is still.
pub const REFRESH: Duration = Duration::from_millis(250);

/// The runtime's desktop-pointer state (`Runtime::desktop_pointer`).
pub struct PointerRt {
    /// `hyprland` | `surface`.
    pub source: &'static str,
    /// Why the surface is used (no global source), or the thread couldn't start.
    pub reason: Option<String>,
    pub feed: Option<Desktop>,
    stop: Option<Arc<AtomicBool>>,
    /// The feed version last forwarded.
    pub seen: u64,
    /// Desktop positions were in use at the last iteration.
    pub live: bool,
    /// The surface's buttons per output (a press is only seen over the bare desktop).
    pub buttons: std::collections::BTreeMap<String, u32>,
    pub buttons_dirty: bool,
    /// The global source just went away: the next surface sample is a jump.
    pub surface_jump: bool,
    pub next_refresh: Option<Instant>,
    /// Desktop samples forwarded / of them jumps (a scene placed, not moved).
    pub forwards: u64,
    pub jumps: u64,
}

impl Drop for PointerRt {
    fn drop(&mut self) {
        if let Some(s) = &self.stop {
            s.store(true, Ordering::Relaxed);
        }
        if let Some(f) = &self.feed {
            f.set_rate(0.0);
            if let Some(t) = f.0.thread.get() {
                t.unpark();
            }
        }
    }
}

impl PointerRt {
    pub fn idle() -> PointerRt {
        PointerRt {
            source: "surface",
            reason: Some("not started".into()),
            feed: None,
            stop: None,
            seen: 0,
            live: false,
            buttons: Default::default(),
            buttons_dirty: false,
            surface_jump: false,
            next_refresh: None,
            forwards: 0,
            jumps: 0,
        }
    }

    pub fn start(choice: Choice) -> PointerRt {
        let mut p = PointerRt::idle();
        match choice {
            Choice::Surface(why) => p.reason = Some(why),
            Choice::Hyprland(sig) => {
                let feed = Desktop::default();
                let stop = Arc::new(AtomicBool::new(false));
                match spawn_hyprland(&sig, feed.clone(), stop.clone()) {
                    Ok(()) => {
                        p.source = "hyprland";
                        p.reason = None;
                        p.feed = Some(feed);
                        p.stop = Some(stop);
                    }
                    Err(e) => p.reason = Some(format!("can't start lia-cursor: {e}")),
                }
            }
        }
        p
    }

    /// The `pointer` probe.
    pub fn probe(&self) -> serde_json::Value {
        let st = self.feed.as_ref().map(Desktop::status).unwrap_or_default();
        let polls = st.polls.max(1);
        serde_json::json!({
            "source": self.source,
            "in_use": if self.live { "desktop" } else { "surface" },
            "ok": st.ok,
            "reason": st.reason.clone().or_else(|| self.reason.clone()),
            "rate_hz": self.feed.as_ref().map(Desktop::rate).unwrap_or(0.0),
            "pos": st.pos.map(|(x, y)| vec![x, y]),
            "polls": st.polls,
            "changes": st.changes,
            "fails": st.fails,
            "request_us_mean": if st.polls == 0 { 0.0 } else {
                st.busy.as_secs_f64() * 1e6 / polls as f64
            },
            "forwards": self.forwards,
            "jumps": self.jumps,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hyprlands_reply() {
        assert_eq!(parse_cursorpos("1440, 540\n"), Some((1440.0, 540.0)));
        assert_eq!(parse_cursorpos("-1920,0"), Some((-1920.0, 0.0)));
        assert_eq!(parse_cursorpos("12.5, 3.25"), Some((12.5, 3.25)));
        assert_eq!(parse_cursorpos("unknown request"), None);
        assert_eq!(parse_cursorpos(""), None);
    }

    #[test]
    fn maps_like_screen_to_client() {
        // DP-1 at -1920,0 (1920×1080 logical, drawn at 1920×1080 px); DP-2 at 0,0, scale 2.
        let dp1 = [-1920.0, 0.0, 1920.0, 1080.0];
        let dp2 = [0.0, 0.0, 1920.0, 1080.0];
        assert_eq!(
            desktop_to_output((-960.0, 540.0), dp1, (1920.0, 1080.0)),
            Some((960.0, 540.0))
        );
        assert_eq!(
            desktop_to_output((960.0, 540.0), dp2, (3840.0, 2160.0)),
            Some((1920.0, 1080.0))
        );
        // On the other monitor: outside the output, not clamped (WE: outside 0..1).
        assert_eq!(
            desktop_to_output((-960.0, 540.0), dp2, (1920.0, 1080.0)),
            Some((-960.0, 540.0))
        );
        assert_eq!(
            desktop_to_output((0.0, 0.0), [0.0, 0.0, 0.0, 1.0], (1.0, 1.0)),
            None
        );
    }

    #[test]
    fn choose_by_env() {
        assert_eq!(
            choose(false, None, Some("abc")),
            Choice::Hyprland("abc".into())
        );
        assert!(matches!(choose(false, None, None), Choice::Surface(_)));
        assert!(matches!(
            choose(true, None, Some("abc")),
            Choice::Surface(_)
        ));
        assert_eq!(
            choose(true, Some("hyprland"), Some("fake")),
            Choice::Hyprland("fake".into())
        );
        assert!(matches!(
            choose(false, Some("surface"), Some("abc")),
            Choice::Surface(_)
        ));
    }

    #[test]
    fn publishes_only_changes() {
        let d = Desktop::default();
        assert_eq!(d.usable(), None);
        d.publish((1.0, 2.0), Duration::ZERO);
        let v = d.version();
        assert_eq!(d.usable(), Some((1.0, 2.0)));
        d.publish((1.0, 2.0), Duration::ZERO);
        assert_eq!(d.version(), v, "same position: no change");
        d.fail("gone".into());
        assert_eq!(d.usable(), None, "a failure falls back");
        assert_ne!(d.version(), v);
        let st = d.status();
        assert_eq!((st.polls, st.fails), (2, 1));
    }
}
