//! The wire protocol (spec §4.2 "Command API", §9): JSON Lines over a unix socket.
//!
//! - request `{"id":N,"cmd":"<verb>","args":{…}}` (`args` optional; `id` any JSON value,
//!   echoed back verbatim)
//! - reply `{"id":N,"ok":true,"result":…}` | `{"id":N,"ok":false,"error":{"code","message",
//!   "hint"}}` — an unparseable line gets `"id":null`
//! - event (connections that `subscribe`d) `{"event":"<kind>","corr":…,"t_mono_ms":…, …}` —
//!   an event-log record with `kind` renamed to `event`
//!
//! Lines are capped at [`MAX_LINE`]; see `.claude/rules/player-core.md` § Command API.

use serde_json::{Map, Value, json};

use crate::graph::ApiError;

/// Longest request line accepted (bytes, without the newline). Longer → `bad_request`
/// and the connection is closed.
pub const MAX_LINE: usize = 1024 * 1024;

/// Where every error's hint points when there's nothing more specific to say.
pub const DOC: &str = ".claude/rules/player-core.md \u{a7} Command API";

/// One parsed request.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: Value,
    pub cmd: String,
    pub args: Value,
}

/// Parse one request line. On failure returns the id if one could be read (else `null`)
/// with a `bad_request` error.
pub fn parse(line: &[u8]) -> Result<Request, (Value, ApiError)> {
    let v: Value = serde_json::from_slice(line).map_err(|e| {
        (
            Value::Null,
            bad_request(format!("not a JSON request line: {e}")),
        )
    })?;
    let Value::Object(mut o) = v else {
        return Err((
            Value::Null,
            bad_request("a request must be a JSON object".into()),
        ));
    };
    let id = o.remove("id").unwrap_or(Value::Null);
    let cmd = match o.remove("cmd") {
        Some(Value::String(c)) => c,
        Some(other) => {
            return Err((
                id,
                bad_request(format!("`cmd` must be a string, got {other}")),
            ));
        }
        None => return Err((id, bad_request("missing `cmd`".into()))),
    };
    let args = match o.remove("args") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(a @ Value::Object(_)) => a,
        Some(other) => {
            return Err((
                id,
                bad_request(format!("`args` must be an object, got {other}")),
            ));
        }
    };
    Ok(Request { id, cmd, args })
}

/// A success reply line (no trailing newline).
pub fn ok_line(id: &Value, result: Value) -> String {
    json!({"id": id, "ok": true, "result": result}).to_string()
}

/// An error reply line (no trailing newline).
pub fn err_line(id: &Value, e: &ApiError) -> String {
    json!({"id": id, "ok": false, "error": e}).to_string()
}

/// An event-log record as a subscription event line: `kind` → `event`, first key.
pub fn event_line(record: &Value) -> String {
    let mut out = Map::new();
    if let Value::Object(o) = record {
        out.insert(
            "event".into(),
            o.get("kind").cloned().unwrap_or(Value::Null),
        );
        for (k, v) in o {
            if k != "kind" {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out).to_string()
}

pub fn bad_request(message: String) -> ApiError {
    ApiError {
        code: "bad_request",
        message,
        hint: format!(
            "requests are one JSON object per line: {{\"id\":1,\"cmd\":\"<verb>\",\"args\":{{…}}}}; \
             see {DOC}"
        ),
    }
}

pub fn no_such_verb(cmd: &str, verbs: &[&str]) -> ApiError {
    ApiError {
        code: "no_such_verb",
        message: format!("unknown verb {cmd:?}"),
        hint: format!("verbs: {}; see {DOC}", verbs.join(", ")),
    }
}

pub fn unsupported(message: String, hint: &str) -> ApiError {
    ApiError {
        code: "unsupported",
        message,
        hint: hint.to_string(),
    }
}

/// The value of `args[key]`, typed — `bad_request` naming the key if absent/wrong.
pub fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request(format!("args.{key} must be a string")))
}

pub fn arg_f64(args: &Value, key: &str) -> Result<f64, ApiError> {
    args.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad_request(format!("args.{key} must be a number")))
}

pub fn opt_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, ApiError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(bad_request(format!(
            "args.{key} must be a string, got {other}"
        ))),
    }
}

pub fn opt_f64(args: &Value, key: &str) -> Result<Option<f64>, ApiError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_f64()
            .map(Some)
            .ok_or_else(|| bad_request(format!("args.{key} must be a number, got {v}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shapes() {
        let r = parse(br#"{"id":7,"cmd":"hello"}"#).unwrap();
        assert_eq!(
            (r.id, r.cmd.as_str(), r.args),
            (json!(7), "hello", json!({}))
        );
        let (id, e) = parse(b"garbage").unwrap_err();
        assert_eq!((id, e.code), (Value::Null, "bad_request"));
        let (id, e) = parse(br#"{"id":"a","cmd":3}"#).unwrap_err();
        assert_eq!((id, e.code), (json!("a"), "bad_request"));
        let (_, e) = parse(br#"{"id":1,"cmd":"x","args":[1]}"#).unwrap_err();
        assert_eq!(e.code, "bad_request");
    }

    #[test]
    fn event_line_renames_kind() {
        let rec = json!({"t_mono_ms": 1.5, "kind": "source.ready", "corr": null, "id": "src1"});
        let v: Value = serde_json::from_str(&event_line(&rec)).unwrap();
        assert_eq!(v["event"], "source.ready");
        assert!(v.get("kind").is_none());
        assert_eq!(v["id"], "src1");
        assert_eq!(v["corr"], Value::Null);
    }
}
