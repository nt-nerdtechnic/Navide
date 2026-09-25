<script setup lang="ts">
// Settings → Voice Input → Shortcut. The dictation key, editable where people
// look for it. It edits the same user rules as Settings → Shortcuts
// (buildRows / setRowKeys / resetRow over getUserRules / saveUserRules), so
// both views always show one binding.
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildRows,
  commandI18nKey,
  conflictsByRow,
  getUserRules,
  keySpecToTokens,
  formatKeySpec,
  onUserRulesChanged,
  resetRow,
  saveUserRules,
  setRowKeys,
  validateKeySpec,
  type BindingRow,
  type KeybindingRule,
} from '@navide/plugin-ui/shared'
import SettingRow from './SettingRow.vue'
import { useKeyChordRecorder } from '../../composables/useKeyChordRecorder'
import { HOLD_TO_TALK_COMMAND } from '../../voice/voiceSettings'
import { holdToTalkKeyProblem } from '../../voice/holdToTalkKey'

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

// Hold-to-talk is held down, so it is one key combination, never a sequence;
// it may be a single modifier on its own (Right Option).
const recorder = useKeyChordRecorder({ maxSegments: 1, allowLoneModifier: true })

/** Why `spec` cannot be the dictation key (see holdToTalkKey.ts), or ''. */
function problemText(spec: string, mode: 'refused' | 'warning'): string {
  const problem = holdToTalkKeyProblem(spec)
  if (problem === 'meta') {
    return mode === 'refused' ? t('settings.voice.shortcut-meta-refused', { key: formatKeySpec(spec) }) : t('settings.voice.shortcut-meta-warning')
  }
  if (problem === 'meta-alone') return t('settings.voice.shortcut-meta-alone-refused', { key: formatKeySpec(spec) })
  if (problem === 'typing-key') return t('settings.voice.shortcut-typing-refused', { key: formatKeySpec(spec) })
  return ''
}

function labelFor(r: BindingRow): string {
  const key = commandI18nKey(r.command)
  return te(key) ? t(key) : r.label
}

const conflictNote = computed(() => {
  const r = row.value
  if (!r) return ''
  const rivals = (conflictsByRow(rows.value).get(r.id) ?? [])
    .flatMap((c) => c.rows)
    .filter((other) => other.id !== r.id)
  return rivals.length ? t('settings.voice.shortcut-conflict', { commands: [...new Set(rivals.map(labelFor))].join(', ') }) : ''
})

// A refused key can still arrive from keybindings.json or the Shortcuts tab.
const boundProblem = computed(() => row.value?.keys.map((k) => problemText(k.key, 'warning')).find(Boolean) ?? '')
const warning = computed(() => error.value || boundProblem.value)

async function commit(next: KeybindingRule[]): Promise<void> {
  userRules.value = next
  const result = await saveUserRules(next)
  if (!result.ok) error.value = `${t('settings.keybindings.save-failed')} — ${result.error ?? 'write failed'}`
}

function startRecording(): void {
  error.value = ''
  recorder.start()
}

async function save(): Promise<void> {
  const r = row.value
  const spec = recorder.spec.value
  recorder.stop()
  if (!r || !spec) return
  const refused = problemText(spec, 'refused')
  if (refused) {
    error.value = refused
    return
  }
  // setRowKeys drops a key validateKeySpec rejects; say why instead.
  if (!validateKeySpec(spec).ok) {
    error.value = t('settings.keybindings.invalid-key', { key: formatKeySpec(spec) })
    return
  }
  await commit(setRowKeys(userRules.value, r, [spec]))
}

async function reset(): Promise<void> {
  const r = row.value
  if (!r) return
  recorder.stop()
  error.value = ''
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
  <p v-if="warning" class="vs-message vs-message--warning" data-testid="voice-shortcut-warning">{{ warning }}</p>
  <p v-else-if="conflictNote" class="vs-message">{{ conflictNote }}</p>
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
.vs-open a { color: var(--accent-fg); }
</style>
