//! lp-player CLI entry point.
//!
//! ```text
//! lp-player --version
//! lp-player serve [--clock real|stepped] [--ao <mpv ao>] [--socket <path>]
//!                 [--log-level error|warn|info|debug|trace]          (Wayland outputs)
//! lp-player serve --headless [--outputs 1920x1080@60[,…]] [same options]
//! lp-player ctl <verb> ['<json args>']
//! lp-player ctl subscribe <prefix…>
//! ```
//!
//! `serve` without `--headless` draws on every `wl_output` of `$WAYLAND_DISPLAY` (Task 13,
//! `.claude/rules/player-core.md` § Wayland). See § Command API for `ctl`.

use std::process::ExitCode;

use lp_player::log::Level;
use lp_player::runtime::{ClockMode, ServeOpts, serve};

const SERVE_USAGE: &str = "usage: lp-player serve [--headless [--outputs WxH@HZ[,…]]] \
                           [--clock real|stepped] [--ao <mpv ao>] [--socket <path>] \
                           [--log-level error|warn|info|debug|trace]";

fn serve_main(args: &[String]) -> ExitCode {
    let mut headless = false;
    let mut outputs_given = false;
    let mut outputs = "1920x1080@60".to_string();
    let mut clock = ClockMode::Real;
    let mut ao = None;
    let mut socket = None;
    let mut level = Level::Info;
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
    let outputs = match lp_player::headless::parse_outputs(&outputs) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("lp-player serve: {e}\n{SERVE_USAGE}");
            return ExitCode::from(2);
        }
    };
    let opts = ServeOpts {
        outputs,
        clock,
        ao,
        own_socket_dir: socket.is_none() && lp_player::paths::socket_is_default(),
        socket: socket.unwrap_or_else(lp_player::paths::socket),
        state_dir: lp_player::paths::state_dir(),
        log_level: level,
        wayland: !headless,
    };
    match serve(opts) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("lp-player serve: {e}");
            ExitCode::from(1)
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
