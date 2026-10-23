//! M10 (final review; spec §7 "a test fails when it is stale"): `CREDITS.md` is generated
//! from `UPSTREAM.md` (+ `patches/`) by `scripts/gen-credits.py`; this runs its `--check`
//! (exit 1 with a diff when stale). Skips (prints `SKIP: …`) when the repo around the crate
//! isn't there — `nix build .#lp-player` builds `src/player` alone — or there's no
//! `python3`.

use std::path::Path;
use std::process::Command;

#[test]
fn credits_md_is_up_to_date() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = repo.join("scripts/gen-credits.py");
    if !script.exists() || !repo.join("UPSTREAM.md").exists() {
        println!("SKIP: no repo around the crate ({})", script.display());
        return;
    }
    let out = match Command::new("python3").arg(&script).arg("--check").output() {
        Ok(o) => o,
        Err(e) => {
            println!("SKIP: no python3 ({e})");
            return;
        }
    };
    assert!(
        out.status.success(),
        "CREDITS.md is stale — run `python3 scripts/gen-credits.py`:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
