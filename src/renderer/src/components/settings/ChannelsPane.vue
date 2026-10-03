<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import type { useBackend } from '../../composables/useBackend'
import {
  DEFAULT_ACCOUNT,
  newAccountId,
  useChannels,
  type ChannelAccountState,
  type ChannelLinkInvite,
  type ChannelPlatform,
} from '../../composables/useChannels'
import {
  CHANNEL_PLATFORM_SPECS,
  channelPlatform,
  clipboardTokenField,
  type RegisteredChannelPlatform,
} from '../../platform/channels'
import ChannelLinkGuide from '../ChannelLinkGuide.vue'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → Channels: connect chat platforms, watch their connection state,
 * approve pairing requests and manage who may talk to panes. A platform can run
 * several bots, each with its own credential, connection and linked chats.
 * Secrets go to the backend once and are never shown again — a stored secret
 * only shows as masked. A new bot is added with "quick add": the backend keeps it
 * only once the platform accepted its credential, then the bot's link guide opens
 * the chat app with a fresh code.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
}>()

const { t, te } = useI18n()
const store = useChannels(props.backend)

// Configured platforms first; otherwise the declared display order.
const specs = computed<RegisteredChannelPlatform[]>(() => {
  const visible = CHANNEL_PLATFORM_SPECS.filter((s) => !s.macOnly || isMacPlatform())
  return [
    ...visible.filter((s) => isConfigured(s.id)),
    ...visible.filter((s) => !isConfigured(s.id)),
  ]
})

/** A bot row: a configured bot, the not-yet-set-up default slot, or one being added. */
interface BotRow extends ChannelAccountState {
  key: string
  isNew: boolean
}

// The bot being added, per platform: its form is open under the platform's bots.
const adding = reactive<Partial<Record<ChannelPlatform, string>>>({})
const expanded = ref<string | null>(null)
const busy = ref(false)
const errorByBot = reactive<Record<string, string>>({})
const drafts = reactive<Record<string, Record<string, string>>>({})
const listError = ref('')
// Rename and remove each ask on the row itself first.
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const confirmingRemove = ref<string | null>(null)
// Quick add progress per bot; the invite it got is handed to the bot's link guide.
type QuickStep = 'verifying' | 'opening' | 'waiting' | 'done'
const quickStep = reactive<Record<string, QuickStep>>({})
const quickInvite = reactive<Record<string, ChannelLinkInvite>>({})
// Whether the link guide got the code command onto the clipboard.
const quickCopied = reactive<Record<string, boolean>>({})
// Added, but no invite reached the link guide: the row says to link from the guide.
const quickAdded = reactive<Record<string, boolean>>({})
const QUICK_STEPS: readonly QuickStep[] = ['verifying', 'opening', 'waiting', 'done']

function botKey(platform: string, account: string): string {
  return `${platform}:${account}`
}

function isConfigured(platform: ChannelPlatform): boolean {
  return !!store.platformState(platform)?.configured
}

function emptyBot(platform: ChannelPlatform, account: string, isNew: boolean): BotRow {
  return {
    key: botKey(platform, account), account, name: '', configured: false, enabled: false, isNew,
    status: { lifecycle: 'stopped', connected: false, reconnect_attempts: 0, last_error: '', last_connected_at: null, last_inbound_at: null, identity: '' },
    config: {}, capabilities: null,
  }
}

function botsOf(platform: ChannelPlatform): BotRow[] {
  const configured = store.platformState(platform)?.accounts ?? []
  const rows: BotRow[] = configured.map((a) => ({ ...a, key: botKey(platform, a.account), isNew: false }))
  if (!rows.length) rows.push(emptyBot(platform, DEFAULT_ACCOUNT, false))
  const added = adding[platform]
  if (added) rows.push(emptyBot(platform, added, true))
  return rows
}

function botLabel(bot: Pick<BotRow, 'name' | 'account'>): string {
  if (bot.name) return bot.name
  return bot.account === DEFAULT_ACCOUNT ? t('channels.bot.default') : bot.account
}

/** Which bot a pairing request or allowed sender belongs to, named only when
 *  its platform runs several bots (one bot reads exactly as before). */
function entryBot(platform: ChannelPlatform, account: string | undefined): string {
  const bots = store.platformState(platform)?.accounts ?? []
  if (bots.length < 2) return ''
  const id = account ?? DEFAULT_ACCOUNT
  return botLabel(bots.find((b) => b.account === id) ?? { name: '', account: id })
}

function badgeOf(platform: string): string {
  return channelPlatform(platform)?.badge ?? platform.slice(0, 2).toUpperCase()
}

function platformName(platform: string): string {
  return t(`channels.platform.${platform}`)
}

function statusText(bot: BotRow): string {
  if (!bot.configured) return t('channels.status.not-configured')
  if (!bot.enabled) return t('channels.status.disabled')
  const label = t(`channels.lifecycle.${bot.status.lifecycle}`)
  return bot.status.lifecycle === 'ready' && bot.status.identity ? `${label} ${bot.status.identity}` : label
}

function pendingCount(platform: ChannelPlatform): number {
  return store.pairing.value.filter((r) => r.platform === platform).length
}

function needsText(spec: RegisteredChannelPlatform): string {
  if (!spec.fields.length && spec.configNoteKey) return t(spec.configNoteKey)
  const fields = spec.fields.filter((f) => !f.optional).map((f) => t(`channels.field.${f.key}`))
  return t('channels.needs', { fields: fields.join(' + ') })
}

function statusTone(bot: BotRow): string {
  if (!bot.configured || !bot.enabled) return 'muted'
  switch (bot.status.lifecycle) {
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

function openForm(spec: RegisteredChannelPlatform, bot: BotRow): void {
  const draft: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = f.secret ? '' : bot.config[f.key]
    draft[f.key] = typeof v === 'string' ? v : (f.options?.[0] ?? '')
  }
  if (bot.isNew) draft.name = ''
  drafts[bot.key] = draft
  errorByBot[bot.key] = ''
  expanded.value = bot.key
}

function toggleExpanded(spec: RegisteredChannelPlatform, bot: BotRow): void {
  if (expanded.value === bot.key) {
    expanded.value = null
    return
  }
  openForm(spec, bot)
  if (usesQuickAdd(spec, bot)) void prefillFromClipboard(spec, bot.key)
}

function startAdding(spec: RegisteredChannelPlatform): void {
  const account = newAccountId()
  adding[spec.id] = account
  const bot = emptyBot(spec.id, account, true)
  openForm(spec, bot)
  if (usesQuickAdd(spec, bot)) void prefillFromClipboard(spec, bot.key)
}

/** A bot not set up yet, on a platform with a credential to verify (not iMessage). */
function usesQuickAdd(spec: RegisteredChannelPlatform, bot: BotRow): boolean {
  return !bot.configured && spec.fields.some((f) => f.secret)
}

/** Read the clipboard only on a button press, and keep it only when it has the
 *  shape of one of the platform's empty credential fields; anything else is dropped unseen. */
async function prefillFromClipboard(spec: RegisteredChannelPlatform, key: string): Promise<void> {
  if (!spec.fields.some((f) => f.clipboardPattern)) return
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    return
  }
  const field = clipboardTokenField(spec.fields, text)
  const draft = drafts[key]
  if (field && draft && !draft[field]) draft[field] = text.trim()
}

function closeForm(spec: RegisteredChannelPlatform, bot: BotRow): void {
  expanded.value = null
  if (bot.isNew) delete adding[spec.id]
}

async function run(key: string | null, op: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  busy.value = true
  try {
    const res = await op()
    const msg = res.ok ? '' : (res.error ?? t('channels.error.generic'))
    if (key) errorByBot[key] = msg
    else listError.value = msg
    return res.ok
  } finally {
    busy.value = false
  }
}

/** The form as a configure request; null (with the error shown) when a required field is empty. */
function formRequest(spec: RegisteredChannelPlatform, bot: BotRow): { config: Record<string, unknown>; secret: Record<string, string> | undefined } | null {
  const draft = drafts[bot.key] ?? {}
  const config: Record<string, unknown> = { ...bot.config }
  // The permission relay is always on (Navide Guard screens every chat approval).
  delete config.permission_relay
  delete config.secret_hint
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
  const name = (draft.name ?? '').trim()
  if (bot.isNew && name) config.name = name
  const missing = spec.fields.filter((f) =>
    f.optional ? false : f.secret ? !bot.configured && !secret[f.key] : !(config[f.key] as string)
  )
  if (missing.length) {
    errorByBot[bot.key] = t('channels.error.missing', { fields: missing.map((f) => t(`channels.field.${f.key}`)).join(', ') })
    return null
  }
  // A platform without credentials (iMessage) still sends an empty secret.
  const sendSecret = Object.keys(secret).length > 0 || !spec.fields.some((f) => f.secret)
  return { config, secret: sendSecret ? secret : undefined }
}

async function save(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  const req = formRequest(spec, bot)
  if (!req) return
  const ok = await run(bot.key, () => store.configure(spec.id, req.config, req.secret, bot.account))
  if (ok) closeForm(spec, bot)
}

async function quickAdd(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  // Busy before the clipboard read: a second press meanwhile would add the same bot twice.
  if (busy.value) return
  busy.value = true
  try {
    if (spec.fields.some((f) => f.secret && !(drafts[bot.key]?.[f.key] ?? '').trim())) {
      await prefillFromClipboard(spec, bot.key)
    }
    const req = formRequest(spec, bot)
    if (!req) return
    // Only a platform whose primary link button opens a link gets an invite right away;
    // the others show their link guide once the bot is connected.
    const primary = spec.link.targets[0]
    const linkTarget = primary?.opensLink ? primary.target : undefined
    errorByBot[bot.key] = ''
    delete quickAdded[bot.key]
    quickStep[bot.key] = 'verifying'
    const res = await store.quickAdd(spec.id, req.config, req.secret ?? {}, bot.account, linkTarget)
    if (!res.ok || !res.data) {
      delete quickStep[bot.key]
      const error = res.error ?? t('channels.error.generic')
      errorByBot[bot.key] = res.reason === 'rejected' || res.reason === 'timeout'
        ? t(`channels.quick.${res.reason}`, { platform: platformName(spec.id), error })
        : error
      return
    }
    closeForm(spec, bot)
    // The link guide only shows on a connected bot: hand it the invite only then.
    const added = botsOf(spec.id).find((b) => b.account === bot.account)
    if (res.data.link && added && isConnected(added)) {
      quickStep[bot.key] = 'opening'
      quickInvite[bot.key] = res.data.link
    } else {
      endQuickSteps(bot.key)
    }
  } finally {
    busy.value = false
  }
}

/** Stop the steps where the link guide cannot go on: the row says to link from the guide. */
function endQuickSteps(key: string): void {
  delete quickStep[key]
  delete quickInvite[key]
  quickAdded[key] = true
}

function quickOpened(key: string, copied: boolean): void {
  delete quickInvite[key]
  quickCopied[key] = copied
  if (quickStep[key] === 'opening') quickStep[key] = 'waiting'
}

function botLinked(key: string): void {
  delete quickAdded[key]
  if (quickStep[key]) quickStep[key] = 'done'
  void loadChatCounts()
}

function stepState(key: string, step: QuickStep): string {
  const at = QUICK_STEPS.indexOf(quickStep[key] ?? 'verifying')
  const i = QUICK_STEPS.indexOf(step)
  return i === at ? 'current' : i < at ? 'past' : ''
}

function quickStepText(spec: RegisteredChannelPlatform, step: QuickStep): string {
  if (step === 'waiting') {
    return t(spec.link.urlCarriesCode ? 'channels.quick.step.waiting-start' : 'channels.quick.step.waiting-paste')
  }
  return t(`channels.quick.step.${step}`, { platform: platformName(spec.id) })
}

function openSetupLink(url: string): void {
  void window.agentTeam?.openExternal?.(url)
}

/** Panes connected through this bot: removing it disconnects them. */
function boundCount(platform: ChannelPlatform, account: string): number {
  return store.bindings.value.filter((b) => b.platform === platform && (b.account || DEFAULT_ACCOUNT) === account).length
}

async function removeBot(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  // The last bot takes the platform with it (allowlist and pairing requests too),
  // exactly as removing a platform always has.
  const last = (store.platformState(spec.id)?.accounts.length ?? 0) <= 1
  const ok = await run(bot.key, () => (last ? store.remove(spec.id) : store.remove(spec.id, bot.account)))
  confirmingRemove.value = null
  if (ok) expanded.value = null
}

function startRename(bot: BotRow): void {
  renaming.value = bot.key
  renameDraft.value = bot.name
}

async function saveRename(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  const ok = await run(bot.key, () => store.renameAccount(spec.id, bot.account, renameDraft.value.trim()))
  if (ok) renaming.value = null
}

function isConnected(bot: BotRow): boolean {
  return bot.configured && bot.enabled && bot.status.connected && store.enabled.value
}

// Chats each connected bot knows: none yet means the row shows the linking
// guide as the next step; some collapse it to a one-line summary.
const chatCounts = reactive<Record<string, number>>({})
// Why a count could not be read: the row shows it with a retry instead of
// silently dropping the linking guide.
const chatCountErrors = reactive<Record<string, string>>({})
const linkOpen = ref<string | null>(null)
const connectedBots = computed(() =>
  specs.value.flatMap((s) => botsOf(s.id).filter(isConnected).map((b) => ({ platform: s.id, bot: b })))
)
const connectedKey = computed(() => connectedBots.value.map((c) => c.bot.key).join(','))

// Loads overlap (every status patch re-runs this); only the latest may write.
let chatCountLoad = 0

async function loadChatCounts(): Promise<void> {
  const load = ++chatCountLoad
  await Promise.all(
    connectedBots.value.map(async ({ platform, bot }) => {
      const res = await store.locations(platform, bot.account)
      if (load !== chatCountLoad) return
      if (res.ok) {
        chatCounts[bot.key] = res.data?.locations?.length ?? 0
        delete chatCountErrors[bot.key]
      } else {
        chatCountErrors[bot.key] = res.error ?? t('channels.error.generic')
      }
    })
  )
}

watch(
  () => [store.platforms.value, store.lastLinked.value, connectedKey.value],
  () => void loadChatCounts(),
  { immediate: true }
)

// An invite waiting for the link guide, on a bot whose guide will not show
// (its chats failed to load, or it is no longer connected), must not hold the steps at "opening".
watch(
  () => Object.keys(quickStep).filter((k) => quickStep[k] === 'opening'
    && (chatCountErrors[k] !== undefined || !connectedBots.value.some((c) => c.bot.key === k))),
  (stuck) => stuck.forEach(endQuickSteps)
)

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
          :key="spec.id"
          class="ch-row"
          :class="{ open: !!expanded?.startsWith(`${spec.id}:`) }"
          :data-platform="spec.id"
        >
          <div class="ch-row-head">
            <span class="ch-mark" :class="{ on: isConfigured(spec.id) }" aria-hidden="true">{{ spec.badge }}</span>
            <div class="ch-row-text">
              <div class="ch-row-title">
                <span class="ch-row-name">{{ platformName(spec.id) }}</span>
                <span
                  v-if="pendingCount(spec.id)"
                  class="ch-pill pending"
                  data-testid="channel-pending"
                >{{ t('channels.pending-count', { n: pendingCount(spec.id) }) }}</span>
              </div>
              <div class="ch-row-desc">{{ t(`channels.desc.${spec.id}`) }}</div>
            </div>
            <div class="ch-row-actions">
              <button
                v-if="isConfigured(spec.id) && !adding[spec.id]"
                type="button"
                class="ch-btn ghost sm"
                :disabled="busy"
                data-testid="channel-add-bot"
                @click="startAdding(spec)"
              >{{ t('channels.bot.add') }}</button>
            </div>
          </div>

          <div v-for="bot in botsOf(spec.id)" :key="bot.key" class="ch-bot" :data-account="bot.account" data-testid="channel-bot">
            <div class="ch-bot-head">
              <div class="ch-row-text">
                <div class="ch-row-title">
                  <template v-if="bot.configured">
                    <form v-if="renaming === bot.key" class="ch-rename" @submit.prevent="saveRename(spec, bot)">
                      <input
                        v-model="renameDraft"
                        class="ch-input"
                        name="bot-name"
                        :placeholder="botLabel(bot)"
                        :aria-label="t('channels.bot.name')"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <button type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-rename-save">{{ t('channels.save') }}</button>
                      <button type="button" class="ch-btn ghost sm" :disabled="busy" @click="renaming = null">{{ t('channels.cancel') }}</button>
                    </form>
                    <template v-else>
                      <span class="ch-bot-name" data-testid="channel-bot-name">{{ botLabel(bot) }}</span>
                      <button type="button" class="ch-link-btn" :disabled="busy" data-testid="channel-rename" @click="startRename(bot)">{{ t('channels.bot.rename') }}</button>
                    </template>
                  </template>
                  <span v-else-if="bot.isNew" class="ch-bot-name">{{ t('channels.bot.new') }}</span>
                  <span class="ch-pill" :class="statusTone(bot)" data-testid="channel-status">{{ statusText(bot) }}</span>
                </div>
                <div
                  v-if="bot.status.last_error"
                  class="ch-row-error"
                  :class="statusTone(bot)"
                  :title="bot.status.last_error"
                  data-testid="channel-last-error"
                >{{ bot.status.last_error }}</div>
              </div>
              <div class="ch-row-actions">
                <ToggleSwitch
                  v-if="bot.configured"
                  :model-value="bot.enabled"
                  :disabled="busy || !store.enabled.value"
                  :aria-label="t('channels.enable-platform', { platform: `${platformName(spec.id)} ${botLabel(bot)}` })"
                  @update:model-value="(v: boolean) => run(bot.key, () => store.setEnabled(spec.id, v, bot.account))"
                />
                <button v-if="!bot.isNew" type="button" class="ch-btn ghost sm" data-testid="channel-manage" @click="toggleExpanded(spec, bot)">
                  {{ bot.configured ? t('channels.manage') : t('channels.connect') }}
                </button>
              </div>
            </div>

            <template v-if="quickStep[bot.key]">
              <ol class="ch-quick-steps" data-testid="channel-quick-steps" :data-step="quickStep[bot.key]">
                <li v-for="step in QUICK_STEPS" :key="step" :class="stepState(bot.key, step)">{{ quickStepText(spec, step) }}</li>
              </ol>
              <p
                v-if="quickStep[bot.key] === 'waiting' && !spec.link.urlCarriesCode && quickCopied[bot.key]"
                class="ch-form-hint"
                data-testid="channel-quick-copied"
              >{{ t('channels.quick.copied-code', { platform: platformName(spec.id) }) }}</p>
            </template>
            <p v-else-if="quickAdded[bot.key]" class="ch-form-hint" data-testid="channel-quick-added">{{ t('channels.quick.added') }}</p>

            <div
              v-if="isConnected(bot) && (chatCounts[bot.key] !== undefined || chatCountErrors[bot.key])"
              class="ch-link"
              :class="{ next: !chatCounts[bot.key] }"
              data-testid="channel-link-block"
            >
              <div v-if="chatCountErrors[bot.key]" class="ch-link-summary">
                <span class="ch-link-error" role="alert">{{ t('channels.link.count-failed', { error: chatCountErrors[bot.key] }) }}</span>
                <button type="button" class="ch-btn ghost sm" data-testid="channel-link-retry" @click="loadChatCounts">{{ t('action.retry') }}</button>
              </div>
              <template v-else-if="!chatCounts[bot.key] || (quickStep[bot.key] && quickStep[bot.key] !== 'done')">
                <div class="ch-link-title" data-testid="channel-next-step">{{ t('channels.link.next-step') }}</div>
                <p class="ch-link-desc">{{ t('channels.link.next-step-desc', { platform: platformName(spec.id) }) }}</p>
                <ChannelLinkGuide
                  :store="store"
                  :platform="spec.id"
                  :account="bot.account"
                  :initial-invite="quickInvite[bot.key] ?? null"
                  @opened="(copied) => quickOpened(bot.key, copied)"
                  @linked="botLinked(bot.key)"
                />
              </template>
              <template v-else>
                <div class="ch-link-summary">
                  <span data-testid="channel-linked-summary">{{ t('channels.link.linked-summary', { n: chatCounts[bot.key] }) }}</span>
                  <button
                    type="button"
                    class="ch-btn ghost sm"
                    data-testid="channel-link-account"
                    :aria-expanded="linkOpen === bot.key"
                    @click="linkOpen = linkOpen === bot.key ? null : bot.key"
                  >{{ t('channels.link.link-account') }}</button>
                </div>
                <ChannelLinkGuide v-if="linkOpen === bot.key" :store="store" :platform="spec.id" :account="bot.account" @linked="loadChatCounts" />
              </template>
            </div>

            <form v-if="expanded === bot.key" class="ch-form" @submit.prevent="usesQuickAdd(spec, bot) ? quickAdd(spec, bot) : save(spec, bot)">
              <div class="ch-form-notes">
                <p class="ch-form-needs" data-testid="channel-needs">{{ needsText(spec) }}</p>
                <template v-if="spec.setupLink && !bot.configured">
                  <a
                    class="ch-setup-link"
                    :href="spec.setupLink.url"
                    data-testid="channel-setup-link"
                    @click.prevent="openSetupLink(spec.setupLink.url)"
                  >{{ t(spec.setupLink.label) }}</a>
                  <p class="ch-form-hint">{{ t(spec.setupLink.hint) }}</p>
                </template>
                <p v-if="te(`channels.hint.${spec.id}`)" class="ch-form-hint" data-testid="channel-hint">{{ t(`channels.hint.${spec.id}`) }}</p>
                <p v-if="spec.singleReceiver" class="ch-form-hint" data-testid="channel-single-receiver">{{ t('channels.single-receiver-hint') }}</p>
              </div>
              <label v-if="bot.isNew && !usesQuickAdd(spec, bot)" class="ch-field">
                <span class="ch-field-label">{{ t('channels.bot.name') }} {{ t('channels.optional') }}</span>
                <input v-model="drafts[bot.key]!.name" class="ch-input" name="name" autocomplete="off" spellcheck="false" />
              </label>
              <label v-for="f in spec.fields" :key="f.key" class="ch-field">
                <span class="ch-field-label">{{ t(`channels.field.${f.key}`) }}<template v-if="f.optional"> {{ t('channels.optional') }}</template></span>
                <select v-if="f.options" v-model="drafts[bot.key]![f.key]" class="ch-input" :name="f.key">
                  <option v-for="o in f.options" :key="o" :value="o">{{ t(`channels.option.${o}`) }}</option>
                </select>
                <input
                  v-else
                  v-model="drafts[bot.key]![f.key]"
                  class="ch-input"
                  :type="f.secret ? 'password' : 'text'"
                  :name="f.key"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="f.secret && bot.configured ? t('channels.secret-stored') : ''"
                />
              </label>
              <details v-if="bot.isNew && usesQuickAdd(spec, bot)" class="ch-advanced" data-testid="channel-advanced">
                <summary>{{ t('channels.quick.advanced') }}</summary>
                <label class="ch-field">
                  <span class="ch-field-label">{{ t('channels.bot.name') }} {{ t('channels.optional') }}</span>
                  <input v-model="drafts[bot.key]!.name" class="ch-input" name="name" autocomplete="off" spellcheck="false" />
                </label>
              </details>
              <p v-if="errorByBot[bot.key]" class="ch-error" role="alert">{{ errorByBot[bot.key] }}</p>
              <p v-if="confirmingRemove === bot.key" class="ch-form-hint ch-remove-ask" data-testid="channel-remove-ask">
                {{ t('channels.bot.remove-ask', { n: boundCount(spec.id, bot.account) }) }}
              </p>
              <div class="ch-form-actions">
                <template v-if="bot.configured">
                  <button
                    v-if="confirmingRemove !== bot.key"
                    type="button"
                    class="ch-btn danger-ghost sm"
                    :disabled="busy"
                    data-testid="channel-remove"
                    @click="confirmingRemove = bot.key"
                  >{{ t('channels.remove') }}</button>
                  <template v-else>
                    <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="channel-remove-cancel" @click="confirmingRemove = null">{{ t('channels.cancel') }}</button>
                    <button type="button" class="ch-btn danger-ghost sm" :disabled="busy" data-testid="channel-remove-confirm" @click="removeBot(spec, bot)">{{ t('channels.remove') }}</button>
                  </template>
                </template>
                <span class="ch-spacer"></span>
                <button type="button" class="ch-btn ghost sm" :disabled="busy" @click="closeForm(spec, bot)">{{ t('channels.cancel') }}</button>
                <button v-if="usesQuickAdd(spec, bot)" type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-quick-add">
                  {{ quickStep[bot.key] === 'verifying' ? t('channels.quick.verifying') : t('channels.quick.add') }}
                </button>
                <button v-else type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-save">{{ t('channels.save') }}</button>
              </div>
            </form>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection v-if="store.pairing.value.length" :label="t('channels.pairing.title')">
      <p class="ch-section-hint">{{ t('channels.pairing.hint') }}</p>
      <SettingsCard>
        <div v-for="req in store.pairing.value" :key="`${req.platform}:${req.code}`" class="ch-item" data-testid="pairing-row">
          <span class="ch-mark sm" aria-hidden="true">{{ badgeOf(req.platform) }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name">{{ req.sender_name || req.sender_id }}</span>
            <span class="ch-item-meta">{{ platformName(req.platform) }}<template v-if="entryBot(req.platform, req.account)"> · <span data-testid="pairing-bot">{{ entryBot(req.platform, req.account) }}</span></template> · {{ formatTime(req.created_at) }}</span>
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
        <div v-for="entry in store.allow.value" :key="`${entry.platform}:${entry.account}:${entry.sender_id}`" class="ch-item" data-testid="allow-row">
          <span class="ch-mark sm" aria-hidden="true">{{ badgeOf(entry.platform) }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name">{{ entry.sender_name || entry.sender_id }}</span>
            <span class="ch-item-meta">{{ platformName(entry.platform) }}<template v-if="entryBot(entry.platform, entry.account)"> · <span data-testid="allow-bot">{{ entryBot(entry.platform, entry.account) }}</span></template> · {{ entry.sender_id }}</span>
          </div>
          <div class="ch-row-actions">
            <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="allow-remove" @click="run(null, () => store.removeAllow(entry.platform, entry.sender_id, entry.account))">{{ t('channels.allow.remove') }}</button>
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

/* Bots under a platform, aligned with the platform's text. */
.ch-bot { margin: 8px 0 0 40px; }
.ch-bot + .ch-bot { padding-top: 8px; border-top: 1px solid var(--border-muted); }
.ch-bot-head { display: flex; align-items: center; gap: 12px; }
.ch-bot-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.ch-link-btn { font: inherit; font-size: var(--font-2xs); color: var(--accent-fg); background: transparent; border: none; padding: 0; cursor: pointer; }
.ch-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-rename { display: flex; align-items: center; gap: 6px; }
.ch-remove-ask { color: var(--danger-fg); }

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
.ch-form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 2px; }
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
.ch-setup-link { align-self: flex-start; font-size: var(--font-row-desc); color: var(--accent-fg); }
.ch-advanced > summary { cursor: pointer; font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-advanced > .ch-field { margin-top: 6px; }

/* Quick add progress: verifying → opening → waiting → done. */
.ch-quick-steps { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; padding: 0; list-style: none; font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-quick-steps li.past { color: var(--success-fg); }
.ch-quick-steps li.current { color: var(--text-bright); font-weight: 600; }
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

/* Linking guide under a connected platform, aligned with the row text. */
.ch-link { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 2px; }
.ch-link.next { padding: 10px 12px; border: 1px solid var(--accent-muted); border-radius: var(--radius-sm); background: var(--accent-subtle); }
.ch-link-title { font-size: var(--font-row-desc); font-weight: 600; color: var(--text-bright); }
.ch-link-desc { margin: 0; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.ch-link-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-link-error { color: var(--danger-fg); word-break: break-word; }

/* Pairing / allowlist rows. */
.ch-section-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-item { display: flex; align-items: center; gap: 10px; padding: 8px var(--space-row-x); }
.ch-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ch-item-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-code { font-family: var(--font-mono, monospace); font-size: var(--font-xs); letter-spacing: 0.08em; color: var(--text-bright); }
</style>
