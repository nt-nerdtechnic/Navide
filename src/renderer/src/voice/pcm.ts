// Audio format conversion for voice input: whatever the capture device runs
// at → 16 kHz mono s16le, the format the navide-stt sidecar reads.

export const VOICE_SAMPLE_RATE = 16_000
/** ~250 ms of 16 kHz audio per voice.chunk. */
export const VOICE_CHUNK_SAMPLES = 4_000

/**
 * A streaming downsampler: each call takes the next block of mono float
 * samples at `inRate` and returns the 16-bit samples at `outRate` it completes.
 * Every output sample is the mean of the input samples in its window (a box
 * filter, enough to keep speech-band aliasing down at these ratios), and the
 * fractional position carries over between calls, so block boundaries leave
 * no seam.
 *
 * MUST stay self-contained — no references to anything outside its own body.
 * The AudioWorklet runs in a separate global scope, and its source is built
 * from this function's text (see workletSource.ts).
 */
export function createResampler(inRate: number, outRate: number): (input: Float32Array) => Int16Array {
  // Integer phase: each input sample advances it by outRate, and an output
  // window closes each time it reaches inRate. Exact, so where the blocks are
  // cut never changes where the windows fall.
  const inStep = Math.round(inRate)
  const outStep = Math.round(outRate)
  let acc = 0
  let count = 0
  let phase = 0
  return (input: Float32Array): Int16Array => {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) {
      acc += input[i]
      count++
      phase += outStep
      if (phase >= inStep) {
        phase -= inStep
        const mean = acc / count
        const clamped = mean > 1 ? 1 : mean < -1 ? -1 : mean
        out.push(clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff))
        acc = 0
        count = 0
      }
    }
    return Int16Array.from(out)
  }
}

/** Mix interleaved-by-channel float blocks down to mono. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const n = channels[0]?.length ?? 0
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length
  return out
}

/** Little-endian bytes of `samples`, base64-encoded for voice.chunk. */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}
