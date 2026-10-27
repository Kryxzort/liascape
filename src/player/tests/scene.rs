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
    SceneSource::open(gfx, o).expect("open the scene source")
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
