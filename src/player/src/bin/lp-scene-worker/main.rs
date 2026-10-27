//! `lp-scene-worker --fd N --parent-pid P [--stub]` — renders one WE scene for lp-player in its
//! own process (Phase 2; `.claude/rules/player-core.md` § Scene worker). Spawned by
//! `worker::WorkerHost`, never by hand: fd `N` is its end of a `SOCK_SEQPACKET` socketpair
//! (`worker::proto`), `P` the compositor's pid.
//!
//! First thing: `PR_SET_PDEATHSIG(SIGKILL)`, then `getppid() == P` (the parent may have died
//! before the prctl) — a compositor killed outright never leaves a worker behind.
//!
//! `--stub` (tests): no GPU, no scene — answers `Hello`/`Ping`/`Tick`, logs each `Start`'s
//! position, scripted by `LP_SCENE_WORKER_TEST` (comma-separated): `crash_after_ms:N` (prints
//! `stub: crashing` to stderr, then `abort()`), `hang_after_ms:N` (stops answering),
//! `exit_code:N` (exit with N — at `crash_after_ms` if given, else right after `Hello`),
//! `ignore_quit` (ignores `Quit` and EOF; only SIGKILL ends it), `spam_stderr:N` (N stderr
//! lines after `Hello`).
//!
//! Without `--stub`: the renderer (Task 4) — a surfaceless EGL context at LOW priority, a
//! 3-slot ring exported as dmabufs (`ring.rs`), one frame per `Tick` into a free slot, an
//! acquire fence (`sync: fence`) or a CPU wait on its own `sync_file` (`sync: fdpoll`, env
//! `LP_SCENE_SYNC=fdpoll` or no `EGL_ANDROID_native_fence_sync`). Only synthetic scenes so far
//! (`synthetic.rs`, gated by `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1`); LWE is Task 7.
//!
//! `--lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S]` (feature `lwe`): a
//! diagnostic outside the protocol — renders a real scene through LWE's core offscreen, writes
//! two PNGs, prints one JSON line (`lwe.rs`).

#[cfg(feature = "lwe")]
mod lwe;
mod ring;
mod synthetic;

use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use lp_player::gfx::{Gfx, OffscreenOpts, Priority};
use lp_player::scene::cover_size;
use lp_player::scene::synthetic::{Fail, Pattern, SyntheticSpec};
use lp_player::worker::proto::{self, FromWorker, ToWorker};

/// `LP_SCENE_WORKER_TEST`'s knobs (also honoured by the synthetic renderer's spec).
#[derive(Debug, Default, Clone)]
struct Knobs {
    crash_after_ms: Option<u64>,
    hang_after_ms: Option<u64>,
    exit_code: Option<i32>,
    ignore_quit: bool,
    spam_stderr: u32,
}

impl Knobs {
    fn parse(s: &str) -> Knobs {
        let mut k = Knobs::default();
        for item in s.split(',').map(str::trim).filter(|i| !i.is_empty()) {
            let (key, val) = item.split_once(':').unwrap_or((item, ""));
            match key {
                "crash_after_ms" => k.crash_after_ms = val.parse().ok(),
                "hang_after_ms" => k.hang_after_ms = val.parse().ok(),
                "exit_code" => k.exit_code = val.parse().ok(),
                "ignore_quit" => k.ignore_quit = true,
                "spam_stderr" => k.spam_stderr = val.parse().unwrap_or(0),
                other => warn(&format!("unknown LP_SCENE_WORKER_TEST knob {other:?}")),
            }
        }
        k
    }
}

fn warn(line: &str) {
    let _ = writeln!(std::io::stderr(), "lp-scene-worker: {line}");
}

fn usage() -> ! {
    warn("usage: lp-scene-worker --fd N --parent-pid P [--stub] (spawned by lp-player)");
    std::process::exit(2)
}

fn main() {
    // a diagnostic, not part of the protocol: render a real scene through LWE's core offscreen
    #[cfg(feature = "lwe")]
    if std::env::args().nth(1).as_deref() == Some("--lwe-smoke") {
        lwe::smoke(&std::env::args().skip(1).collect::<Vec<_>>());
    }
    let mut fd: Option<i32> = None;
    let mut parent: Option<i32> = None;
    let mut stub = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--fd" => fd = args.next().and_then(|v| v.parse().ok()),
            "--parent-pid" => parent = args.next().and_then(|v| v.parse().ok()),
            "--stub" => stub = true,
            _ => usage(),
        }
    }
    let (Some(fd), Some(parent)) = (fd, parent) else {
        usage()
    };
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        if libc::getppid() != parent {
            warn(&format!("parent {parent} is already gone"));
            std::process::exit(3);
        }
        // Nothing this process starts (LWE's helpers) may hold the socket: EOF is the crash
        // signal the compositor relies on.
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let sock = unsafe { OwnedFd::from_raw_fd(fd) };
    let knobs = Knobs::parse(&std::env::var("LP_SCENE_WORKER_TEST").unwrap_or_default());
    if stub {
        run_stub(sock, knobs)
    }
    run_renderer(sock, knobs)
}

fn send(sock: &OwnedFd, m: &FromWorker) {
    let _ = proto::send(sock.as_fd(), m, &[]);
}

fn hello(sock: &OwnedFd, features: &[&str], sync: &str) {
    send(
        sock,
        &FromWorker::Hello {
            protocol: proto::PROTOCOL,
            pid: std::process::id(),
            features: features.iter().map(|f| f.to_string()).collect(),
            sync: sync.into(),
        },
    );
}

/// `abort()` (SIGABRT, no core: `RLIMIT_CORE` 1 skips a piped `core_pattern` — no
/// systemd-coredump, no desktop crash popup), or `exit(code)`.
fn crash(code: Option<i32>) -> ! {
    match code {
        Some(c) => {
            let _ = writeln!(std::io::stderr(), "stub: exiting with code {c}");
            std::process::exit(c)
        }
        None => {
            let _ = writeln!(std::io::stderr(), "stub: crashing");
            unsafe {
                let one = libc::rlimit {
                    rlim_cur: 1,
                    rlim_max: 1,
                };
                libc::setrlimit(libc::RLIMIT_CORE, &one);
            }
            std::process::abort()
        }
    }
}

fn hang() -> ! {
    let _ = writeln!(std::io::stderr(), "stub: hanging");
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Poll `fd` for input until `timeout` (`None` = forever). EINTR counts as a wake.
fn wait_readable(fd: i32, timeout: Option<Duration>) {
    let mut p = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = timeout.map_or(-1, |t| t.as_millis().min(i32::MAX as u128) as i32);
    unsafe { libc::poll(&mut p, 1, ms) };
}

fn run_stub(sock: OwnedFd, k: Knobs) -> ! {
    hello(&sock, &["stub"], "none");
    {
        let mut err = std::io::stderr().lock();
        for i in 0..k.spam_stderr {
            let _ = writeln!(err, "stub: spam line {i}");
        }
    }
    if k.crash_after_ms.is_none()
        && let Some(c) = k.exit_code
    {
        crash(Some(c));
    }
    let t0 = Instant::now();
    let mut sock = Some(sock);
    loop {
        let el = t0.elapsed();
        if k.crash_after_ms
            .is_some_and(|c| el >= Duration::from_millis(c))
        {
            crash(k.exit_code);
        }
        if k.hang_after_ms
            .is_some_and(|h| el >= Duration::from_millis(h))
        {
            hang();
        }
        let next = [k.crash_after_ms, k.hang_after_ms]
            .into_iter()
            .flatten()
            .map(|ms| Duration::from_millis(ms).saturating_sub(el))
            .min();
        let Some(s) = sock.as_ref() else {
            // EOF with ignore_quit: nothing to read any more, only the knobs' deadlines.
            std::thread::sleep(next.unwrap_or(Duration::from_secs(3600)));
            continue;
        };
        wait_readable(s.as_raw_fd(), next);
        loop {
            match proto::recv::<ToWorker>(s.as_fd()) {
                Ok(Some((m, _fds))) => match m {
                    ToWorker::Ping { seq } => send(s, &FromWorker::Pong { seq }),
                    ToWorker::Tick { seq, t, .. } => send(
                        s,
                        &FromWorker::Frame {
                            slot: 0,
                            seq,
                            t,
                            gpu_ms: None,
                        },
                    ),
                    ToWorker::Start { position, .. } => send(
                        s,
                        &FromWorker::Log {
                            level: "info".into(),
                            line: format!("stub: start position {position}"),
                        },
                    ),
                    ToWorker::Quit if !k.ignore_quit => std::process::exit(0),
                    _ => {}
                },
                Ok(None) => break,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    if !k.ignore_quit {
                        std::process::exit(0);
                    }
                    sock = None;
                    break;
                }
                Err(e) => warn(&format!("bad message: {e}")),
            }
        }
    }
}

/// Slots in the ring (spike §2: 3 never stalled below GPU saturation).
const RING_SLOTS: u8 = 3;

/// The renderer's state between messages.
struct Renderer {
    sock: OwnedFd,
    gfx: Gfx,
    /// `sync: fdpoll` — wait on our own fence before `Frame`, send no fd.
    fdpoll: bool,
    ring: Option<ring::Ring>,
    scene: Option<synthetic::Synthetic>,
    /// The newest tick not rendered yet (older ones are answered by its `Frame`).
    pending: Option<(u64, f64, f32)>,
    pointer: (f32, f32),
    next_slot_id: u8,
    /// A fatal error was reported: idle until `Quit`.
    dead: bool,
    crash_at: Option<Instant>,
    hang_at: Option<Instant>,
    exit_code: Option<i32>,
    resize_noted: bool,
}

/// `poll` a `sync_file` until it signals (bounded; a kernel wait, never a spin).
fn wait_fence_cpu(fd: &OwnedFd, ms: i32) {
    let mut p = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut p, 1, ms) };
}

impl Renderer {
    fn send(&self, m: &FromWorker) {
        send(&self.sock, m);
    }

    fn log(&self, line: String) {
        self.send(&FromWorker::Log {
            level: "info".into(),
            line,
        });
    }

    /// Report a fatal error and idle until `Quit` (the caller stops us: never a crash loop,
    /// never a crash record).
    fn fatal(&mut self, reason: String) {
        warn(&reason);
        self.send(&FromWorker::Error {
            reason,
            fatal: true,
        });
        self.dead = true;
        self.ring = None;
        self.scene = None;
        self.pending = None;
    }

    fn start(&mut self, path: &str, max_size: [u32; 2], synthetic: bool) {
        if !synthetic {
            let why = if cfg!(feature = "lwe") {
                "the LWE renderer is not wired into lp-scene-worker yet (Phase 2 Task 7)"
            } else {
                "lp-scene-worker was built without LWE (cargo feature `lwe`): only synthetic \
                 test scenes can play"
            };
            return self.fatal(format!("can't play {path}: {why}"));
        }
        if std::env::var("LP_PLAYER_ALLOW_SYNTHETIC_SCENES").as_deref() != Ok("1") {
            return self.fatal(
                "synthetic scenes are test-only: LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1 is not set"
                    .into(),
            );
        }
        let file = std::path::Path::new(path).join("lp-synthetic.json");
        let spec: SyntheticSpec = match std::fs::read(&file)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        {
            Ok(s) => s,
            Err(e) => return self.fatal(format!("synthetic scene {}: {e}", file.display())),
        };
        if spec.fail == Some(Fail::Load) {
            return self.fatal(format!("synthetic scene {path}: load failed (fail: load)"));
        }
        let now = Instant::now();
        if let Some(ms) = spec.crash_after_ms {
            self.crash_at = Some(now + Duration::from_millis(ms));
        }
        if let Some(ms) = spec.hang_after_ms {
            self.hang_at = Some(now + Duration::from_millis(ms));
        }
        let native = (spec.native[0].max(1), spec.native[1].max(1));
        let (w, h) = cover_size(native, (max_size[0], max_size[1]));
        let ready = FromWorker::Ready {
            native: [native.0, native.1],
            has_audio: spec.has_audio,
            wants_audio_input: spec.pattern == Pattern::InputLevel,
        };
        let scene = match synthetic::Synthetic::new(&self.gfx, spec) {
            Ok(s) => s,
            Err(e) => return self.fatal(e),
        };
        let (ring, buffers) = match ring::Ring::new(&self.gfx, w, h, RING_SLOTS, self.next_slot_id)
        {
            Ok(r) => r,
            Err(e) => return self.fatal(format!("export the frame ring: {e}")),
        };
        self.next_slot_id = self.next_slot_id.wrapping_add(RING_SLOTS);
        for (m, fds) in &buffers {
            let b: Vec<_> = fds.iter().map(|f| f.as_fd()).collect();
            let _ = proto::send(self.sock.as_fd(), m, &b);
        }
        self.ring = Some(ring);
        self.scene = Some(scene);
        self.send(&ready);
    }

    fn on_message(&mut self, m: ToWorker, fds: Vec<OwnedFd>) {
        match m {
            ToWorker::Start {
                path,
                max_size,
                synthetic,
                ..
            } => {
                if self.ring.is_none() && !self.dead {
                    self.start(&path, max_size, synthetic);
                }
            }
            ToWorker::Tick { seq, t, input } if !self.dead => {
                let level = input.filter(|v| !v.is_empty()).map_or(0.0, |v| {
                    v.iter().map(|&b| b as f32).sum::<f32>() / v.len() as f32 / 255.0
                });
                self.pending = Some((seq, t, level));
            }
            ToWorker::Release { slot } => {
                if let Some(r) = self.ring.as_mut() {
                    r.release(slot, fds.into_iter().next());
                }
            }
            ToWorker::Pointer { x, y, .. } => self.pointer = (x as f32, y as f32),
            ToWorker::Ping { seq } => self.send(&FromWorker::Pong { seq }),
            ToWorker::Resize { .. } if !self.resize_noted => {
                self.resize_noted = true;
                self.log(
                    "resize: ring re-export arrives with Phase 2 Task 5; keeping the size".into(),
                );
            }
            ToWorker::Quit => std::process::exit(0),
            _ => {}
        }
    }

    /// Render the pending tick into a free slot and hand it over.
    fn render(&mut self) {
        let (Some(ring), Some(scene)) = (self.ring.as_mut(), self.scene.as_ref()) else {
            return;
        };
        let Some((seq, t, level)) = self.pending else {
            return;
        };
        let Some(i) = ring.free() else {
            return; // all slots with the compositor: wait for a Release
        };
        self.pending = None;
        let (w, h) = (ring.w, ring.h);
        let slot = &mut ring.slots[i];
        if let Some(fence) = slot.release.take() {
            if self.fdpoll {
                wait_fence_cpu(&fence, 1000);
            } else if let Err(e) = self.gfx.gpu_wait_fence(fence) {
                warn(&format!("release fence: {e}"));
            }
        }
        scene.render(&self.gfx, &slot.fbo, w, h, seq, level, self.pointer);
        slot.busy = true;
        let id = slot.id;
        let frame = FromWorker::Frame {
            slot: id,
            seq,
            t,
            gpu_ms: None,
        };
        match self.gfx.native_fence() {
            Ok(fence) if !self.fdpoll => {
                let _ = proto::send(self.sock.as_fd(), &frame, &[fence.as_fd()]);
            }
            Ok(fence) => {
                wait_fence_cpu(&fence, 2000);
                self.send(&frame);
            }
            Err(e) => {
                // No sync_file: wait in GL instead (bounded) — never glFinish.
                unsafe {
                    use glow::HasContext;
                    if let Ok(s) = self.gfx.gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0) {
                        self.gfx.gl.client_wait_sync(
                            s,
                            glow::SYNC_FLUSH_COMMANDS_BIT,
                            1_000_000_000,
                        );
                        self.gfx.gl.delete_sync(s);
                    }
                }
                if !self.fdpoll {
                    warn(&format!("native fence: {e}"));
                }
                self.send(&frame);
            }
        }
    }

    fn run(mut self) -> ! {
        loop {
            let now = Instant::now();
            if self.crash_at.is_some_and(|t| now >= t) {
                crash(self.exit_code);
            }
            if self.hang_at.is_some_and(|t| now >= t) {
                hang();
            }
            let can_render =
                self.pending.is_some() && self.ring.as_ref().is_some_and(|r| r.free().is_some());
            let timeout = if can_render {
                Some(Duration::ZERO)
            } else {
                [self.crash_at, self.hang_at]
                    .into_iter()
                    .flatten()
                    .map(|t| t.saturating_duration_since(now))
                    .min()
            };
            wait_readable(self.sock.as_raw_fd(), timeout);
            loop {
                match proto::recv::<ToWorker>(self.sock.as_fd()) {
                    Ok(Some((m, fds))) => self.on_message(m, fds),
                    Ok(None) => break,
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        std::process::exit(0)
                    }
                    Err(e) => warn(&format!("bad message: {e}")),
                }
            }
            self.render();
        }
    }
}

/// The real renderer (Task 4: synthetic; Task 7: LWE).
fn run_renderer(sock: OwnedFd, k: Knobs) -> ! {
    let mut features = vec!["synthetic"];
    if cfg!(feature = "lwe") {
        features.push("lwe");
    }
    let gfx = match Gfx::new_offscreen_with(OffscreenOpts {
        priority: Some(Priority::Low),
    }) {
        Ok(g) => g,
        Err(e) => {
            hello(&sock, &features, "none");
            let reason = format!("scene worker: no GPU context ({e})");
            warn(&reason);
            send(
                &sock,
                &FromWorker::Error {
                    reason,
                    fatal: true,
                },
            );
            idle_until_quit(&sock)
        }
    };
    let fdpoll =
        std::env::var("LP_SCENE_SYNC").as_deref() == Ok("fdpoll") || !gfx.has_native_fences();
    hello(&sock, &features, if fdpoll { "fdpoll" } else { "fence" });
    let now = Instant::now();
    let r = Renderer {
        sock,
        gfx,
        fdpoll,
        ring: None,
        scene: None,
        pending: None,
        pointer: (0.0, 0.0),
        next_slot_id: 0,
        dead: false,
        crash_at: k.crash_after_ms.map(|ms| now + Duration::from_millis(ms)),
        hang_at: k.hang_after_ms.map(|ms| now + Duration::from_millis(ms)),
        exit_code: k.exit_code,
        resize_noted: false,
    };
    r.log(format!(
        "gfx: context priority requested low, granted {}",
        r.gfx.context_priority().map_or("n/a", |p| p.name())
    ));
    r.run()
}

fn idle_until_quit(sock: &OwnedFd) -> ! {
    loop {
        wait_readable(sock.as_raw_fd(), None);
        loop {
            match proto::recv::<ToWorker>(sock.as_fd()) {
                Ok(Some((ToWorker::Quit, _))) => std::process::exit(0),
                Ok(Some((ToWorker::Ping { seq }, _))) => send(sock, &FromWorker::Pong { seq }),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => std::process::exit(0),
                Err(_) => {}
            }
        }
    }
}
