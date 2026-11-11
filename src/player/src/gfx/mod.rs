//! GPU core (spec §5.1 "Graphics"): desktop OpenGL (core profile) via EGL. Everything
//! from here down — effect shaders, layer composition, libmpv video
//! textures, the headless test harness and the real Wayland
//! outputs — renders through [`Gfx`].
//!
//! - [`egl`] — EGL display/context plumbing: [`Gfx`] itself, [`WindowTarget`].
//! - [`gl`] — GL-level helpers built on top of a [`Gfx`]: [`Tex`], [`Fbo`], shader
//!   programs, the shared empty VAO, PNG readback.
//! - [`effects`] — the gl-transitions effect catalogue: [`Catalogue`],
//!   [`EffectProgram`].
//! - [`compose`] — layer composition: [`Composer`], [`fit_rect`], [`UvRect`].
//!
//! See `docs/player/modules/gfx-egl.md` and `docs/player/modules/composition.md`
//! for the display-selection order, the surfaceless requirement, the `read_rgba`/
//! `write_png` coordinate-origin conventions, the effect-catalogue header-rewrite/
//! uniform-binding contract, and the composer's fit/viewport/opacity rules later tasks
//! rely on.

pub mod compose;
pub mod dmabuf;
pub mod effects;
pub mod egl;
pub mod gl;

pub use compose::{Composer, UvRect, fit_rect};
pub use effects::{Catalogue, EffectProgram};
pub use egl::{
    CurrentGuard, Gfx, GlKeepAlive, OffscreenOpts, Priority, SharedContext, WindowTarget,
};
pub use gl::{Fbo, MappedPixels, PackBuffer, PendingReadback, Readback, Tex};
