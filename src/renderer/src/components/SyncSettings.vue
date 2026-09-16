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
  /** True for a scope whose payloads never reach the renderer: `local` and
   *  `remote` are then metadata (or a placeholder), not the item. */
  sealed?: boolean
}

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const available = ref<string[]>([])
const scopes = ref<Record<string, boolean>>({})
const hasKey = ref(false)
const keyId = ref('')
const legacyRingPending = ref(false)
const rotateArmed = ref(false)
const linkState = ref('')
const conflicts = ref<Conflict[]>([])
const busy = ref('')
const error = ref('')

/** Scopes whose adapter is not shipped yet still list, but cannot be turned on.
 *  Skill *content* is a later phase; what ships here is the decision layer. */
const READY: ReadonlySet<string> = new Set(['prompts', 'mcp', 'skills', 'memory', 'credentials'])

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
      keyId?: unknown
      legacyRingPending?: unknown
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
    keyId.value = typeof payload?.keyId === 'string' ? payload.keyId : ''
    legacyRingPending.value = Boolean(payload?.legacyRingPending)
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

/** Adopt the sync key from before accounts were bound as this account's.
 *  Explicit and once: the backend cannot tell whose it was, and minting a
 *  fresh key instead would leave everything that key wrote unreadable. */
async function adoptLegacyKey(): Promise<void> {
  busy.value = 'key'
  error.value = ''
  try {
    const resp = await props.backend.send('sync.adopt_legacy_key', {}, 30_000)
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    await load()
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

/** Retire the active key: every record is re-sealed under a new one on the
 *  next rounds; paired devices receive the new key over the paired channel.
 *  Two clicks, because this is the stop-the-bleeding move and not a refresh. */
async function rotateKey(): Promise<void> {
  if (!rotateArmed.value) {
    rotateArmed.value = true
    return
  }
  rotateArmed.value = false
  busy.value = 'key'
  error.value = ''
  try {
    const resp = await props.backend.send<{ keyId?: unknown }>('sync.rotate_key', {}, 60_000)
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    await load()
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

function preview(value: unknown, sealed = false): string {
  if (value === null || value === undefined) return t('settings.sync.deleted')
  if (sealed) {
    // The backend already redacted this half; what is left is which slot it
    // is, and that is all a person needs to pick a side.
    if (isRecord(value) && typeof value.agentKey === 'string' && typeof value.slotId === 'string') {
      return `${value.agentKey} / ${value.slotId}`
    }
    return t('settings.sync.sealed')
  }
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

    <!-- The account key: which one is active (by id, never the key), the
         one-time adoption of a key from before accounts were bound, and
         rotation. -->
    <div v-if="connected" class="sync-key">
      <p v-if="legacyRingPending && !hasKey" class="sync-note sync-key-legacy">
        {{ t('settings.sync.legacy-key') }}
        <button type="button" :disabled="busy === 'key'" @click="adoptLegacyKey">
          {{ t('settings.sync.legacy-key-adopt') }}
        </button>
      </p>
      <p v-if="hasKey" class="sync-note sync-key-row">
        <span>{{ t('settings.sync.key-id', { id: keyId.slice(0, 8) || '—' }) }}</span>
        <button type="button" :disabled="busy === 'key'" @click="rotateKey">
          {{ rotateArmed ? t('settings.sync.rotate-confirm') : t('settings.sync.rotate') }}
        </button>
        <button v-if="rotateArmed" type="button" @click="rotateArmed = false">
          {{ t('settings.sync.rotate-cancel') }}
        </button>
      </p>
      <p v-if="hasKey" class="sync-hint">{{ t('settings.sync.rotate-hint') }}</p>
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
          <code class="sync-side-body">{{ preview(c.local, c.sealed) }}</code>
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
          <code class="sync-side-body">{{ preview(c.remote, c.sealed) }}</code>
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
.sync-key {
  margin-top: 12px;
}
.sync-key-row,
.sync-key-legacy {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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
