<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import type { useBackend } from '../../composables/useBackend'
import {
  CHANNEL_PLATFORMS,
  useChannels,
  type ChannelPlatform,
  type ChannelPlatformSpec,
  type ChannelPlatformState,
} from '../../composables/useChannels'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → Channels: connect chat platforms, watch their connection state,
 * approve pairing requests and manage who may talk to panes. Secrets go to the
 * backend once and are never shown again — a stored secret only shows as masked.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
}>()

const { t, te } = useI18n()
const store = useChannels(props.backend)

/** Short letter mark per platform: no brand images, theme tokens only. */
const MARKS: Record<ChannelPlatform, string> = {
  telegram: 'TG',
  discord: 'DC',
  slack: 'SL',
  feishu: 'FS',
  dingtalk: 'DT',
  matrix: 'MX',
  mattermost: 'MM',
  imessage: 'iM',
}

/** Platforms whose inbound connection (long polling / socket) takes messages
 *  away from any other program receiving for the same bot. */
const SINGLE_RECEIVER = new Set<ChannelPlatform>(['telegram', 'discord', 'slack', 'feishu', 'dingtalk'])

// Configured platforms first; otherwise the declared display order.
const specs = computed<ChannelPlatformSpec[]>(() => {
  const visible = CHANNEL_PLATFORMS.filter((s) => !s.macOnly || isMacPlatform())
  return [
    ...visible.filter((s) => stateOf(s.platform)?.configured),
    ...visible.filter((s) => !stateOf(s.platform)?.configured),
  ]
})

const expanded = ref<ChannelPlatform | null>(null)
const busy = ref(false)
const errorByPlatform = reactive<Partial<Record<ChannelPlatform, string>>>({})
const drafts = reactive<Partial<Record<ChannelPlatform, Record<string, string>>>>({})
const listError = ref('')

function stateOf(platform: ChannelPlatform): ChannelPlatformState | null {
  return store.platformState(platform)
}

function platformName(platform: string): string {
  return t(`channels.platform.${platform}`)
}

function statusText(platform: ChannelPlatform): string {
  const st = stateOf(platform)
  if (!st?.configured) return t('channels.status.not-configured')
  if (!st.enabled) return t('channels.status.disabled')
  const label = t(`channels.lifecycle.${st.status.lifecycle}`)
  return st.status.lifecycle === 'ready' && st.status.identity ? `${label} ${st.status.identity}` : label
}

function pendingCount(platform: ChannelPlatform): number {
  return store.pairing.value.filter((r) => r.platform === platform).length
}

function needsText(spec: ChannelPlatformSpec): string {
  if (!spec.fields.length) return t('channels.imessage-note')
  const fields = spec.fields.filter((f) => !f.optional).map((f) => t(`channels.field.${f.key}`))
  return t('channels.needs', { fields: fields.join(' + ') })
}

function statusTone(platform: ChannelPlatform): string {
  const st = stateOf(platform)
  if (!st?.configured || !st.enabled) return 'muted'
  switch (st.status.lifecycle) {
    case 'ready':
      return 'ok'
    case 'blocked':
      return 'bad'
    case 'recovering':
    case 'starting':
      return 'warn'
    default:
      return 'muted'
  }
}

function toggleExpanded(platform: ChannelPlatform): void {
  if (expanded.value === platform) {
    expanded.value = null
    return
  }
  const st = stateOf(platform)
  const spec = CHANNEL_PLATFORMS.find((s) => s.platform === platform)!
  const draft: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = f.secret ? '' : st?.config[f.key]
    draft[f.key] = typeof v === 'string' ? v : (f.options?.[0] ?? '')
  }
  drafts[platform] = draft
  errorByPlatform[platform] = ''
  expanded.value = platform
}

async function run(platform: ChannelPlatform | null, op: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  busy.value = true
  try {
    const res = await op()
    const msg = res.ok ? '' : (res.error ?? t('channels.error.generic'))
    if (platform) errorByPlatform[platform] = msg
    else listError.value = msg
    return res.ok
  } finally {
    busy.value = false
  }
}

async function save(spec: ChannelPlatformSpec): Promise<void> {
  const platform = spec.platform
  const st = stateOf(platform)
  const draft = drafts[platform] ?? {}
  const config: Record<string, unknown> = { ...(st?.config ?? {}) }
  // The permission relay is always on (Navide Guard screens every chat approval).
  delete config.permission_relay
  const secret: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = (draft[f.key] ?? '').trim()
    if (f.secret) {
      if (v) secret[f.key] = v
    } else if (v || !f.optional) {
      config[f.key] = v
    } else {
      delete config[f.key]
    }
  }
  const missing = spec.fields.filter((f) =>
    f.optional ? false : f.secret ? !st?.configured && !secret[f.key] : !(config[f.key] as string)
  )
  if (missing.length) {
    errorByPlatform[platform] = t('channels.error.missing', { fields: missing.map((f) => t(`channels.field.${f.key}`)).join(', ') })
    return
  }
  // A platform without credentials (iMessage) still sends an empty secret.
  const sendSecret = Object.keys(secret).length > 0 || !spec.fields.some((f) => f.secret)
  const ok = await run(platform, () => store.configure(platform, config, sendSecret ? secret : undefined))
  if (ok) expanded.value = null
}

async function removePlatform(platform: ChannelPlatform): Promise<void> {
  const ok = await run(platform, () => store.remove(platform))
  if (ok) expanded.value = null
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}
</script>

<template>
  <section class="channels-pane" data-settings-section="channels">
    <SettingsCard>
      <SettingRow :title="t('channels.global.title')" :description="t('channels.global.desc')">
        <template #control>
          <ToggleSwitch
            data-testid="channels-global-toggle"
            :model-value="store.enabled.value"
            :disabled="busy"
            :aria-label="t('channels.global.title')"
            @update:model-value="(v: boolean) => run(null, () => store.setGlobalEnabled(v))"
          />
        </template>
      </SettingRow>
    </SettingsCard>
    <p v-if="listError || store.error.value" class="ch-error ch-list-error" role="alert">{{ listError || store.error.value }}</p>

    <SettingsSection :label="t('channels.section.platforms')">
      <SettingsCard>
        <div
          v-for="spec in specs"
          :key="spec.platform"
          class="ch-row"
          :class="{ open: expanded === spec.platform }"
          :data-platform="spec.platform"
        >
          <div class="ch-row-head">
            <span class="ch-mark" :class="{ on: stateOf(spec.platform)?.configured }" aria-hidden="true">{{ MARKS[spec.platform] }}</span>
            <div class="ch-row-text">
              <div class="ch-row-title">
                <span class="ch-row-name">{{ platformName(spec.platform) }}</span>
                <span class="ch-pill" :class="statusTone(spec.platform)" data-testid="channel-status">{{ statusText(spec.platform) }}</span>
                <span
                  v-if="pendingCount(spec.platform)"
                  class="ch-pill pending"
                  data-testid="channel-pending"
                >{{ t('channels.pending-count', { n: pendingCount(spec.platform) }) }}</span>
              </div>
              <div class="ch-row-desc">{{ t(`channels.desc.${spec.platform}`) }}</div>
              <div
                v-if="stateOf(spec.platform)?.status.last_error"
                class="ch-row-error"
                :class="statusTone(spec.platform)"
                :title="stateOf(spec.platform)?.status.last_error"
                data-testid="channel-last-error"
              >{{ stateOf(spec.platform)?.status.last_error }}</div>
            </div>
            <div class="ch-row-actions">
              <ToggleSwitch
                v-if="stateOf(spec.platform)?.configured"
                :model-value="stateOf(spec.platform)?.enabled === true"
                :disabled="busy || !store.enabled.value"
                :aria-label="t('channels.enable-platform', { platform: platformName(spec.platform) })"
                @update:model-value="(v: boolean) => run(spec.platform, () => store.setEnabled(spec.platform, v))"
              />
              <button type="button" class="ch-btn ghost sm" data-testid="channel-manage" @click="toggleExpanded(spec.platform)">
                {{ stateOf(spec.platform)?.configured ? t('channels.manage') : t('channels.connect') }}
              </button>
            </div>
          </div>

          <form v-if="expanded === spec.platform" class="ch-form" @submit.prevent="save(spec)">
            <div class="ch-form-notes">
              <p class="ch-form-needs" data-testid="channel-needs">{{ needsText(spec) }}</p>
              <p v-if="te(`channels.hint.${spec.platform}`)" class="ch-form-hint" data-testid="channel-hint">{{ t(`channels.hint.${spec.platform}`) }}</p>
              <p v-if="SINGLE_RECEIVER.has(spec.platform)" class="ch-form-hint" data-testid="channel-single-receiver">{{ t('channels.single-receiver-hint') }}</p>
            </div>
            <label v-for="f in spec.fields" :key="f.key" class="ch-field">
              <span class="ch-field-label">{{ t(`channels.field.${f.key}`) }}<template v-if="f.optional"> {{ t('channels.optional') }}</template></span>
              <select v-if="f.options" v-model="drafts[spec.platform]![f.key]" class="ch-input" :name="f.key">
                <option v-for="o in f.options" :key="o" :value="o">{{ t(`channels.option.${o}`) }}</option>
              </select>
              <input
                v-else
                v-model="drafts[spec.platform]![f.key]"
                class="ch-input"
                :type="f.secret ? 'password' : 'text'"
                :name="f.key"
                autocomplete="off"
                spellcheck="false"
                :placeholder="f.secret && stateOf(spec.platform)?.configured ? t('channels.secret-stored') : ''"
              />
            </label>
            <p v-if="errorByPlatform[spec.platform]" class="ch-error" role="alert">{{ errorByPlatform[spec.platform] }}</p>
            <div class="ch-form-actions">
              <button
                v-if="stateOf(spec.platform)?.configured"
                type="button"
                class="ch-btn danger-ghost sm"
                :disabled="busy"
                data-testid="channel-remove"
                @click="removePlatform(spec.platform)"
              >{{ t('channels.remove') }}</button>
              <span class="ch-spacer"></span>
              <button type="button" class="ch-btn ghost sm" :disabled="busy" @click="expanded = null">{{ t('channels.cancel') }}</button>
              <button type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-save">{{ t('channels.save') }}</button>
            </div>
          </form>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection v-if="store.pairing.value.length" :label="t('channels.pairing.title')">
      <p class="ch-section-hint">{{ t('channels.pairing.hint') }}</p>
      <SettingsCard>
        <div v-for="req in store.pairing.value" :key="`${req.platform}:${req.code}`" class="ch-item" data-testid="pairing-row">
          <span class="ch-mark sm" aria-hidden="true">{{ MARKS[req.platform] }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name">{{ req.sender_name || req.sender_id }}</span>
            <span class="ch-item-meta">{{ platformName(req.platform) }} · {{ formatTime(req.created_at) }}</span>
          </div>
          <code class="ch-code">{{ req.code }}</code>
          <div class="ch-row-actions">
            <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="pairing-reject" @click="run(null, () => store.rejectPairing(req.platform, req.code))">{{ t('channels.pairing.reject') }}</button>
            <button type="button" class="ch-btn primary sm" :disabled="busy" data-testid="pairing-approve" @click="run(null, () => store.approvePairing(req.platform, req.code))">{{ t('channels.pairing.approve') }}</button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection v-if="store.allow.value.length" :label="t('channels.allow.title')">
      <SettingsCard>
        <div v-for="entry in store.allow.value" :key="`${entry.platform}:${entry.sender_id}`" class="ch-item" data-testid="allow-row">
          <span class="ch-mark sm" aria-hidden="true">{{ MARKS[entry.platform] }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name">{{ entry.sender_name || entry.sender_id }}</span>
            <span class="ch-item-meta">{{ platformName(entry.platform) }} · {{ entry.sender_id }}</span>
          </div>
          <div class="ch-row-actions">
            <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="allow-remove" @click="run(null, () => store.removeAllow(entry.platform, entry.sender_id))">{{ t('channels.allow.remove') }}</button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  </section>
</template>

<style scoped>
.channels-pane { display: flex; flex-direction: column; }
.ch-list-error { margin-top: 8px; }
.ch-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); word-break: break-word; }

/* Platform rows: same inset and type scale as SettingRow. */
.ch-row { padding: var(--space-row-y) var(--space-row-x); }
.ch-row.open { background: var(--bg-base); }
.ch-row-head { display: flex; align-items: center; gap: 12px; }
.ch-mark {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ch-mark.on { color: var(--accent-fg); border-color: var(--accent-muted); background: var(--accent-subtle); }
.ch-mark.sm { width: 22px; height: 22px; }
.ch-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ch-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ch-row-name { font-size: var(--font-row-title); font-weight: 600; color: var(--text-bright); }
.ch-row-desc { font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-row-error {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.ch-row-error.warn { color: var(--attention-fg); }
.ch-row-error.bad { color: var(--danger-fg); }
.ch-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Status pill: same shape as the account badges on the Accounts page. */
.ch-pill {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--text-secondary);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  white-space: nowrap;
}
.ch-pill.ok { color: var(--success-fg); background: var(--success-subtle); border-color: var(--success-muted); }
.ch-pill.warn { color: var(--attention-fg); background: var(--attention-subtle); border-color: var(--attention-muted); }
.ch-pill.bad { color: var(--danger-fg); background: var(--danger-subtle); border-color: var(--danger-muted); }
.ch-pill.pending { color: var(--accent-fg); background: var(--accent-subtle); border-color: var(--accent-muted); }

/* Connect / manage form, revealed under its row. */
.ch-form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 2px 40px; }
.ch-form-notes { display: flex; flex-direction: column; gap: 4px; }
.ch-form-needs { margin: 0; font-size: var(--font-row-desc); font-weight: 600; color: var(--text-primary); }
.ch-form-hint { margin: 0; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.ch-field { display: flex; flex-direction: column; gap: 4px; }
.ch-field-label { font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 8px;
}
.ch-input:hover { border-color: var(--border-strong); }
.ch-input:focus { outline: none; border-color: var(--accent-focus); }
.ch-form-actions { display: flex; align-items: center; gap: 8px; }
.ch-spacer { flex: 1; }

/* Buttons: the Accounts page's button set. */
.ch-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  white-space: nowrap;
}
.ch-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.ch-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.ch-btn.ghost { color: var(--text-secondary); }
.ch-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.ch-btn.danger-ghost { color: var(--danger-fg); border-color: var(--danger-muted); }
.ch-btn.danger-ghost:hover:not(:disabled) { border-color: var(--danger-fg); }

/* Pairing / allowlist rows. */
.ch-section-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-item { display: flex; align-items: center; gap: 10px; padding: 8px var(--space-row-x); }
.ch-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ch-item-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-code { font-family: var(--font-mono, monospace); font-size: var(--font-xs); letter-spacing: 0.08em; color: var(--text-bright); }
</style>
