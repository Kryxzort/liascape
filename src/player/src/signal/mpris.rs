//! The MPRIS reader for auto-mute's "Only if an MPRIS player is active" (Phase 3 Task 14):
//! thread `lia-mpris` reads every `org.mpris.MediaPlayer2.*` player over the **session bus**
//! (zbus, blocking — off the loop; `org.mpris.MediaPlayer2.playerctld` is skipped, it mirrors
//! another player): its `PlaybackStatus`, `Identity`, `DesktopEntry`, and the pid owning the
//! name (`org.freedesktop.DBus.GetConnectionUnixProcessID`). It re-reads on every
//! `PropertiesChanged` on `/org/mpris/MediaPlayer2` and every `NameOwnerChanged` of an MPRIS
//! name (thread `lia-mpris-sig`), and every [`REFRESH`] as a safety net. With no session bus it
//! reports `available: false` (the MPRIS mode then never mutes — it never "passes").
//! `audio::sysmon` re-classifies its streams on each [`MprisFeed`] version.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::json;
use zbus::blocking::Connection;
use zbus::zvariant::OwnedValue;

use crate::audio::foreign::MprisPlayer;
use crate::audio::sysmon::{MprisFeed, MprisState};
use crate::log::{self, Level};

/// The safety-net re-read period.
pub const REFRESH: Duration = Duration::from_secs(2);
/// A player that doesn't answer within this is skipped this round.
const CALL_TIMEOUT: Duration = Duration::from_millis(400);
const PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";

/// Start `lia-mpris` (once per process: it lives as long as the player, a few idle threads).
pub fn start() -> Arc<MprisFeed> {
    let feed = Arc::new(MprisFeed::default());
    let f = feed.clone();
    let _ = std::thread::Builder::new()
        .name("lia-mpris".into())
        .spawn(move || run(&f));
    feed
}

fn publish(feed: &MprisFeed, st: MprisState) {
    let mut g = feed.state.lock().unwrap_or_else(|e| e.into_inner());
    let changed =
        g.available != st.available || g.players != st.players || g.reason != st.reason;
    *g = MprisState {
        refreshes: g.refreshes + 1,
        ..st
    };
    drop(g);
    if changed {
        feed.version.fetch_add(1, Ordering::SeqCst);
    }
}

fn run(feed: &Arc<MprisFeed>) {
    let conn = match zbus::blocking::connection::Builder::session()
        .map(|b| b.method_timeout(CALL_TIMEOUT))
        .and_then(|b| b.build())
    {
        Ok(c) => c,
        Err(e) => {
            let reason = format!("no session bus ({e})");
            log::event(
                "signal",
                Level::Warn,
                "automute.mpris_unavailable",
                None,
                json!({ "reason": reason }),
            );
            publish(
                feed,
                MprisState {
                    available: Some(false),
                    reason: Some(reason),
                    ..MprisState::default()
                },
            );
            return;
        }
    };
    let dirty = Arc::new((Mutex::new(true), Condvar::new()));
    for rule in [
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")
            .and_then(|b| b.member("PropertiesChanged"))
            .and_then(|b| b.path(PATH))
            .map(|b| b.build()),
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender("org.freedesktop.DBus")
            .and_then(|b| b.interface("org.freedesktop.DBus"))
            .and_then(|b| b.member("NameOwnerChanged"))
            .and_then(|b| b.arg0ns("org.mpris.MediaPlayer2"))
            .map(|b| b.build()),
    ]
    .into_iter()
    .flatten()
    {
        let Ok(it) = zbus::blocking::MessageIterator::for_match_rule(rule, &conn, Some(64)) else {
            continue;
        };
        let d = dirty.clone();
        let _ = std::thread::Builder::new()
            .name("lia-mpris-sig".into())
            .spawn(move || {
                for _ in it {
                    *d.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    d.1.notify_one();
                }
            });
    }
    loop {
        {
            let (m, cv) = &*dirty;
            let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
            if !*g {
                g = cv
                    .wait_timeout(g, REFRESH)
                    .map(|r| r.0)
                    .unwrap_or_else(|e| e.into_inner().0);
            }
            *g = false;
        }
        let players = read_players(&conn);
        publish(
            feed,
            MprisState {
                available: Some(true),
                reason: None,
                players,
                ..MprisState::default()
            },
        );
    }
}

fn call<T: serde::de::DeserializeOwned + zbus::zvariant::Type>(
    conn: &Connection,
    dest: &str,
    path: &str,
    iface: &str,
    method: &str,
    body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
) -> Option<T> {
    let reply = conn
        .call_method(Some(dest), path, Some(iface), method, body)
        .ok()?;
    reply.body().deserialize::<T>().ok()
}

fn str_of(m: &HashMap<String, OwnedValue>, k: &str) -> Option<String> {
    m.get(k).and_then(|v| String::try_from(v.clone()).ok())
}

fn read_players(conn: &Connection) -> Vec<MprisPlayer> {
    let names: Vec<String> = call(
        conn,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "ListNames",
        &(),
    )
    .unwrap_or_default();
    let mut out = Vec::new();
    for name in names
        .into_iter()
        .filter(|n| n.starts_with(PREFIX) && n != "org.mpris.MediaPlayer2.playerctld")
    {
        let get_all = |iface: &str| -> HashMap<String, OwnedValue> {
            call(
                conn,
                &name,
                PATH,
                "org.freedesktop.DBus.Properties",
                "GetAll",
                &(iface,),
            )
            .unwrap_or_default()
        };
        let player = get_all("org.mpris.MediaPlayer2.Player");
        let root = get_all("org.mpris.MediaPlayer2");
        let pid: Option<u32> = call(
            conn,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            &(name.as_str(),),
        );
        let title = player
            .get("Metadata")
            .and_then(|v| HashMap::<String, OwnedValue>::try_from(v.clone()).ok())
            .and_then(|m| str_of(&m, "xesam:title"))
            .unwrap_or_default();
        out.push(MprisPlayer {
            playing: str_of(&player, "PlaybackStatus").as_deref() == Some("Playing"),
            identity: str_of(&root, "Identity").unwrap_or_else(|| {
                name.trim_start_matches(PREFIX)
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .to_string()
            }),
            desktop_entry: str_of(&root, "DesktopEntry").filter(|s| !s.is_empty()),
            pid,
            bus_name: name,
            title,
        });
    }
    out
}
