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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
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
  /** The cloud never held this item (a rev-0 synthetic tombstone): keeping
   *  "theirs" would only delete the local copy, and the backend refuses it. */
  remoteAbsent?: boolean
}

/** One scope's outcome of a sync round, as sync.now returns it. */
interface ScopeResult {
  scope: string
  ok?: boolean
  error?: string
  skipped?: string
  pulled?: number
  pushed?: number
  conflicts?: number
  held?: string[]
  refused?: string[]
  tooLarge?: string[]
  /** ISO-8601 UTC. */
  at?: string
}

interface ResultLine {
  text: string
  error?: boolean
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
/** Whose cloud these sections go to, when the backend says. */
const accountEmail = ref('')
const conflicts = ref<Conflict[]>([])
const busy = ref('')
const error = ref('')
/** The latest outcome per scope ('all' when the round never reached one). */
const results = ref<Record<string, ScopeResult>>({})

/** Scopes whose adapter is not shipped yet still list, but cannot be turned on.
 *  Skill *content* is a later phase; what ships here is the decision layer.
 *
 *  'credentials' is held out of this set for v0.2.4: its adapter is complete
 *  and tested, but its review is not, and it is the one scope that puts a CLI
 *  credential on the wire. Leaving it off the list is the whole gate — the
 *  Accounts pane reads the cloud side only when `scopes.credentials` is on
 *  (useCliProfiles.refreshCloud), so with no way to switch it on, nothing
 *  downstream can reach a credential either. Put it back once the review
 *  lands. */
const READY: ReadonlySet<string> = new Set(['prompts', 'mcp', 'skills', 'memory'])

const connected = computed(() => linkState.value === 'connected')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const SKIP_REASONS: ReadonlySet<string> = new Set(['not-connected', 'no-key', 'unsupported'])

function itemIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function toResult(value: unknown): ScopeResult | null {
  if (!isRecord(value) || typeof value.scope !== 'string' || !value.scope) return null
  return {
    scope: value.scope,
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    error: typeof value.error === 'string' && value.error ? value.error : undefined,
    skipped: typeof value.skipped === 'string' && value.skipped ? value.skipped : undefined,
    pulled: Number(value.pulled ?? 0) || 0,
    pushed: Number(value.pushed ?? 0) || 0,
    conflicts: Number(value.conflicts ?? 0) || 0,
    held: itemIds(value.held),
    refused: itemIds(value.refused),
    tooLarge: itemIds(value.tooLarge),
    at: typeof value.at === 'string' ? value.at : undefined,
  }
}

/** Record one scope's outcome. A switched-off scope's "skipped" is dropped
 *  rather than shown: off is the default, not something to report. */
function noteResult(value: unknown): void {
  const result = toResult(value)
  if (!result) return
  const next = { ...results.value }
  if (result.skipped === 'disabled') delete next[result.scope]
  else next[result.scope] = result
  results.value = next
}

function resultLines(r: ScopeResult): ResultLine[] {
  if (r.error) return [{ text: t('settings.sync.result-error', { error: r.error }), error: true }]
  if (r.skipped) {
    return [
      {
        text: SKIP_REASONS.has(r.skipped)
          ? t('settings.sync.skipped-' + r.skipped)
          : t('settings.sync.skipped-other', { reason: r.skipped }),
      },
    ]
  }
  const lines: ResultLine[] = [
    { text: t('settings.sync.result-ok', { pulled: r.pulled ?? 0, pushed: r.pushed ?? 0 }) },
  ]
  if (r.conflicts) lines.push({ text: t('settings.sync.result-conflicts', { count: r.conflicts }) })
  if (r.held?.length) lines.push({ text: t('settings.sync.result-held', { items: r.held.join(', ') }) })
  if (r.refused?.length) {
    lines.push({ text: t('settings.sync.result-refused', { items: r.refused.join(', ') }), error: true })
  }
  if (r.tooLarge?.length) {
    lines.push({ text: t('settings.sync.result-too-large', { items: r.tooLarge.join(', ') }), error: true })
  }
  return lines
}

/** Results in the order the scopes are listed, the catch-all row first. */
const resultRows = computed(() => {
  const order = ['all', ...available.value, 'skill-files']
  return Object.values(results.value).sort(
    (a, b) => (order.indexOf(a.scope) + 1 || 999) - (order.indexOf(b.scope) + 1 || 999),
  )
})

function scopeLabel(scope: string): string {
  return t('settings.sync.scope-' + scope)
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
      last?: unknown
      account?: unknown
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
    const email = isRecord(payload?.account) ? payload.account.email : undefined
    accountEmail.value = typeof email === 'string' ? email : ''
    if (isRecord(payload?.last)) {
      // The backend keeps the last outcome per scope; it is the whole truth.
      results.value = {}
      for (const [scope, last] of Object.entries(payload.last)) {
        if (isRecord(last)) noteResult({ scope, ...last })
      }
    }
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

/** A scope outside READY may still be on (left on by an older build). Its
 *  switch then only goes one way: off is always allowed, on never is. */
function canToggle(scope: string): boolean {
  return READY.has(scope) || Boolean(scopes.value[scope])
}

async function setScope(scope: string, enabled: boolean): Promise<void> {
  if (enabled && !READY.has(scope)) return
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
    const resp = await props.backend.send<{ results?: unknown }>('sync.now', {})
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    else if (Array.isArray(resp.payload?.results)) resp.payload.results.forEach(noteResult)
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

/** MCP keys whose values are secrets (tokens, auth headers). */
const MCP_SECRET_FIELDS = ['env', 'headers']

const MASK = '••••'
/** A flag or variable name that announces a secret value. */
const SECRET_NAME = /token|key|secret|password|passwd|auth|bearer/i

/** Userinfo and every query value go; scheme, host, path and keys stay. */
function maskUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i, `$1${MASK}@`)
    .replace(/([?&][^=&#]*=)[^&#]*/g, `$1${MASK}`)
}

/** Secret flags (`--api-key v`, `--token=v`), `KEY=value` with a secret name,
 *  and Bearer tokens; every other argument stays readable. */
function maskArgs(args: unknown[]): unknown[] {
  let maskNext = false
  return args.map((arg) => {
    if (typeof arg !== 'string') return arg
    if (maskNext) {
      maskNext = false
      return MASK
    }
    if (/^bearer\s/i.test(arg)) return `${arg.split(/\s/)[0]} ${MASK}`
    const eq = arg.indexOf('=')
    if (eq > 0) return SECRET_NAME.test(arg.slice(0, eq)) ? `${arg.slice(0, eq + 1)}${MASK}` : arg
    if (/^-/.test(arg) && SECRET_NAME.test(arg)) maskNext = true
    return arg
  })
}

/** One side of a conflict as it may be shown: an MCP record keeps the names
 *  in env and headers, so a person can tell the two apart, but not the values;
 *  its url and args lose their secret parts the same way. */
function shown(scope: string, value: unknown): unknown {
  if (scope !== 'mcp' || !isRecord(value)) return value
  const out: Record<string, unknown> = { ...value }
  if (typeof out.url === 'string') out.url = maskUrl(out.url)
  if (Array.isArray(out.args)) out.args = maskArgs(out.args)
  for (const field of MCP_SECRET_FIELDS) {
    const entries = out[field]
    if (isRecord(entries)) {
      out[field] = Object.fromEntries(Object.keys(entries).map((k) => [k, MASK]))
    }
  }
  return out
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

/** The whole value behind a preview cut at 160 characters, for its hover. */
function previewFull(value: unknown, sealed = false): string | undefined {
  return sealed || value === null || value === undefined ? undefined : JSON.stringify(value)
}

/** A round the backend ran on its own (after a local save, on reconnect)
 *  reports here, so the pane does not wait to be reopened. */
function onSyncResult(payload: unknown): void {
  noteResult(payload)
  void loadConflicts().catch((err) => {
    error.value = String(err)
  })
}

let offResult: (() => void) | undefined

onMounted(() => {
  offResult = props.backend.on('sync.result', onSyncResult)
  void load()
})

onBeforeUnmount(() => offResult?.())
</script>

<template>
  <SettingsSection :label="t('settings.sync.title')">
    <p v-if="accountEmail" class="sync-account">
      {{ t('settings.sync.account', { email: accountEmail }) }}
    </p>
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
            :disabled="busy === scope || !canToggle(scope)"
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

    <ul v-if="resultRows.length" class="sync-results">
      <li v-for="r in resultRows" :key="r.scope" class="sync-result">
        <strong>{{ scopeLabel(r.scope) }}</strong>
        <span
          v-for="(line, i) in resultLines(r)"
          :key="i"
          :class="['sync-result-line', { 'sync-result-error': line.error }]"
          >{{ line.text }}</span
        >
      </li>
    </ul>

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
          <code class="sync-side-body" v-truncate="previewFull(shown(c.scope, c.local), c.sealed)">{{ preview(shown(c.scope, c.local), c.sealed) }}</code>
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
          <code class="sync-side-body" v-truncate="previewFull(shown(c.scope, c.remote), c.sealed)">{{ preview(shown(c.scope, c.remote), c.sealed) }}</code>
          <button
            v-if="!c.remoteAbsent"
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
.sync-account {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.sync-actions {
  margin-top: 10px;
}
.sync-results {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sync-result {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 2px 0;
  min-width: 0;
}
.sync-result strong {
  color: var(--text-primary);
  font-weight: 600;
}
.sync-result-line {
  overflow-wrap: anywhere;
}
.sync-result-error {
  color: var(--text-danger, #e07060);
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
