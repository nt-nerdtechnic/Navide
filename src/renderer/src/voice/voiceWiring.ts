import { watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { registerCommand, setContext } from '@navide/plugin-ui/shared'
import { NOTICE_SENDER, type useAgentMessaging } from '../composables/useAgentMessaging'
import type { useBackend } from '../composables/useBackend'
import { useVoiceInput, type VoiceDeps, type VoiceTarget } from '../composables/useVoiceInput'
import { speakWithSynthesis, useVoiceReadback } from '../composables/useVoiceReadback'
import { openMicCapture } from './micCapture'
import { useVoiceSettings } from './voiceSettings'

/** What the main window must hand over to wire voice input. */
export interface VoiceWiringHost {
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
  messaging: Pick<
    ReturnType<typeof useAgentMessaging>,
    'sendMessage' | 'messages' | 'cancelMessage' | 'pump' | 'paneIdOf'
  >
  /** The focused CLI pane right now, if any. */
  focusedPaneId: () => string | null
  /** A pane's messaging handle and whether a CLI is running behind it. */
  paneInfo: (paneId: string) => { realized: boolean; messagingName?: string } | undefined
  /** Display name for the readback fallback line. */
  paneLabel: (paneId: string) => string
}

/**
 * Voice input for the main window: hotkey, capture, delivery and readback.
 *
 * Delivery is a bare-text system message on the ordinary messaging queue —
 * the same path, gates and verbatim injection a Navide `notice` takes (idle
 * gate, typing hold, echo verification) — so the transcript is typed into the
 * pane exactly as the user would have typed it, with no envelope.
 *
 * With the setting off: the `voiceInput` context is false, so the hotkey rule
 * never matches and the chord reaches the PTY as before; the command handler
 * declines; no key listener is installed; nothing talks to the backend.
 */
export function setupVoiceInput(host: VoiceWiringHost) {
  const settings = useVoiceSettings()

  const readback = useVoiceReadback({
    enabled: () => settings.voiceReadbackEnabled.value,
    speak: (text) => speakWithSynthesis(text, String(i18n.global.locale.value)),
    doneLine: (paneId) => i18n.global.t('voice.readback.done', { name: host.paneLabel(paneId) }),
  })

  const deps: VoiceDeps = {
    enabled: () => settings.voiceInputEnabled.value,
    request: async (type, payload, timeoutMs) => {
      const res = await host.backend.send(type, payload, timeoutMs)
      return { ok: res.ok, payload: res.payload as never }
    },
    askMicrophone: async () => {
      const media = window.agentTeam?.media
      if (!media) return true
      return (await media.askMicrophone()).granted
    },
    openCapture: openMicCapture,
    resolveTarget: (paneId): VoiceTarget => {
      const pane = host.paneInfo(paneId)
      if (!pane || !pane.messagingName) return { ok: false, reason: 'not-cli' }
      // An idle-reclaimed or cold-restored placeholder has no CLI to type into.
      // Refused rather than woken: realizing takes tens of seconds and may ask
      // which session to resume — not something to start from a key press.
      if (!pane.realized) return { ok: false, reason: 'asleep' }
      if (host.messaging.paneIdOf(pane.messagingName) !== paneId) return { ok: false, reason: 'not-cli' }
      return { ok: true, name: pane.messagingName }
    },
    deliver: (name, text) => {
      const msg = host.messaging.sendMessage(NOTICE_SENDER, name, text, { kind: 'notice' })
      host.messaging.pump()
      return msg.id
    },
    messageView: (id) => host.messaging.messages.value.find((m) => m.id === id),
    cancelMessage: (id) => host.messaging.cancelMessage(id),
    onDelivered: (paneId) => readback.noteVoiceDelivered(paneId),
  }
  const voice = useVoiceInput(deps)

  // ── Hold detection ──────────────────────────────────────────────────────────
  // The key resolver only sees keydown. The take ends on the first keyup after
  // the press — letting go of any key of the chord — or when the window loses
  // focus (a keyup that happens elsewhere never arrives here).
  let holding = false
  function onKeyUp(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopImmediatePropagation()
    endHold()
  }
  function endHold(): void {
    if (!holding) return
    holding = false
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', endHold)
    voice.release()
  }

  registerCommand('workbench.action.holdToTalk', () => {
    if (!settings.voiceInputEnabled.value) return false
    if (holding) return true // key repeat
    const consumed = voice.press(host.focusedPaneId())
    if (!consumed) return false
    if (voice.state.phase === 'starting' || voice.state.phase === 'recording') {
      holding = true
      window.addEventListener('keyup', onKeyUp, true)
      window.addEventListener('blur', endHold)
    }
    return true
  })

  // ── Esc during a take ───────────────────────────────────────────────────────
  // Listened for only in the short-lived phases (see useVoiceInput.cancel). A
  // held or failed capsule leaves Esc to the CLI — it is how a busy pane is
  // interrupted — and offers its own buttons instead.
  function onEsc(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.isComposing) return
    if (!voice.cancel()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    endHold()
  }
  const ESC_PHASES = new Set(['starting', 'recording', 'transcribing', 'countdown', 'delivering'])
  watch(
    () => ESC_PHASES.has(voice.state.phase),
    (owned) => {
      if (owned) window.addEventListener('keydown', onEsc, true)
      else window.removeEventListener('keydown', onEsc, true)
    },
  )

  watch(
    settings.voiceInputEnabled,
    (on) => {
      setContext('voiceInput', on)
      if (!on) {
        endHold()
        voice.disable()
      }
    },
    { immediate: true },
  )

  return {
    state: voice.state,
    withdraw: voice.withdraw,
    dismiss: voice.dismiss,
    /** Feed every turn_complete here; only voice-driven panes are read out. */
    onTurnComplete: readback.onTurnComplete,
  }
}
