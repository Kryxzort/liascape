//! NVIDIA's GL shader disk cache directory ([`ensure`]), and where the scene worker's LWE core
//! keeps its shader text work ([`lwe_dir`]).
//!
//! The NVIDIA driver keeps compiled shaders in `__GL_SHADER_DISK_CACHE_PATH` when it is set,
//! but only if that directory already exists: it never creates it, and when it's missing every
//! shader is compiled again at every launch. A common XDG clean-up tip sets the variable to
//! `$XDG_CACHE_HOME/nv` without creating the folder; a big scene then builds in ~2.2 s instead
//! of ~1.1–1.3 s warm (measured: 3042492564 under `--lwe-smoke`, deferred texture decode in).
//! So the compositor (`runtime::serve`) and the scene worker's GL modes (`run_renderer`,
//! `--lwe-smoke`, `--shader-sweep`) create it, owner-only, before they make a GL context.
//!
//! What is left alone:
//! - the variable unset or empty: the driver uses its own default location (it creates that one);
//! - `__GL_SHADER_DISK_CACHE=0`: the cache is off on purpose;
//! - a relative path (an unexpanded `~/…`, say): it would be created under whatever directory
//!   the player was started in;
//! - the variable's value itself, which is never changed.
//!
//! Other vendors need nothing: Mesa (`MESA_SHADER_CACHE_DIR`, `MESA_SHADER_CACHE_DISABLE`)
//! creates its cache directory and any missing parents itself.
//!
//! A failure (read-only filesystem, a path through a file) is never fatal: the driver just
//! runs without a disk cache, as it would have anyway. The caller logs it once at debug level.
//!
//! Guards: the unit tests below; `tests/api.rs` `serve_creates_the_shader_cache_dir`,
//! `tests/worker.rs` `renderer_creates_the_shader_cache_dir`.

use std::ffi::OsStr;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::log::{self, Level};

/// The directory NVIDIA's driver keeps its GL shader cache in when set.
pub const PATH_ENV: &str = "__GL_SHADER_DISK_CACHE_PATH";
/// NVIDIA's cache switch: `0` turns the disk cache off.
pub const ENABLE_ENV: &str = "__GL_SHADER_DISK_CACHE";

/// Overrides [`lwe_dir`]; empty = no cache. Tests point it into their temp dirs (`tests/common`).
pub const LWE_DIR_ENV: &str = "LIASCAPE_SCENE_SHADER_CACHE_DIR";

/// Where the scene worker's LWE core keeps its shader text work (WE's text passes, glslang +
/// SPIRV-Cross), so a scene's next load skips it (`wp_config_set_shader_cache_dir`,
/// `docs/player/modules/scene-lwe-core.md` § Shader cache): `env` ([`LWE_DIR_ENV`]'s value) when
/// set, else `$XDG_CACHE_HOME/liascape/lwe-shaders`, else `$HOME/.cache/liascape/lwe-shaders`.
pub fn lwe_dir(
    env: Option<&OsStr>,
    xdg_cache: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Option<PathBuf> {
    if let Some(d) = env {
        return (!d.is_empty()).then(|| PathBuf::from(d));
    }
    xdg_cache
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|h| !h.is_empty())
                .map(|h| Path::new(h).join(".cache"))
        })
        .map(|d| d.join("liascape/lwe-shaders"))
}

/// [`lwe_dir`] with this process's environment, created owner-only if missing (a planted entry
/// would be GLSL the driver compiles); `None` = no cache.
pub fn lwe_dir_from_env() -> Option<PathBuf> {
    let dir = lwe_dir(
        std::env::var_os(LWE_DIR_ENV).as_deref(),
        std::env::var_os("XDG_CACHE_HOME").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .ok()?;
    Some(dir)
}

/// What [`ensure`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheDir {
    /// [`PATH_ENV`] unset or empty: the driver's default location, nothing to do.
    Unset,
    /// [`ENABLE_ENV`] is `0`: the cache is off on purpose.
    Disabled,
    /// [`PATH_ENV`] is relative: left alone.
    Relative(PathBuf),
    /// It already exists (as a directory).
    Exists(PathBuf),
    /// It was missing and is now there, mode 0700.
    Created(PathBuf),
    /// It couldn't be created (or the path is not a directory); the driver runs uncached.
    Failed { path: PathBuf, error: String },
}

/// [`ensure`] with this process's environment. Call it before the first EGL/GL call.
pub fn ensure_from_env() -> CacheDir {
    ensure(
        std::env::var_os(PATH_ENV).as_deref(),
        std::env::var_os(ENABLE_ENV).as_deref(),
    )
}

/// Create the shader cache directory `path` names (the value of [`PATH_ENV`]) if it is missing,
/// mode 0700 (missing parents too). `enable` is [`ENABLE_ENV`]'s value: only an explicit `0`
/// stops it — creating an empty directory costs nothing, a missing one costs every shader.
pub fn ensure(path: Option<&OsStr>, enable: Option<&OsStr>) -> CacheDir {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return CacheDir::Unset;
    };
    if enable.is_some_and(|v| v.to_str().is_some_and(|v| v.trim().parse() == Ok(0u32))) {
        return CacheDir::Disabled;
    }
    let path = Path::new(path).to_path_buf();
    if !path.is_absolute() {
        return CacheDir::Relative(path);
    }
    match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => return CacheDir::Exists(path),
        Ok(_) => {
            return CacheDir::Failed {
                path,
                error: "not a directory".into(),
            };
        }
        // Not found (or not even stat-able): try; the create reports the real error.
        Err(_) => {}
    }
    match std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)
    {
        Ok(()) => {
            // The umask may have taken bits off the mode above; the cache holds this user's
            // compiled shaders, so it is exactly owner-only.
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
            CacheDir::Created(path)
        }
        Err(e) => CacheDir::Failed {
            path,
            error: e.to_string(),
        },
    }
}

impl CacheDir {
    /// One line for a log, for the outcomes worth one (`Created`, `Failed`); else `None`.
    pub fn note(&self) -> Option<String> {
        match self {
            CacheDir::Created(p) => Some(format!("created the shader cache dir {}", p.display())),
            CacheDir::Failed { path, error } => Some(format!(
                "can't create the shader cache dir {} ({error}); the driver compiles every shader",
                path.display()
            )),
            _ => None,
        }
    }
}

/// `gfx.shader_cache_dir` (debug) once the event log is open, for `Created` / `Failed` only.
pub fn log_outcome(outcome: &CacheDir) {
    let fields = match outcome {
        CacheDir::Created(p) => json!({ "env": PATH_ENV, "path": p, "created": true }),
        CacheDir::Failed { path, error } => {
            json!({ "env": PATH_ENV, "path": path, "created": false, "error": error })
        }
        _ => return,
    };
    log::event("gfx", Level::Debug, "gfx.shader_cache_dir", None, fields);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    fn tmp(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "liascape-shader-cache-{}-{name}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().mode() & 0o7777
    }

    #[test]
    fn missing_dir_is_created_owner_only_with_its_parents() {
        let root = tmp("create");
        let dir = root.join("cache/nv");
        let got = ensure(Some(dir.as_os_str()), None);
        assert_eq!(got, CacheDir::Created(dir.clone()));
        assert!(dir.is_dir(), "{dir:?} was not created");
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&root.join("cache")), 0o700);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().uid(),
            unsafe { libc::geteuid() }
        );
        // Again: already there, left as it is.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert_eq!(
            ensure(Some(dir.as_os_str()), Some(OsStr::new("1"))),
            CacheDir::Exists(dir.clone())
        );
        assert_eq!(mode(&dir), 0o750, "an existing dir's mode is the user's");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lwe_dir_follows_the_override_then_xdg_then_home() {
        let s = |v: &'static str| Some(OsStr::new(v));
        assert_eq!(
            lwe_dir(s("/t/lwe"), s("/x"), s("/h")),
            Some(PathBuf::from("/t/lwe"))
        );
        assert_eq!(lwe_dir(s(""), s("/x"), s("/h")), None, "empty = no cache");
        assert_eq!(
            lwe_dir(None, s("/x"), s("/h")),
            Some(PathBuf::from("/x/liascape/lwe-shaders"))
        );
        assert_eq!(
            lwe_dir(None, s(""), s("/h")),
            Some(PathBuf::from("/h/.cache/liascape/lwe-shaders"))
        );
        assert_eq!(lwe_dir(None, None, None), None);
    }

    #[test]
    fn nothing_is_created_when_unset_or_disabled() {
        assert_eq!(ensure(None, None), CacheDir::Unset);
        assert_eq!(ensure(Some(OsStr::new("")), None), CacheDir::Unset);
        let root = tmp("disabled");
        let dir = root.join("nv");
        for off in ["0", " 0 ", "00"] {
            assert_eq!(
                ensure(Some(dir.as_os_str()), Some(OsStr::new(off))),
                CacheDir::Disabled
            );
        }
        assert!(!dir.exists(), "__GL_SHADER_DISK_CACHE=0 must create nothing");
        // A relative path would land in the current directory: left alone.
        assert_eq!(
            ensure(Some(OsStr::new("~/.cache/nv")), None),
            CacheDir::Relative(PathBuf::from("~/.cache/nv"))
        );
        assert!(!Path::new("~").exists());
        // Any other switch value keeps the cache on.
        assert_eq!(
            ensure(Some(dir.as_os_str()), Some(OsStr::new("1"))),
            CacheDir::Created(dir.clone())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_uncreatable_path_fails_softly() {
        let root = tmp("fail");
        // Through a regular file: ENOTDIR for any user, root included.
        let file = root.join("file");
        std::fs::write(&file, b"").unwrap();
        let under_file = file.join("nv");
        assert!(matches!(
            ensure(Some(under_file.as_os_str()), None),
            CacheDir::Failed { .. }
        ));
        // The path itself is a file.
        assert!(matches!(
            ensure(Some(file.as_os_str()), None),
            CacheDir::Failed { .. }
        ));
        // A read-only parent (root ignores the mode bits, so only checked for a user).
        let ro = root.join("ro");
        std::fs::create_dir(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
        let got = ensure(Some(ro.join("nv").as_os_str()), None);
        if unsafe { libc::geteuid() } != 0 {
            match &got {
                CacheDir::Failed { error, .. } => assert!(!error.is_empty()),
                other => panic!("expected Failed, got {other:?}"),
            }
            assert!(got.note().unwrap().contains("can't create"));
        }
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Logging a failure before (or without) the event log is a no-op, never a panic.
        log_outcome(&got);
        let _ = std::fs::remove_dir_all(&root);
    }
}
