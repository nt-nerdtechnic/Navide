<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { useReview } from '../composables/useReview'
import type { useBackend } from '../composables/useBackend'
import type { useGit } from '../composables/useGit'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  gitStatus: ReturnType<typeof useGit>['gitStatus']['value']
  gitBranches: ReturnType<typeof useGit>['gitBranches']['value']
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { isReviewing, reviewText, reviewError, startReview, stopReview } = useReview(props.backend)

const mode = ref<'working' | 'branch'>('working')
const baseBranch = ref('main')
const compareBranch = ref('')

// Model picker
type ProviderKey = 'ollama' | 'anthropic' | 'openai' | 'google' | 'groq' | 'deepseek' | 'mistral' | 'xai' | 'openai_compatible'

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  ollama: 'Ollama (Local)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral AI',
  xai: 'xAI (Grok)',
  openai_compatible: 'Custom (OpenAI-compatible)',
}

const PROVIDER_MODELS: Partial<Record<ProviderKey, string[]>> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  xai: ['grok-3-mini', 'grok-3', 'grok-2'],
}

const provider = ref<ProviderKey>('ollama')
const currentModel = ref('')
const ollamaModels = ref<string[]>([])

const staticModels = computed(() => PROVIDER_MODELS[provider.value] ?? [])

onMounted(async () => {
  const r = await props.backend.send<Record<string, string>>('ai.chat.settings.get', {})
  if (r.ok && r.payload?.ok) {
    const p = r.payload.provider as ProviderKey
    if (p) provider.value = p
    if (r.payload.model) currentModel.value = r.payload.model
  }
  const mr = await props.backend.send<{ ok: boolean; models?: { name: string }[] }>('analyzer.models', {})
  if (mr.ok && mr.payload?.models) {
    ollamaModels.value = mr.payload.models.map((m: { name: string }) => m.name).filter(Boolean)
  }
})

async function saveModel() {
  await props.backend.send('ai.chat.settings.set', {
    provider: provider.value,
    model: currentModel.value,
  })
}

const outputEl = ref<HTMLElement | null>(null)

const localBranches = computed(() =>
  (props.gitBranches as { name: string; is_remote: boolean; is_current: boolean }[])
    .filter(b => !b.is_remote)
    .map(b => b.name)
)

const currentBranch = computed(() =>
  (props.gitBranches as { name: string; is_current: boolean }[]).find(b => b.is_current)?.name ?? ''
)

async function doReview() {
  await startReview({
    workspacePath: props.workspacePath,
    mode: mode.value,
    base: mode.value === 'branch' ? baseBranch.value : undefined,
    compare: mode.value === 'branch' ? (compareBranch.value || currentBranch.value) : undefined,
  })
  await nextTick()
  outputEl.value?.scrollTo({ top: 0 })
}

// Minimal markdown → HTML renderer (handles review output patterns only).
// Only processes trusted AI-generated text; no user-supplied input.
function renderMd(text: string): string {
  if (!text) return ''
  const lines = text.split('\n')
  const out: string[] = []
  let inList = false

  for (const raw of lines) {
    // Close list if line is not a list item
    if (inList && !raw.trimStart().startsWith('- ') && !raw.trimStart().startsWith('* ')) {
      out.push('</ul>')
      inList = false
    }

    let line = escHtml(raw)

    // Headings
    if (raw.startsWith('### ')) {
      out.push(`<h3>${escHtml(raw.slice(4))}</h3>`)
      continue
    }
    if (raw.startsWith('## ')) {
      out.push(`<h2>${escHtml(raw.slice(3))}</h2>`)
      continue
    }
    if (raw.startsWith('# ')) {
      out.push(`<h2>${escHtml(raw.slice(2))}</h2>`)
      continue
    }

    // List items
    if (raw.trimStart().startsWith('- ') || raw.trimStart().startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true }
      const content = applyInline(escHtml(raw.trimStart().slice(2)))
      out.push(`<li>${content}</li>`)
      continue
    }

    // Horizontal rule
    if (/^-{3,}$/.test(raw.trim()) || /^\*{3,}$/.test(raw.trim())) {
      out.push('<hr>')
      continue
    }

    // Empty line → paragraph break
    if (!raw.trim()) {
      out.push('<br>')
      continue
    }

    out.push(`<p>${applyInline(line)}</p>`)
  }

  if (inList) out.push('</ul>')
  return out.join('\n')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function applyInline(s: string): string {
  // **bold**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  // *italic*
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  return s
}
</script>

<template>
  <div class="review-pane">
    <!-- Header (hidden when embedded in a tabbed panel) -->
    <div v-if="!hideHeader" class="panel-header">
      <span class="panel-title">AI REVIEW</span>
      <div class="spacer" />
      <button class="hdr-btn" title="Close" @click="emit('close')">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/>
        </svg>
      </button>
    </div>

    <!-- Controls -->
    <div class="controls">
      <!-- Model picker row -->
      <div class="model-row">
        <select class="model-select" v-model="provider" @change="saveModel">
          <option v-for="(label, key) in PROVIDER_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
        <!-- Ollama: dynamic model list -->
        <select v-if="provider === 'ollama'" class="model-select model-select--flex" v-model="currentModel" @change="saveModel">
          <option v-for="m in ollamaModels" :key="m" :value="m">{{ m }}</option>
          <option v-if="currentModel && !ollamaModels.includes(currentModel)" :value="currentModel">{{ currentModel }}</option>
        </select>
        <!-- Custom OpenAI-compatible: free text input -->
        <input
          v-else-if="provider === 'openai_compatible'"
          class="model-select model-select--flex model-input"
          v-model="currentModel"
          placeholder="Model name (e.g. llama-3.3-70b)"
          @change="saveModel"
        />
        <!-- Cloud providers: static model list -->
        <select v-else class="model-select model-select--flex" v-model="currentModel" @change="saveModel">
          <option v-for="m in staticModels" :key="m" :value="m">{{ m }}</option>
          <option v-if="currentModel && !staticModels.includes(currentModel)" :value="currentModel">{{ currentModel }}</option>
        </select>
      </div>

      <!-- Mode label + branch toggle -->
      <div class="mode-row">
        <span class="mode-label">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;opacity:0.7">
            <path d="M2 2.5A2.5 2.5 0 1 1 5 5H4v1h6V5h-1a2.5 2.5 0 1 1 2.5-2.5v.085l.447.224A1.5 1.5 0 0 1 13 4.5V8a1.5 1.5 0 0 1-1.5 1.5H10v1h.5A1.5 1.5 0 0 1 12 12v1.5a2.5 2.5 0 1 1-1 0V12a.5.5 0 0 0-.5-.5H5.5A.5.5 0 0 0 5 12v1.5a2.5 2.5 0 1 1-1 0V12a1.5 1.5 0 0 1 1.5-1.5H6v-1H4.5A1.5 1.5 0 0 1 3 8V4.5a1.5 1.5 0 0 1 .553-1.191L4 3.085V2.5A2.5 2.5 0 0 1 2 2.5z"/>
          </svg>
          {{ mode === 'working' ? 'Working Changes' : `${baseBranch} → ${compareBranch || currentBranch}` }}
        </span>
        <button class="branch-toggle" @click="mode = mode === 'branch' ? 'working' : 'branch'">
          {{ mode === 'branch' ? '✕ Cancel' : '↔ Branch Diff' }}
        </button>
      </div>

      <!-- Branch selectors (branch mode only) -->
      <div v-if="mode === 'branch'" class="branch-row">
        <span class="branch-label">Base</span>
        <select class="branch-select" v-model="baseBranch">
          <option v-for="b in localBranches" :key="b" :value="b">{{ b }}</option>
          <option v-if="!localBranches.includes('main')" value="main">main</option>
          <option v-if="!localBranches.includes('master')" value="master">master</option>
        </select>
        <span class="branch-arrow">→</span>
        <select class="branch-select" v-model="compareBranch">
          <option value="">{{ currentBranch || 'HEAD' }} (current)</option>
          <option v-for="b in localBranches" :key="b" :value="b">{{ b }}</option>
        </select>
      </div>

      <!-- Action buttons -->
      <div class="action-row">
        <button
          v-if="!isReviewing"
          class="btn-primary"
          :disabled="!workspacePath"
          @click="doReview"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="margin-right:5px">
            <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7 5v3.5l3 1.5-.5 1L6 9V5z"/>
          </svg>
          Start Review
        </button>
        <button v-else class="btn-stop" @click="stopReview">Stop</button>
        <span v-if="isReviewing" class="reviewing-indicator">Reviewing…</span>
      </div>
    </div>

    <!-- Error -->
    <div v-if="reviewError" class="review-error">{{ reviewError }}</div>

    <!-- Output -->
    <div ref="outputEl" class="review-output">
      <div v-if="!reviewText && !isReviewing && !reviewError" class="empty-hint">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.3;margin-bottom:8px">
          <path d="M1.5 2.75C1.5 1.784 2.284 1 3.25 1h9.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 12.75 12H9.06l.72 1.5h1.47a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5h1.47L6.94 12H3.25A1.75 1.75 0 0 1 1.5 10.25v-7.5zm1.5 0v7.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-9.5a.25.25 0 0 0-.25.25z"/>
        </svg>
        <p>Click <strong>Start Review</strong> to analyse your working changes, or use <strong>↔ Branch Diff</strong> to compare branches.</p>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="md-body" v-html="renderMd(reviewText)" />
      <div v-if="isReviewing" class="cursor-blink">▌</div>
    </div>
  </div>
</template>

<style scoped>
.review-pane {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-base); color: var(--text-primary);
  font-size: 12px; overflow: hidden;
}

/* Re-use panel-header / hdr-btn / panel-title from GitPane */
.panel-header {
  display: flex; align-items: center; gap: 2px;
  padding: 1px 6px; border-bottom: 1px solid var(--border-muted);
  min-height: 24px; flex-shrink: 0; background: var(--bg-base);
}
.panel-title {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1px; color: var(--text-secondary); padding: 0 4px;
}
.spacer { flex: 1; }
.hdr-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: transparent; border: none;
  border-radius: 4px; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0;
}
.hdr-btn:hover { color: var(--text-primary); background: rgba(177,186,196,0.1); }

/* Controls */
.controls {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 8px 6px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.model-row {
  display: flex; align-items: center; gap: 4px;
}
.model-select {
  padding: 2px 4px; font-size: 11px;
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 4px; color: var(--text-primary); cursor: pointer; min-width: 0;
}
.model-select--flex { flex: 1; }
.model-input { font-family: inherit; }
.mode-row {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.mode-label {
  display: flex; align-items: center; font-size: 11px; font-weight: 600;
  color: var(--text-primary);
}
.branch-toggle {
  padding: 2px 7px; font-size: 10px; border-radius: 4px;
  border: 1px solid var(--border-default); background: transparent;
  color: var(--text-muted); cursor: pointer; white-space: nowrap;
}
.branch-toggle:hover { color: var(--accent-fg); border-color: var(--accent-emphasis); }
.branch-row {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
}
.branch-label { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.branch-arrow { color: var(--text-muted); font-size: 11px; }
.branch-select {
  flex: 1; min-width: 80px; padding: 2px 4px; font-size: 11px;
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: 4px; color: var(--text-primary); cursor: pointer;
}
.action-row { display: flex; align-items: center; gap: 8px; }
.btn-primary {
  display: flex; align-items: center; padding: 4px 10px; font-size: 11px; font-weight: 600;
  background: var(--success-emphasis); color: #fff; border: none; border-radius: 5px; cursor: pointer;
}
.btn-primary:hover { background: var(--success-strong); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-stop {
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  background: var(--danger-subtle); color: var(--danger-fg);
  border: 1px solid var(--danger-muted); border-radius: 5px; cursor: pointer;
}
.btn-stop:hover { background: var(--danger-emphasis); color: #fff; }
.reviewing-indicator {
  font-size: 11px; color: var(--text-muted); font-style: italic;
}

/* Error */
.review-error {
  padding: 6px 10px; font-size: 11px; color: var(--danger-fg);
  background: var(--danger-subtle); border-bottom: 1px solid var(--danger-muted);
  flex-shrink: 0;
}

/* Output */
.review-output {
  flex: 1; overflow-y: auto; padding: 12px 14px;
  position: relative;
}
.empty-hint {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; color: var(--text-muted); font-size: 12px; text-align: center; gap: 4px;
}
.empty-hint p { max-width: 220px; line-height: 1.6; }
.cursor-blink {
  display: inline-block; color: var(--accent-fg);
  animation: blink 0.8s step-start infinite;
}
@keyframes blink { 50% { opacity: 0; } }

/* Markdown body */
.md-body :deep(h2) {
  font-size: 13px; font-weight: 700; color: var(--text-bright);
  margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border-muted);
}
.md-body :deep(h3) {
  font-size: 12px; font-weight: 600; color: var(--accent-fg);
  margin: 10px 0 4px;
}
.md-body :deep(p) {
  margin: 0 0 6px; line-height: 1.6; color: var(--text-primary);
}
.md-body :deep(strong) { font-weight: 700; color: var(--text-bright); }
.md-body :deep(em) { font-style: italic; color: var(--text-secondary); }
.md-body :deep(code) {
  font-family: monospace; font-size: 11px;
  background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px;
  color: var(--accent-bright);
}
.md-body :deep(ul) { margin: 4px 0 8px 16px; padding: 0; }
.md-body :deep(li) { margin: 3px 0; line-height: 1.5; color: var(--text-primary); }
.md-body :deep(hr) {
  border: none; border-top: 1px solid var(--border-muted); margin: 10px 0;
}
.md-body :deep(br) { display: block; content: ''; margin: 4px 0; }
</style>
