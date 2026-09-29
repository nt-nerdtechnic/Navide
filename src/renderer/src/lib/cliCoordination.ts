import { parseEventMs, turnTextFingerprint } from './completion'
import type { EchoEvidence } from './injectEcho'

/** Retry only an injection that left the composer empty. A failed submit with
 * an observed echo must never append a second copy of the kickoff. */
export async function runPipelineKickoff(input: {
  inject: () => Promise<{ injected: boolean; echo?: EchoEvidence | null }>
  sleep: (ms: number) => Promise<void>
  paneAlive: () => boolean
  onHeld?: () => void
  onRetry?: (attempt: number) => void
}): Promise<{ sent: boolean; cancelled: boolean }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await input.inject()
    if (result.injected) return { sent: true, cancelled: false }
    if (result.echo != null) {
      input.onHeld?.()
      break
    }
    if (attempt < 3) {
      input.onRetry?.(attempt)
      await input.sleep(3000)
      if (!input.paneAlive()) return { sent: false, cancelled: true }
    }
  }
  return { sent: false, cancelled: false }
}

/** Hook and transcript watcher can report the same turn. Record acceptance
 * synchronously, before a caller dispatches messages and can be reentered. */
export function createTurnTextGate() {
  const timestamps = new Map<string, number>()
  const fingerprints = new Map<string, string>()
  return {
    accept(paneId: string, text: string, timestamp: string): boolean {
      const eventMs = parseEventMs(timestamp)
      if (!Number.isNaN(eventMs)) {
        if (eventMs <= (timestamps.get(paneId) ?? 0)) return false
        timestamps.set(paneId, eventMs)
      } else {
        const fingerprint = turnTextFingerprint(text)
        if (fingerprint === fingerprints.get(paneId)) return false
        fingerprints.set(paneId, fingerprint)
      }
      return true
    },
    delete(paneId: string): void {
      timestamps.delete(paneId)
      fingerprints.delete(paneId)
    },
  }
}

/** A missing manual-pane record is normally a transient spawn race. Retrying
 * on later activity is bounded so a permanent miss cannot flood the backend.
 * Undefined means the caller could not attempt a write (e.g. missing stage). */
export function createPaneSessionPersistence() {
  const persisted = new Set<string>()
  const attempts = new Map<string, number>()
  return async (key: string, write: () => Promise<boolean | undefined>): Promise<void> => {
    if (persisted.has(key)) return
    const saved = await write()
    if (saved === undefined) return
    if (saved) {
      persisted.add(key)
      attempts.delete(key)
    } else {
      const count = (attempts.get(key) ?? 0) + 1
      attempts.set(key, count)
      if (count >= 8) persisted.add(key)
    }
  }
}
