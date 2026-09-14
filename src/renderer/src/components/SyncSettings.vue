<script setup lang="ts">
/**
 * Cross-device sync for the four INTEGRATIONS sections.
 *
 * Deliberately one list rather than a switch inside each section's own pane:
 * "what leaves this machine" is a question people ask once, about everything,
 * and answering it in four places is how a switch gets missed.
 *
 * Three states share this surface and must stay distinguishable — off (the
 * default), on but not connected, and on with an unresolved conflict. A pane
 * that collapses them into one is a pane that makes someone re-enter a
 * credential that was never wrong.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import SettingRow from './settings/SettingRow.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingsSection from './settings/SettingsSection.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'

type Backend = ReturnType<typeof useBackend>

interface Conflict {
  scope: string
  itemId: string
  local: unknown
  remote: unknown
  remoteRev: number
  remoteDevice: string
  seenAt: number
}

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const available = ref<string[]>([])
const scopes = ref<Record<string, boolean>>({})
const hasKey = ref(false)
const linkState = ref('')
const conflicts = ref<Conflict[]>([])
const busy = ref('')
const error = ref('')

/** Scopes whose adapter is not shipped yet still list, but cannot be turned on.
 *  Skill *content* is a later phase; what ships here is the decision layer. */
const READY: ReadonlySet<string> = new Set(['prompts', 'mcp', 'skills', 'memory'])

const connected = computed(() => linkState.value === 'connected')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toScopes(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Boolean(v)]))
}

async function load(): Promise<void> {
  error.value = ''
  try {
    const resp = await props.backend.send<{
      available?: unknown
      scopes?: unknown
      hasKey?: unknown
      link?: unknown
    }>('sync.status', {})
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    const payload = resp.payload
    available.value = Array.isArray(payload?.available) ? payload.available.map(String) : []
    scopes.value = toScopes(payload?.scopes)
    hasKey.value = Boolean(payload?.hasKey)
    linkState.value = isRecord(payload?.link) ? String(payload.link.state ?? '') : ''
    await loadConflicts()
  } catch (err) {
    error.value = String(err)
  }
}

async function loadConflicts(): Promise<void> {
  const resp = await props.backend.send<{ conflicts?: unknown }>('sync.conflicts', {})
  const rows = resp.ok ? resp.payload?.conflicts : null
  conflicts.value = Array.isArray(rows) ? (rows as Conflict[]) : []
}

async function setScope(scope: string, enabled: boolean): Promise<void> {
  busy.value = scope
  error.value = ''
  try {
    const resp = await props.backend.send<{ scopes?: unknown }>('sync.set_scope', {
      scope,
      enabled,
    })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    scopes.value = toScopes(resp.payload?.scopes)
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function syncNow(): Promise<void> {
  busy.value = 'all'
  error.value = ''
  try {
    const resp = await props.backend.send('sync.now', {})
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    await loadConflicts()
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function resolve(conflict: Conflict, keep: 'local' | 'remote'): Promise<void> {
  busy.value = `${conflict.scope}/${conflict.itemId}`
  error.value = ''
  try {
    const resp = await props.backend.send<{ conflicts?: unknown }>('sync.resolve', {
      scope: conflict.scope,
      itemId: conflict.itemId,
      keep,
    })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    const rows = resp.payload?.conflicts
    if (Array.isArray(rows)) conflicts.value = rows as Conflict[]
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return t('settings.sync.deleted')
  const text = JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

onMounted(load)
</script>

<template>
  <SettingsSection :label="t('settings.sync.title')">
    <SettingsCard>
      <SettingRow
        v-for="scope in available"
        :key="scope"
        :title="t('settings.sync.scope-' + scope)"
        :description="
          READY.has(scope) ? t('settings.sync.scope-hint-' + scope) : t('settings.sync.not-yet')
        "
      >
        <template #control>
          <ToggleSwitch
            :model-value="Boolean(scopes[scope])"
            :disabled="busy === scope || !READY.has(scope)"
            :aria-label="t('settings.sync.scope-' + scope)"
            @update:model-value="(v: boolean) => setScope(scope, v)"
          />
        </template>
      </SettingRow>
    </SettingsCard>

    <p class="sync-hint">{{ t('settings.sync.hint') }}</p>

    <!-- The three states kept apart: off is the absence of a toggle, so only
         the other two need saying out loud. -->
    <p v-if="!connected" class="sync-note">{{ t('settings.sync.not-connected') }}</p>
    <p v-else-if="!hasKey" class="sync-note">{{ t('settings.sync.no-key') }}</p>

    <div class="sync-actions">
      <button type="button" :disabled="busy === 'all' || !connected" @click="syncNow">
        {{ t('settings.sync.now') }}
      </button>
    </div>

    <div v-if="conflicts.length" class="sync-conflicts">
      <h3>{{ t('settings.sync.conflicts-title', { count: conflicts.length }) }}</h3>
      <p class="sync-hint">{{ t('settings.sync.conflicts-hint') }}</p>
      <div v-for="c in conflicts" :key="c.scope + '/' + c.itemId" class="sync-conflict">
        <div class="sync-conflict-head">
          <strong>{{ t('settings.sync.scope-' + c.scope) }}</strong>
          <code>{{ c.itemId }}</code>
        </div>
        <div class="sync-conflict-side">
          <span class="sync-side-label">{{ t('settings.sync.this-device') }}</span>
          <code class="sync-side-body">{{ preview(c.local) }}</code>
          <button
            type="button"
            :disabled="busy === c.scope + '/' + c.itemId"
            @click="resolve(c, 'local')"
          >
            {{ t('settings.sync.keep-this') }}
          </button>
        </div>
        <div class="sync-conflict-side">
          <span class="sync-side-label">{{ c.remoteDevice || t('settings.sync.other-device') }}</span>
          <code class="sync-side-body">{{ preview(c.remote) }}</code>
          <button
            type="button"
            :disabled="busy === c.scope + '/' + c.itemId"
            @click="resolve(c, 'remote')"
          >
            {{ t('settings.sync.keep-other') }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="err-msg">{{ error }}</p>
  </SettingsSection>
</template>

<style scoped>
.sync-hint {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 8px 0 0;
}
.sync-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 6px 0 0;
}
.sync-actions {
  margin-top: 10px;
}
.sync-conflicts {
  margin-top: 16px;
}
.sync-conflicts h3 {
  font-size: var(--font-row-title);
  font-weight: 600;
  margin: 0 0 4px;
}
.sync-conflict {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  padding: 10px 12px;
  margin-top: 10px;
  background: var(--bg-subtle);
}
.sync-conflict-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 6px;
}
.sync-conflict-side {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  min-width: 0;
}
.sync-side-label {
  flex: none;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  min-width: 7em;
}
.sync-side-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err-msg {
  color: var(--text-danger, #e07060);
  font-size: var(--font-row-desc);
  margin-top: 8px;
}
</style>
