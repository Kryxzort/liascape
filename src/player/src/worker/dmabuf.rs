//! Compositor side of the scene frame transport (Phase 2 Task 4; `docs/player/spikes/dmabuf.md`
//! §9): [`ImportedRing`] — one worker's exported ring, imported once — and [`Latch`] — which
//! frame to show: **only the newest queued frame whose acquire fence has already signalled**
//! (never an `eglWaitSync` on an unsignalled worker fence: that would queue the compositor's
//! GPU work behind the worker's and let a hung worker stall every output). A frame not ready →
//! the previous one stays, never black, never a block.

use std::collections::VecDeque;
use std::os::fd::{AsRawFd, OwnedFd};

use crate::gfx::dmabuf::{DmabufDesc, ImportedTex};
use crate::gfx::{Gfx, Tex};

/// Refuse a `{fourcc, modifier}` this display can't sample as `GL_TEXTURE_2D`: absent from
/// `table` (`Gfx::dmabuf_modifiers`), or external-only — LINEAR on NVIDIA, which our core
/// context can't sample at all (no `GL_OES_EGL_image_external`). An empty table (no
/// `eglQueryDmaBufModifiersEXT`) can't be checked: the import itself decides.
pub fn validate_modifier(fourcc: u32, modifier: u64, table: &[(u64, bool)]) -> Result<(), String> {
    if table.is_empty() {
        return Ok(());
    }
    let name = String::from_utf8_lossy(&fourcc.to_le_bytes()).into_owned();
    match table.iter().find(|(m, _)| *m == modifier) {
        Some((_, false)) => Ok(()),
        Some((_, true)) => Err(format!(
            "dmabuf {name} modifier {modifier:#018x} is external-only on this display: it can't \
             be sampled as GL_TEXTURE_2D (no GL_OES_EGL_image_external in the core context) — \
             workers must hand over block-linear buffers (docs/player/spikes/dmabuf.md §1)"
        )),
        None => Err(format!(
            "dmabuf {name} modifier {modifier:#018x} is not importable on this display \
             ({} modifiers listed; docs/player/spikes/dmabuf.md §1)",
            table.len()
        )),
    }
}

/// One worker process's ring, imported once per slot (`Buffer` messages). `generation` = the
/// worker generation it belongs to ([`Latch::generation`]).
pub struct ImportedRing {
    pub generation: u32,
    slots: Vec<(u8, ImportedTex)>,
}

impl ImportedRing {
    pub fn new(generation: u32) -> ImportedRing {
        ImportedRing {
            generation,
            slots: Vec::new(),
        }
    }

    /// Validate against `table` and import `slot` (a re-sent slot id replaces the old one).
    pub fn import(
        &mut self,
        gfx: &Gfx,
        slot: u8,
        desc: &DmabufDesc,
        fds: Vec<OwnedFd>,
        table: &[(u64, bool)],
    ) -> Result<(), String> {
        validate_modifier(desc.fourcc, desc.modifier, table)?;
        let t = gfx.import_dmabuf(desc, fds)?;
        self.slots.retain(|(s, _)| *s != slot);
        self.slots.push((slot, t));
        Ok(())
    }

    pub fn tex(&self, slot: u8) -> Option<&Tex> {
        self.slots
            .iter()
            .find(|(s, _)| *s == slot)
            .map(|(_, t)| t.tex())
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

/// A frame the [`Latch`] picked. `acquire` = its (already signalled) fence, for the caller's
/// `gpu_wait_fence` safety net.
#[derive(Debug)]
pub struct Latched {
    pub slot: u8,
    pub seq: u64,
    pub t: f64,
    pub generation: u32,
    pub acquire: Option<OwnedFd>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LatchStats {
    /// Frames latched.
    pub latched: u64,
    /// `latch` calls that found frames queued but none signalled (the previous frame stayed).
    pub stale_reuses: u64,
    /// Queued frames dropped unseen because a newer one was ready first.
    pub superseded: u64,
}

struct Queued {
    slot: u8,
    seq: u64,
    t: f64,
    generation: u32,
    acquire: Option<OwnedFd>,
}

#[derive(Debug, Clone, Copy)]
struct Current {
    slot: u8,
    seq: u64,
    t: f64,
    generation: u32,
    /// From a worker that's gone: never released (the new worker never had that slot).
    foreign: bool,
}

/// Which worker frame is shown. `push` every `Frame`, `latch` once per update, then send
/// `take_releases` back to the worker.
#[derive(Default)]
pub struct Latch {
    queued: VecDeque<Queued>,
    current: Option<Current>,
    releases: Vec<(u8, Option<OwnedFd>)>,
    generation: u32,
    stats: LatchStats,
}

/// A `sync_file` polls readable once it has signalled.
fn signalled(fd: &OwnedFd) -> bool {
    let mut p = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut p, 1, 0) == 1 && p.revents & (libc::POLLIN | libc::POLLERR) != 0 }
}

impl Latch {
    pub fn new() -> Latch {
        Latch::default()
    }

    /// A `Frame {slot, seq, t}` from the current worker, with its acquire fence (`None` =
    /// fdpoll mode: the worker already waited, the frame is complete).
    pub fn push(&mut self, slot: u8, seq: u64, t: f64, acquire: Option<OwnedFd>) {
        self.queued.push_back(Queued {
            slot,
            seq,
            t,
            generation: self.generation,
            acquire,
        });
    }

    /// Latch the newest queued frame whose fence has signalled (no fence = ready). Older
    /// queued frames are released without a fence (never sampled; the worker's own context
    /// orders its next render after them); the previously latched slot is released with
    /// `release_fence()` — created right now, so it orders after every draw that sampled it.
    /// `None` = nothing new (the current frame stays).
    pub fn latch(&mut self, mut release_fence: impl FnMut() -> Option<OwnedFd>) -> Option<Latched> {
        let ready = (0..self.queued.len())
            .rev()
            .find(|&i| self.queued[i].acquire.as_ref().is_none_or(signalled));
        let Some(i) = ready else {
            if !self.queued.is_empty() {
                self.stats.stale_reuses += 1;
            }
            return None;
        };
        for q in self.queued.drain(..i) {
            self.releases.push((q.slot, None));
            self.stats.superseded += 1;
        }
        let q = self.queued.pop_front().expect("the ready frame");
        if let Some(c) = self.current.take()
            && !c.foreign
        {
            self.releases.push((c.slot, release_fence()));
        }
        self.current = Some(Current {
            slot: q.slot,
            seq: q.seq,
            t: q.t,
            generation: q.generation,
            foreign: false,
        });
        self.stats.latched += 1;
        Some(Latched {
            slot: q.slot,
            seq: q.seq,
            t: q.t,
            generation: q.generation,
            acquire: q.acquire,
        })
    }

    /// The worker died and a new one is coming: its queued frames are dropped (nothing to
    /// release to), the current frame stays shown but will never be released, and frames
    /// pushed from now on belong to the next generation.
    pub fn forget_worker(&mut self) {
        self.queued.clear();
        self.releases.clear();
        if let Some(c) = self.current.as_mut() {
            c.foreign = true;
        }
        self.generation += 1;
    }

    /// `(slot, release fence)` to send as `Release` messages.
    pub fn take_releases(&mut self) -> Vec<(u8, Option<OwnedFd>)> {
        std::mem::take(&mut self.releases)
    }

    /// The shown frame: `(slot, seq, t, generation)`.
    pub fn current(&self) -> Option<(u8, u64, f64, u32)> {
        self.current.map(|c| (c.slot, c.seq, c.t, c.generation))
    }

    /// The generation frames are pushed into now.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn queued(&self) -> usize {
        self.queued.len()
    }

    pub fn stats(&self) -> LatchStats {
        self.stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    const AB24: u32 = u32::from_le_bytes(*b"AB24");

    #[test]
    fn external_only_modifier_is_refused() {
        // The spike's NVIDIA table: block-linear sampleable, LINEAR external-only.
        let table = [
            (0x0300_0000_00e0_8014, false),
            (0x0300_0000_0060_6010, false),
            (0, true),
        ];
        let e = validate_modifier(AB24, 0, &table).unwrap_err();
        assert!(e.contains("external-only"), "{e}");
        assert!(e.contains("docs/player/spikes/dmabuf.md §1"), "{e}");
        assert!(e.contains("AB24"), "{e}");
        assert!(validate_modifier(AB24, 0x0300_0000_00e0_8014, &table).is_ok());
        let e = validate_modifier(AB24, 0x1234, &table).unwrap_err();
        assert!(e.contains("not importable"), "{e}");
        // No table (no query extension): the import decides.
        assert!(validate_modifier(AB24, 0, &[]).is_ok());
    }

    /// A pipe as a stand-in fence: readable (signalled) once written to.
    fn fence() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn signal(w: &OwnedFd) {
        assert_eq!(
            unsafe { libc::write(w.as_raw_fd(), b"x".as_ptr().cast(), 1) },
            1
        );
    }

    #[test]
    fn latch_takes_newest_signalled_and_releases_the_rest() {
        let mut l = Latch::new();
        assert!(l.latch(|| None).is_none());
        assert_eq!(
            l.stats().stale_reuses,
            0,
            "nothing queued is not a stale reuse"
        );

        let (r0, w0) = fence();
        l.push(0, 1, 0.0, Some(r0));
        // Unsignalled: nothing latched, never waited for.
        assert!(l.latch(|| None).is_none());
        assert_eq!(l.stats().stale_reuses, 1);
        signal(&w0);
        let got = l.latch(|| None).unwrap();
        assert_eq!((got.slot, got.seq), (0, 1));
        assert!(
            got.acquire.is_some(),
            "the acquire fence comes back for gpu_wait_fence"
        );
        assert!(l.take_releases().is_empty(), "nothing was shown before");

        // Three more: 1 and 2 signalled, 3 not → 2 latched, 1 superseded (no fence),
        // the previous (slot 0) released with a fresh release fence, 3 stays queued.
        let (r1, w1) = fence();
        let (r2, w2) = fence();
        let (r3, _w3) = fence();
        l.push(1, 2, 0.1, Some(r1));
        l.push(2, 3, 0.2, Some(r2));
        l.push(0, 4, 0.3, Some(r3));
        signal(&w1);
        signal(&w2);
        let (rf, _wf) = fence();
        let mut rf = Some(rf);
        let got = l.latch(|| rf.take()).unwrap();
        assert_eq!((got.slot, got.seq), (2, 3));
        let rel = l.take_releases();
        assert_eq!(rel.len(), 2);
        assert_eq!(
            (rel[0].0, rel[0].1.is_some()),
            (1, false),
            "superseded: no fence"
        );
        assert_eq!(
            (rel[1].0, rel[1].1.is_some()),
            (0, true),
            "previous: release fence"
        );
        assert_eq!(l.queued(), 1);
        assert_eq!(l.current().map(|c| c.1), Some(3));
        assert_eq!(l.stats().superseded, 1);
        assert_eq!(l.stats().latched, 2);

        // fdpoll frames (no fence) are ready at once.
        l.push(1, 5, 0.4, None);
        assert_eq!(l.latch(|| None).unwrap().seq, 5);
    }

    #[test]
    fn forget_worker_keeps_the_frame_and_never_releases_it() {
        let mut l = Latch::new();
        l.push(0, 1, 0.0, None);
        l.latch(|| None).unwrap();
        l.push(1, 2, 0.1, None);
        l.forget_worker();
        assert_eq!(l.queued(), 0, "the dead worker's queued frames are gone");
        assert_eq!(l.current().map(|c| (c.1, c.3)), Some((1, 0)), "still shown");
        assert_eq!(l.generation(), 1);
        l.push(0, 3, 0.2, None);
        let got = l
            .latch(|| panic!("no release fence for a foreign slot"))
            .unwrap();
        assert_eq!((got.seq, got.generation), (3, 1));
        assert!(l.take_releases().is_empty());
    }
}
