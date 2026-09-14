<script setup lang="ts">
// Frame, numbered key and caption shared by every Settings → Help mock
// screenshot. The picture itself is drawn by whatever sits in the default
// slot; this component only supplies the surround, so a mock never has to
// restate the border, the ①②③ key or the caption typography.
//
// The legend arrives as data rather than as slotted markup: slot content
// carries the CALLER's scope id, so list styling declared here would not
// reach it.
defineProps<{
  /** One-line explanation printed under the picture. */
  caption: string
  /** Optional key: one row per marked region, in mark order. */
  legend?: { mark: string; label: string; text: string }[]
}>()
</script>

<template>
  <figure class="mk-fig">
    <div class="mk-fig-frame"><slot /></div>
    <ol v-if="legend?.length" class="mk-fig-legend">
      <li v-for="item in legend" :key="item.mark">
        <span class="mk-fig-mark">{{ item.mark }}</span>
        <span><strong>{{ item.label }}</strong> — {{ item.text }}</span>
      </li>
    </ol>
    <figcaption class="mk-fig-cap">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.mk-fig {
  margin: 2px 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}

/* The mock's own type scale. Everything inside sizes itself in `em`, so the
   whole picture shrinks with the dialog instead of overflowing it. */
.mk-fig-frame {
  font-size: var(--font-2xs);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  padding: 0.9em;
  min-width: 0;
  overflow: hidden;
}

.mk-fig-legend {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-secondary);
}
.mk-fig-legend li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.mk-fig-mark {
  flex: none;
  color: var(--accent-fg);
  font-size: var(--font-sm);
}
.mk-fig-legend strong { color: var(--text-primary); }

.mk-fig-cap {
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-muted);
}
</style>
