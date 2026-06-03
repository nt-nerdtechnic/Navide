<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

export interface QuestionItem {
  prompt: string
  type: 'text' | 'choice'
  options: string[]
}

interface Props {
  visible: boolean
  questions: QuestionItem[]
  agentLabel?: string
  stageTitle?: string
  slotLabel?: string
  queueLen?: number
  paneId?: string
  /** When true the LLM is generating an answer — disable inputs, show spinner */
  autoMode?: boolean
  /** The LLM-generated answer text to display before auto-submit */
  autoText?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'answer', combined: string, answers: string[]): void
  (e: 'cancel'): void
}>()

const answers = ref<string[]>([])
const firstTextRef = ref<HTMLTextAreaElement | null>(null)

watch(
  () => [props.visible, props.questions],
  async ([vis, qs]) => {
    if (!vis) return
    answers.value = (qs as QuestionItem[]).map(() => '')
    await nextTick()
    firstTextRef.value?.focus()
  },
  { immediate: true, deep: true }
)

function setAnswer(i: number, value: string): void {
  if (i < 0 || i >= answers.value.length) return
  answers.value[i] = value
}

const allAnswered = computed(() =>
  props.questions.every((_, i) => (answers.value[i] ?? '').trim().length > 0)
)

function buildCombined(): string {
  // Single question → just the answer, no envelope (keeps it natural).
  if (props.questions.length === 1) return answers.value[0].trim()
  // Multi-question → numbered block so the agent can map back.
  return props.questions
    .map((q, i) => `Q${i + 1}. ${q.prompt}\nA${i + 1}. ${answers.value[i].trim()}`)
    .join('\n\n')
}

function submit(): void {
  if (!allAnswered.value) return
  emit('answer', buildCombined(), [...answers.value])
}

function extractDropPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const getPath = window.agentTeam?.getPathForFile
  if (!getPath) return []

  const sources: File[] = dt.items?.length
    ? Array.from(dt.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => f !== null)
    : Array.from(dt.files)

  return sources.map(f => getPath(f)).filter(Boolean)
}

function onAnswerDrop(i: number, e: DragEvent): void {
  const paths = extractDropPaths(e)
  if (!paths.length) return
  const el = e.target as HTMLTextAreaElement
  const cur = answers.value[i] ?? ''
  const start = el.selectionStart ?? cur.length
  setAnswer(i, cur.slice(0, start) + paths.join(' ') + cur.slice(start))
}

// e.g. "Claude (Architecture)" or just "Claude"
const headerLabel = computed(() => {
  const base = props.agentLabel || 'Agent'
  return props.slotLabel ? `${base} (${props.slotLabel})` : base
})
const counter = computed(() =>
  props.questions.length > 1 ? `${props.questions.length} questions` : ''
)
const queueBadge = computed(() =>
  (props.queueLen ?? 0) > 0 ? `+${props.queueLen} more waiting` : ''
)
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && questions.length > 0" class="modal" @keydown.esc="emit('cancel')">
      <div class="card">
        <header>
          <div class="who">
            <span class="dot"></span>
            <span class="title">
              <strong>{{ headerLabel }}</strong> is asking
              <span v-if="counter" class="count">· {{ counter }}</span>
              <span v-if="queueBadge" class="queue-badge">{{ queueBadge }}</span>
            </span>
            <span v-if="stageTitle" class="stage">{{ stageTitle }}</span>
          </div>
          <button class="x" @click="emit('cancel')" title="Dismiss without answering">✕</button>
        </header>

        <div class="questions">
          <section v-for="(q, i) in questions" :key="i" class="qcard">
            <div class="qhead">
              <span class="qnum">{{ questions.length > 1 ? `${i + 1}/${questions.length}` : '' }}</span>
              <div class="qprompt">{{ q.prompt }}</div>
            </div>
            <!-- Auto mode: read-only display -->
            <template v-if="autoMode">
              <div v-if="q.type === 'choice' && q.options.length > 0" class="choices">
                <button
                  v-for="opt in q.options"
                  :key="opt"
                  class="choice"
                  :class="{ picked: answers[i] === opt }"
                  disabled
                >
                  <span class="check">{{ answers[i] === opt ? '●' : '○' }}</span>
                  <span class="opt-text">{{ opt }}</span>
                </button>
              </div>
              <textarea v-else :value="answers[i] ?? ''" rows="3" disabled spellcheck="false"></textarea>
            </template>
            <!-- Manual mode: interactive -->
            <template v-else>
              <div v-if="q.type === 'choice' && q.options.length > 0" class="choices">
                <button
                  v-for="opt in q.options"
                  :key="opt"
                  class="choice"
                  :class="{ picked: answers[i] === opt }"
                  @click="setAnswer(i, opt)"
                >
                  <span class="check">{{ answers[i] === opt ? '●' : '○' }}</span>
                  <span class="opt-text">{{ opt }}</span>
                </button>
              </div>
              <textarea
                v-else
                :ref="(el) => i === 0 ? (firstTextRef = el as HTMLTextAreaElement) : null"
                :value="answers[i] ?? ''"
                @input="setAnswer(i, ($event.target as HTMLTextAreaElement).value)"
                rows="3"
                placeholder="Type your answer…"
                spellcheck="false"
                @keydown.meta.enter="submit"
                @keydown.ctrl.enter="submit"
                @dragover.prevent
                @drop.prevent="onAnswerDrop(i, $event)"
              ></textarea>
            </template>
          </section>
        </div>

        <!-- Auto-answer status bar -->
        <div v-if="autoMode" class="auto-bar">
          <span v-if="!autoText" class="auto-spinner">🤖 LLM 自動回覆中…</span>
          <span v-else class="auto-answer-preview">🤖 自動回覆：{{ autoText.slice(0, 120) }}{{ autoText.length > 120 ? '…' : '' }}</span>
        </div>

        <footer>
          <span v-if="autoMode" class="hint ok">🤖 全自動模式 — 即將自動送出</span>
          <span v-else-if="!allAnswered" class="hint">Answer all {{ questions.length }} question(s) to send.</span>
          <span v-else class="hint ok">⌘+Enter to send</span>
          <div class="actions">
            <button class="ghost" @click="emit('cancel')" :disabled="autoMode">Cancel</button>
            <button class="primary" :disabled="autoMode || !allAnswered" @click="submit">
              {{ questions.length > 1 ? `Send all ${questions.length} answers` : 'Send answer' }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-left: 4px solid #d29922;
  border-radius: 8px;
  width: min(620px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #21262d;
  background: #161b22;
}
.who {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #d29922;
  box-shadow: 0 0 0 4px rgba(210, 153, 34, 0.2);
}
.title strong {
  color: #d29922;
}
.title .count {
  color: #8b949e;
  font-weight: 400;
  margin-left: 4px;
}
.stage {
  font-size: 11px;
  color: #8b949e;
  margin-left: 4px;
}
.queue-badge {
  font-size: 11px;
  color: #f0883e;
  background: rgba(240, 136, 62, 0.15);
  border: 1px solid rgba(240, 136, 62, 0.35);
  border-radius: 10px;
  padding: 1px 7px;
  margin-left: 6px;
  font-weight: 500;
}
.x {
  background: transparent;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
}
.x:hover {
  background: #21262d;
  color: #e6edf3;
}
.questions {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.qcard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 6px;
}
.qhead {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.qnum {
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  color: #79c0ff;
  background: #1f3a5f;
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
.qprompt {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: #e6edf3;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: #21262d;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  line-height: 1.5;
  font-family: inherit;
}
.choice:hover:not(:disabled) {
  background: #1f3a5f;
  border-color: #1f6feb;
}
.choice.picked {
  background: #1f3a5f;
  border-color: #58a6ff;
}
.choice .check {
  color: #58a6ff;
  font-size: 12px;
  margin-top: 1px;
}
.choice.picked .check {
  color: #d29922;
}
.choice:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
textarea {
  background: #010409;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 8px 10px;
  border-radius: 6px;
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  resize: vertical;
  min-height: 60px;
}
textarea:focus {
  outline: none;
  border-color: #1f6feb;
}
.auto-bar {
  padding: 10px 18px;
  background: #0d2030;
  border-top: 1px solid #1f3a5f;
  font-size: 12px;
}
.auto-spinner {
  color: #79c0ff;
  animation: pulse 1.2s ease-in-out infinite;
}
.auto-answer-preview {
  color: #3fb950;
  font-family: Menlo, Monaco, monospace;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid #21262d;
  background: #0d1117;
}
.hint {
  flex: 1;
  font-size: 11px;
  color: #8b949e;
}
.hint.ok {
  color: #3fb950;
}
.actions {
  display: flex;
  gap: 8px;
}
button {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button.primary {
  background: #238636;
  border-color: #2ea043;
  color: #fff;
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: #2ea043;
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: #21262d;
}
</style>
