//! GPU core (spec §5.1 "Graphics"): desktop OpenGL (core profile) via EGL. Everything
//! from here down — effect shaders (Task 8), layer composition (Task 9), libmpv video
//! textures (Task 10), the headless test harness (Task 11/12) and the real Wayland
//! outputs (Task 13) — renders through [`Gfx`].
//!
//! - [`egl`] — EGL display/context plumbing: [`Gfx`] itself, [`WindowTarget`].
//! - [`gl`] — GL-level helpers built on top of a [`Gfx`]: [`Tex`], [`Fbo`], shader
//!   programs, the shared empty VAO, PNG readback.
//!
//! See `.claude/rules/player-core.md`'s "GFX / EGL" section for the display-selection
//! order, the surfaceless requirement, and the `read_rgba`/`write_png` coordinate-origin
//! conventions later tasks rely on.

pub mod egl;
pub mod gl;

pub use egl::{Gfx, WindowTarget};
pub use gl::{Fbo, Tex};
