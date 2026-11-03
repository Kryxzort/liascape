//! The "now playing" feed for SceneScript's media events (gap audit B10, S11–S14): thread
//! `lia-scene-media` reads the system's MPRIS players over the session bus once a second, and
//! [`Media::apply`] (on the render thread, before a frame) hands what changed to LWE's
//! `wp_project_notify_*`. Started only for a scene that takes media events
//! (`wp_project_uses_media`); `LIASCAPE_SCENE_MEDIA=0` turns it off.
//!
//! **Which player** (the audit's open decision, settled here): the one that is `Playing`
//! (the one chosen before, while it still plays), else the first `Paused` one, else none.
//! `playerctld` is skipped (it mirrors another player). Windows' "current media session" is one
//! session the same way.
//!
//! **Album art**: `mpris:artUrl` as given when it is `file://`; an `http(s)://` one (Spotify) is
//! fetched once with `curl` into `$XDG_CACHE_HOME/liascape/media-art/` and given as that file.
//! Without curl, or for other schemes, the scene gets no thumbnail (`hasThumbnail: false`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zbus::blocking::Connection;
use zbus::zvariant::OwnedValue;

/// How often the players are read (the timeline's resolution).
const POLL: Duration = Duration::from_secs(1);
const CALL_TIMEOUT: Duration = Duration::from_millis(400);
const PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";

/// `wp_media_playback_state`.
pub const STOPPED: i32 = 0;
pub const PLAYING: i32 = 1;
pub const PAUSED: i32 = 2;

/// What the chosen player reports (empty strings: unknown).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genres: String,
    /// a `file://` URL, or empty
    pub art: String,
    pub state: i32,
    pub position: f64,
    pub length: f64,
}

#[derive(Default)]
struct Shared {
    /// `None` = no session bus (media integration off)
    bus: Mutex<Option<bool>>,
    track: Mutex<Track>,
    version: AtomicU64,
}

/// The feed of one scene: its thread stops when the scene drops it.
pub struct Media {
    shared: Arc<Shared>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    applied: u64,
    last: Option<Track>,
    status_sent: Option<bool>,
}

impl Media {
    pub fn start() -> Option<Media> {
        if std::env::var("LIASCAPE_SCENE_MEDIA").as_deref() == Ok("0") {
            return None;
        }
        let shared = Arc::new(Shared::default());
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s, st) = (shared.clone(), stop.clone());
        std::thread::Builder::new()
            .name("lia-scene-media".into())
            .spawn(move || run(&s, &st))
            .ok()?;
        Some(Media {
            shared,
            stop,
            applied: 0,
            last: None,
            status_sent: None,
        })
    }

    /// What changed since the last call, as `wp_project_notify_*` calls (`notify` gets them).
    pub fn apply(&mut self, notify: &mut dyn FnMut(Notify<'_>)) {
        let bus = *self.shared.bus.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(on) = bus
            && self.status_sent != Some(on)
        {
            self.status_sent = Some(on);
            notify(Notify::Status(on));
        }
        let v = self.shared.version.load(Ordering::SeqCst);
        if v == self.applied {
            return;
        }
        self.applied = v;
        let t = self
            .shared
            .track
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let prev = self.last.take().unwrap_or(Track {
            state: -1,
            ..Track::default()
        });
        if (&t.title, &t.artist, &t.album, &t.album_artist, &t.genres)
            != (
                &prev.title,
                &prev.artist,
                &prev.album,
                &prev.album_artist,
                &prev.genres,
            )
        {
            notify(Notify::Properties(&t));
        }
        if t.art != prev.art || self.applied == 1 {
            notify(Notify::Art(&t.art));
        }
        if t.state != prev.state {
            notify(Notify::State(t.state));
        }
        notify(Notify::Timeline(t.position, t.length));
        self.last = Some(t);
    }
}

impl Drop for Media {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub enum Notify<'a> {
    Status(bool),
    Properties(&'a Track),
    Art(&'a str),
    State(i32),
    Timeline(f64, f64),
}

fn run(shared: &Shared, stop: &std::sync::atomic::AtomicBool) {
    let conn = match zbus::blocking::connection::Builder::session()
        .map(|b| b.method_timeout(CALL_TIMEOUT))
        .and_then(|b| b.build())
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("scene media: no session bus ({e}): media events off");
            *shared.bus.lock().unwrap_or_else(|e| e.into_inner()) = Some(false);
            return;
        }
    };
    *shared.bus.lock().unwrap_or_else(|e| e.into_inner()) = Some(true);
    let mut chosen: Option<String> = None;
    let mut art_cache: HashMap<String, String> = HashMap::new();
    let mut last: Option<Track> = None;
    while !stop.load(Ordering::SeqCst) {
        let track = read(&conn, &mut chosen, &mut art_cache).unwrap_or_default();
        if last.as_ref() != Some(&track) {
            *shared.track.lock().unwrap_or_else(|e| e.into_inner()) = track.clone();
            shared.version.fetch_add(1, Ordering::SeqCst);
            last = Some(track);
        }
        std::thread::sleep(POLL);
    }
}

fn call<T: serde::de::DeserializeOwned + zbus::zvariant::Type>(
    conn: &Connection,
    dest: &str,
    iface: &str,
    method: &str,
    body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
) -> Option<T> {
    conn.call_method(Some(dest), PATH, Some(iface), method, body)
        .ok()?
        .body()
        .deserialize::<T>()
        .ok()
}

fn names(conn: &Connection) -> Vec<String> {
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "ListNames",
        &(),
    )
    .ok()
    .and_then(|m| m.body().deserialize::<Vec<String>>().ok())
    .unwrap_or_default()
    .into_iter()
    .filter(|n| n.starts_with(PREFIX) && n != "org.mpris.MediaPlayer2.playerctld")
    .collect()
}

fn string(v: Option<&OwnedValue>) -> String {
    v.and_then(|v| String::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default()
}

fn strings(v: Option<&OwnedValue>) -> String {
    v.and_then(|v| Vec::<String>::try_from(v.try_clone().ok()?).ok())
        .map(|l| l.join(", "))
        .unwrap_or_default()
}

/// µs (`x` or `t`) → s
fn micros(v: Option<&OwnedValue>) -> f64 {
    let Some(v) = v else { return 0.0 };
    if let Ok(x) = i64::try_from(v) {
        return x as f64 / 1e6;
    }
    if let Ok(x) = u64::try_from(v) {
        return x as f64 / 1e6;
    }
    0.0
}

fn read(
    conn: &Connection,
    chosen: &mut Option<String>,
    art_cache: &mut HashMap<String, String>,
) -> Option<Track> {
    let mut players: Vec<(String, HashMap<String, OwnedValue>)> = names(conn)
        .into_iter()
        .filter_map(|n| {
            let props: HashMap<String, OwnedValue> =
                call(conn, &n, "org.freedesktop.DBus.Properties", "GetAll", &(PLAYER,))?;
            Some((n, props))
        })
        .collect();
    let status = |p: &HashMap<String, OwnedValue>| string(p.get("PlaybackStatus"));
    // the chosen one while it plays, else the first playing one, else the first paused one
    let pick = players
        .iter()
        .position(|(n, p)| Some(n) == chosen.as_ref() && status(p) == "Playing")
        .or_else(|| players.iter().position(|(_, p)| status(p) == "Playing"))
        .or_else(|| players.iter().position(|(_, p)| status(p) == "Paused"))?;
    let (name, props) = players.swap_remove(pick);
    *chosen = Some(name);
    let meta: HashMap<String, OwnedValue> = props
        .get("Metadata")
        .and_then(|m| HashMap::<String, OwnedValue>::try_from(m.try_clone().ok()?).ok())
        .unwrap_or_default();
    let state = match status(&props).as_str() {
        "Playing" => PLAYING,
        "Paused" => PAUSED,
        _ => STOPPED,
    };
    let url = string(meta.get("mpris:artUrl"));
    Some(Track {
        title: string(meta.get("xesam:title")),
        artist: strings(meta.get("xesam:artist")),
        album: string(meta.get("xesam:album")),
        album_artist: strings(meta.get("xesam:albumArtist")),
        genres: strings(meta.get("xesam:genre")),
        art: art_file(&url, art_cache),
        state,
        position: micros(props.get("Position")),
        length: micros(meta.get("mpris:length")),
    })
}

/// A `file://` URL for the art: as given, or an http(s) one fetched once into the cache.
fn art_file(url: &str, cache: &mut HashMap<String, String>) -> String {
    if url.is_empty() || url.starts_with("file://") {
        return url.to_string();
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return String::new();
    }
    if let Some(f) = cache.get(url) {
        return f.clone();
    }
    let dir = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .map(|c| c.join("liascape/media-art"));
    let Some(dir) = dir else {
        return String::new();
    };
    // FNV-1a of the URL names the file
    let mut h: u64 = 0xcbf29ce484222325;
    for b in url.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    let file = dir.join(format!("{h:016x}"));
    if !file.is_file() {
        let _ = std::fs::create_dir_all(&dir);
        let part = dir.join(format!("{h:016x}.part"));
        let ok = std::process::Command::new("curl")
            .args(["-sfL", "--max-time", "5", "--max-filesize", "8000000", "-o"])
            .arg(&part)
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok || std::fs::rename(&part, &file).is_err() {
            let _ = std::fs::remove_file(&part);
            cache.insert(url.to_string(), String::new());
            return String::new();
        }
    }
    let out = format!("file://{}", file.display());
    cache.insert(url.to_string(), out.clone());
    out
}
