<script setup lang="ts">
// The Settings dialog, drawn rather than captured: the grouped nav down the
// left and one section's header plus body on the right. Callers put the
// section's own content (MockCardRow rows, for instance) in the default slot.
//
// Mirrors SettingsModal.vue: `.s-modal.nv-modal-shell--wide` (:1899), the
// `.s-sidebar` with its `.s-ws-header` title row (:1902) and the `.s-nav`
// groups of `SettingsNavItem` (:1940, group title at :1992), and a section
// body's `.mcp-topbar` with `.mcp-page-title` and its `.mcp-action-btn`
// actions (:2060). The optional search box is `.s-search-box` with its
// `.s-search-results` dropdown and `.s-search-empty` row (:1913-1938).
//
// Two shapes, one component: pass `navGroup` + `nav` for a picture about one
// page inside Settings, or `groups` (+ optionally `search`) when the picture
// is about the nav itself. Passing no `pageTitle` and no slot drops the right
// half, leaving the sidebar alone.
defineProps<{
  /** Dialog title, i.e. the label above the nav. */
  navTitle: string
  /** Nav group heading. One group; use `groups` for the whole nav. */
  navGroup?: string
  /** Nav entries, in the order the real nav lists them. */
  nav?: { label: string; active?: boolean }[]
  /** Every group, when the picture is about the nav itself rather than about
   *  one page inside it. Takes the place of `navGroup` + `nav`. */
  groups?: { title: string; items: { label: string; active?: boolean }[] }[]
  /** The search box above the nav, with the results it drops down. */
  search?: {
    placeholder: string
    query?: string
    results?: { title: string; group: string }[]
    empty?: string
    mark?: string
  }
  /** Section header on the right. */
  pageTitle: string
  /** Buttons in the section's top bar. */
  actions?: string[]
  navMark?: string
  bodyMark?: string
}>()
</script>

<template>
  <div class="mk-set">
    <aside class="mk-set-side">
      <div class="mk-set-head">
        <span class="mk-set-avatar" aria-hidden="true">⚙</span>
        <span class="mk-set-name">{{ navTitle }}</span>
        <span v-if="navMark" class="mk-set-mark">{{ navMark }}</span>
      </div>
      <div v-if="search" class="mk-set-search">
        <div class="mk-set-searchbox">
          <span class="mk-set-searchglyph" aria-hidden="true">⌕</span>
          <span :class="search.query ? 'mk-set-query' : 'mk-set-placeholder'">{{
            search.query || search.placeholder
          }}</span>
          <span v-if="search.mark" class="mk-set-mark">{{ search.mark }}</span>
        </div>
        <div v-if="search.results?.length || search.empty" class="mk-set-results">
          <span v-for="hit in search.results ?? []" :key="hit.title" class="mk-set-result">
            <span class="mk-set-result-title">{{ hit.title }}</span>
            <span class="mk-set-result-group">{{ hit.group }}</span>
          </span>
          <span v-if="search.empty" class="mk-set-result-empty">{{ search.empty }}</span>
        </div>
      </div>

      <template v-if="groups?.length">
        <template v-for="group in groups" :key="group.title">
          <div class="mk-set-grouptitle">{{ group.title }}</div>
          <span
            v-for="item in group.items"
            :key="item.label"
            class="mk-set-navitem"
            :class="{ on: item.active }"
          >{{ item.label }}</span>
        </template>
      </template>
      <template v-else>
        <div v-if="navGroup" class="mk-set-grouptitle">{{ navGroup }}</div>
        <span
          v-for="item in nav ?? []"
          :key="item.label"
          class="mk-set-navitem"
          :class="{ on: item.active }"
        >{{ item.label }}</span>
      </template>
    </aside>

    <div v-if="$slots.default || pageTitle" class="mk-set-main">
      <div class="mk-set-topbar">
        <span class="mk-set-pagetitle">{{ pageTitle }}</span>
        <span class="mk-set-gap" />
        <span v-for="action in actions ?? []" :key="action" class="mk-set-btn">{{ action }}</span>
      </div>
      <div class="mk-set-body">
        <slot />
        <span v-if="bodyMark" class="mk-set-mark mk-set-mark--body">{{ bodyMark }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mk-set {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
  min-width: 0;
}

.mk-set-side {
  flex: 0 0 30%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15em;
  padding: 0.5em 0.4em;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
}
.mk-set-head {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0 0.25em 0.45em;
  min-width: 0;
}
.mk-set-avatar { flex: none; color: var(--text-secondary); }
.mk-set-name {
  color: var(--text-bright);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-set-search {
  display: flex;
  flex-direction: column;
  gap: 0.3em;
  padding: 0 0.25em 0.4em;
  min-width: 0;
}
.mk-set-searchbox {
  display: flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.2em 0.4em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  min-width: 0;
}
.mk-set-searchglyph { flex: none; color: var(--text-muted); }
.mk-set-placeholder {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-set-query {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mk-set-results {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-overlay);
  box-shadow: 0 2px 8px var(--shadow-overlay);
  overflow: hidden;
}
.mk-set-result {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  padding: 0.2em 0.45em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.mk-set-result:last-child { border-bottom: none; }
.mk-set-result-title {
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-set-result-group { flex: none; color: var(--text-muted); font-size: 0.85em; }
.mk-set-result-empty {
  padding: 0.2em 0.45em;
  color: var(--text-muted);
}

.mk-set-grouptitle {
  padding: 0.2em 0.35em;
  color: var(--text-muted);
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mk-set-navitem {
  padding: 0.25em 0.45em;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-set-navitem.on {
  background: var(--bg-selected);
  color: var(--text-bright);
}

.mk-set-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.mk-set-topbar {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.45em 0.55em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-set-pagetitle {
  color: var(--text-bright);
  font-weight: 600;
  white-space: nowrap;
}
.mk-set-gap { flex: 1; }
.mk-set-btn {
  flex: none;
  padding: 0.1em 0.45em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  white-space: nowrap;
}

.mk-set-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  padding: 0.5em;
  background: var(--bg-inset);
  min-width: 0;
}

.mk-set-mark { color: var(--accent-fg); font-size: 1.1em; flex: none; }
.mk-set-mark--body {
  position: absolute;
  right: 0.3em;
  bottom: 0.15em;
}
</style>
