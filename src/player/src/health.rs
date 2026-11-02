//! Feature health (owner, 2026-10-28: "make missing libraries fail loudly"): which of the player's
//! optional pieces work HERE, and why not — so the backend can put a warning on the setting a missing
//! piece breaks instead of the feature degrading silently. Each entry is `{ok, reason, …}` (`reason`
//! null when ok); `ok: null` = not known yet (the VRAM check runs once, off the loop).
//!
//! - `effects` — the transitions catalogue (`Catalogue::resolve_dir`): none → every switch is a cut.
//! - `vram` — a VRAM measurement (`vram::probe_from_env`, one sample): none → "Limit VRAM per scene" and
//!   "When VRAM runs low" can't act (e.g. an Intel GPU: no NVML, no AMD sysfs, no nvidia-smi).
//! - `hwdec_interop` — the render worker's GL interop for hardware-decoded frames (running player only):
//!   none → hardware decoding copies every frame through the CPU.
//! - `scenes` — the `scene` capability's rule (`Runtime::scenes_available` / `scene-check`).
//! - `automute` — the `automute` capability (the in-player auto-mute Signal): its env gate
//!   (`LIASCAPE_PLAYER_AUTOMUTE=0` turns it off) and the audio bus up. Without it the backend's
//!   `AudioMonitor` mutes only while the app is open. `liascape-player health` knows only the gate
//!   (`ok: null` when on: the bus is known once a player runs).
//! - `bus` — the player audio bus itself (§ Audio bus): up (or re-targeting) = ok; down = sources play on mpv's
//!   default device instead (nothing stops working, the bus meter and the in-player auto-mute do), with the
//!   reason (`--ao` other than pipewire, `LIASCAPE_PLAYER_BUS=off`, no PipeWire / session manager). `ok: null`
//!   while the first session is still being set up, and in `liascape-player health` (no player: the bus is
//!   known once one runs; `LIASCAPE_PLAYER_BUS=off` is known).
//!
//! `hello.health` carries them for a running player; `liascape-player health` prints the same (minus the
//! interop, which needs the render worker's GL context) when none runs.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::{Value, json};

use crate::audio::bus::{BusInfo, BusState, CONNECTING_REASON};

/// `effects` from a resolved catalogue dir (None = none resolved) and its effect count.
pub fn effects_json(dir: Option<&Path>, count: usize) -> Value {
    match dir {
        Some(d) if count > 0 => json!({ "ok": true, "reason": null, "dir": d, "count": count }),
        Some(d) => json!({ "ok": false, "dir": d, "count": 0,
            "reason": format!("the transitions catalogue at {} has no effects — every switch is a cut", d.display()) }),
        None => json!({ "ok": false, "dir": null, "count": 0,
            "reason": "no transitions catalogue found (LIASCAPE_TRANSITIONS_DIR, ~/.local/lib/liascape/transitions, \
                       the repo) — every switch is a cut" }),
    }
}

/// `effects` for this environment (loads the manifest — cheap: no shader is compiled).
pub fn effects_here() -> Value {
    match crate::gfx::effects::Catalogue::resolve_dir() {
        Some(d) => match crate::gfx::effects::Catalogue::load(&d) {
            Ok(c) => effects_json(Some(&d), c.ids().len()),
            Err(e) => json!({ "ok": false, "dir": d, "count": 0,
                "reason": format!("the transitions catalogue at {} doesn't load ({e}) — every switch is a cut", d.display()) }),
        },
        None => effects_json(None, 0),
    }
}

/// `vram` from a probe's name and one sample's outcome.
pub fn vram_json(probe: &str, sample: Result<(), String>) -> Value {
    match sample {
        Ok(()) => json!({ "ok": true, "reason": null, "probe": probe }),
        Err(e) => json!({ "ok": false, "probe": probe,
            "reason": format!("no VRAM measurement here ({e}) — the per-scene VRAM limit and the low-VRAM rule can't act") }),
    }
}

/// One sample from the probe `LIASCAPE_PLAYER_VRAM_PROBE` picks (blocking: nvidia-smi may be spawned).
pub fn vram_here() -> Value {
    let mut p = crate::vram::probe_from_env();
    let name = p.name();
    vram_json(name, p.sample(&[]).map(|_| ()))
}

static VRAM: OnceLock<Value> = OnceLock::new();

/// Start the VRAM check on its own thread (serve start): `hello` must never wait for it.
pub fn warm() {
    let _ = std::thread::Builder::new()
        .name("lia-health".into())
        .spawn(|| {
            VRAM.get_or_init(vram_here);
        });
}

/// The VRAM check's answer, or `ok: null` while it still runs.
pub fn vram_cached() -> Value {
    VRAM.get()
        .cloned()
        .unwrap_or_else(|| json!({ "ok": null, "reason": null, "pending": true }))
}

/// `hwdec_interop` from the render worker's interop (`has_worker` false = no render worker yet).
pub fn hwdec_json(has_worker: bool, interop: Option<&str>) -> Value {
    match (has_worker, interop) {
        (_, Some(i)) => json!({ "ok": true, "reason": null, "interop": i }),
        (true, None) => json!({ "ok": false, "interop": null,
            "reason": "no GL interop for hardware-decoded video on this GPU/driver — hardware decoding copies every frame through the CPU (slower, more CPU)" }),
        (false, None) => json!({ "ok": null, "reason": null, "interop": null }),
    }
}

/// `bus` from why there is no bus at all (`Audio::down_reason`) or the bus's `BusInfo`; neither = no answer yet.
/// `state` is the bus probe's (`up` | `retargeting` | `down` | `off`).
pub fn bus_json(off_reason: Option<&str>, info: Option<&BusInfo>) -> Value {
    const NOTE: &str = "sources play on mpv's default device instead (nothing stops, but there is no bus meter and no in-player auto-mute)";
    match (off_reason, info) {
        (Some(r), _) => json!({ "ok": false, "state": "off",
            "reason": format!("the player's audio bus is off ({r}) — {NOTE}") }),
        (None, Some(i)) if i.state != BusState::Down => {
            json!({ "ok": true, "reason": null, "state": i.state })
        }
        // the first session is still being set up: not a failure (yet)
        (None, Some(i)) if i.generation == 0 && i.reason.as_deref() == Some(CONNECTING_REASON) => {
            json!({ "ok": null, "reason": null, "state": i.state })
        }
        (None, Some(i)) => json!({ "ok": false, "state": i.state,
            "reason": format!("the player's audio bus is down ({}) — {NOTE}; it keeps retrying",
                i.reason.as_deref().unwrap_or("no PipeWire / session manager reachable")) }),
        (None, None) => json!({ "ok": null, "reason": null, "state": null }),
    }
}

/// `bus` for `liascape-player health` (no player running): only `LIASCAPE_PLAYER_BUS=off` is known.
pub fn bus_here() -> Value {
    if std::env::var("LIASCAPE_PLAYER_BUS").is_ok_and(|v| v == "off") {
        bus_json(Some("disabled by LIASCAPE_PLAYER_BUS=off"), None)
    } else {
        bus_json(None, None)
    }
}

/// `automute` from the env gate and whether the audio bus is up.
pub fn automute_json(env: bool, bus_up: bool) -> Value {
    match (env, bus_up) {
        (false, _) => json!({ "ok": false,
            "reason": "LIASCAPE_PLAYER_AUTOMUTE=0 — the in-player auto-mute is off" }),
        (true, true) => json!({ "ok": true, "reason": null }),
        (true, false) => json!({ "ok": false,
            "reason": "the player's audio bus is down (no PipeWire / session manager reachable, or --ao null) — no in-player auto-mute" }),
    }
}

/// `automute` for `liascape-player health` (no player running): the env gate only.
pub fn automute_here() -> Value {
    if crate::signal::automute::env_enabled() {
        json!({ "ok": null, "reason": null })
    } else {
        automute_json(false, false)
    }
}

/// `scenes` from the scene rule's outcome.
pub fn scenes_json(r: Result<(), String>) -> Value {
    match r {
        Ok(()) => json!({ "ok": true, "reason": null }),
        Err(e) => json!({ "ok": false, "reason": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effects_cases() {
        assert_eq!(effects_json(Some(Path::new("/t")), 3)["ok"], true);
        let none = effects_json(None, 0);
        assert_eq!(none["ok"], false);
        assert!(none["reason"].as_str().unwrap().contains("cut"));
        assert_eq!(effects_json(Some(Path::new("/t")), 0)["ok"], false);
    }

    #[test]
    fn vram_cases() {
        assert_eq!(vram_json("nvml", Ok(()))["ok"], true);
        let no = vram_json("none", Err("disabled by LIASCAPE_PLAYER_VRAM_PROBE=none".into()));
        assert_eq!(no["ok"], false);
        assert_eq!(no["probe"], "none");
        assert!(no["reason"].as_str().unwrap().contains("LIASCAPE_PLAYER_VRAM_PROBE=none"));
    }

    #[test]
    fn hwdec_cases() {
        assert_eq!(hwdec_json(true, Some("cuda"))["ok"], true);
        assert_eq!(hwdec_json(true, None)["ok"], false);
        assert!(hwdec_json(false, None)["ok"].is_null());
    }

    #[test]
    fn automute_cases() {
        assert_eq!(automute_json(true, true)["ok"], true);
        let off = automute_json(false, true);
        assert_eq!(off["ok"], false);
        assert!(off["reason"].as_str().unwrap().contains("LIASCAPE_PLAYER_AUTOMUTE=0"), "{off}");
        let down = automute_json(true, false);
        assert_eq!(down["ok"], false);
        assert!(down["reason"].as_str().unwrap().contains("audio bus"), "{down}");
    }

    fn info(state: BusState, generation: u64, reason: Option<&str>) -> BusInfo {
        BusInfo {
            state,
            device: "pipewire/liascape-player-bus".into(),
            latency_ms: 0.0,
            latency_samples: 0,
            quantum_ms: 0.0,
            target: None,
            default_sink: None,
            playback_node: None,
            sink_node: None,
            retargets: 0,
            connecting: state == BusState::Down,
            generation,
            requested: None,
            overridden: false,
            reason: reason.map(Into::into),
        }
    }

    #[test]
    fn bus_cases() {
        assert_eq!(bus_json(None, Some(&info(BusState::Up, 1, None)))["ok"], true);
        assert_eq!(bus_json(None, Some(&info(BusState::Retargeting, 1, None)))["ok"], true);
        // first connect still running: unknown, not down
        assert!(bus_json(None, Some(&info(BusState::Down, 0, Some(CONNECTING_REASON))))["ok"].is_null());
        // a failed attempt / a lost session: down, with the reason
        let failed = bus_json(None, Some(&info(BusState::Down, 0, Some("no session manager"))));
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["state"], "down");
        assert!(failed["reason"].as_str().unwrap().contains("no session manager"), "{failed}");
        assert!(failed["reason"].as_str().unwrap().contains("default device"), "{failed}");
        assert_eq!(bus_json(None, Some(&info(BusState::Down, 2, Some(CONNECTING_REASON))))["ok"], false);
        // no bus at all
        let off = bus_json(Some("--ao null"), None);
        assert_eq!(off["ok"], false);
        assert_eq!(off["state"], "off");
        assert!(off["reason"].as_str().unwrap().contains("--ao null"), "{off}");
        assert!(bus_json(None, None)["ok"].is_null());
    }

    #[test]
    fn scenes_cases() {
        assert_eq!(scenes_json(Ok(()))["ok"], true);
        assert_eq!(scenes_json(Err("x".into()))["reason"], "x");
    }
}
