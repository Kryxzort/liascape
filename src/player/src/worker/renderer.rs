//! Whether this install's scene worker can start at all (`docs/player/modules/scene-crash-policy.md` § Not a crash: a
//! worker the loader can't start): one process-wide state, since every worker runs the same binary and core.
//!
//! A worker the dynamic loader can't start ([`super::LOADER_FAILED`] before its `Hello`) marks the renderer missing:
//! `Runtime::scenes_available` then says so (no `scene` capability, `hello.health.scenes` and
//! `hello.scene_renderer_missing` carry the reason), so the backend can grey every scene up front instead of letting
//! each one fail. Any worker's `Hello` (a spare's too) clears it; while it stands, a `lia-renderer-probe` thread starts
//! the worker binary (`--features`) every [`recheck`] until one loads, since nothing else spawns a worker while
//! scenes are off (the core comes back without a rebuild when the devShell realises its store path again). Both
//! changes are outbox facts (`scene.renderer_missing`, `scene.renderer_found`), so a backend that was away hears of
//! them; it reads the state itself from `hello`. A fresh player process starts unknown (= fine): a restart on a build
//! whose worker loads is clean, and one whose worker doesn't is marked at its first scene.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};

use crate::log::{self, Level};

/// The reason (with the loader's line) while the renderer is missing; the probe thread runs while `probing`.
struct State {
    missing: Option<Missing>,
    probing: bool,
}

#[derive(Clone)]
struct Missing {
    detail: String,
    bin: PathBuf,
}

static STATE: Mutex<State> = Mutex::new(State {
    missing: None,
    probing: false,
});

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// `LIASCAPE_SCENE_RENDERER_RECHECK_MS` (tests), else 15 s: how often a missing renderer is looked for again.
pub fn recheck() -> Duration {
    std::env::var("LIASCAPE_SCENE_RENDERER_RECHECK_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(15))
}

/// The user-facing reason and the loader's line while the renderer is missing.
pub fn missing() -> Option<(&'static str, String)> {
    state()
        .missing
        .as_ref()
        .map(|m| (super::RENDERER_MISSING, m.detail.clone()))
}

/// `hello.scene_renderer_missing`: `{reason, detail}`, or null.
pub fn missing_json() -> Value {
    match missing() {
        Some((reason, detail)) => json!({"reason": reason, "detail": detail}),
        None => Value::Null,
    }
}

/// A worker of `bin` couldn't be started by the loader (`detail`: its line). `scene` = the event fields naming the
/// scene it was for (id, path, scene_id), if any. Logs `scene.renderer_missing` every time (each one is a scene that
/// didn't play), an outbox fact only when it marks the renderer missing (a rotation with the app closed retries scenes
/// for hours: one fact per failure would push older facts out of the bounded outbox), and starts the probe.
pub fn note_missing(bin: &Path, detail: &str, scene: Value) {
    let (newly, start_probe) = {
        let mut st = state();
        let newly = st
            .missing
            .replace(Missing {
                detail: detail.to_string(),
                bin: bin.to_path_buf(),
            })
            .is_none();
        (newly, !std::mem::replace(&mut st.probing, true))
    };
    let mut ev = scene;
    if !ev.is_object() {
        ev = json!({});
    }
    ev["reason"] = json!(super::RENDERER_MISSING);
    ev["detail"] = json!(detail);
    if newly {
        crate::outbox::with_seq("scene.renderer_missing", &mut ev);
    }
    log::event("worker", Level::Error, "scene.renderer_missing", None, ev);
    if start_probe {
        let spawned = std::thread::Builder::new()
            .name("lia-renderer-probe".into())
            .spawn(probe_loop);
        if spawned.is_err() {
            state().probing = false;
        }
    }
}

/// A worker started (its `Hello`), or the probe's did: the renderer is there. `via` names which.
pub fn note_loads(via: &str) {
    let was = state().missing.take();
    if was.is_some() {
        let mut ev = json!({"via": via});
        crate::outbox::with_seq("scene.renderer_found", &mut ev);
        log::event("worker", Level::Info, "scene.renderer_found", None, ev);
    }
}

/// While the renderer is missing: start the worker binary every [`recheck`] (`--features`: it answers at once, once
/// the loader could start it); the first that does clears the state. A plain spawn (`posix_spawn`, no `pre_exec`), as
/// the serve process must never fork.
fn probe_loop() {
    loop {
        std::thread::sleep(recheck());
        let bin = {
            let mut st = state();
            match &st.missing {
                Some(m) => m.bin.clone(),
                None => {
                    st.probing = false;
                    return;
                }
            }
        };
        let loads = std::process::Command::new(&bin)
            .arg("--features")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.code() != Some(super::LOADER_FAILED) && s.code().is_some());
        if loads {
            note_loads("probe");
            let mut st = state();
            if st.missing.is_none() {
                st.probing = false;
                return;
            }
        }
    }
}
