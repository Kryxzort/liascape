//! A program's transition choice (pure, seeded): which effect, how long and how, for one
//! switch — `TransitionService.PickEffect` / `PickDuration` / `Pick` (the liascape-player
//! path), ported. Sequential cycles through the enabled set; shuffle never repeats the last
//! effect; the duration is uniform in `[duration_ms, duration_max_ms]`; 0 ms is a cut; the
//! params are the catalogue's uniform defaults.

use serde_json::{Map, Value};

use super::Rng;
use crate::graph::ApiError;
use crate::recipes::transition::Method;

/// The longest effect a program asks for (`PickDuration`'s clamp).
pub const DURATION_MAX_MS: u32 = 10_000;

/// A program's `transition` property, parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct TransitionCfg {
    pub enabled: bool,
    /// Catalogue ids, in the order the user enabled them (unknown ids are dropped at the
    /// pick, not here — the catalogue can change under a saved program).
    pub effects: Vec<String>,
    pub shuffle: bool,
    pub duration_ms: u32,
    pub duration_max_ms: u32,
    pub method: Method,
}

impl Default for TransitionCfg {
    fn default() -> TransitionCfg {
        TransitionCfg {
            enabled: false,
            effects: Vec::new(),
            shuffle: false,
            duration_ms: 0,
            duration_max_ms: 0,
            // `TransitionService.Pick`: `TransitionMethod ?? "reveal"`
            method: Method::Reveal,
        }
    }
}

fn cfg_err(code: &'static str, message: String) -> ApiError {
    ApiError {
        code,
        message,
        hint: "transition = {enabled, effects: [ids], shuffle, duration_ms, duration_max_ms, \
               method: full-live|reveal|frozen}; see .claude/rules/player-core.md \u{a7} Programs"
            .to_string(),
    }
}

impl TransitionCfg {
    /// Parse a `transition` map. Missing keys take [`TransitionCfg::default`]'s values;
    /// durations are clamped to 0–[`DURATION_MAX_MS`]; an unknown key is `no_such_prop`, a
    /// wrong type `bad_type`, an unknown method `out_of_range`.
    pub fn from_map(m: &Map<String, Value>) -> Result<TransitionCfg, ApiError> {
        let mut c = TransitionCfg::default();
        for (k, v) in m {
            let bad = || cfg_err("bad_type", format!("transition.{k}: unexpected {v}"));
            match k.as_str() {
                "enabled" => c.enabled = v.as_bool().ok_or_else(bad)?,
                "shuffle" => c.shuffle = v.as_bool().ok_or_else(bad)?,
                "effects" => {
                    let arr = v.as_array().ok_or_else(bad)?;
                    c.effects = arr
                        .iter()
                        .map(|e| e.as_str().map(str::to_string).ok_or_else(bad))
                        .collect::<Result<_, _>>()?;
                }
                "duration_ms" | "duration_max_ms" => {
                    let f = v.as_f64().ok_or_else(bad)?;
                    let ms = f.clamp(0.0, DURATION_MAX_MS as f64).round() as u32;
                    if k == "duration_ms" {
                        c.duration_ms = ms;
                    } else {
                        c.duration_max_ms = ms;
                    }
                }
                "method" => {
                    c.method = serde_json::from_value(v.clone()).map_err(|_| {
                        cfg_err(
                            "out_of_range",
                            format!("transition.method: {v} is not full-live|reveal|frozen"),
                        )
                    })?;
                }
                _ => {
                    return Err(cfg_err(
                        "no_such_prop",
                        format!("transition has no key {k:?}"),
                    ));
                }
            }
        }
        Ok(c)
    }
}

/// One switch's transition. `effect_id: None` = a cut.
#[derive(Debug, Clone, PartialEq)]
pub struct Pick {
    pub effect_id: Option<String>,
    pub params: Map<String, Value>,
    pub duration_ms: u32,
    pub method: Method,
    /// The program's next `last_effect` (`PickEffect`'s `_lastEffect`): the effect the
    /// cycle moved to — also on a 0 ms cut — and `None` when it didn't move (disabled, no
    /// known effect, or a single one, which `PickEffect` returns without recording).
    pub picked: Option<String>,
}

/// `TransitionService.Pick`: disabled, no known effect, or a duration of 0 → a cut.
/// `defaults_of(id)` is the catalogue: `None` = unknown id (dropped), else its uniform
/// defaults (the request's `params`).
pub fn pick(
    cfg: &TransitionCfg,
    last_effect: Option<&str>,
    defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
    rng: &mut Rng,
) -> Pick {
    let cut = |picked: Option<String>| Pick {
        effect_id: None,
        params: Map::new(),
        duration_ms: 0,
        method: cfg.method,
        picked,
    };
    if !cfg.enabled {
        return cut(None);
    }
    // PickEffect
    let mut ids: Vec<&str> = Vec::new();
    for e in &cfg.effects {
        if !ids.contains(&e.as_str()) && defaults_of(e).is_some() {
            ids.push(e);
        }
    }
    let (effect, picked) = match ids.len() {
        0 => return cut(None),
        1 => (ids[0], None),
        _ if cfg.shuffle => {
            let pool: Vec<&str> = ids.iter().copied().filter(|i| Some(*i) != last_effect).collect();
            let pool = if pool.is_empty() { ids.clone() } else { pool };
            let e = pool[rng.below(pool.len())];
            (e, Some(e.to_string()))
        }
        n => {
            let next = match last_effect.and_then(|l| ids.iter().position(|i| *i == l)) {
                Some(i) => (i + 1) % n,
                None => 0,
            };
            (ids[next], Some(ids[next].to_string()))
        }
    };
    // PickDuration
    let min = cfg.duration_ms.min(DURATION_MAX_MS);
    let duration_ms = if cfg.duration_max_ms > min {
        let max = cfg.duration_max_ms.clamp(min, DURATION_MAX_MS);
        min + rng.below((max - min + 1) as usize) as u32
    } else {
        min
    };
    if duration_ms == 0 {
        return cut(picked);
    }
    Pick {
        effect_id: Some(effect.to_string()),
        params: defaults_of(effect).unwrap_or_default(),
        duration_ms,
        method: cfg.method,
        picked,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn catalogue(id: &str) -> Option<Map<String, Value>> {
        match id {
            "fade" => Some(Map::new()),
            "wipe" => json!({"direction": [1.0, 0.0]}).as_object().cloned(),
            "zoom" => json!({"strength": [0.5]}).as_object().cloned(),
            _ => None,
        }
    }

    fn cfg(effects: &[&str], shuffle: bool, d: u32, dmax: u32) -> TransitionCfg {
        TransitionCfg {
            enabled: true,
            effects: effects.iter().map(|s| s.to_string()).collect(),
            shuffle,
            duration_ms: d,
            duration_max_ms: dmax,
            method: Method::FullLive,
        }
    }

    /// Picks in a row, feeding `picked` back as the last effect.
    fn run(c: &TransitionCfg, n: usize, rng: &mut Rng) -> Vec<Pick> {
        let mut last: Option<String> = None;
        (0..n)
            .map(|_| {
                let p = pick(c, last.as_deref(), &catalogue, rng);
                if let Some(e) = &p.picked {
                    last = Some(e.clone());
                }
                p
            })
            .collect()
    }

    #[test]
    fn sequential_and_shuffle() {
        let mut rng = Rng::new(5);
        // sequential cycles through the enabled set
        let got: Vec<_> = run(&cfg(&["fade", "wipe"], false, 500, 0), 3, &mut rng)
            .into_iter()
            .map(|p| p.effect_id.unwrap())
            .collect();
        assert_eq!(got, ["fade", "wipe", "fade"]);
        // shuffle never returns the last effect when ≥ 2
        let picks = run(&cfg(&["fade", "wipe", "zoom"], true, 500, 0), 300, &mut rng);
        for w in picks.windows(2) {
            assert_ne!(w[0].effect_id, w[1].effect_id);
        }
        // unknown ids are dropped (and duplicates)
        let got: Vec<_> = run(&cfg(&["nope", "wipe", "wipe", "fade"], false, 500, 0), 3, &mut rng)
            .into_iter()
            .map(|p| p.effect_id.unwrap())
            .collect();
        assert_eq!(got, ["wipe", "fade", "wipe"]);
        // params = the catalogue's defaults; method = the cfg's
        let p = pick(&cfg(&["wipe"], false, 500, 0), None, &catalogue, &mut rng);
        assert_eq!(p.params, catalogue("wipe").unwrap());
        assert_eq!(p.method, Method::FullLive);
        assert_eq!(p.duration_ms, 500);
        assert_eq!(p.picked, None, "a single effect isn't recorded (PickEffect)");
    }

    #[test]
    fn cuts() {
        let mut rng = Rng::new(5);
        let mut c = cfg(&["fade"], false, 0, 0);
        assert_eq!(pick(&c, None, &catalogue, &mut rng).effect_id, None, "0 ms");
        c.duration_ms = 500;
        c.enabled = false;
        assert_eq!(pick(&c, None, &catalogue, &mut rng).effect_id, None, "disabled");
        let c = cfg(&["nope"], false, 500, 0);
        assert_eq!(pick(&c, None, &catalogue, &mut rng).effect_id, None, "no known effect");
        // a 0 ms cut still moves the cycle (PickEffect runs before PickDuration)
        let c = cfg(&["fade", "wipe"], false, 0, 0);
        let p = pick(&c, Some("fade"), &catalogue, &mut rng);
        assert_eq!((p.effect_id, p.picked.as_deref()), (None, Some("wipe")));
    }

    #[test]
    fn duration_range_is_uniform() {
        let mut rng = Rng::new(11);
        let c = cfg(&["fade"], false, 500, 900);
        let mut buckets = [0u32; 4];
        let (mut lo, mut hi) = (u32::MAX, 0);
        for _ in 0..1000 {
            let d = pick(&c, None, &catalogue, &mut rng).duration_ms;
            assert!((500..=900).contains(&d), "{d}");
            lo = lo.min(d);
            hi = hi.max(d);
            buckets[(((d - 500) * 4) / 401) as usize] += 1;
        }
        assert!(lo < 520 && hi > 880, "{lo}..{hi}");
        for b in buckets {
            assert!((180..320).contains(&b), "{buckets:?}");
        }
        // clamped to 10 s; max ≤ min → the min
        let c = cfg(&["fade"], false, 20_000, 30_000);
        assert_eq!(pick(&c, None, &catalogue, &mut rng).duration_ms, 10_000);
        let c = cfg(&["fade"], false, 700, 300);
        assert_eq!(pick(&c, None, &catalogue, &mut rng).duration_ms, 700);
    }

    #[test]
    fn from_map_parses_and_validates() {
        let m = json!({"enabled": true, "effects": ["fade"], "shuffle": true,
                       "duration_ms": 20000, "duration_max_ms": -5, "method": "frozen"});
        let c = TransitionCfg::from_map(m.as_object().unwrap()).unwrap();
        assert_eq!(
            c,
            TransitionCfg {
                enabled: true,
                effects: vec!["fade".into()],
                shuffle: true,
                duration_ms: 10_000,
                duration_max_ms: 0,
                method: Method::Frozen,
            }
        );
        assert_eq!(TransitionCfg::from_map(&Map::new()).unwrap(), TransitionCfg::default());
        let err = |v: Value| TransitionCfg::from_map(v.as_object().unwrap()).unwrap_err().code;
        assert_eq!(err(json!({"enabled": 1})), "bad_type");
        assert_eq!(err(json!({"effects": [1]})), "bad_type");
        assert_eq!(err(json!({"method": "slide"})), "out_of_range");
        assert_eq!(err(json!({"durationMs": 5})), "no_such_prop");
    }
}
