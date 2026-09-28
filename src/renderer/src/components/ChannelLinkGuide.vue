<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { ChannelLinkInvite, ChannelPlatform, ChannelsStore } from '../composables/useChannels'

/**
 * "Link my chat account" for one connected platform: asks the backend for a
 * one-time code, opens the platform's deep link when there is one, and waits
 * for `channels.linked`. Whoever sends the code is allowlisted and their chat
 * remembered, so no pairing approval is needed. Pending pairing requests for
 * the platform are approvable here too. Used by the pane picker's empty state
 * and by the Settings → Channels card.
 */
const props = defineProps<{
  store: ChannelsStore
  platform: ChannelPlatform
}>()
const emit = defineEmits<{ linked: [title: string] }>()

// Global instance: the pane header mounts without the i18n plugin in tests.
const t = i18n.global.t

interface LinkAction {
  target: 'direct' | 'group'
  label: string
}

// Telegram deep links carry the code; Discord's link installs the bot in a
// server; Slack's opens the app's DM. Everywhere else the code is typed by hand.
const ACTIONS: Partial<Record<ChannelPlatform, LinkAction[]>> = {
  telegram: [
    { target: 'direct', label: 'channels.link.open-telegram' },
    { target: 'group', label: 'channels.link.add-group' },
  ],
  discord: [
    { target: 'group', label: 'channels.link.add-server' },
    { target: 'direct', label: 'channels.link.get-code' },
  ],
  slack: [{ target: 'direct', label: 'channels.link.open-slack' }],
}
const actions = computed(() => ACTIONS[props.platform] ?? [{ target: 'direct' as const, label: 'channels.link.get-code' }])

const invite = ref<ChannelLinkInvite | null>(null)
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const linkedTitle = ref('')

const platformName = computed(() => t(`channels.platform.${props.platform}`))
const command = computed(() =>
  invite.value ? `${props.platform === 'telegram' ? '/start' : 'link'} ${invite.value.code}` : ''
)
const sendHint = computed(() => {
  if (props.platform === 'telegram') return t('channels.link.send-code-telegram')
  if (props.platform === 'imessage') return t('channels.link.send-code-imessage')
  return t('channels.link.send-code')
})
const waitingText = computed(() =>
  props.platform === 'telegram' ? t('channels.link.waiting-start') : t('channels.link.waiting', { platform: platformName.value })
)
const pending = computed(() => props.store.pairing.value.filter((r) => r.platform === props.platform))

async function start(action: LinkAction): Promise<void> {
  busy.value = true
  error.value = ''
  copied.value = false
  linkedTitle.value = ''
  try {
    const res = await props.store.createLink(props.platform, action.target)
    if (!res.ok || !res.data) {
      error.value = res.error ?? t('channels.error.generic')
      return
    }
    invite.value = res.data
    if (res.data.url) {
      // Main-process opener: http(s) only, app windows only.
      const opened = await window.agentTeam?.openExternal?.(res.data.url)
      if (opened && !opened.ok) error.value = t('channels.link.open-failed', { error: opened.error ?? '' })
    }
  } finally {
    busy.value = false
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value)
    copied.value = true
  } catch {
    copied.value = false
  }
}

async function approve(code: string): Promise<void> {
  busy.value = true
  const res = await props.store.approvePairing(props.platform, code)
  busy.value = false
  if (!res.ok) error.value = res.error ?? t('channels.error.generic')
}

watch(
  () => props.store.lastLinked.value,
  (ev) => {
    if (!ev || ev.platform !== props.platform) return
    invite.value = null
    linkedTitle.value = ev.title || ev.chat_id
    emit('linked', linkedTitle.value)
  }
)
</script>

<template>
  <div class="clg" data-testid="channel-link-guide" :data-platform="platform">
    <div class="clg-actions">
      <button
        v-for="a in actions"
        :key="a.target + a.label"
        type="button"
        class="clg-btn"
        :class="{ primary: a === actions[0] }"
        :disabled="busy"
        data-testid="channel-link-action"
        :data-target="a.target"
        @click="start(a)"
      >{{ t(a.label, { platform: platformName }) }}</button>
    </div>
    <p v-if="linkedTitle" class="clg-ok" role="status" data-testid="channel-link-done">{{ t('channels.link.linked', { title: linkedTitle }) }}</p>
    <div v-if="invite" class="clg-wait" data-testid="channel-link-waiting">
      <span class="clg-wait-text"><span class="clg-dot" aria-hidden="true"></span>{{ waitingText }}</span>
      <span class="clg-hint">{{ sendHint }}</span>
      <span class="clg-code-row">
        <code class="clg-code" data-testid="channel-link-code">{{ command }}</code>
        <button type="button" class="clg-btn sm" data-testid="channel-link-copy" @click="copy">{{ copied ? t('channels.link.copied') : t('channels.link.copy') }}</button>
      </span>
      <span class="clg-hint">{{ t('channels.link.expires') }}</span>
    </div>
    <div v-for="req in pending" :key="req.code" class="clg-pair" data-testid="channel-link-pairing">
      <span class="clg-pair-name">{{ t('channels.link.pairing', { name: req.sender_name || req.sender_id }) }}</span>
      <button type="button" class="clg-btn sm primary" :disabled="busy" data-testid="channel-link-approve" @click="approve(req.code)">{{ t('channels.pairing.approve') }}</button>
    </div>
    <p v-if="error" class="clg-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.clg { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.clg-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.clg-btn { font: inherit; border-radius: 5px; padding: 3px 9px; cursor: pointer; border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); white-space: nowrap; }
.clg-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.clg-btn:disabled { opacity: 0.5; cursor: default; }
.clg-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.clg-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.clg-btn.sm { padding: 1px 7px; font-size: var(--font-3xs); }
.clg-wait { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px dashed var(--accent-muted); border-radius: var(--radius-xs); background: var(--bg-subtle); }
.clg-wait-text { display: inline-flex; align-items: center; gap: 6px; color: var(--text-primary); }
.clg-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-fg); animation: clg-pulse 1.2s ease-in-out infinite; }
@keyframes clg-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .clg-dot { animation: none; } }
.clg-hint { line-height: 1.4; }
.clg-code-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.clg-code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, monospace); letter-spacing: 0.04em; color: var(--text-bright); user-select: all; }
.clg-pair { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.clg-pair-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.clg-ok { margin: 0; color: var(--success-fg); }
.clg-error { margin: 0; color: var(--danger-fg); word-break: break-word; }
</style>
