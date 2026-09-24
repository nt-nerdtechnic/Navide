import { VOICE_WORKLET_NAME, voiceWorkletSource } from './workletSource'

/** A live microphone capture feeding 16 kHz mono s16le blocks to `onChunk`. */
export interface VoiceCapture {
  /** Emit whatever audio is still buffered, then resolve. */
  flush(): Promise<void>
  /** Release the mic and the audio graph. Idempotent. */
  close(): void
}

const FLUSH_TIMEOUT_MS = 500

let workletUrl: string | null = null

function workletModuleUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([voiceWorkletSource()], { type: 'application/javascript' }))
  }
  return workletUrl
}

function requestStream(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  })
}

/**
 * Open the chosen microphone ('' = system default). Only ever called from a
 * hold-to-talk press with voice input switched on — this is the one place the
 * app calls getUserMedia. A chosen device that is gone (unplugged, or an id
 * from another origin) falls back to the system default once; a denied
 * permission is never retried.
 */
export async function openMicCapture(onChunk: (pcm: Int16Array) => void, deviceId = ''): Promise<VoiceCapture> {
  let stream: MediaStream
  try {
    stream = await requestStream(deviceId)
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err
    stream = await requestStream('')
  }
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext()
    await ctx.audioWorklet.addModule(workletModuleUrl())
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, VOICE_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 })
    // A worklet that reaches no destination may never be pulled; route it
    // through a muted gain so it runs without playing the mic back.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)

    let onFlushed: (() => void) | null = null
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) onChunk(new Int16Array(e.data))
      else if (e.data && (e.data as { flushed?: boolean }).flushed) onFlushed?.()
    }

    let closed = false
    const audioCtx = ctx
    return {
      flush: () =>
        new Promise<void>((resolve) => {
          if (closed) return resolve()
          const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
          onFlushed = () => {
            clearTimeout(timer)
            onFlushed = null
            resolve()
          }
          node.port.postMessage('flush')
        }),
      close: () => {
        if (closed) return
        closed = true
        node.port.onmessage = null
        try {
          source.disconnect()
          node.disconnect()
          mute.disconnect()
        } catch {
          // already disconnected
        }
        for (const t of stream.getTracks()) t.stop()
        void audioCtx.close().catch(() => {})
      },
    }
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    void ctx?.close().catch(() => {})
    throw err
  }
}
