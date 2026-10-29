//! `liascape-player scene-loudness` (the offline scene loudness estimate's CLI —
//! `.claude/rules/player-core.md` § Scene worker → "Scene loudness" → "Offline estimate"): a
//! generated packaged scene, end to end through the binary. Needs ffmpeg (SKIP without it).

use std::path::PathBuf;
use std::process::Command;

use liascape_player::audio::loudness::{Learner, RATE};
use liascape_player::scene::pkg;
use serde_json::{Value, json};

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// 16-bit PCM stereo WAV of a sine at `peak` on both channels.
fn sine_wav(hz: f64, peak: f64, secs: f64) -> Vec<u8> {
    let n = (secs * RATE as f64) as usize;
    let data: Vec<u8> = (0..n)
        .flat_map(|i| {
            let v = peak * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE as f64).sin();
            let s = ((v * 32767.0).round() as i16).to_le_bytes();
            [s[0], s[1], s[0], s[1]]
        })
        .collect();
    let mut w = Vec::new();
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&RATE.to_le_bytes());
    w.extend_from_slice(&(RATE * 4).to_le_bytes());
    w.extend_from_slice(&4u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(data.len() as u32).to_le_bytes());
    w.extend_from_slice(&data);
    w
}

fn run(dir: &PathBuf, extra: &[&str]) -> (i32, Value) {
    let out = Command::new(env!("CARGO_BIN_EXE_liascape-player"))
        .arg("scene-loudness")
        .arg(dir)
        .args(extra)
        .output()
        .expect("run liascape-player");
    let v = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    (out.status.code().unwrap_or(-1), v)
}

#[test]
fn scene_loudness_cli_estimates_a_packaged_scene() {
    if !have_ffmpeg() {
        eprintln!("SKIP: no ffmpeg");
        return;
    }
    let root = std::env::temp_dir().join(format!("lia-sl-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("scene");
    std::fs::create_dir_all(&dir).unwrap();
    // music −20 dBFS always; rain −20 dBFS on a bool property (off by default); a colour too
    let a = 0.1;
    let scene = json!({"objects": [
        {"id": 1, "name": "music", "sound": ["sounds/music.wav"], "playbackmode": "loop", "volume": 1.0},
        {"id": 2, "name": "rain", "sound": ["sounds/rain.wav"], "playbackmode": "loop",
         "volume": {"user": "rain", "value": 0.0}},
        {"id": 3, "name": "img", "image": "models/x.json", "color": {"user": "tint", "value": "1 0 0"}}]})
    .to_string();
    let bytes = pkg::build(
        "PKGV0022",
        &[
            ("scene.json", scene.as_bytes()),
            ("sounds/music.wav", &sine_wav(1000.0, a, 4.0)),
            ("sounds/rain.wav", &sine_wav(300.0, a, 3.0)),
        ],
    );
    std::fs::write(dir.join("scene.pkg"), bytes).unwrap();
    std::fs::write(
        dir.join("project.json"),
        json!({"type": "scene", "file": "scene.json", "general": {"properties": {
            "rain": {"type": "bool", "value": false},
            "tint": {"type": "color", "value": "1 0 0"}}}})
        .to_string(),
    )
    .unwrap();
    let cache = root.join("cache");
    let c = cache.to_str().unwrap();

    let (code, base) = run(&dir, &["--model", "we", "--cache", c]);
    assert_eq!(code, 0, "{base}");
    assert_eq!(base["estimated"], true);
    assert!(
        (base["lufs"].as_f64().unwrap() + 20.0).abs() < 0.1,
        "{base}"
    );
    assert_eq!(base["cache"]["decodes"], 1);
    // the state is the live learner's shape: a seed it continues at the same loudness
    let l = Learner::new(60.0).with_seed(Some(&base["state"]));
    assert!((l.integrated().unwrap() - base["lufs"].as_f64().unwrap()).abs() < 0.01);
    let seed = Learner::new(60.0).with_seed(Some(&base["seed"]["state"]));
    assert!((seed.audible_s() - 10.0).abs() < 1e-9);

    // the colour: same fingerprint, same loudness, nothing decoded (a new process: the disk cache)
    let (_, col) = run(
        &dir,
        &[
            "--model",
            "we",
            "--cache",
            c,
            "--props",
            r#"{"tint": "0 1 0"}"#,
        ],
    );
    assert_eq!(col["fingerprint"], base["fingerprint"]);
    assert_eq!(col["lufs"], base["lufs"]);
    assert_eq!(col["cache"]["decodes"], 0);
    assert_eq!(col["cache"]["disk_hits"], 1);

    // the bool on: a new fingerprint, the two files' power sum (K-weighting reads the 300 Hz one
    // ~0.75 dB quieter than the 1 kHz one), only rain decoded
    let (_, on) = run(
        &dir,
        &[
            "--model",
            "we",
            "--cache",
            c,
            "--props",
            r#"{"rain": true}"#,
        ],
    );
    assert_ne!(on["fingerprint"], base["fingerprint"]);
    let file_lufs = |name: &str| {
        on["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["file"] == name)
            .unwrap()["lufs"]
            .as_f64()
            .unwrap()
    };
    let (lm, lr) = (file_lufs("sounds/music.wav"), file_lufs("sounds/rain.wav"));
    let want = 10.0 * (10f64.powf(lm / 10.0) + 10f64.powf(lr / 10.0)).log10();
    let got = on["lufs"].as_f64().unwrap();
    assert!((got - want).abs() < 0.1, "{got} vs {want}: {on}");
    assert!(got - base["lufs"].as_f64().unwrap() > 2.0);
    assert_eq!(on["cache"]["decodes"], 1);

    // LWE (the default) plays WE's rules since fork patch 0018: the property counts the same;
    // only the fingerprint's model prefix differs
    let (_, lwe) = run(&dir, &["--cache", c]);
    assert_eq!(lwe["model"], "lwe");
    assert_eq!(lwe["lufs"], base["lufs"]);
    let (_, lwe_on) = run(&dir, &["--cache", c, "--props", r#"{"rain": true}"#]);
    assert_eq!(lwe_on["lufs"], on["lufs"]);
    assert_ne!(lwe_on["fingerprint"], lwe["fingerprint"]);
    assert!(lwe["fingerprint"].as_str().unwrap().starts_with("lwe-"));

    // not a scene → exit 1 with the error; usage → 2
    let (code, err) = run(&root, &[]);
    assert_eq!(code, 1);
    assert!(
        err["error"].as_str().unwrap().contains("project.json"),
        "{err}"
    );
    let (code, _) = run(&dir, &["--model", "nope"]);
    assert_eq!(code, 2);
    let _ = std::fs::remove_dir_all(&root);
}
