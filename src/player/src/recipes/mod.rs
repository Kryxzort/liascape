//! Recipes (spec §4.3): features built only from the blocks — graph `create`/`set`/
//! `destroy` plus `Animator` animations. A recipe never renders, never touches a live
//! source and never special-cases a source kind; the compositor and `SourceHost` turn
//! what it writes into pictures and sound.
//!
//! - [`transition`] — A→B with an effect (or a cut), three hold methods, `align: end`,
//!   interrupt/cancel/failure handling (Task 11).

pub mod transition;

pub use transition::{
    Align, Method, Phase, TransitionEvent, TransitionEventKind, TransitionReq, TransitionStatus,
    Transitions,
};
