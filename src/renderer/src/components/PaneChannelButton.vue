<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { executeCommand } from '@navide/plugin-ui/shared'
import {
  channelsKey,
  type ChannelLocation,
  type ChannelPlatform,
  type ChannelPlatformState,
  type ChannelsStore,
} from '../composables/useChannels'
import { guardKey, type GuardStore } from '../composables/useGuard'
import { vendorRunsYolo } from '../lib/guardYolo'

/**
 * Pane-header entry to chat channels. Unbound: a small button that opens a
 * popover listing every chat the configured, connected platforms know, grouped
 * by platform; one click binds the pane (or Settings → Channels opens when no
 * platform is configured). Bound: a chip naming the platform and chat, with ✕
 * to unbind.
 */
const props = defineProps<{
  paneId: string
  paneName: string
  /** The pane's CLI vendor, for the Guard warning in the popover. */
  agentKey?: string
  /** Test seam; the app provides the store through `channelsKey`. */
  store?: ChannelsStore
  /** Test seam; the app provides the store through `guardKey`. */
  guardStore?: GuardStore
}>()

// Global instance, as TerminalPane does: headers mount in tests without the plugin.
const t = i18n.global.t
const store = props.store ?? inject(channelsKey, null)
const guard = props.guardStore ?? inject(guardKey, null)

const binding = computed(() => store?.bindingFor(props.paneId) ?? null)
const open = ref(false)
const busy = ref(false)
const error = ref('')
interface PlatformGroup {
  platform: ChannelPlatform
  identity: string
  /** Status text when the platform cannot be bound to right now; empty when connected. */
  unavailable: string
  loading: boolean
  error: string
  locations: ChannelLocation[]
}
const groups = ref<PlatformGroup[]>([])
// Bumped per open, so a slow `channels.locations` reply from an earlier open is dropped.
let loadSeq = 0
const btnRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const popStyle = ref<Record<string, string>>({})

// A vendor Guard cannot block, running with its permission prompts off: a chat
// room would drive it with nothing between the message and the shell. Read
// when the popover opens, so a settings change since mount is picked up.
const unguardedYolo = ref(false)

function platformName(platform: string): string {
  return t(`channels.platform.${platform}`)
}

function canCreate(platform: ChannelPlatform): boolean {
  return store?.platformState(platform)?.capabilities?.create_location === true
}

// Platforms name one-to-one chats differently: Telegram `private`, Slack `im`,
// Discord `dm`, Mattermost `D`, the rest `direct`.
const DIRECT_KINDS = new Set(['direct', 'dm', 'private', 'im', 'D'])
function kindLabel(loc: ChannelLocation): string {
  return t(DIRECT_KINDS.has(loc.kind) ? 'channels.pane.kind-direct' : 'channels.pane.kind-group')
}

function unavailableText(p: ChannelPlatformState): string {
  if (!p.enabled || !store?.enabled.value) return t('channels.status.disabled')
  if (p.status.connected) return ''
  return t(`channels.lifecycle.${p.status.lifecycle}`)
}

async function loadGroups(): Promise<void> {
  if (!store) return
  const seq = ++loadSeq
  groups.value = store.configuredPlatforms.value.map((p) => {
    const unavailable = unavailableText(p)
    return { platform: p.platform, identity: p.status.identity, unavailable, loading: !unavailable, error: '', locations: [] }
  })
  await Promise.all(
    groups.value
      .filter((g) => !g.unavailable)
      .map(async (g) => {
        const res = await store.locations(g.platform)
        if (seq !== loadSeq) return
        const group = groups.value.find((x) => x.platform === g.platform)
        if (!group) return
        group.loading = false
        if (res.ok) group.locations = res.data?.locations ?? []
        else group.error = res.error ?? t('channels.error.generic')
      })
  )
  if (seq !== loadSeq || !open.value) return
  await nextTick()
  position()
}

function position(): void {
  const rect = btnRef.value?.getBoundingClientRect()
  const pop = popRef.value
  if (!rect || !pop) return
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))
  const below = rect.bottom + 6
  const top = below + pop.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - pop.offsetHeight) : below
  popStyle.value = { top: `${top}px`, left: `${left}px` }
}

async function toggle(): Promise<void> {
  if (!store) return
  if (open.value) {
    close()
    return
  }
  if (!store.configuredPlatforms.value.length) {
    executeCommand('workbench.action.openSettingsChannels')
    return
  }
  error.value = ''
  unguardedYolo.value =
    !!props.agentKey && guard?.hookSupportFor(props.agentKey) === 'none' && vendorRunsYolo(props.agentKey)
  open.value = true
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
  await nextTick()
  position()
  await loadGroups()
}

function close(): void {
  open.value = false
  loadSeq++
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown, true)
}

function onPointerDown(event: Event): void {
  const target = event.target as Node | null
  if (target && (popRef.value?.contains(target) || btnRef.value?.contains(target))) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

onBeforeUnmount(close)

async function bind(platform: ChannelPlatform, loc: ChannelLocation, mode: 'new' | 'existing'): Promise<void> {
  if (!store) return
  busy.value = true
  error.value = ''
  const res = await store.bind({
    pane_id: props.paneId,
    pane_name: props.paneName,
    platform,
    mode,
    chat_id: loc.chat_id,
    ...(mode === 'new' ? { title: props.paneName } : {}),
  })
  busy.value = false
  if (res.ok) close()
  else error.value = res.error ?? t('channels.error.generic')
}

async function unbind(): Promise<void> {
  if (!store) return
  busy.value = true
  await store.unbind(props.paneId)
  busy.value = false
}

function openSettings(): void {
  close()
  executeCommand('workbench.action.openSettingsChannels')
}
</script>

<template>
  <span v-if="store" class="pane-channel">
    <span v-if="binding" class="pch-chip" data-testid="channel-chip" :title="`${platformName(binding.platform)} · ${binding.title || binding.chat_id}`">
      <svg class="pch-icon pch-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z" /><path d="M5.4 6.2h5.2M5.4 8.2h3.2" /></svg>
      <span class="pch-chip-label">{{ platformName(binding.platform) }} · {{ binding.title || binding.chat_id }}</span>
      <button
        type="button"
        class="pch-chip-x"
        data-testid="channel-unbind"
        :disabled="busy"
        :aria-label="t('channels.pane.unbind')"
        :title="t('channels.pane.unbind')"
        @click.stop="unbind"
        @mousedown.stop
        @dblclick.stop
      >✕</button>
    </span>
    <button
      v-else
      ref="btnRef"
      type="button"
      class="pch-btn"
      data-testid="channel-connect"
      :title="t('channels.pane.connect')"
      :aria-label="t('channels.pane.connect')"
      :aria-expanded="open"
      @click.stop="toggle"
      @mousedown.stop
      @dblclick.stop
    ><svg class="pch-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z" /><path d="M5.4 6.2h5.2M5.4 8.2h3.2" /></svg></button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="popRef"
        class="pch-pop"
        :style="popStyle"
        role="dialog"
        :aria-label="t('channels.pane.where')"
        data-testid="channel-popover"
        @click.stop
        @mousedown.stop
      >
        <div class="pch-pop-head">{{ t('channels.pane.where') }}</div>
        <p v-if="unguardedYolo" class="pch-warn" role="note" data-testid="channel-guard-warning">{{ t('guard.pane.no-hook-warning') }}</p>
        <section v-for="g in groups" :key="g.platform" class="pch-group" data-testid="channel-group">
          <div class="pch-group-head">
            <span class="pch-mark" aria-hidden="true">{{ platformName(g.platform).charAt(0) }}</span>
            <span class="pch-group-name">{{ platformName(g.platform) }}</span>
            <span v-if="g.identity" class="pch-sub pch-ellipsis">{{ g.identity }}</span>
          </div>
          <div v-if="g.unavailable" class="pch-row pch-row-off" data-testid="channel-platform-off" aria-disabled="true">{{ g.unavailable }}</div>
          <div v-else-if="g.loading" class="pch-sub">{{ t('channels.pane.loading') }}</div>
          <p v-else-if="g.error" class="pch-error" role="alert">{{ g.error }}</p>
          <div v-else-if="!g.locations.length" class="pch-sub" data-testid="channel-no-chats">{{ t('channels.pane.no-chats-yet') }}</div>
          <div v-for="loc in g.locations" :key="loc.chat_id" class="pch-loc" data-testid="channel-location">
            <button
              type="button"
              class="pch-row"
              data-testid="channel-bind-existing"
              :disabled="busy"
              :title="t('channels.pane.use-existing')"
              @click="bind(g.platform, loc, 'existing')"
            >
              <span class="pch-loc-title pch-ellipsis">{{ loc.title || loc.chat_id }}</span>
              <span class="pch-kind">{{ kindLabel(loc) }}</span>
            </button>
            <button
              v-if="loc.supports_topics && canCreate(g.platform)"
              type="button"
              class="pch-new"
              data-testid="channel-bind-new"
              :disabled="busy"
              :title="t('channels.pane.new-topic', { name: paneName })"
              @click="bind(g.platform, loc, 'new')"
            >{{ t('channels.pane.new-topic-short') }}</button>
          </div>
        </section>
        <p v-if="error" class="pch-error" role="alert">{{ error }}</p>
        <button type="button" class="pch-link pch-foot" data-testid="channel-manage" @click="openSettings">{{ t('channels.pane.manage-chats') }}</button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.pane-channel { display: inline-flex; align-items: center; min-width: 0; }
/* .pch-btn has no skin of its own: the pane header styles it as one of its
   icon buttons (TerminalPane.vue, next to .rebuild-btn / .minimize-btn). */
.pch-icon { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
/* Same height and type as the header's status badge. */
.pch-chip { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 1; max-width: 200px; font-size: var(--font-3xs); color: var(--accent-fg); background: var(--accent-subtle); border: 1px solid var(--accent-muted); border-radius: 999px; padding: 1px 2px 1px 7px; }
.pch-chip-icon { width: 11px; height: 11px; flex-shrink: 0; }
.pch-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pch-chip-x { font: inherit; line-height: 1; color: inherit; background: transparent; border: none; padding: 0 3px; cursor: pointer; opacity: 0.8; }
.pch-chip-x:hover { opacity: 1; }
.pch-pop { position: fixed; z-index: 300; box-sizing: border-box; width: 300px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; display: flex; flex-direction: column; gap: 4px; background: var(--bg-overlay); border: 1px solid var(--border-default); border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); font-size: var(--font-2xs); color: var(--text-secondary); }
.pch-pop-head { font-weight: 600; color: var(--text-bright); margin-bottom: 2px; }
.pch-sub { color: var(--text-secondary); }
.pch-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pch-link { font: inherit; text-align: left; color: var(--accent-fg); background: transparent; border: none; padding: 2px 0; cursor: pointer; }
.pch-foot { margin-top: 2px; padding-top: 6px; border-top: 1px solid var(--border-muted); }
.pch-group { display: flex; flex-direction: column; gap: 3px; padding: 4px 0; }
.pch-group + .pch-group { border-top: 1px solid var(--border-muted); }
.pch-group-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pch-group-name { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.pch-mark { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex-shrink: 0; font-size: 9px; font-weight: 700; color: var(--accent-fg); background: var(--accent-subtle); border: 1px solid var(--accent-muted); border-radius: 3px; }
.pch-loc { display: flex; align-items: stretch; gap: 4px; }
.pch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1; min-width: 0; font: inherit; text-align: left; color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-xs); padding: 4px 8px; cursor: pointer; }
.pch-row:hover:not(:disabled) { border-color: var(--border-default); }
.pch-row:disabled { opacity: 0.5; cursor: default; }
.pch-row-off { color: var(--text-secondary); opacity: 0.6; cursor: default; }
.pch-loc-title { color: var(--text-bright); }
.pch-kind { flex-shrink: 0; color: var(--text-secondary); font-size: var(--font-3xs); }
.pch-new { flex-shrink: 0; font: inherit; font-size: var(--font-3xs); color: var(--accent-fg); background: transparent; border: 1px solid var(--accent-muted); border-radius: var(--radius-xs); padding: 0 6px; cursor: pointer; }
.pch-new:hover:not(:disabled) { background: var(--accent-subtle); }
.pch-new:disabled { opacity: 0.5; cursor: default; }
.pch-error { margin: 0; color: var(--danger-fg); }
.pch-warn { margin: 0 0 2px; color: var(--attention-fg); line-height: 1.4; }
</style>
