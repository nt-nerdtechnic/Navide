//! Local speech-to-text via whisper.cpp (whisper-rs binding).
//! Ported from nt-type's `src-tauri/src/stt/mod.rs`, without `single_segment`
//! (it truncated longer utterances to the first segment).

use std::os::raw::c_int;
use std::path::Path;

use anyhow::{Context, Result};
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
        if samples.is_empty() {
            return Ok(String::new());
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
        if !initial_prompt.is_empty() {
            params.set_initial_prompt(initial_prompt);
        }

        state.full(params, samples).context("whisper inference failed")?;

        let n = state.full_n_segments()?;
        let mut out = String::new();
        for i in 0..n {
            out.push_str(&state.full_get_segment_text_lossy(i)?);
        }
        Ok(strip_non_speech(&out))
    }
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
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{decode_s16le, strip_non_speech};

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
