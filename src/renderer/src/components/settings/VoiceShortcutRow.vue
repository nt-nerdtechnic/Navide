<script setup lang="ts">
// Settings → Voice Input → Shortcut. The dictation key, editable where people
// look for it. It edits the same user rules as Settings → Shortcuts
// (buildRows / setRowKeys / resetRow over getUserRules / saveUserRules), so
// both views always show one binding.
//
// While it records it also takes fn (🌐) on macOS, through the native helper
// (useFnKeyRecorder), and every press gets an answer: recorded, or refused
// with the reason (KeyRecorderFeedback and the live check below).
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildRows,
  canonicalizeKeySpec,
  commandI18nKey,
  conflictsByRow,
  getUserRules,
  keySpecToTokens,
  formatKeySpec,
  FN_KEY,
  onUserRulesChanged,
  parseKeySpec,
  resetRow,
  saveUserRules,
  setRowKeys,
  validateKeySpec,
  type BindingRow,
  type KeybindingRule,
} from '@navide/plugin-ui/shared'
import SettingRow from './SettingRow.vue'
import KeyRecorderFeedback from './KeyRecorderFeedback.vue'
import { useKeyChordRecorder } from '../../composables/useKeyChordRecorder'
import { useFnKeyRecorder } from '../../voice/fnKeyRecorder'
import { HOLD_TO_TALK_COMMAND, useVoiceSettings } from '../../voice/voiceSettings'
import { holdToTalkKeyProblem, reservedChordAction, suggestHoldToTalkKeys } from '../../voice/holdToTalkKey'

const emit = defineEmits<{ 'open-shortcuts': [command: string] }>()
const { t, te } = useI18n()

const userRules = ref<KeybindingRule[]>([...getUserRules()])
const stopWatching = onUserRulesChanged(() => {
  userRules.value = [...getUserRules()]
})
onUnmounted(stopWatching)

const rows = computed(() => buildRows(userRules.value))
const row = computed(() => rows.value.find((r) => r.command === HOLD_TO_TALK_COMMAND) ?? null)
const error = ref('')
// Free keys offered after a chord was refused.
const suggestions = ref<string[]>([])
// Keys are judged against the recording mode: a ⌘ chord is fine only in toggle.
const { voiceRecordingMode, voiceFnKeyEnabled, setVoiceFnKeyEnabled } = useVoiceSettings()
watch(voiceRecordingMode, () => {
  error.value = ''
  suggestions.value = []
})

// Hold-to-talk is held down, so it is one key combination, never a sequence;
// it may be a single modifier on its own (Right Option), or fn.
const recorder = useKeyChordRecorder({ maxSegments: 1, allowLoneModifier: true })
const fnRecorder = useFnKeyRecorder(() => recorder.recordKey(FN_KEY))
watch(recorder.active, (on) => {
  if (!on) fnRecorder.stop()
})

// The old "Use the fn (🌐) key" switch becomes what it meant: fn bound next to
// the current key. Done here, where the user's rules are long loaded, never at
// startup, where a save could overwrite a keybindings.json not read yet; until
// then voiceWiring counts the switch as fn bound.
onMounted(async () => {
  if (!voiceFnKeyEnabled.value) return
  const r = row.value
  if (r && !r.keys.some((k) => k.key === FN_KEY)) {
    await commit(setRowKeys(userRules.value, r, [...r.keys.map((k) => k.key), FN_KEY]))
    if (error.value) return
  }
  setVoiceFnKeyEnabled(false)
})

/** Why `spec` cannot be the dictation key in the current mode (see holdToTalkKey.ts), or ''. */
function problemText(spec: string, mode: 'refused' | 'warning'): string {
  const problem = holdToTalkKeyProblem(spec, voiceRecordingMode.value)
  const key = formatKeySpec(spec)
  if (problem === 'meta') {
    return mode === 'refused' ? t('settings.voice.shortcut-meta-refused', { key }) : t('settings.voice.shortcut-meta-warning')
  }
  if (problem === 'macos-reserved') {
    return t('settings.voice.shortcut-reserved-refused', { key, action: t(`settings.voice.reserved.${reservedChordAction(spec)}`) })
  }
  if (problem === 'menu') return t('settings.voice.shortcut-menu-refused', { key })
  if (problem === 'typing-key') return t('settings.voice.shortcut-typing-refused', { key })
  return ''
}

/** Every key the rule table binds right now, to any command. */
function takenKeys(): Set<string> {
  return new Set(rows.value.flatMap((r) => r.keys.map((k) => k.key)))
}

function labelFor(r: BindingRow): string {
  const key = commandI18nKey(r.command)
  return te(key) ? t(key) : r.label
}

/** The other commands sharing a key with the dictation row in `all`, by name. */
function rivalNames(all: BindingRow[], r: BindingRow): string[] {
  const rivals = (conflictsByRow(all).get(r.id) ?? [])
    .flatMap((c) => c.rows)
    .filter((other) => other.id !== r.id)
  return [...new Set(rivals.map(labelFor))]
}

const conflictNote = computed(() => {
  const r = row.value
  if (!r) return ''
  const names = rivalNames(rows.value, r)
  return names.length ? t('settings.voice.shortcut-conflict', { commands: names.join(', ') }) : ''
})

// A refused key can still arrive from keybindings.json or the Shortcuts tab,
// or become one when the recording mode changes (a ⌘ chord left behind by
// toggle mode): it is flagged, never changed behind the user's back.
const boundProblem = computed(() => row.value?.keys.map((k) => problemText(k.key, 'warning')).find(Boolean) ?? '')
const warning = computed(() => error.value || boundProblem.value)
// The bound key stopped working in this mode: offer the two ways out.
const boundMetaInHold = computed(
  () => !error.value && !!row.value?.keys.some((k) => holdToTalkKeyProblem(k.key, voiceRecordingMode.value) === 'meta'),
)

async function commit(next: KeybindingRule[]): Promise<void> {
  userRules.value = next
  const result = await saveUserRules(next)
  if (!result.ok) error.value = `${t('settings.keybindings.save-failed')} — ${result.error ?? 'write failed'}`
}

function startRecording(): void {
  error.value = ''
  suggestions.value = []
  recorder.start()
  fnRecorder.start()
}

// A refused key is answered the moment it is pressed, not on Save.
watch(recorder.spec, (spec) => {
  if (!recorder.active.value) return
  error.value = ''
  suggestions.value = []
  if (!spec) return
  const refused = refusal(spec)
  if (refused) refuse(spec, refused)
})

/** Why `spec` cannot be saved as the dictation key right now, or ''. */
function refusal(spec: string): string {
  const refused = problemText(spec, 'refused')
  if (refused) return refused
  if (!validateKeySpec(spec).ok) return t('settings.keybindings.invalid-key', { key: formatKeySpec(spec) })
  // A ⌘ chord (toggle mode) must not take a key another command already has:
  // most of them are Navide's own everyday shortcuts.
  const r = row.value
  if (r && parseKeySpec(spec).some((k) => k.meta)) {
    const next = setRowKeys(userRules.value, r, [spec])
    const nextRow = buildRows(next).find((x) => x.id === r.id)
    const names = nextRow ? rivalNames(buildRows(next), nextRow) : []
    if (names.length) return t('settings.voice.shortcut-taken-refused', { key: formatKeySpec(spec), commands: names.join(', ') })
  }
  return ''
}

function refuse(spec: string, message: string): void {
  error.value = message
  suggestions.value = suggestHoldToTalkKeys(spec, voiceRecordingMode.value, takenKeys())
}

async function save(): Promise<void> {
  const r = row.value
  const spec = recorder.spec.value
  recorder.stop()
  if (!r || !spec) return
  suggestions.value = []
  // setRowKeys drops a key validateKeySpec rejects; say why instead.
  const refused = refusal(spec)
  if (refused) {
    refuse(spec, refused)
    return
  }
  await commit(setRowKeys(userRules.value, r, [spec]))
}

async function useSuggestion(spec: string): Promise<void> {
  const r = row.value
  if (!r) return
  error.value = ''
  suggestions.value = []
  await commit(setRowKeys(userRules.value, r, [canonicalizeKeySpec(spec)]))
}

async function reset(): Promise<void> {
  const r = row.value
  if (!r) return
  recorder.stop()
  error.value = ''
  suggestions.value = []
  await commit(resetRow(userRules.value, r))
}
</script>

<template>
  <SettingRow
    data-settings-section="voice-shortcut"
    :title="t('settings.voice.shortcut')"
    :description="t('settings.voice.shortcut-hint')"
  >
    <template #control>
      <span v-if="recorder.active.value" class="vs-keys vs-recording">
        <template v-if="recorder.spec.value">
          <kbd v-for="(tok, i) in keySpecToTokens(recorder.spec.value)[0]" :key="i">{{ tok }}</kbd>
        </template>
        <em v-else>{{ t('settings.voice.shortcut-press') }}</em>
      </span>
      <span v-else-if="row && row.keys.length" class="vs-keys" data-testid="voice-shortcut-keys">
        <span v-for="chip in row.keys" :key="chip.key" class="vs-chip">
          <template v-for="(seg, si) in keySpecToTokens(chip.key)" :key="si">
            <span v-if="si" class="vs-sep">→</span>
            <kbd v-for="(tok, ti) in seg" :key="ti">{{ tok }}</kbd>
          </template>
        </span>
      </span>
      <span v-else class="vs-unbound">{{ t('settings.voice.shortcut-unbound') }}</span>

      <template v-if="recorder.active.value">
        <button type="button" class="vs-btn" :disabled="!recorder.spec.value" data-testid="voice-shortcut-save" @click="save">
          {{ t('settings.voice.shortcut-save') }}
        </button>
        <button type="button" class="vs-btn" @click="recorder.stop()">{{ t('settings.voice.shortcut-cancel') }}</button>
      </template>
      <button v-else type="button" class="vs-btn" data-testid="voice-shortcut-change" @click="startRecording">
        {{ t('settings.voice.shortcut-change') }}
      </button>
      <button
        v-if="row?.customized"
        type="button"
        class="vs-btn"
        data-testid="voice-shortcut-reset"
        @click="reset"
      >{{ t('settings.voice.shortcut-reset') }}</button>
    </template>
  </SettingRow>
  <KeyRecorderFeedback v-if="recorder.active.value" :notice="recorder.notice.value" :fn="fnRecorder" />
  <p v-if="warning" class="vs-message vs-message--warning" data-testid="voice-shortcut-warning">
    {{ warning }}
    <template v-if="boundMetaInHold">
      <button type="button" class="vs-btn" data-testid="voice-shortcut-warning-reset" @click="reset">{{ t('settings.voice.shortcut-reset') }}</button>
      <button type="button" class="vs-btn" data-testid="voice-shortcut-warning-rebind" @click="startRecording">{{ t('settings.voice.shortcut-rebind') }}</button>
    </template>
  </p>
  <p v-else-if="conflictNote" class="vs-message">{{ conflictNote }}</p>
  <p v-if="suggestions.length" class="vs-message" data-testid="voice-shortcut-suggestions">
    {{ t('settings.voice.shortcut-suggest') }}
    <button
      v-for="spec in suggestions"
      :key="spec"
      type="button"
      class="vs-btn vs-suggest"
      :data-suggest="spec"
      :title="t('settings.voice.shortcut-use', { key: formatKeySpec(spec) })"
      @click="useSuggestion(spec)"
    ><kbd v-for="(tok, i) in keySpecToTokens(spec)[0]" :key="i">{{ tok }}</kbd></button>
  </p>
  <p class="vs-open">
    <a href="#" data-testid="voice-shortcut-open" @click.prevent="emit('open-shortcuts', HOLD_TO_TALK_COMMAND)">
      {{ t('settings.voice.shortcut-open') }}
    </a>
  </p>
</template>

<style scoped>
.vs-keys {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 8px;
}
.vs-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.vs-keys kbd {
  font-family: inherit;
  font-size: var(--font-2xs);
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
}
.vs-recording em {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.vs-sep {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.vs-unbound {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  margin-right: 8px;
}
.vs-btn {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  margin-left: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.vs-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-emphasis); }
.vs-btn:disabled { opacity: 0.5; cursor: default; }
.vs-message,
.vs-open {
  margin: 0;
  padding: 0 var(--space-row-x) var(--space-row-y);
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.vs-message--warning { color: var(--warning-fg); }
.vs-suggest kbd {
  font-family: inherit;
  font-size: var(--font-2xs);
  padding: 0 4px;
}
.vs-open a { color: var(--accent-fg); }
</style>
