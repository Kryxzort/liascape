//! libmpv FFI (spec §5.1, Task 10): bindgen over `mpv/client.h` + `mpv/render.h` +
//! `mpv/render_gl.h`, found through pkg-config `mpv` — which also emits the
//! `cargo:rustc-link-lib=mpv` + `-L` that nixpkgs auto-rpaths (same mechanism the
//! `khronos-egl` `static` feature relies on for libEGL; see `.claude/rules/player-core.md`
//! § GFX / EGL). The flake's `liascape-player` derivation carries `pkg-config` +
//! `rustPlatform.bindgenHook` (libclang) for this.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    lwe_link();
    let mpv = pkg_config::Config::new()
        .atleast_version("2.0") // client API 2.x (mpv ≥ 0.35): render API + volume-gain
        .probe("mpv")
        .expect("pkg-config: libmpv (mpv.pc) not found — need mpv dev headers");

    let mut builder = bindgen::Builder::default()
        .header_contents(
            "liascape_mpv_wrapper.h",
            "#include <mpv/client.h>\n#include <mpv/render.h>\n#include <mpv/render_gl.h>\n",
        )
        .allowlist_function("mpv_.*")
        .allowlist_type("mpv_.*")
        .allowlist_var("MPV_.*")
        // C enums as plain integer constants in a module per enum: a value libmpv adds
        // later (a new event id, a new end-file reason) can never be UB the way an
        // out-of-range Rust `enum` would be.
        .default_enum_style(bindgen::EnumVariation::ModuleConsts)
        .layout_tests(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));
    for inc in &mpv.include_paths {
        builder = builder.clang_arg(format!("-I{}", inc.display()));
    }
    let bindings = builder
        .generate()
        .expect("bindgen over mpv/client.h + render.h + render_gl.h failed");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("mpv_bindings.rs");
    bindings.write_to_file(&out).expect("write mpv_bindings.rs");
}

/// Phase 2 (feature `lwe`, default on): only `liascape-scene-worker` links LWE's core — the
/// compositor binary never does (`rustc-link-arg-bin`). The core is `$LIASCAPE_LWE_CORE_DIR/lib`:
/// the flake's `lwe-core` (its devShell and the `liascape-player` package set it), or
/// `scripts/lwe.sh build` (`build/lwe-core`). The worker's RUNPATH is that dir, or
/// `$LIASCAPE_LWE_RPATH` when set (`install.sh`: `$ORIGIN/../lib`, the core installed beside it).
fn lwe_link() {
    println!("cargo::rerun-if-env-changed=LIASCAPE_LWE_CORE_DIR");
    println!("cargo::rerun-if-env-changed=LIASCAPE_LWE_RPATH");
    if env::var_os("CARGO_FEATURE_LWE").is_none() {
        return;
    }
    let dir = env::var("LIASCAPE_LWE_CORE_DIR").ok().filter(|d| !d.is_empty());
    let Some(dir) = dir else {
        panic!(
            "feature `lwe` (on by default) needs LWE's core: build inside the repo's devShell \
             (`nix develop` sets LIASCAPE_LWE_CORE_DIR), or run `bash scripts/lwe.sh fetch prepare \
             build` and set LIASCAPE_LWE_CORE_DIR to the directory it prints (the one holding lib/), \
             or build without it (`--no-default-features`) — liascape-scene-worker then plays \
             synthetic scenes only"
        );
    };
    let so = std::path::Path::new(&dir).join("lib/liblinux-wallpaperengine-core.so");
    if !so.exists() {
        panic!(
            "LIASCAPE_LWE_CORE_DIR={dir} has no lib/liblinux-wallpaperengine-core.so — run \
             `bash scripts/lwe.sh fetch prepare build` (or point it at the flake's lwe-core)"
        );
    }
    println!("cargo::rerun-if-changed={}", so.display());
    let rpath = env::var("LIASCAPE_LWE_RPATH")
        .ok()
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| format!("{dir}/lib"));
    let bin = "liascape-scene-worker";
    println!("cargo::rustc-link-arg-bin={bin}=-L{dir}/lib");
    println!("cargo::rustc-link-arg-bin={bin}=-llinux-wallpaperengine-core");
    println!("cargo::rustc-link-arg-bin={bin}=-Wl,-rpath,{rpath}");
}
