import { describe, expect, it } from 'vitest'
import { createResampler, int16ToBase64, mixToMono, VOICE_CHUNK_SAMPLES } from '../pcm'
import { VOICE_WORKLET_NAME, voiceWorkletSource } from '../workletSource'

function constant(n: number, v: number): Float32Array {
  return new Float32Array(n).fill(v)
}

describe('createResampler', () => {
  it('48 kHz → 16 kHz keeps one sample in three and the level', () => {
    const out = createResampler(48_000, 16_000)(constant(480, 0.5))
    expect(out.length).toBe(160)
    expect([...new Set(out)]).toEqual([Math.round(0.5 * 0x7fff)])
  })

  it('44.1 kHz → 16 kHz yields the right count over a long take', () => {
    const r = createResampler(44_100, 16_000)
    let total = 0
    for (let i = 0; i < 100; i++) total += r(constant(441, 0)).length
    // 44 100 input samples = 1 s → 16 000 output samples (±1 for the open window).
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1)
  })

  it('block boundaries leave no seam: split input equals whole input', () => {
    const input = Float32Array.from({ length: 1_000 }, (_, i) => Math.sin(i / 7))
    const whole = createResampler(44_100, 16_000)(input)
    const split = createResampler(44_100, 16_000)
    const parts = [split(input.subarray(0, 128)), split(input.subarray(128, 511)), split(input.subarray(511))]
    const joined = Int16Array.from(parts.flatMap((p) => [...p]))
    expect(joined).toEqual(whole)
  })

  it('averages each window (box filter) and clamps to s16 range', () => {
    const r = createResampler(32_000, 16_000)
    expect([...r(Float32Array.from([1, 0, 2, 2, -3, -3]))]).toEqual([Math.round(0.5 * 0x7fff), 0x7fff, -0x8000])
  })

  it('16 kHz input passes through unchanged', () => {
    expect([...createResampler(16_000, 16_000)(Float32Array.from([0, -1, 1]))]).toEqual([0, -0x8000, 0x7fff])
  })
})

describe('int16ToBase64', () => {
  it('encodes little-endian s16', () => {
    // 1 → 01 00, -2 → FE FF, 0x1234 → 34 12
    const b64 = int16ToBase64(Int16Array.from([1, -2, 0x1234]))
    expect([...atob(b64)].map((c) => c.charCodeAt(0))).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12])
  })

  it('handles a full 250 ms chunk', () => {
    const b64 = int16ToBase64(new Int16Array(VOICE_CHUNK_SAMPLES).fill(-1))
    expect(atob(b64).length).toBe(VOICE_CHUNK_SAMPLES * 2)
  })
})

describe('mixToMono', () => {
  it('averages channels', () => {
    expect([...mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 0])])]).toEqual([0.5, 0])
  })
})

describe('voice worklet source', () => {
  // Runs the generated module text against a stand-in worklet scope: proves the
  // inlined resampler survives stringification and the processor emits s16
  // chunks of the promised size, plus a final flush.
  function loadProcessor(rate: number) {
    let Registered: (new () => { process: (i: Float32Array[][]) => boolean; port: FakePort }) | null = null
    class FakePort {
      posted: unknown[] = []
      onmessage: ((e: { data: unknown }) => void) | null = null
      postMessage(d: unknown): void { this.posted.push(d) }
    }
    class AudioWorkletProcessor { port = new FakePort() }
    const registerProcessor = (name: string, cls: typeof Registered): void => {
      expect(name).toBe(VOICE_WORKLET_NAME)
      Registered = cls
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', voiceWorkletSource())(
      AudioWorkletProcessor, registerProcessor, rate,
    )
    return new Registered!()
  }

  it('posts 4000-sample chunks and flushes the remainder', () => {
    const p = loadProcessor(48_000)
    // 13 000 input frames of 128 → 4 333 output samples: one full chunk + 333.
    const frames = Math.ceil(13_000 / 128)
    for (let i = 0; i < frames; i++) p.process([[constant(128, 0.25)]])
    const chunks = p.port.posted.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer)
    expect(chunks.map((c) => c.byteLength)).toEqual([VOICE_CHUNK_SAMPLES * 2])
    p.port.onmessage!({ data: 'flush' })
    const after = p.port.posted.slice(-2)
    expect((after[0] as ArrayBuffer).byteLength).toBe((Math.floor((frames * 128) / 3) - VOICE_CHUNK_SAMPLES) * 2)
    expect(after[1]).toEqual({ flushed: true })
    expect(new Int16Array(chunks[0])[0]).toBe(Math.round(0.25 * 0x7fff))
  })
})
