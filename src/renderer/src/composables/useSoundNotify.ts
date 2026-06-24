/**
 * Synthesized notification sounds via Web Audio API.
 * No audio files needed — tones are generated at runtime.
 *
 * "done"      – ascending two-note chime (C5 → E5): signals task completion.
 * "attention" – double A5 ping: signals CLI is waiting for user input.
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  // AudioContext may be suspended until a user gesture on some browsers.
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function playTone(
  freq: number,
  startTime: number,
  duration: number,
  gainPeak: number,
  audioCtx: AudioContext
): void {
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.connect(gain)
  gain.connect(audioCtx.destination)
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

/** Pleasant ascending chime — plays when a CLI pane finishes its turn. */
export function playDoneSound(): void {
  try {
    const c = getCtx()
    const now = c.currentTime
    playTone(523.25, now, 0.28, 0.28, c)        // C5
    playTone(659.25, now + 0.2, 0.38, 0.22, c)  // E5
  } catch {
    // Web Audio not available or blocked — silently skip.
  }
}

/** Double ping — plays when the CLI needs user attention/input. */
export function playAttentionSound(): void {
  try {
    const c = getCtx()
    const now = c.currentTime
    playTone(880, now, 0.15, 0.32, c)           // A5
    playTone(880, now + 0.22, 0.15, 0.32, c)    // A5 (repeat)
  } catch {
    // Web Audio not available or blocked — silently skip.
  }
}
