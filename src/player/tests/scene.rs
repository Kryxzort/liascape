//! dmabuf scene-frame transport (Phase 2 Task 4; `.claude/rules/player-core.md` § Scene
//! worker → "Frame transport"; evidence `docs/player/spikes/dmabuf.md`). GPU: each test
//! drives a [`SceneSource`] whose `lp-scene-worker` renders `lp-synthetic.json` (D7) into a
//! 3-slot ring of exported `GL_RGBA8` textures; the source imports them once and latches
//! only frames whose acquire fence already signalled. SKIP without EGL (`LP_REQUIRE_GPU=1`
//! fails instead). One test at a time (`GPU`): their frame-rate and timing assertions must
//! not compete with each other for the GPU.

mod common;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use glow::HasContext;
use lp_player::gfx::{Gfx, Tex};
use lp_player::scene::synthetic::{MARKER, PROBE, Pattern, SyntheticSpec, grad_rgb, marker_rgb};
use lp_player::sources::Source;
use lp_player::sources::scene::{SceneOpts, SceneSource};
use lp_player::worker::RestartBudget;

static GPU: Mutex<()> = Mutex::new(());

fn gpu_lock() -> std::sync::MutexGuard<'static, ()> {
    GPU.lock().unwrap_or_else(|e| e.into_inner())
}

fn crash_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lp-scene-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn spec(pattern: Pattern) -> SyntheticSpec {
    SyntheticSpec {
        pattern,
        native: [1920, 1080],
        ..SyntheticSpec::default()
    }
}

/// A synthetic scene source ticking at 144 Hz into a 1920×1080 demand.
fn open(gfx: &Gfx, name: &str, s: &SyntheticSpec) -> SceneSource {
    open_with(gfx, name, s, |_| {})
}

fn open_with(
    gfx: &Gfx,
    name: &str,
    s: &SyntheticSpec,
    tweak: impl FnOnce(&mut SceneOpts),
) -> SceneSource {
    let dir = common::synthetic_scene(name, s);
    let mut o = SceneOpts::new(dir, env!("CARGO_BIN_EXE_lp-scene-worker"));
    o.synthetic = true;
    o.tick_hz = 144.0;
    o.max_size = [1920, 1080];
    o.env = vec![("LP_PLAYER_ALLOW_SYNTHETIC_SCENES".into(), "1".into())];
    o.crash_dir = crash_dir(name);
    tweak(&mut o);
    SceneSource::open_opts(gfx, o).expect("open the scene source")
}

/// Run `update` (waiting ≤ 1 ms on the wake fd between calls) until `f` says stop or
/// `limit` passes; `f` gets the source and whether its texture changed. Returns whether
/// `f` stopped it.
fn run(
    gfx: &Gfx,
    src: &mut SceneSource,
    limit: Duration,
    mut f: impl FnMut(&mut SceneSource, bool) -> bool,
) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        let mut p = libc::pollfd {
            fd: src.wake_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut p, 1, 1) };
        let changed = src.update(gfx);
        assert!(src.error().is_none(), "scene error: {:?}", src.error());
        if f(src, changed) {
            return true;
        }
    }
    false
}

/// Read a `w`×`h` RGBA block at GL `(x, y)` (bottom-left origin = image top, R25).
fn read_block(gfx: &Gfx, tex: &Tex, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut px = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let fbo = gfx.fbo(tex);
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
        gfx.gl.read_pixels(
            x as i32,
            y as i32,
            w as i32,
            h as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(&mut px)),
        );
        gfx.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gfx.gl.delete_framebuffer(fbo.id);
    }
    px
}

/// The latched texture shows exactly frame `seq`: its top-left marker and its far-corner
/// gradient probe (a torn or stale frame fails one of them).
fn check_frame(gfx: &Gfx, tex: &Tex, seq: u64) -> Result<(), String> {
    let c = read_block(gfx, tex, MARKER / 2, MARKER / 2, 1, 1);
    let want = marker_rgb(seq);
    if c[..3] != want {
        return Err(format!("frame {seq}: marker {:?}, want {want:?}", &c[..3]));
    }
    let (x0, y0) = (tex.w - PROBE, tex.h - PROBE);
    let px = read_block(gfx, tex, x0, y0, PROBE, PROBE);
    for ly in 0..PROBE {
        for lx in 0..PROBE {
            let i = ((ly * PROBE + lx) * 4) as usize;
            let want = grad_rgb(lx, ly, seq);
            if px[i..i + 3] != want || px[i + 3] != 255 {
                return Err(format!(
                    "frame {seq}: probe ({lx},{ly}) = {:?}, want {want:?}+255",
                    &px[i..i + 4]
                ));
            }
        }
    }
    Ok(())
}

/// Latch `frames` frames, checking every one; returns the latched seqs.
fn transport_run(gfx: &Gfx, src: &mut SceneSource, frames: u64) -> Vec<u64> {
    let mut seqs = Vec::new();
    let mut errors = Vec::new();
    run(gfx, src, Duration::from_secs(20), |s, changed| {
        if changed {
            let seq = s.latched_seq().expect("a latched frame");
            if let Err(e) = check_frame(gfx, s.texture().unwrap(), seq) {
                errors.push(e);
            }
            seqs.push(seq);
        }
        s.stats().ticks_sent >= frames && seqs.last().is_some_and(|l| *l + 1 >= frames)
    });
    assert!(
        errors.is_empty(),
        "{} bad frames: {:?}",
        errors.len(),
        &errors[..errors.len().min(5)]
    );
    assert!(
        seqs.windows(2).all(|w| w[1] > w[0]),
        "latched seqs must strictly increase: {seqs:?}"
    );
    seqs
}

#[test]
fn transport_never_shows_stale_torn_or_out_of_order() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut src = open(&gfx, "transport", &spec(Pattern::FrameIndex));
    let seqs = transport_run(&gfx, &mut src, 600);
    let st = src.stats();
    println!(
        "transport: {} latched of {} ticks, stats {st:?}",
        seqs.len(),
        st.ticks_sent
    );
    assert!(
        seqs.len() >= 590,
        "only {} of 600 frames latched",
        seqs.len()
    );
    assert_eq!(src.sync(), Some("fence"), "fence mode by default");
    assert_eq!(src.size(), Some((1920, 1080)));
}

#[test]
fn latch_never_waits_on_an_unsignalled_fence() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut s = spec(Pattern::FrameIndex);
    s.gpu_work = 4000; // the spike's saturation load: ~6 ms of GPU per 1080p frame
    let mut src = open(&gfx, "gpuload", &s);
    // Warm up until frames flow.
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 10));
    let mut costs = Vec::new();
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(2) {
        let mut p = libc::pollfd {
            fd: src.wake_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut p, 1, 1) };
        let t0 = Instant::now();
        src.update(&gfx);
        costs.push(t0.elapsed());
    }
    costs.sort();
    let p99 = costs[costs.len() * 99 / 100];
    let max = *costs.last().unwrap();
    let st = src.stats();
    println!(
        "gpu load: {} updates, p50 {:?} p99 {p99:?} max {max:?}; stats {st:?}",
        costs.len(),
        costs[costs.len() / 2]
    );
    assert!(st.stale_reuses > 0, "the GPU was never behind? {st:?}");
    assert!(p99 <= Duration::from_millis(1), "update p99 {p99:?}");
    // Waiting on a worker fence would cost a frame's GPU time (~6 ms) — never anything near.
    assert!(max < Duration::from_millis(4), "update max {max:?}");
}

#[test]
fn killed_worker_keeps_last_frame() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut src = open_with(&gfx, "killed", &spec(Pattern::FrameIndex), |o| {
        o.budget = RestartBudget {
            window: Duration::from_secs(60),
            max: 0,
        };
    });
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 30));
    let pid = src.pid().unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    // Let anything in flight land first (a frame whose fence was pending may still latch).
    run(&gfx, &mut src, Duration::from_millis(200), |_, _| false);
    let tex_id = src.texture().expect("a held texture").id;
    let seq = src.latched_seq().unwrap();
    let held = read_block(&gfx, src.texture().unwrap(), 0, 0, 64, 64);
    check_frame(&gfx, src.texture().unwrap(), seq).unwrap();
    for _ in 0..20 {
        run(&gfx, &mut src, Duration::from_millis(100), |_, _| false);
        let tex = src.texture().expect("the texture never goes away");
        assert_eq!(tex.id, tex_id);
        assert_eq!(
            read_block(&gfx, tex, 0, 0, 64, 64),
            held,
            "the held frame changed"
        );
        check_frame(&gfx, tex, seq).unwrap();
    }
    assert!(src.pid().is_none(), "no restart with a zero budget");
}

#[test]
fn restart_replaces_ring_after_first_new_frame() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut src = open(&gfx, "restart", &spec(Pattern::FrameIndex));
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 30));
    let pid = src.pid().unwrap();
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    run(&gfx, &mut src, Duration::from_millis(50), |_, _| false);
    let old_id = src.texture().unwrap().id;
    let old_seq = src.latched_seq().unwrap();
    let old_gen = src.stats().latched_gen;
    let held = read_block(&gfx, src.texture().unwrap(), 0, 0, 64, 64);
    let mut held_checks = 0;
    let swapped = run(&gfx, &mut src, Duration::from_secs(10), |s, _| {
        let tex = s.texture().expect("never without a texture");
        if s.stats().latched_gen == old_gen {
            // Still the dead worker's frame: same texture, same pixels.
            assert_eq!(tex.id, old_id);
            assert_eq!(read_block(&gfx, tex, 0, 0, 64, 64), held);
            assert!(s.stats().rings <= 2, "{:?}", s.stats());
            held_checks += 1;
            false
        } else {
            true
        }
    });
    assert!(swapped, "no frame from the restarted worker within 10 s");
    assert!(held_checks > 0);
    let st = src.stats();
    assert_ne!(src.texture().unwrap().id, old_id, "the new ring's texture");
    assert_eq!(
        st.rings, 1,
        "the old ring is dropped at the first new latch: {st:?}"
    );
    assert_eq!(st.restarts, 1);
    let seq = src.latched_seq().unwrap();
    assert!(
        seq > old_seq,
        "seqs continue across the restart ({old_seq} → {seq})"
    );
    check_frame(&gfx, src.texture().unwrap(), seq).unwrap();
    assert_ne!(src.pid(), Some(pid));
}

#[test]
fn fdpoll_fallback_is_equally_correct() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut src = open_with(&gfx, "fdpoll", &spec(Pattern::FrameIndex), |o| {
        o.env.push(("LP_SCENE_SYNC".into(), "fdpoll".into()));
    });
    let seqs = transport_run(&gfx, &mut src, 300);
    assert_eq!(src.sync(), Some("fdpoll"));
    assert!(
        seqs.len() >= 295,
        "only {} of 300 frames latched",
        seqs.len()
    );
}

#[test]
fn scene_texture_holds_image_top_at_t0() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut s = spec(Pattern::SplitTb);
    s.rgb = [255, 0, 0];
    s.rgb2 = [0, 0, 255];
    let mut src = open(&gfx, "split", &s);
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 2));
    let tex = src.texture().unwrap();
    // R25: image top at texture row 0 = GL's low y — no flip in the worker.
    assert_eq!(read_block(&gfx, tex, 960, 10, 1, 1), vec![255, 0, 0, 255]);
    assert_eq!(read_block(&gfx, tex, 960, 1070, 1, 1), vec![0, 0, 255, 255]);
}

#[test]
fn scene_frame_is_opaque() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut s = spec(Pattern::Solid);
    s.rgb = [10, 200, 30];
    s.alpha = 0.0; // like every LWE core pixel
    let mut src = open(&gfx, "opaque", &s);
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 2));
    assert_eq!(
        read_block(&gfx, src.texture().unwrap(), 100, 100, 1, 1),
        vec![10, 200, 30, 255]
    );
}

#[test]
fn huge_native_scene_exports_at_cover_size() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut s = spec(Pattern::FrameIndex);
    s.native = [7467, 4200];
    let mut src = open(&gfx, "huge", &s);
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 2));
    assert_eq!(src.size(), Some((1920, 1080)));
    assert_eq!(src.native(), Some([7467, 4200]));
    let t = src.texture().unwrap();
    assert_eq!((t.w, t.h), (1920, 1080));
    check_frame(&gfx, t, src.latched_seq().unwrap()).unwrap();
}

#[test]
fn four_workers_latch_independently() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    // One worker's update cost per loop iteration, then four's.
    let per_iter = |srcs: &mut Vec<SceneSource>, frames: u64| -> (Duration, Vec<Vec<u64>>) {
        let mut seqs = vec![Vec::new(); srcs.len()];
        let mut spent = Duration::ZERO;
        let mut iters = 0u32;
        let end = Instant::now() + Duration::from_secs(20);
        // Warm up: every source has frames flowing.
        while Instant::now() < end && srcs.iter().any(|s| s.stats().latched < 5) {
            std::thread::sleep(Duration::from_millis(1));
            for s in srcs.iter_mut() {
                s.update(&gfx);
            }
        }
        let base: Vec<u64> = srcs.iter().map(|s| s.stats().latched).collect();
        while Instant::now() < end
            && srcs
                .iter()
                .zip(&base)
                .any(|(s, b)| s.stats().latched - b < frames)
        {
            std::thread::sleep(Duration::from_millis(1));
            let t = Instant::now();
            let changed: Vec<bool> = srcs.iter_mut().map(|s| s.update(&gfx)).collect();
            spent += t.elapsed();
            iters += 1;
            for (i, c) in changed.into_iter().enumerate() {
                if c {
                    let s = &srcs[i];
                    let seq = s.latched_seq().unwrap();
                    check_frame(&gfx, s.texture().unwrap(), seq).unwrap();
                    seqs[i].push(seq);
                }
                assert!(srcs[i].error().is_none(), "{:?}", srcs[i].error());
            }
        }
        (spent / iters.max(1), seqs)
    };
    let mut one = vec![open(&gfx, "four-solo", &spec(Pattern::FrameIndex))];
    let (cost1, _) = per_iter(&mut one, 150);
    drop(one);
    let mut four: Vec<SceneSource> = (0..4)
        .map(|i| open(&gfx, &format!("four-{i}"), &spec(Pattern::FrameIndex)))
        .collect();
    let (cost4, seqs) = per_iter(&mut four, 150);
    for (i, s) in seqs.iter().enumerate() {
        assert!(s.len() >= 140, "worker {i}: only {} frames", s.len());
        assert!(s.windows(2).all(|w| w[1] > w[0]), "worker {i} out of order");
    }
    let pids: std::collections::HashSet<_> = four.iter().map(|s| s.pid().unwrap()).collect();
    assert_eq!(pids.len(), 4, "one worker process each");
    println!("update cost per iteration: 1 worker {cost1:?}, 4 workers {cost4:?}");
    assert!(
        cost4 <= cost1.mul_f64(4.5),
        "4 workers cost {cost4:?} per iteration vs {cost1:?} for one"
    );
}

/// The worker's CPU time so far (utime + stime), from `/proc/<pid>/stat`.
fn proc_cpu(pid: u32) -> Duration {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let f: Vec<&str> = s.rsplit(')').next().unwrap().split_whitespace().collect();
    let ticks: u64 = f[11].parse::<u64>().unwrap() + f[12].parse::<u64>().unwrap();
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
    Duration::from_millis(ticks * 1000 / hz)
}

/// The spike's pass criteria (`dmabuf.md`: ≥ 143 fps, 0 out-of-order, < 5 % CPU per process)
/// through the real transport, trivial and under 3.7 ms-class GPU load; every latched frame
/// checked. Prints the numbers the rules doc quotes.
#[test]
fn transport_meets_the_spike_budget() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    for (label, work) in [("trivial", 0u32), ("load", 2500)] {
        let mut s = spec(Pattern::FrameIndex);
        s.gpu_work = work;
        let mut src = open(&gfx, &format!("budget-{label}"), &s);
        assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
            .stats()
            .latched
            >= 20));
        let pid = src.pid().unwrap();
        let (cpu0, l0, t0) = (proc_cpu(pid), src.stats().latched, Instant::now());
        let mut upd = Duration::ZERO;
        let mut bad = Vec::new();
        let mut last = src.latched_seq().unwrap();
        while t0.elapsed() < Duration::from_secs(5) {
            let mut p = libc::pollfd {
                fd: src.wake_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut p, 1, 1) };
            let t = Instant::now();
            let changed = src.update(&gfx);
            upd += t.elapsed();
            if changed {
                let seq = src.latched_seq().unwrap();
                if seq <= last {
                    bad.push(format!("out of order {last} → {seq}"));
                }
                last = seq;
                if let Err(e) = check_frame(&gfx, src.texture().unwrap(), seq) {
                    bad.push(e);
                }
            }
        }
        let secs = t0.elapsed().as_secs_f64();
        let fps = (src.stats().latched - l0) as f64 / secs;
        let worker_cpu = (proc_cpu(pid) - cpu0).as_secs_f64() / secs * 100.0;
        let comp_cpu = upd.as_secs_f64() / secs * 100.0;
        let mut lat = src.latencies_ms();
        lat.sort_by(f32::total_cmp);
        let (p50, p99) = (lat[lat.len() / 2], lat[lat.len() * 99 / 100]);
        println!(
            "budget {label}: {fps:.2} fps, bad {}, worker CPU {worker_cpu:.2} %, compositor \
             update CPU {comp_cpu:.2} %, tick→latch p50 {p50:.2} p99 {p99:.2} ms, stats {:?}",
            bad.len(),
            src.stats()
        );
        assert!(bad.is_empty(), "{label}: {:?}", &bad[..bad.len().min(5)]);
        assert!(fps >= 143.0, "{label}: {fps:.2} fps");
        assert!(worker_cpu < 5.0, "{label}: worker CPU {worker_cpu:.2} %");
        assert!(
            comp_cpu < 5.0,
            "{label}: compositor update CPU {comp_cpu:.2} %"
        );
    }
}

#[test]
fn worker_context_is_low_priority() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let Some(granted) = gfx.context_priority() else {
        println!("SKIP: no EGL_IMG_context_priority on this display");
        return;
    };
    // The compositor keeps the driver default (see `gfx::OffscreenOpts`) — above the worker.
    assert_eq!(
        granted,
        lp_player::gfx::Priority::Medium,
        "the compositor's default"
    );
    let mut src = open(&gfx, "prio", &spec(Pattern::Solid));
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 1));
    let tail = src.log_tail();
    assert!(
        tail.iter()
            .any(|l| l.contains("context priority requested low, granted low")),
        "{tail:?}"
    );
}

// ---------------------------------------------------------------- Task 5: the `scene` Source kind

use common::harness::Harness;
use lp_player::anim::PropPath;
use lp_player::graph::PropValue;
use lp_player::sources::SourceEvent;
use serde_json::json;

/// A harness (GPU + catalogue, else SKIP) with the scene lock held first.
fn harness(outputs: &[&str]) -> Option<(std::sync::MutexGuard<'static, ()>, Harness)> {
    let g = gpu_lock();
    let h = Harness::new(outputs)?;
    Some((g, h))
}

fn readies(h: &Harness, id: &str) -> usize {
    h.src_events
        .iter()
        .filter(|(_, i, e)| i == id && *e == SourceEvent::Ready)
        .count()
}

fn set(h: &mut Harness, path: &str, v: PropValue) {
    h.graph
        .set(&PropPath(path.to_string()), v)
        .unwrap_or_else(|e| panic!("set {path}: {e}"));
}

/// Tick for `d` of wall time (the harness clock follows the wall).
fn tick_for(h: &mut Harness, d: Duration) {
    let end = Instant::now() + d;
    while Instant::now() < end {
        h.tick();
    }
}

/// Ready is the first *latched* frame, at exactly `position` (the clock waits for it), and
/// it comes once.
#[test]
fn scene_ready_is_first_latched_frame() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene(
        "t5-ready",
        &spec(Pattern::FrameIndex),
        json!({"position": 5.0}),
    );
    h.show("VIRTUAL-1", &id);
    let ok = h.tick_until(Duration::from_secs(10), |h| {
        h.host.scene(&id).is_some_and(|s| s.texture().is_some())
    });
    assert!(ok, "no frame: {:?}", h.src_events);
    let s = h.scene_src(&id);
    assert_eq!(readies(&h, &id), 1, "Ready with the first latched frame");
    assert!(h.bool(&format!("{id}.ready")));
    assert_eq!(
        (s.latched_seq(), s.latched_t()),
        (Some(0), Some(5.0)),
        "the frame of t = position"
    );
    assert_eq!(h.corner(&id), Some(marker_rgb(0)[0]));
    assert_eq!(h.str(&format!("{id}.kind")), "scene");
    tick_for(&mut h, Duration::from_millis(500));
    assert_eq!(readies(&h, &id), 1, "one Ready per load");
    assert!(h.scene_src(&id).stats().latched > 5, "it plays on");
    let tp = h.f64(&format!("{id}.time_pos"));
    assert!(
        (5.3..6.0).contains(&tp),
        "time_pos {tp} after ~0.5 s from 5.0"
    );
    assert_eq!(
        h.f64(&format!("{id}.width")),
        640.0,
        "exported at the output's cover size"
    );
}

/// A scene opened paused shows its first frame (Ready) and nothing else: exactly one tick.
#[test]
fn paused_scene_readies_with_its_first_frame() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene(
        "t5-paused",
        &spec(Pattern::FrameIndex),
        json!({"paused": true}),
    );
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    let px0 = h.corner(&id).expect("a frame");
    let t0 = h.f64(&format!("{id}.time_pos"));
    tick_for(&mut h, Duration::from_secs(1));
    let st = h.scene_src(&id).stats();
    assert_eq!(st.ticks_sent, 1, "exactly one tick: {st:?}");
    assert_eq!(st.latched, 1, "{st:?}");
    assert_eq!(h.corner(&id), Some(px0), "identical for 1 s");
    assert_eq!(h.f64(&format!("{id}.time_pos")), t0, "the clock is stopped");
    assert_eq!(readies(&h, &id), 1);
}

/// `paused` freezes the picture at once (no latch after the apply) and the clock; resuming
/// continues the clock where it stopped (within one tick).
#[test]
fn pause_freezes_picture_exactly() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene("t5-pause", &spec(Pattern::FrameIndex), json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    tick_for(&mut h, Duration::from_millis(300));
    // Pause with a tick in flight: its frame must never latch.
    let ok = h.tick_until(Duration::from_secs(2), |h| {
        let st = h.scene_src(&id).stats();
        st.ticks_sent > st.frames_received
    });
    assert!(ok, "a tick in flight");
    let latched = h.scene_src(&id).stats().latched;
    let seq = h.scene_src(&id).latched_seq();
    let px = h.corner(&id);
    set(&mut h, &format!("{id}.paused"), PropValue::Bool(true));
    h.tick(); // the apply
    let frozen = h.f64(&format!("{id}.time_pos"));
    tick_for(&mut h, Duration::from_millis(500));
    let s = h.scene_src(&id);
    assert_eq!(s.stats().latched, latched, "no latch after the apply");
    assert_eq!(s.latched_seq(), seq);
    assert_eq!(h.corner(&id), px, "the held texture is exact");
    assert_eq!(h.f64(&format!("{id}.time_pos")), frozen, "time_pos frozen");
    set(&mut h, &format!("{id}.paused"), PropValue::Bool(false));
    h.tick();
    let resumed = h.f64(&format!("{id}.time_pos"));
    assert!(
        resumed >= frozen && resumed - frozen <= 1.0 / 30.0 + 0.02,
        "resume continues: {frozen} → {resumed}"
    );
    let ok = h.tick_until(Duration::from_secs(2), |h| {
        h.scene_src(&id).stats().latched > latched
    });
    assert!(ok, "frames flow again");
    let t = h.scene_src(&id).latched_t().unwrap();
    assert!(
        t >= frozen && t - frozen < 0.2,
        "the first frame after the resume: {t} vs {frozen}"
    );
}

/// `time_pos` advances at `speed` (owner decision: speed scales a scene's animation), a
/// live `position` set jumps the clock.
#[test]
fn scene_clock_follows_speed_and_position() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene(
        "t5-speed",
        &spec(Pattern::FrameIndex),
        json!({"speed": 2.0}),
    );
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    let tp = format!("{id}.time_pos");
    let rate = |h: &mut Harness| {
        let (t0, w0) = (h.f64(&tp), Instant::now());
        tick_for(h, Duration::from_millis(800));
        (h.f64(&tp) - t0) / w0.elapsed().as_secs_f64()
    };
    let r = rate(&mut h);
    assert!((r - 2.0).abs() < 0.2, "speed 2: {r:.3} scene s per s");
    set(&mut h, &format!("{id}.speed"), PropValue::F64(0.5));
    h.tick();
    let r = rate(&mut h);
    assert!((r - 0.5).abs() < 0.1, "speed 0.5 live: {r:.3}");
    set(&mut h, &format!("{id}.position"), PropValue::F64(100.0));
    h.tick();
    let t = h.f64(&tp);
    assert!((100.0..100.1).contains(&t), "jumped: {t}");
    let ok = h.tick_until(Duration::from_secs(2), |h| {
        h.scene_src(&id).latched_t().is_some_and(|t| t >= 100.0)
    });
    assert!(ok, "frames of the new time");
}

/// The tick rate follows the outputs' `scene_fps` (D5: 30 by default), live, same worker.
#[test]
fn scene_tick_rate_follows_demand() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene("t5-fps", &spec(Pattern::FrameIndex), json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    tick_for(&mut h, Duration::from_millis(300));
    let pid = h.scene_src(&id).pid();
    let fps = |h: &mut Harness, d: Duration| {
        let (l0, w0) = (h.scene_src(&id).stats().latched, Instant::now());
        tick_for(h, d);
        (h.scene_src(&id).stats().latched - l0) as f64 / w0.elapsed().as_secs_f64()
    };
    let f30 = fps(&mut h, Duration::from_secs(2));
    assert!(
        (f30 - 30.0).abs() <= 2.0,
        "default scene_fps 30: {f30:.2}/s"
    );
    set(&mut h, "out:VIRTUAL-1.scene_fps", PropValue::F64(60.0));
    tick_for(&mut h, Duration::from_millis(500));
    let f60 = fps(&mut h, Duration::from_secs(1));
    assert!((f60 - 60.0).abs() <= 3.0, "scene_fps 60: {f60:.2}/s");
    assert_eq!(h.scene_src(&id).pid(), pid, "same worker");
    assert_eq!(h.scene_src(&id).tick_hz(), 60.0);
}

/// A live `path` change is a new worker on the new folder, the old frame held (never None)
/// until the new one's first frame — not a crash, not a restart.
#[test]
fn path_change_restarts_worker_and_holds_frame() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let mut red = spec(Pattern::Solid);
    red.rgb = [255, 0, 0];
    let mut blue = spec(Pattern::Solid);
    blue.rgb = [0, 0, 255];
    let blue_dir = common::synthetic_scene("t5-path-blue", &blue);
    let id = h.scene("t5-path-red", &red, json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    let pid = h.scene_src(&id).pid().unwrap();
    let px = |h: &Harness| {
        let t = h
            .scene_src(&id)
            .texture()
            .expect("the texture is never None");
        common::read_rgba(&h.gfx, t, 100, 100)
    };
    assert_eq!(px(&h)[..3], [255, 0, 0]);
    set(
        &mut h,
        &format!("{id}.path"),
        PropValue::Str(blue_dir.to_str().unwrap().into()),
    );
    let mut reds = 0;
    let ok = h.tick_until(Duration::from_secs(10), |h| {
        let p = px(h);
        if p[..3] == [255, 0, 0] {
            reds += 1;
        }
        p[..3] == [0, 0, 255]
    });
    assert!(ok, "the new folder's frame: {:?}", h.src_events);
    let s = h.scene_src(&id);
    assert_ne!(s.pid(), Some(pid), "a new worker");
    assert!(reds >= 1, "the old frame was held meanwhile");
    let st = s.stats();
    assert_eq!((st.restarts, st.spawns), (0, 2), "not a crash: {st:?}");
    assert_eq!(readies(&h, &id), 2, "Ready once per load");
    assert!(
        !h.src_events
            .iter()
            .any(|(_, i, e)| i == &id && matches!(e, SourceEvent::Error { .. })),
        "{:?}",
        h.src_events
    );
    assert!(s.error().is_none() && s.broken().is_none());
}

/// A demand change that moves the largest output (a 2560×1440 output shows the scene too)
/// re-exports the ring once at the new cover size; the texture is never None meanwhile and
/// the old slots go once a new frame latched.
#[test]
fn demand_change_reexports_without_black() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let mut s = spec(Pattern::FrameIndex);
    s.native = [3840, 2160];
    let id = h.scene("t5-demand", &s, json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    assert_eq!(
        h.scene_src(&id).size(),
        Some((640, 360)),
        "VIRTUAL-1's cover size"
    );
    let pid = h.scene_src(&id).pid();
    h.add_graph_output("BIG", 2560, 1440);
    h.show("BIG", &id);
    let ok = h.tick_until(Duration::from_secs(10), |h| {
        assert!(h.scene_src(&id).texture().is_some(), "never None");
        h.scene_src(&id).size() == Some((2560, 1440))
    });
    assert!(ok, "re-exported: {:?}", h.scene_src(&id).stats());
    tick_for(&mut h, Duration::from_millis(200));
    let src = h.scene_src(&id);
    let st = src.stats();
    assert_eq!((st.resizes, st.buffer_sets), (1, 2), "{st:?}");
    assert_eq!((st.rings, st.slots), (1, 3), "the old slots went: {st:?}");
    assert_eq!(src.pid(), pid, "same worker");
    assert_eq!(src.max_size(), [2560, 1440]);
    let tex = src.texture().unwrap();
    let seq = src.latched_seq().unwrap();
    check_frame(&h.gfx, tex, seq).expect("a whole frame at the new size");
}

// ---------------------------------------------------------------- Task 7: real scenes

use std::path::{Path, PathBuf};

/// `patches/lwe/tests/fixtures/<name>` — real LWE projects that need no WE assets
/// (`min-scene`: a clear colour; `fail-scene`: its renderer build throws).
fn lwe_fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../patches/lwe/tests/fixtures")
        .join(name)
}

/// The worker was built with LWE (`--features` lists `lwe`); else the real-scene tests SKIP.
fn worker_has_lwe() -> bool {
    std::process::Command::new(env!("CARGO_BIN_EXE_lp-scene-worker"))
        .arg("--features")
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<Vec<String>>(&o.stdout).ok())
        .is_some_and(|f| f.iter().any(|x| x == "lwe"))
}

/// A fresh empty directory (an "assets dir" with nothing in it).
fn empty_dir(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "lp-scene-test-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A real (non-synthetic) scene source on `dir` with `assets`.
fn open_real(
    gfx: &Gfx,
    name: &str,
    dir: &Path,
    assets: Option<&Path>,
    tweak: impl FnOnce(&mut SceneOpts),
) -> SceneSource {
    let mut o = SceneOpts::new(dir, env!("CARGO_BIN_EXE_lp-scene-worker"));
    o.id = name.into();
    o.max_size = [640, 360];
    o.assets_dir = assets.map(|a| a.display().to_string());
    o.crash_dir = crash_dir(name);
    tweak(&mut o);
    SceneSource::open_opts(gfx, o).expect("open the scene source")
}

/// `update` until `f` stops it or `limit` passes (errors allowed); whether `f` stopped it.
fn pump(
    gfx: &Gfx,
    src: &mut SceneSource,
    limit: Duration,
    mut f: impl FnMut(&mut SceneSource) -> bool,
) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        let mut p = libc::pollfd {
            fd: src.wake_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut p, 1, 2) };
        src.update(gfx);
        if f(src) {
            return true;
        }
    }
    false
}

fn crash_records(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .count()
        })
        .unwrap_or(0)
}

/// A cold LWE build blocks the worker's renderer for up to seconds: its protocol thread keeps
/// answering pings meanwhile, so a 1.5 s load against a 300 ms hang timeout readies without
/// a single restart (RED with the reader not covering the load: `Hung` → restarts).
#[test]
fn slow_scene_load_keeps_the_heartbeat() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let s = SyntheticSpec {
        load_ms: 1500,
        ..spec(Pattern::Solid)
    };
    let mut src = open_with(&gfx, "slow-load", &s, |o| {
        o.hang_timeout = Duration::from_millis(300);
    });
    let t = Instant::now();
    let ready = pump(&gfx, &mut src, Duration::from_secs(6), |s| s.is_ready());
    let took = t.elapsed();
    println!(
        "slow load: ready {ready} after {took:?}, stats {:?}",
        src.stats()
    );
    assert!(ready, "never ready: {:?} {:?}", src.error(), src.log_tail());
    assert!(
        took >= Duration::from_millis(1400),
        "the load took its time: {took:?}"
    );
    assert_eq!(src.stats().restarts, 0, "a slow load is not a hang");
    assert!(src.error().is_none() && src.broken().is_none());
}

/// The real LWE path end to end without WE's assets (D7 fixture `min-scene`, a 64×32 clear
/// colour): load + build in the worker, blit into the ring at the cover size, alpha forced to
/// 1, Ready.
#[test]
fn min_scene_renders_through_the_worker() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    if !worker_has_lwe() {
        println!("SKIP: lp-scene-worker built without LWE");
        return;
    }
    let assets = empty_dir("min");
    let mut src = open_real(
        &gfx,
        "min",
        &lwe_fixture("min-scene"),
        Some(&assets),
        |_| {},
    );
    assert!(
        pump(&gfx, &mut src, Duration::from_secs(10), |s| s.is_ready()
            || s.error().is_some()),
        "never ready"
    );
    assert!(
        src.error().is_none(),
        "{:?} {:?}",
        src.error(),
        src.log_tail()
    );
    assert_eq!(src.native(), Some([64, 32]));
    assert_eq!(src.size(), Some((64, 32)), "never above native");
    let tex = src.texture().expect("a frame");
    for (x, y) in [(32, 16), (1, 1), (62, 30)] {
        let c = read_block(&gfx, tex, x, y, 1, 1);
        for (i, want) in [51u8, 102, 153, 255].iter().enumerate() {
            assert!(
                (c[i] as i32 - *want as i32).abs() <= 1,
                "pixel ({x},{y}) = {c:?}, want the clear colour 51 102 153 255"
            );
        }
    }
}

/// A scene whose renderer build fails (`fail-scene`: an object with a missing parent — the
/// same outcome as WE's assets missing) is a fatal error: no restart, no crash record, the
/// worker idles until stopped and then exits on its own (never a SIGSEGV loop, spike §4.4).
#[test]
fn renderer_build_failure_is_broken_not_a_segfault() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    if !worker_has_lwe() {
        println!("SKIP: lp-scene-worker built without LWE");
        return;
    }
    let assets = empty_dir("failbuild");
    let mut src = open_real(
        &gfx,
        "failbuild",
        &lwe_fixture("fail-scene"),
        Some(&assets),
        |_| {},
    );
    let pid = src.pid().expect("spawned");
    assert!(
        pump(&gfx, &mut src, Duration::from_secs(10), |s| s
            .error()
            .is_some()),
        "no error"
    );
    let e = src.error().unwrap().to_string();
    assert!(e.contains("renderer build failed"), "{e}");
    assert!(
        e.contains(&assets.display().to_string()),
        "names the assets dir: {e}"
    );
    pump(&gfx, &mut src, Duration::from_millis(500), |_| false);
    assert_eq!(src.stats().restarts, 0);
    assert!(src.broken().is_none());
    assert_eq!(crash_records(&crash_dir("failbuild")), 0);
    drop(src);
    let t = Instant::now();
    while unsafe { libc::kill(pid as i32, 0) } == 0 && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        t.elapsed() < Duration::from_secs(1),
        "the worker went on its own after quit"
    );
}

/// Review Focus #1 at the worker: a missing folder, one without `project.json` (Steam still
/// downloading) and a truncated scene all fail cleanly — `load failed`, no restart, no crash
/// record.
#[test]
fn missing_or_half_downloaded_scene_fails_cleanly() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    if !worker_has_lwe() {
        println!("SKIP: lp-scene-worker built without LWE");
        return;
    }
    let assets = empty_dir("missing");
    let half = empty_dir("half-downloaded");
    std::fs::write(half.join("scene.pkg"), b"PKGV0001").unwrap();
    let trunc = empty_dir("truncated");
    std::fs::copy(
        lwe_fixture("min-scene/project.json"),
        trunc.join("project.json"),
    )
    .unwrap();
    let full = std::fs::read(lwe_fixture("min-scene/scene.json")).unwrap();
    std::fs::write(trunc.join("scene.json"), &full[..full.len() / 2]).unwrap();
    for (name, dir, want) in [
        (
            "gone",
            PathBuf::from("/nonexistent/431960/123"),
            "does not exist",
        ),
        ("half", half, "no project.json"),
        ("trunc", trunc, "load failed"),
    ] {
        let mut src = open_real(&gfx, name, &dir, Some(&assets), |_| {});
        assert!(
            pump(&gfx, &mut src, Duration::from_secs(10), |s| s
                .error()
                .is_some()),
            "{name}: no error"
        );
        let e = src.error().unwrap().to_string();
        println!("{name}: {e}");
        assert!(e.contains("load failed") && e.contains(want), "{name}: {e}");
        pump(&gfx, &mut src, Duration::from_millis(300), |_| false);
        assert_eq!(src.stats().restarts, 0, "{name}");
        assert!(src.broken().is_none(), "{name}");
        assert_eq!(crash_records(&crash_dir(name)), 0, "{name}");
    }
}

/// On-machine (D7): real Workshop scenes with the owner's WE assets, `LP_PLAYER_TEST_SCENES=<the
/// 431960 folder>` (SFW: `~/.local/share/Steam/steamapps/workshop/content/431960`), else SKIP
/// (FAIL under `LP_REQUIRE_SCENES=1`). Each: Ready ≤ 3 s (incl. the cold build), frames at 1 s
/// and 3 s of scene time non-blank, opaque and different, exported at the cover size (never
/// native), no GL error. Frames go to `LP_PLAYER_TEST_SCENES_OUT` (default
/// `<tmp>/lp-real-scenes`).
#[test]
fn real_scenes_render_and_animate() {
    let _g = gpu_lock();
    let require = std::env::var("LP_REQUIRE_SCENES").is_ok_and(|v| v == "1");
    let skip = |why: &str| {
        assert!(!require, "LP_REQUIRE_SCENES=1 but: {why}");
        println!("SKIP: {why}");
    };
    let Some(root) = std::env::var_os("LP_PLAYER_TEST_SCENES").map(PathBuf::from) else {
        return skip("LP_PLAYER_TEST_SCENES is not set");
    };
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    if !worker_has_lwe() {
        return skip("lp-scene-worker built without LWE");
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let assets = match lp_player::scene::assets::resolve(None, &home) {
        Ok(a) => a,
        Err(e) => return skip(&e),
    };
    let out = std::env::var_os("LP_PLAYER_TEST_SCENES_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("lp-real-scenes"));
    std::fs::create_dir_all(&out).unwrap();
    for id in ["1726902114", "2371103399", "2134765860"] {
        let dir = root.join(id);
        if !dir.is_dir() {
            skip(&format!("{} is not installed", dir.display()));
            continue;
        }
        let mut src = open_real(&gfx, &format!("real-{id}"), &dir, Some(&assets), |o| {
            o.stepped = true;
            o.max_size = [1920, 1080];
        });
        let t = Instant::now();
        src.step_to(0.0);
        let ready = pump(&gfx, &mut src, Duration::from_secs(10), |s| {
            s.is_ready() || s.error().is_some()
        });
        let ready_ms = t.elapsed().as_millis();
        assert!(
            ready && src.error().is_none(),
            "{id}: {:?} {:?}",
            src.error(),
            src.log_tail()
        );
        // 30 fps of scene time, like playback (particles integrate per frame; three far-apart
        // ticks barely move them), capturing the frames at 1 s and 3 s.
        let mut shots = Vec::new();
        for f in 1..=90u32 {
            let at = f as f64 / 30.0;
            src.step_to(at);
            assert!(
                pump(&gfx, &mut src, Duration::from_secs(5), |s| {
                    s.step_status() == lp_player::sources::StepStatus::Done
                }),
                "{id}: frame at {at} s"
            );
            if f == 30 || f == 90 {
                let tex = src.texture().unwrap();
                let px = read_block(&gfx, tex, 0, 0, tex.w, tex.h);
                let p = out.join(format!("{id}-{}s.png", f / 30));
                gfx.write_png_source(tex, &p).unwrap();
                shots.push((p, px));
            }
        }
        let (w, h) = src.size().unwrap();
        let native = src.native().unwrap();
        let lit = shots[1]
            .1
            .chunks_exact(4)
            .filter(|c| c[0] as u32 + c[1] as u32 + c[2] as u32 > 24)
            .count();
        let opaque = shots[1].1.chunks_exact(4).all(|c| c[3] == 255);
        let changed = shots[0]
            .1
            .chunks_exact(4)
            .zip(shots[1].1.chunks_exact(4))
            .filter(|(a, b)| a[..3] != b[..3])
            .count();
        let gl_errors: Vec<String> = src
            .log_tail()
            .into_iter()
            .filter(|l| l.contains("GL error"))
            .collect();
        println!(
            "{id}: ready {ready_ms} ms, native {native:?} -> export {w}x{h}, lit {lit}, \
             changed 1s->3s {changed} px, shots {} {}",
            shots[0].0.display(),
            shots[1].0.display()
        );
        assert!(ready_ms <= 3000, "{id}: Ready took {ready_ms} ms");
        assert!(w <= native[0] && h <= native[1], "{id}: never above native");
        assert!(
            w >= 1920.min(native[0]) && h >= 1080.min(native[1]),
            "{id}: covers the demand"
        );
        assert!(lit > (w * h / 10) as usize, "{id}: blank frame ({lit} lit)");
        assert!(opaque, "{id}: alpha forced to 1");
        assert!(changed > 0, "{id}: not animating");
        assert!(gl_errors.is_empty(), "{id}: {gl_errors:?}");
    }
}
