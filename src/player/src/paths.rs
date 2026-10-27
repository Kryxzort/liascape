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

/// Whether [`socket`] is the default path (no `LP_PLAYER_SOCKET` override) — then its
/// directory (`…/livepaper`) is the player's own and may be `chmod 0700`-ed.
pub fn socket_is_default() -> bool {
    std::env::var_os("LP_PLAYER_SOCKET").is_none_or(|p| p.is_empty())
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

/// Crash records of scene workers (Phase 2 Task 3): `<state>/crashes/`.
pub fn crash_dir() -> PathBuf {
    state_dir().join("crashes")
}

/// The scene worker binary: `$LP_SCENE_WORKER_BIN`, else `lp-scene-worker` next to this
/// executable (`/proc/self/exe` — a dev build's `target/<profile>/`, the flake's `$out/bin`),
/// else the first `lp-scene-worker` on `PATH`. `None` = scenes can't play here.
pub fn scene_worker_bin() -> Option<PathBuf> {
    resolve_scene_worker(
        std::env::var_os("LP_SCENE_WORKER_BIN").map(PathBuf::from),
        std::fs::read_link("/proc/self/exe").ok(),
        std::env::var_os("PATH"),
    )
}

/// [`scene_worker_bin`]'s order on explicit inputs (unit-tested). A non-empty override is
/// used only if it names a file; the sibling and `PATH` candidates must be executable files.
pub fn resolve_scene_worker(
    override_bin: Option<PathBuf>,
    exe: Option<PathBuf>,
    path_var: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    const NAME: &str = "lp-scene-worker";
    let runnable = |p: &std::path::Path| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if let Some(b) = override_bin.filter(|b| !b.as_os_str().is_empty()) {
        return b.is_file().then_some(b);
    }
    if let Some(sib) = exe
        .as_deref()
        .and_then(|e| e.parent())
        .map(|d| d.join(NAME))
        && runnable(&sib)
    {
        return Some(sib);
    }
    std::env::split_paths(&path_var?)
        .map(|d| d.join(NAME))
        .find(|p| runnable(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn exec_file(dir: &std::path::Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn scene_worker_resolution_order() {
        let root = std::env::temp_dir().join(format!("lp-paths-{}", std::process::id()));
        let exe_dir = root.join("bin");
        let path_dir = root.join("path");
        let exe = exec_file(&exe_dir, "lp-player");
        let on_path = exec_file(&path_dir, "lp-scene-worker");
        let path_var = Some(std::env::join_paths([&path_dir]).unwrap());
        // No sibling yet → PATH.
        assert_eq!(
            resolve_scene_worker(None, Some(exe.clone()), path_var.clone()),
            Some(on_path.clone())
        );
        // A sibling beats PATH.
        let sib = exec_file(&exe_dir, "lp-scene-worker");
        assert_eq!(
            resolve_scene_worker(None, Some(exe.clone()), path_var.clone()),
            Some(sib)
        );
        // The override beats both — but only if it exists.
        assert_eq!(
            resolve_scene_worker(Some(on_path.clone()), Some(exe.clone()), path_var.clone()),
            Some(on_path)
        );
        assert_eq!(
            resolve_scene_worker(Some(root.join("missing")), Some(exe), path_var),
            None
        );
        // Nothing anywhere.
        assert_eq!(resolve_scene_worker(None, None, None), None);
        assert!(crash_dir().ends_with("livepaper/lp-player/crashes"));
    }
}
