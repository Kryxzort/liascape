//! GPU core (spec §5.1 "Graphics"): desktop OpenGL (core profile) via EGL. Everything
//! from here down — effect shaders (Task 8), layer composition (Task 9), libmpv video
//! textures (Task 10), the headless test harness (Task 11/12) and the real Wayland
//! outputs (Task 13) — renders through [`Gfx`].
//!
//! - [`egl`] — EGL display/context plumbing: [`Gfx`] itself, [`WindowTarget`].
//! - [`gl`] — GL-level helpers built on top of a [`Gfx`]: [`Tex`], [`Fbo`], shader
//!   programs, the shared empty VAO, PNG readback.
//! - [`effects`] — the gl-transitions effect catalogue (Task 8): [`Catalogue`],
//!   [`EffectProgram`].
//!
//! See `.claude/rules/player-core.md`'s "GFX / EGL" and "Effects" sections for the
//! display-selection order, the surfaceless requirement, the `read_rgba`/`write_png`
//! coordinate-origin conventions, and the effect-catalogue header-rewrite/uniform-binding
//! contract later tasks rely on.

pub mod effects;
pub mod egl;
pub mod gl;

pub use effects::{Catalogue, EffectProgram};
pub use egl::{Gfx, WindowTarget};
pub use gl::{Fbo, Tex};
