//! Which playback streams the in-player auto-mute (Phase 3 Task 14, `crate::signal::automute`)
//! **counts** — pure rules on registry data, no PipeWire calls (`audio::sysmon` feeds them).
//!
//! - **Ownership, never names** (spec §4.4; owner 2026-10-29: "no default exclusions"): a stream is
//!   the player's own when its process is the player or one of its descendants (the scene workers),
//!   when it targets the bus (`target.object` / `node.target` = `liascape-player-bus` or its serial)
//!   or when it is linked into the bus sink. Everything else is **foreign** and counts: a user-run
//!   `mpv`, voice chat, notifications. `application.name = liascape-player` alone proves nothing.
//! - **The process** of a stream: the node's own `application.process.id`, else its Client's
//!   (`client.id` → the Client object: a native PipeWire node carries no pid). **Never
//!   `pipewire.sec.pid`**: for pipewire-pulse clients it is the pulse server's pid (measured on the
//!   owner's machine 2026-10-29, `scripts/probe-mpris-streams.py`).
//! - **"Only if an MPRIS player is active"** hears only a Playing player's own streams
//!   ([`match_player`]): the stream's pid is the player's pid or a descendant (a browser's audio
//!   service is a child of the process owning the MPRIS name), else its Flatpak app id equals the
//!   player's `DesktopEntry`, else its binary / `application.name` equals `DesktopEntry` or
//!   `Identity` (case-insensitive, NixOS `.foo-wrapped` stripped; `DesktopEntry` may be absent —
//!   Chromium).
//! - **Silent by its own volume** ([`StreamVolume::silent`]): `mute` or every `channelVolumes` 0 in
//!   the node's `Props`. An empty `channelVolumes` is unknown, not silent.

use std::collections::BTreeSet;

/// What a playback node and its client say about who plays it (registry props).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Identity {
    /// `application.process.id` (the node's, else its client's); never `pipewire.sec.pid`.
    pub pid: Option<u32>,
    /// `application.process.binary` (node, else client).
    pub binary: String,
    /// `application.name` (node, else client).
    pub app_name: String,
    /// `pipewire.access.portal.app_id`, else `flatpak.app-id`/`application.id` of a sandboxed client.
    pub portal_app_id: Option<String>,
    /// `target.object` / `node.target` of the node ("" none).
    pub target: String,
}

/// The player's own processes and bus, for [`classify`].
#[derive(Debug, Clone, Default)]
pub struct OwnCtx {
    pub player_pid: u32,
    /// Scene worker pids the runtime knows (also caught as descendants of `player_pid`).
    pub worker_pids: BTreeSet<u32>,
    /// The bus sink's `node.name` and, when seen, its `object.serial` / node id.
    pub bus_name: String,
    pub bus_serial: Option<u64>,
    pub bus_node: Option<u32>,
}

/// Why a stream counts or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The player's own: by `pid` (the player itself), `worker` (a scene worker / descendant),
    /// `target` (aims at the bus) or `link` (linked into the bus sink).
    Own(&'static str),
    Foreign,
}

impl Verdict {
    pub fn as_str(&self) -> String {
        match self {
            Verdict::Own(why) => format!("own:{why}"),
            Verdict::Foreign => "foreign".into(),
        }
    }
    pub fn foreign(&self) -> bool {
        *self == Verdict::Foreign
    }
}

/// `pid` is `ancestor` or one of its descendants (`parent_of` = the ppid, `/proc/<pid>/stat`).
pub fn in_tree(pid: u32, ancestor: u32, parent_of: &dyn Fn(u32) -> Option<u32>) -> bool {
    let mut p = pid;
    for _ in 0..64 {
        if p == ancestor {
            return true;
        }
        match parent_of(p) {
            Some(pp) if pp > 1 && pp != p => p = pp,
            _ => return false,
        }
    }
    false
}

/// The parent pid of `pid` (`/proc/<pid>/stat` field 4, after the `(comm)`).
pub fn proc_ppid(pid: u32) -> Option<u32> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &s[s.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Ownership of one playback stream (see the module doc). `linked_to_bus`: a link from this node
/// into the bus sink exists.
pub fn classify(
    id: &Identity,
    linked_to_bus: bool,
    own: &OwnCtx,
    parent_of: &dyn Fn(u32) -> Option<u32>,
) -> Verdict {
    if let Some(pid) = id.pid {
        if pid == own.player_pid {
            return Verdict::Own("pid");
        }
        if own.worker_pids.contains(&pid) || in_tree(pid, own.player_pid, parent_of) {
            return Verdict::Own("worker");
        }
    }
    if !id.target.is_empty()
        && (id.target == own.bus_name
            || own.bus_serial.is_some_and(|s| id.target == s.to_string())
            || own.bus_node.is_some_and(|n| id.target == n.to_string()))
    {
        return Verdict::Own("target");
    }
    if linked_to_bus {
        return Verdict::Own("link");
    }
    Verdict::Foreign
}

/// A stream's own volume (`Props`: `mute`, `channelVolumes` — cubic, as PipeWire stores them).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamVolume {
    pub mute: Option<bool>,
    pub channel_volumes: Vec<f32>,
    /// The master `volume` (`pw-cat --volume`, `pw_stream_set_control`), when the node has one.
    pub volume: Option<f32>,
}

impl StreamVolume {
    /// Muted, the master volume at 0, or every channel at 0. No `Props` yet / an empty list = unknown → not silent.
    pub fn silent(&self) -> bool {
        self.mute == Some(true)
            || self.volume.is_some_and(|v| v <= 0.0)
            || (!self.channel_volumes.is_empty() && self.channel_volumes.iter().all(|v| *v <= 0.0))
    }
}

/// One `org.mpris.MediaPlayer2.*` player (`crate::signal::mpris`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MprisPlayer {
    pub bus_name: String,
    pub identity: String,
    pub desktop_entry: Option<String>,
    /// `GetConnectionUnixProcessID` of the bus name's owner.
    pub pid: Option<u32>,
    pub playing: bool,
    pub title: String,
}

/// How a stream belongs to an MPRIS player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchHow {
    PidTree,
    AppId,
    Name,
}

impl MatchHow {
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchHow::PidTree => "pid_tree",
            MatchHow::AppId => "app_id",
            MatchHow::Name => "name",
        }
    }
}

/// A name for comparison: lowercase, NixOS's `.foo-wrapped` → `foo`, a trailing `.desktop` dropped.
pub fn norm_name(s: &str) -> String {
    let s = s.trim().to_lowercase();
    let s = s.strip_suffix(".desktop").unwrap_or(&s);
    let s = s.strip_prefix('.').unwrap_or(s);
    let s = s.strip_suffix("-wrapped").unwrap_or(s);
    s.to_string()
}

fn names_match(a: &str, b: &str) -> bool {
    let (a, b) = (norm_name(a), norm_name(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    // `org.mozilla.firefox` ~ `firefox` (a reverse-DNS desktop id's last part)
    let last = |s: &str| s.rsplit('.').next().unwrap_or("").to_string();
    a == b || last(&a) == b || a == last(&b)
}

/// Whether stream `id` belongs to MPRIS player `p` (the rules in the module doc, in order).
pub fn match_player(
    id: &Identity,
    p: &MprisPlayer,
    parent_of: &dyn Fn(u32) -> Option<u32>,
) -> Option<MatchHow> {
    if let (Some(sp), Some(pp)) = (id.pid, p.pid)
        && pp > 1
        && in_tree(sp, pp, parent_of)
    {
        return Some(MatchHow::PidTree);
    }
    if let (Some(app), Some(de)) = (&id.portal_app_id, &p.desktop_entry)
        && !app.is_empty()
        && norm_name(app) == norm_name(de)
    {
        return Some(MatchHow::AppId);
    }
    let theirs = [p.desktop_entry.as_deref().unwrap_or(""), p.identity.as_str()];
    let ours = [id.binary.as_str(), id.app_name.as_str()];
    if ours
        .iter()
        .any(|o| theirs.iter().any(|t| names_match(o, t)))
    {
        return Some(MatchHow::Name);
    }
    None
}

/// The Playing player stream `id` belongs to, if any: `(bus name, how)`.
pub fn playing_owner<'a>(
    id: &Identity,
    players: &'a [MprisPlayer],
    parent_of: &dyn Fn(u32) -> Option<u32>,
) -> Option<(&'a MprisPlayer, MatchHow)> {
    players
        .iter()
        .filter(|p| p.playing)
        .find_map(|p| match_player(id, p, parent_of).map(|m| (p, m)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A fake process tree: 100 = the player (its parent 50 = the supervisor), 101 = a scene
    /// worker, 300 = a browser, 301 its audio service, 400 = mpv, 500 = paplay.
    fn tree() -> impl Fn(u32) -> Option<u32> {
        let m: BTreeMap<u32, u32> = [
            (100, 50),
            (50, 1),
            (101, 100),
            (300, 1),
            (301, 300),
            (302, 301),
            (400, 1),
            (500, 1),
        ]
        .into();
        move |p| m.get(&p).copied()
    }

    fn own() -> OwnCtx {
        OwnCtx {
            player_pid: 100,
            worker_pids: [101].into(),
            bus_name: "liascape-player-bus".into(),
            bus_serial: Some(77),
            bus_node: Some(42),
        }
    }

    fn ident(pid: Option<u32>, binary: &str, name: &str) -> Identity {
        Identity {
            pid,
            binary: binary.into(),
            app_name: name.into(),
            ..Identity::default()
        }
    }

    #[test]
    fn foreign_streams_are_classified_by_ownership() {
        let t = tree();
        let o = own();
        // the player's own mpv (in-process), whatever it is called
        let mpv_src = ident(Some(100), "liascape-player", "liascape-player");
        assert_eq!(classify(&mpv_src, false, &o, &t), Verdict::Own("pid"));
        // a scene worker, by the known pid and as a descendant
        let w = ident(Some(101), "liascape-scene-worker", "liascape-player");
        assert_eq!(classify(&w, false, &o, &t), Verdict::Own("worker"));
        let mut o2 = o.clone();
        o2.worker_pids.clear();
        assert_eq!(classify(&w, false, &o2, &t), Verdict::Own("worker"));
        // anything aimed at the bus: by name, serial, or node id; or linked into it
        for target in ["liascape-player-bus", "77", "42"] {
            let mut s = ident(None, "", "x");
            s.target = target.into();
            assert_eq!(classify(&s, false, &o, &t), Verdict::Own("target"), "{target}");
        }
        assert_eq!(
            classify(&ident(None, "", "x"), true, &o, &t),
            Verdict::Own("link")
        );
        // foreign: paplay, a user's mpv (the old `application.name = mpv` filter was a bug),
        // a stream that only *claims* our name, one with no pid at all
        assert!(classify(&ident(Some(500), "paplay", "paplay"), false, &o, &t).foreign());
        assert!(classify(&ident(Some(400), "mpv", "mpv"), false, &o, &t).foreign());
        assert!(
            classify(&ident(Some(400), "mpv", "liascape-player"), false, &o, &t).foreign(),
            "never by name"
        );
        assert!(classify(&ident(None, "", ""), false, &o, &t).foreign());
        let mut other = ident(Some(500), "paplay", "paplay");
        other.target = "hermetic-sink".into();
        assert!(classify(&other, false, &o, &t).foreign());
    }

    fn player(pid: Option<u32>, identity: &str, de: Option<&str>) -> MprisPlayer {
        MprisPlayer {
            bus_name: format!("org.mpris.MediaPlayer2.{identity}"),
            identity: identity.into(),
            desktop_entry: de.map(str::to_string),
            pid,
            playing: true,
            title: String::new(),
        }
    }

    #[test]
    fn mpris_streams_match_by_pid_tree_then_app_id_then_name() {
        let t = tree();
        // Opera: the MPRIS name is owned by 300, the audio comes from its child 301 (and 302)
        let opera = player(Some(300), "Opera", None);
        let tab = ident(Some(301), "opera", "Chromium input");
        assert_eq!(match_player(&tab, &opera, &t), Some(MatchHow::PidTree));
        assert_eq!(
            match_player(&ident(Some(302), "x", "y"), &opera, &t),
            Some(MatchHow::PidTree)
        );
        assert_eq!(
            match_player(&ident(Some(300), "opera", ""), &opera, &t),
            Some(MatchHow::PidTree),
            "the pid itself"
        );
        // Flatpak: the pids are namespaced (no match), the portal app id = DesktopEntry
        let spot = player(Some(9999), "Spotify", Some("com.spotify.Client"));
        let mut fp = ident(Some(2), "spotify", "spotify");
        fp.portal_app_id = Some("com.spotify.Client".into());
        assert_eq!(match_player(&fp, &spot, &t), Some(MatchHow::AppId));
        // the name fallback: a wrapper's pid doesn't line up; binary vs Identity (no
        // DesktopEntry: Chromium), NixOS-wrapped binary vs DesktopEntry
        let chromium = player(Some(9998), "Chromium", None);
        assert_eq!(
            match_player(&ident(Some(7), "chromium", "Chromium"), &chromium, &t),
            Some(MatchHow::Name)
        );
        let vlc = player(Some(9997), "VLC media player", Some("vlc"));
        assert_eq!(
            match_player(&ident(Some(8), ".vlc-wrapped", "VLC"), &vlc, &t),
            Some(MatchHow::Name)
        );
        let ff = player(Some(9996), "Mozilla Firefox", Some("org.mozilla.firefox"));
        assert_eq!(
            match_player(&ident(Some(8), "firefox", "Firefox"), &ff, &t),
            Some(MatchHow::Name)
        );
        // an unrelated paplay matches nobody
        let paplay = ident(Some(500), "paplay", "paplay");
        for p in [&opera, &spot, &chromium, &vlc, &ff] {
            assert_eq!(match_player(&paplay, p, &t), None, "{}", p.identity);
        }
        // only Playing players own streams
        let mut paused = opera.clone();
        paused.playing = false;
        assert!(playing_owner(&tab, &[paused.clone()], &t).is_none());
        assert_eq!(
            playing_owner(&tab, &[paused, opera.clone()], &t).map(|(p, m)| (p.pid, m)),
            Some((Some(300), MatchHow::PidTree))
        );
        // a matched stream that is muted or at volume 0 is silent; unknown volume is not
        let muted = StreamVolume {
            mute: Some(true),
            channel_volumes: vec![1.0, 1.0],
            volume: None,
        };
        let zero = StreamVolume {
            mute: Some(false),
            channel_volumes: vec![0.0, 0.0],
            volume: None,
        };
        let quiet = StreamVolume {
            mute: Some(false),
            channel_volumes: vec![0.064, 0.064],
            volume: None,
        };
        assert!(muted.silent());
        assert!(zero.silent());
        assert!(!quiet.silent(), "turned down, not silent: the meter decides");
        let master0 = StreamVolume {
            volume: Some(0.0),
            ..quiet.clone()
        };
        assert!(master0.silent(), "the master volume at 0");
        assert!(!StreamVolume::default().silent(), "no Props yet = unknown");
        assert!(
            !StreamVolume {
                mute: Some(false),
                channel_volumes: vec![],
                volume: None,
            }
            .silent(),
            "an empty channelVolumes = unknown"
        );
    }

    #[test]
    fn names_normalise() {
        assert_eq!(norm_name(".kded6-wrapped"), "kded6");
        assert_eq!(norm_name("Firefox.desktop"), "firefox");
        assert!(names_match("org.chromium.Chromium", "chromium"));
        assert!(!names_match("", ""));
        assert!(in_tree(302, 300, &tree()));
        assert!(!in_tree(500, 300, &tree()));
    }
}
