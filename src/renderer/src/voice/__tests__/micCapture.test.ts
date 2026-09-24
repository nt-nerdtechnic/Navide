// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openMicCapture } from '../micCapture'

function domError(name: string): Error {
  const err = new Error(name)
  err.name = name
  return err
}

describe('openMicCapture device choice', () => {
  let getUserMedia: ReturnType<typeof vi.fn>
  const stop = vi.fn()

  beforeEach(() => {
    stop.mockReset()
    getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
    vi.stubGlobal(
      'AudioContext',
      class {
        audioWorklet = { addModule: async () => {} }
        destination = {}
        createMediaStreamSource = node
        createGain = () => ({ ...node(), gain: { value: 1 } })
        close = async () => {}
      },
    )
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = { onmessage: null, postMessage: vi.fn() }
        connect = vi.fn()
        disconnect = vi.fn()
      },
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worklet')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const audioOf = (call: number) => (getUserMedia.mock.calls[call][0] as { audio: Record<string, unknown> }).audio

  it('asks for no deviceId when the choice is the system default', async () => {
    const cap = await openMicCapture(() => {})
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(audioOf(0)).not.toHaveProperty('deviceId')
    expect(audioOf(0)).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    cap.close()
  })

  it('asks for exactly the chosen device', async () => {
    const cap = await openMicCapture(() => {}, 'mic-1')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(audioOf(0)).toMatchObject({
      deviceId: { exact: 'mic-1' },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
    cap.close()
  })

  it.each(['OverconstrainedError', 'NotFoundError'])('falls back to the system default once on %s', async (name) => {
    getUserMedia.mockRejectedValueOnce(domError(name))
    const cap = await openMicCapture(() => {}, 'gone')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(audioOf(0)).toMatchObject({ deviceId: { exact: 'gone' } })
    expect(audioOf(1)).not.toHaveProperty('deviceId')
    cap.close()
  })

  it('does not retry a second failure', async () => {
    getUserMedia.mockRejectedValue(domError('NotFoundError'))
    await expect(openMicCapture(() => {}, 'gone')).rejects.toThrow('NotFoundError')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('rethrows a denied permission without retrying', async () => {
    getUserMedia.mockRejectedValue(domError('NotAllowedError'))
    await expect(openMicCapture(() => {}, 'mic-1')).rejects.toThrow('NotAllowedError')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('does not retry the system default itself', async () => {
    getUserMedia.mockRejectedValue(domError('NotFoundError'))
    await expect(openMicCapture(() => {})).rejects.toThrow('NotFoundError')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('reports the device going away, but not its own close', async () => {
    const track: { stop: () => void; onended: (() => void) | null } = { stop, onended: null }
    getUserMedia.mockResolvedValue({ getTracks: () => [track] })
    const onEnded = vi.fn()
    const cap = await openMicCapture(() => {}, '', onEnded)
    track.onended?.()
    expect(onEnded).toHaveBeenCalledTimes(1)
    cap.close()
    track.onended?.()
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('flags a capture that fell back to the system default', async () => {
    const chosen = await openMicCapture(() => {}, 'mic-1')
    expect(chosen.fellBack).toBe(false)
    getUserMedia.mockRejectedValueOnce(domError('NotFoundError'))
    const fallback = await openMicCapture(() => {}, 'mic-1')
    expect(fallback.fellBack).toBe(true)
  })
})
