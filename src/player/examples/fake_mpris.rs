//! A fake MPRIS player for testing the scene worker's media events (gap audit B10):
//! `cargo run --example fake_mpris -- <state.json>` owns `org.mpris.MediaPlayer2.liascapefake`
//! on the session bus and answers `Properties.Get`/`GetAll` of `org.mpris.MediaPlayer2.Player`
//! from the JSON file, re-read on every call (edit it to change the track):
//! `{"title", "artist", "album", "albumArtist": [..], "genre": [..], "artUrl", "status":
//! "Playing"|"Paused"|"Stopped", "position_us", "length_us"}`. Runs until killed.

use std::collections::HashMap;

use serde_json::Value as Json;
use zbus::zvariant::{Str, Value};

fn state(path: &str) -> Json {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Json::Null)
}

fn text(j: &Json, k: &str) -> String {
    j[k].as_str().unwrap_or_default().to_string()
}

fn list(j: &Json, k: &str) -> Vec<String> {
    j[k].as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn properties(j: &Json) -> HashMap<String, Value<'static>> {
    let mut meta: HashMap<String, Value<'static>> = HashMap::new();
    meta.insert("mpris:trackid".into(), Value::from(zbus::zvariant::ObjectPath::from_static_str_unchecked("/fake/track")));
    meta.insert("xesam:title".into(), Value::from(Str::from(text(j, "title"))));
    meta.insert("xesam:artist".into(), Value::from(list(j, "artist")));
    meta.insert("xesam:album".into(), Value::from(Str::from(text(j, "album"))));
    meta.insert("xesam:albumArtist".into(), Value::from(list(j, "albumArtist")));
    meta.insert("xesam:genre".into(), Value::from(list(j, "genre")));
    meta.insert("mpris:artUrl".into(), Value::from(Str::from(text(j, "artUrl"))));
    meta.insert("mpris:length".into(), Value::from(j["length_us"].as_i64().unwrap_or(0)));
    let mut props: HashMap<String, Value<'static>> = HashMap::new();
    props.insert("Metadata".into(), Value::from(meta));
    props.insert("PlaybackStatus".into(), Value::from(Str::from(text(j, "status"))));
    props.insert("Position".into(), Value::from(j["position_us"].as_i64().unwrap_or(0)));
    props
}

fn main() -> zbus::Result<()> {
    let path = std::env::args().nth(1).expect("usage: fake_mpris <state.json>");
    // "artist" may be a plain string too
    let conn = zbus::blocking::Connection::session()?;
    conn.request_name("org.mpris.MediaPlayer2.liascapefake")?;
    eprintln!("fake_mpris: serving org.mpris.MediaPlayer2.liascapefake from {path}");
    for msg in zbus::blocking::MessageIterator::from(&conn) {
        let Ok(msg) = msg else { continue };
        let header = msg.header();
        if header.message_type() != zbus::message::Type::MethodCall
            || header.interface().map(|i| i.as_str()) != Some("org.freedesktop.DBus.Properties")
        {
            continue;
        }
        let j = state(&path);
        let mut props = properties(&j);
        match header.member().map(|m| m.as_str()) {
            Some("GetAll") => {
                let _ = conn.reply(&header, &(props,));
            }
            Some("Get") => {
                let (_, name): (String, String) = msg.body().deserialize().unwrap_or_default();
                if let Some(v) = props.remove(&name) {
                    let _ = conn.reply(&header, &(v,));
                }
            }
            _ => {}
        }
    }
    Ok(())
}
