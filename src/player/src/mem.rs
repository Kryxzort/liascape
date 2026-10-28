//! Task 20b — process memory: what the kernel says (`/proc/self/status`) and what glibc
//! malloc says (`mallinfo2` + `malloc_info`), so "RSS grows" can be split into *in use*
//! (a leak: something still owns it) vs *retained* (freed, but kept by the allocator).
//! The `memory` probe (`probe/memory.rs`) reports both and can `malloc_trim(0)` on demand.
//! Also the allocator policy itself ([`apply_policy`]: why RSS used to grow per switch).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use serde::Serialize;

/// The kernel's view of this process (`/proc/self/status`, KiB).
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ProcStatus {
    pub rss_kib: u64,
    pub hwm_kib: u64,
    pub rss_anon_kib: u64,
    pub rss_file_kib: u64,
    pub threads: u64,
}

/// `/proc/self/status` (zeros if it can't be read — probes only).
pub fn proc_status() -> ProcStatus {
    let mut s = ProcStatus::default();
    let Ok(text) = std::fs::read_to_string("/proc/self/status") else {
        return s;
    };
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let n = v
            .split_whitespace()
            .next()
            .and_then(|x| x.parse().ok())
            .unwrap_or(0);
        match k {
            "VmRSS" => s.rss_kib = n,
            "VmHWM" => s.hwm_kib = n,
            "RssAnon" => s.rss_anon_kib = n,
            "RssFile" => s.rss_file_kib = n,
            "Threads" => s.threads = n,
            _ => {}
        }
    }
    s
}

/// glibc malloc's own accounting, summed over every arena (bytes).
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct MallocStats {
    /// Non-mmapped bytes the arenas got from the system (`mallinfo2.arena`).
    pub arena_bytes: u64,
    /// Bytes in chunks served by their own `mmap` (`hblkhd`) and how many (`hblks`).
    pub mmap_bytes: u64,
    pub mmap_chunks: u64,
    /// Allocated and not freed, in arenas (`uordblks`) — + `mmap_bytes` = everything live.
    pub in_use_bytes: u64,
    /// Freed but still held by the arenas (`fordblks`) — the retention side.
    pub free_bytes: u64,
    /// Of `free_bytes`, the part at the top of the main heap `malloc_trim` can give back
    /// without `madvise` (`keepcost`).
    pub top_releasable_bytes: u64,
    /// How many arenas exist (`<heap nr=…>` entries of `malloc_info`).
    pub arenas: u64,
}

/// `mallinfo2()` + the arena count from `malloc_info()` (glibc only; zeros elsewhere).
pub fn malloc_stats() -> MallocStats {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: plain glibc queries, no preconditions.
        let mi = unsafe { libc::mallinfo2() };
        MallocStats {
            arena_bytes: mi.arena as u64,
            mmap_bytes: mi.hblkhd as u64,
            mmap_chunks: mi.hblks as u64,
            in_use_bytes: mi.uordblks as u64,
            free_bytes: mi.fordblks as u64,
            top_releasable_bytes: mi.keepcost as u64,
            arenas: arena_count(),
        }
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    MallocStats::default()
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn arena_count() -> u64 {
    let mut buf: *mut libc::c_char = std::ptr::null_mut();
    let mut len: libc::size_t = 0;
    // SAFETY: `open_memstream` owns `buf` until `fclose`; we free it after reading.
    unsafe {
        let f = libc::open_memstream(&mut buf, &mut len);
        if f.is_null() {
            return 0;
        }
        libc::malloc_info(0, f);
        libc::fclose(f);
        if buf.is_null() {
            return 0;
        }
        let xml = std::slice::from_raw_parts(buf as *const u8, len);
        let n = xml.windows(9).filter(|w| *w == b"<heap nr=").count() as u64;
        libc::free(buf as *mut libc::c_void);
        n
    }
}

/// `malloc_trim(0)`: give every arena's free pages back to the kernel. Returns whether
/// anything was released (glibc's own return value).
pub fn trim() -> bool {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: always safe to call; it takes each arena's lock in turn.
        unsafe { libc::malloc_trim(0) != 0 }
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    false
}

// ---------------------------------------------------------------- allocator policy

/// The fixed glibc mmap threshold (bytes): an allocation at least this big that no free
/// chunk of its arena fits gets its own mapping, which `free` returns to the kernel at once
/// (instead of growing the arena).
///
/// **Why (Task 20b, measured).** glibc starts at 128 KiB but raises the threshold to the
/// size of any mmapped chunk that is freed (up to 32 MiB). Once the first mpv core is
/// destroyed, its 1080p frame-pool buffers (~3 MiB each) and demuxer blocks are above
/// the old threshold but below the new one, so every later core allocates them from
/// malloc's arenas — and an arena keeps what it frees. ~57 arenas (one per thread that
/// ever allocated, up to 8 × cores) each hold a peak's worth: 200 hermetic switches
/// grew RSS 159 → 922 MiB with malloc's *in-use* bytes flat at ~300 MiB and its *free*
/// (retained) bytes 1 → 614 MiB; with `hwdec=auto` 1.2–1.6 GiB. Pinning the threshold
/// at glibc's own starting value (which also turns the dynamic adjustment off) keeps
/// those buffers out of the arenas: 380 MiB after 300 switches (+ the reaper's trim).
pub const MMAP_THRESHOLD: usize = 128 * 1024;

/// `LIASCAPE_PLAYER_MALLOC=glibc` leaves glibc's defaults alone (A/B runs; the regression
/// test's RED evidence). Unset = the policy; any other value warns (`mem.policy` event)
/// and also leaves the policy on.
pub const POLICY_ENV: &str = "LIASCAPE_PLAYER_MALLOC";

static APPLIED: AtomicBool = AtomicBool::new(false);
static THRESHOLD: AtomicUsize = AtomicUsize::new(0);
/// The caller's own mmap threshold won (`MALLOC_MMAP_THRESHOLD_` / `GLIBC_TUNABLES`).
static ENV_THRESHOLD: AtomicBool = AtomicBool::new(false);
/// `LIASCAPE_PLAYER_MALLOC` was set to something other than `glibc` (or unset).
static BAD_ENV: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static TRIM: AtomicBool = AtomicBool::new(false);
static TRIMS: AtomicU64 = AtomicU64::new(0);
static TRIM_US_TOTAL: AtomicU64 = AtomicU64::new(0);
static TRIM_US_MAX: AtomicU64 = AtomicU64::new(0);

/// The allocator policy (Task 20b). `serve` calls it first thing (it needs no log yet; the
/// outcome is emitted by [`log_policy`] once the log is up): (1) the mmap threshold is fixed at [`MMAP_THRESHOLD`] — unless the caller's
/// environment already chose one (`MALLOC_MMAP_THRESHOLD_`, or
/// `glibc.malloc.mmap_threshold` in `GLIBC_TUNABLES`), which then wins; (2) the mpv
/// reaper runs [`trim_after_reap`] after each batch of destroyed cores — the smaller
/// chunks a core frees still fragment the arenas (+0.35 MiB retained per switch with
/// (1) alone), and `malloc_trim(0)` gives those pages back (measured 1.4 ms mean, ≤ 2.4
/// ms per switch with (1) in place; on the reaper thread, never the loop). Idempotent.
pub fn apply_policy() {
    match std::env::var(POLICY_ENV).as_deref() {
        Ok("glibc") => return,
        Ok(other) => {
            let _ = BAD_ENV.set(other.to_string());
        }
        Err(_) => {}
    }
    let env_threshold = std::env::var_os("MALLOC_MMAP_THRESHOLD_").is_some()
        || std::env::var("GLIBC_TUNABLES").is_ok_and(|t| t.contains("glibc.malloc.mmap_threshold"));
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    if !env_threshold {
        // SAFETY: mallopt only updates malloc's own parameters (under its lock).
        if unsafe { libc::mallopt(libc::M_MMAP_THRESHOLD, MMAP_THRESHOLD as libc::c_int) } == 1 {
            THRESHOLD.store(MMAP_THRESHOLD, Ordering::SeqCst);
        }
    }
    ENV_THRESHOLD.store(env_threshold, Ordering::SeqCst);
    // Nothing to apply (and nothing for the reaper to trim) off glibc.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        TRIM.store(true, Ordering::SeqCst);
        APPLIED.store(true, Ordering::SeqCst);
    }
}

/// Emit the policy outcome to the event log (`mem.policy`); `serve` calls it right after
/// `log::init` (the policy itself runs before the log exists).
pub fn log_policy() {
    let level = if BAD_ENV.get().is_some() {
        crate::log::Level::Warn
    } else {
        crate::log::Level::Info
    };
    crate::log::event("mem", level, "mem.policy", None, policy());
}

/// What the reaper calls after destroying a batch of mpv cores: `malloc_trim(0)` when
/// the policy is on (`None` when it's off). Returns (released anything, ms).
pub fn trim_after_reap() -> Option<(bool, f64)> {
    if !TRIM.load(Ordering::SeqCst) {
        return None;
    }
    let t = Instant::now();
    let released = trim();
    let us = t.elapsed().as_micros() as u64;
    TRIMS.fetch_add(1, Ordering::Relaxed);
    TRIM_US_TOTAL.fetch_add(us, Ordering::Relaxed);
    TRIM_US_MAX.fetch_max(us, Ordering::Relaxed);
    Some((released, us as f64 / 1000.0))
}

/// The policy in effect + the reaper's trim counters, for the `memory` probe.
pub fn policy() -> serde_json::Value {
    let threshold = THRESHOLD.load(Ordering::SeqCst);
    let trims = TRIMS.load(Ordering::Relaxed);
    let env_threshold = ENV_THRESHOLD.load(Ordering::SeqCst);
    serde_json::json!({
        "allocator": if cfg!(all(target_os = "linux", target_env = "gnu")) { "glibc" } else { "other" },
        "applied": APPLIED.load(Ordering::SeqCst),
        "mmap_threshold": (threshold > 0).then_some(threshold),
        // "policy" = fixed here, "env" = the caller's own tunable won (value not read back),
        // null = not fixed (policy off / not glibc).
        "mmap_threshold_source": if threshold > 0 { Some("policy") } else if env_threshold { Some("env") } else { None },
        "env_unknown_value": BAD_ENV.get(),
        "trim_after_reap": TRIM.load(Ordering::SeqCst),
        "trims": trims,
        "trim_ms_total": TRIM_US_TOTAL.load(Ordering::Relaxed) as f64 / 1000.0,
        "trim_ms_max": TRIM_US_MAX.load(Ordering::Relaxed) as f64 / 1000.0,
    })
}
