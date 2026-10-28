//! The worker's GPU time per frame (Phase 2 Task 8, the GPU budget's input): one
//! `GL_TIME_ELAPSED` query around each frame's rendering (scene + blit into the slot), read
//! back once the driver says its result is available — normally a frame or two later — and
//! **never waited on** (`QUERY_RESULT_AVAILABLE` first; a query not done yet stays queued).
//! At most [`MAX_QUERIES`] are in flight: when all are, that frame goes untimed rather than
//! stalling. A driver that refuses queries turns the timer off for good (`gpu_ms` stays
//! `None`, the budget then never throttles — see `scene::budget`).

use std::collections::VecDeque;

use glow::HasContext;

/// Queries in flight at most (a GPU 3–4 frames behind still gets every other frame timed).
pub const MAX_QUERIES: usize = 4;

#[derive(Default)]
pub struct GpuTimer {
    free: Vec<glow::Query>,
    pending: VecDeque<glow::Query>,
    active: Option<glow::Query>,
    off: bool,
}

impl GpuTimer {
    /// Start timing this frame's GL work (no-op when every query is still in flight).
    pub fn begin(&mut self, gl: &glow::Context) {
        if self.off || self.active.is_some() {
            return;
        }
        let q = match self.free.pop() {
            Some(q) => q,
            None if self.pending.len() < MAX_QUERIES => match unsafe { gl.create_query() } {
                Ok(q) => q,
                Err(_) => {
                    self.off = true;
                    return;
                }
            },
            None => return,
        };
        unsafe { gl.begin_query(glow::TIME_ELAPSED, q) };
        self.active = Some(q);
    }

    /// Stop timing this frame (its result is read by a later [`poll`](Self::poll)).
    pub fn end(&mut self, gl: &glow::Context) {
        if let Some(q) = self.active.take() {
            unsafe { gl.end_query(glow::TIME_ELAPSED) };
            self.pending.push_back(q);
        }
    }

    /// The newest measurement (ms) that finished since the last call, oldest queries first,
    /// without waiting; `None` = none finished.
    pub fn poll(&mut self, gl: &glow::Context) -> Option<f32> {
        let mut latest = None;
        while let Some(&q) = self.pending.front() {
            let ready = unsafe { gl.get_query_parameter_u32(q, glow::QUERY_RESULT_AVAILABLE) };
            if ready == 0 {
                break;
            }
            let ns = unsafe { gl.get_query_parameter_u64(q, glow::QUERY_RESULT) };
            self.pending.pop_front();
            self.free.push(q);
            latest = Some(ns as f32 / 1e6);
        }
        latest
    }
}
