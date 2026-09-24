import { createResampler, VOICE_CHUNK_SAMPLES, VOICE_SAMPLE_RATE } from './pcm'

export const VOICE_WORKLET_NAME = 'navide-voice-capture'

/**
 * Source of the AudioWorklet that turns the mic stream into 16 kHz mono s16le.
 *
 * Built from createResampler's own text so the worklet and the tested code are
 * the same function — the worklet scope has no module imports. Each posted
 * message is an ArrayBuffer (transferred) of ~250 ms of samples; a `flush`
 * message from the page posts whatever is left, then `{ flushed: true }`.
 */
export function voiceWorkletSource(): string {
  return `
const createResampler = ${createResampler.toString()};
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resample = createResampler(sampleRate, ${VOICE_SAMPLE_RATE});
    this.buf = new Int16Array(${VOICE_CHUNK_SAMPLES});
    this.len = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.post();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  post() {
    if (this.len === 0) return;
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    this.port.postMessage(out.buffer, [out.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const pcm = this.resample(ch);
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.len++] = pcm[i];
      if (this.len === this.buf.length) this.post();
    }
    return true;
  }
}
registerProcessor('${VOICE_WORKLET_NAME}', VoiceCapture);
`
}
