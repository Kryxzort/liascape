//! Audio (spec §5.3; Task 14): the player audio bus ([`Bus`], `bus.rs`) — one in-process
//! PipeWire loopback sink every wallpaper plays into, forwarded to the default sink — and
//! the bus meter ([`Meter`], `meter.rs`) on its monitor. See `.claude/rules/player-core.md`
//! § Audio bus.
//!
//! [`Audio::start`] is what `serve` runs: the bus + its meter, or — when the bus can't or
//! shouldn't exist — the reason, logged once as `audio.bus.down {reason}`. Sources then keep
//! mpv's default device and the meter reports itself unavailable.

pub mod bus;
pub mod meter;

use serde_json::json;

pub use bus::{Bus, BusInfo, BusState};
pub use meter::{Meter, MeterStatus};

use crate::log::{self, Level};

/// The bus and its meter, or why there are none.
pub struct Audio {
    pub bus: Option<Bus>,
    pub meter: Option<Meter>,
    /// Set when `bus` is `None`.
    pub down_reason: Option<String>,
}

impl Audio {
    /// Create the bus for sources playing through mpv's `ao` (`None` = lp-player's default,
    /// `pipewire`). Any other AO never reaches the bus (`--ao null` in tests — R26 — would
    /// only add a sink to the owner's session for nothing), so none is created for it.
    pub fn start(ao: Option<&str>) -> Audio {
        let ao = ao.unwrap_or(crate::sources::mpv::DEFAULT_AO);
        if ao != "pipewire" {
            return Audio::down(format!(
                "--ao {ao}: sources don't play through PipeWire's pipewire AO, so they can't \
                 target the bus"
            ));
        }
        match Bus::create() {
            Ok(bus) => {
                let info = bus.info();
                log::event(
                    "audio",
                    Level::Info,
                    "audio.bus.up",
                    None,
                    json!({
                        "device": info.device,
                        "latency_ms": info.latency_ms,
                        "latency_samples": info.latency_samples,
                        "quantum_ms": info.quantum_ms,
                        "target": info.target,
                    }),
                );
                let meter = Meter::start(&bus);
                Audio {
                    bus: Some(bus),
                    meter: Some(meter),
                    down_reason: None,
                }
            }
            Err(reason) => Audio::down(reason),
        }
    }

    /// No bus: log `audio.bus.down {reason}`.
    pub fn down(reason: String) -> Audio {
        log::event(
            "audio",
            Level::Warn,
            "audio.bus.down",
            None,
            json!({ "reason": reason }),
        );
        Audio {
            bus: None,
            meter: None,
            down_reason: Some(reason),
        }
    }

    /// The meter, if it exists (it may still be unavailable — see [`Meter::available`]).
    pub fn meter(&self) -> Option<&Meter> {
        self.meter.as_ref()
    }

    /// Why the meter is unavailable, or `None` when it is available.
    pub fn meter_unavailable(&self) -> Option<String> {
        match (&self.bus, &self.meter) {
            (None, _) => Some(format!(
                "audio bus down ({})",
                self.down_reason.as_deref().unwrap_or("?")
            )),
            (Some(b), _) if b.state() == BusState::Down => Some(format!(
                "audio bus down ({})",
                b.info().reason.unwrap_or_default()
            )),
            (_, None) => Some("no meter".into()),
            (_, Some(m)) => {
                let st = m.status();
                if st.available {
                    None
                } else if let Some(e) = st.error {
                    Some(e)
                } else if !st.streaming {
                    Some("meter stream not streaming yet".into())
                } else {
                    Some(format!(
                        "no meter sample in the last {} ms",
                        meter::STALE.as_millis()
                    ))
                }
            }
        }
    }
}

impl Audio {
    /// Stop the meter, unload the bus (`audio.bus.down {reason: "shutdown"}`). Run after
    /// every source is gone, so no stream is left targeting a vanished sink. Idempotent.
    pub fn close(&mut self) {
        // The meter's capture stream lives on the bus's own `lp-bus` thread and borrows its
        // core (`bus.rs`'s module doc) — stop it first, so no capture callback can still be
        // running against a connection that's about to go away.
        self.meter = None;
        // Then the bus itself, explicitly (not just `Option::take`'s return value dropping
        // at the end of the `if`): the drop is the actual teardown step (unloads the
        // loopback module, which takes the sink with it), so it's spelled out rather than
        // left implicit.
        let bus = self.bus.take();
        if let Some(b) = bus {
            drop(b);
            self.down_reason = Some("shutdown".into());
            log::event(
                "audio",
                Level::Info,
                "audio.bus.down",
                None,
                json!({ "reason": "shutdown" }),
            );
        }
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.close();
    }
}
