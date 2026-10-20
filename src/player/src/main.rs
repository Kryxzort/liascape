//! lp-player CLI entry point.
//!
//! Only `--version` is implemented in this task; every other invocation (including no
//! args) is a stub that later tasks fill in (`serve`, `ctl`, …).

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);

    match args.next().as_deref() {
        Some("--version") => {
            println!("lp-player {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("not implemented yet");
            ExitCode::from(2)
        }
    }
}
