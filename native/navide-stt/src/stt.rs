//! Local speech-to-text via whisper.cpp (whisper-rs binding).
//! Ported from nt-type's `src-tauri/src/stt/mod.rs`, without `single_segment`
//! (it truncated longer utterances to the first segment).

use std::ffi::c_void;
use std::os::raw::c_int;
use std::path::Path;

use anyhow::{Context, Result};
use crate::protocol::Segment;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const SAMPLE_RATE: usize = 16_000;

/// whisper.cpp skips input under 1.0 s outright; pad to a little over that.
const MIN_SAMPLES: usize = SAMPLE_RATE * 11 / 10;

/// Holds a loaded whisper model. Created once, reused across transcriptions.
pub struct Transcriber {
    ctx: WhisperContext,
    n_threads: c_int,
    gpu: bool,
}

impl Transcriber {
    /// Load a ggml model file (e.g. ggml-base.bin). `threads` of `None`
    /// picks a default suited to the backend in use.
    pub fn load(model_path: &Path, threads: Option<usize>) -> Result<Self> {
        let path = model_path
            .to_str()
            .context("model path is not valid UTF-8")?;
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.flash_attn(true);
        let ctx = WhisperContext::new_with_params(path, ctx_params)
            .context("failed to load whisper model")?;
        let gpu = gpu_device_present();
        let available = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        // With Metal only the decoder runs on the CPU, where more than four
        // threads mostly adds context-switch overhead; CPU-only builds run the
        // encoder there too and scale further.
        let default_threads = available.min(if gpu { 4 } else { 8 });
        let n_threads = threads.unwrap_or(default_threads).max(1) as c_int;
        let transcriber = Self {
            ctx,
            n_threads,
            gpu,
        };
        // The first Metal inference after install compiles the shaders
        // (~1 min, then cached by macOS). Pay it here, before `ready`, rather
        // than on the user's first utterance. CPU builds have nothing to warm.
        if gpu {
            let started = std::time::Instant::now();
            transcriber
                .transcribe(&[0.0; MIN_SAMPLES], "en", "")
                .context("warm-up inference failed")?;
            eprintln!("navide-stt: warm-up took {} ms", started.elapsed().as_millis());
        }
        Ok(transcriber)
    }

    pub fn gpu(&self) -> bool {
        self.gpu
    }

    /// Transcribe 16 kHz mono f32 samples into one trimmed string.
    pub fn transcribe(&self, samples: &[f32], language: &str, initial_prompt: &str) -> Result<String> {
        let segments = self.transcribe_segments(samples, language, initial_prompt, false, &|| false)?;
        Ok(join_segments(&segments))
    }

    /// Transcribe into whisper's segments. Segment text has non-speech markers
    /// removed but keeps its leading space, so joining them preserves word
    /// spacing; times are relative to the start of `samples`. With `clauses`
    /// each segment is further split after clause punctuation, timed by token
    /// timestamps (whisper emits one segment for many seconds of Chinese).
    /// whisper.cpp polls `should_abort` between encoder/decoder steps and
    /// fails the run once it returns true.
    pub fn transcribe_segments(
        &self,
        samples: &[f32],
        language: &str,
        initial_prompt: &str,
        clauses: bool,
        should_abort: &dyn Fn() -> bool,
    ) -> Result<Vec<Segment>> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let padded;
        let samples = if samples.len() < MIN_SAMPLES {
            let mut buf = samples.to_vec();
            buf.resize(MIN_SAMPLES, 0.0);
            padded = buf;
            &padded[..]
        } else {
            samples
        };

        let mut state = self.ctx.create_state()?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_translate(false);
        // Voice input is always a fresh utterance — no cross-sentence context.
        params.set_no_context(true);
        params.set_n_threads(self.n_threads);
        params.set_token_timestamps(clauses);
        if !initial_prompt.is_empty() {
            params.set_initial_prompt(initial_prompt);
        }
        // Our own trampoline: whisper-rs 0.14's set_abort_callback_safe casts
        // its boxed closure to the wrong type. `abort` outlives `state.full`.
        let abort: &dyn Fn() -> bool = should_abort;
        unsafe {
            params.set_abort_callback(Some(abort_trampoline));
            params.set_abort_callback_user_data(&abort as *const &dyn Fn() -> bool as *mut c_void);
        }

        state.full(params, samples).context("whisper inference failed")?;

        // whisper.cpp reports times in 10 ms units.
        let n = state.full_n_segments()?;
        let mut out = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let (seg_t0, seg_t1) = (state.full_get_segment_t0(i)?, state.full_get_segment_t1(i)?);
            if !clauses {
                out.push(Segment {
                    t0_ms: seg_t0 * 10,
                    t1_ms: seg_t1 * 10,
                    text: remove_non_speech(&state.full_get_segment_text_lossy(i)?),
                });
                continue;
            }
            // Token bytes are accumulated per clause, so a character spread
            // over two tokens is decoded whole; a clause only ends after a
            // punctuation token, which is always a complete character.
            let eot = self.ctx.token_eot();
            let mut bytes: Vec<u8> = Vec::new();
            let mut t0 = seg_t0;
            for j in 0..state.full_n_tokens(i)? {
                let data = state.full_get_token_data(i, j)?;
                if data.id >= eot {
                    continue;
                }
                let token = state.full_get_token_bytes(i, j)?;
                bytes.extend_from_slice(&token);
                if ends_clause(&String::from_utf8_lossy(&token)) {
                    let t1 = data.t1.clamp(t0, seg_t1);
                    out.push(Segment {
                        t0_ms: t0 * 10,
                        t1_ms: t1 * 10,
                        text: remove_non_speech(&String::from_utf8_lossy(&bytes)),
                    });
                    bytes.clear();
                    t0 = t1;
                }
            }
            if !bytes.is_empty() {
                out.push(Segment {
                    t0_ms: t0 * 10,
                    t1_ms: seg_t1.max(t0) * 10,
                    text: remove_non_speech(&String::from_utf8_lossy(&bytes)),
                });
            }
        }
        Ok(out)
    }
}

/// True for a token that ends a clause (Chinese or Latin punctuation).
fn ends_clause(token: &str) -> bool {
    token
        .trim_end()
        .ends_with(['，', '。', '、', '！', '？', '；', '：', ',', '.', '!', '?', ';'])
}

unsafe extern "C" fn abort_trampoline(data: *mut c_void) -> bool {
    let should_abort = &*(data as *const &dyn Fn() -> bool);
    should_abort()
}

/// The trimmed transcript of `segments`, as `transcribe` returns it.
pub fn join_segments(segments: &[Segment]) -> String {
    let joined: String = segments.iter().map(|s| s.text.as_str()).collect();
    joined.trim().to_string()
}

/// True when ggml registered a GPU device (Metal on macOS). whisper.cpp uses
/// the first GPU device whenever `use_gpu` is set, which is the default.
fn gpu_device_present() -> bool {
    unsafe {
        (0..whisper_rs_sys::ggml_backend_dev_count()).any(|i| {
            let dev = whisper_rs_sys::ggml_backend_dev_get(i);
            whisper_rs_sys::ggml_backend_dev_type(dev)
                == whisper_rs_sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
        })
    }
}

/// Decode raw s16le mono PCM into f32 samples in [-1, 1). A trailing odd
/// byte (a torn final sample) is ignored.
pub fn decode_s16le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

/// Remove whisper non-speech annotations like [BLANK_AUDIO], [Music], [音樂],
/// 【...】 — these are model markers, not user speech, and must not be typed out.
pub fn strip_non_speech(text: &str) -> String {
    remove_non_speech(text).trim().to_string()
}

/// `strip_non_speech` without the trim.
fn remove_non_speech(text: &str) -> String {
    let mut out = String::new();
    let mut depth: i32 = 0;
    for c in text.chars() {
        match c {
            '[' | '【' => depth += 1,
            ']' | '】' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{decode_s16le, ends_clause, join_segments, strip_non_speech};
    use crate::protocol::Segment;

    #[test]
    fn strips_blank_audio_marker() {
        assert_eq!(strip_non_speech("[BLANK_AUDIO]"), "");
        assert_eq!(strip_non_speech("[_BLANK_AUDIO_]"), "");
        assert_eq!(strip_non_speech("  [BLANK_AUDIO]  "), "");
    }

    #[test]
    fn strips_inline_markers_keeps_speech() {
        assert_eq!(strip_non_speech("你好[Music]世界"), "你好世界");
        assert_eq!(strip_non_speech("【音樂】今天天氣不錯"), "今天天氣不錯");
    }

    #[test]
    fn keeps_plain_speech() {
        assert_eq!(strip_non_speech("幫我分析專案結構"), "幫我分析專案結構");
    }

    #[test]
    fn unbalanced_close_does_not_swallow_speech() {
        assert_eq!(strip_non_speech("a]b"), "ab");
    }

    #[test]
    fn joins_segments_like_transcribe() {
        let seg = |t: &str| Segment { t0_ms: 0, t1_ms: 0, text: t.into() };
        assert_eq!(join_segments(&[seg(" Hello"), seg(" world")]), "Hello world");
        assert_eq!(join_segments(&[seg("你好"), seg("世界 ")]), "你好世界");
        assert_eq!(join_segments(&[]), "");
    }

    #[test]
    fn clause_punctuation() {
        assert!(ends_clause("，"));
        assert!(ends_clause("話。"));
        assert!(ends_clause(" world."));
        assert!(!ends_clause("麥克風"));
        assert!(!ends_clause(" hello"));
    }

    #[test]
    fn decodes_s16le_samples() {
        let bytes = [0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40];
        assert_eq!(decode_s16le(&bytes), vec![0.0, 32767.0 / 32768.0, -1.0, 0.5]);
    }

    #[test]
    fn decode_ignores_trailing_odd_byte() {
        assert_eq!(decode_s16le(&[0x00, 0x40, 0x7f]), vec![0.5]);
        assert!(decode_s16le(&[]).is_empty());
    }
}
