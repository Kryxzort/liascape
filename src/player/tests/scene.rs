//! dmabuf scene-frame transport (Phase 2 Task 4; `.claude/rules/player-core.md` § Scene
//! worker → "Frame transport"; evidence `docs/player/spikes/dmabuf.md`). GPU: each test
//! drives a [`SceneSource`] whose `liascape-scene-worker` renders `liascape-synthetic.json` (D7) into a
//! 3-slot ring of exported `GL_RGBA8` textures; the source imports them once and latches
//! only frames whose acquire fence already signalled. SKIP without EGL (`LIASCAPE_REQUIRE_GPU=1`
//! fails instead). One test at a time (`GPU`): their frame-rate and timing assertions must
//! not compete with each other for the GPU.

mod common;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use glow::HasContext;
use liascape_player::gfx::{Gfx, Tex};
use liascape_player::scene::synthetic::{MARKER, PROBE, Pattern, SyntheticSpec, grad_rgb, marker_rgb};
use liascape_player::sources::Source;
use liascape_player::sources::scene::{SceneOpts, SceneSource};
use liascape_player::worker::RestartBudget;

static GPU: Mutex<()> = Mutex::new(());

fn gpu_lock() -> std::sync::MutexGuard<'static, ()> {
    GPU.lock().unwrap_or_else(|e| e.into_inner())
}

fn crash_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("liascape-scene-test-{}-{name}", std::process::id()));
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
    let mut o = SceneOpts::new(dir, env!("CARGO_BIN_EXE_liascape-scene-worker"));
    o.synthetic = true;
    o.tick_hz = 144.0;
    o.max_size = [1920, 1080];
    o.env = vec![("LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES".into(), "1".into())];
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

/// The suspend false-hang (2026-10-29, `docs/player/reports/phase2.md` § 8): while the GPU
/// finishes nothing — NVIDIA saving VRAM before a suspend, the GPU waking after it — the
/// worker's frames' acquire fences don't signal, so the compositor latches none, releases
/// none, and soon holds all three slots; the worker then can't render the next tick and waits
/// for a `Release`. That is the GPU, not a hung worker: it must not be killed. Synthetic
/// `gpu_stall: [500, 1500]` = for 1.5 s from 0.5 s after the start every frame's fence is held
/// back (a stand-in signalled at the end) — 5 × the 300 ms hang timeout. After it the
/// frames flow again from the same worker, never restarted.
#[test]
fn gpu_stall_that_starves_the_worker_is_not_a_hang() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let sp = SyntheticSpec {
        gpu_stall: Some([500, 1500]),
        ..spec(Pattern::FrameIndex)
    };
    let mut src = open_with(&gfx, "gpu-stall", &sp, |o| {
        o.hang_timeout = Duration::from_millis(300);
    });
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 10));
    let pid = src.pid().expect("a worker");
    // (time, latched) at every change, over the stall and 1.5 s past it.
    let t0 = Instant::now();
    let mut series = vec![(Duration::ZERO, src.stats().latched)];
    run(&gfx, &mut src, Duration::from_millis(3500), |s, _| {
        let l = s.stats().latched;
        if series.last().is_some_and(|x| x.1 != l) {
            series.push((t0.elapsed(), l));
        }
        false
    });
    let gap = series
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .max()
        .unwrap_or_default();
    let st = src.stats();
    println!("longest latch gap {gap:?}, stats {st:?}");
    assert_eq!(st.restarts, 0, "no restart: the worker was starved, not hung ({st:?})");
    assert!(
        gap >= Duration::from_millis(1200),
        "the stall held every frame back (longest gap between latches {gap:?})"
    );
    assert_eq!(src.pid(), Some(pid), "the same worker");
    let last = series.last().unwrap();
    assert!(
        last.0 >= Duration::from_millis(2500) && st.latched >= series[0].1 + 100,
        "frames flowed again after the stall: {:?}",
        &series[series.len().saturating_sub(3)..]
    );
    check_frame(&gfx, src.texture().unwrap(), src.latched_seq().unwrap()).unwrap();
}

/// A scene the VRAM guard stops (Task 8, `stop_for_vram`) gives its ring back — the worker's
/// exported slots stay alive while the compositor holds their imports (~3 × the export size
/// of GPU memory, for a scene stopped *because* it used too much) — keeping exactly the slot
/// on screen: the last frame stays shown, unchanged, from one imported slot.
#[test]
fn vram_stopped_scene_keeps_only_its_shown_slot() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let mut src = open(&gfx, "vram-slots", &spec(Pattern::FrameIndex));
    assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
        .stats()
        .latched
        >= 20));
    assert_eq!(src.stats().slots, 3, "a playing scene holds its ring of 3");
    src.stop_for_vram(1800.0, 1536.0);
    let tex_id = src.texture().expect("the shown frame").id;
    let seq = src.latched_seq().unwrap();
    let held = read_block(&gfx, src.texture().unwrap(), 0, 0, 64, 64);
    check_frame(&gfx, src.texture().unwrap(), seq).unwrap();
    let end = Instant::now() + Duration::from_secs(1);
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(5));
        src.update(&gfx);
        let tex = src.texture().expect("the stopped scene's frame never goes away");
        assert_eq!(tex.id, tex_id, "the same imported texture");
    }
    let tex = src.texture().unwrap();
    assert_eq!(read_block(&gfx, tex, 0, 0, 64, 64), held, "the held frame changed");
    check_frame(&gfx, tex, seq).unwrap();
    let st = src.stats();
    assert_eq!(
        (st.slots, st.rings, st.queued),
        (1, 1, 0),
        "after a VRAM stop only the shown slot stays imported: {st:?}"
    );
    assert!(src.vram_stopped().is_some());
    assert!(src.error().is_some(), "a VRAM stop is reported as the source's error");
    // A path change still brings a new worker, whose first frame replaces the kept slot.
    let other = common::synthetic_scene("vram-slots-next", &spec(Pattern::FrameIndex));
    src.apply("path", &PropValue::Str(other.display().to_string()))
        .unwrap();
    assert!(
        run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
            .texture()
            .is_some_and(|t| t.id != tex_id)
            && s.stats().slots == 3),
        "a new worker's ring after the path change: {:?}",
        src.stats()
    );
    assert!(src.vram_stopped().is_none());
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
        o.env.push(("LIASCAPE_SCENE_SYNC".into(), "fdpoll".into()));
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

/// The worker's CPU time so far, summed over its threads' `schedstat` run time (ns — not the
/// 10 ms-tick `utime + stime`), and each thread's (name, time) for the report.
fn proc_cpu(pid: u32) -> (Duration, Vec<(String, Duration)>) {
    let mut total = Duration::ZERO;
    let mut per = Vec::new();
    for e in std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .flatten()
    {
        let ns: u64 = std::fs::read_to_string(e.path().join("schedstat"))
            .ok()
            .and_then(|s| s.split_whitespace().next()?.parse().ok())
            .unwrap_or(0);
        let name = std::fs::read_to_string(e.path().join("comm")).unwrap_or_default();
        total += Duration::from_nanos(ns);
        per.push((name.trim().to_string(), Duration::from_nanos(ns)));
    }
    (total, per)
}

/// On a hybrid CPU (Intel P + E cores: `/sys/devices/cpu_core/cpus`), the performance cores;
/// `None` elsewhere.
fn performance_cores() -> Option<Vec<usize>> {
    let list = std::fs::read_to_string("/sys/devices/cpu_core/cpus").ok()?;
    let mut cpus = Vec::new();
    for part in list.trim().split(',').filter(|p| !p.is_empty()) {
        match part.split_once('-') {
            Some((a, b)) => cpus.extend(a.parse::<usize>().ok()?..=b.parse::<usize>().ok()?),
            None => cpus.push(part.parse().ok()?),
        }
    }
    (!cpus.is_empty()).then_some(cpus)
}

/// Pin every thread of `pid` to `cpus` (threads it starts later inherit the affinity).
fn pin_threads(pid: u32, cpus: &[usize]) {
    for e in std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .flatten()
    {
        let Ok(tid) = e.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            for &c in cpus {
                libc::CPU_SET(c, &mut set);
            }
            libc::sched_setaffinity(tid, std::mem::size_of::<libc::cpu_set_t>(), &set);
        }
    }
}

/// A user-space hardware counter (`HW_CYCLES` / `HW_INSTRUCTIONS`) over every current thread
/// of `pid` (one `perf_event_open` per thread; on a hybrid CPU the P-core PMU — the threads are
/// pinned there). `None` where counters aren't permitted (`perf_event_paranoid` > 2, a
/// container).
struct Counter(Vec<i32>);

const HW_CYCLES: u64 = 0;
const HW_INSTRUCTIONS: u64 = 1;

impl Counter {
    fn open(pid: u32, event: u64) -> Option<Counter> {
        let pmu: u64 = std::fs::read_to_string("/sys/devices/cpu_core/type")
            .ok()
            .and_then(|t| t.trim().parse().ok())
            .unwrap_or(0);
        let mut fds = Vec::new();
        for e in std::fs::read_dir(format!("/proc/{pid}/task"))
            .ok()?
            .flatten()
        {
            let tid: i32 = e.file_name().to_string_lossy().parse().ok()?;
            // struct perf_event_attr (128 bytes): type HARDWARE, size, config = (pmu << 32) |
            // event, flags exclude_kernel | exclude_hv.
            let mut a = [0u8; 128];
            a[4..8].copy_from_slice(&128u32.to_ne_bytes());
            a[8..16].copy_from_slice(&((pmu << 32) | event).to_ne_bytes());
            a[40..48].copy_from_slice(&((1u64 << 5) | (1 << 6)).to_ne_bytes());
            let fd =
                unsafe { libc::syscall(libc::SYS_perf_event_open, a.as_ptr(), tid, -1, -1, 0u64) }
                    as i32;
            if fd < 0 {
                fds.iter().for_each(|f| unsafe {
                    libc::close(*f);
                });
                return None;
            }
            fds.push(fd);
        }
        Some(Counter(fds))
    }

    fn read(&self) -> u64 {
        self.0
            .iter()
            .map(|&fd| {
                let mut v = 0u64;
                unsafe { libc::read(fd, (&mut v as *mut u64).cast(), 8) };
                v
            })
            .sum()
    }
}

impl Drop for Counter {
    fn drop(&mut self) {
        self.0.iter().for_each(|f| unsafe {
            libc::close(*f);
        });
    }
}

/// The spike's pass criteria (`dmabuf.md`: ≥ 143 fps, 0 out-of-order, < 5 % CPU per process)
/// through the real transport, trivial and under 3.7 ms-class GPU load; every latched frame
/// checked. Prints the numbers the rules doc quotes.
///
/// The worker's CPU is measured as the cost of its work, not of where the scheduler put it
/// (`.claude/rules/player-core.md` § Frame transport → "Measured"): its threads are pinned to
/// the performance cores of a hybrid CPU (the same work — a constant ~178 k user instructions a
/// frame — took 214–231 µs of CPU on a P-core and 276–290 µs on an E-core of this i9-12900K),
/// its run time is read per thread from `schedstat` (ns), and the asserted figure is the
/// **median of 1 s windows** (a burst of other load on a shared machine moves one window),
/// measured ≥ 5 s and up to 15 s while it's over budget. Sustained contention still inflates
/// CPU time with the work unchanged (memory-streaming load: 7×), so the work itself is asserted
/// too — user instructions per frame (hardware counter) and wake-ups per frame — and a CPU
/// figure over budget with that work in budget is reported as contention, not failed.
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
        let fast = performance_cores();
        if let Some(cpus) = &fast {
            pin_threads(pid, cpus);
        }
        let (instr, cycles) = (
            Counter::open(pid, HW_INSTRUCTIONS),
            Counter::open(pid, HW_CYCLES),
        );
        let (ins0, cyc0, sw0) = (
            instr.as_ref().map(|i| i.read()),
            cycles.as_ref().map(|c| c.read()),
            ctx_switches(pid),
        );
        let (cpu0, l0, f0, t0) = (
            proc_cpu(pid).0,
            src.stats().latched,
            src.stats().frames_received,
            Instant::now(),
        );
        // (wall, worker CPU) at each 1 s window's edge
        let mut edges = vec![(t0, cpu0)];
        let mut upd = Duration::ZERO;
        let mut bad = Vec::new();
        let mut last = src.latched_seq().unwrap();
        // ≥ 5 s; up to 15 s while the median window is over budget (other load comes and goes)
        while t0.elapsed() < Duration::from_secs(15)
            && (t0.elapsed() < Duration::from_secs(5) || median_cpu(&edges) >= CPU_BUDGET_PCT)
        {
            if edges.last().unwrap().0.elapsed() >= Duration::from_secs(1) {
                edges.push((Instant::now(), proc_cpu(pid).0));
            }
            let mut p = libc::pollfd {
                fd: src.wake_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut p, 1, 1) };
            let t = thread_cpu();
            let changed = src.update(&gfx);
            upd += thread_cpu() - t;
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
        let (cpu1, threads) = proc_cpu(pid);
        let rendered = (src.stats().frames_received - f0).max(1) as f64;
        let instr_per_frame = instr
            .as_ref()
            .map(|i| (i.read() - ins0.unwrap()) as f64 / rendered);
        let cycles_per_frame = cycles
            .as_ref()
            .map(|c| (c.read() - cyc0.unwrap()) as f64 / rendered);
        let switches_per_frame = (ctx_switches(pid) - sw0) as f64 / rendered;
        drop((instr, cycles));
        edges.push((Instant::now(), cpu1));
        let worker_cpu = median_cpu(&edges);
        let windows = cpu_windows(&edges);
        let whole = (cpu1 - cpu0).as_secs_f64() / secs * 100.0;
        let comp_cpu = upd.as_secs_f64() / secs * 100.0;
        let mut lat = src.latencies_ms();
        lat.sort_by(f32::total_cmp);
        let (p50, p99) = (lat[lat.len() / 2], lat[lat.len() * 99 / 100]);
        let threads: Vec<String> = threads
            .iter()
            .map(|(n, d)| format!("{n} {:.0} ms", d.as_secs_f64() * 1e3))
            .collect();
        let work = match (instr_per_frame, cycles_per_frame) {
            (Some(i), Some(c)) => format!(
                "{:.0} k user instructions in {:.0} k user cycles",
                i / 1e3,
                c / 1e3
            ),
            (Some(i), None) => format!("{:.0} k user instructions", i / 1e3),
            _ => "user instructions not countable here".into(),
        };
        println!(
            "budget {label}: {fps:.2} fps, bad {}, worker CPU {worker_cpu:.2} % (median of the \
             1 s windows {windows:.2?} over {secs:.1} s; whole {whole:.2} %; pinned to {}; \
             threads' totals {threads:?}); per frame {work}, {switches_per_frame:.2} context \
             switches; compositor update CPU {comp_cpu:.2} %, tick→latch p50 {p50:.2} p99 \
             {p99:.2} ms, stats {:?}",
            bad.len(),
            if fast.is_some() {
                "the P-cores"
            } else {
                "nothing: not a hybrid CPU"
            },
            src.stats()
        );
        assert!(bad.is_empty(), "{label}: {:?}", &bad[..bad.len().min(5)]);
        assert!(fps >= 143.0, "{label}: {fps:.2} fps");
        // The worker's work per frame, independent of contention: its user instructions and
        // its wake-ups. Measured 175–178 k (debug worker) and exactly 4 (the tick and the
        // release each wake the protocol thread, then the renderer) — any growth is real cost.
        if let Some(i) = instr_per_frame {
            assert!(
                i < INSTR_BUDGET_PER_FRAME,
                "{label}: {:.0} k user instructions per frame (budget {:.0} k)",
                i / 1e3,
                INSTR_BUDGET_PER_FRAME / 1e3
            );
        }
        assert!(
            switches_per_frame < 4.5,
            "{label}: {switches_per_frame:.2} context switches per frame"
        );
        // CPU time per frame is not the work: it moves with the clock (cores idle at 0.8 GHz
        // under the `powersave` governor, 5.3 GHz boosted — a light periodic load rarely ramps
        // them) and with other load (the same instructions took 0.3 → 5.4 M user cycles a
        // frame against 12 memory-streaming processes). Over budget with the work unchanged
        // (both checks above passed, on a counting machine) = the machine, not the worker:
        // said so, not failed. Without counters the CPU budget must hold as measured. The
        // compositor's `update` (this thread's CPU time inside it) moves the same way: over
        // budget only counts as the machine when the worker's figure does too.
        if worker_cpu >= CPU_BUDGET_PCT && instr_per_frame.is_some() {
            println!(
                "budget {label}: MACHINE, NOT WORK — worker CPU {worker_cpu:.2} % (compositor update \
                 {comp_cpu:.2} %) over {secs:.1} s with the per-frame work within budget \
                 ({work}); load {}",
                std::fs::read_to_string("/proc/loadavg")
                    .unwrap_or_default()
                    .trim()
            );
            continue;
        }
        assert!(
            worker_cpu < CPU_BUDGET_PCT,
            "{label}: worker CPU {worker_cpu:.2} %"
        );
        assert!(
            comp_cpu < CPU_BUDGET_PCT,
            "{label}: compositor update CPU {comp_cpu:.2} %"
        );
    }
}

/// This thread's CPU time (`CLOCK_THREAD_CPUTIME_ID`: time it was preempted doesn't count).
fn thread_cpu() -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

/// The spike's CPU budget per process (`dmabuf.md`).
const CPU_BUDGET_PCT: f64 = 5.0;

/// The worker's user instructions per 144 fps synthetic frame: measured 175–178 k (debug
/// worker, either config — `gpu_work` loops on the GPU) and ~102 k (release); 1.4× the debug
/// figure, so +40 % of user-space work fails whatever the machine is doing.
const INSTR_BUDGET_PER_FRAME: f64 = 250e3;

/// The worker's CPU % per window between consecutive `edges` (wall, CPU) ≥ 0.5 s apart, sorted.
fn cpu_windows(edges: &[(Instant, Duration)]) -> Vec<f64> {
    let mut w: Vec<f64> = edges
        .windows(2)
        .filter(|w| w[1].0 - w[0].0 >= Duration::from_millis(500))
        .map(|w| (w[1].1 - w[0].1).as_secs_f64() / (w[1].0 - w[0].0).as_secs_f64() * 100.0)
        .collect();
    w.sort_by(f64::total_cmp);
    w
}

/// The median of [`cpu_windows`] (∞ before the first window).
fn median_cpu(edges: &[(Instant, Duration)]) -> f64 {
    let w = cpu_windows(edges);
    w.get(w.len() / 2).copied().unwrap_or(f64::INFINITY)
}

/// Voluntary context switches of every thread of `pid` — its wake-ups (involuntary ones are
/// other load preempting it).
fn ctx_switches(pid: u32) -> u64 {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .map(|d| {
            d.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path().join("status")).ok())
                .flat_map(|s| {
                    s.lines()
                        .filter_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            (k == "voluntary_ctxt_switches")
                                .then(|| v.trim().parse::<u64>().ok())?
                        })
                        .collect::<Vec<_>>()
                })
                .sum()
        })
        .unwrap_or(0)
}

/// The names of a process's threads.
fn thread_names(pid: u32) -> Vec<String> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .map(|d| {
            d.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path().join("comm")).ok())
                .map(|c| c.trim().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// A scene without sound has nothing to play: its worker never starts the audio thread (it
/// polled for a sound 50×/s for the scene's whole life); one with sound does.
#[test]
fn audio_thread_only_for_a_scene_with_sound() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    for sound in [false, true] {
        let mut s = spec(Pattern::Solid);
        s.has_audio = sound;
        let mut src = open(&gfx, &format!("audio-thread-{sound}"), &s);
        assert!(run(&gfx, &mut src, Duration::from_secs(10), |s, _| s
            .stats()
            .latched
            >= 10));
        let names = thread_names(src.pid().unwrap());
        assert_eq!(
            names.iter().any(|n| n == "lia-scene-audio"),
            sound,
            "has_audio {sound}: worker threads {names:?}"
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
        liascape_player::gfx::Priority::Medium,
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
use liascape_player::anim::PropPath;
use liascape_player::graph::PropValue;
use liascape_player::sources::SourceEvent;
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

/// Task 8: the worker GPU budget, live on one worker. A scene whose worker reports 20 ms of
/// GPU per frame (the synthetic `report_gpu_ms` knob — 600 ms/s at 30 fps) is throttled to
/// half its latched rate when its outputs miss 10 % of their frames, steps back up × 1.25 after
/// 5 s calm (a virtual budget clock), and `auto` off lifts the cap at once — the tick rate
/// follows each change, same pid. A light worker (the plain synthetic scene: its real
/// `GL_TIME_ELAPSED` reading is a fraction of a ms) is never throttled for the same misses.
#[test]
fn scene_budget_throttles_live_and_recovers() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let mut heavy = spec(Pattern::FrameIndex);
    heavy.report_gpu_ms = Some(20.0);
    let id = h.scene("t8-heavy", &heavy, json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    tick_for(&mut h, Duration::from_millis(2500));
    let pid = h.scene_src(&id).pid();
    let fps = |h: &mut Harness, d: Duration| {
        let (l0, w0) = (h.scene_src(&id).stats().latched, Instant::now());
        tick_for(h, d);
        (h.scene_src(&id).stats().latched - l0) as f64 / w0.elapsed().as_secs_f64()
    };
    assert_eq!(h.scene_src(&id).gpu_ms().0, Some(20.0), "the knob's GPU time arrives");
    assert_eq!(h.scene_src(&id).throttle_cap(), None);
    let t0 = Duration::from_secs(1000);
    let budget = |h: &mut Harness, at: Duration, missed: f64, auto: bool| {
        h.host
            .scene_mut(&id)
            .expect("hosted")
            .observe_budget(at, missed, auto);
    };
    budget(&mut h, t0, 0.0, true);
    assert_eq!(h.scene_src(&id).throttle_cap(), None, "clean outputs: no cap");
    budget(&mut h, t0 + Duration::from_millis(500), 10.0, true);
    let cap = h.scene_src(&id).throttle_cap().expect("throttled");
    assert!((14.0..=16.0).contains(&cap), "half of ~30 fps: {cap}");
    assert_eq!(h.scene_src(&id).tick_hz(), cap, "ticks at the cap");
    assert_eq!(h.scene_src(&id).demand_hz(), 30.0, "the demand is kept");
    tick_for(&mut h, Duration::from_millis(500));
    let f = fps(&mut h, Duration::from_secs(2));
    assert!((f - cap).abs() <= 2.0, "throttled to {cap}: {f:.2}/s");
    assert_eq!(h.scene_src(&id).pid(), pid, "same worker");
    // Calm for 5 s of the budget's clock: one step up.
    budget(&mut h, t0 + Duration::from_secs(1), 0.0, true);
    budget(&mut h, t0 + Duration::from_millis(5500), 0.0, true);
    assert_eq!(h.scene_src(&id).throttle_cap(), Some(cap), "not before 5 s calm");
    budget(&mut h, t0 + Duration::from_secs(6), 0.0, true);
    assert_eq!(h.scene_src(&id).throttle_cap(), Some(cap * 1.25));
    // The setting off: fixed fps again at once.
    budget(&mut h, t0 + Duration::from_secs(7), 10.0, false);
    assert_eq!(h.scene_src(&id).throttle_cap(), None);
    assert_eq!(h.scene_src(&id).tick_hz(), 30.0);
    budget(&mut h, t0 + Duration::from_secs(10), 50.0, false);
    assert_eq!(h.scene_src(&id).throttle_cap(), None, "off never throttles");
    tick_for(&mut h, Duration::from_millis(500));
    let f = fps(&mut h, Duration::from_secs(2));
    assert!((f - 30.0).abs() <= 2.0, "back at 30: {f:.2}/s");
    assert_eq!(h.scene_src(&id).pid(), pid, "same worker");

    let light = h.scene("t8-light", &spec(Pattern::FrameIndex), json!({}));
    h.show("VIRTUAL-1", &light);
    h.wait_ready(&light);
    tick_for(&mut h, Duration::from_millis(2500));
    let (p50, p95) = h.scene_src(&light).gpu_ms();
    let (p50, p95) = (p50.expect("measured GPU time"), p95.unwrap());
    println!("light synthetic scene: gpu_ms p50 {p50:.3} p95 {p95:.3}");
    assert!(p50 > 0.0 && p50 < 5.0, "a trivial frame: {p50} ms");
    for i in 0..10 {
        h.host
            .scene_mut(&light)
            .unwrap()
            .observe_budget(t0 + Duration::from_millis(500 * i), 10.0, true);
    }
    assert_eq!(h.scene_src(&light).throttle_cap(), None, "a light worker is never the cause");
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
    std::process::Command::new(env!("CARGO_BIN_EXE_liascape-scene-worker"))
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
        "liascape-scene-test-{}-{name}-{}",
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
    let mut o = SceneOpts::new(dir, env!("CARGO_BIN_EXE_liascape-scene-worker"));
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
        println!("SKIP: liascape-scene-worker built without LWE");
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
        println!("SKIP: liascape-scene-worker built without LWE");
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
        println!("SKIP: liascape-scene-worker built without LWE");
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

/// On-machine (D7): real Workshop scenes with the owner's WE assets, `LIASCAPE_PLAYER_TEST_SCENES=<the
/// 431960 folder>` (SFW: `~/.local/share/Steam/steamapps/workshop/content/431960`), else SKIP
/// (FAIL under `LIASCAPE_REQUIRE_SCENES=1`). Each: Ready ≤ 3 s (incl. the cold build), frames at 1 s
/// and 3 s of scene time non-blank, opaque and different, exported at the cover size (never
/// native), no GL error. Frames go to `LIASCAPE_PLAYER_TEST_SCENES_OUT` (default
/// `<tmp>/liascape-real-scenes`).
#[test]
fn real_scenes_render_and_animate() {
    let _g = gpu_lock();
    let require = std::env::var("LIASCAPE_REQUIRE_SCENES").is_ok_and(|v| v == "1");
    let skip = |why: &str| {
        assert!(!require, "LIASCAPE_REQUIRE_SCENES=1 but: {why}");
        println!("SKIP: {why}");
    };
    let Some(root) = std::env::var_os("LIASCAPE_PLAYER_TEST_SCENES").map(PathBuf::from) else {
        return skip("LIASCAPE_PLAYER_TEST_SCENES is not set");
    };
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    if !worker_has_lwe() {
        return skip("liascape-scene-worker built without LWE");
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let assets = match liascape_player::scene::assets::resolve(None, &home) {
        Ok(a) => a,
        Err(e) => return skip(&e),
    };
    let out = std::env::var_os("LIASCAPE_PLAYER_TEST_SCENES_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("liascape-real-scenes"));
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
                    s.step_status() == liascape_player::sources::StepStatus::Done
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

// ---------------------------------------------------------------- Task 10: the crash policy

/// A crashed worker's restart resumes at the scene time of the frame it left on screen —
/// exactly that `t`, not the compositor's clock moved on by the outage; the picture is held
/// (identical) from the restart until the new worker's first frame, and `time_pos` never
/// jumps (the scene clock stops while no worker renders). RED before: the first frame of the
/// restarted worker was the outage past the held one (the clock ran through the restart).
#[test]
fn crash_holds_last_frame_and_resumes_at_position() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let id = h.scene(
        "t10-resume",
        &spec(Pattern::FrameIndex),
        json!({"position": 2.0}),
    );
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    let tp = format!("{id}.time_pos");
    assert!(
        h.tick_until(Duration::from_secs(10), |h| h.f64(&tp) >= 3.0),
        "never reached t = 3"
    );
    let period = 1.0 / h.scene_src(&id).tick_hz();
    let pid = h.scene_src(&id).pid().expect("a worker");
    let gen0 = h.scene_src(&id).stats().latched_gen;
    let kill_tp = h.f64(&tp);
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let mut samples: Vec<(Instant, f64)> = vec![(Instant::now(), kill_tp)];
    // (the held frame's t, the output's marker) once the restart is under way
    let mut held: Option<(f64, [u8; 4])> = None;
    let mut held_checks = 0;
    let ok = h.tick_until(Duration::from_secs(10), |h| {
        samples.push((Instant::now(), h.f64(&tp)));
        let s = h.scene_src(&id);
        if s.stats().latched_gen != gen0 {
            return true;
        }
        if s.stats().restarts >= 1 {
            let px = h.out_corner("VIRTUAL-1");
            match &held {
                None => held = Some((s.latched_t().expect("the held frame"), px)),
                Some((_, p)) => {
                    assert_eq!(&px, p, "the held picture changed during the restart");
                    held_checks += 1;
                }
            }
        }
        false
    });
    assert!(ok, "no frame from the restarted worker: {:?}", h.src_events);
    let (held_t, _) = held.expect("the restart was seen before the new frame");
    assert!(held_checks > 0, "the restart took no tick at all");
    let s = h.scene_src(&id);
    assert_ne!(s.pid(), Some(pid), "a new worker");
    assert_eq!(s.stats().restarts, 1);
    let t_new = s.latched_t().unwrap();
    println!("killed at time_pos {kill_tp:.4}; held t {held_t:.4}; first new frame t {t_new:.4}");
    assert!(
        (t_new - held_t).abs() < 1e-6,
        "the restarted worker's first frame is t = {t_new}, the held frame was t = {held_t}"
    );
    assert!(
        held_t >= kill_tp - period - 0.02,
        "the held frame t = {held_t} is more than a tick before the kill ({kill_tp})"
    );
    let tp_new = h.f64(&tp);
    assert!(
        (tp_new - held_t).abs() <= period + 0.02,
        "time_pos {tp_new} at the first new frame, the held frame was {held_t}"
    );
    for w in samples.windows(2) {
        let (dw, ds) = (
            w[1].0.duration_since(w[0].0).as_secs_f64(),
            w[1].1 - w[0].1,
        );
        assert!(
            ds >= -0.1 && ds <= dw + 0.1,
            "time_pos jumped {:.3} → {:.3} in {dw:.3} s",
            w[0].1,
            w[1].1
        );
    }
    // It plays on from there.
    tick_for(&mut h, Duration::from_millis(400));
    let tp_after = h.f64(&tp);
    assert!(
        (tp_after - held_t - 0.4).abs() <= 0.15,
        "time_pos {tp_after} 0.4 s after resuming at {held_t}"
    );
    assert_eq!(readies(&h, &id), 1, "a restart is not a load");
    assert!(
        !h.src_events
            .iter()
            .any(|(_, i, e)| i == &id && matches!(e, SourceEvent::Error { .. })),
        "{:?}",
        h.src_events
    );
}

/// The green test preview (mpv's ordered dither may move a channel by one).
fn green(px: [u8; 4]) -> bool {
    px[0] <= 3 && px[1] >= 252 && px[2] <= 3
}

/// A worker that crashes before its first frame (every one: `crash_after_ms 0`) has nothing
/// to hold: the source shows its `preview` image while it restarts and once it is broken
/// (3 restarts) — never black, never anything else. `broken` is observed in the graph, one
/// `Error`, no `Ready`.
#[test]
fn crash_before_first_frame_shows_preview() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let png = common::solid_png("t10-preview-green", [0, 255, 0]);
    let mut sp = spec(Pattern::Solid);
    sp.rgb = [255, 0, 0];
    sp.crash_after_ms = Some(0);
    let id = h.scene(
        "t10-preview",
        &sp,
        json!({"preview": png.to_str().unwrap()}),
    );
    h.show("VIRTUAL-1", &id);
    let mut shown_before_broken = 0;
    let ok = h.tick_until(Duration::from_secs(15), |h| {
        let s = h.scene_src(&id);
        if let Some(t) = s.texture() {
            let px = common::read_rgba(&h.gfx, t, t.w / 2, t.h / 2);
            assert!(green(px), "only the preview may show: {px:?}");
            if s.broken().is_none() {
                shown_before_broken += 1;
            }
        }
        s.broken().is_some()
    });
    assert!(ok, "never broken: {:?}", h.src_events);
    // The preview stays (an image open may still be finishing at the break).
    let ok = h.tick_until(Duration::from_secs(5), |h| {
        h.scene_src(&id).texture().is_some() && green(h.out_corner("VIRTUAL-1"))
    });
    assert!(ok, "the broken scene shows its preview on the output");
    tick_for(&mut h, Duration::from_millis(300));
    assert!(green(h.out_corner("VIRTUAL-1")), "and keeps it");
    println!("preview shown on {shown_before_broken} ticks before the break");
    let s = h.scene_src(&id);
    assert_eq!(s.stats().restarts, 3);
    assert!(s.pid().is_none(), "no worker once broken");
    assert!(h.bool(&format!("{id}.broken")), "observed `broken`");
    assert_eq!(readies(&h, &id), 0, "never a frame of the scene itself");
    let errors = h
        .src_events
        .iter()
        .filter(|(_, i, e)| i == &id && matches!(e, SourceEvent::Error { .. }))
        .count();
    assert_eq!(errors, 1, "{:?}", h.src_events);
}

/// A GPU context loss in the worker (`EGL_NV_robustness_video_memory_purge`, a GPU reset —
/// here the synthetic `context_lost_after_ms`: every worker reports `ContextLost` 600 ms after
/// its start) is a crash restart: the compositor kills and restarts it through the same
/// budget, the frame held meanwhile; the 4th within 60 s is broken, its crash record naming
/// the context loss.
#[test]
fn context_lost_is_a_restart() {
    let Some((_g, mut h)) = harness(&["VIRTUAL-1"]) else {
        return;
    };
    let mut sp = spec(Pattern::FrameIndex);
    sp.context_lost_after_ms = Some(600);
    let id = h.scene("t10-ctxlost", &sp, json!({}));
    h.show("VIRTUAL-1", &id);
    h.wait_ready(&id);
    let pid = h.scene_src(&id).pid().unwrap();
    let gen0 = h.scene_src(&id).stats().latched_gen;
    let ok = h.tick_until(Duration::from_secs(10), |h| {
        assert!(h.scene_src(&id).texture().is_some(), "the frame went away");
        h.scene_src(&id).stats().latched_gen > gen0
    });
    assert!(ok, "no restart after the context loss: {:?}", h.src_events);
    let s = h.scene_src(&id);
    assert_eq!(s.stats().restarts, 1);
    assert_ne!(s.pid(), Some(pid), "a new worker");
    let tail = s.log_tail().join("\n");
    assert!(
        tail.contains("GL context lost"),
        "the restart names the context loss:\n{tail}"
    );
    assert!(s.broken().is_none() && s.error().is_none());
    let ok = h.tick_until(Duration::from_secs(15), |h| {
        h.scene_src(&id).broken().is_some()
    });
    assert!(ok, "never broken after repeated context losses");
    let s = h.scene_src(&id);
    assert_eq!(s.stats().restarts, 3);
    assert!(s.texture().is_some(), "the last frame is kept");
    let reason = s.broken().unwrap().to_string();
    let rec = reason
        .split("crash record ")
        .nth(1)
        .and_then(|r| r.strip_suffix(')'))
        .expect("the record path in the reason");
    let rec: serde_json::Value =
        serde_json::from_slice(&std::fs::read(rec).expect("the crash record")).unwrap();
    assert!(
        rec["reason"]
            .as_str()
            .is_some_and(|r| r.contains("GL context lost")),
        "{rec}"
    );
    assert!(h.bool(&format!("{id}.broken")));
}

// ---- Scene loudness: the shared `Book` across sources (player-core.md § "Scene loudness") ----

fn tone_spec() -> SyntheticSpec {
    SyntheticSpec {
        pattern: Pattern::Solid,
        native: [640, 360],
        has_audio: true,
        tone_hz: 1000.0,
        tone_dbfs: -20.0,
        ..SyntheticSpec::default()
    }
}

/// A learner state of `blocks` blocks at −20 LUFS (`Learner::state_json`'s shape).
fn loud_state(blocks: u64) -> serde_json::Value {
    serde_json::json!({"v": 1, "first": 500, "counts": [blocks], "peak_dbfs": -20.0})
}

fn open_loud(
    gfx: &Gfx,
    name: &str,
    id: &str,
    book: &liascape_player::audio::loudness::SharedBook,
    tweak: impl FnOnce(&mut SceneOpts),
) -> SceneSource {
    open_with(gfx, name, &tone_spec(), |o| {
        o.id = id.into();
        o.tick_hz = 30.0;
        o.max_size = [640, 360];
        o.loudness_window_s = 2.0;
        o.loudness_cap_s = 1e6;
        o.loudness_book = Some(book.clone());
        tweak(o);
    })
}

/// Update every source until `f` says stop or `limit` passes.
fn run_all(
    gfx: &Gfx,
    srcs: &mut [&mut SceneSource],
    limit: Duration,
    mut f: impl FnMut(&mut [&mut SceneSource]) -> bool,
) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(2));
        for s in srcs.iter_mut() {
            s.update(gfx);
            assert!(s.error().is_none(), "scene error: {:?}", s.error());
        }
        if f(srcs) {
            return true;
        }
    }
    false
}

fn loud(s: &SceneSource, k: &str) -> serde_json::Value {
    s.worker_info()["loudness"][k].clone()
}

/// A source dropped without its teardown (`Drop`) still leaves its path: the older source of
/// the path measures on (RED without the `Drop`: the dropped one stays the head and nothing is
/// measured any more). Also: the newer source measures only from its first segment.
#[test]
fn dropped_scene_source_hands_its_loudness_over() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let book = liascape_player::audio::loudness::Book::shared();
    let mut a = open_loud(&gfx, "loud-drop", "a", &book, |_| {});
    assert!(run_all(&gfx, &mut [&mut a], Duration::from_secs(10), |s| {
        loud(s[0], "seconds").as_f64().unwrap_or(0.0) >= 0.5
    }), "a measures");
    let mut b = open_loud(&gfx, "loud-drop", "b", &book, |_| {});
    assert_eq!(loud(&b, "measuring"), serde_json::json!(false), "b pending until it sounds");
    assert_eq!(loud(&a, "measuring"), serde_json::json!(true));
    assert!(run_all(&gfx, &mut [&mut a, &mut b], Duration::from_secs(10), |s| {
        loud(s[1], "measuring") == serde_json::json!(true)
    }), "b takes over at its first segment");
    assert!(b.worker_info()["loudness"]["received"].as_u64().unwrap() > 0);
    assert_eq!(loud(&a, "measuring"), serde_json::json!(false));
    drop(b);
    assert_eq!(loud(&a, "measuring"), serde_json::json!(true), "a measures on after b's drop");
    let s0 = loud(&a, "seconds").as_f64().unwrap();
    assert!(run_all(&gfx, &mut [&mut a], Duration::from_secs(10), |s| {
        loud(s[0], "seconds").as_f64().unwrap_or(0.0) >= s0 + 0.5
    }), "a's segments count again");
}

/// A meter switched off at the cap comes back on once the path's measurement isn't capped
/// any more (here: a second source adopts a seed with room under its own cap) — RED before:
/// `update` never asked again, `a` stayed silent to the book for good.
#[test]
fn scene_meter_comes_back_on_when_the_path_is_no_longer_capped() {
    let _g = gpu_lock();
    let Some(gfx) = common::headless_gl() else {
        return;
    };
    let book = liascape_player::audio::loudness::Book::shared();
    // a: cap 1 s, seeded with 1 s → capped from the start: its worker never meters.
    let mut a = open_loud(&gfx, "loud-meter", "a", &book, |o| {
        o.loudness_window_s = 1.0;
        o.loudness_cap_s = 1.0;
        o.loudness_seed = Some(loud_state(10));
    });
    run_all(&gfx, &mut [&mut a], Duration::from_millis(1500), |_| false);
    assert_eq!(loud(&a, "capped"), serde_json::json!(true));
    assert_eq!(loud(&a, "meter"), serde_json::json!(false));
    assert_eq!(loud(&a, "received"), serde_json::json!(0), "nothing metered while capped");
    // b joins with a longer seed under a large cap: adopted, the path isn't capped any more.
    let mut b = open_loud(&gfx, "loud-meter", "b", &book, |o| {
        o.loudness_window_s = 1.0;
        o.loudness_cap_s = 1e6;
        o.loudness_seed = Some(loud_state(20));
        o.paused = true;
    });
    assert_eq!(loud(&a, "capped"), serde_json::json!(false));
    assert!(run_all(&gfx, &mut [&mut a, &mut b], Duration::from_secs(5), |s| {
        loud(s[0], "received").as_u64().unwrap_or(0) > 0
    }), "a meters again: {}", a.worker_info()["loudness"]);
    assert_eq!(loud(&a, "meter"), serde_json::json!(true));
    assert_eq!(loud(&a, "measuring"), serde_json::json!(true), "b (paused) is pending");
    let s0 = loud(&a, "seconds").as_f64().unwrap();
    assert!(run_all(&gfx, &mut [&mut a, &mut b], Duration::from_secs(5), |s| {
        loud(s[0], "seconds").as_f64().unwrap_or(0.0) >= s0 + 0.5
    }), "a measures");
}
