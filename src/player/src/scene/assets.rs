//! Where WE's `assets/` (shaders, materials, fonts every real scene needs — spike `lwe-core.md`
//! §2) lives, resolved explicitly (Phase 2 Task 7; `.claude/rules/player-core.md` § Scene worker
//! → "Real scenes"). LWE's own auto-detection only looks for WE in Steam's *primary* library;
//! on this machine (and any with a second library) WE sits in another one, so the player
//! resolves the dir itself and passes it to every worker.
//!
//! Order ([`resolve_with`]): an explicit dir (`player.scene_assets`) → `LIASCAPE_WE_ASSETS_DIR` →
//! every Steam root ([`steam_roots`]) and each library its `libraryfolders.vdf` lists →
//! `<library>/steamapps/common/wallpaper_engine/assets`. A candidate counts only when it holds
//! [`PROBE_FILE`] (an empty or half-installed dir would build no renderer — a 1×1 scene).
//! Pure except for the file-system probes; no GPU.

use std::path::{Component, Path, PathBuf};

/// The environment variable naming WE's `assets/` dir.
pub const ASSETS_ENV: &str = "LIASCAPE_WE_ASSETS_DIR";
/// A file every scene's renderer needs (`genericimage2`, also pulled in by `general.bloom`).
pub const PROBE_FILE: &str = "shaders/genericimage2.vert";
/// Wallpaper Engine's Steam app id.
pub const WE_APP_ID: &str = "431960";
/// What the error hint tells the user to set.
pub const HINT: &str = "set LIASCAPE_WE_ASSETS_DIR (or the player prop player.scene_assets) to \
                        <steam library>/steamapps/common/wallpaper_engine/assets";

/// Steam roots under `home`, in the order they're tried (native, the `~/.steam` aliases,
/// Flatpak).
pub fn steam_roots(home: &Path) -> Vec<PathBuf> {
    [
        ".local/share/Steam",
        ".steam/steam",
        ".steam/root",
        ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        ".var/app/com.valvesoftware.Steam/data/Steam",
    ]
    .iter()
    .map(|r| home.join(r))
    .collect()
}

/// Every `"path"` value in a Steam `libraryfolders.vdf` (KeyValues text), in file order.
/// Tolerant: unknown keys, nesting and comments are skipped; `\\` and `\"` are unescaped.
pub fn parse_libraryfolders(text: &str) -> Vec<PathBuf> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = chars.next() {
                                s.push(n);
                            }
                        }
                        '"' => break,
                        _ => s.push(c),
                    }
                }
                tokens.push(Some(s));
            }
            '{' | '}' => tokens.push(None),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    tokens
        .windows(2)
        .filter_map(|w| match (&w[0], &w[1]) {
            (Some(k), Some(v)) if k.eq_ignore_ascii_case("path") && !v.is_empty() => {
                Some(PathBuf::from(v))
            }
            _ => None,
        })
        .collect()
}

/// The libraries of Steam root `root`: itself, then every `"path"` of its
/// `steamapps/libraryfolders.vdf` (or the older `config/libraryfolders.vdf`).
pub fn libraries_of(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    for vdf in ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"] {
        if let Ok(text) = std::fs::read_to_string(root.join(vdf)) {
            out.extend(parse_libraryfolders(&text));
        }
    }
    out
}

/// `<library>/steamapps/common/wallpaper_engine/assets`.
pub fn assets_in(library: &Path) -> PathBuf {
    library.join("steamapps/common/wallpaper_engine/assets")
}

/// `dir` is a usable WE assets dir ([`PROBE_FILE`] in it).
pub fn is_assets_dir(dir: &Path) -> bool {
    dir.join(PROBE_FILE).is_file()
}

/// [`resolve_with`] reading `LIASCAPE_WE_ASSETS_DIR` from the environment (empty = unset).
pub fn resolve(explicit: Option<&Path>, home: &Path) -> Result<PathBuf, String> {
    let env = std::env::var_os(ASSETS_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    resolve_with(explicit, env.as_deref(), home)
}

/// The first usable assets dir of: `explicit` (empty = none), `env`, then each Steam root's
/// libraries ([`steam_roots`], [`libraries_of`]). `Err` names every candidate tried and
/// [`HINT`].
pub fn resolve_with(
    explicit: Option<&Path>,
    env: Option<&Path>,
    home: &Path,
) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut consider = |c: PathBuf, tried: &mut Vec<PathBuf>| -> Option<PathBuf> {
        let key = c.canonicalize().unwrap_or_else(|_| c.clone());
        if !seen.insert(key) {
            return None;
        }
        if is_assets_dir(&c) {
            return Some(c);
        }
        tried.push(c);
        None
    };
    for c in [explicit, env]
        .into_iter()
        .flatten()
        .filter(|p| !p.as_os_str().is_empty())
    {
        if let Some(found) = consider(c.to_path_buf(), &mut tried) {
            return Ok(found);
        }
    }
    for root in steam_roots(home) {
        if !root.is_dir() {
            continue;
        }
        for lib in libraries_of(&root) {
            if let Some(found) = consider(assets_in(&lib), &mut tried) {
                return Ok(found);
            }
        }
    }
    let list = if tried.is_empty() {
        format!("no Steam install under {}", home.display())
    } else {
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Err(format!(
        "Wallpaper Engine's assets dir was not found (tried: {list}); {HINT}"
    ))
}

/// The Steam root (library) a Workshop item folder lives in: `dir` resolved (a `local/<id>`
/// symlink followed), then the prefix before `steamapps/workshop/content/431960/<id>`.
/// `None` for a folder outside any Steam library (an imported or synthetic scene).
pub fn steam_root_of_item(dir: &Path) -> Option<PathBuf> {
    let real = dir.canonicalize().ok()?;
    let comps: Vec<Component> = real.components().collect();
    let want = ["steamapps", "workshop", "content", WE_APP_ID];
    (0..comps.len().saturating_sub(want.len())).find_map(|i| {
        let hit = want
            .iter()
            .enumerate()
            .all(|(j, w)| comps[i + j].as_os_str() == *w);
        hit.then(|| comps[..i].iter().collect::<PathBuf>())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("liascape-assets-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_assets(lib: &Path) -> PathBuf {
        let a = assets_in(lib);
        std::fs::create_dir_all(a.join("shaders")).unwrap();
        std::fs::write(a.join(PROBE_FILE), "// probe").unwrap();
        a
    }

    #[test]
    fn vdf_paths_parsed() {
        let vdf = r#""libraryfolders"
{
	"0"
	{
		"path"		"/home/u/.local/share/Steam"
		"label"		""
		"apps" { "228980" "1" }
	}
	// a comment "path" "/not/this"
	"1"
	{
		"PATH"		"/mnt/Games/Steam Library"
		"apps" { "431960" "826555680" }
	}
	"2" { "path" "C:\\Games\\Steam" }
}"#;
        assert_eq!(
            parse_libraryfolders(vdf),
            vec![
                PathBuf::from("/home/u/.local/share/Steam"),
                PathBuf::from("/mnt/Games/Steam Library"),
                PathBuf::from("C:\\Games\\Steam"),
            ]
        );
        assert!(parse_libraryfolders("").is_empty());
        assert!(
            parse_libraryfolders("\"path\"").is_empty(),
            "a key without value"
        );
    }

    #[test]
    fn assets_found_in_secondary_library() {
        let home = tmp("secondary");
        let primary = home.join(".local/share/Steam");
        let second = home.join("games/SteamLibrary");
        std::fs::create_dir_all(primary.join("steamapps")).unwrap();
        std::fs::write(
            primary.join("steamapps/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
                primary.display(),
                second.display()
            ),
        )
        .unwrap();
        // WE's folder exists in the primary library but is empty (half-installed): skipped.
        std::fs::create_dir_all(assets_in(&primary)).unwrap();
        let want = fake_assets(&second);
        assert_eq!(resolve_with(None, None, &home), Ok(want.clone()));
        // An explicit dir wins over the auto-detection, and `env` over Steam.
        let other = fake_assets(&home.join("explicit"));
        assert_eq!(resolve_with(Some(&other), None, &home), Ok(other.clone()));
        assert_eq!(resolve_with(None, Some(&other), &home), Ok(other.clone()));
        // An unusable explicit dir falls through to the next candidate.
        assert_eq!(
            resolve_with(Some(&home.join("nope")), None, &home),
            Ok(want)
        );
    }

    #[test]
    fn missing_assets_error_names_every_candidate() {
        let home = tmp("missing");
        let primary = home.join(".local/share/Steam");
        std::fs::create_dir_all(primary.join("steamapps")).unwrap();
        std::fs::write(
            primary.join("steamapps/libraryfolders.vdf"),
            "\"libraryfolders\" { \"1\" { \"path\" \"/nonexistent/lib\" } }",
        )
        .unwrap();
        let explicit = home.join("explicit-assets");
        let e = resolve_with(Some(&explicit), Some(Path::new("/env/assets")), &home).unwrap_err();
        for want in [
            explicit.display().to_string(),
            "/env/assets".into(),
            assets_in(&primary).display().to_string(),
            "/nonexistent/lib/steamapps/common/wallpaper_engine/assets".into(),
            "LIASCAPE_WE_ASSETS_DIR".into(),
            "player.scene_assets".into(),
        ] {
            assert!(e.contains(&want), "{want:?} not in {e}");
        }
        let e = resolve_with(None, None, &tmp("nosteam")).unwrap_err();
        assert!(e.contains("no Steam install"), "{e}");
        assert!(e.contains("LIASCAPE_WE_ASSETS_DIR"), "{e}");
    }

    #[test]
    fn steam_root_of_symlinked_local_item() {
        let home = tmp("root");
        let root = home.join("Steam");
        let item = root.join("steamapps/workshop/content/431960/2371103399");
        std::fs::create_dir_all(&item).unwrap();
        let local = home.join("library/local");
        std::fs::create_dir_all(&local).unwrap();
        let link = local.join("2371103399");
        std::os::unix::fs::symlink(&item, &link).unwrap();
        let want = root.canonicalize().unwrap();
        assert_eq!(steam_root_of_item(&item), Some(want.clone()));
        assert_eq!(
            steam_root_of_item(&link),
            Some(want),
            "the symlink resolves"
        );
        assert_eq!(steam_root_of_item(&home.join("library")), None);
        assert_eq!(steam_root_of_item(&home.join("gone/123")), None);
    }
}
