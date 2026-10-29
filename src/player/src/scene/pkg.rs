//! Wallpaper Engine's `scene.pkg` container (read-only), for the offline loudness estimate
//! ([`super::loudness_estimate`]). Layout (little-endian; LWE's `PackageParser`, confirmed on
//! every `scene.pkg` of the owner's Workshop library — `.claude/rules/player-core.md` § Scene
//! worker → "Scene loudness" → "Offline estimate"):
//!
//! ```text
//! u32 n, n bytes   header "PKGV00xx" (xx = 01…24 seen; one layout for all of them)
//! u32 count
//! count × { u32 n, n bytes name (UTF-8, '/'-separated), u32 offset, u32 length }
//! data             entry i = bytes [data_start + offset_i, + length_i)
//! ```
//!
//! `data_start` is the position right after the entry table; the entries are contiguous from
//! offset 0 and the last one ends at the end of the file (not required here — only that each
//! entry lies inside the file).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One file inside a package; `offset` is absolute (from the start of the `.pkg`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone)]
pub struct Pkg {
    pub path: PathBuf,
    /// The header string, e.g. `PKGV0021`.
    pub version: String,
    pub data_start: u64,
    pub size: u64,
    pub entries: Vec<Entry>,
}

/// Longest header / entry name accepted (real ones: 8 / < 300 bytes).
const MAX_HEADER: u32 = 64;
const MAX_NAME: u32 = 4096;
const MAX_ENTRIES: u32 = 1_000_000;

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

fn u32_of(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn string_of(r: &mut impl Read, max: u32, what: &str) -> io::Result<String> {
    let n = u32_of(r)?;
    if n > max {
        return Err(bad(format!("{what} length {n} > {max}: not a scene.pkg")));
    }
    let mut b = vec![0u8; n as usize];
    r.read_exact(&mut b)?;
    String::from_utf8(b).map_err(|_| bad(format!("{what} is not UTF-8")))
}

impl Pkg {
    pub fn open(path: &Path) -> io::Result<Pkg> {
        let mut f = io::BufReader::new(File::open(path)?);
        let size = f.get_ref().metadata()?.len();
        Pkg::parse(&mut f, size, path)
    }

    /// Parse the header + entry table from `r` (positioned at 0) of a `size`-byte package.
    pub fn parse(r: &mut (impl Read + Seek), size: u64, path: &Path) -> io::Result<Pkg> {
        let version = string_of(r, MAX_HEADER, "header")?;
        if !version.starts_with("PKGV") {
            return Err(bad(format!("header {version:?} doesn't start with PKGV")));
        }
        let count = u32_of(r)?;
        if count > MAX_ENTRIES {
            return Err(bad(format!("{count} entries: not a scene.pkg")));
        }
        let mut raw = Vec::with_capacity(count.min(4096) as usize);
        for _ in 0..count {
            let name = string_of(r, MAX_NAME, "entry name")?;
            let offset = u32_of(r)? as u64;
            let len = u32_of(r)? as u64;
            raw.push((name, offset, len));
        }
        let data_start = r.stream_position()?;
        let mut entries = Vec::with_capacity(raw.len());
        for (name, offset, len) in raw {
            let abs = data_start + offset;
            if abs + len > size {
                return Err(bad(format!(
                    "entry {name:?} [{abs}, +{len}) runs past the end ({size} bytes): truncated"
                )));
            }
            entries.push(Entry {
                name,
                offset: abs,
                len,
            });
        }
        Ok(Pkg {
            path: path.to_path_buf(),
            version,
            data_start,
            size,
            entries,
        })
    }

    /// The entry named `name` — exactly, else ignoring ASCII case (LWE's fork patch 0016 does
    /// the same for a path no mountpoint has exactly). A leading `/` or `./` is ignored.
    pub fn find(&self, name: &str) -> Option<&Entry> {
        let name = name.trim_start_matches("./").trim_start_matches('/');
        self.entries.iter().find(|e| e.name == name).or_else(|| {
            self.entries
                .iter()
                .find(|e| e.name.eq_ignore_ascii_case(name))
        })
    }

    pub fn read(&self, e: &Entry) -> io::Result<Vec<u8>> {
        let mut f = File::open(&self.path)?;
        f.seek(SeekFrom::Start(e.offset))?;
        let mut b = vec![0u8; e.len as usize];
        f.read_exact(&mut b)?;
        Ok(b)
    }
}

/// A package with these entries, in order (test fixtures; the same layout WE writes).
pub fn build(version: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let s = |out: &mut Vec<u8>, v: &[u8]| {
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        out.extend_from_slice(v);
    };
    s(&mut out, version.as_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    let mut off = 0u32;
    for (name, data) in entries {
        s(&mut out, name.as_bytes());
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        off += data.len() as u32;
    }
    for (_, data) in entries {
        out.extend_from_slice(data);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(bytes: &[u8]) -> io::Result<Pkg> {
        Pkg::parse(
            &mut io::Cursor::new(bytes),
            bytes.len() as u64,
            Path::new("mem.pkg"),
        )
    }

    #[test]
    fn generated_pkg_round_trips() {
        let b = build(
            "PKGV0021",
            &[
                ("scene.json", b"{\"objects\":[]}"),
                ("sounds/Rain.MP3", b"abc"),
            ],
        );
        let p = parse(&b).unwrap();
        assert_eq!(p.version, "PKGV0021");
        // 4 + 8 header, 4 count, (4 + 10 + 8) + (4 + 15 + 8) table
        assert_eq!(p.data_start, 4 + 8 + 4 + 22 + 27);
        assert_eq!(p.entries.len(), 2);
        assert_eq!(p.entries[0].offset, p.data_start);
        assert_eq!(p.entries[1].offset, p.data_start + 14);
        assert_eq!(p.entries[1].offset + p.entries[1].len, b.len() as u64);
        let e = p.entries[1].clone();
        assert_eq!(&b[e.offset as usize..(e.offset + e.len) as usize], b"abc");
        assert_eq!(p.find("sounds/Rain.MP3"), Some(&e));
        assert_eq!(
            p.find("sounds/rain.mp3"),
            Some(&e),
            "case-insensitive fallback"
        );
        assert_eq!(p.find("/sounds/Rain.MP3"), Some(&e));
        assert!(p.find("sounds/other.mp3").is_none());
    }

    #[test]
    fn reads_an_entry_from_a_file() {
        let dir = std::env::temp_dir().join(format!("lia-pkg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scene.pkg");
        std::fs::write(&path, build("PKGV0001", &[("a", b"12345"), ("b", b"xyz")])).unwrap();
        let p = Pkg::open(&path).unwrap();
        assert_eq!(p.read(p.find("b").unwrap()).unwrap(), b"xyz");
        assert_eq!(p.read(p.find("a").unwrap()).unwrap(), b"12345");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn garbage_and_truncation_are_refused() {
        assert!(parse(b"").is_err());
        let mut not_pkg = build("ZIPV0001", &[("a", b"1")]);
        assert!(parse(&not_pkg).is_err());
        not_pkg = build("PKGV0001", &[("a", b"12345")]);
        not_pkg.truncate(not_pkg.len() - 1);
        let e = parse(&not_pkg).unwrap_err();
        assert!(e.to_string().contains("truncated"), "{e}");
        // a huge length field is refused before allocating
        let mut huge = 8u32.to_le_bytes().to_vec();
        huge.extend_from_slice(b"PKGV0001");
        huge.extend_from_slice(&1u32.to_le_bytes());
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&huge).is_err());
    }
}
