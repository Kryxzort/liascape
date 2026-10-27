//! The worker's frame ring (spike `dmabuf.md` §2): N `GL_RGBA8` textures, each with its own
//! FBO, exported once as a dmabuf. A slot is busy from the `Frame` that names it until the
//! compositor's `Release` (whose fence must be waited on before rendering into it again).
//! Slot ids are unique for the worker's lifetime (`first_id..`), so a re-exported ring
//! (Task 5's `Resize`) can't be confused with this one.

use std::os::fd::OwnedFd;

use lp_player::gfx::dmabuf::EglImage;
use lp_player::gfx::{Fbo, Gfx, Tex};
use lp_player::worker::proto::FromWorker;

/// A `Buffer` message and its plane fds.
pub type BufferMsg = (FromWorker, Vec<OwnedFd>);

pub struct Slot {
    pub id: u8,
    _tex: Tex,
    pub fbo: Fbo,
    _image: EglImage,
    /// Handed to the compositor and not released yet.
    pub busy: bool,
    /// The compositor's release fence: wait on it before the next render into this slot.
    pub release: Option<OwnedFd>,
}

pub struct Ring {
    pub slots: Vec<Slot>,
    pub w: u32,
    pub h: u32,
}

impl Ring {
    /// Allocate and export `n` slots of `w`×`h`; returns the ring and its `Buffer` messages
    /// (with their plane fds) to send.
    pub fn new(
        gfx: &Gfx,
        w: u32,
        h: u32,
        n: u8,
        first_id: u8,
    ) -> Result<(Ring, Vec<BufferMsg>), String> {
        let mut slots = Vec::new();
        let mut msgs = Vec::new();
        for i in 0..n {
            let tex = gfx.tex(w, h);
            let fbo = gfx.fbo(&tex);
            let ex = gfx.export_dmabuf(&tex)?;
            let id = first_id.wrapping_add(i);
            msgs.push((
                FromWorker::Buffer {
                    slot: id,
                    w,
                    h,
                    fourcc: ex.desc.fourcc,
                    modifier: ex.desc.modifier,
                    planes: ex.desc.planes.clone(),
                },
                ex.fds,
            ));
            slots.push(Slot {
                id,
                _tex: tex,
                fbo,
                _image: ex.image,
                busy: false,
                release: None,
            });
        }
        Ok((Ring { slots, w, h }, msgs))
    }

    /// A slot not held by the compositor.
    pub fn free(&self) -> Option<usize> {
        self.slots.iter().position(|s| !s.busy)
    }

    /// The compositor is done with `id` (unknown ids — an older ring's — are ignored).
    pub fn release(&mut self, id: u8, fence: Option<OwnedFd>) {
        if let Some(s) = self.slots.iter_mut().find(|s| s.id == id) {
            s.busy = false;
            s.release = fence;
        }
    }
}
