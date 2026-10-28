//! Phase 2 Task 1–2: LWE's core as the scene worker links it (`third_party/lwe/PIN`,
//! `patches/lwe/`, the flake's `lwe-core`, `scripts/lwe.sh`). `.claude/rules/player-core.md`
//! § Scene worker → "LWE core".
//!
//! The core tests SKIP without `LIASCAPE_LWE_CORE_DIR` (it is set by the devShell and the flake's
//! package) and FAIL then under `LIASCAPE_REQUIRE_SCENES=1`; the repo tests SKIP when the crate is
//! built alone (`nix build .#liascape-player` copies only `src/player`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

fn skip(reason: &str) {
    if std::env::var("LIASCAPE_REQUIRE_SCENES").is_ok_and(|v| !v.is_empty() && v != "0") {
        panic!("LIASCAPE_REQUIRE_SCENES is set but an LWE test would skip: {reason}");
    }
    println!("SKIP: {reason}");
}

fn core_dir() -> Option<PathBuf> {
    match std::env::var("LIASCAPE_LWE_CORE_DIR") {
        Ok(d) if !d.is_empty() => Some(PathBuf::from(d)),
        _ => {
            skip(
                "LIASCAPE_LWE_CORE_DIR is not set (the devShell sets it; or `bash scripts/lwe.sh build`)",
            );
            None
        }
    }
}

fn repo() -> Option<PathBuf> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    if repo.join("third_party/lwe/PIN").exists() {
        Some(repo)
    } else {
        println!("SKIP: no repo around the crate ({})", repo.display());
        None
    }
}

fn pin(repo: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(repo.join("third_party/lwe/PIN")).expect("read PIN");
    serde_json::from_str(&text).expect("PIN is JSON")
}

/// `nm -D --defined-only` of the core: `wp_*` exports, version suffix stripped (the `A` entry
/// is the version node, not a symbol).
fn exports(so: &Path) -> Vec<String> {
    let out = Command::new("nm")
        .args(["-D", "--defined-only"])
        .arg(so)
        .output()
        .expect("run nm");
    assert!(
        out.status.success(),
        "nm {}: {}",
        so.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let (_addr, kind, name) = (f.next()?, f.next()?, f.next()?);
            (kind != "A").then(|| name.split('@').next().unwrap_or(name).to_string())
        })
        .collect()
}

#[test]
fn core_exports_only_wp_symbols() {
    let Some(dir) = core_dir() else { return };
    let so = dir.join("lib/liblinux-wallpaperengine-core.so");
    assert!(so.exists(), "{} missing", so.display());
    let have = exports(&so);
    let foreign: Vec<_> = have.iter().filter(|s| !s.starts_with("wp_")).collect();
    assert!(
        foreign.is_empty(),
        "the core exports non-wp_ symbols: {foreign:?}"
    );
    let want: BTreeSet<String> = include_str!("fixtures/lwe_exports.txt")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(str::to_string)
        .collect();
    let have: BTreeSet<String> = have.into_iter().collect();
    let missing: Vec<_> = want.difference(&have).collect();
    assert!(
        missing.is_empty(),
        "the core lacks {missing:?} (fixtures/lwe_exports.txt)"
    );
    for patched in [
        "wp_config_set_audio_output",
        "wp_context_audio_pull",
        "wp_context_audio_stream_count",
        "wp_context_audio_driver_name",
    ] {
        assert!(
            have.contains(patched),
            "{patched}: patch 0003 is not in this core"
        );
    }
}

#[test]
fn core_is_the_pinned_one() {
    let Some(dir) = core_dir() else { return };
    let Some(repo) = repo() else { return };
    let rev = pin(&repo)["rev"].as_str().unwrap().to_string();
    // the flake's lwe-core and `lwe.sh build` stamp REV; a `LWE_DEV_SRC` build says "dev:<dir>"
    match std::fs::read_to_string(dir.join("REV")) {
        Ok(stamp) if stamp.trim().starts_with("dev:") => {
            println!("SKIP: a development core ({})", stamp.trim())
        }
        Ok(stamp) => assert_eq!(
            stamp.trim(),
            rev,
            "LIASCAPE_LWE_CORE_DIR ({}) holds another rev than third_party/lwe/PIN — re-enter the \
             devShell or re-run `bash scripts/lwe.sh fetch prepare build`",
            dir.display()
        ),
        Err(_) => println!("SKIP: {} has no REV stamp", dir.display()),
    }
}

#[test]
fn worker_links_the_core() {
    if !cfg!(feature = "lwe") {
        println!("SKIP: built without the `lwe` feature");
        return;
    }
    let Some(dir) = core_dir() else { return };
    let worker = Path::new(env!("CARGO_BIN_EXE_liascape-scene-worker"));
    let out = Command::new("readelf").arg("-d").arg(worker).output();
    let Ok(out) = out else {
        println!("SKIP: no readelf");
        return;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("liblinux-wallpaperengine-core.so"),
        "liascape-scene-worker has no NEEDED on the core:\n{text}"
    );
    assert!(
        text.contains(&format!("{}/lib", dir.display())) || text.contains("$ORIGIN"),
        "liascape-scene-worker's RUNPATH names neither {}/lib nor $ORIGIN:\n{text}",
        dir.display()
    );
    let lp = Path::new(env!("CARGO_BIN_EXE_liascape-player"));
    let out = Command::new("readelf").arg("-d").arg(lp).output().unwrap();
    assert!(
        !String::from_utf8_lossy(&out.stdout).contains("linux-wallpaperengine"),
        "the compositor binary must never link LWE"
    );
}

#[test]
fn patch_headers_are_complete() {
    let Some(repo) = repo() else { return };
    let mut patches: Vec<_> = std::fs::read_dir(repo.join("patches/lwe"))
        .expect("patches/lwe")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "patch"))
        .collect();
    patches.sort();
    assert!(!patches.is_empty(), "no patches/lwe/*.patch");
    for (i, p) in patches.iter().enumerate() {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.starts_with(&format!("{:04}-", i + 1)),
            "{name}: patches are numbered 0001… in order"
        );
        let text = std::fs::read_to_string(p).unwrap();
        let (head, _) = text.split_once("\n---\n").unwrap_or((&text, ""));
        let field = |k: &str| {
            head.lines()
                .find_map(|l| l.strip_prefix(&format!("{k}: ")))
                .map(str::trim)
                .map(str::to_string)
        };
        for k in ["From", "Subject", "Why"] {
            assert!(field(k).is_some_and(|v| !v.is_empty()), "{name}: no `{k}:`");
        }
        let origin = field("Origin").unwrap_or_default();
        assert!(
            ["ours", "upstream-PR", "upstream-commit"]
                .iter()
                .any(|o| origin.starts_with(o)),
            "{name}: Origin `{origin}` ∉ {{ours, upstream-PR, upstream-commit}}"
        );
        if origin.starts_with("upstream-PR") {
            assert!(
                field("Upstream-PR").is_some(),
                "{name}: an upstream PR needs Upstream-PR:"
            );
        }
        if origin.starts_with("upstream-commit") {
            assert!(
                field("Upstream-Commit").is_some(),
                "{name}: needs Upstream-Commit:"
            );
        }
        // `upstream: <where>` = already merged upstream, on a branch our base doesn't have yet (a
        // cherry-pick from upstream `main` onto `next-v2`); dropped by the next rebase onto a base that has it
        let status = field("Status").unwrap_or_default();
        let merged = status.starts_with("upstream: ") && status.len() > "upstream: ".len();
        assert!(
            status == "candidate-for-upstream" || status == "local-only" || merged,
            "{name}: Status `{status}` ∉ {{candidate-for-upstream, local-only, upstream: <where>}}"
        );
        if merged {
            assert!(
                origin.starts_with("upstream-"),
                "{name}: `Status: upstream: …` needs an upstream Origin, not `{origin}`"
            );
        }
    }
}

#[test]
fn pin_matches_flake() {
    let Some(repo) = repo() else { return };
    let pin = pin(&repo);
    let rev = pin["rev"].as_str().expect("PIN.rev");
    let base = pin["base"].as_str().expect("PIN.base");
    let hash = pin["nix_hash"].as_str().expect("PIN.nix_hash");
    for (k, v) in [("rev", rev), ("base", base)] {
        assert!(
            v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit()),
            "PIN.{k} `{v}`"
        );
    }
    assert!(
        hash.starts_with("sha256-") && hash.len() == 51 && !hash.contains("AAAAAAAAAA"),
        "PIN.nix_hash `{hash}` is not a real SRI hash"
    );
    assert_eq!(
        pin["submodules"].as_object().map(|m| m.len()),
        Some(10),
        "PIN.submodules"
    );
    // the flake takes rev + hash from the PIN itself (one source of truth): it must keep doing so
    let flake = std::fs::read_to_string(repo.join("flake.nix")).unwrap();
    for needle in [
        "builtins.fromJSON (builtins.readFile ./third_party/lwe/PIN)",
        "rev = lwePin.rev;",
        "hash = lwePin.nix_hash;",
        "LIASCAPE_LWE_CORE_DIR = \"${lwe-core}\";",
    ] {
        assert!(flake.contains(needle), "flake.nix no longer has `{needle}`");
    }
    // and the patch series ends at the pinned rev (format-patch's first line names the commit)
    let mut last = None;
    for e in std::fs::read_dir(repo.join("patches/lwe"))
        .unwrap()
        .flatten()
    {
        let p = e.path();
        if p.extension().is_some_and(|e| e == "patch")
            && last.as_ref().is_none_or(|l: &PathBuf| p > *l)
        {
            last = Some(p);
        }
    }
    let last = std::fs::read_to_string(last.expect("a patch")).unwrap();
    assert!(
        last.starts_with(&format!("From {rev} ")),
        "the last patch is not PIN.rev's commit — run `bash scripts/lwe.sh fetch patches`"
    );
}
