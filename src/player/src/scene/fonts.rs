//! Which font families a scene's text asks fontconfig for, and which stand-ins it got
//! (`docs/player/modules/scene-lwe-core.md` § Fonts). Scene fonts are fonts like any app's: a
//! `systemfont_<name>` is the Windows family WE takes it to, looked up through fontconfig with the
//! system's configuration plus [`ALIASES`] (open stand-ins for the families fontconfig has no
//! metric alias for); nothing reads a Windows install (`docs/decisions.md` § "Scene fonts come from
//! fontconfig, not a Windows install"). No GPU, no fontconfig here: the worker does the lookup
//! (`liascape-scene-worker`'s `render::scene_fonts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The fontconfig rules the worker adds to its configuration before any text is set up: an
/// `<accept>` alias per Windows family whose open stand-in fontconfig doesn't know (a real
/// installed font of that family still wins). Compiled in, so every install (the flake, a
/// PKGBUILD, the AppImage, a dev build) gives every worker the same rules without touching any
/// other app's fonts.
pub const ALIASES: &str = include_str!("../../fontconfig/liascape-scene-fonts.conf");

/// Font folders the package carries (`:`-separated; the flake's wrapper sets it to its font
/// packages' `share/fonts`): the worker adds each as a fontconfig application font dir. Unset or
/// empty = the system's fonts only (a distro package depends on the same fonts installed system-wide).
pub const DIRS_ENV: &str = "LIASCAPE_SCENE_FONT_DIRS";

/// WE's `systemfont_*` names (its text layout's table: arial.ttf, calibri.ttf, cambria.ttc,
/// comic.ttf, consola.ttf, micross.ttf, segoeui.ttf, verdana.ttf), each with the families the
/// core's `TextFonts::systemFont` (fork patch 0048, `TextLayout.cpp`) puts in one fontconfig
/// pattern: the Windows family first, then the metric twins it lists itself. Kept equal to the
/// core's table, so the family reported as shown is the one the core drew with.
const SYSTEM_FONTS: &[(&str, &[&str])] = &[
    (
        "systemfont_arial",
        &["Arial", "Liberation Sans", "Arimo", "sans-serif"],
    ),
    ("systemfont_calibri", &["Calibri", "Carlito", "sans-serif"]),
    ("systemfont_cambria", &["Cambria", "Caladea", "serif"]),
    (
        "systemfont_comicsans",
        &["Comic Sans MS", "Comic Neue", "Comic Relief", "sans-serif"],
    ),
    (
        "systemfont_consolas",
        &["Consolas", "Inconsolata", "DejaVu Sans Mono", "monospace"],
    ),
    (
        "systemfont_sansserif",
        &[
            "Microsoft Sans Serif",
            "Liberation Sans",
            "Arimo",
            "sans-serif",
        ],
    ),
    (
        "systemfont_segoe",
        &[
            "Segoe UI",
            "Selawik",
            "Noto Sans",
            "Open Sans",
            "sans-serif",
        ],
    ),
    (
        "systemfont_verdana",
        &["Verdana", "DejaVu Sans", "sans-serif"],
    ),
];

/// The families fontconfig is asked for, in order, for a text's `font` that names no file of the
/// scene (`systemfont_*`, or empty). A name WE doesn't know is Arial, as in WE (it can't open
/// one and takes arial.ttf).
pub fn families(font: &str) -> &'static [&'static str] {
    SYSTEM_FONTS
        .iter()
        .find(|(n, _)| *n == font)
        .unwrap_or(&SYSTEM_FONTS[0])
        .1
}

/// The Windows family a `systemfont_*` name asks for ("Consolas").
pub fn family(font: &str) -> &'static str {
    families(font)[0]
}

/// Whether a text's `font` is a system font (the core's test): empty or `systemfont_*`. Any
/// other value is a font file of the scene.
pub fn is_system_font(font: &str) -> bool {
    font.is_empty() || font.starts_with("systemfont_")
}

/// The text objects of a `scene.json`, as LWE parses them: a `text` key and none of the keys that
/// make an object something else first (a string `image` or `model`, a `sound`, a particle
/// system). Only a scene with one needs fontconfig.
pub fn text_objects(scene: &Value) -> Vec<&Value> {
    let Some(objects) = scene.get("objects").and_then(Value::as_array) else {
        return Vec::new();
    };
    objects
        .iter()
        .filter(|o| {
            o.get("text").is_some()
                && !o.get("image").is_some_and(Value::is_string)
                && !o.get("model").is_some_and(Value::is_string)
                && !o
                    .get("sound")
                    .is_some_and(|s| s.is_string() || s.is_array())
                && !o.get("particle").is_some_and(|p| {
                    p.is_object() || p.as_str().is_some_and(|s| !s.is_empty() && s != "None")
                })
        })
        .collect()
}

/// The system fonts the text objects ([`text_objects`]) ask for, each once, in order. A text's
/// `font` defaults to `systemfont_arial` (WE's default).
pub fn requested(scene: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for o in text_objects(scene) {
        let font = match o.get("font") {
            Some(Value::String(f)) => f.as_str(),
            None => "systemfont_arial",
            Some(_) => continue,
        };
        if is_system_font(font) && !out.iter().any(|f| f == font) {
            out.push(font.to_string());
        }
    }
    out
}

/// A system font the scene asks for that this machine shows with another family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StandIn {
    /// The family the scene asks for ("Consolas").
    pub font: String,
    /// The family fontconfig matched and the text is drawn with ("Cascadia Mono").
    pub shown: String,
}

/// The stand-ins among `requested` (`systemfont_*` names): `matched` gets the families of one
/// lookup ([`families`]) and answers every family name of the font fontconfig matched (a font has
/// one per language), `None` when it found none. A match whose names include the asked family is
/// the real font, no stand-in. One entry per asked family.
pub fn stand_ins(
    requested: &[String],
    mut matched: impl FnMut(&[&str]) -> Option<Vec<String>>,
) -> Vec<StandIn> {
    let mut out: Vec<StandIn> = Vec::new();
    let mut asked: Vec<&str> = Vec::new();
    for font in requested {
        let want = family(font);
        if asked.contains(&want) {
            continue;
        }
        asked.push(want);
        let Some(names) = matched(families(font)) else {
            continue;
        };
        if names.iter().any(|n| n.eq_ignore_ascii_case(want)) {
            continue;
        }
        if let Some(shown) = names.into_iter().next() {
            out.push(StandIn {
                font: want.to_string(),
                shown,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_fonts_map_to_their_windows_family() {
        for (name, fam) in [
            ("systemfont_arial", "Arial"),
            ("systemfont_calibri", "Calibri"),
            ("systemfont_cambria", "Cambria"),
            ("systemfont_comicsans", "Comic Sans MS"),
            ("systemfont_consolas", "Consolas"),
            ("systemfont_sansserif", "Microsoft Sans Serif"),
            ("systemfont_segoe", "Segoe UI"),
            ("systemfont_verdana", "Verdana"),
        ] {
            assert_eq!(family(name), fam, "{name}");
        }
        // WE can't open any other name and takes Arial; so does an empty one
        assert_eq!(family("systemfont_tahoma"), "Arial");
        assert_eq!(family(""), "Arial");
        assert_eq!(
            families("systemfont_consolas"),
            &["Consolas", "Inconsolata", "DejaVu Sans Mono", "monospace"]
        );
        assert!(is_system_font("") && is_system_font("systemfont_x"));
        assert!(!is_system_font("fonts/VCR_OSD_MONO.ttf"));
    }

    #[test]
    fn requested_fonts_are_the_text_objects_system_fonts() {
        let scene = json!({"objects": [
            {"id": 1, "name": "a", "text": "x", "font": "systemfont_consolas"},
            {"id": 2, "name": "b", "text": "y"},
            {"id": 3, "name": "c", "text": "z", "font": "systemfont_consolas"},
            {"id": 4, "name": "d", "text": "w", "font": "fonts/own.ttf"},
            {"id": 5, "name": "e", "image": "models/x.json", "text": "not a text", "font": "systemfont_verdana"},
            {"id": 6, "name": "f", "text": "v", "particle": "None", "font": "systemfont_segoe"},
            {"id": 7, "name": "g", "text": "v", "particle": "particles/p.json", "font": "systemfont_calibri"},
            {"id": 8, "name": "h", "sound": ["s.mp3"], "text": "u", "font": "systemfont_cambria"},
        ]});
        assert_eq!(
            requested(&scene),
            [
                "systemfont_consolas",
                "systemfont_arial",
                "systemfont_segoe"
            ]
        );
        assert!(requested(&json!({})).is_empty());
        // a text in a file font of its own still needs fontconfig (WE's fallback chain)
        assert_eq!(text_objects(&scene).len(), 5);
        assert!(text_objects(&json!({"objects": [{"id": 1, "image": "x.json"}]})).is_empty());
    }

    #[test]
    fn a_stand_in_is_a_match_without_the_asked_family() {
        let req: Vec<String> = [
            "systemfont_consolas",
            "systemfont_arial",
            "systemfont_verdana",
            "systemfont_tahoma",
            "systemfont_segoe",
        ]
        .map(String::from)
        .into();
        let mut asked = Vec::new();
        let got = stand_ins(&req, |fams| {
            asked.push(fams[0].to_string());
            match fams[0] {
                "Consolas" => Some(vec!["Cascadia Mono".into(), "Cascadia Mono Regular".into()]),
                // the real one (matched under another language's name too)
                "Arial" => Some(vec!["Arial".into()]),
                "Verdana" => Some(vec!["DejaVu Sans".into(), "verdana".into()]),
                _ => None,
            }
        });
        assert_eq!(
            got,
            [StandIn {
                font: "Consolas".into(),
                shown: "Cascadia Mono".into()
            }]
        );
        // systemfont_tahoma is Arial, asked once
        assert_eq!(asked, ["Consolas", "Arial", "Verdana", "Segoe UI"]);
    }

    #[test]
    fn the_alias_file_accepts_each_stand_in_after_the_real_family() {
        for (fam, stand_in) in [
            ("Consolas", "Cascadia Mono"),
            ("Segoe UI", "Selawik"),
            ("Comic Sans MS", "Comic Neue"),
        ] {
            let at = ALIASES
                .find(&format!("<family>{fam}</family>"))
                .unwrap_or_else(|| panic!("no alias for {fam}"));
            let rest = &ALIASES[at..];
            let end = rest.find("</alias>").unwrap();
            let alias = &rest[..end];
            assert!(
                alias.contains("<accept>")
                    && alias.contains(&format!("<family>{stand_in}</family>")),
                "{fam}: {alias}"
            );
            // `prefer` would put the stand-in ahead of a real installed font
            assert!(!alias.contains("<prefer>"), "{fam}: {alias}");
        }
        // the standard metric aliases (30-metric-aliases.conf) are fontconfig's, never repeated here
        for fam in ["Arial", "Times New Roman", "Courier New"] {
            assert!(
                !ALIASES.contains(&format!("<family>{fam}</family>")),
                "{fam}"
            );
        }
    }
}
