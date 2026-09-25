//! JSON Lines protocol between the Navide backend and this sidecar.
//! stdout carries protocol lines only; everything else goes to stderr.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::script::Script;

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
        /// Also return timed `segments` in the reply: whisper's segments
        /// split after clause punctuation (token timestamps).
        segments: bool,
        /// Chinese script the text and segments are converted to.
        script: Script,
        /// Run the encoder over the submitted audio only, not a padded 30 s
        /// window. Cheaper per run (ggml-base on an M4: 1–4 s windows ~40%
        /// faster when idle), but on short windows whisper then hallucinates
        /// repetitions more often, each costing a temperature-fallback
        /// re-decode, so Navide's backend does not send it (2026-09-25).
        fit_audio_ctx: bool,
    },
    Ping {
        id: String,
    },
    /// Abort request `target` if it is running or still queued. No reply of
    /// its own; the target answers `{"ok":false,"cancelled":true}`.
    Cancel {
        target: String,
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
    segments: Option<bool>,
    script: Option<String>,
    fit_audio_ctx: Option<bool>,
    target: Option<String>,
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
    if op == "cancel" {
        return Some(match raw.target {
            Some(target) if !target.is_empty() => Request::Cancel { target },
            _ => Request::Invalid {
                id: raw.id,
                error: "missing target".to_string(),
            },
        });
    }
    let Some(id) = raw.id else {
        return Some(Request::Invalid {
            id: None,
            error: "missing id".to_string(),
        });
    };
    Some(match op {
        "ping" => Request::Ping { id },
        "transcribe" => match (raw.pcm_path, raw.script.as_deref().map_or(Some(Script::None), Script::parse)) {
            (_, None) => Request::Invalid {
                id: Some(id),
                error: format!("unknown script: {:?}", raw.script.unwrap_or_default()),
            },
            (Some(pcm_path), Some(script)) if !pcm_path.is_empty() => Request::Transcribe {
                id,
                pcm_path,
                language: raw
                    .language
                    .filter(|l| !l.is_empty())
                    .unwrap_or_else(|| DEFAULT_LANGUAGE.to_string()),
                initial_prompt: raw
                    .initial_prompt
                    .unwrap_or_else(|| DEFAULT_INITIAL_PROMPT.to_string()),
                segments: raw.segments.unwrap_or(false),
                script,
                fit_audio_ctx: raw.fit_audio_ctx.unwrap_or(false),
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

/// One whisper segment; times are ms from the start of the submitted audio.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
}

/// `ok_text` plus the segments the text was joined from.
pub fn ok_segments(id: &str, text: &str, ms: u128, segments: &[Segment]) -> Value {
    let mut reply = ok_text(id, text, ms);
    reply["segments"] = segments
        .iter()
        .map(|s| json!({ "t0_ms": s.t0_ms, "t1_ms": s.t1_ms, "text": s.text }))
        .collect();
    reply
}

pub fn ok(id: &str) -> Value {
    json!({ "id": id, "ok": true })
}

pub fn cancelled(id: &str) -> Value {
    json!({ "id": id, "ok": false, "error": "cancelled", "cancelled": true })
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
                segments: false,
                script: Script::None,
                fit_audio_ctx: false,
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
                segments: false,
                script: Script::None,
                fit_audio_ctx: false,
            })
        );
    }

    #[test]
    fn parses_segments_flag() {
        let req = parse_request(r#"{"id":"s","op":"transcribe","pcm_path":"/p","segments":true}"#);
        assert!(matches!(req, Some(Request::Transcribe { segments: true, .. })));
        let req = parse_request(r#"{"id":"s","op":"transcribe","pcm_path":"/p","segments":false}"#);
        assert!(matches!(req, Some(Request::Transcribe { segments: false, .. })));
    }

    #[test]
    fn parses_fit_audio_ctx_flag() {
        let req = parse_request(r#"{"id":"f","op":"transcribe","pcm_path":"/p","fit_audio_ctx":true}"#);
        assert!(matches!(req, Some(Request::Transcribe { fit_audio_ctx: true, .. })));
    }

    #[test]
    fn parses_script() {
        for (value, script) in [("hant-tw", Script::HantTw), ("hans", Script::Hans), ("none", Script::None)] {
            let line = format!(r#"{{"id":"z","op":"transcribe","pcm_path":"/p","script":"{value}"}}"#);
            assert!(matches!(parse_request(&line), Some(Request::Transcribe { script: s, .. }) if s == script));
        }
        assert!(matches!(
            parse_request(r#"{"id":"z","op":"transcribe","pcm_path":"/p","script":"zh-CN"}"#),
            Some(Request::Invalid { id: Some(_), .. })
        ));
    }

    #[test]
    fn parses_cancel() {
        assert_eq!(
            parse_request(r#"{"op":"cancel","target":"r5"}"#),
            Some(Request::Cancel { target: "r5".into() })
        );
        assert!(matches!(
            parse_request(r#"{"id":"c","op":"cancel"}"#),
            Some(Request::Invalid { id: Some(_), .. })
        ));
        assert_eq!(
            cancelled("r5").to_string(),
            r#"{"cancelled":true,"error":"cancelled","id":"r5","ok":false}"#
        );
    }

    #[test]
    fn segments_reply_shape() {
        let segs = [
            Segment { t0_ms: 0, t1_ms: 1200, text: "你好".into() },
            Segment { t0_ms: 1200, t1_ms: 2500, text: " world".into() },
        ];
        assert_eq!(
            ok_segments("i", "你好 world", 7, &segs).to_string(),
            r#"{"id":"i","ms":7,"ok":true,"segments":[{"t0_ms":0,"t1_ms":1200,"text":"你好"},{"t0_ms":1200,"t1_ms":2500,"text":" world"}],"text":"你好 world"}"#
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
