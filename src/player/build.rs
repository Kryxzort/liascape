//! libmpv FFI (spec §5.1, Task 10): bindgen over `mpv/client.h` + `mpv/render.h` +
//! `mpv/render_gl.h`, found through pkg-config `mpv` — which also emits the
//! `cargo:rustc-link-lib=mpv` + `-L` that nixpkgs auto-rpaths (same mechanism the
//! `khronos-egl` `static` feature relies on for libEGL; see `.claude/rules/player-core.md`
//! § GFX / EGL). The flake's `lp-player` derivation carries `pkg-config` +
//! `rustPlatform.bindgenHook` (libclang) for this.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let mpv = pkg_config::Config::new()
        .atleast_version("2.0") // client API 2.x (mpv ≥ 0.35): render API + volume-gain
        .probe("mpv")
        .expect("pkg-config: libmpv (mpv.pc) not found — need mpv dev headers");

    let mut builder = bindgen::Builder::default()
        .header_contents(
            "lp_mpv_wrapper.h",
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
