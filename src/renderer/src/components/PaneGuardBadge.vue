<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { guardKey, type GuardStore } from '../composables/useGuard'

/**
 * Pane-header badge for a pane Navide Guard marks as influenced by external
 * content (chat channel, remote device, another pane, MCP). Click opens a small
 * confirm popover; clearing the mark is a local user action only.
 */
const props = defineProps<{
  paneId: string
  /** Test seam; the app provides the store through `guardKey`. */
  store?: GuardStore
}>()

// Global instance, as TerminalPane does: headers mount in tests without the plugin.
const t = i18n.global.t
const store = props.store ?? inject(guardKey, null)

const entry = computed(() => (store?.available.value ? store.taintFor(props.paneId) : null))
const open = ref(false)
const busy = ref(false)
const error = ref('')
const btnRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const popStyle = ref<Record<string, string>>({})

function sourceText(source: string): string {
  const key = `guard.source.${source}`
  const text = t(key)
  return text === key ? source : text
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString()
}

const why = computed(() => {
  const e = entry.value
  if (!e) return ''
  const sources = (e.sources ?? []).map(sourceText).join(', ')
  return t('guard.pane.tooltip', { sources, since: formatTime(e.since) }) + (e.detail ? ` — ${e.detail}` : '')
})

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
  if (open.value) {
    close()
    return
  }
  error.value = ''
  open.value = true
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
  await nextTick()
  position()
}

function close(): void {
  open.value = false
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

async function clear(): Promise<void> {
  if (!store) return
  busy.value = true
  const res = await store.clearTaint(props.paneId)
  busy.value = false
  if (res.ok) close()
  else error.value = res.error ?? t('guard.error.generic')
}
</script>

<template>
  <span v-if="entry" class="pane-guard">
    <button
      ref="btnRef"
      type="button"
      class="pgd-badge"
      data-testid="guard-taint-badge"
      :title="why"
      :aria-expanded="open"
      @click.stop="toggle"
      @mousedown.stop
      @dblclick.stop
    ><svg class="pgd-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4Z" /><path d="M8 5.2v3.2M8 10.6v0.01" /></svg>{{ t('guard.pane.badge') }}</button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="popRef"
        class="pgd-pop"
        :style="popStyle"
        role="dialog"
        :aria-label="t('guard.pane.badge')"
        data-testid="guard-taint-popover"
        @click.stop
        @mousedown.stop
      >
        <div class="pgd-pop-head">{{ t('guard.pane.badge') }}</div>
        <p class="pgd-text">{{ why }}</p>
        <p class="pgd-text">{{ t('guard.pane.explain') }}</p>
        <p v-if="error" class="pgd-error" role="alert">{{ error }}</p>
        <div class="pgd-actions">
          <button type="button" class="pgd-btn" @click="close">{{ t('guard.cancel') }}</button>
          <button type="button" class="pgd-btn primary" data-testid="guard-taint-clear" :disabled="busy" @click="clear">{{ t('guard.pane.clear') }}</button>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.pane-guard { display: inline-flex; align-items: center; flex-shrink: 0; }
/* Same height and type as the header's status badge and channel chip. */
.pgd-badge { display: inline-flex; align-items: center; gap: 3px; font: inherit; font-size: var(--font-3xs); line-height: 1.4; color: var(--attention-fg); background: var(--attention-subtle); border: 1px solid var(--attention-muted); border-radius: 999px; padding: 1px 7px 1px 5px; cursor: pointer; white-space: nowrap; }
.pgd-badge:hover { border-color: var(--attention-fg); }
.pgd-icon { width: 11px; height: 11px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pgd-pop { position: fixed; z-index: 300; box-sizing: border-box; width: 300px; max-width: calc(100vw - 16px); display: flex; flex-direction: column; gap: 6px; background: var(--bg-overlay); border: 1px solid var(--border-default); border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); font-size: var(--font-2xs); color: var(--text-secondary); }
.pgd-pop-head { font-weight: 600; color: var(--text-bright); }
.pgd-text { margin: 0; line-height: 1.4; word-break: break-word; }
.pgd-error { margin: 0; color: var(--danger-fg); }
.pgd-actions { display: flex; justify-content: flex-end; gap: 6px; }
.pgd-btn { font: inherit; color: var(--text-primary); background: transparent; border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 3px 8px; cursor: pointer; }
.pgd-btn:disabled { opacity: 0.5; cursor: default; }
.pgd-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
</style>
