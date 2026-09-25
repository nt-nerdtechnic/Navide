//! navide-stt: local speech-to-text sidecar for Navide.
//!
//! Usage: navide-stt --model <abs path> [--threads N]
//! Speaks JSON Lines on stdin/stdout (see src/protocol.rs); logs go to stderr.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::process::ExitCode;
use std::time::Instant;

use navide_stt::protocol::{self, Request};
use navide_stt::stt::{decode_s16le, join_segments, Transcriber};
use serde_json::Value;

struct Args {
    model: PathBuf,
    threads: Option<usize>,
}

fn parse_args() -> Result<Args, String> {
    let mut model = None;
    let mut threads = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model = args.next().map(PathBuf::from),
            "--threads" => {
                let value = args.next().ok_or("--threads needs a value")?;
                threads = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| format!("invalid --threads value: {value}"))?,
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let model = model.ok_or("--model <path> is required")?;
    Ok(Args { model, threads })
}

fn emit(out: &mut impl Write, value: &Value) -> io::Result<()> {
    writeln!(out, "{value}")?;
    out.flush()
}

fn main() -> ExitCode {
    let mut stdout = io::stdout().lock();

    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            let _ = emit(&mut stdout, &protocol::fatal(&error));
            return ExitCode::FAILURE;
        }
    };
    let transcriber = match Transcriber::load(&args.model, args.threads) {
        Ok(t) => t,
        Err(error) => {
            let _ = emit(&mut stdout, &protocol::fatal(&format!("{error:#}")));
            return ExitCode::FAILURE;
        }
    };
    let model = args.model.to_string_lossy();
    if emit(&mut stdout, &protocol::ready(&model, transcriber.gpu())).is_err() {
        return ExitCode::FAILURE;
    }

    // stdin is read on its own thread so a `cancel` can reach a transcription
    // that is already running; every reply is still written from this thread.
    let cancel_target: Arc<Mutex<Option<String>>> = Arc::default();
    let (tx, rx) = mpsc::channel::<Request>();
    {
        let cancel_target = Arc::clone(&cancel_target);
        std::thread::spawn(move || {
            for line in io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                match protocol::parse_request(&line) {
                    None => {}
                    Some(Request::Cancel { target }) => {
                        *cancel_target.lock().unwrap() = Some(target);
                    }
                    Some(Request::Shutdown) => {
                        let _ = tx.send(Request::Shutdown);
                        break;
                    }
                    Some(request) => {
                        if tx.send(request).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let is_cancelled = |id: &str| cancel_target.lock().unwrap().as_deref() == Some(id);

    for request in rx {
        let reply = match request {
            Request::Shutdown => break,
            Request::Cancel { .. } => continue,
            Request::Ping { id } => protocol::ok(&id),
            Request::Invalid { id, error } => protocol::err(id.as_deref(), &error),
            Request::Transcribe { id, .. } if is_cancelled(&id) => protocol::cancelled(&id),
            Request::Transcribe {
                id,
                pcm_path,
                language,
                initial_prompt,
                segments,
                script,
                fit_audio_ctx,
            } => {
                let started = Instant::now();
                let result = std::fs::read(&pcm_path)
                    .map_err(|e| format!("cannot read pcm_path: {e}"))
                    .and_then(|bytes| {
                        transcriber
                            .transcribe_segments(&decode_s16le(&bytes), &language, &initial_prompt, segments, fit_audio_ctx, &|| {
                                is_cancelled(&id)
                            })
                            .map_err(|e| format!("{e:#}"))
                    });
                match result {
                    _ if is_cancelled(&id) => protocol::cancelled(&id),
                    Ok(mut segs) => {
                        for seg in &mut segs {
                            seg.text = script.convert(&seg.text);
                        }
                        let text = join_segments(&segs);
                        let ms = started.elapsed().as_millis();
                        if segments {
                            protocol::ok_segments(&id, &text, ms, &segs)
                        } else {
                            protocol::ok_text(&id, &text, ms)
                        }
                    }
                    Err(error) => protocol::err(Some(&id), &error),
                }
            }
        };
        if emit(&mut stdout, &reply).is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}
