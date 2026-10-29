//! The OFFLINE loudness estimate of a Wallpaper Engine scene: what the live learner
//! (`audio::loudness`, § Scene worker → "Scene loudness") would measure, computed from the
//! scene's files before it ever plays — so a scene can be normalized from its first second.
//! `.claude/rules/player-core.md` § Scene worker → "Scene loudness" → "Offline estimate".
//!
//! **Pipeline.** `project.json` (its user properties' defaults + the item's `scene_props`
//! overrides) and `scene.json` (from the folder or inside `scene.pkg`, [`super::pkg`]) → the
//! sound objects ([`parse_sounds`]) → a [`Plan`] under an audio [`Model`]: which tracks play,
//! how (loop / once / shuffled with gaps) and at what linear gain → each audio file decoded
//! ONCE by ffmpeg to 48 kHz stereo F32 and reduced to per-100 ms K-weighted segment powers
//! ([`FileStats`], through the live meter's own [`SegmentMeter`]; cached per file in memory and
//! on disk, [`Cache`]) → the plan's segments mixed as a power sum ([`mix`]: K-weighting is
//! linear and unrelated sounds' cross terms average out, so the mix's segment power is
//! Σ gain² · power) → fed to the live [`Learner`] itself, so the result is the SAME
//! `state_json` shape the live learner continues (a seed it refines).
//!
//! **Models** — what the player plays a scene through decides the rules:
//! - [`Model::Lwe`] (the default: liascape-player plays scenes through LWE `next-v2`, so this
//!   is what the live learner measures and the owner hears). LWE's `CSound` makes one
//!   `AudioStream` per file of a sound object, ALL playing at once from the start, each looping
//!   iff `playbackmode == "loop"` (else once), mixed at unity gain by the host driver; it
//!   ignores the object's `volume` (and so every user property bound to it), `visible`,
//!   `startsilent`, `mintime`/`maxtime`. User properties therefore never change a scene's audio
//!   under LWE.
//! - [`Model::We`] (Wallpaper Engine 2.8.485's own rules, decompiled —
//!   docs/player/spikes/we-sound-semantics.md): the stream's amplitude is `volume²` (WE
//!   squares the field, × the wallpaper's own volume, 1 here), user properties bound to it apply
//!   (a slider = its value, a bool = 1/0, a `{name, condition}` binding = 1 iff the property
//!   equals the condition — LWE's `DynamicValue` rule; WE's conversion is not decompiled), an
//!   absent `playbackmode` is `loop`, `loop` plays one file at a time picked at random
//!   back-to-back (a single file loops), `random` one random file at a time with a uniform
//!   `mintime`..`maxtime` gap (defaults 1 / 5 s) — both time-weighted like a playlist here —
//!   `single` ONE random file once (the first stands in), `startsilent` contributes nothing
//!   until a script starts it. Kept for when LWE honours these (then it becomes the live
//!   behaviour) and for the property-aware loudness design (docs/TODO.md).
//!
//! **Fingerprint** ([`fingerprint`]): the active tracks + their effective gains (+ which files)
//! — a property that doesn't touch audio never changes it; the backend keys a scene's loudness
//! by it.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::pkg::Pkg;
use crate::audio::loudness::{
    Learner, RATE, SEGMENT_FRAMES, SEGMENT_S, Segment, SegmentMeter, lufs_of,
};

/// How the scene's sound objects are played (module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Lwe,
    We,
}

impl Model {
    pub fn name(self) -> &'static str {
        match self {
            Model::Lwe => "lwe",
            Model::We => "we",
        }
    }

    pub fn parse(s: &str) -> Option<Model> {
        match s {
            "lwe" => Some(Model::Lwe),
            "we" => Some(Model::We),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The scene's description
// ---------------------------------------------------------------------------------------------

/// A property binding of a value (`"user": "name"` or `"user": {name, condition}`).
#[derive(Debug, Clone, PartialEq)]
pub enum UserRef {
    Name(String),
    Condition { name: String, condition: String },
}

/// A sound object's `volume` as written in scene.json.
#[derive(Debug, Clone, PartialEq)]
pub struct Volume {
    /// The literal value (or the binding's `value` fallback).
    pub value: f64,
    pub user: Option<UserRef>,
    /// A `script` drives it (SceneScript): its value at run time is unknown here.
    pub scripted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SoundObject {
    pub id: i64,
    pub name: String,
    pub files: Vec<String>,
    /// `playbackmode` as written (`loop`, `single`, `random`, …); `None` = absent.
    pub mode: Option<String>,
    pub volume: Volume,
    pub mintime: f64,
    pub maxtime: f64,
    pub startsilent: bool,
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn parse_volume(v: Option<&Value>) -> Volume {
    let plain = |value| Volume {
        value,
        user: None,
        scripted: false,
    };
    match v {
        None | Some(Value::Null) => plain(1.0),
        Some(Value::Object(o)) => {
            let value = o.get("value").and_then(num).unwrap_or(1.0);
            let user = match o.get("user") {
                Some(Value::String(s)) => Some(UserRef::Name(s.clone())),
                Some(Value::Object(u)) => match (u.get("name"), u.get("condition")) {
                    (Some(Value::String(n)), Some(c)) => Some(UserRef::Condition {
                        name: n.clone(),
                        condition: match c {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        },
                    }),
                    _ => None,
                },
                _ => None,
            };
            Volume {
                value,
                user,
                scripted: o.contains_key("script"),
            }
        }
        Some(other) => plain(num(other).unwrap_or(1.0)),
    }
}

/// Every sound object of a scene.json (`objects[]` with a `sound` array — LWE's
/// `ObjectParser` rule), in file order.
pub fn parse_sounds(scene: &Value) -> Vec<SoundObject> {
    let Some(objs) = scene.get("objects").and_then(Value::as_array) else {
        return vec![];
    };
    objs.iter()
        .filter_map(|o| {
            let files: Vec<String> = o
                .get("sound")?
                .as_array()?
                .iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect();
            Some(SoundObject {
                id: o.get("id").and_then(Value::as_i64).unwrap_or(-1),
                name: o
                    .get("name")
                    .map(|n| n.as_str().map_or_else(|| n.to_string(), str::to_string))
                    .unwrap_or_default(),
                files,
                mode: o
                    .get("playbackmode")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                volume: parse_volume(o.get("volume")),
                // WE's defaults (its sound constructor): 1 s / 5 s
                mintime: o.get("mintime").and_then(num).unwrap_or(1.0),
                maxtime: o.get("maxtime").and_then(num).unwrap_or(5.0),
                startsilent: o
                    .get("startsilent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// The current value of every user property: project.json `general.properties` defaults,
/// overridden by `overrides` (the item's `scene_props`, name → value).
pub fn property_values(
    project: &Value,
    overrides: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(props) = project
        .pointer("/general/properties")
        .and_then(Value::as_object)
    {
        for (k, p) in props {
            if let Some(v) = p.get("value") {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(o) = overrides {
        for (k, v) in o {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// A property as the string LWE compares a `condition` with.
fn cond_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// The effective linear gain of a `volume` under WE's rules (module doc): the bound property's
/// value (number, bool 1/0, numeric string), `{name, condition}` → 1 iff equal, else the literal.
pub fn eval_volume(v: &Volume, props: &Map<String, Value>) -> f64 {
    let g = match &v.user {
        None => v.value,
        Some(UserRef::Name(n)) => props.get(n).and_then(num).unwrap_or(v.value),
        Some(UserRef::Condition { name, condition }) => match props.get(name) {
            Some(p) => {
                let s = cond_string(p);
                let hit = s == *condition
                    || (matches!(p, Value::Bool(true)) && condition.eq_ignore_ascii_case("true"))
                    || (matches!(p, Value::Bool(false)) && condition.eq_ignore_ascii_case("false"));
                if hit { 1.0 } else { 0.0 }
            }
            None => v.value,
        },
    };
    if g.is_finite() { g.max(0.0) } else { 0.0 }
}

// ---------------------------------------------------------------------------------------------
// The plan: what plays, how, how loud
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Pattern {
    /// The files in order, repeated forever.
    Loop(Vec<String>),
    /// The files in order, once, from the start.
    Once(Vec<String>),
    /// One file after another (in listed order — WE picks at random; time-weighted the same),
    /// each followed by `gap_s` of silence, repeated.
    Shuffle { files: Vec<String>, gap_s: f64 },
}

impl Pattern {
    pub fn files(&self) -> &[String] {
        match self {
            Pattern::Loop(f) | Pattern::Once(f) => f,
            Pattern::Shuffle { files, .. } => files,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Pattern::Loop(_) => "loop",
            Pattern::Once(_) => "once",
            Pattern::Shuffle { .. } => "shuffle",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub object: i64,
    pub pattern: Pattern,
    /// Linear amplitude.
    pub gain: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub tracks: Vec<Track>,
    /// Sound objects that contribute nothing (gain 0, startsilent, no files): `(id, why)`.
    pub silent: Vec<(i64, String)>,
    /// Confidence notes (`(level, text)`, level 0 = info, 1 = medium, 2 = low).
    pub notes: Vec<(u8, String)>,
}

/// Which tracks play under `model` with the property values `props` (module doc).
pub fn plan(sounds: &[SoundObject], props: &Map<String, Value>, model: Model) -> Plan {
    let mut p = Plan::default();
    for s in sounds {
        if s.files.is_empty() {
            p.silent.push((s.id, "no files".into()));
            continue;
        }
        let mode = s.mode.as_deref().unwrap_or("");
        match model {
            Model::Lwe => {
                let looped = mode == "loop";
                if !looped {
                    p.notes.push((
                        1,
                        format!(
                            "sound {} plays once (playbackmode {:?}): its share depends on how long the scene plays",
                            s.id, s.mode
                        ),
                    ));
                }
                if s.files.len() > 1 {
                    p.notes.push((
                        0,
                        format!(
                            "sound {}: LWE plays all {} files at once (WE would play them one after another)",
                            s.id,
                            s.files.len()
                        ),
                    ));
                }
                if s.volume.user.is_some() || (s.volume.value - 1.0).abs() > 1e-6 {
                    p.notes.push((
                        0,
                        format!(
                            "sound {}: volume {} ignored by LWE (plays at 1.0)",
                            s.id,
                            describe_volume(&s.volume)
                        ),
                    ));
                }
                if s.startsilent {
                    p.notes
                        .push((0, format!("sound {}: startsilent ignored by LWE", s.id)));
                }
                for f in &s.files {
                    p.tracks.push(Track {
                        object: s.id,
                        pattern: if looped {
                            Pattern::Loop(vec![f.clone()])
                        } else {
                            Pattern::Once(vec![f.clone()])
                        },
                        gain: 1.0,
                    });
                }
            }
            Model::We => {
                if s.volume.scripted {
                    p.notes.push((
                        2,
                        format!(
                            "sound {}: volume is scripted — its literal value is used",
                            s.id
                        ),
                    ));
                }
                if s.startsilent {
                    p.silent.push((s.id, "startsilent".into()));
                    p.notes.push((
                        2,
                        format!(
                            "sound {}: startsilent — silent until something starts it",
                            s.id
                        ),
                    ));
                    continue;
                }
                // WE sends volume² (× the wallpaper volume) to the stream
                let v = eval_volume(&s.volume, props);
                let gain = v * v;
                if gain <= 0.0 {
                    p.silent
                        .push((s.id, format!("volume 0 ({})", describe_volume(&s.volume))));
                    continue;
                }
                let pattern = match mode {
                    // absent = WE's default, loop
                    "loop" | "" => Pattern::Loop(s.files.clone()),
                    "random" => {
                        p.notes.push((
                            1,
                            format!("sound {}: random — a time-weighted mix of its files", s.id),
                        ));
                        Pattern::Shuffle {
                            files: s.files.clone(),
                            gap_s: ((s.mintime + s.maxtime) / 2.0).max(0.0),
                        }
                    }
                    other => {
                        p.notes.push((
                            1,
                            if other == "single" && s.files.len() > 1 {
                                format!(
                                    "sound {}: single — WE plays ONE of its {} files at random, once",
                                    s.id,
                                    s.files.len()
                                )
                            } else {
                                format!("sound {}: playbackmode {other:?} plays once", s.id)
                            },
                        ));
                        Pattern::Once(vec![s.files[0].clone()])
                    }
                };
                p.tracks.push(Track {
                    object: s.id,
                    pattern,
                    gain,
                });
            }
        }
    }
    if model == Model::We {
        p.notes.push((
            1,
            "model we: WE 2.8.485's decompiled rules; a bound property's value conversion and the non-spatial level are inferred".into(),
        ));
    }
    p
}

fn describe_volume(v: &Volume) -> String {
    match &v.user {
        None => format!("{}", v.value),
        Some(UserRef::Name(n)) => format!("bound to property {n:?} (default {})", v.value),
        Some(UserRef::Condition { name, condition }) => {
            format!("bound to {name:?} == {condition:?}")
        }
    }
}

/// FNV-1a 64 (stable across builds/platforms — it names cache files and fingerprints).
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The audio configuration's fingerprint: `<model>-<16 hex>` over the active tracks (object,
/// pattern, files, gain to 1e-4), order-independent. Two property sets that play the same
/// sound the same way get the same one; nothing else enters it.
pub fn fingerprint(plan: &Plan, model: Model) -> String {
    let mut rows: Vec<String> = plan
        .tracks
        .iter()
        .map(|t| {
            let gap = match &t.pattern {
                Pattern::Shuffle { gap_s, .. } => format!("{gap_s:.3}"),
                _ => String::new(),
            };
            format!(
                "{}|{}{}|{}|{:.4}",
                t.object,
                t.pattern.kind(),
                gap,
                t.pattern.files().join("\u{1f}"),
                t.gain
            )
        })
        .collect();
    rows.sort();
    format!(
        "{}-{:016x}",
        model.name(),
        fnv64(rows.join("\n").as_bytes())
    )
}

// ---------------------------------------------------------------------------------------------
// Per-file stats (the expensive part) + their cache
// ---------------------------------------------------------------------------------------------

/// One audio file reduced to what the mix needs: per 100 ms segment, the channel-summed
/// K-weighted mean square (the live meter's [`Segment`] power) and the sample peak.
#[derive(Debug, Clone, PartialEq)]
pub struct FileStats {
    pub frames: u64,
    pub power: Vec<f64>,
    pub peak: Vec<f32>,
}

const STATS_V: u64 = 1;

impl FileStats {
    /// From interleaved stereo F32 at 48 kHz (a partial last segment is dropped).
    pub fn from_interleaved(samples: &[f32]) -> FileStats {
        let mut b = StatsBuilder::new();
        b.feed(samples);
        b.finish()
    }

    pub fn duration_s(&self) -> f64 {
        self.frames as f64 / RATE as f64
    }

    fn to_json(&self, key: &str) -> Value {
        json!({"v": STATS_V, "key": key, "frames": self.frames, "power": self.power, "peak": self.peak})
    }

    fn from_json(v: &Value, key: &str) -> Option<FileStats> {
        if v.get("v")?.as_u64()? != STATS_V || v.get("key")?.as_str()? != key {
            return None;
        }
        let power: Vec<f64> = v
            .get("power")?
            .as_array()?
            .iter()
            .map(|x| x.as_f64())
            .collect::<Option<_>>()?;
        let peak: Vec<f32> = v
            .get("peak")?
            .as_array()?
            .iter()
            .map(|x| x.as_f64().map(|f| f as f32))
            .collect::<Option<_>>()?;
        (power.len() == peak.len()).then_some(FileStats {
            frames: v.get("frames")?.as_u64()?,
            power,
            peak,
        })
    }
}

struct StatsBuilder {
    meter: SegmentMeter,
    out: Vec<Segment>,
    frames: u64,
}

impl StatsBuilder {
    fn new() -> StatsBuilder {
        StatsBuilder {
            meter: SegmentMeter::new(2),
            out: Vec::new(),
            frames: 0,
        }
    }

    fn feed(&mut self, samples: &[f32]) {
        self.frames += (samples.len() / 2) as u64;
        self.meter.feed(samples, &mut self.out);
    }

    fn finish(self) -> FileStats {
        FileStats {
            frames: self.frames,
            power: self.out.iter().map(|s| s.power).collect(),
            peak: self.out.iter().map(|s| s.peak).collect(),
        }
    }
}

/// Where a sound file lives: a file in the scene folder, an entry of its `scene.pkg`, or WE's
/// assets dir (LWE mounts the folder, the package and the assets — in that order).
#[derive(Debug, Clone)]
pub enum AudioRef {
    File(PathBuf),
    PkgEntry { pkg: Arc<Pkg>, name: String },
}

impl AudioRef {
    /// The cache key: what identifies these exact bytes (path + size + mtime; for a package
    /// entry also its name, offset and length).
    pub fn key(&self) -> String {
        let meta = |p: &Path| {
            std::fs::metadata(p)
                .map(|m| {
                    use std::os::unix::fs::MetadataExt;
                    format!("{}:{}.{}", m.len(), m.mtime(), m.mtime_nsec())
                })
                .unwrap_or_default()
        };
        match self {
            AudioRef::File(p) => {
                let c = p.canonicalize().unwrap_or_else(|_| p.clone());
                format!("file:{}:{}", c.display(), meta(&c))
            }
            AudioRef::PkgEntry { pkg, name } => {
                let c = pkg.path.canonicalize().unwrap_or_else(|_| pkg.path.clone());
                let e = pkg.find(name);
                format!(
                    "pkg:{}:{}:{}:{}:{}",
                    c.display(),
                    meta(&c),
                    e.map_or(name.as_str(), |e| e.name.as_str()),
                    e.map_or(0, |e| e.offset),
                    e.map_or(0, |e| e.len)
                )
            }
        }
    }
}

/// The longest one decode may run.
pub const DECODE_TIMEOUT: Duration = Duration::from_secs(120);
/// The longest audio decoded per file (the live learner's cap; a longer file's first 30 min
/// stand for it).
pub const MAX_DECODE_S: f64 = 1800.0;

/// Decode one file with ffmpeg (from `PATH`) to 48 kHz stereo F32 and reduce it, streaming
/// (never the whole PCM in memory). A package entry is piped through stdin.
pub fn decode(src: &AudioRef) -> Result<FileStats, String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-nostdin", "-i"]);
    let input = match src {
        AudioRef::File(p) => {
            cmd.arg(p);
            None
        }
        AudioRef::PkgEntry { pkg, name } => {
            let e = pkg
                .find(name)
                .ok_or_else(|| format!("{name}: not in {}", pkg.path.display()))?;
            cmd.arg("pipe:0");
            Some(pkg.read(e).map_err(|e| format!("{name}: {e}"))?)
        }
    };
    cmd.args(["-vn", "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-t"])
        .arg(format!("{MAX_DECODE_S}"))
        .args(["-f", "f32le", "pipe:1"])
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg: {e}"))?;
    let pid = child.id() as libc::pid_t;
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take();
        std::thread::spawn(move || {
            if let Some(s) = stdin.as_mut() {
                // a broken pipe = ffmpeg stopped reading (done or failed): its status says which
                let _ = std::io::Write::write_all(s, &bytes);
            }
        })
    });
    let mut stderr = child.stderr.take();
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_end(&mut b);
        }
        b
    });
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dog = {
        let done = done.clone();
        std::thread::spawn(move || {
            let t0 = Instant::now();
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                if t0.elapsed() > DECODE_TIMEOUT {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        })
    };
    let mut b = StatsBuilder::new();
    let mut stdout = child.stdout.take().ok_or("ffmpeg: no stdout")?;
    let mut buf = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::new();
    let mut samples: Vec<f32> = Vec::with_capacity(1 << 14);
    loop {
        let n = match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("ffmpeg: {e}")),
        };
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 8 * 8; // whole stereo frames
        samples.clear();
        samples.extend(
            carry[..whole]
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])),
        );
        b.feed(&samples);
        carry.drain(..whole);
    }
    let status = child.wait().map_err(|e| format!("ffmpeg: {e}"))?;
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let timed_out = dog.join().unwrap_or(false);
    if let Some(w) = writer {
        let _ = w.join();
    }
    let err = String::from_utf8_lossy(&err_t.join().unwrap_or_default())
        .trim()
        .to_string();
    if timed_out {
        return Err(format!("ffmpeg decode timed out after {DECODE_TIMEOUT:?}"));
    }
    let stats = b.finish();
    if !status.success() && stats.frames == 0 {
        return Err(format!(
            "ffmpeg failed ({status}): {}",
            err.lines().last().unwrap_or("no output")
        ));
    }
    Ok(stats)
}

/// Per-file stats, decoded at most once: in memory for the process, and (with a `dir`) on disk
/// as `<dir>/<fnv64(key)>.json` (key checked on load) — so re-estimating a scene for another
/// property combination, or after a restart, is only a re-mix.
pub struct Cache {
    dir: Option<PathBuf>,
    mem: HashMap<String, Arc<FileStats>>,
    pub hits: u64,
    pub disk_hits: u64,
    pub decodes: u64,
}

impl Cache {
    pub fn new(dir: Option<PathBuf>) -> Cache {
        Cache {
            dir,
            mem: HashMap::new(),
            hits: 0,
            disk_hits: 0,
            decodes: 0,
        }
    }

    /// `$XDG_CACHE_HOME/liascape/scene-loudness` (else `~/.cache/…`).
    pub fn default_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_CACHE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .map(|c| c.join("liascape").join("scene-loudness"))
    }

    /// Put stats in by key (tests; a caller that measured them another way).
    pub fn insert(&mut self, key: &str, stats: FileStats) {
        self.mem.insert(key.to_string(), Arc::new(stats));
    }

    pub fn stats(&mut self, src: &AudioRef) -> Result<Arc<FileStats>, String> {
        let key = src.key();
        if let Some(s) = self.mem.get(&key) {
            self.hits += 1;
            return Ok(s.clone());
        }
        let file = self
            .dir
            .as_ref()
            .map(|d| d.join(format!("{:016x}.json", fnv64(key.as_bytes()))));
        if let Some(f) = &file
            && let Ok(bytes) = std::fs::read(f)
            && let Ok(v) = serde_json::from_slice::<Value>(&bytes)
            && let Some(s) = FileStats::from_json(&v, &key)
        {
            self.disk_hits += 1;
            let s = Arc::new(s);
            self.mem.insert(key, s.clone());
            return Ok(s);
        }
        let s = Arc::new(decode(src)?);
        self.decodes += 1;
        if let Some(f) = &file {
            // best-effort: a cache that can't be written only costs a decode next time
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let tmp = f.with_extension(format!("tmp{}", std::process::id()));
            if std::fs::write(&tmp, s.to_json(&key).to_string()).is_ok() {
                let _ = std::fs::rename(&tmp, f);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        self.mem.insert(key, s.clone());
        Ok(s)
    }
}

// ---------------------------------------------------------------------------------------------
// The mix + the estimate
// ---------------------------------------------------------------------------------------------

/// The simulated play length when nothing longer is needed (the live window).
pub const MIN_HORIZON_S: f64 = 60.0;
/// Never simulate more than the live learner's cap.
pub const MAX_HORIZON_S: f64 = 1800.0;

/// A track's segment timeline: `(power, peak)` at segment `t` (0 past a one-shot's end).
struct Timeline {
    /// One cycle (or the whole one-shot): `(stats index, segment)` or silence.
    cycle: Vec<Option<(usize, usize)>>,
    looped: bool,
    gain: f64,
}

impl Timeline {
    fn at(&self, t: usize) -> Option<(usize, usize)> {
        if self.cycle.is_empty() {
            return None;
        }
        if self.looped {
            self.cycle[t % self.cycle.len()]
        } else {
            self.cycle.get(t).copied().flatten()
        }
    }
}

#[derive(Debug, Clone)]
pub struct Mix {
    pub segments: Vec<Segment>,
    pub horizon_s: f64,
    /// Groups of equal-length tracks that may add coherently ([`mix_with`]).
    pub coherent_groups: usize,
}

/// The plan's mixed segment timeline over a horizon long enough for its loops to cycle
/// (≥ [`MIN_HORIZON_S`]; several loops of different lengths: 4 × the longest, so their phases
/// mix; ≤ [`MAX_HORIZON_S`]). `stats[file]` must hold every file of the plan's tracks (a file
/// missing there is silence). Power sum: Σ gain² · power; peak: Σ gain · peak (a bound).
pub fn mix(plan: &Plan, stats: &HashMap<String, Arc<FileStats>>) -> Mix {
    mix_for(plan, stats, None)
}

/// [`mix`] over exactly `horizon_s` of play from the start when given (validation against a
/// recording of the first seconds; ≤ [`MAX_HORIZON_S`]).
pub fn mix_for(
    plan: &Plan,
    stats: &HashMap<String, Arc<FileStats>>,
    horizon_s: Option<f64>,
) -> Mix {
    mix_with(plan, stats, horizon_s, false)
}

/// Tracks whose cycles are this close in length (and at least [`COHERENT_MIN_S`] long) start
/// together and may be versions of one recording (an instrumental and a vocal mix, a copy):
/// [`mix_with`]`(…, coherent: true)` adds them in amplitude instead of power — the upper bound.
pub const COHERENT_TOL_S: f64 = 0.5;
pub const COHERENT_MIN_S: f64 = 5.0;

/// [`mix_for`], and with `coherent` the equal-length groups (above) summed in amplitude —
/// `(Σ gain·√power)²` per segment — the loudest the scene can be if those files are aligned
/// versions of one track. `Mix::coherent_groups` counts such groups (either way).
pub fn mix_with(
    plan: &Plan,
    stats: &HashMap<String, Arc<FileStats>>,
    horizon_s: Option<f64>,
    coherent: bool,
) -> Mix {
    let mut files: Vec<Arc<FileStats>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut lines = Vec::new();
    for tr in &plan.tracks {
        let mut cycle = Vec::new();
        let mut push_file = |name: &String, cycle: &mut Vec<Option<(usize, usize)>>| {
            if let Some(s) = stats.get(name) {
                let i = *index.entry(name.clone()).or_insert_with(|| {
                    files.push(s.clone());
                    files.len() - 1
                });
                cycle.extend((0..s.power.len()).map(|k| Some((i, k))));
            }
        };
        let looped = match &tr.pattern {
            Pattern::Loop(fs) => {
                fs.iter().for_each(|f| push_file(f, &mut cycle));
                true
            }
            Pattern::Once(fs) => {
                fs.iter().for_each(|f| push_file(f, &mut cycle));
                false
            }
            Pattern::Shuffle { files: fs, gap_s } => {
                for f in fs {
                    push_file(f, &mut cycle);
                    cycle.extend(std::iter::repeat_n(
                        None,
                        (gap_s / SEGMENT_S).round() as usize,
                    ));
                }
                true
            }
        };
        if cycle.iter().any(Option::is_some) {
            lines.push(Timeline {
                cycle,
                looped,
                gain: tr.gain,
            });
        }
    }
    let seg = |s: f64| (s / SEGMENT_S).round() as usize;
    let longest = lines.iter().map(|l| l.cycle.len()).max().unwrap_or(0);
    let mut periods: Vec<usize> = lines
        .iter()
        .filter(|l| l.looped)
        .map(|l| l.cycle.len())
        .collect();
    periods.sort_unstable();
    periods.dedup();
    let mut n = longest.max(seg(MIN_HORIZON_S));
    if periods.len() > 1 {
        n = n.max(4 * longest);
    }
    let n = horizon_s.map_or(n, seg).min(seg(MAX_HORIZON_S));
    // equal-length groups (every track starts at 0): greedy, in track order
    let mut group: Vec<Option<usize>> = vec![None; lines.len()];
    let mut groups = 0;
    for i in 0..lines.len() {
        if group[i].is_some() || lines[i].cycle.len() < seg(COHERENT_MIN_S) {
            continue;
        }
        let mates: Vec<usize> = (i + 1..lines.len())
            .filter(|j| {
                group[*j].is_none()
                    && lines[*j].looped == lines[i].looped
                    && lines[*j].cycle.len().abs_diff(lines[i].cycle.len()) <= seg(COHERENT_TOL_S)
            })
            .collect();
        if !mates.is_empty() {
            group[i] = Some(groups);
            mates.iter().for_each(|j| group[*j] = Some(groups));
            groups += 1;
        }
    }
    let mut amp = vec![0.0f64; groups];
    let segments = (0..n)
        .map(|t| {
            let (mut p, mut pk) = (0.0f64, 0.0f32);
            amp.iter_mut().for_each(|a| *a = 0.0);
            for (l, g) in lines.iter().zip(&group) {
                if let Some((i, k)) = l.at(t) {
                    match g {
                        Some(g) if coherent => amp[*g] += l.gain * files[i].power[k].sqrt(),
                        _ => p += l.gain * l.gain * files[i].power[k],
                    }
                    pk += (l.gain as f32) * files[i].peak[k];
                }
            }
            p += amp.iter().map(|a| a * a).sum::<f64>();
            Segment { power: p, peak: pk }
        })
        .collect();
    Mix {
        segments,
        horizon_s: n as f64 * SEGMENT_S,
        coherent_groups: groups,
    }
}

#[derive(Debug, Clone)]
pub struct Estimate {
    /// Gated integrated loudness; `None` = nothing above the absolute gate (silent).
    pub lufs: Option<f64>,
    pub peak_dbfs: Option<f64>,
    /// Audible seconds of the simulated play (blocks above the absolute gate).
    pub audible_s: f64,
    /// The live learner's `state_json` of the simulated play (full weight).
    pub state: Value,
}

/// Run the mix through the live [`Learner`] (window/cap past the horizon: no report, no stop).
pub fn estimate(m: &Mix) -> Estimate {
    let mut l = Learner::new(MAX_HORIZON_S * 2.0).with_cap(MAX_HORIZON_S * 2.0);
    for s in &m.segments {
        let _ = l.push(*s);
    }
    let state = l.state_json();
    Estimate {
        lufs: l.integrated(),
        peak_dbfs: state.get("peak_dbfs").and_then(Value::as_f64),
        audible_s: l.audible_s(),
        state,
    }
}

/// `state` with its counts scaled to `weight_s` audible seconds (largest remainder, so the
/// total is exact and the shape kept to one block): the seed a live learner continues, weighted
/// so live play dominates it quickly. `None` for an empty state.
pub fn scale_state(state: &Value, weight_s: f64) -> Option<Value> {
    let first = state.get("first")?.as_u64()?;
    let counts: Vec<u64> = state
        .get("counts")?
        .as_array()?
        .iter()
        .map(Value::as_u64)
        .collect::<Option<_>>()?;
    let total: u64 = counts.iter().sum();
    if total == 0 {
        return None;
    }
    let target = ((weight_s / SEGMENT_S).round() as u64).max(1);
    let exact: Vec<f64> = counts
        .iter()
        .map(|c| *c as f64 * target as f64 / total as f64)
        .collect();
    let mut out: Vec<u64> = exact.iter().map(|e| e.floor() as u64).collect();
    let mut left = target - out.iter().sum::<u64>();
    let mut order: Vec<usize> = (0..out.len()).collect();
    order.sort_by(|a, b| {
        let fa = exact[*a] - exact[*a].floor();
        let fb = exact[*b] - exact[*b].floor();
        fb.partial_cmp(&fa)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    for i in order {
        if left == 0 {
            break;
        }
        out[i] += 1;
        left -= 1;
    }
    // trim zero ends so the shape is the live learner's (first = the first non-zero bin)
    let lead = out.iter().position(|c| *c > 0).unwrap_or(0);
    let tail = out.iter().rposition(|c| *c > 0).map_or(lead, |t| t + 1);
    Some(json!({
        "v": state.get("v").cloned().unwrap_or(json!(1)),
        "first": first + lead as u64,
        "counts": &out[lead..tail],
        "peak_dbfs": state.get("peak_dbfs").cloned().unwrap_or(Value::Null),
    }))
}

// ---------------------------------------------------------------------------------------------
// A scene folder
// ---------------------------------------------------------------------------------------------

/// A scene folder: its project, scene.json and how to find its files.
pub struct SceneDir {
    pub dir: PathBuf,
    pub project: Value,
    pub scene: Value,
    pub pkg: Option<Arc<Pkg>>,
    pub assets: Option<PathBuf>,
    /// The scene has SceneScript somewhere (a `script` key) — under WE it could drive sounds.
    pub has_scripts: bool,
}

fn json_of(bytes: &[u8]) -> Result<Value, String> {
    let b = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_slice(b).map_err(|e| e.to_string())
}

fn mentions_script(v: &Value) -> bool {
    match v {
        Value::Object(o) => o.contains_key("script") || o.values().any(mentions_script),
        Value::Array(a) => a.iter().any(mentions_script),
        _ => false,
    }
}

impl SceneDir {
    pub fn open(dir: &Path, assets: Option<&Path>) -> Result<SceneDir, String> {
        let pj = dir.join("project.json");
        let project = json_of(&std::fs::read(&pj).map_err(|e| format!("{}: {e}", pj.display()))?)
            .map_err(|e| format!("{}: {e}", pj.display()))?;
        let ty = project.get("type").and_then(Value::as_str).unwrap_or("");
        if !ty.eq_ignore_ascii_case("scene") {
            return Err(format!("{}: type {ty:?}, not a scene", pj.display()));
        }
        let file = project
            .get("file")
            .and_then(Value::as_str)
            .unwrap_or("scene.json");
        let pkg_path = dir.join("scene.pkg");
        let pkg = if pkg_path.exists() {
            Some(Arc::new(
                Pkg::open(&pkg_path).map_err(|e| format!("{}: {e}", pkg_path.display()))?,
            ))
        } else {
            None
        };
        let scene_bytes = if dir.join(file).is_file() {
            std::fs::read(dir.join(file)).map_err(|e| format!("{file}: {e}"))?
        } else if let Some(p) = &pkg
            && let Some(e) = p.find(file)
        {
            p.read(e).map_err(|e| format!("{file}: {e}"))?
        } else {
            return Err(format!(
                "{}: no {file} (folder or scene.pkg)",
                dir.display()
            ));
        };
        let scene = json_of(&scene_bytes).map_err(|e| format!("{file}: {e}"))?;
        let has_scripts = mentions_script(&scene);
        Ok(SceneDir {
            dir: dir.to_path_buf(),
            project,
            scene,
            pkg,
            assets: assets.map(Path::to_path_buf),
            has_scripts,
        })
    }

    /// Resolve a sound path: the folder, then the package, then WE's assets dir.
    pub fn locate(&self, name: &str) -> Option<AudioRef> {
        let rel = name.trim_start_matches("./").trim_start_matches('/');
        let f = self.dir.join(rel);
        if f.is_file() {
            return Some(AudioRef::File(f));
        }
        if let Some(p) = &self.pkg
            && p.find(rel).is_some()
        {
            return Some(AudioRef::PkgEntry {
                pkg: p.clone(),
                name: rel.to_string(),
            });
        }
        let a = self.assets.as_ref()?.join(rel);
        a.is_file().then_some(AudioRef::File(a))
    }
}

/// Options of one estimate.
#[derive(Debug, Clone)]
pub struct Opts {
    pub model: Model,
    /// The item's `scene_props` (name → value).
    pub props: Option<Map<String, Value>>,
    /// Audible seconds the `seed` state is scaled to.
    pub seed_s: f64,
    /// Simulate exactly this long from the start instead of the automatic horizon.
    pub horizon_s: Option<f64>,
}

/// The default weight of an estimated seed: a sixth of the live window — live play outweighs
/// it 5:1 by the first report (docs/TODO.md "Offline scene loudness → integration").
pub const DEFAULT_SEED_S: f64 = 10.0;

impl Default for Opts {
    fn default() -> Opts {
        Opts {
            model: Model::Lwe,
            props: None,
            seed_s: DEFAULT_SEED_S,
            horizon_s: None,
        }
    }
}

/// Estimate a scene (the `scene-loudness` CLI's body): the report JSON (`estimated: true`).
pub fn estimate_scene(scene: &SceneDir, opts: &Opts, cache: &mut Cache) -> Value {
    let t0 = Instant::now();
    let sounds = parse_sounds(&scene.scene);
    let props = property_values(&scene.project, opts.props.as_ref());
    let mut p = plan(&sounds, &props, opts.model);
    if scene.has_scripts && opts.model == Model::We {
        p.notes.push((
            1,
            "the scene has scripts: under WE they could start, stop or fade sounds".into(),
        ));
    }
    let mut stats = HashMap::new();
    let mut file_rows = Vec::new();
    let mut wanted: Vec<String> = p
        .tracks
        .iter()
        .flat_map(|t| t.pattern.files().iter().cloned())
        .collect();
    wanted.sort();
    wanted.dedup();
    for f in &wanted {
        let row = match scene.locate(f) {
            None => {
                p.notes
                    .push((2, format!("{f}: not found (folder, scene.pkg, assets)")));
                json!({"file": f, "error": "not found"})
            }
            Some(src) => match cache.stats(&src) {
                Ok(s) => {
                    let row = json!({"file": f, "duration_s": round3(s.duration_s()),
                        "lufs": file_lufs(&s)});
                    if s.power.is_empty() {
                        p.notes.push((2, format!("{f}: decoded to nothing")));
                    }
                    stats.insert(f.clone(), s);
                    row
                }
                Err(e) => {
                    p.notes.push((2, format!("{f}: {e}")));
                    json!({"file": f, "error": e})
                }
            },
        };
        file_rows.push(row);
    }
    let lens: Vec<usize> = p
        .tracks
        .iter()
        .filter(|t| matches!(t.pattern, Pattern::Loop(_)))
        .map(|t| {
            t.pattern
                .files()
                .iter()
                .filter_map(|f| stats.get(f))
                .map(|s| s.power.len())
                .sum()
        })
        .collect();
    if lens.iter().any(|l| *l != lens[0]) {
        p.notes.push((
            0,
            "loops of different lengths: their phases are mixed over the horizon".into(),
        ));
    }
    let m = mix_for(&p, &stats, opts.horizon_s);
    let est = estimate(&m);
    let coherent = (m.coherent_groups > 0)
        .then(|| estimate(&mix_with(&p, &stats, opts.horizon_s, true)).lufs)
        .flatten();
    if let (Some(c), Some(l)) = (coherent, est.lufs) {
        p.notes.push((
            2,
            format!(
                "{} group(s) of equal-length files start together: if they are versions of one track they add \
                 coherently — up to {:+.1} LU louder ({:.1} LUFS)",
                m.coherent_groups,
                c - l,
                c
            ),
        ));
    }
    if p.tracks.is_empty() {
        p.notes.push((0, "no sound plays".into()));
    } else if est.lufs.is_none() {
        p.notes.push((
            0,
            "everything is below the absolute gate (−70 LUFS): silent".into(),
        ));
    } else if est.audible_s < 20.0 {
        p.notes.push((
            1,
            format!(
                "only {:.1} s audible: the live learner needs 20 s to report",
                est.audible_s
            ),
        ));
    }
    let level = p.notes.iter().map(|n| n.0).max().unwrap_or(0);
    let fp = fingerprint(&p, opts.model);
    let level_name = ["high", "medium", "low"][level.min(2) as usize];
    let sound_rows: Vec<Value> = sounds
        .iter()
        .map(|s| {
            let tracks: Vec<&Track> = p.tracks.iter().filter(|t| t.object == s.id).collect();
            json!({
                "id": s.id, "name": s.name, "files": s.files, "playbackmode": s.mode,
                "volume": describe_volume(&s.volume),
                "gain": tracks.first().map(|t| t.gain),
                "active": !tracks.is_empty(),
                "silent": p.silent.iter().find(|(i, _)| *i == s.id).map(|(_, w)| w),
            })
        })
        .collect();
    json!({
        "path": scene.dir,
        "estimated": true,
        "model": opts.model.name(),
        "fingerprint": fp,
        "lufs": est.lufs.map(round3),
        "peak_dbfs": est.peak_dbfs.map(round3),
        "lufs_if_coherent": coherent.map(round3),
        "audible_s": round3(est.audible_s),
        "horizon_s": round3(m.horizon_s),
        "state": est.state,
        "seed": {"weight_s": opts.seed_s, "state": scale_state(&est.state, opts.seed_s)},
        "confidence": {
            "level": level_name,
            "notes": p.notes.iter().map(|n| &n.1).collect::<Vec<_>>(),
        },
        "sounds": sound_rows,
        "files": file_rows,
        "cache": {"hits": cache.hits, "disk_hits": cache.disk_hits, "decodes": cache.decodes},
        "ms": round3(t0.elapsed().as_secs_f64() * 1000.0),
    })
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// One file's own gated loudness (as if it looped alone at unity) — a diagnostic row.
fn file_lufs(s: &FileStats) -> Option<f64> {
    let mut l = Learner::new(MAX_HORIZON_S * 2.0).with_cap(MAX_HORIZON_S * 2.0);
    for (p, k) in s.power.iter().zip(&s.peak) {
        let _ = l.push(Segment {
            power: *p,
            peak: *k,
        });
    }
    l.integrated().map(round3)
}

/// Frames per 100 ms segment (re-exported for tests).
pub const SEGMENT: usize = SEGMENT_FRAMES;

/// The loudness of a plain power (LUFS) — re-exported for tests and the report.
pub fn lufs(power: f64) -> f64 {
    lufs_of(power)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = RATE as f64;

    /// Interleaved stereo sine, `peak` amplitude on both channels.
    fn sine(hz: f64, peak: f32, secs: f64) -> Vec<f32> {
        let n = (secs * SR) as usize;
        (0..n)
            .flat_map(|i| {
                let v = peak * (2.0 * std::f64::consts::PI * hz * i as f64 / SR).sin() as f32;
                [v, v]
            })
            .collect()
    }

    fn stats_of(s: &[f32]) -> Arc<FileStats> {
        Arc::new(FileStats::from_interleaved(s))
    }

    fn sound(id: i64, files: &[&str], mode: &str, volume: Value) -> Value {
        json!({"id": id, "name": format!("s{id}"), "sound": files, "playbackmode": mode,
               "volume": volume, "mintime": 1.0, "maxtime": 5.0, "startsilent": false})
    }

    fn est(
        sounds: &[SoundObject],
        props: &Map<String, Value>,
        model: Model,
        st: &HashMap<String, Arc<FileStats>>,
    ) -> (Plan, Estimate) {
        let p = plan(sounds, props, model);
        let e = estimate(&mix(&p, st));
        (p, e)
    }

    /// Tech 3341-style: a stereo 1 kHz sine at −20 dBFS peak reads −20.0 LUFS — through the
    /// estimator's own reduction + mix + the live learner.
    #[test]
    fn sine_at_minus_20_dbfs_reads_minus_20_lufs() {
        let a = 10f32.powf(-20.0 / 20.0);
        let mut st = HashMap::new();
        st.insert("a.wav".to_string(), stats_of(&sine(1000.0, a, 10.0)));
        let sounds = parse_sounds(&json!({"objects": [sound(1, &["a.wav"], "loop", json!(1.0))]}));
        for model in [Model::Lwe, Model::We] {
            let (_, e) = est(&sounds, &Map::new(), model, &st);
            let l = e.lufs.unwrap();
            assert!((l + 20.0).abs() < 0.06, "{model:?}: {l}");
            assert!((e.peak_dbfs.unwrap() + 20.0).abs() < 0.01);
            // looped over the 60 s horizon: every block audible (the first 3 segments form none)
            assert!((e.audible_s - 59.7).abs() < 0.11, "{}", e.audible_s);
        }
    }

    /// Two simultaneous sounds at known volumes (WE model): the mix is their power sum —
    /// within 0.05 LU of measuring the actually summed signal.
    #[test]
    fn simultaneous_sounds_mix_as_a_power_sum() {
        let (a, b) = (sine(1000.0, 0.1, 8.0), sine(440.0, 0.2, 8.0));
        let mut st = HashMap::new();
        st.insert("a".to_string(), stats_of(&a));
        st.insert("b".to_string(), stats_of(&b));
        let sounds = parse_sounds(&json!({"objects": [
            sound(1, &["a"], "loop", json!(1.0)), sound(2, &["b"], "loop", json!(0.5))]}));
        let (_, e) = est(&sounds, &Map::new(), Model::We, &st);
        let pa = st["a"].power[10];
        let pb = st["b"].power[10];
        // volume 0.5 → amplitude 0.25 (WE squares it) → power 1/16
        let want = lufs_of(pa + 0.0625 * pb);
        assert!(
            (e.lufs.unwrap() - want).abs() < 0.06,
            "{:?} vs {want}",
            e.lufs
        );
        // the real mix, measured like the live meter
        let real: Vec<f32> = a.iter().zip(&b).map(|(x, y)| x + 0.25 * y).collect();
        let real = stats_of(&real);
        let mut l = Learner::new(1e9).with_cap(1e9);
        for (p, k) in real.power.iter().zip(&real.peak) {
            let _ = l.push(Segment {
                power: *p,
                peak: *k,
            });
        }
        assert!((l.integrated().unwrap() - e.lufs.unwrap()).abs() < 0.05);
        // LWE ignores the 0.5: both at unity
        let (_, e) = est(&sounds, &Map::new(), Model::Lwe, &st);
        assert!((e.lufs.unwrap() - lufs_of(pa + pb)).abs() < 0.06);
    }

    #[test]
    fn volume_forms_and_property_bindings() {
        let props = property_values(
            &json!({"general": {"properties": {
                "music": {"type": "slider", "value": 0.8},
                "rain": {"type": "bool", "value": true},
                "weather": {"type": "combo", "value": "Snow"},
                "n": {"type": "combo", "value": "2"},
                "label": {"type": "textinput", "value": "x"}}}}),
            Some(&json!({"music": 0.25}).as_object().unwrap().clone()),
        );
        let v = |j: Value| eval_volume(&parse_volume(Some(&j)), &props);
        assert_eq!(v(json!(0.5)), 0.5);
        assert_eq!(v(json!("0.3")), 0.3);
        assert_eq!(eval_volume(&parse_volume(None), &props), 1.0);
        assert_eq!(
            v(json!({"user": "music", "value": 0.8})),
            0.25,
            "override wins"
        );
        assert_eq!(
            v(json!({"user": "rain", "value": 0.7})),
            1.0,
            "bool true → 1"
        );
        assert_eq!(
            v(json!({"user": "gone", "value": 0.7})),
            0.7,
            "missing property → literal"
        );
        assert_eq!(
            v(json!({"user": "label", "value": 0.7})),
            0.7,
            "non-numeric → literal"
        );
        assert_eq!(
            v(json!({"user": {"name": "weather", "condition": "Snow"}, "value": 0.0})),
            1.0
        );
        assert_eq!(
            v(json!({"user": {"name": "weather", "condition": "Rain"}, "value": 1.0})),
            0.0
        );
        assert_eq!(
            v(json!({"user": {"name": "n", "condition": "2"}, "value": 0.0})),
            1.0
        );
        assert_eq!(v(json!(-1.0)), 0.0, "never negative");
        assert!(parse_volume(Some(&json!({"script": "x", "value": 1.0}))).scripted);
    }

    fn two_sound_fixture() -> (Value, Value) {
        let project = json!({"type": "scene", "general": {"properties": {
            "rain": {"type": "bool", "value": true},
            "schemecolor": {"type": "color", "value": "0 0 0"},
            "tint": {"type": "color", "value": "1 0 0"}}}});
        let scene = json!({"objects": [
            sound(1, &["music.wav"], "loop", json!(1.0)),
            sound(2, &["rain.wav"], "loop", json!({"user": "rain", "value": 1.0})),
            {"id": 3, "name": "img", "image": "models/x.json", "color": {"user": "tint", "value": "1 0 0"}}]});
        (project, scene)
    }

    /// The owner's case: a bool property disables one of two sounds → the fingerprint changes
    /// and the estimate drops by exactly that sound's power; a colour property → the same
    /// fingerprint and estimate. Under LWE (volume ignored) neither changes anything.
    #[test]
    fn audio_property_changes_the_fingerprint_a_visual_one_never() {
        let (project, scene) = two_sound_fixture();
        let sounds = parse_sounds(&scene);
        assert_eq!(sounds.len(), 2);
        let mut st = HashMap::new();
        st.insert("music.wav".to_string(), stats_of(&sine(1000.0, 0.1, 6.0)));
        st.insert("rain.wav".to_string(), stats_of(&sine(300.0, 0.1, 6.0)));
        let o = |j: Value| j.as_object().unwrap().clone();
        let on = property_values(&project, None);
        let off = property_values(&project, Some(&o(json!({"rain": false}))));
        let recoloured = property_values(
            &project,
            Some(&o(json!({"tint": "0 1 0", "schemecolor": "1 1 1"}))),
        );
        let (p_on, e_on) = est(&sounds, &on, Model::We, &st);
        let (p_off, e_off) = est(&sounds, &off, Model::We, &st);
        let (p_col, e_col) = est(&sounds, &recoloured, Model::We, &st);
        let (f_on, f_off, f_col) = (
            fingerprint(&p_on, Model::We),
            fingerprint(&p_off, Model::We),
            fingerprint(&p_col, Model::We),
        );
        assert_ne!(f_on, f_off);
        assert_eq!(f_on, f_col);
        assert_eq!(p_off.tracks.len(), 1);
        let (pm, pr) = (st["music.wav"].power[10], st["rain.wav"].power[10]);
        assert!((e_on.lufs.unwrap() - lufs_of(pm + pr)).abs() < 0.06);
        assert!((e_off.lufs.unwrap() - lufs_of(pm)).abs() < 0.06);
        let drop = e_on.lufs.unwrap() - e_off.lufs.unwrap();
        assert!(
            (drop - 10.0 * ((pm + pr) / pm).log10()).abs() < 0.06,
            "drop {drop}"
        );
        assert_eq!(e_on.lufs, e_col.lufs);
        // LWE plays both whatever the property says
        let fl = |props| fingerprint(&plan(&sounds, props, Model::Lwe), Model::Lwe);
        assert_eq!(fl(&on), fl(&off));
        assert!(fl(&on).starts_with("lwe-") && f_on.starts_with("we-"));
    }

    /// LWE's rules: every file of an object at once at unity, looping only for `loop`.
    #[test]
    fn lwe_plays_every_file_at_once_and_non_loops_once() {
        let sounds = parse_sounds(&json!({"objects": [
            sound(1, &["a", "b"], "loop", json!(0.3)), sound(2, &["c"], "single", json!(1.0))]}));
        let p = plan(&sounds, &Map::new(), Model::Lwe);
        assert_eq!(p.tracks.len(), 3);
        assert!(p.tracks.iter().all(|t| t.gain == 1.0));
        assert_eq!(p.tracks[2].pattern, Pattern::Once(vec!["c".into()]));
        let mut st = HashMap::new();
        st.insert("a".to_string(), stats_of(&sine(1000.0, 0.1, 4.0)));
        st.insert("b".to_string(), stats_of(&sine(500.0, 0.1, 6.0)));
        st.insert("c".to_string(), stats_of(&sine(250.0, 0.5, 2.0)));
        let m = mix(&p, &st);
        // loops of 4 s and 6 s → 4 × 6 s, at least the 60 s window
        assert!((m.horizon_s - 60.0).abs() < 1e-9);
        let (pa, pb, pc) = (st["a"].power[5], st["b"].power[5], st["c"].power[5]);
        assert!((m.segments[5].power - (pa + pb + pc)).abs() / (pa + pb + pc) < 1e-9);
        // past c's 2 s it's gone; a and b keep cycling
        assert!((m.segments[30].power - (pa + pb)).abs() / (pa + pb) < 1e-6);
        assert!((m.segments[45].power - (st["a"].power[5] + st["b"].power[45])).abs() < 1e-9);
    }

    /// Two equal-length files that are the same recording: the power sum under-reads by 3 dB
    /// (the real mix doubles the amplitude: +6), the coherent bound is exact; two unrelated
    /// equal-length files stay a power sum (the bound only brackets).
    #[test]
    fn equal_length_files_get_a_coherent_bound() {
        let x = sine(1000.0, 0.1, 8.0);
        let mut st = HashMap::new();
        st.insert("v".to_string(), stats_of(&x));
        st.insert("i".to_string(), stats_of(&x));
        let sounds = parse_sounds(&json!({"objects": [sound(1, &["v", "i"], "loop", json!(1.0))]}));
        let p = plan(&sounds, &Map::new(), Model::Lwe);
        let m = mix(&p, &st);
        assert_eq!(m.coherent_groups, 1);
        let incoherent = estimate(&m).lufs.unwrap();
        let bound = estimate(&mix_with(&p, &st, None, true)).lufs.unwrap();
        let one = lufs_of(st["v"].power[10]);
        assert!(
            (incoherent - (one + 3.0103)).abs() < 0.06,
            "{incoherent} {one}"
        );
        assert!((bound - (one + 6.0206)).abs() < 0.06, "{bound} {one}");
        // different lengths: no group
        st.insert("i".to_string(), stats_of(&sine(1000.0, 0.1, 3.0)));
        assert_eq!(mix(&p, &st).coherent_groups, 0);
    }

    /// WE's `random`: one file at a time with the mean gap of silence (gated out) — the
    /// time-weighted mix of the files.
    #[test]
    fn random_mode_is_a_time_weighted_mix() {
        let sounds =
            parse_sounds(&json!({"objects": [sound(1, &["q", "l"], "random", json!(1.0))]}));
        let p = plan(&sounds, &Map::new(), Model::We);
        assert_eq!(
            p.tracks[0].pattern,
            Pattern::Shuffle {
                files: vec!["q".into(), "l".into()],
                gap_s: 3.0
            }
        );
        let (q, l) = (sine(1000.0, 0.05, 5.0), sine(1000.0, 0.1, 5.0));
        let mut st = HashMap::new();
        st.insert("q".to_string(), stats_of(&q));
        st.insert("l".to_string(), stats_of(&l));
        let m = mix(&p, &st);
        let e = estimate(&m);
        // the same play as real audio: q, 3 s of silence, l, 3 s of silence, … over the horizon
        let gap = vec![0f32; 3 * RATE as usize * 2];
        let cycle: Vec<f32> = [&q[..], &gap, &l, &gap].concat();
        let n = (m.horizon_s * SR) as usize * 2;
        let real: Vec<f32> = cycle.iter().copied().cycle().take(n).collect();
        let real = stats_of(&real);
        let mut lr = Learner::new(1e9).with_cap(1e9);
        for (p, k) in real.power.iter().zip(&real.peak) {
            let _ = lr.push(Segment {
                power: *p,
                peak: *k,
            });
        }
        let want = lr.integrated().unwrap();
        assert!(
            (e.lufs.unwrap() - want).abs() < 0.05,
            "{:?} vs {want}",
            e.lufs
        );
        // and close to the files' energy mean (the gaps are gated out; the ramps in/out of
        // each file form a few quieter blocks)
        let mean = lufs_of((st["q"].power[10] + st["l"].power[10]) / 2.0);
        assert!((e.lufs.unwrap() - mean).abs() < 0.5);
    }

    /// WE's defaults: an absent `playbackmode` loops, absent `mintime`/`maxtime` are 1 / 5 s,
    /// and the stream's amplitude is volume².
    #[test]
    fn we_defaults_and_squared_volume() {
        let sounds = parse_sounds(&json!({"objects": [
            {"id": 1, "sound": ["a", "b"], "volume": 0.5},
            {"id": 2, "sound": ["c"], "playbackmode": "random"}]}));
        let p = plan(&sounds, &Map::new(), Model::We);
        assert_eq!(p.tracks[0].pattern, Pattern::Loop(vec!["a".into(), "b".into()]));
        assert!((p.tracks[0].gain - 0.25).abs() < 1e-12);
        assert_eq!(
            p.tracks[1].pattern,
            Pattern::Shuffle {
                files: vec!["c".into()],
                gap_s: 3.0
            }
        );
        assert_eq!(p.tracks[1].gain, 1.0);
    }

    #[test]
    fn startsilent_and_zero_volume_are_silent_under_we() {
        let mut s = sound(1, &["a"], "loop", json!(0.0));
        let mut t = sound(2, &["b"], "loop", json!(1.0));
        t["startsilent"] = json!(true);
        s["id"] = json!(1);
        let p = plan(
            &parse_sounds(&json!({"objects": [s, t]})),
            &Map::new(),
            Model::We,
        );
        assert!(p.tracks.is_empty());
        assert_eq!(p.silent.len(), 2);
        assert!(
            p.notes
                .iter()
                .any(|n| n.0 == 2 && n.1.contains("startsilent"))
        );
    }

    /// The seed is the live learner's own state shape, scaled: it parses, holds the weight's
    /// audible seconds and integrates to the same loudness.
    #[test]
    fn scaled_seed_is_a_valid_learner_state() {
        let mut st = HashMap::new();
        let mut sig = sine(1000.0, 0.1, 5.0);
        sig.extend(sine(1000.0, 0.02, 5.0)); // two levels → two bins
        st.insert("a".to_string(), stats_of(&sig));
        let sounds = parse_sounds(&json!({"objects": [sound(1, &["a"], "loop", json!(1.0))]}));
        let e = estimate(&mix(&plan(&sounds, &Map::new(), Model::Lwe), &st));
        let seed = scale_state(&e.state, 10.0).unwrap();
        let l = Learner::new(60.0).with_seed(Some(&seed));
        assert!((l.audible_s() - 10.0).abs() < 1e-9, "{}", l.audible_s());
        assert!((l.integrated().unwrap() - e.lufs.unwrap()).abs() < 0.15);
        let full = Learner::new(60.0).with_seed(Some(&e.state));
        assert!((full.integrated().unwrap() - e.lufs.unwrap()).abs() < 1e-9);
        assert!(
            scale_state(
                &json!({"v": 1, "first": 0, "counts": [], "peak_dbfs": null}),
                10.0
            )
            .is_none()
        );
    }

    /// The per-file cache: a re-estimate under other properties decodes nothing; the disk cache
    /// survives a new process (a fresh `Cache`) and refuses a stale key.
    #[test]
    fn cache_reuses_stats_in_memory_and_on_disk() {
        let dir = std::env::temp_dir().join(format!("lia-sl-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f = dir.join("x.raw");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&f, b"not audio").unwrap();
        let src = AudioRef::File(f.clone());
        let key = src.key();
        let s = FileStats::from_interleaved(&sine(1000.0, 0.1, 1.0));
        let cdir = dir.join("cache");
        let file = cdir.join(format!("{:016x}.json", fnv64(key.as_bytes())));
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(&file, s.to_json(&key).to_string()).unwrap();
        let mut c = Cache::new(Some(cdir.clone()));
        let same = |a: &FileStats| {
            a.frames == s.frames
                && a.peak == s.peak
                && a.power
                    .iter()
                    .zip(&s.power)
                    .all(|(x, y)| (x - y).abs() <= 1e-12 * y.abs())
        };
        assert!(same(&c.stats(&src).unwrap()));
        assert!(same(&c.stats(&src).unwrap()));
        assert_eq!((c.disk_hits, c.hits, c.decodes), (1, 1, 0));
        // a different key (the file changed) never takes the stale entry
        std::fs::write(&file, s.to_json("file:other").to_string()).unwrap();
        let mut c = Cache::new(Some(cdir));
        assert!(
            c.stats(&src).is_err(),
            "falls through to decoding (not audio)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- end to end through ffmpeg (SKIP without it) -------------------------------------

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// 16-bit PCM WAV, interleaved stereo or mono.
    pub(crate) fn wav(samples: &[f32], channels: u16) -> Vec<u8> {
        let data: Vec<u8> = samples
            .iter()
            .flat_map(|v| ((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes())
            .collect();
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&channels.to_le_bytes());
        w.extend_from_slice(&RATE.to_le_bytes());
        w.extend_from_slice(&(RATE * channels as u32 * 2).to_le_bytes());
        w.extend_from_slice(&(channels * 2).to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(data.len() as u32).to_le_bytes());
        w.extend_from_slice(&data);
        w
    }

    /// A packaged scene (scene.json + two WAVs inside a generated scene.pkg, one of them mono),
    /// estimated end to end: the stereo sine at −20 dBFS alone reads −20.0; turning the bool
    /// on (WE model) adds the mono one (FFmpeg's mono → stereo at −3 dB per channel, as LWE's
    /// resampler) — and the re-estimate decodes nothing.
    #[test]
    fn packaged_scene_end_to_end() {
        if !have_ffmpeg() {
            eprintln!("SKIP: no ffmpeg");
            return;
        }
        let dir = std::env::temp_dir().join(format!("lia-sl-scene-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = 10f32.powf(-20.0 / 20.0);
        let stereo = wav(&sine(1000.0, a, 6.0), 2);
        let mono: Vec<f32> = sine(1000.0, a, 6.0).into_iter().step_by(2).collect();
        let mono = wav(&mono, 1);
        let scene = json!({"objects": [
            sound(1, &["sounds/a.wav"], "loop", json!(1.0)),
            sound(2, &["sounds/Mono.wav"], "loop", json!({"user": "extra", "value": 0.0}))]})
        .to_string();
        let pkg = super::super::pkg::build(
            "PKGV0021",
            &[
                ("scene.json", scene.as_bytes()),
                ("sounds/a.wav", &stereo),
                ("sounds/Mono.wav", &mono),
            ],
        );
        std::fs::write(dir.join("scene.pkg"), pkg).unwrap();
        std::fs::write(
            dir.join("project.json"),
            json!({"type": "Scene", "file": "scene.json", "general": {"properties": {
                "extra": {"type": "bool", "value": false}}}})
            .to_string(),
        )
        .unwrap();
        let sd = SceneDir::open(&dir, None).unwrap();
        let mut cache = Cache::new(None);
        let r = estimate_scene(
            &sd,
            &Opts {
                model: Model::We,
                ..Opts::default()
            },
            &mut cache,
        );
        let l = r["lufs"].as_f64().unwrap();
        assert!((l + 20.0).abs() < 0.1, "{r}");
        assert_eq!(r["estimated"], true);
        assert_eq!(r["cache"]["decodes"], 1, "only the active file decoded");
        let props = json!({"extra": true}).as_object().unwrap().clone();
        let r2 = estimate_scene(
            &sd,
            &Opts {
                model: Model::We,
                props: Some(props),
                ..Opts::default()
            },
            &mut cache,
        );
        assert_ne!(r["fingerprint"], r2["fingerprint"]);
        // −20 LUFS + the mono one at −3 dB per channel (−23 LUFS stereo) in phase: the power
        // sum of uncorrelated ≈ −18.24; this one is the same tone, so it's correlated — the
        // estimator's power sum still says −18.24 (documented limit: same-frequency content)
        let l2 = r2["lufs"].as_f64().unwrap();
        assert!(
            (l2 - lufs_of(
                10f64.powf((-20.0 + 0.691) / 10.0) + 10f64.powf((-23.01 + 0.691) / 10.0)
            ))
            .abs()
                < 0.15,
            "{r2}"
        );
        assert_eq!(r2["cache"]["decodes"], 2);
        let r3 = estimate_scene(
            &sd,
            &Opts {
                model: Model::We,
                ..Opts::default()
            },
            &mut cache,
        );
        assert_eq!(r3["cache"]["decodes"], 2, "re-mix only");
        assert_eq!(r3["lufs"], r["lufs"]);
        // LWE: both play, whatever `extra` says
        let rl = estimate_scene(&sd, &Opts::default(), &mut cache);
        assert!((rl["lufs"].as_f64().unwrap() - l2).abs() < 1e-9, "{rl}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
