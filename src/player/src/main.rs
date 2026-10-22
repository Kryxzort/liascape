//! lp-player CLI entry point.
//!
//! ```text
//! lp-player --version
//! lp-player serve [--clock real|stepped] [--ao <mpv ao>] [--socket <path>]
//!                 [--log-level error|warn|info|debug|trace] [--restore]
//!                 [--no-supervise]                                  (Wayland outputs)
//! lp-player serve --headless [--outputs 1920x1080@60[,…]] [--redraw-policy content|every_tick]
//!                 [same options]
//! lp-player ctl <verb> ['<json args>']
//! lp-player ctl subscribe <prefix…>
//! ```
//!
//! `serve` without `--headless` draws on every `wl_output` of `$WAYLAND_DISPLAY` (Task 13,
//! `.claude/rules/player-core.md` § Wayland). See § Command API for `ctl`.
//!
//! `serve` is **supervised** by default (Task 16, `supervise.rs`, § Supervisor): this
//! process stays a small supervisor and runs the compositor as a child
//! (`serve --supervised …`), restarting it with `--restore` after a crash. `--no-supervise`
//! runs the compositor in this process (tests that don't test supervision). `--restore`
//! restores `<state>/snapshot.json` (§ Snapshot). Exit codes: 0 clean, 1 refused/failed at
//! startup, 2 usage, 3 compositor connection lost (restarted when supervised), 4 the
//! supervisor gave up (5 restarts in 60 s). `--supervised` / `--restarted <spec>` are
//! internal (the supervisor passes them).

use std::process::ExitCode;

use lp_player::log::Level;
use lp_player::runtime::{ClockMode, ServeOpts, Supervised, serve};
use lp_player::supervise::{self, RestartInfo};

const SERVE_USAGE: &str = "usage: lp-player serve [--headless [--outputs WxH@HZ[,…]] \
                           [--redraw-policy content|every_tick]] [--clock real|stepped] \
                           [--ao <mpv ao>] [--socket <path>] \
                           [--log-level error|warn|info|debug|trace] [--restore] \
                           [--no-supervise]";

fn serve_main(args: &[String]) -> ExitCode {
    let mut headless = false;
    let mut outputs_given = false;
    let mut outputs = "1920x1080@60".to_string();
    let mut clock = ClockMode::Real;
    let mut ao = None;
    let mut socket = None;
    let mut level = Level::Info;
    let mut restore = false;
    let mut no_supervise = false;
    let mut supervised = false;
    let mut restarted = None;
    let mut redraw_content = false;
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
            eprintln!("lp-player serve: {e}\n{SERVE_USAGE}");
            return ExitCode::from(2);
        }
    }
    if !headless && outputs_given {
        eprintln!(
            "lp-player serve: --outputs only applies with --headless (Wayland outputs come \
             from the compositor)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    if !headless && redraw_content {
        eprintln!(
            "lp-player serve: --redraw-policy only applies with --headless (Wayland outputs \
             always use the content policy)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    if restarted.is_some() && !supervised {
        eprintln!(
            "lp-player serve: --restarted is internal (the supervisor passes it)\n{SERVE_USAGE}"
        );
        return ExitCode::from(2);
    }
    let outputs = match lp_player::headless::parse_outputs(&outputs) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("lp-player serve: {e}\n{SERVE_USAGE}");
            return ExitCode::from(2);
        }
    };
    if !no_supervise && !supervised {
        // The supervisor: nothing but fork + exec + wait from here on (no thread, no EGL,
        // no PipeWire, no socket — R72).
        let child: Vec<String> = args.iter().filter(|a| *a != "--restore").cloned().collect();
        return supervise::run(child, restore, &lp_player::paths::state_dir());
    }
    if supervised {
        // Exec'd as /proc/self/exe: comm would be "exe".
        unsafe { libc::prctl(libc::PR_SET_NAME, c"lp-player".as_ptr()) };
    }
    let opts = ServeOpts {
        outputs,
        clock,
        ao,
        own_socket_dir: socket.is_none() && lp_player::paths::socket_is_default(),
        socket: socket.unwrap_or_else(lp_player::paths::socket),
        state_dir: lp_player::paths::state_dir(),
        log_level: level,
        wayland: !headless,
        restore,
        supervised: supervised.then(|| Supervised {
            pid: unsafe { libc::getppid() } as u32,
            restart: restarted,
        }),
        redraw_content,
    };
    match serve(opts) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("lp-player serve: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => {
            println!("lp-player {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("serve") => serve_main(&args[1..]),
        Some("ctl") => lp_player::ctl::main(&args[1..]),
        _ => {
            eprintln!(
                "usage: lp-player --version | lp-player serve [--headless …] | lp-player ctl \
                 <verb> ['<json args>']"
            );
            ExitCode::from(2)
        }
    }
}
