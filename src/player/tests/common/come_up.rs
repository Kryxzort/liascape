//! A spawned process's come-up wait that tells a slow start from a stuck one, like the
//! transition harness's `Harness::within` and the worker's own hello grace
//! (`worker::HELLO_TIMEOUT`): past its plain deadline a start is still waited for while the
//! process tree moves (CPU time, a major fault, a thread in uninterruptible IO wait), up to
//! [`CEILING`]. A cold `serve` start pages its binary and ~140 libraries in, and with those
//! evicted from the page cache and the disk saturated by fsync writers the loader alone took
//! longer than a fixed 15 s wait — no player code had run yet.
#![allow(dead_code)]

use std::time::{Duration, Instant};

/// No CPU time, no major fault and no thread in `D` this long = stuck (not starting slowly).
pub const QUIET: Duration = Duration::from_secs(10);
/// The longest a start that keeps moving is waited for, from the spawn.
pub const CEILING: Duration = Duration::from_secs(120);

/// One process tree's activity: `utime + stime` (ticks) and major faults summed over the
/// process and its descendants, and whether any of their threads is in `D`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Activity {
    cpu: u64,
    majflt: u64,
    in_io: bool,
}

fn stat_fields(path: &str) -> Option<Vec<String>> {
    let s = std::fs::read_to_string(path).ok()?;
    Some(
        s.rsplit_once(')')?
            .1
            .split_whitespace()
            .map(str::to_string)
            .collect(),
    )
}

fn add_tree(pid: u32, a: &mut Activity, depth: u32) {
    // after `(comm)`: state is field 3, majflt 12, utime 14, stime 15
    let Some(f) = stat_fields(&format!("/proc/{pid}/stat")) else {
        return;
    };
    let n = |field: usize| {
        f.get(field - 3)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    };
    a.cpu += n(14) + n(15);
    a.majflt += n(12);
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for t in tasks.flatten() {
            let tid = t.file_name();
            let tid = tid.to_string_lossy();
            if let Some(tf) = stat_fields(&format!("/proc/{pid}/task/{tid}/stat"))
                && tf.first().is_some_and(|s| s == "D")
            {
                a.in_io = true;
            }
            if depth < 4
                && let Ok(kids) =
                    std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/children"))
            {
                for k in kids.split_whitespace().filter_map(|k| k.parse().ok()) {
                    add_tree(k, a, depth + 1);
                }
            }
        }
    }
}

fn activity(pid: u32) -> Activity {
    let mut a = Activity {
        cpu: 0,
        majflt: 0,
        in_io: false,
    };
    add_tree(pid, &mut a, 0);
    a
}

/// The come-up wait of the process `pid` (and what it spawns: the supervisor's player).
pub struct ComeUp {
    pid: u32,
    spawned: Instant,
    last: Option<Activity>,
    moved_at: Instant,
}

impl ComeUp {
    /// From now (call it right after the spawn, or after the event that starts the wait).
    pub fn new(pid: u32) -> ComeUp {
        let now = Instant::now();
        ComeUp {
            pid,
            spawned: now,
            last: None,
            moved_at: now,
        }
    }

    /// Keep waiting: inside `limit` (the wait's own deadline) from the start, or after it while
    /// the process tree moved within [`QUIET`] and [`CEILING`] isn't reached. Sample it on every
    /// poll of the wait.
    pub fn waiting(&mut self, limit: Duration) -> bool {
        let a = activity(self.pid);
        let now = Instant::now();
        if a.in_io
            || self
                .last
                .is_some_and(|l| l.cpu != a.cpu || l.majflt != a.majflt)
        {
            self.moved_at = now;
        }
        self.last = Some(a);
        let since = now.duration_since(self.spawned);
        since < limit || (since < CEILING && now.duration_since(self.moved_at) < QUIET)
    }

    /// For a failure message: how long the wait ran and how long the tree was last quiet.
    pub fn describe(&self) -> String {
        let a = self.last.unwrap_or(Activity {
            cpu: 0,
            majflt: 0,
            in_io: false,
        });
        format!(
            "{:.1} s since the start, quiet for {:.1} s ({} cpu ticks, {} major faults)",
            self.spawned.elapsed().as_secs_f64(),
            self.moved_at.elapsed().as_secs_f64(),
            a.cpu,
            a.majflt
        )
    }
}
