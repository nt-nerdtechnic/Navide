//! navide-stt: local speech-to-text sidecar for Navide.
//!
//! Usage: navide-stt --model <abs path> [--threads N]
//! Speaks JSON Lines on stdin/stdout (see src/protocol.rs); logs go to stderr.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use navide_stt::protocol::{self, Request};
use navide_stt::stt::{decode_s16le, Transcriber};
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

    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let reply = match protocol::parse_request(&line) {
            None => continue,
            Some(Request::Shutdown) => break,
            Some(Request::Ping { id }) => protocol::ok(&id),
            Some(Request::Invalid { id, error }) => protocol::err(id.as_deref(), &error),
            Some(Request::Transcribe {
                id,
                pcm_path,
                language,
                initial_prompt,
            }) => {
                let started = Instant::now();
                let result = std::fs::read(&pcm_path)
                    .map_err(|e| format!("cannot read pcm_path: {e}"))
                    .and_then(|bytes| {
                        transcriber
                            .transcribe(&decode_s16le(&bytes), &language, &initial_prompt)
                            .map_err(|e| format!("{e:#}"))
                    });
                match result {
                    Ok(text) => protocol::ok_text(&id, &text, started.elapsed().as_millis()),
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
