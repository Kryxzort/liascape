//! A test process's own temp root, shared by the lib's unit tests (`lib.rs`, `#[cfg(test)]`) and every integration
//! suite (`tests/common/mod.rs` includes this file by path).
//!
//! Before `main` (one thread: the only sound moment to change the environment) `TMPDIR` is pointed at
//! `<temp>/lpt-<pid>`, so every `std::env::temp_dir()` a test or a process it spawns uses lands inside it; the folder
//! is removed when the process exits, whether its tests passed, failed or panicked, so no test needs its own cleanup
//! to leave nothing behind. `LIASCAPE_KEEP_TMP=1` keeps it (and says where, on stderr).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// The pid that created the root: a forked child that exits without exec must not remove its parent's folder.
static OWNER: AtomicU32 = AtomicU32::new(0);

/// This process's temp root (the value `std::env::temp_dir()` returns once [`setup`] ran).
#[allow(dead_code)]
pub fn root() -> PathBuf {
    std::env::temp_dir()
}

#[used]
#[unsafe(link_section = ".init_array")]
static INIT: extern "C" fn() = init;

#[used]
#[unsafe(link_section = ".fini_array")]
static FINI: extern "C" fn() = fini;

extern "C" fn init() {
    setup();
}

/// Idempotent: other `.init_array` entries that read `temp_dir()` call it first (their order is unspecified).
#[allow(dead_code)]
pub fn setup() {
    if OWNER.load(Ordering::SeqCst) == std::process::id() {
        return;
    }
    let root = std::env::temp_dir().join(format!("lpt-{}", std::process::id()));
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    OWNER.store(std::process::id(), Ordering::SeqCst);
    // SAFETY: `.init_array` runs before `main`, with no other thread to read the environment.
    unsafe { std::env::set_var("TMPDIR", &root) };
}

extern "C" fn fini() {
    if OWNER.load(Ordering::SeqCst) != std::process::id() {
        return;
    }
    let root = std::env::temp_dir();
    if !root.file_name().is_some_and(|n| n.to_string_lossy().starts_with("lpt-")) {
        return;
    }
    if std::env::var_os("LIASCAPE_KEEP_TMP").is_some_and(|v| !v.is_empty()) {
        eprintln!("kept {} (LIASCAPE_KEEP_TMP)", root.display());
        return;
    }
    let _ = std::fs::remove_dir_all(&root);
}
