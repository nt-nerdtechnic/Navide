//! JSON Lines protocol between the Navide backend and this sidecar.
//! stdout carries protocol lines only; everything else goes to stderr.

use serde::Deserialize;
use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Decoder bias used when a request omits `initial_prompt`.
pub const DEFAULT_INITIAL_PROMPT: &str = "以下是繁體中文語音記錄。";
pub const DEFAULT_LANGUAGE: &str = "zh";

#[derive(Debug, PartialEq)]
pub enum Request {
    Transcribe {
        id: String,
        pcm_path: String,
        language: String,
        initial_prompt: String,
    },
    Ping {
        id: String,
    },
    Shutdown,
    /// A line we could not act on; answered with `ok:false`.
    Invalid {
        id: Option<String>,
        error: String,
    },
}

#[derive(Deserialize)]
struct RawRequest {
    id: Option<String>,
    op: Option<String>,
    pcm_path: Option<String>,
    language: Option<String>,
    initial_prompt: Option<String>,
}

/// Parse one stdin line. Returns `None` for blank lines.
pub fn parse_request(line: &str) -> Option<Request> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: RawRequest = match serde_json::from_str(line) {
        Ok(raw) => raw,
        Err(err) => {
            return Some(Request::Invalid {
                id: None,
                error: format!("invalid request: {err}"),
            })
        }
    };
    let op = raw.op.as_deref().unwrap_or("");
    if op == "shutdown" {
        return Some(Request::Shutdown);
    }
    let Some(id) = raw.id else {
        return Some(Request::Invalid {
            id: None,
            error: "missing id".to_string(),
        });
    };
    Some(match op {
        "ping" => Request::Ping { id },
        "transcribe" => match raw.pcm_path {
            Some(pcm_path) if !pcm_path.is_empty() => Request::Transcribe {
                id,
                pcm_path,
                language: raw
                    .language
                    .filter(|l| !l.is_empty())
                    .unwrap_or_else(|| DEFAULT_LANGUAGE.to_string()),
                initial_prompt: raw
                    .initial_prompt
                    .unwrap_or_else(|| DEFAULT_INITIAL_PROMPT.to_string()),
            },
            _ => Request::Invalid {
                id: Some(id),
                error: "missing pcm_path".to_string(),
            },
        },
        other => Request::Invalid {
            id: Some(id),
            error: format!("unknown op: {other:?}"),
        },
    })
}

pub fn ready(model: &str, gpu: bool) -> Value {
    json!({ "event": "ready", "version": VERSION, "model": model, "gpu": gpu })
}

pub fn fatal(error: &str) -> Value {
    json!({ "event": "fatal", "error": error })
}

pub fn ok_text(id: &str, text: &str, ms: u128) -> Value {
    json!({ "id": id, "ok": true, "text": text, "ms": ms })
}

pub fn ok(id: &str) -> Value {
    json!({ "id": id, "ok": true })
}

pub fn err(id: Option<&str>, error: &str) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_transcribe_with_defaults() {
        let req = parse_request(r#"{"id":"a1","op":"transcribe","pcm_path":"/tmp/x.pcm"}"#);
        assert_eq!(
            req,
            Some(Request::Transcribe {
                id: "a1".into(),
                pcm_path: "/tmp/x.pcm".into(),
                language: "zh".into(),
                initial_prompt: DEFAULT_INITIAL_PROMPT.into(),
            })
        );
    }

    #[test]
    fn parses_transcribe_with_overrides() {
        let req = parse_request(
            r#"{"id":"a2","op":"transcribe","pcm_path":"/p","language":"en","initial_prompt":""}"#,
        );
        assert_eq!(
            req,
            Some(Request::Transcribe {
                id: "a2".into(),
                pcm_path: "/p".into(),
                language: "en".into(),
                initial_prompt: String::new(),
            })
        );
    }

    #[test]
    fn parses_ping_and_shutdown() {
        assert_eq!(
            parse_request(r#"{"id":"p","op":"ping"}"#),
            Some(Request::Ping { id: "p".into() })
        );
        assert_eq!(parse_request(r#"{"op":"shutdown"}"#), Some(Request::Shutdown));
    }

    #[test]
    fn blank_lines_are_ignored() {
        assert_eq!(parse_request("   "), None);
    }

    #[test]
    fn malformed_requests_are_invalid() {
        assert!(matches!(
            parse_request("not json"),
            Some(Request::Invalid { id: None, .. })
        ));
        assert!(matches!(
            parse_request(r#"{"op":"ping"}"#),
            Some(Request::Invalid { id: None, .. })
        ));
        assert!(matches!(
            parse_request(r#"{"id":"x","op":"transcribe"}"#),
            Some(Request::Invalid { id: Some(_), .. })
        ));
        assert!(matches!(
            parse_request(r#"{"id":"x","op":"dance"}"#),
            Some(Request::Invalid { id: Some(_), .. })
        ));
    }

    #[test]
    fn responses_have_contract_shape() {
        assert_eq!(
            ok_text("i", "你好", 12).to_string(),
            r#"{"id":"i","ms":12,"ok":true,"text":"你好"}"#
        );
        assert_eq!(err(None, "e")["id"], Value::Null);
        assert_eq!(ready("/m", true)["event"], "ready");
        assert_eq!(fatal("x")["event"], "fatal");
    }
}
