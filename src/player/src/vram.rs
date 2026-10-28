//! VRAM: measuring it and the two rules built on it (Phase 2 Task 8; owner decisions "VRAM
//! guard" and "VRAM, round 3"; `.claude/rules/player-core.md` § Scene worker → "GPU budget and
//! VRAM (Task 8)").
//!
//! **Measuring ([`Probe`]).** System-wide total/free VRAM and per-process use, from (first that
//! works, `LP_PLAYER_VRAM_PROBE=auto`): NVIDIA's NVML (`libnvidia-ml.so.1`, **dlopened** — never
//! a link dependency), AMD's `mem_info_vram_{total,used}` sysfs + `/proc/<pid>/fdinfo`
//! `drm-*-vram`/`local` per process (AMD/Intel), else `nvidia-smi` (a process per sample, so
//! every [`NVIDIA_SMI_INTERVAL`]). `none` disables it; `fake:<file>` reads a JSON file each
//! sample — `{"total_mib", "free_mib", "procs": {"<pid>": mib}}` — so tests drive both rules
//! deterministically (a missing or bad file = no sample). A [`Monitor`] runs the probe on its own
//! thread (`lp-vram`), never the loop: NVML calls take ~1 ms, `nvidia-smi` ~50 ms.
//!
//! **The per-scene limit** (`player.scene_vram_limit_mib`, 0 = off): the runtime stops a scene
//! worker whose own VRAM stays above it for [`Timing::scene_hold`] (2 s — a load's transient
//! peak isn't a reason); see `SceneSource::stop_for_vram`.
//!
//! **The low-VRAM rule ([`LowVram`], `player.vram_low_mode` stop|pause|off, default stop)** —
//! a pure state machine over samples, thresholds relative to the card:
//! - **low** = free < [`low_mib`]`(total)` = max([`LOW_FLOOR_MIB`] 512, [`LOW_FRACTION`] 5 % of
//!   total), held for [`Timing::enter_hold`] (3 s) without a sample at or above it → `Engage`.
//!   A short dip (a game loading a level, a browser tab) never fires — WE's version false-fires
//!   under light load (Steam report); this one needs seconds of genuinely low memory.
//! - **free again** = free − reserve ≥ [`resume_mib`]`(total)` = low + max([`RESUME_MARGIN_FLOOR_MIB`]
//!   1024, [`RESUME_MARGIN_FRACTION`] 10 %), held for the resume hold (10 s) → `Release`. The
//!   **reserve** is what our resumed sources will take back — in `stop` mode the VRAM our own
//!   processes used when it engaged (per-process numbers), or, without them, how much free VRAM
//!   rose in the [`Timing::settle`] (2 s) after the stop; 0 in `pause` mode (nothing freed). So
//!   the memory we released ourselves never reads as "free again" (no stop → resume → low loop).
//! - **anti-flap**: an `Engage` within [`FLAP_WINDOW`] (60 s) of the last `Release` doubles the
//!   resume hold (10 → 20 → 40 … ≤ [`RESUME_HOLD_MAX`] 160 s); [`FLAP_RESET`] (5 min) without
//!   one resets it.
//! - no sample for [`UNAVAILABLE_RELEASE`] (30 s) while engaged → `Release` (a probe that died
//!   must never keep the wallpaper stopped).
//!
//! The runtime applies the actions (`Runtime::vram_tick`): `Engage` holds the player paused
//! (composed with `player.paused` — the R75/R88 machinery ramps every source out and freezes
//! time) and, in `stop` mode, then drops every video/image/scene source's decoder or worker
//! (`SourceHost::suspend_media` — a still of its last frame stays shown); `Release` reopens them
//! at their positions, waits for their first frames, then lets go of the pause.

use std::collections::BTreeMap;
use std::ffi::{CString, c_char, c_int, c_uint, c_void};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// Low = free below this floor…
pub const LOW_FLOOR_MIB: f64 = 512.0;
/// …or below this fraction of the total, whichever is larger.
pub const LOW_FRACTION: f64 = 0.05;
/// Free again = above low by this floor…
pub const RESUME_MARGIN_FLOOR_MIB: f64 = 1024.0;
/// …or this fraction of the total, whichever is larger.
pub const RESUME_MARGIN_FRACTION: f64 = 0.10;
/// An engage this soon after a release doubles the resume hold.
pub const FLAP_WINDOW: Duration = Duration::from_secs(60);
/// The resume hold never grows past this.
pub const RESUME_HOLD_MAX: Duration = Duration::from_secs(160);
/// This long without an engage resets the resume hold.
pub const FLAP_RESET: Duration = Duration::from_secs(300);
/// No sample for this long while engaged → release.
pub const UNAVAILABLE_RELEASE: Duration = Duration::from_secs(30);
/// Sampling period of NVML / sysfs / a fake.
pub const INTERVAL: Duration = Duration::from_secs(1);
/// Sampling period of the `nvidia-smi` fallback (a process per sample).
pub const NVIDIA_SMI_INTERVAL: Duration = Duration::from_secs(3);

/// The low threshold for a card of `total_mib`.
pub fn low_mib(total_mib: f64) -> f64 {
    LOW_FLOOR_MIB.max(LOW_FRACTION * total_mib)
}

/// Free VRAM (minus the reserve) needed before the rule releases.
pub fn resume_mib(total_mib: f64) -> f64 {
    low_mib(total_mib) + RESUME_MARGIN_FLOOR_MIB.max(RESUME_MARGIN_FRACTION * total_mib)
}

/// The rule's timing. Production: [`Timing::default`]; tests shorten it with
/// `LP_PLAYER_VRAM_TIMING=<interval_ms>,<enter_ms>,<resume_ms>,<settle_ms>,<scene_hold_ms>`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// Sampling period (a probe may ask for a longer one).
    pub interval: Duration,
    pub enter_hold: Duration,
    /// The base resume hold (doubled by flapping).
    pub resume_hold: Duration,
    /// After a stop, how long until the freed VRAM is measured (when no per-process numbers).
    pub settle: Duration,
    /// How long a scene must stay over its limit.
    pub scene_hold: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            interval: INTERVAL,
            enter_hold: Duration::from_secs(3),
            resume_hold: Duration::from_secs(10),
            settle: Duration::from_secs(2),
            scene_hold: Duration::from_secs(2),
        }
    }
}

impl Timing {
    /// The default, or `LP_PLAYER_VRAM_TIMING` (test knob; a bad value is ignored).
    pub fn from_env() -> Timing {
        let mut t = Timing::default();
        if let Ok(v) = std::env::var("LP_PLAYER_VRAM_TIMING") {
            let ms: Vec<u64> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if ms.len() == 5 {
                let d = Duration::from_millis;
                t = Timing {
                    interval: d(ms[0]),
                    enter_hold: d(ms[1]),
                    resume_hold: d(ms[2]),
                    settle: d(ms[3]),
                    scene_hold: d(ms[4]),
                };
            }
        }
        t
    }
}

// ------------------------------------------------------------------------ samples + probes

/// One measurement.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub total_mib: f64,
    pub free_mib: f64,
    /// VRAM per process (MiB) for the pids asked about that the probe could see; `None` = this
    /// probe has no per-process numbers.
    pub procs: Option<BTreeMap<u32, f64>>,
}

impl Sample {
    pub fn to_json(&self) -> Value {
        json!({
            "total_mib": self.total_mib,
            "free_mib": self.free_mib,
            "used_mib": self.total_mib - self.free_mib,
            "procs": self.procs.as_ref().map(|m| m.iter()
                .map(|(p, v)| (p.to_string(), json!(v))).collect::<serde_json::Map<_, _>>()),
        })
    }
}

/// A VRAM source. Runs on the [`Monitor`]'s thread only.
pub trait Probe: Send {
    fn name(&self) -> &'static str;
    /// Measure (blocking is fine: off the loop). `pids` = the processes whose use is wanted.
    fn sample(&mut self, pids: &[u32]) -> Result<Sample, String>;
    /// The shortest sampling period this probe allows.
    fn min_interval(&self) -> Duration {
        Duration::ZERO
    }
}

/// No measurement (`LP_PLAYER_VRAM_PROBE=none`, or nothing found): every sample is `Err`.
pub struct NoProbe(pub String);

impl Probe for NoProbe {
    fn name(&self) -> &'static str {
        "none"
    }
    fn sample(&mut self, _: &[u32]) -> Result<Sample, String> {
        Err(self.0.clone())
    }
}

/// `fake:<file>` (tests).
pub struct FakeProbe(pub PathBuf);

impl Probe for FakeProbe {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn sample(&mut self, pids: &[u32]) -> Result<Sample, String> {
        let b = std::fs::read(&self.0).map_err(|e| format!("{}: {e}", self.0.display()))?;
        let v: Value = serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", self.0.display()))?;
        let num = |k: &str| {
            v.get(k)
                .and_then(Value::as_f64)
                .ok_or_else(|| format!("{}: no {k}", self.0.display()))
        };
        let procs = v.get("procs").and_then(Value::as_object).map(|m| {
            m.iter()
                .filter_map(|(k, x)| Some((k.parse::<u32>().ok()?, x.as_f64()?)))
                .filter(|(p, _)| pids.contains(p))
                .collect()
        });
        Ok(Sample {
            total_mib: num("total_mib")?,
            free_mib: num("free_mib")?,
            procs,
        })
    }
}

/// The probe `LP_PLAYER_VRAM_PROBE` asks for (`auto` when unset): `none`, `fake:<file>`,
/// `nvml`, `drm`, `nvidia-smi`, or `auto` = the first of NVML, DRM sysfs, `nvidia-smi` that
/// works here.
pub fn probe_from_env() -> Box<dyn Probe> {
    let want = std::env::var("LP_PLAYER_VRAM_PROBE").unwrap_or_else(|_| "auto".into());
    if let Some(f) = want.strip_prefix("fake:") {
        return Box::new(FakeProbe(PathBuf::from(f)));
    }
    match want.as_str() {
        "none" | "off" => Box::new(NoProbe("disabled by LP_PLAYER_VRAM_PROBE=none".into())),
        "nvml" => nvml::Nvml::open()
            .map(|n| Box::new(n) as Box<dyn Probe>)
            .unwrap_or_else(|e| Box::new(NoProbe(e))),
        "drm" => DrmProbe::find()
            .map(|d| Box::new(d) as Box<dyn Probe>)
            .unwrap_or_else(|| Box::new(NoProbe("no AMD mem_info_vram_* in /sys/class/drm".into()))),
        "nvidia-smi" => Box::new(NvidiaSmi),
        _ => auto_probe(),
    }
}

fn auto_probe() -> Box<dyn Probe> {
    let nv = match nvml::Nvml::open() {
        Ok(n) => return Box::new(n),
        Err(e) => e,
    };
    if let Some(d) = DrmProbe::find() {
        return Box::new(d);
    }
    let mut smi = NvidiaSmi;
    if smi.sample(&[]).is_ok() {
        return Box::new(smi);
    }
    Box::new(NoProbe(format!(
        "no VRAM measurement: NVML ({nv}), no AMD mem_info_vram_* sysfs, no nvidia-smi"
    )))
}

// ------------------------------------------------------------------------ DRM (AMD / Intel)

/// AMD's sysfs totals + `fdinfo` per process.
pub struct DrmProbe {
    device: PathBuf,
}

impl DrmProbe {
    /// The card with the most VRAM that has `mem_info_vram_total`.
    pub fn find() -> Option<DrmProbe> {
        let mut best: Option<(u64, PathBuf)> = None;
        for e in std::fs::read_dir("/sys/class/drm").ok()?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with("card") || name.contains('-') {
                continue;
            }
            let dev = e.path().join("device");
            if let Some(t) = read_u64(&dev.join("mem_info_vram_total"))
                && best.as_ref().is_none_or(|(b, _)| t > *b)
            {
                best = Some((t, dev));
            }
        }
        best.map(|(_, device)| DrmProbe { device })
    }
}

fn read_u64(p: &Path) -> Option<u64> {
    std::fs::read_to_string(p).ok()?.trim().parse().ok()
}

impl Probe for DrmProbe {
    fn name(&self) -> &'static str {
        "drm"
    }
    fn sample(&mut self, pids: &[u32]) -> Result<Sample, String> {
        let total = read_u64(&self.device.join("mem_info_vram_total"))
            .ok_or("mem_info_vram_total unreadable")?;
        let used =
            read_u64(&self.device.join("mem_info_vram_used")).ok_or("mem_info_vram_used unreadable")?;
        let mib = |b: u64| b as f64 / (1024.0 * 1024.0);
        let procs = pids
            .iter()
            .filter_map(|&p| fdinfo_vram_mib(p).map(|m| (p, m)))
            .collect();
        Ok(Sample {
            total_mib: mib(total),
            free_mib: mib(total.saturating_sub(used)),
            procs: Some(procs),
        })
    }
}

/// A process's VRAM from `/proc/<pid>/fdinfo/*` (DRM client stats: `drm-memory-vram` on amdgpu,
/// `drm-total-local0`/`drm-resident-*` on i915/xe, …), each DRM client counted once.
pub fn fdinfo_vram_mib(pid: u32) -> Option<f64> {
    let dir = std::fs::read_dir(format!("/proc/{pid}/fdinfo")).ok()?;
    let mut clients: BTreeMap<String, f64> = BTreeMap::new();
    for e in dir.flatten() {
        let Ok(text) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        if let Some((client, mib)) = parse_fdinfo(&text) {
            let c = clients.entry(client).or_insert(0.0);
            *c = c.max(mib);
        }
    }
    (!clients.is_empty()).then(|| clients.values().sum())
}

/// One fdinfo file → `(drm-client-id, VRAM MiB)`, or `None` if it isn't a DRM client. Per
/// region (a key's last `-` part: `vram`, `vram0`, `local0`…) the resident number wins over the
/// legacy `drm-memory-` one, which wins over `drm-total-`; regions summed.
pub fn parse_fdinfo(text: &str) -> Option<(String, f64)> {
    let mut client = None;
    // region → (rank, MiB)
    let mut regions: BTreeMap<String, (u8, f64)> = BTreeMap::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        if k == "drm-client-id" {
            client = Some(v.to_string());
            continue;
        }
        let (rank, region) = if let Some(r) = k.strip_prefix("drm-resident-") {
            (3, r)
        } else if let Some(r) = k.strip_prefix("drm-memory-") {
            (2, r)
        } else if let Some(r) = k.strip_prefix("drm-total-") {
            (1, r)
        } else {
            continue;
        };
        if !(region.starts_with("vram") || region.starts_with("local")) {
            continue;
        }
        let mut it = v.split_whitespace();
        let Some(n) = it.next().and_then(|n| n.parse::<f64>().ok()) else {
            continue;
        };
        let mib = match it.next().unwrap_or("") {
            "KiB" => n / 1024.0,
            "MiB" => n,
            "GiB" => n * 1024.0,
            _ => n / (1024.0 * 1024.0), // bytes
        };
        let e = regions.entry(region.to_string()).or_insert((0, 0.0));
        if rank > e.0 {
            *e = (rank, mib);
        }
    }
    let client = client?;
    Some((client, regions.values().map(|(_, m)| m).sum()))
}

// ------------------------------------------------------------------------ nvidia-smi

/// `nvidia-smi` (plain output: its memory line and process table — `--query-compute-apps`
/// lists compute processes only, never a GL client like ours).
pub struct NvidiaSmi;

impl Probe for NvidiaSmi {
    fn name(&self) -> &'static str {
        "nvidia-smi"
    }
    fn min_interval(&self) -> Duration {
        NVIDIA_SMI_INTERVAL
    }
    fn sample(&mut self, pids: &[u32]) -> Result<Sample, String> {
        let out = std::process::Command::new("nvidia-smi")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("nvidia-smi: {e}"))?;
        if !out.status.success() {
            return Err(format!("nvidia-smi: {}", out.status));
        }
        let mut s = parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
            .ok_or("nvidia-smi: no memory line")?;
        if let Some(m) = s.procs.as_mut() {
            m.retain(|p, _| pids.contains(p));
        }
        Ok(s)
    }
}

/// Plain `nvidia-smi` output → the first GPU's `<used>MiB / <total>MiB` and every process row's
/// `<pid> … <mem>MiB`.
pub fn parse_nvidia_smi(text: &str) -> Option<Sample> {
    let mut mem = None;
    let mut procs = BTreeMap::new();
    let mut in_procs = false;
    for line in text.lines() {
        if line.contains("Processes:") {
            in_procs = true;
            continue;
        }
        let mibs: Vec<f64> = line
            .split(|c: char| !(c.is_ascii_digit() || c == 'M' || c == 'i' || c == 'B'))
            .filter_map(|w| w.strip_suffix("MiB")?.parse().ok())
            .collect();
        if !in_procs {
            if mem.is_none() && mibs.len() >= 2 && line.contains('/') {
                mem = Some((mibs[0], mibs[1]));
            }
            continue;
        }
        // `|    0   N/A  N/A   1774158    C+G   …/lp-player     194MiB |`
        let cols: Vec<&str> = line
            .trim_matches(|c| c == '|' || c == ' ')
            .split_whitespace()
            .collect();
        if cols.len() >= 6
            && let (Some(pid), Some(&last)) = (cols.get(3).and_then(|p| p.parse::<u32>().ok()), mibs.last())
        {
            *procs.entry(pid).or_insert(0.0) += last;
        }
    }
    let (used, total) = mem?;
    Some(Sample {
        total_mib: total,
        free_mib: (total - used).max(0.0),
        procs: Some(procs),
    })
}

// ------------------------------------------------------------------------ NVML

mod nvml {
    use super::*;

    type Ret = c_int;
    type Dev = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Memory {
        total: u64,
        free: u64,
        used: u64,
    }

    /// `nvmlProcessInfo_t` (v2/v3 layout).
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ProcInfo {
        pid: c_uint,
        used: u64,
        gpu_instance: c_uint,
        compute_instance: c_uint,
    }

    const NOT_AVAILABLE: u64 = u64::MAX;
    const INSUFFICIENT_SIZE: Ret = 7;
    const MAX_PROCS: usize = 512;

    type ProcsFn = unsafe extern "C" fn(Dev, *mut c_uint, *mut ProcInfo) -> Ret;

    /// `libnvidia-ml.so.1`, dlopened (never linked).
    pub struct Nvml {
        lib: *mut c_void,
        shutdown: unsafe extern "C" fn() -> Ret,
        count: unsafe extern "C" fn(*mut c_uint) -> Ret,
        handle: unsafe extern "C" fn(c_uint, *mut Dev) -> Ret,
        memory: unsafe extern "C" fn(Dev, *mut Memory) -> Ret,
        graphics: Option<ProcsFn>,
        compute: Option<ProcsFn>,
        buf: Vec<ProcInfo>,
    }

    // The handle is only used from the monitor's thread (moved there once).
    unsafe impl Send for Nvml {}

    const CANDIDATES: [&str; 5] = [
        "libnvidia-ml.so.1",
        "/run/opengl-driver/lib/libnvidia-ml.so.1",
        "/usr/lib/libnvidia-ml.so.1",
        "/usr/lib64/libnvidia-ml.so.1",
        "/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1",
    ];

    unsafe fn sym<T: Copy>(lib: *mut c_void, name: &str) -> Option<T> {
        let c = CString::new(name).ok()?;
        let p = unsafe { libc::dlsym(lib, c.as_ptr() as *const c_char) };
        (!p.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
    }

    impl Nvml {
        pub fn open() -> Result<Nvml, String> {
            let mut lib = std::ptr::null_mut();
            for c in CANDIDATES {
                let name = CString::new(c).unwrap();
                lib = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
                if !lib.is_null() {
                    break;
                }
            }
            if lib.is_null() {
                return Err("libnvidia-ml.so.1 not found".into());
            }
            let fail = |what: &str| {
                unsafe { libc::dlclose(lib) };
                Err(format!("NVML: {what}"))
            };
            let (Some(init), Some(shutdown), Some(count), Some(handle), Some(memory)) = (unsafe {
                (
                    sym::<unsafe extern "C" fn() -> Ret>(lib, "nvmlInit_v2"),
                    sym(lib, "nvmlShutdown"),
                    sym(lib, "nvmlDeviceGetCount_v2"),
                    sym(lib, "nvmlDeviceGetHandleByIndex_v2"),
                    sym(lib, "nvmlDeviceGetMemoryInfo"),
                )
            }) else {
                return fail("missing entry points");
            };
            let r = unsafe { init() };
            if r != 0 {
                return fail(&format!("nvmlInit_v2 returned {r}"));
            }
            let graphics = unsafe {
                sym::<ProcsFn>(lib, "nvmlDeviceGetGraphicsRunningProcesses_v3")
                    .or_else(|| sym(lib, "nvmlDeviceGetGraphicsRunningProcesses_v2"))
            };
            let compute = unsafe {
                sym::<ProcsFn>(lib, "nvmlDeviceGetComputeRunningProcesses_v3")
                    .or_else(|| sym(lib, "nvmlDeviceGetComputeRunningProcesses_v2"))
            };
            Ok(Nvml {
                lib,
                shutdown,
                count,
                handle,
                memory,
                graphics,
                compute,
                buf: vec![ProcInfo::default(); MAX_PROCS],
            })
        }

        /// Per-process VRAM on `dev` (MiB), graphics and compute clients (max per pid).
        fn procs(&mut self, dev: Dev, out: &mut BTreeMap<u32, f64>) {
            for f in [self.graphics, self.compute].into_iter().flatten() {
                let mut n = MAX_PROCS as c_uint;
                let r = unsafe { f(dev, &mut n, self.buf.as_mut_ptr()) };
                if r != 0 && r != INSUFFICIENT_SIZE {
                    continue;
                }
                for p in &self.buf[..(n as usize).min(MAX_PROCS)] {
                    if p.used == NOT_AVAILABLE {
                        continue;
                    }
                    let mib = p.used as f64 / (1024.0 * 1024.0);
                    let e = out.entry(p.pid).or_insert(0.0);
                    *e = e.max(mib);
                }
            }
        }
    }

    impl Drop for Nvml {
        fn drop(&mut self) {
            // Never dlclose: a driver library with threads of its own may not survive being
            // unmapped; the handle stays (one per process lifetime at most per sampler).
            let _ = self.lib;
            unsafe { (self.shutdown)() };
        }
    }

    impl Probe for Nvml {
        fn name(&self) -> &'static str {
            "nvml"
        }
        fn sample(&mut self, pids: &[u32]) -> Result<Sample, String> {
            let mut n: c_uint = 0;
            let r = unsafe { (self.count)(&mut n) };
            if r != 0 || n == 0 {
                return Err(format!("nvmlDeviceGetCount_v2: {r}, {n} devices"));
            }
            let me = std::process::id();
            let mut chosen: Option<Memory> = None;
            let mut first: Option<Memory> = None;
            let mut procs = BTreeMap::new();
            for i in 0..n {
                let mut dev: Dev = std::ptr::null_mut();
                if unsafe { (self.handle)(i, &mut dev) } != 0 {
                    continue;
                }
                let mut m = Memory::default();
                if unsafe { (self.memory)(dev, &mut m) } != 0 {
                    continue;
                }
                let mut here = BTreeMap::new();
                self.procs(dev, &mut here);
                // The system numbers are the GPU the compositor itself runs on.
                if chosen.is_none() && here.contains_key(&me) {
                    chosen = Some(m);
                } else if first.is_none() {
                    first = Some(m);
                }
                for (p, v) in here {
                    *procs.entry(p).or_insert(0.0) += v;
                }
            }
            let m = chosen.or(first).ok_or("NVML: no device answered")?;
            let mib = |b: u64| b as f64 / (1024.0 * 1024.0);
            procs.retain(|p, _| pids.contains(p));
            let per_process = self.graphics.is_some() || self.compute.is_some();
            Ok(Sample {
                total_mib: mib(m.total),
                free_mib: mib(m.free),
                procs: per_process.then_some(procs),
            })
        }
    }
}

// ------------------------------------------------------------------------ the monitor thread

struct Shared {
    pids: Vec<u32>,
    latest: Option<(u64, Instant, Result<Sample, String>)>,
    seq: u64,
    stop: bool,
    probe: &'static str,
}

/// The probe on its own thread (`lp-vram`): one sample per period with the latest pid list;
/// [`Monitor::latest`] reads the newest. Dropping it stops the thread at its next wake (never
/// joined on the caller's thread).
pub struct Monitor {
    shared: Arc<(Mutex<Shared>, Condvar)>,
}

impl Monitor {
    pub fn start(mut probe: Box<dyn Probe>, interval: Duration) -> Monitor {
        let shared = Arc::new((
            Mutex::new(Shared {
                pids: Vec::new(),
                latest: None,
                seq: 0,
                stop: false,
                probe: probe.name(),
            }),
            Condvar::new(),
        ));
        let sh = shared.clone();
        let period = interval.max(probe.min_interval());
        let _ = std::thread::Builder::new()
            .name("lp-vram".into())
            .spawn(move || {
                let (lock, cv) = &*sh;
                loop {
                    let pids = {
                        let g = lock.lock().unwrap_or_else(|e| e.into_inner());
                        if g.stop {
                            return;
                        }
                        g.pids.clone()
                    };
                    let r = probe.sample(&pids);
                    let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
                    g.seq += 1;
                    let seq = g.seq;
                    g.latest = Some((seq, Instant::now(), r));
                    if probe.name() == "none" {
                        return; // nothing will ever measure: one answer is enough
                    }
                    let deadline = Instant::now() + period;
                    while !g.stop {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        g = cv.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner()).0;
                    }
                    if g.stop {
                        return;
                    }
                }
            });
        Monitor { shared }
    }

    /// The processes whose VRAM the next samples measure.
    pub fn set_pids(&self, pids: Vec<u32>) {
        let mut g = self.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.pids = pids;
    }

    /// The newest sample `(seq, taken at, result)`.
    pub fn latest(&self) -> Option<(u64, Instant, Result<Sample, String>)> {
        let g = self.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.latest.clone()
    }

    pub fn probe(&self) -> &'static str {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).probe
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        let (lock, cv) = &*self.shared;
        lock.lock().unwrap_or_else(|e| e.into_inner()).stop = true;
        cv.notify_all();
    }
}

// ------------------------------------------------------------------------ the low-VRAM rule

/// What the rule asks of the runtime.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    /// VRAM has been low for the hold: pause (and, in `stop` mode, free).
    Engage,
    /// VRAM is free again for the resume hold (or no sample for too long): resume.
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Normal,
    /// Below the low threshold since `since`.
    Pending { since: Duration },
    /// Engaged since `since`; `reserve` = what resuming takes back (None = not measured yet).
    Low {
        since: Duration,
        free_at_engage: f64,
        reserve: Option<f64>,
    },
    /// Free again since `since` (still engaged).
    Recovering {
        since: Duration,
        low_since: Duration,
        reserve: f64,
    },
}

/// The system low-VRAM rule (module docs). Pure: `observe` per sample with the caller's clock.
#[derive(Debug, Clone)]
pub struct LowVram {
    pub timing: Timing,
    phase: Phase,
    resume_hold: Duration,
    last_release: Option<Duration>,
    last_sample: Option<Duration>,
}

impl LowVram {
    pub fn new(timing: Timing) -> LowVram {
        LowVram {
            timing,
            phase: Phase::Normal,
            resume_hold: timing.resume_hold,
            last_release: None,
            last_sample: None,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn engaged(&self) -> bool {
        matches!(self.phase, Phase::Low { .. } | Phase::Recovering { .. })
    }

    /// The resume hold in force (doubled by flapping).
    pub fn resume_hold(&self) -> Duration {
        self.resume_hold
    }

    /// One sample at `now`: the card's `total`/`free` MiB, `ours` = the VRAM our own processes
    /// use (None = unknown), `frees` = the engaged mode frees our memory (`stop`).
    pub fn observe(
        &mut self,
        now: Duration,
        total: f64,
        free: f64,
        ours: Option<f64>,
        frees: bool,
    ) -> Option<Action> {
        self.last_sample = Some(now);
        let low = low_mib(total);
        let resume = resume_mib(total);
        match self.phase {
            Phase::Normal => {
                if free < low {
                    self.phase = Phase::Pending { since: now };
                    return self.observe_pending(now, low, free, ours, frees);
                }
                None
            }
            Phase::Pending { .. } => self.observe_pending(now, low, free, ours, frees),
            Phase::Low {
                since,
                free_at_engage,
                reserve,
            } => {
                let reserve = reserve.or_else(|| {
                    (now >= since + self.timing.settle).then(|| (free - free_at_engage).max(0.0))
                });
                self.phase = Phase::Low {
                    since,
                    free_at_engage,
                    reserve,
                };
                if let Some(r) = reserve
                    && free - r >= resume
                {
                    self.phase = Phase::Recovering {
                        since: now,
                        low_since: since,
                        reserve: r,
                    };
                    return self.observe_recovering(now, resume, free);
                }
                None
            }
            Phase::Recovering { .. } => self.observe_recovering(now, resume, free),
        }
    }

    fn observe_pending(
        &mut self,
        now: Duration,
        low: f64,
        free: f64,
        ours: Option<f64>,
        frees: bool,
    ) -> Option<Action> {
        let Phase::Pending { since } = self.phase else {
            return None;
        };
        if free >= low {
            self.phase = Phase::Normal;
            return None;
        }
        if now < since + self.timing.enter_hold {
            return None;
        }
        // Anti-flap: soon after the last release, wait longer before the next one.
        self.resume_hold = match self.last_release {
            Some(r) if now < r + FLAP_WINDOW => (self.resume_hold * 2).min(RESUME_HOLD_MAX),
            Some(r) if now < r + FLAP_RESET => self.resume_hold,
            _ => self.timing.resume_hold,
        };
        self.phase = Phase::Low {
            since: now,
            free_at_engage: free,
            reserve: if frees { ours } else { Some(0.0) },
        };
        Some(Action::Engage)
    }

    fn observe_recovering(&mut self, now: Duration, resume: f64, free: f64) -> Option<Action> {
        let Phase::Recovering {
            since,
            low_since,
            reserve,
        } = self.phase
        else {
            return None;
        };
        if free - reserve < resume {
            self.phase = Phase::Low {
                since: low_since,
                free_at_engage: free,
                reserve: Some(reserve),
            };
            return None;
        }
        if now < since + self.resume_hold {
            return None;
        }
        self.release(now);
        Some(Action::Release)
    }

    /// No usable sample at `now` (the probe failed): an engaged rule releases after
    /// [`UNAVAILABLE_RELEASE`] without one; a pending one starts over.
    pub fn unavailable(&mut self, now: Duration) -> Option<Action> {
        match self.phase {
            Phase::Pending { .. } => {
                self.phase = Phase::Normal;
                None
            }
            Phase::Low { .. } | Phase::Recovering { .. }
                if now >= self.last_sample.unwrap_or(now) + UNAVAILABLE_RELEASE =>
            {
                self.release(now);
                Some(Action::Release)
            }
            _ => None,
        }
    }

    /// Back to normal at once (the mode was turned off, or the caller released).
    pub fn release(&mut self, now: Duration) {
        if self.engaged() {
            self.last_release = Some(now);
        }
        self.phase = Phase::Normal;
    }

    pub fn to_json(&self, total: Option<f64>) -> Value {
        let (state, reserve) = match self.phase {
            Phase::Normal => ("normal", None),
            Phase::Pending { .. } => ("pending", None),
            Phase::Low { reserve, .. } => ("low", reserve),
            Phase::Recovering { reserve, .. } => ("recovering", Some(reserve)),
        };
        json!({
            "state": state,
            "reserve_mib": reserve,
            "low_mib": total.map(low_mib),
            "resume_mib": total.map(resume_mib),
            "enter_hold_ms": self.timing.enter_hold.as_millis() as u64,
            "resume_hold_ms": self.resume_hold.as_millis() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn thresholds_scale_with_the_card() {
        assert_eq!(low_mib(8192.0), 512.0, "8 GiB: the floor");
        assert!((low_mib(24576.0) - 1228.8).abs() < 1e-9, "24 GiB: 5 %");
        assert_eq!(resume_mib(8192.0), 512.0 + 1024.0);
        assert!((resume_mib(24576.0) - (1228.8 + 2457.6)).abs() < 1e-9);
    }

    /// Light load never fires: dips below the threshold shorter than the 3 s hold, and long
    /// stretches just above it, leave the rule alone.
    #[test]
    fn low_vram_never_flaps_under_light_load() {
        let mut r = LowVram::new(Timing::default());
        let mut t = 0;
        for i in 0..600 {
            // 8 GiB card; free swings 400–900 MiB: under 512 for 2 s of every 5 s.
            let free = if i % 5 < 2 { 400.0 } else { 900.0 };
            assert_eq!(r.observe(s(t), 8192.0, free, Some(300.0), true), None, "at {t} ms");
            t += 1000;
        }
        assert_eq!(r.phase(), Phase::Normal);
        // Hovering at the threshold exactly: not low.
        for _ in 0..30 {
            assert_eq!(r.observe(s(t), 8192.0, 512.0, None, true), None);
            t += 1000;
        }
    }

    /// Stop mode: engages after 3 s low; the memory it freed itself (its reserve, 600 MiB of our
    /// processes) never counts as free; resumes after 10 s of free − reserve ≥ low + 1 GiB; a
    /// dip back under it restarts the 10 s.
    #[test]
    fn low_vram_engages_after_hold_and_resumes_with_hysteresis() {
        let mut r = LowVram::new(Timing::default());
        assert_eq!(r.observe(s(0), 8192.0, 300.0, Some(600.0), true), None);
        assert_eq!(r.observe(s(2000), 8192.0, 300.0, Some(600.0), true), None);
        assert_eq!(
            r.observe(s(3000), 8192.0, 300.0, Some(600.0), true),
            Some(Action::Engage)
        );
        // Our stop freed 600: 900 free. 900 − 600 = 300 — still low.
        for t in (4000..20_000).step_by(1000) {
            assert_eq!(r.observe(s(t), 8192.0, 900.0, None, true), None);
        }
        // The game quits: 2200 free, − 600 = 1600 ≥ 1536 → recovering…
        assert_eq!(r.observe(s(20_000), 8192.0, 2200.0, None, true), None);
        assert!(matches!(r.phase(), Phase::Recovering { .. }));
        // …a dip under it at 25 s: back to low, the hold starts over…
        assert_eq!(r.observe(s(25_000), 8192.0, 2000.0, None, true), None);
        assert!(matches!(r.phase(), Phase::Low { .. }));
        assert_eq!(r.observe(s(26_000), 8192.0, 2200.0, None, true), None);
        assert_eq!(r.observe(s(35_000), 8192.0, 2200.0, None, true), None);
        assert_eq!(
            r.observe(s(36_000), 8192.0, 2200.0, None, true),
            Some(Action::Release),
            "10 s after 26 s"
        );
        assert_eq!(r.phase(), Phase::Normal);
    }

    /// Without per-process numbers the reserve is the free VRAM's rise in the 2 s after the
    /// stop; pause mode reserves nothing.
    #[test]
    fn low_vram_reserve_is_measured_without_per_process_numbers() {
        let mut r = LowVram::new(Timing::default());
        r.observe(s(0), 8192.0, 200.0, None, true);
        assert_eq!(r.observe(s(3000), 8192.0, 200.0, None, true), Some(Action::Engage));
        // Stopping freed 800 MiB.
        r.observe(s(4000), 8192.0, 1000.0, None, true);
        r.observe(s(5000), 8192.0, 1000.0, None, true);
        assert!(matches!(r.phase(), Phase::Low { reserve: Some(x), .. } if x == 800.0));
        // 2300 − 800 = 1500 < 1536: still low; 2400 − 800 = 1600: recovering.
        r.observe(s(6000), 8192.0, 2300.0, None, true);
        assert!(matches!(r.phase(), Phase::Low { .. }));
        r.observe(s(7000), 8192.0, 2400.0, None, true);
        assert!(matches!(r.phase(), Phase::Recovering { .. }));

        let mut p = LowVram::new(Timing::default());
        p.observe(s(0), 8192.0, 200.0, Some(900.0), false);
        assert_eq!(p.observe(s(3000), 8192.0, 200.0, Some(900.0), false), Some(Action::Engage));
        p.observe(s(4000), 8192.0, 1600.0, None, false);
        assert!(matches!(p.phase(), Phase::Recovering { reserve: 0.0, .. }), "pause frees nothing");
    }

    /// Engaging again within 60 s of a release doubles the resume hold (≤ 160 s); 5 min without
    /// an engage resets it.
    #[test]
    fn low_vram_backs_off_when_it_flaps() {
        let mut r = LowVram::new(Timing::default());
        let mut t = 0;
        let cycle = |r: &mut LowVram, t: &mut u64| -> Duration {
            r.observe(s(*t), 8192.0, 100.0, Some(0.0), true);
            *t += 3000;
            assert_eq!(r.observe(s(*t), 8192.0, 100.0, Some(0.0), true), Some(Action::Engage));
            let hold = r.resume_hold();
            *t += 1000;
            r.observe(s(*t), 8192.0, 4000.0, None, true);
            *t += hold.as_millis() as u64;
            assert_eq!(r.observe(s(*t), 8192.0, 4000.0, None, true), Some(Action::Release));
            *t += 1000;
            hold
        };
        assert_eq!(cycle(&mut r, &mut t), s(10_000));
        assert_eq!(cycle(&mut r, &mut t), s(20_000));
        assert_eq!(cycle(&mut r, &mut t), s(40_000));
        assert_eq!(cycle(&mut r, &mut t), s(80_000));
        assert_eq!(cycle(&mut r, &mut t), s(160_000));
        assert_eq!(cycle(&mut r, &mut t), s(160_000), "capped");
        t += 300_000;
        assert_eq!(cycle(&mut r, &mut t), s(10_000), "reset after 5 min");
    }

    /// A probe that dies while engaged releases after 30 s; a pending dip starts over.
    #[test]
    fn low_vram_releases_when_the_probe_dies() {
        let mut r = LowVram::new(Timing::default());
        r.observe(s(0), 8192.0, 100.0, None, false);
        assert_eq!(r.unavailable(s(1000)), None);
        assert_eq!(r.phase(), Phase::Normal, "pending starts over");
        r.observe(s(2000), 8192.0, 100.0, None, false);
        assert_eq!(r.observe(s(5000), 8192.0, 100.0, None, false), Some(Action::Engage));
        assert_eq!(r.unavailable(s(20_000)), None);
        assert_eq!(r.unavailable(s(35_000)), Some(Action::Release));
    }

    #[test]
    fn fdinfo_parsing_amdgpu_and_xe() {
        let amd = "pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-client-id:\t42\n\
                   drm-memory-vram:\t524288 KiB\ndrm-memory-gtt:\t2048 KiB\n";
        assert_eq!(parse_fdinfo(amd), Some(("42".into(), 512.0)));
        let xe = "drm-driver:\txe\ndrm-client-id:\t7\ndrm-total-system0:\t100 KiB\n\
                  drm-total-vram0:\t2048 KiB\ndrm-resident-vram0:\t1024 KiB\n";
        assert_eq!(parse_fdinfo(xe), Some(("7".into(), 1.0)), "resident wins");
        let i915 = "drm-client-id: 3\ndrm-total-local0: 3 MiB\n";
        assert_eq!(parse_fdinfo(i915), Some(("3".into(), 3.0)));
        assert_eq!(parse_fdinfo("pos: 0\nflags: 0\n"), None, "not a DRM client");
    }

    #[test]
    fn nvidia_smi_parsing() {
        let text = "\
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 595.84                 Driver Version: 595.84         CUDA Version: 13.2     |
|=========================================+========================+======================|
|   0  NVIDIA GeForce RTX 3070 Ti     Off |   00000000:01:00.0  On |                  N/A |
|  0%   45C    P5             30W /  290W |    2950MiB /   8192MiB |     12%      Default |
+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|=========================================================================================|
|    0   N/A  N/A            2076      G   ...alia-qs-0.0.12/bin/quickshell        116MiB |
|    0   N/A  N/A         1774158    C+G   ...player/target/debug/lp-player        194MiB |
+-----------------------------------------------------------------------------------------+
";
        let s = parse_nvidia_smi(text).expect("parsed");
        assert_eq!((s.total_mib, s.free_mib), (8192.0, 8192.0 - 2950.0));
        let p = s.procs.unwrap();
        assert_eq!(p.get(&2076), Some(&116.0));
        assert_eq!(p.get(&1774158), Some(&194.0));
    }

    #[test]
    fn fake_probe_reads_the_file_each_sample() {
        let f = std::env::temp_dir().join(format!("lp-vram-fake-{}.json", std::process::id()));
        let mut p = FakeProbe(f.clone());
        assert!(p.sample(&[]).is_err(), "no file: no sample");
        std::fs::write(&f, r#"{"total_mib": 8192, "free_mib": 300, "procs": {"12": 900, "13": 5}}"#)
            .unwrap();
        let s = p.sample(&[12]).unwrap();
        assert_eq!((s.total_mib, s.free_mib), (8192.0, 300.0));
        assert_eq!(s.procs.unwrap().into_iter().collect::<Vec<_>>(), vec![(12, 900.0)]);
        let _ = std::fs::remove_file(&f);
    }
}
