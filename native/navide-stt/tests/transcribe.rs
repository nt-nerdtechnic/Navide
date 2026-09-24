//! End-to-end check of the JSON Lines protocol against the real binary.
//! Needs a whisper model, so it only runs when NAVIDE_STT_TEST_MODEL points
//! at one (e.g. ggml-base.bin). Optional: NAVIDE_STT_TEST_PCM (raw s16le mono
//! 16 kHz; defaults to 1 s of silence) and NAVIDE_STT_TEST_EXPECT (a substring
//! the transcript must contain).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

#[test]
fn transcribes_fixture_over_json_lines() {
    let Ok(model) = std::env::var("NAVIDE_STT_TEST_MODEL") else {
        eprintln!("NAVIDE_STT_TEST_MODEL not set; skipping");
        return;
    };
    let pcm_path = match std::env::var("NAVIDE_STT_TEST_PCM") {
        Ok(path) => path,
        Err(_) => {
            let path = std::env::temp_dir().join(format!("navide-stt-silence-{}.pcm", std::process::id()));
            std::fs::write(&path, vec![0u8; 32_000]).unwrap();
            path.to_string_lossy().into_owned()
        }
    };

    let mut child = Command::new(env!("CARGO_BIN_EXE_navide-stt"))
        .args(["--model", &model])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap() };

    let ready = next();
    assert_eq!(ready["event"], "ready", "{ready}");
    assert!(ready["gpu"].is_boolean());

    writeln!(stdin, r#"{{"id":"p1","op":"ping"}}"#).unwrap();
    assert_eq!(next(), serde_json::json!({"id": "p1", "ok": true}));

    let request = serde_json::json!({"id": "t1", "op": "transcribe", "pcm_path": pcm_path, "language": "zh"});
    writeln!(stdin, "{request}").unwrap();
    let reply = next();
    assert_eq!(reply["id"], "t1");
    assert_eq!(reply["ok"], true, "{reply}");
    let text = reply["text"].as_str().unwrap();
    eprintln!("transcript: {text:?} in {} ms (gpu={})", reply["ms"], ready["gpu"]);
    if let Ok(expect) = std::env::var("NAVIDE_STT_TEST_EXPECT") {
        assert!(text.contains(&expect), "{text:?} does not contain {expect:?}");
    }

    writeln!(stdin, r#"{{"id":"t2","op":"transcribe","pcm_path":"/nonexistent/navide.pcm"}}"#).unwrap();
    let reply = next();
    assert_eq!(reply["ok"], false);

    let request = serde_json::json!({"id": "t3", "op": "transcribe", "pcm_path": pcm_path, "segments": true});
    writeln!(stdin, "{request}").unwrap();
    let reply = next();
    assert_eq!(reply["ok"], true, "{reply}");
    let segments = reply["segments"].as_array().expect("segments");
    let joined: String = segments.iter().map(|s| s["text"].as_str().unwrap()).collect();
    assert_eq!(joined.trim(), reply["text"].as_str().unwrap());
    assert!(segments.iter().all(|s| s["t1_ms"].as_i64() >= s["t0_ms"].as_i64()));

    // A cancel sent right behind a request aborts it (or, on a fast machine,
    // lands after it finished); either way the next request still works.
    let long = std::env::temp_dir().join(format!("navide-stt-long-{}.pcm", std::process::id()));
    std::fs::write(&long, vec![0u8; 32_000 * 25]).unwrap();
    let request = serde_json::json!({"id": "t4", "op": "transcribe", "pcm_path": long});
    writeln!(stdin, "{request}").unwrap();
    writeln!(stdin, r#"{{"op":"cancel","target":"t4"}}"#).unwrap();
    let reply = next();
    assert_eq!(reply["id"], "t4");
    assert!(reply["ok"] == true || reply["cancelled"] == true, "{reply}");
    eprintln!("cancel reply: {reply}");
    writeln!(stdin, r#"{{"id":"p2","op":"ping"}}"#).unwrap();
    assert_eq!(next(), serde_json::json!({"id": "p2", "ok": true}));
    let _ = std::fs::remove_file(&long);

    writeln!(stdin, r#"{{"op":"shutdown"}}"#).unwrap();
    assert!(child.wait().unwrap().success());
}
