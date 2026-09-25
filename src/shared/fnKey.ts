// The fn (🌐) key relay between the main process and a renderer (voice input,
// macOS). Main side: src/main/fn-key-helper.ts; renderer: voice/voiceWiring.ts.

export type FnKeyEventType = 'down' | 'up' | 'chord'

/** What the Settings row shows. */
export type FnKeyPhase =
  | 'off' // nobody subscribed
  | 'starting'
  | 'ready'
  | 'no-permission' // Input Monitoring not granted; waits for a retry
  | 'restarting' // crashed; respawning after a backoff
  | 'failed' // crashed too often, or the helper binary is missing
  | 'unsupported' // not macOS

export interface FnKeyStatus {
  phase: FnKeyPhase
  /** The "Press 🌐 key to" setting: 0 = Do Nothing, -1 = unknown, null = not read yet. */
  fnUsage: number | null
}

export const FN_KEY_EVENT_CHANNEL = 'voice:fn-key-event'
export const FN_KEY_STATUS_CHANNEL = 'voice:fn-key-status'

export interface FnKeyApi {
  /** Start receiving fn events (spawns the helper for the first subscriber). */
  subscribe: () => Promise<FnKeyStatus>
  unsubscribe: () => Promise<void>
  status: () => Promise<FnKeyStatus>
  requestPermission: () => Promise<FnKeyStatus>
  openSettings: (which: 'input-monitoring' | 'keyboard') => Promise<{ ok: boolean }>
  onEvent: (handler: (e: { type: FnKeyEventType }) => void) => () => void
  onStatus: (handler: (s: FnKeyStatus) => void) => () => void
}
