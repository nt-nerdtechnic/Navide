<script setup lang="ts">
// The main window's chrome, drawn in HTML: the custom titlebar (traffic
// lights on the left via hiddenInset, workspace name centred, gear on the
// right) and the status bar strip at the foot. The slotted body is the
// three-column shell between them.
//
// Mirrors App.vue: `.titlebar` (38px, absolute top — App.vue:18024),
// `.statusbar` (24px overlay — App.vue:17645) and the status bar's own
// left/right item groups (App.vue:17659 / :17733).
defineProps<{
  /** Workspace name in the titlebar. Omit to draw a body-only frame. */
  title?: string
  /** Key mark for the titlebar, e.g. '①'. */
  mark?: string
  /** Git branch pill, drawn with the real branch glyph. */
  branch?: string
  /** Remaining status bar items; `dot` draws the backend pill's state dot. */
  statusLeft?: { text: string; dot?: boolean }[]
  statusRight?: string[]
  statusMark?: string
}>()
</script>

<template>
  <div class="mk-win">
    <div v-if="title" class="mk-win-bar">
      <span class="mk-win-lights"><i /><i /><i /></span>
      <span class="mk-win-title">{{ title }}</span>
      <span class="mk-win-gear" aria-hidden="true">⚙</span>
      <span v-if="mark" class="mk-win-mark">{{ mark }}</span>
    </div>

    <div class="mk-win-body"><slot /></div>

    <div v-if="branch || statusLeft?.length || statusRight?.length" class="mk-win-status">
      <span v-if="statusMark" class="mk-win-mark mk-win-mark--status">{{ statusMark }}</span>
      <span v-if="branch" class="mk-sb-item">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {{ branch }}
      </span>
      <span v-for="item in statusLeft" :key="item.text" class="mk-sb-item">
        <span v-if="item.dot" class="mk-sb-dot" />{{ item.text }}
      </span>
      <span class="mk-sb-gap" />
      <span v-for="item in statusRight" :key="item" class="mk-sb-item">{{ item }}</span>
    </div>
  </div>
</template>

<style scoped>
.mk-win {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
  min-width: 0;
}

.mk-win-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.6em;
  height: 2.1em;
  padding: 0 0.7em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
}
.mk-win-lights { display: flex; gap: 0.35em; flex: none; }
.mk-win-lights i {
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: var(--border-strong);
}
.mk-win-title {
  flex: 1;
  text-align: center;
  color: var(--text-bright);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-win-gear { flex: none; color: var(--text-secondary); }

.mk-win-body {
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 0;
}

.mk-win-status {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.7em;
  height: 1.9em;
  padding: 0 0.7em;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-size: 0.92em;
  white-space: nowrap;
  overflow: hidden;
}
.mk-sb-item { display: inline-flex; align-items: center; gap: 0.3em; }
.mk-sb-dot {
  width: 0.45em;
  height: 0.45em;
  border-radius: 50%;
  background: var(--success-fg);
}
.mk-sb-gap { flex: 1; }

.mk-win-mark {
  color: var(--accent-fg);
  font-size: 1.1em;
  flex: none;
}
</style>
