<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

// The one right-click menu for a run group, whichever surface opened it — a
// stage tab or a sidebar group heading. Both open it through App.vue, so the
// items and what they do cannot drift between the two. Items a group cannot
// use are disabled rather than hidden, so the menu keeps one shape everywhere.

const props = defineProps<{
  x: number
  y: number
  canRename: boolean
  canMove: boolean
  canDetach: boolean
  /** How many of the group's panes each batch action would take right now. */
  rebuildCount: number
  reclaimCount: number
  /** Every pane in the group — what "remove all panes" would take. */
  paneCount: number
}>()
const emit = defineEmits<{
  (e: 'rename'): void
  (e: 'move'): void
  (e: 'detach'): void
  (e: 'rebuild'): void
  (e: 'reclaim'): void
  (e: 'remove-panes'): void
  (e: 'close-panes'): void
  (e: 'dismiss'): void
}>()

const el = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

// Clamp into the viewport once rendered — a heading near the bottom of the
// sidebar would otherwise open the menu half off-screen.
onMounted(() => {
  void nextTick(() => {
    if (!el.value) return
    const r = el.value.getBoundingClientRect()
    const margin = 8
    if (pos.value.y + r.height > window.innerHeight) pos.value.y = Math.max(margin, window.innerHeight - r.height - margin)
    if (pos.value.x + r.width > window.innerWidth) pos.value.x = Math.max(margin, window.innerWidth - r.width - margin)
  })
})
</script>

<template>
  <Teleport to="body">
    <div class="rg-ctx-backdrop" @mousedown="emit('dismiss')" @contextmenu.prevent="emit('dismiss')" />
    <div
      ref="el"
      class="rg-ctx"
      role="menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @click.stop
      @mousedown.stop
    >
      <button class="rg-ctx-item" role="menuitem" :disabled="!canRename" @click="emit('rename')">{{ $t('stageTab.rename') }}</button>
      <button class="rg-ctx-item" role="menuitem" :disabled="!canDetach" @click="emit('detach')">{{ $t('stageTab.open-in-window') }}</button>
      <div class="rg-ctx-sep" />
      <button class="rg-ctx-item" role="menuitem" :disabled="rebuildCount === 0" @click="emit('rebuild')">{{ $t('stageTab.rebuild-panes', { count: rebuildCount }) }}</button>
      <button class="rg-ctx-item" role="menuitem" :disabled="reclaimCount === 0" @click="emit('reclaim')">{{ $t('stageTab.reclaim-panes', { count: reclaimCount }) }}</button>
      <button class="rg-ctx-item danger" role="menuitem" :disabled="paneCount === 0" @click="emit('remove-panes')">{{ $t('stageTab.remove-panes', { count: paneCount }) }}</button>
      <div class="rg-ctx-sep" />
      <!-- The pair the workspace menu has (close / close with panes): the first
           keeps the panes by moving them to another group — the ✕ popover's
           "move to another group" — the second takes them with it. Emptying
           the group while it stays is "remove" in the batch block above. -->
      <button
        class="rg-ctx-item"
        role="menuitem"
        :disabled="!canMove"
        :title="$t('stageTab.close-group-title')"
        @click="emit('move')"
      >{{ $t('stageTab.close-group') }}</button>
      <button class="rg-ctx-item danger" role="menuitem" @click="emit('close-panes')">{{ $t('stageTab.close-group-and-panes') }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Same look as the pane context menu (.pane-ctx in App.vue), so the two
   right-click menus read as one family. */
.rg-ctx-backdrop { position: fixed; inset: 0; z-index: 999; }
.rg-ctx {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  min-width: 170px;
  user-select: none;
}
.rg-ctx-item {
  padding: 6px 14px;
  border: none;
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: var(--font-xs);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.rg-ctx-item:hover:not(:disabled) { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.rg-ctx-item.danger { color: var(--danger-bright); }
.rg-ctx-item.danger:hover { background: var(--danger-emphasis); color: var(--text-on-emphasis); }
.rg-ctx-item:disabled { opacity: 0.4; cursor: default; }
.rg-ctx-sep { height: 1px; background: var(--border-default); margin: 4px 0; }
</style>
