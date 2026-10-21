//! Where the player lives on disk (plan Global Constraints): the command socket
//! `$XDG_RUNTIME_DIR/livepaper/lp-player.sock` (dir `0700`, socket `0600`) and the state
//! dir (event log) `$XDG_STATE_HOME/livepaper/lp-player/` (default
//! `~/.local/state/livepaper/lp-player/`). `LP_PLAYER_SOCKET` / `--socket` override the
//! socket path (both `serve` and `ctl`).

use std::path::PathBuf;

/// The command socket path: `$LP_PLAYER_SOCKET`, else `$XDG_RUNTIME_DIR/livepaper/
/// lp-player.sock`, else `/run/user/<uid>/livepaper/lp-player.sock`.
pub fn socket() -> PathBuf {
    if let Some(p) = std::env::var_os("LP_PLAYER_SOCKET").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let run = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
    run.join("livepaper/lp-player.sock")
}

/// The state dir: `$XDG_STATE_HOME/livepaper/lp-player`, else
/// `$HOME/.local/state/livepaper/lp-player`.
pub fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("livepaper/lp-player")
}
