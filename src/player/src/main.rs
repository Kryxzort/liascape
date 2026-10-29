//! liascape-player CLI entry point.
//!
//! ```text
//! liascape-player --version
//! liascape-player serve [--clock real|stepped] [--ao <mpv ao>] [--socket <path>]
//!                 [--log-level error|warn|info|debug|trace] [--restore [--session-start]] [--debug]
//!                 [--no-supervise] [--render-worker on|off]          (Wayland outputs)
//! liascape-player serve --headless [--outputs 1920x1080@60[,…]] [--redraw-policy content|every_tick]
//!                 [same options]
//! liascape-player ctl <verb> ['<json args>']
//! liascape-player ctl subscribe <prefix…>
//! ```
//!
//! `serve` without `--headless` draws on every `wl_output` of `$WAYLAND_DISPLAY` (Task 13,
//! `.claude/rules/player-core.md` § Wayland). See § Command API for `ctl`.
//!
//! `serve` is **supervised** by default (Task 16, `supervise.rs`, § Supervisor): this
//! process stays a small supervisor and runs the compositor as a child
//! (`serve --supervised …`), restarting it with `--restore` after a crash. `--no-supervise`
//! runs the compositor in this process (tests that don't test supervision). `--restore`
//! restores `<state>/snapshot.json` (§ Snapshot); `--session-start` with it marks a session
//! start (boot / `liascape restore`): each restored program starts per its `start_mode`
//! (§ Programs "Playlist start") — the supervisor gives it to its first child only, never
//! to a restart. Exit codes: 0 clean, 1 refused at
//! startup (never retried — e.g. already running), 2 usage, 3 compositor connection lost
//! mid-run (restarted when supervised), 4 the supervisor gave up (5 real crashes in 60 s,
//! or the compositor/EGL never became available), 5 compositor/EGL not available *yet*
//! (retried with backoff when supervised, § Supervisor "Startup-failure classes").
//! `--supervised` / `--restarted <spec>` are internal (the supervisor passes them).

use std::process::ExitCode;

use liascape_player::log::Level;
use liascape_player::runtime::{ClockMode, ServeOpts, Supervised, serve};
use liascape_player::supervise::{self, RestartInfo};

const SERVE_USAGE: &str = "usage: liascape-player serve [--headless [--outputs WxH@HZ[,…]] \
                           [--redraw-policy content|every_tick]] [--clock real|stepped] \
                           [--ao <mpv ao>] [--socket <path>] \
                           [--log-level error|warn|info|debug|trace] [--restore [--session-start]] \
                           [--no-supervise] [--debug] [--render-worker on|off]";

fn serve_main(args: &[String]) -> ExitCode {
    let mut headless = false;
    let mut outputs_given = false;
    let mut outputs = "1920x1080@60".to_string();
    let mut clock = ClockMode::Real;
    let mut ao = None;
    let mut socket = None;
    let mut level = Level::Info;
    let mut restore = false;
    let mut session_start = false;
    let mut no_supervise = false;
    let mut supervised = false;
    let mut restarted = None;
    let mut redraw_content = false;
    let mut debug = false;
    let mut render_worker: Option<bool> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        let r: Result<(), String> = (|| {
            match a.as_str() {
                "--headless" => headless = true,
                "--outputs" => {
                    outputs = val("--outputs")?;
                    outputs_given = true;
                }
                "--clock" => {
                    clock = match val("--clock")?.as_str() {
                        "real" => ClockMode::Real,
                        "stepped" => ClockMode::Stepped,
                        other => return Err(format!("--clock {other:?}: expected real|stepped")),
                    }
                }
                "--ao" => ao = Some(val("--ao")?),
                "--restore" => restore = true,
                "--session-start" => session_start = true,
                "--no-supervise" => no_supervise = true,
                "--supervised" => supervised = true,
                "--restarted" => restarted = Some(RestartInfo::parse(&val("--restarted")?)?),
                "--redraw-policy" => {
                    redraw_content = match val("--redraw-policy")?.as_str() {
                        "content" => true,
                        "every_tick" => false,
                        other => {
                            return Err(format!(
                                "--redraw-policy {other:?}: expected content|every_tick"
                            ));
                        }
                    }
                }
                "--debug" => debug = true,
                "--render-worker" => {
                    let v = val("--render-worker")?;
                    render_worker = Some(
                        liascape_player::runtime::parse_on_off(&v)
                            .ok_or_else(|| format!("--render-worker {v:?}: expected on|off"))?,
                    );
                }
                "--socket" => socket = Some(std::path::PathBuf::from(val("--socket")?)),
                "--log-level" => {
                    let l = val("--log-level")?;
                    level = serde_json::from_value(serde_json::json!(l)).map_err(|_| {
                        format!("--log-level {l:?}: expected error|warn|info|debug|trace")
                    })?;
                }
                other => return Err(format!("unknown option {other:?}")),
            }
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("liascape-player serve: {e}\n{SERVE_USAGE}");
            return ExitCode::from(2);
        }
    }
    if !headless && outputs_given {
        eprintln!(
            "liascape-player serve: --outputs only applies with --headless (Wayland outputs come \
             from the compositor)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    if !headless && redraw_content {
        eprintln!(
            "liascape-player serve: --redraw-policy only applies with --headless (Wayland outputs \
             always use the content policy)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    if restarted.is_some() && !supervised {
        eprintln!(
            "liascape-player serve: --restarted is internal (the supervisor passes it)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    let outputs = match liascape_player::headless::parse_outputs(&outputs) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("liascape-player serve: {e}\n{SERVE_USAGE}");
            return ExitCode::from(2);
        }
    };
    if !no_supervise && !supervised {
        // The supervisor: nothing but fork + exec + wait from here on (no thread, no EGL,
        // no PipeWire, no socket — R72).
        let child: Vec<String> = args
            .iter()
            .filter(|a| *a != "--restore" && *a != "--session-start")
            .cloned()
            .collect();
        return supervise::run(
            child,
            restore,
            session_start,
            &liascape_player::paths::state_dir(),
        );
    }
    if supervised {
        // Exec'd as /proc/self/exe: comm would be "exe".
        unsafe { libc::prctl(libc::PR_SET_NAME, c"liascape-player".as_ptr()) };
    }
    let opts = ServeOpts {
        outputs,
        clock,
        ao,
        own_socket_dir: socket.is_none() && liascape_player::paths::socket_is_default(),
        socket: socket.unwrap_or_else(liascape_player::paths::socket),
        state_dir: liascape_player::paths::state_dir(),
        log_level: level,
        wayland: !headless,
        restore,
        session_start,
        supervised: supervised.then(|| Supervised {
            pid: unsafe { libc::getppid() } as u32,
            restart: restarted,
        }),
        redraw_content,
        debug,
        render_worker: liascape_player::runtime::render_worker_enabled(render_worker),
    };
    match serve(opts) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("liascape-player serve: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => {
            println!("liascape-player {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("serve") => serve_main(&args[1..]),
        Some("ctl") => liascape_player::ctl::main(&args[1..]),
        Some("scene-check") => scene_check(&args[1..]),
        Some("scene-loudness") => scene_loudness(&args[1..]),
        Some("health") => {
            // `hello.health` for when no player runs (no render worker here: no hwdec interop);
            // the backend's capability report (/health/features) reads it, exit 0
            let out = serde_json::json!({
                "effects": liascape_player::health::effects_here(),
                "vram": liascape_player::health::vram_here(),
            });
            println!("{out}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "usage: liascape-player --version | liascape-player serve [--headless …] | liascape-player ctl \
                 <verb> ['<json args>'] | liascape-player scene-check [--assets <dir>] | liascape-player \
                 scene-loudness <scene dir> [--assets <dir>] [--props '<json>'] [--model lwe|we] \
                 [--seed-seconds S] [--horizon S] [--cache <dir>|--no-cache] | liascape-player health"
            );
            ExitCode::from(2)
        }
    }
}

/// `liascape-player scene-loudness <scene dir> [--assets <dir>] [--props '<json>'] [--model lwe|we]
/// [--seed-seconds S] [--horizon S] [--cache <dir>|--no-cache]` — the OFFLINE loudness estimate of
/// a WE scene (`scene::loudness_estimate`; player-core.md § Scene worker → "Scene loudness" →
/// "Offline estimate"): one JSON object `{path, estimated: true, model, fingerprint, lufs,
/// lufs_if_coherent, peak_dbfs, audible_s, horizon_s, state, seed {weight_s, state}, confidence
/// {level, notes}, sounds, files, cache, ms}` — `state`/`seed.state` are the live learner's
/// `state_json` shape (a `loudness_seed`).
/// `--props` = the item's `scene_props` (name → value) over project.json's defaults; `--model`
/// `lwe` (default: what liascape-player plays — LWE with fork patch 0018, WE's rules) or `we`
/// (the same plan; another fingerprint prefix). `--assets` = WE's
/// assets dir for sounds the scene takes from it (else resolved like `scene-check`). Per-file
/// stats are cached (`$XDG_CACHE_HOME/liascape/scene-loudness`), so a re-estimate is a re-mix.
/// `--horizon S` simulates exactly the first S s of play (validation against a recording).
/// Exit 0, 1 = not a scene / unreadable (the error as `{path, error}`), 2 = usage.
fn scene_loudness(args: &[String]) -> ExitCode {
    use liascape_player::scene::loudness_estimate as le;
    let usage = || {
        eprintln!(
            "usage: liascape-player scene-loudness <scene dir> [--assets <dir>] [--props '<json>'] \
             [--model lwe|we] [--seed-seconds S] [--horizon S] [--cache <dir>|--no-cache]"
        );
        ExitCode::from(2)
    };
    let (mut dir, mut assets, mut opts) = (None, None, le::Opts::default());
    let mut cache_dir = le::Cache::default_dir();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--assets" => assets = it.next().map(std::path::PathBuf::from),
            "--props" => match it
                .next()
                .map(|v| serde_json::from_str::<serde_json::Value>(v))
            {
                Some(Ok(serde_json::Value::Object(m))) => opts.props = Some(m),
                _ => {
                    eprintln!("liascape-player scene-loudness: --props needs a JSON object");
                    return ExitCode::from(2);
                }
            },
            "--model" => match it.next().and_then(|m| le::Model::parse(m)) {
                Some(m) => opts.model = m,
                None => return usage(),
            },
            "--seed-seconds" => match it.next().and_then(|v| v.parse::<f64>().ok()) {
                Some(s) if s > 0.0 => opts.seed_s = s,
                _ => return usage(),
            },
            "--horizon" => match it.next().and_then(|v| v.parse::<f64>().ok()) {
                Some(s) if s > 0.0 => opts.horizon_s = Some(s),
                _ => return usage(),
            },
            "--cache" => cache_dir = it.next().map(std::path::PathBuf::from),
            "--no-cache" => cache_dir = None,
            other if !other.starts_with("--") && dir.is_none() => {
                dir = Some(std::path::PathBuf::from(other))
            }
            _ => return usage(),
        }
    }
    let Some(dir) = dir else { return usage() };
    let assets = assets.or_else(|| {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        liascape_player::scene::assets::resolve(None, &home).ok()
    });
    match le::SceneDir::open(&dir, assets.as_deref()) {
        Ok(scene) => {
            let mut cache = le::Cache::new(cache_dir);
            println!("{}", le::estimate_scene(&scene, &opts, &mut cache));
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("{}", serde_json::json!({"path": dir, "error": e}));
            ExitCode::from(1)
        }
    }
}

/// `liascape-player scene-check [--assets <dir>]` (Phase 2 Task 7): can scenes play here? One JSON
/// line `{worker, features, assets_dir, ok, reason}`, exit 0 = yes / 1 = no (the backend's
/// adapter reads it when no player runs). The same rule as `hello`'s `scene` capability: the
/// worker resolves and was built with LWE, and WE's assets dir resolves (`--assets`, else
/// `LIASCAPE_WE_ASSETS_DIR`, else every Steam library) — with `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`
/// the assets are optional (hermetic tests).
fn scene_check(args: &[String]) -> ExitCode {
    let mut explicit = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--assets" => explicit = it.next().map(std::path::PathBuf::from),
            other => {
                eprintln!("liascape-player scene-check: unknown option {other:?}");
                return ExitCode::from(2);
            }
        }
    }
    let worker = liascape_player::paths::scene_worker_bin();
    let features: Vec<String> = worker
        .as_ref()
        .and_then(|w| {
            std::process::Command::new(w)
                .arg("--features")
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()
        })
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or_default();
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let assets = liascape_player::scene::assets::resolve(explicit.as_deref(), &home);
    let synthetic = std::env::var("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES").as_deref() == Ok("1");
    let reason = if worker.is_none() {
        Some("liascape-scene-worker not found (LIASCAPE_SCENE_WORKER_BIN, next to liascape-player, PATH)".into())
    } else if synthetic {
        None
    } else if !features.iter().any(|f| f == "lwe") {
        Some("liascape-scene-worker was built without LWE (install.sh --no-scenes)".to_string())
    } else {
        assets.as_ref().err().cloned()
    };
    let out = serde_json::json!({
        "worker": worker,
        "features": features,
        "assets_dir": assets.as_ref().ok(),
        "ok": reason.is_none(),
        "reason": reason,
    });
    println!("{out}");
    if reason.is_none() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
