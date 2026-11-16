//! Which folder of Windows fonts a scene worker reads (`docs/player/modules/scene-lwe-core.md` § Fonts).
//! A scene's text that names a Windows system font (`systemfont_consolas`, `systemfont_comicsans` …, and
//! WE's fallback chain: Arial, Segoe UI Emoji, Microsoft YaHei …) gets the real face when the worker can
//! read the user's own Windows install; nothing Microsoft-licensed is shipped or copied, the worker reads
//! the files where they are (`liascape-scene-worker` hands the folder to fontconfig as an application
//! font dir).
//!
//! The choice ([`Choice`]) travels from `player.scene_fonts` (or [`ENV`] in the compositor's
//! environment when the prop is auto) to each worker in [`ENV`] ([`effective`]). The worker resolves
//! it ([`resolve`]): auto = the first `Windows/Fonts` (any case) at the root of a mounted NTFS
//! file system in `/proc/self/mountinfo`. Resolving never mounts anything and runs in the worker,
//! never on the compositor's loop: a sleeping disk or a stuck FUSE daemon delays one scene's load,
//! not the desktop. No GPU, no fontconfig here.

use std::path::{Path, PathBuf};

/// The worker's setting (and, in the compositor's environment, what auto means there: tests set
/// `off`): `auto` (or empty), `off`, or an absolute folder.
pub const ENV: &str = "LIASCAPE_SCENE_FONTS";

/// File-system types a Windows install is mounted with (kernel ntfs3 / ntfs, ntfs-3g's FUSE).
const NTFS_TYPES: &[&str] = &["ntfs3", "ntfs", "fuseblk", "fuse.ntfs-3g", "ntfs-3g"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// Find a mounted Windows install's fonts.
    Auto,
    /// No Windows fonts: fontconfig's own only.
    Off,
    /// This folder.
    Folder(PathBuf),
}

impl Choice {
    /// `""` / `auto` → [`Choice::Auto`], `off` → [`Choice::Off`], anything else a folder.
    pub fn parse(s: &str) -> Choice {
        match s.trim() {
            "" | "auto" => Choice::Auto,
            "off" => Choice::Off,
            dir => Choice::Folder(PathBuf::from(dir)),
        }
    }

    /// The value [`ENV`] carries.
    pub fn as_env(&self) -> String {
        match self {
            Choice::Auto => "auto".into(),
            Choice::Off => "off".into(),
            Choice::Folder(d) => d.display().to_string(),
        }
    }
}

/// What a worker gets: the prop's choice, or for an auto prop the compositor's own [`ENV`] (unset
/// or empty = auto).
pub fn effective(prop: &str, env: Option<&str>) -> Choice {
    match Choice::parse(prop) {
        Choice::Auto => Choice::parse(env.unwrap_or("")),
        c => c,
    }
}

/// The resolved folder and one line saying where it came from (or why there is none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub dir: Option<PathBuf>,
    pub note: String,
}

/// [`resolve_with`] reading `/proc/self/mountinfo`.
pub fn resolve(choice: &Choice) -> Resolved {
    resolve_with(choice, || {
        std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default()
    })
}

/// The folder for `choice`; `mountinfo` is read only for [`Choice::Auto`].
pub fn resolve_with(choice: &Choice, mountinfo: impl FnOnce() -> String) -> Resolved {
    match choice {
        Choice::Off => Resolved {
            dir: None,
            note: "Windows fonts off".into(),
        },
        Choice::Folder(d) if d.is_absolute() && d.is_dir() => Resolved {
            dir: Some(d.clone()),
            note: format!("Windows fonts from {} (the setting)", d.display()),
        },
        Choice::Folder(d) => Resolved {
            dir: None,
            note: format!(
                "Windows fonts folder {} is not a folder: none read",
                d.display()
            ),
        },
        Choice::Auto => match windows_fonts_in(&mountinfo()) {
            Some(d) => Resolved {
                note: format!(
                    "Windows fonts from {} (a mounted Windows install)",
                    d.display()
                ),
                dir: Some(d),
            },
            None => Resolved {
                dir: None,
                note: "no mounted Windows install with a Windows/Fonts folder".into(),
            },
        },
    }
}

/// The first `<mount point>/Windows/Fonts` (each part matched in any case) of an NTFS mount in
/// `mountinfo` (`/proc/<pid>/mountinfo` text), in mount order.
pub fn windows_fonts_in(mountinfo: &str) -> Option<PathBuf> {
    ntfs_mount_points(mountinfo)
        .into_iter()
        .find_map(|mp| child_ci(&child_ci(&mp, "Windows")?, "Fonts"))
}

/// Mount points of NTFS file systems in `mountinfo`, in order. A line is
/// `id parent maj:min root mount-point options [optional…] - fstype source super-options`; the
/// mount point has spaces, tabs, newlines and backslashes octal-escaped (`\040`).
pub fn ntfs_mount_points(mountinfo: &str) -> Vec<PathBuf> {
    mountinfo
        .lines()
        .filter_map(|line| {
            let (pre, post) = line.split_once(" - ")?;
            let fstype = post.split(' ').next()?;
            if !NTFS_TYPES.contains(&fstype) {
                return None;
            }
            pre.split(' ').nth(4).map(|mp| PathBuf::from(unescape(mp)))
        })
        .collect()
}

fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && (b'0'..=b'3').contains(&b[i + 1])
            && b[i + 2..i + 4].iter().all(|c| (b'0'..=b'7').contains(c))
        {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `dir/<name>` as a directory, the name matched in any case (NTFS keeps a name's case, a Linux
/// mount may look it up case-sensitively).
fn child_ci(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.is_dir() {
        return Some(exact);
    }
    std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
        let p = e.path();
        (e.file_name().to_string_lossy().eq_ignore_ascii_case(name) && p.is_dir()).then_some(p)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(mp: &str, fstype: &str) -> String {
        format!("41 1 259:3 / {mp} rw,relatime shared:12 - {fstype} /dev/nvme1n1p3 rw,uid=1000\n")
    }

    #[test]
    fn choices_parse_and_auto_defers_to_the_environment() {
        assert_eq!(Choice::parse(""), Choice::Auto);
        assert_eq!(Choice::parse(" auto "), Choice::Auto);
        assert_eq!(Choice::parse("off"), Choice::Off);
        assert_eq!(Choice::parse("/f"), Choice::Folder("/f".into()));
        assert_eq!(effective("", Some("off")), Choice::Off);
        assert_eq!(effective("", None), Choice::Auto);
        assert_eq!(effective("", Some("")), Choice::Auto);
        assert_eq!(effective("/x", Some("off")), Choice::Folder("/x".into()));
        assert_eq!(effective("off", Some("/x")), Choice::Off);
        for c in [Choice::Auto, Choice::Off, Choice::Folder("/a b".into())] {
            assert_eq!(Choice::parse(&c.as_env()), c);
        }
    }

    #[test]
    fn auto_finds_windows_fonts_on_an_ntfs_mount_in_any_case() {
        let root = std::env::temp_dir().join(format!("lia-fonts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // an ext4 mount with a Windows/Fonts (not NTFS: skipped), an NTFS data drive without one,
        // then the install, its folders in WINDOWS/fonts case and its mount point with a space
        let ext = root.join("ext");
        let data = root.join("data");
        let win = root.join("win c");
        std::fs::create_dir_all(ext.join("Windows/Fonts")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(win.join("WINDOWS/fonts")).unwrap();
        let info = line(&ext.display().to_string(), "ext4")
            + &line(&data.display().to_string(), "ntfs3")
            + &line(&win.display().to_string().replace(' ', "\\040"), "fuseblk");
        assert_eq!(windows_fonts_in(&info), Some(win.join("WINDOWS/fonts")));
        let r = resolve_with(&Choice::Auto, || info.clone());
        assert_eq!(r.dir, Some(win.join("WINDOWS/fonts")));
        // no NTFS mount with one: none, and `off` never reads the mount table
        assert_eq!(
            windows_fonts_in(&line(&ext.display().to_string(), "ext4")),
            None
        );
        let off = resolve_with(&Choice::Off, || panic!("off read the mount table"));
        assert_eq!(off.dir, None);
        // a folder: taken as it is when it is one; a relative or missing one is none
        let f = resolve_with(&Choice::Folder(data.clone()), || {
            panic!("read the mount table")
        });
        assert_eq!(f.dir, Some(data.clone()));
        assert_eq!(
            resolve_with(&Choice::Folder("rel".into()), String::new).dir,
            None
        );
        assert_eq!(
            resolve_with(&Choice::Folder(root.join("missing")), String::new).dir,
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
