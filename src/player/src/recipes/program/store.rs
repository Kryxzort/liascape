//! A program across player restarts (designer call 4): its configuration and play order in
//! `<state>/program.json` (written only when they change), its dynamic state — the cursor,
//! history, play time, countdown — in `snapshot.json`'s `programs` ([`ProgramSnap`]), which
//! the snapshot refreshes anyway. Both are written on the snapshot thread (`lia-snapshot`),
//! atomically, `program.json` first. Each carries the program's definition revision
//! (`rev`): a snapshot whose `rev` lags or leads `program.json`'s (a crash between the two
//! writes) keeps `program.json`'s order and re-anchors the cursor on the saved current
//! item.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The file in the state dir.
pub const FILE: &str = "program.json";
/// The format this player writes and reads.
pub const VERSION: u32 = 1;

/// A program node's settable props, as `program.json` keeps them (`outputs` is fixed at
/// create; the observed ones are not kept).
pub const SETTABLE: [&str; 14] = [
    "outputs",
    "items",
    "defaults",
    "order",
    "mode",
    "interval_ms",
    "max_ms",
    "separate_scenes",
    "scenes_after_ms",
    "transition",
    "seed",
    "while_parked",
    "key",
    "start_mode",
];

/// `program.json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ProgramFile {
    pub version: u32,
    /// Bumped on every write (any program's definition changed).
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub programs: Vec<ProgramDef>,
}

/// One program's definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgramDef {
    pub id: String,
    /// Its settable props ([`SETTABLE`]), as `get` returns them.
    #[serde(default)]
    pub props: Map<String, Value>,
    pub order: OrderSnap,
}

/// The play order (`Order`): the items in play order (a shuffle cycle's), the cursor, shuffle.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct OrderSnap {
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub idx: usize,
    #[serde(default)]
    pub shuffle: bool,
}

/// A program's dynamic state in `snapshot.json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ProgramSnap {
    pub id: String,
    /// The `program.json` revision this state belongs to.
    #[serde(default)]
    pub rev: u64,
    /// The cursor in the order's items (it differs from the current item's place after a
    /// `prev`).
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub history: Vec<String>,
    #[serde(default)]
    pub history_index: usize,
    /// What played (`None` = the program was idle).
    #[serde(default)]
    pub current_path: Option<String>,
    #[serde(default)]
    pub played_ms: f64,
    #[serde(default)]
    pub remaining_ms: f64,
    #[serde(default)]
    pub last_effect: Option<String>,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub broken: Vec<String>,
}

impl ProgramFile {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = serde_json::to_vec_pretty(self).unwrap_or_default();
        b.push(b'\n');
        b
    }

    pub fn parse(bytes: &[u8]) -> Result<ProgramFile, String> {
        let f: ProgramFile =
            serde_json::from_slice(bytes).map_err(|e| format!("bad program.json: {e}"))?;
        if f.version != VERSION {
            return Err(format!(
                "unknown version {} (this player reads version {VERSION})",
                f.version
            ));
        }
        Ok(f)
    }
}

/// Read `<dir>/program.json`: `Ok(None)` when there is none.
pub fn load(dir: &Path) -> Result<Option<ProgramFile>, String> {
    match std::fs::read(dir.join(FILE)) {
        Ok(b) => ProgramFile::parse(&b).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("can't read {}: {e}", dir.join(FILE).display())),
    }
}

/// Whether `order` holds exactly the items of `paths` (a saved play order still fits the
/// program's items).
pub fn same_items(order: &[String], paths: &[String]) -> bool {
    if order.len() != paths.len() {
        return false;
    }
    let mut a = order.to_vec();
    let mut b = paths.to_vec();
    a.sort();
    b.sort();
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_file_roundtrips_and_rejects_other_versions() {
        let f = ProgramFile {
            version: VERSION,
            rev: 3,
            programs: vec![ProgramDef {
                id: "prog:main".into(),
                props: serde_json::json!({"order": "shuffle"})
                    .as_object()
                    .unwrap()
                    .clone(),
                order: OrderSnap {
                    items: vec!["b".into(), "a".into()],
                    idx: 1,
                    shuffle: true,
                },
            }],
        };
        assert_eq!(ProgramFile::parse(&f.to_bytes()).unwrap(), f);
        assert!(ProgramFile::parse(br#"{"version": 2}"#).is_err());
        assert!(ProgramFile::parse(b"nope").is_err());
        assert!(same_items(&["b".into(), "a".into()], &["a".into(), "b".into()]));
        assert!(!same_items(&["a".into()], &["a".into(), "b".into()]));
    }
}
