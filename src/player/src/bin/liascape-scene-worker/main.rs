//! `liascape-scene-worker --fd N --parent-pid P [--stub]` — renders one WE scene for liascape-player in its
//! own process (Phase 2; `.claude/rules/player-core.md` § Scene worker). Spawned by
//! `worker::WorkerHost`, never by hand: fd `N` is its end of a `SOCK_SEQPACKET` socketpair
//! (`worker::proto`), `P` the compositor's pid.
//!
//! First thing: `PR_SET_PDEATHSIG(SIGKILL)`, then `getppid() == P` (the parent may have died
//! before the prctl) — a compositor killed outright never leaves a worker behind. Then a soft
//! `RLIMIT_CORE` of 1 (`skip_core_handler`: a crashing scene never reaches systemd-coredump /
//! a desktop crash popup; `LIASCAPE_SCENE_WORKER_COREDUMP=1` opts out).
//!
//! `--stub` (tests): no GPU, no scene — answers `Hello`/`Ping`/`Tick`, logs each `Start`'s
//! position, scripted by `LIASCAPE_SCENE_WORKER_TEST` (comma-separated): `crash_after_ms:N` (prints
//! `stub: crashing` to stderr, then `abort()`), `hang_after_ms:N` (stops answering),
//! `exit_code:N` (exit with N — at `crash_after_ms` if given, else right after `Hello`),
//! `ignore_quit` (ignores `Quit` and EOF; only SIGKILL ends it), `spam_stderr:N` (N stderr
//! lines after `Hello`), `ring:N` (announce N slots on `Start`, frame each tick into a free one,
//! hold the newest tick while the host has them all — the renderer's slot starvation),
//! `freeze_after_ms:N` + `freeze_ms:M` (N ms after `Hello` stop reading for M ms, then carry on).
//!
//! Without `--stub`: the renderer (Task 4) — a surfaceless EGL context at LOW priority, a
//! 3-slot ring exported as dmabufs (`ring.rs`), one frame per `Tick` into a free slot, an
//! acquire fence (`sync: fence`) or a CPU wait on its own `sync_file` (`sync: fdpoll`, env
//! `LIASCAPE_SCENE_SYNC=fdpoll` or no `EGL_ANDROID_native_fence_sync`). It renders a real WE scene
//! through LWE's core (`render.rs`, feature `lwe` — Task 7) or, in tests, the synthetic pattern
//! (`synthetic.rs`, gated by `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`).
//!
//! Two threads (Task 7): the renderer (this one — GL, the ring, LWE) and `lia-scene-proto`, which
//! reads the socket and hands messages over; while the renderer is inside a load + build (up to
//! seconds for a cold LWE build) the protocol thread answers `Ping`s itself, so a slow load is
//! never read as a hang (bounded: `LIASCAPE_SCENE_LOAD_TIMEOUT_MS`, default 30 s).
//!
//! Task 6 adds a third, `lia-scene-audio` (`audio.rs`; started only once the loaded scene turns
//! out to have a sound — a soundless scene has none): the scene's sound as a PipeWire stream
//! on the player bus — pulled from LWE (or the synthetic tone), time-stretched to the scene's
//! speed (`stretch.rs`), gated and gained in dB. The protocol thread applies `Gain`, `Paused`,
//! `NoAudio`, `Route` and `Speed` to it directly; a quit waits until the stream is silent.
//!
//! `--lwe-smoke <scene dir> --assets <dir> --out <dir> [--seconds S] [--audio-dump S]`
//! (feature `lwe`): a diagnostic outside the protocol — renders a real scene through LWE's core
//! offscreen, writes two PNGs, prints one JSON line (`lwe.rs`); `--audio-dump` also writes its
//! sound and the time stretch's 0.5×/1.5× output as raw F32.

mod audio;
mod gputimer;
#[cfg(feature = "lwe")]
mod lwe;
#[cfg(feature = "lwe")]
mod render;
mod ring;
mod stretch;
mod synthetic;

use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use liascape_player::gfx::{Gfx, OffscreenOpts, Priority};
use liascape_player::scene::cover_size;
use liascape_player::scene::synthetic::{Fail, Pattern, SyntheticSpec, input_level};
use liascape_player::worker::proto::{self, FromWorker, ToWorker};

/// `LIASCAPE_SCENE_WORKER_TEST`'s knobs (also honoured by the synthetic renderer's spec).
#[derive(Debug, Default, Clone)]
struct Knobs {
    crash_after_ms: Option<u64>,
    hang_after_ms: Option<u64>,
    exit_code: Option<i32>,
    ignore_quit: bool,
    spam_stderr: u32,
    /// `ring:N` (stub): announce a ring of N slots on `Start` and frame each tick into a free
    /// one, holding the newest tick while every slot is with the host — the renderer's
    /// slot starvation, without a GPU.
    ring: u8,
    /// `freeze_after_ms:N` + `freeze_ms:M` (stub): N ms after `Hello` stop reading for M ms
    /// (as if blocked in the driver by a GPU-wide stall), then carry on.
    freeze_after_ms: Option<u64>,
    freeze_ms: u64,
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
                "ring" => k.ring = val.parse().unwrap_or(0),
                "freeze_after_ms" => k.freeze_after_ms = val.parse().ok(),
                "freeze_ms" => k.freeze_ms = val.parse().unwrap_or(0),
                other => warn(&format!("unknown LIASCAPE_SCENE_WORKER_TEST knob {other:?}")),
            }
        }
        k
    }
}

fn warn(line: &str) {
    let _ = writeln!(std::io::stderr(), "liascape-scene-worker: {line}");
}

fn usage() -> ! {
    warn("usage: liascape-scene-worker --fd N --parent-pid P [--stub] (spawned by liascape-player)");
    std::process::exit(2)
}

fn main() {
    // a diagnostic, not part of the protocol: render a real scene through LWE's core offscreen
    #[cfg(feature = "lwe")]
    if std::env::args().nth(1).as_deref() == Some("--lwe-smoke") {
        lwe::smoke(&std::env::args().skip(1).collect::<Vec<_>>());
    }
    // `liascape-player scene-check` asks what this build can render.
    if std::env::args().nth(1).as_deref() == Some("--features") {
        let mut f = vec!["stub", "synthetic"];
        if cfg!(feature = "lwe") {
            f.push("lwe");
        }
        println!("{}", serde_json::json!(f));
        std::process::exit(0);
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
    skip_core_handler();
    let sock = unsafe { OwnedFd::from_raw_fd(fd) };
    let knobs = Knobs::parse(&std::env::var("LIASCAPE_SCENE_WORKER_TEST").unwrap_or_default());
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

/// A scene that crashes LWE is an expected, handled event (the host restarts it, then marks it
/// broken with a crash record + log tail) — not a desktop crash alert. Soft `RLIMIT_CORE` 1
/// (never above the hard limit) makes the kernel skip a piped `core_pattern`: no
/// systemd-coredump, no DrKonqi notification per crash (Task 13's corpus: 16 of them for 4
/// broken scenes). `LIASCAPE_SCENE_WORKER_COREDUMP=1` keeps the inherited limit (debugging LWE).
fn skip_core_handler() {
    if std::env::var("LIASCAPE_SCENE_WORKER_COREDUMP").is_ok_and(|v| v == "1") {
        return;
    }
    unsafe {
        let mut cur = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_CORE, &mut cur) == 0 {
            let one = libc::rlimit {
                rlim_cur: 1.min(cur.rlim_max),
                rlim_max: cur.rlim_max,
            };
            libc::setrlimit(libc::RLIMIT_CORE, &one);
        }
    }
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
    // `ring`: (slot id, held by the host); the newest tick waiting for a free slot.
    let mut ring: Vec<(u8, bool)> = Vec::new();
    let mut pending: Option<(u64, f64)> = None;
    let mut freeze_at = k.freeze_after_ms;
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
        if freeze_at.is_some_and(|f| el >= Duration::from_millis(f)) {
            freeze_at = None;
            let _ = writeln!(std::io::stderr(), "stub: frozen for {} ms", k.freeze_ms);
            std::thread::sleep(Duration::from_millis(k.freeze_ms));
        }
        let next = [k.crash_after_ms, k.hang_after_ms, freeze_at]
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
                    ToWorker::Tick { seq, t, .. } if k.ring > 0 => pending = Some((seq, t)),
                    ToWorker::Tick { seq, t, .. } => send(
                        s,
                        &FromWorker::Frame {
                            slot: 0,
                            seq,
                            t,
                            gpu_ms: None,
                        },
                    ),
                    ToWorker::Release { slot } => {
                        if let Some(r) = ring.iter_mut().find(|r| r.0 == slot) {
                            r.1 = false;
                        }
                    }
                    ToWorker::Start { position, .. } => {
                        send(
                            s,
                            &FromWorker::Log {
                                level: "info".into(),
                                line: format!("stub: start position {position}"),
                            },
                        );
                        if ring.is_empty() {
                            for slot in 0..k.ring {
                                ring.push((slot, false));
                                send(
                                    s,
                                    &FromWorker::Buffer {
                                        slot,
                                        w: 64,
                                        h: 64,
                                        fourcc: 0x3432_4241,
                                        modifier: 0,
                                        planes: Vec::new(),
                                    },
                                );
                            }
                        }
                    }
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
        if let (Some((seq, t)), Some(s)) = (pending, sock.as_ref())
            && let Some(r) = ring.iter_mut().find(|r| !r.1)
        {
            r.1 = true;
            pending = None;
            send(
                s,
                &FromWorker::Frame {
                    slot: r.0,
                    seq,
                    t,
                    gpu_ms: None,
                },
            );
        }
    }
}

/// Slots in the ring (spike §2: 3 never stalled below GPU saturation).
const RING_SLOTS: u8 = 3;

/// How long a load + build may take while the reader thread still answers pings for the
/// renderer (`LIASCAPE_SCENE_LOAD_TIMEOUT_MS`). A cold LWE build took up to 2.8 s; past this the
/// pings go to the (stuck) renderer, so the compositor's heartbeat sees a hang.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest a quit waits for an audible stream to fade out (its gate takes 30 ms; a stalled
/// graph never holds the exit for longer).
const QUIT_FADE_MAX: Duration = Duration::from_millis(200);

/// What the protocol (reader) thread knows about the renderer: whether it is inside a load.
struct LoadGate {
    t0: Instant,
    /// ms since `t0` + 1 when the current load started; 0 = not loading.
    since: AtomicU64,
    timeout: Duration,
}

impl LoadGate {
    fn new() -> LoadGate {
        let timeout = std::env::var("LIASCAPE_SCENE_LOAD_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .map_or(LOAD_TIMEOUT, Duration::from_millis);
        LoadGate {
            t0: Instant::now(),
            since: AtomicU64::new(0),
            timeout,
        }
    }

    fn set(&self, loading: bool) {
        let v = if loading {
            self.t0.elapsed().as_millis() as u64 + 1
        } else {
            0
        };
        self.since.store(v, Ordering::SeqCst);
    }

    fn loading(&self) -> bool {
        self.since.load(Ordering::SeqCst) != 0
    }

    /// Loading, and not for longer than the timeout.
    fn covers_ping(&self) -> bool {
        let s = self.since.load(Ordering::SeqCst);
        s != 0 && self.t0.elapsed().as_millis() as u64 + 1 - s < self.timeout.as_millis() as u64
    }
}

type Inbox = mpsc::Receiver<(ToWorker, Vec<OwnedFd>)>;

/// The protocol thread (Task 7): reads the socket, hands messages to the renderer, and while
/// the renderer is inside a load (an LWE build blocks it for up to seconds) answers `Ping`s
/// itself — so the compositor's heartbeat never reads a slow load as a hang, and nothing
/// latches before the first real frame. A `Quit` or EOF during a load ends the process at
/// once (`_exit`: no destructor may run under the half-built scene).
fn reader(
    sock: OwnedFd,
    tx: mpsc::Sender<(ToWorker, Vec<OwnedFd>)>,
    gate: Arc<LoadGate>,
    audio: Arc<audio::Control>,
) {
    // Task 6: the stream's controls apply here, the moment they arrive — never behind a
    // frame being rendered or a load. A quit fades an audible stream out first.
    let quit_now = |audio: &audio::Control| -> ! {
        audio.quit(QUIT_FADE_MAX);
        unsafe { libc::_exit(0) }
    };
    loop {
        wait_readable(sock.as_raw_fd(), None);
        loop {
            match proto::recv::<ToWorker>(sock.as_fd()) {
                Ok(Some((ToWorker::Ping { seq }, _))) if gate.covers_ping() => {
                    send(&sock, &FromWorker::Pong { seq })
                }
                Ok(Some((ToWorker::Quit, _))) if gate.loading() => quit_now(&audio),
                Ok(Some((m, _))) if audio.apply(&m) => {}
                Ok(Some(m)) => {
                    audio.start(&m.0);
                    if tx.send(m).is_err() {
                        quit_now(&audio)
                    }
                }
                Ok(None) => break,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    if gate.loading() || tx.send((ToWorker::Quit, Vec::new())).is_err() {
                        quit_now(&audio)
                    }
                    return;
                }
                Err(e) => warn(&format!("bad message: {e}")),
            }
        }
    }
}

/// The scene being rendered: the synthetic test pattern (D7) or a real WE scene (Task 7).
enum SceneImpl {
    Synthetic(synthetic::Synthetic),
    #[cfg(feature = "lwe")]
    Lwe(render::LweScene),
}

/// The renderer's state between messages.
struct Renderer {
    sock: OwnedFd,
    inbox: Inbox,
    gate: Arc<LoadGate>,
    /// Task 6: the scene's audio stream (its thread starts when a sound is installed).
    audio: Arc<audio::Control>,
    audio_started: bool,
    gfx: Gfx,
    /// `sync: fdpoll` — wait on our own fence before `Frame`, send no fd.
    fdpoll: bool,
    ring: Option<ring::Ring>,
    scene: Option<SceneImpl>,
    /// The newest tick not rendered yet (older ones are answered by its `Frame`).
    pending: Option<(u64, f64)>,
    /// The newest visualiser input not handed to the scene yet.
    input: Option<Vec<u8>>,
    /// The synthetic `input_level` scene's current level.
    level: f32,
    /// The pointer in native scene pixels (y down) + buttons.
    pointer: (f64, f64, u32),
    next_slot_id: u8,
    /// A fatal error was reported: idle until `Quit`.
    dead: bool,
    crash_at: Option<Instant>,
    hang_at: Option<Instant>,
    exit_code: Option<i32>,
    /// The scene's native size (a `resize` re-exports at its cover size).
    native: (u32, u32),
    /// Task 8: `GL_TIME_ELAPSED` per frame, read back later without waiting (`Frame.gpu_ms`).
    timer: gputimer::GpuTimer,
    /// Task 10: the context reports GPU resets (`OffscreenOpts::robust` granted) — polled
    /// after every frame.
    robust: bool,
    /// The synthetic `context_lost_after_ms` (tests): when to act as if the context was lost.
    lost_at: Option<Instant>,
    /// The context is lost (`ContextLost` sent at this instant): nothing renders again; the
    /// compositor kills us (a crash restart) — we exit ourselves after `LOST_EXIT_AFTER`.
    lost: Option<Instant>,
    /// The synthetic `gpu_stall` window (tests): frames in it carry a stand-in acquire fence.
    stall: Option<(Instant, Instant)>,
    /// The stand-ins' write ends: written (signalled) when the window ends.
    stall_fences: Vec<OwnedFd>,
}

/// Task 10: a worker whose context is lost waits this long for the compositor's kill, then
/// exits (code `LOST_EXIT_CODE`) — never a worker idling forever on a dead context.
const LOST_EXIT_AFTER: Duration = Duration::from_secs(5);
const LOST_EXIT_CODE: i32 = 4;

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
        self.audio.remove(); // stop pulling before the scene goes
        self.scene = None;
        self.pending = None;
    }

    fn property_result(&self, name: &str, r: Result<(), String>) {
        if let Err(e) = &r {
            warn(&format!("property {e}"));
        }
        self.send(&FromWorker::PropertySet {
            name: name.to_string(),
            ok: r.is_ok(),
            reason: r.err(),
        });
    }

    fn start(&mut self, s: StartArgs) {
        if s.synthetic {
            return self.start_synthetic(s);
        }
        #[cfg(feature = "lwe")]
        {
            self.start_lwe(s)
        }
        #[cfg(not(feature = "lwe"))]
        self.fatal(format!(
            "can't play {}: liascape-scene-worker was built without LWE (cargo feature `lwe`): only \
             synthetic test scenes can play",
            s.path
        ))
    }

    /// A real scene: load + build with the protocol answered by the reader thread, then the
    /// ring at the cover size, then `Ready`.
    #[cfg(feature = "lwe")]
    fn start_lwe(&mut self, s: StartArgs) {
        let dir = std::path::PathBuf::from(&s.path);
        let assets = s.assets_dir.as_ref().map(std::path::PathBuf::from);
        let steam = s.steam_dir.as_ref().map(std::path::PathBuf::from);
        let opts = render::LoadOpts {
            dir: &dir,
            assets: assets.as_deref(),
            steam_dir: steam.as_deref(),
            properties: &s.properties,
        };
        let t = Instant::now();
        let mut results = Vec::new();
        self.gate.set(true);
        let r = render::LweScene::load(&self.gfx, &opts, |n, r| results.push((n.to_string(), r)));
        self.gate.set(false);
        for (n, r) in results {
            self.property_result(&n, r);
        }
        let scene = match r {
            Ok(sc) => sc,
            Err(e) => return self.fatal(e),
        };
        self.log(format!(
            "lwe: loaded + built {} in {} ms: native {}x{}, audio streams {}, audio input {}",
            s.path,
            t.elapsed().as_millis(),
            scene.native.0,
            scene.native.1,
            scene.has_audio,
            scene.wants_audio_input
        ));
        self.native = scene.native;
        let (w, h) = cover_size(self.native, (s.max_size[0], s.max_size[1]));
        if let Err(e) = self.export(w, h) {
            return self.fatal(format!("export the frame ring: {e}"));
        }
        let ready = FromWorker::Ready {
            native: [scene.native.0, scene.native.1],
            has_audio: scene.has_audio,
            wants_audio_input: scene.wants_audio_input,
        };
        let (x, y, b) = self.pointer;
        scene.set_pointer(x, y, b);
        if scene.has_audio {
            self.install_audio(Box::new(scene.audio_puller()));
        }
        self.scene = Some(SceneImpl::Lwe(scene));
        self.send(&ready);
    }

    fn start_synthetic(&mut self, s: StartArgs) {
        let path = &s.path;
        if std::env::var("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES").as_deref() != Ok("1") {
            return self.fatal(
                "synthetic scenes are test-only: LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 is not set"
                    .into(),
            );
        }
        let file = std::path::Path::new(path).join("liascape-synthetic.json");
        let spec: SyntheticSpec = match std::fs::read(&file)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        {
            Ok(s) => s,
            Err(e) => return self.fatal(format!("synthetic scene {}: {e}", file.display())),
        };
        if spec.load_ms > 0 {
            // A slow "load + build" (Task 7): the reader thread answers pings meanwhile.
            self.gate.set(true);
            std::thread::sleep(Duration::from_millis(spec.load_ms));
            self.gate.set(false);
        }
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
        if let Some(ms) = spec.context_lost_after_ms {
            self.lost_at = Some(now + Duration::from_millis(ms));
        }
        if let Some([after, dur]) = spec.gpu_stall {
            let from = now + Duration::from_millis(after);
            self.stall = Some((from, from + Duration::from_millis(dur)));
        }
        let native = (spec.native[0].max(1), spec.native[1].max(1));
        self.native = native;
        let (w, h) = cover_size(native, (s.max_size[0], s.max_size[1]));
        let ready = FromWorker::Ready {
            native: [native.0, native.1],
            has_audio: spec.has_audio,
            wants_audio_input: spec.pattern == Pattern::InputLevel,
        };
        let spec_audio = (spec.has_audio, spec.tone_hz, spec.tone_dbfs);
        let mut scene = match synthetic::Synthetic::new(&self.gfx, spec) {
            Ok(s) => s,
            Err(e) => return self.fatal(e),
        };
        for (n, v) in &s.properties {
            let r = scene.set_property(n, v);
            self.property_result(n, r);
        }
        if let Err(e) = self.export(w, h) {
            return self.fatal(format!("export the frame ring: {e}"));
        }
        if spec_audio.0 {
            // D7: the synthetic scene's sound is a tone (Task 6).
            self.install_audio(Box::new(audio::Tone::new(spec_audio.1, spec_audio.2)));
        }
        self.scene = Some(SceneImpl::Synthetic(scene));
        self.send(&ready);
    }

    /// The scene has a sound: hand it to the stream, starting the audio thread the first time.
    /// A scene without sound never starts it (no thread, no PipeWire, no idle wake-ups —
    /// `tests/scene.rs::audio_thread_only_for_a_scene_with_sound`).
    fn install_audio(&mut self, src: Box<dyn stretch::Pull>) {
        self.audio.install(src);
        if self.audio_started {
            return;
        }
        self.audio_started = true;
        match self.sock.try_clone() {
            Ok(s) => {
                if let Err(e) = audio::spawn(self.audio.clone(), s) {
                    warn(&format!("start the audio thread: {e}"));
                }
            }
            Err(e) => warn(&format!("dup the socket for audio: {e}")),
        }
    }

    /// Allocate and export a ring of `w`×`h` (fresh slot ids) and send its `buffer`s; it
    /// replaces the current one. The compositor's imports of the old slots keep their memory
    /// (a dmabuf lives while anyone holds it), so the frame it shows stays valid.
    fn export(&mut self, w: u32, h: u32) -> Result<(), String> {
        let (ring, buffers) = ring::Ring::new(&self.gfx, w, h, RING_SLOTS, self.next_slot_id)?;
        self.next_slot_id = self.next_slot_id.wrapping_add(RING_SLOTS);
        for (m, fds) in &buffers {
            let b: Vec<_> = fds.iter().map(|f| f.as_fd()).collect();
            let _ = proto::send(self.sock.as_fd(), m, &b);
        }
        self.ring = Some(ring);
        Ok(())
    }

    /// `resize {max_size}` (Task 5): the largest output showing the scene changed — re-export
    /// the ring at the new cover size (nothing to do if that size is the current one).
    fn resize(&mut self, max_size: [u32; 2]) {
        let Some(r) = self.ring.as_ref() else {
            return; // not started: the restart's/Start's max_size already carries it
        };
        let (w, h) = cover_size(self.native, (max_size[0], max_size[1]));
        if (w, h) == (r.w, r.h) {
            return;
        }
        let from = (r.w, r.h);
        match self.export(w, h) {
            Ok(()) => self.log(format!(
                "resize: ring re-exported {}x{} -> {w}x{h}",
                from.0, from.1
            )),
            Err(e) => self.fatal(format!("re-export the frame ring at {w}x{h}: {e}")),
        }
    }

    fn set_property(&mut self, name: &str, value: &serde_json::Value) {
        let r = match self.scene.as_mut() {
            Some(SceneImpl::Synthetic(s)) => s.set_property(name, value),
            #[cfg(feature = "lwe")]
            Some(SceneImpl::Lwe(s)) => s.set_property(name, value),
            // Before the load: `Start.properties` (folded in by the host) applies it.
            None => return,
        };
        self.property_result(name, r);
    }

    fn on_message(&mut self, m: ToWorker, fds: Vec<OwnedFd>) {
        match m {
            ToWorker::Start {
                path,
                assets_dir,
                steam_dir,
                max_size,
                synthetic,
                properties,
                ..
            } => {
                if self.ring.is_none() && !self.dead {
                    self.start(StartArgs {
                        path,
                        assets_dir,
                        steam_dir,
                        max_size,
                        synthetic,
                        properties,
                    });
                }
            }
            ToWorker::Tick { seq, t, input } if !self.dead => {
                if let Some(v) = input.filter(|v| !v.is_empty()) {
                    self.input = Some(v);
                }
                self.pending = Some((seq, t));
            }
            ToWorker::Release { slot } => {
                if let Some(r) = self.ring.as_mut() {
                    r.release(slot, fds.into_iter().next());
                }
            }
            ToWorker::Pointer { x, y, buttons } => {
                self.pointer = (x, y, buttons);
                #[cfg(feature = "lwe")]
                if let Some(SceneImpl::Lwe(s)) = self.scene.as_ref() {
                    s.set_pointer(x, y, buttons);
                }
            }
            ToWorker::SetProperty { name, value } if !self.dead => self.set_property(&name, &value),
            ToWorker::Ping { seq } => {
                // The reset status is polled after every frame — but a renderer starved of
                // slots (every one with the compositor, e.g. right after a resume) renders
                // none; the heartbeat pings it then, so a purge/reset is still seen here.
                if self.robust
                    && self.lost.is_none()
                    && let Some(st) = self.gfx.reset_status().filter(|st| *st != 0)
                {
                    self.context_lost(&format!("glGetGraphicsResetStatus {st:#x} (idle)"));
                }
                self.send(&FromWorker::Pong { seq })
            }
            ToWorker::Resize { max_size } if !self.dead => self.resize(max_size),
            ToWorker::Quit => self.quit(),
            _ => {}
        }
    }

    /// Fade an audible stream out (≤ 30 ms, bounded), then exit.
    fn quit(&self) -> ! {
        self.audio.quit(QUIT_FADE_MAX);
        std::process::exit(0)
    }

    /// Task 10: the GL context is gone (a GPU reset, an NVIDIA video-memory purge — or the
    /// synthetic knob): report `ContextLost` and render nothing more. The compositor kills
    /// and restarts us through its crash budget; the stream is faded first (bounded).
    fn context_lost(&mut self, why: &str) {
        if self.lost.is_some() {
            return;
        }
        warn(&format!(
            "GL context lost ({why}): asking the compositor for a restart"
        ));
        self.send(&FromWorker::ContextLost);
        self.lost = Some(Instant::now());
        self.pending = None;
        self.audio.quit(QUIT_FADE_MAX);
    }

    /// Render the pending tick into a free slot and hand it over.
    fn render(&mut self) {
        if self.lost.is_some() {
            return;
        }
        let (Some(ring), Some(scene)) = (self.ring.as_mut(), self.scene.as_mut()) else {
            return;
        };
        let Some((seq, t)) = self.pending else {
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
        let input = self.input.take();
        self.timer.begin(&self.gfx.gl);
        let mut report_gpu_ms = None;
        match scene {
            SceneImpl::Synthetic(s) => {
                if let Some(v) = &input {
                    self.level = input_level(v);
                }
                // The pointer comes in native pixels; the dot is drawn in ring pixels.
                let (nw, nh) = (self.native.0.max(1) as f64, self.native.1.max(1) as f64);
                let p = (
                    (self.pointer.0 * w as f64 / nw) as f32,
                    (self.pointer.1 * h as f64 / nh) as f32,
                );
                s.render(&self.gfx, &slot.fbo, w, h, seq, self.level, p);
                report_gpu_ms = s.report_gpu_ms();
            }
            #[cfg(feature = "lwe")]
            SceneImpl::Lwe(s) => {
                if let Some(v) = &input {
                    s.set_input(v);
                }
                s.render(&self.gfx, t, &slot.fbo, w, h);
            }
        }
        self.timer.end(&self.gfx.gl);
        // Task 10: a reset during this frame (robust contexts report it; nothing rendered
        // since can be trusted) — no `Frame`, a restart instead.
        if self.robust
            && let Some(st) = self.gfx.reset_status().filter(|st| *st != 0)
        {
            slot.busy = false;
            return self.context_lost(&format!("glGetGraphicsResetStatus {st:#x}"));
        }
        // The newest finished measurement (an earlier frame's — never waited for); the
        // synthetic `report_gpu_ms` knob (tests) stands in for it.
        let measured = self.timer.poll(&self.gfx.gl);
        slot.busy = true;
        let id = slot.id;
        let frame = FromWorker::Frame {
            slot: id,
            seq,
            t,
            gpu_ms: report_gpu_ms.or(measured),
        };
        match self.gfx.native_fence() {
            Ok(fence) if !self.fdpoll => {
                let stand_in = self.stall_fence(&fence);
                let fd = stand_in.as_ref().unwrap_or(&fence);
                let _ = proto::send(self.sock.as_fd(), &frame, &[fd.as_fd()]);
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

    /// The synthetic `gpu_stall` (tests): inside its window, a frame's acquire fence is a
    /// pipe that becomes readable only when the window ends (the real fence is waited for
    /// first, so the frame is complete whenever the compositor samples it).
    fn stall_fence(&mut self, real: &OwnedFd) -> Option<OwnedFd> {
        let (from, to) = self.stall?;
        let now = Instant::now();
        if now < from || now >= to {
            return None;
        }
        wait_fence_cpu(real, 2000);
        let mut p = [0i32; 2];
        if unsafe { libc::pipe2(p.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return None;
        }
        let (r, w) = unsafe { (OwnedFd::from_raw_fd(p[0]), OwnedFd::from_raw_fd(p[1])) };
        self.stall_fences.push(w);
        Some(r)
    }

    /// The `gpu_stall` window is over: signal every stand-in fence.
    fn end_stall(&mut self) {
        self.stall = None;
        for w in self.stall_fences.drain(..) {
            let _ = unsafe { libc::write(w.as_raw_fd(), b"s".as_ptr().cast(), 1) };
        }
    }

    fn run(mut self) -> ! {
        loop {
            let now = Instant::now();
            if self.stall.is_some_and(|(_, to)| now >= to) {
                self.end_stall();
            }
            if self.crash_at.is_some_and(|t| now >= t) {
                crash(self.exit_code);
            }
            if self.hang_at.is_some_and(|t| now >= t) {
                hang();
            }
            if self.lost_at.is_some_and(|t| now >= t) {
                self.lost_at = None;
                self.context_lost("synthetic context_lost_after_ms");
            }
            let lost_exit = self.lost.map(|t| t + LOST_EXIT_AFTER);
            if lost_exit.is_some_and(|t| now >= t) {
                warn("context lost and not restarted: exiting");
                std::process::exit(LOST_EXIT_CODE);
            }
            let can_render = self.lost.is_none()
                && self.pending.is_some()
                && self.ring.as_ref().is_some_and(|r| r.free().is_some());
            let timeout = if can_render {
                Some(Duration::ZERO)
            } else {
                [
                    self.crash_at,
                    self.hang_at,
                    self.lost_at,
                    lost_exit,
                    self.stall.map(|s| s.1),
                ]
                .into_iter()
                    .flatten()
                    .map(|t| t.saturating_duration_since(now))
                    .min()
            };
            let first = match timeout {
                Some(t) => self.inbox.recv_timeout(t),
                None => self
                    .inbox
                    .recv()
                    .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            };
            match first {
                Ok((m, fds)) => self.on_message(m, fds),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => self.quit(),
            }
            while let Ok((m, fds)) = self.inbox.try_recv() {
                self.on_message(m, fds);
            }
            self.render();
        }
    }
}

/// `Start`'s fields the renderer uses.
struct StartArgs {
    path: String,
    #[cfg_attr(not(feature = "lwe"), allow(dead_code))]
    assets_dir: Option<String>,
    #[cfg_attr(not(feature = "lwe"), allow(dead_code))]
    steam_dir: Option<String>,
    max_size: [u32; 2],
    synthetic: bool,
    properties: serde_json::Map<String, serde_json::Value>,
}

/// The real renderer (Task 4: synthetic; Task 7: LWE).
fn run_renderer(sock: OwnedFd, k: Knobs) -> ! {
    let mut features = vec!["synthetic"];
    if cfg!(feature = "lwe") {
        features.push("lwe");
    }
    let gfx = match Gfx::new_offscreen_with(OffscreenOpts {
        priority: Some(Priority::Low),
        // Task 10: a GPU reset / video-memory purge is reported (→ `ContextLost`, a restart).
        robust: true,
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
        std::env::var("LIASCAPE_SCENE_SYNC").as_deref() == Ok("fdpoll") || !gfx.has_native_fences();
    hello(&sock, &features, if fdpoll { "fdpoll" } else { "fence" });
    let gate = Arc::new(LoadGate::new());
    let audio = Arc::new(audio::Control::default());
    let (tx, inbox) = mpsc::channel();
    let rsock = match sock.try_clone() {
        Ok(s) => s,
        Err(e) => {
            warn(&format!("dup the socket for the reader: {e}"));
            std::process::exit(1)
        }
    };
    {
        let (gate, audio) = (gate.clone(), audio.clone());
        if let Err(e) = std::thread::Builder::new()
            .name("lia-scene-proto".into())
            .spawn(move || reader(rsock, tx, gate, audio))
        {
            warn(&format!("start the protocol thread: {e}"));
            std::process::exit(1)
        }
    }
    let now = Instant::now();
    let r = Renderer {
        sock,
        inbox,
        gate,
        audio,
        audio_started: false,
        gfx,
        fdpoll,
        ring: None,
        scene: None,
        pending: None,
        input: None,
        level: 0.0,
        pointer: (0.0, 0.0, 0),
        next_slot_id: 0,
        dead: false,
        crash_at: k.crash_after_ms.map(|ms| now + Duration::from_millis(ms)),
        hang_at: k.hang_after_ms.map(|ms| now + Duration::from_millis(ms)),
        exit_code: k.exit_code,
        native: (1, 1),
        timer: gputimer::GpuTimer::default(),
        robust: false,
        lost_at: None,
        lost: None,
        stall: None,
        stall_fences: Vec::new(),
    };
    r.log(format!(
        "gfx: context priority requested low, granted {}",
        r.gfx.context_priority().map_or("n/a", |p| p.name())
    ));
    let mut r = r;
    r.robust = r.gfx.loses_context_on_reset() && r.gfx.reset_status().is_some();
    // The strategy query is GL 4.5 / KHR_robustness: an older context flags it — clear that,
    // LWE's own error check must not see ours.
    unsafe {
        use glow::HasContext;
        while r.gfx.gl.get_error() != glow::NO_ERROR {}
    }
    r.log(format!(
        "gfx: robust context {} (a GPU reset or video-memory purge {})",
        if r.robust { "granted" } else { "not available" },
        if r.robust {
            "is reported: ContextLost, a restart"
        } else {
            "goes unnoticed until the worker crashes"
        }
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
