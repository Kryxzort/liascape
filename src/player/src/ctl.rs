//! `lp-player ctl` — every verb from a shell (spec §9 "CLI"). Prints the reply's result as
//! pretty JSON and exits 0, or the error object (`{code, message, hint}`) and exits 1 —
//! errors keep their hint, so the output always says what to do next.
//!
//! ```text
//! lp-player ctl [--timeout-ms N] <verb> ['<json args>']   e.g. lp-player ctl set '{"path":"srcs:*.gain.user","value":-6}'
//! lp-player ctl subscribe <prefix…>                       events, one JSON object per line, until Ctrl-C
//! ```
//!
//! A reply is waited for at most `--timeout-ms` (default [`DEFAULT_TIMEOUT_MS`]) → a
//! `timeout` error; `subscribe` streams without a timeout and exits 0 (with a note on
//! stderr) when the player goes away.
//!
//! The socket is `paths::socket()` (`$LP_PLAYER_SOCKET` or
//! `$XDG_RUNTIME_DIR/livepaper/lp-player.sock`).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use serde_json::{Value, json};

fn fail(code: &str, message: String, hint: &str) -> ExitCode {
    let e = json!({"code": code, "message": message, "hint": hint});
    println!("{}", serde_json::to_string_pretty(&e).unwrap_or_default());
    ExitCode::from(1)
}

const USAGE: &str = "usage: lp-player ctl [--timeout-ms N] <verb> ['<json args>'] | \
                     lp-player ctl subscribe <prefix…>; `lp-player ctl hello` lists the verbs";

/// How long `ctl` waits for a reply by default.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Entry point; `args` are the words after `ctl`.
pub fn main(args: &[String]) -> ExitCode {
    let mut args = args;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    while let Some(a) = args.first() {
        if a == "--timeout-ms" {
            match args.get(1).and_then(|v| v.parse::<u64>().ok()) {
                Some(ms) if ms > 0 => timeout_ms = ms,
                _ => {
                    return fail(
                        "bad_request",
                        "--timeout-ms needs a positive number of milliseconds".into(),
                        USAGE,
                    );
                }
            }
            args = &args[2..];
        } else {
            break;
        }
    }
    let Some(verb) = args.first() else {
        return fail("bad_request", "no verb given".into(), USAGE);
    };
    let path = crate::paths::socket();
    let stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            return fail(
                "io",
                format!("can't connect to {}: {e}", path.display()),
                "is the player running? start it with `lp-player serve` (or check \
                 $XDG_RUNTIME_DIR / $LP_PLAYER_SOCKET)",
            );
        }
    };
    let (cmd, cmd_args, streaming) = if verb == "subscribe" {
        let topics: Vec<&String> = args[1..].iter().collect();
        if topics.is_empty() {
            return fail(
                "bad_request",
                "subscribe needs at least one kind prefix".into(),
                "e.g. `lp-player ctl subscribe transition. source.` (\"\" = everything)",
            );
        }
        ("subscribe", json!({ "topics": topics }), true)
    } else {
        let a = match args.get(1) {
            None => json!({}),
            Some(s) => match serde_json::from_str::<Value>(s) {
                Ok(v @ Value::Object(_)) => v,
                Ok(other) => {
                    return fail(
                        "bad_request",
                        format!("args must be a JSON object, got {other}"),
                        "pass one JSON object, e.g. lp-player ctl get '{\"path\":\"src1.speed\"}'",
                    );
                }
                Err(e) => {
                    return fail(
                        "bad_request",
                        format!("args are not JSON: {e}"),
                        "pass one JSON object (quote it for the shell), e.g. lp-player ctl \
                         set '{\"path\":\"src1.speed\",\"value\":1.5}'",
                    );
                }
            },
        };
        (verb.as_str(), a, false)
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(timeout_ms)));
    let req = json!({"id": 1, "cmd": cmd, "args": cmd_args});
    if let Err(e) = writeln!(&stream, "{req}") {
        return fail(
            "io",
            format!("write: {e}"),
            "the player closed the connection",
        );
    }
    let mut rd = BufReader::new(&stream);
    let mut line = String::new();
    let mut replied = false;
    loop {
        line.clear();
        match rd.read_line(&mut line) {
            Ok(0) if replied => {
                eprintln!("lp-player ctl: the player closed the connection (it exited)");
                return ExitCode::SUCCESS;
            }
            Ok(0) => {
                return fail(
                    "io",
                    "the player closed the connection before replying".into(),
                    "`lp-player ctl logs '{\"kind_prefix\":\"api.\"}'` (if it's still up)",
                );
            }
            Ok(_) => {}
            Err(e)
                if !replied
                    && matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                return fail(
                    "timeout",
                    format!("no reply to {cmd} within {timeout_ms} ms"),
                    "pass `--timeout-ms <ms>` to wait longer (a stepped `step` waits for every \
                     video frame); `lp-player ctl probe '{\"name\":\"loop\"}'` shows whether \
                     the loop is busy",
                );
            }
            Err(e) if replied => {
                eprintln!("lp-player ctl: the connection to the player failed: {e}");
                return ExitCode::SUCCESS;
            }
            Err(e) => return fail("io", format!("read: {e}"), "the player went away"),
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("event").is_some() {
            if streaming {
                let mut out = std::io::stdout().lock();
                if writeln!(out, "{}", line.trim_end())
                    .and_then(|()| out.flush())
                    .is_err()
                {
                    return ExitCode::SUCCESS; // the reader went away (a closed pipe)
                }
            }
            continue;
        }
        if v["id"] != json!(1) {
            continue;
        }
        if v["ok"] != json!(true) {
            println!(
                "{}",
                serde_json::to_string_pretty(&v["error"]).unwrap_or_default()
            );
            return ExitCode::from(1);
        }
        if !streaming {
            println!(
                "{}",
                serde_json::to_string_pretty(&v["result"]).unwrap_or_default()
            );
            return ExitCode::SUCCESS;
        }
        // Subscribed: stream until interrupted, without a timeout.
        replied = true;
        let _ = stream.set_read_timeout(None);
        // subscribed: keep streaming events until interrupted / the player exits
    }
}
