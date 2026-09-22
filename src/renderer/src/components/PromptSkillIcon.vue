<script setup lang="ts">
// One line-art glyph per builtin PromptSkillIcon name. Same house style as the
// other icon components: 16×16, currentColor stroke, round caps.
//
// A name that is not builtin is a custom icon — one character the user typed,
// rendered as text in the same 16×16 box so every call site can stay unaware
// of the difference.
import { computed } from 'vue'
import { isBuiltinPromptSkillIcon, type PromptSkillBuiltinIcon } from '../lib/promptSkills'

const props = defineProps<{ name: string }>()

const builtin = computed<PromptSkillBuiltinIcon | null>(() =>
  isBuiltinPromptSkillIcon(props.name) ? props.name : null,
)

const PATHS: Record<PromptSkillBuiltinIcon, string> = {
  // fast-forward — a task that keeps pushing ahead
  advance: 'M2.6 3.8 7 8l-4.4 4.2zM8.6 3.8 13 8l-4.4 4.2z',
  // check in a circle — verify / get to green
  green: 'M5.4 8.2 7.2 10l3.4-3.9',
  // magnifier — survey without changing anything
  scan: 'M10.2 10.2 13.6 13.6',
  // page with a folded corner — docs / reports
  doc: 'M4 2.2h5l3 3v8.6H4zM9 2.2v3.1h3M6 9.2h4M6 11.2h2.6',
  // cycle arrow — refactor / tidy in rounds
  refactor: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.4v2.6h-2.6',
  // pencil — a one-off prompt written on the spot
  edit: 'M11.1 2.5 13.5 4.9 6.2 12.2l-3.2 0.8 0.8-3.2zM9.9 3.7l2.4 2.4',
  // beetle — hunt and fix a defect
  bug: 'M5.3 6.4a2.7 2.7 0 0 1 5.4 0v2.3a2.7 2.7 0 0 1-5.4 0zM6.4 4.7 5.3 3.2M9.6 4.7l1.1-1.5M5.3 7.2H2.8M10.7 7.2h2.5M5.7 9.8 3.6 11.3M10.3 9.8l2.1 1.5',
  // flask — write or run tests
  test: 'M6.5 2.3v3.9L3.4 11.8a1.3 1.3 0 0 0 1.1 2h7a1.3 1.3 0 0 0 1.1-2L9.5 6.2V2.3M5.5 2.3h5M5.1 9.2h5.8',
  // rocket — ship it / release
  rocket: 'M8 1.9c2.1 1.8 3.2 4.1 3.2 6.4L8 11.4 4.8 8.3C4.8 6 5.9 3.7 8 1.9zM6.3 10.9 4.8 13.8l2.2-1M9.7 10.9l1.5 2.9-2.2-1M6.9 7.4a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0',
  // shield — security review / hardening
  shield: 'M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z',
  // lightning — performance work
  bolt: 'M9.3 1.8 4.3 9h3.1l-.7 5.2L11.7 7H8.6z',
  // two sparks — clean up / polish
  sparkle: 'M5.7 2.1 6.8 5l2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L1.7 6.1 4.6 5zM11.5 8.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z',
  // git graph — branch, rebase, merge work
  branch: 'M4.8 2.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M4.8 11.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M11.2 2.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M4.8 4.9v6.2M4.8 8.2h3.2a3.2 3.2 0 0 0 3.2-3.2',
  // cylinder — schema, queries, migrations
  database: 'M3.3 4.1c0-1.1 2.1-2 4.7-2s4.7.9 4.7 2-2.1 2-4.7 2-4.7-.9-4.7-2zM3.3 4.1v7.8c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2V4.1M3.3 8c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2',
  // prompt — run something in a shell
  terminal: 'M2.4 3h11.2v10H2.4zM4.9 6.2 7 8.3l-2.1 2.1M8.7 10.6h2.9',
  // globe — translation and locales
  globe: 'M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M2.3 8h11.4M8 2.1c1.6 1.6 2.5 3.7 2.5 5.9S9.6 12.3 8 13.9C6.4 12.3 5.5 10.2 5.5 8S6.4 3.7 8 2.1z',
  // bars — measure, analyse, report numbers
  chart: 'M2.7 13.3h10.6M4.9 11V7.3M8 11V3.7M11.1 11V6.1',
  // clock — anything scheduled or timed
  clock: 'M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M8 4.7V8l2.4 1.6',
  // padlock — auth, permissions, secrets
  lock: 'M4.1 7h7.8v6.5H4.1zM5.9 7V5.1a2.1 2.1 0 0 1 4.2 0V7M8 9.4v1.7',
  // box — dependencies, bundling, packaging
  package: 'M8 2.2 13.5 5v6L8 13.8 2.5 11V5zM2.5 5 8 7.8 13.5 5M8 7.8v6',
  // question mark — ask before acting
  question: 'M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M6.3 6.3a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.7M8 11.5v.1',
  // bulleted lines — plan, inventory, checklist
  list: 'M5.5 4.2h8.1M5.5 8h8.1M5.5 11.8h8.1M2.6 4.2h.1M2.6 8h.1M2.6 11.8h.1',
  // eye — review and watch without touching
  eye: 'M1.8 8s2.4-4.3 6.2-4.3S14.2 8 14.2 8s-2.4 4.3-6.2 4.3S1.8 8 1.8 8zM6.1 8a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0',
  // star — the one that matters most
  star: 'M8 2.2 9.8 5.9l4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z',
}
</script>

<template>
  <svg v-if="builtin" class="ps-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle v-if="builtin === 'green'" cx="8" cy="8" r="5.9" />
    <circle v-else-if="builtin === 'scan'" cx="7" cy="7" r="4.3" />
    <path :d="PATHS[builtin]" />
  </svg>
  <span v-else class="ps-glyph" aria-hidden="true">{{ name }}</span>
</template>

<style scoped>
.ps-icon {
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Custom icon: one character in the same box the SVG occupies, so a ring slot
   or a card head does not reflow when a skill switches between the two. */
.ps-glyph {
  display: block;
  width: 16px;
  height: 16px;
  font-size: 13px;
  line-height: 16px;
  text-align: center;
  overflow: hidden;
  /* Colour emoji ignore `color`; a text glyph should still follow the slot. */
  color: inherit;
}
</style>
