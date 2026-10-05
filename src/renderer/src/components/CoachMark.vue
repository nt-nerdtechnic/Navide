<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { findTourAnchor } from '../lib/tours'
import {
  COACH_DONE_MS,
  COACH_MISSING_SKIP_MS,
  COACH_TICK_MS,
  welcomeActionAlreadyDone,
  welcomeActionDone,
  type CoachStep,
  type WelcomeFacts,
} from '../lib/welcomeTour'

// Coach marks: a small bubble beside the real control, saying the one thing
// to do there. Nothing is dimmed and nothing is blocked — the layer and the
// ring around the control let every click through, and no key is taken — so
// the person does the step in the real window. Once the host's facts say it
// is done, the bubble says so for a moment and moves on to the next control.
// A step already done when it comes up is passed over.
//
// Skip (or Esc, unless the focus is in a terminal, where Esc belongs to the
// CLI) ends the tour. A replay adds Next, to read it through without doing
// anything. Steps are data (lib/welcomeTour.ts).

const props = withDefaults(
  defineProps<{
    steps: CoachStep[]
    /** The window as the tour sees it; read inside a reactive watch. */
    facts: () => WelcomeFacts
    startIndex?: number
    /** A replay from the Help menu: Next is offered. */
    replay?: boolean
    /** Something else needs the screen: draw nothing, take no keys. */
    suspended?: boolean
  }>(),
  { startIndex: 0, replay: false, suspended: false },
)
const emit = defineEmits<{
  /** The tour moved on to this step. */
  progress: [index: number]
  /** `completed` is true when the last step was done. */
  finish: [completed: boolean]
}>()

const { t } = useI18n()

const index = ref(props.startIndex)
const step = computed<CoachStep | undefined>(() => props.steps[index.value])
const enteredAt = ref(0)
const doneShown = ref(false)
const rect = ref<DOMRect | null>(null)
const targetId = ref('')

let doneTimer: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null
// When the current skipIfMissing step first found its control absent (0 = present).
let missingSince = 0
let ended = false

function end(completed: boolean): void {
  if (ended) return
  ended = true
  emit('finish', completed)
}

function enter(): void {
  if (doneTimer) clearTimeout(doneTimer)
  doneTimer = null
  doneShown.value = false
  missingSince = 0
  enteredAt.value = Date.now()
  rect.value = null
  targetId.value = ''
  const current = step.value
  if (!current) {
    end(true)
    return
  }
  if (welcomeActionAlreadyDone(current.waitFor, props.facts())) {
    advance()
    return
  }
  locate()
}

function advance(): void {
  if (ended) return
  if (index.value >= props.steps.length - 1) {
    end(true)
    return
  }
  index.value++
  emit('progress', index.value)
  enter()
}

/** Find the step's control again: it may have moved, appeared or gone. */
function locate(): void {
  const current = step.value
  if (!current || ended) return
  const el = findTourAnchor(current.anchor(props.facts()))
  if (el) {
    rect.value = el.getBoundingClientRect()
    targetId.value = el.id
    missingSince = 0
    return
  }
  rect.value = null
  targetId.value = ''
  if (!current.skipIfMissing || doneShown.value) return
  const now = Date.now()
  if (!missingSince) missingSince = now
  else if (now - missingSince >= COACH_MISSING_SKIP_MS) advance()
}

// The step's action happened: say so, then move on.
watch(
  () => !!step.value && welcomeActionDone(step.value.waitFor, props.facts(), enteredAt.value),
  (done) => {
    if (!done || doneShown.value || ended) return
    doneShown.value = true
    doneTimer = setTimeout(() => {
      doneTimer = null
      advance()
    }, COACH_DONE_MS)
  },
)

function onKeydown(e: KeyboardEvent): void {
  if (props.suspended || e.key !== 'Escape') return
  const focus = document.activeElement
  if (focus instanceof Element && focus.closest('.xterm')) return
  end(false)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  ticker = setInterval(locate, COACH_TICK_MS)
  enter()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (ticker) clearInterval(ticker)
  if (doneTimer) clearTimeout(doneTimer)
})

const PAD = 4
const GAP = 10
const BUBBLE_W = 280
// A generous guess at the bubble's height: only used to decide above/below.
const BUBBLE_H = 140

const ringStyle = computed((): Record<string, string> => {
  const r = rect.value
  if (!r) return { pointerEvents: 'none' }
  return {
    pointerEvents: 'none',
    top: `${r.top - PAD}px`,
    left: `${r.left - PAD}px`,
    width: `${r.width + PAD * 2}px`,
    height: `${r.height + PAD * 2}px`,
  }
})

const bubbleStyle = computed((): Record<string, string> => {
  const r = rect.value
  if (!r) return { pointerEvents: 'auto' }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(GAP, Math.min(r.left, vw - BUBBLE_W - GAP))
  const below = r.bottom + PAD + GAP
  const top = below + BUBBLE_H <= vh ? below : Math.max(GAP, r.top - PAD - GAP - BUBBLE_H)
  return { pointerEvents: 'auto', top: `${top}px`, left: `${left}px` }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="!suspended && rect && step" class="coach" data-testid="coach-layer" style="pointer-events: none">
      <div class="coach-ring" data-testid="coach-ring" :data-target="targetId" :style="ringStyle"></div>
      <div
        class="coach-bubble"
        data-testid="coach-bubble"
        :data-step="step.id"
        :style="bubbleStyle"
        role="status"
        aria-live="polite"
      >
        <p class="coach-progress">{{ t('tour.progress', { n: index + 1, total: steps.length }) }}</p>
        <p class="coach-text">{{ t(step.textKey) }}</p>
        <p v-if="doneShown" class="coach-done" data-testid="coach-done">{{ t('tour.welcome.doneFeedback') }}</p>
        <div class="coach-actions">
          <button type="button" class="coach-link" data-testid="coach-skip" @click="end(false)">
            {{ t('tour.skip') }}
          </button>
          <button v-if="replay" type="button" class="coach-link" data-testid="coach-next" @click="advance">
            {{ t('tour.welcome.next') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.coach {
  position: fixed;
  inset: 0;
  /* Below every modal: the tour steps aside for them (App suspends it). */
  z-index: calc(var(--z-modal) - 1);
  font-family: var(--font-ui);
}
.coach-ring {
  position: absolute;
  border: 2px solid var(--accent-fg);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 22%, transparent);
  transition: top 0.18s ease, left 0.18s ease, width 0.18s ease, height 0.18s ease;
}
.coach-bubble {
  position: absolute;
  box-sizing: border-box;
  width: min(280px, calc(100vw - 20px));
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--accent-fg);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  padding: 10px 12px 8px;
  color: var(--text-bright);
  font-size: var(--font-sm);
  line-height: 1.5;
}
.coach-progress {
  margin: 0 0 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.coach-text {
  margin: 0;
}
.coach-done {
  margin: 6px 0 0;
  color: var(--success-fg);
  font-weight: 600;
}
.coach-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 6px;
}
.coach-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
  text-decoration: underline;
}
.coach-link:hover,
.coach-link:focus-visible {
  color: var(--text-bright);
}
</style>
