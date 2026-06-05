<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useNotify } from '../composables/useNotify'
import EditorView from './view/EditorView.vue'
import type { Range } from './types'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  relPath: string
  name: string
  initialLine?: number
}>()

const { toast, alert } = useNotify()

const content = ref('')
const dirty = ref(false)
const loadError = ref('')
const loaded = ref(false)
const editorRef = ref<InstanceType<typeof EditorView> | null>(null)

const model = 'llama3.2' // analyzer's default; rewrite/complete proxy to local LLM
const lang = computed(() => props.name.split('.').pop() ?? '')

interface FsRead { ok: boolean; content?: string; error?: string }
interface AiResult { ok: boolean; text?: string; error?: string }

async function load(): Promise<void> {
  try {
    const resp = await props.backend.send<FsRead>('fs.read_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    if (!resp.payload?.ok) {
      loadError.value = resp.payload?.error || '無法讀取檔案'
      return
    }
    content.value = resp.payload.content ?? ''
    loaded.value = true
    if (props.initialLine && props.initialLine > 0) {
      await nextTick()
      editorRef.value?.revealLine(props.initialLine)
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '讀取檔案失敗'
  }
}

function onChange(v: string): void {
  content.value = v
  dirty.value = true
}

async function save(): Promise<void> {
  if (!dirty.value) return
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
    workspace_path: props.workspacePath,
    rel_path: props.relPath,
    content: content.value,
  })
  if (!resp.payload?.ok) {
    void alert(resp.payload?.error || '存檔失敗', { title: '存檔錯誤' })
    return
  }
  dirty.value = false
  toast('已存檔', { type: 'success' })
}

// ── Cmd+K rewrite ─────────────────────────────────────────────────────────────
const cmdk = ref<{ open: boolean; instruction: string; busy: boolean; range: Range | null; code: string }>(
  { open: false, instruction: '', busy: false, range: null, code: '' }
)
const proposal = ref<{ range: Range; oldText: string; newText: string } | null>(null)
const cmdkInput = ref<HTMLInputElement | null>(null)

function openCmdK(): void {
  const range = editorRef.value?.getSelectionRange() ?? null
  const code = editorRef.value?.getSelectionText() ?? ''
  cmdk.value = { open: true, instruction: '', busy: false, range, code }
  proposal.value = null
  void Promise.resolve().then(() => cmdkInput.value?.focus())
}
function closeCmdK(): void {
  cmdk.value.open = false
  editorRef.value?.focus()
}

async function submitCmdK(): Promise<void> {
  if (!cmdk.value.instruction.trim()) return
  if (!cmdk.value.range || !cmdk.value.code) {
    void alert('請先選取要改寫的程式碼', { title: 'Cmd+K' })
    return
  }
  cmdk.value.busy = true
  const resp = await props.backend.send<AiResult>('editor.rewrite', {
    code: cmdk.value.code,
    instruction: cmdk.value.instruction,
    language: lang.value,
    model,
  })
  cmdk.value.busy = false
  if (!resp.payload?.ok || !resp.payload.text) {
    void alert(resp.payload?.error || '改寫失敗', { title: 'Cmd+K' })
    return
  }
  proposal.value = { range: cmdk.value.range, oldText: cmdk.value.code, newText: resp.payload.text }
  cmdk.value.open = false
}

function acceptProposal(): void {
  if (!proposal.value) return
  editorRef.value?.applyEditExternal(proposal.value.range, proposal.value.newText)
  proposal.value = null
  dirty.value = true
  editorRef.value?.focus()
}
function rejectProposal(): void {
  proposal.value = null
  editorRef.value?.focus()
}

// ── Ghost completion (Cmd/Ctrl+I) ────────────────────────────────────────────
const ghostBusy = ref(false)
async function requestGhost(): Promise<void> {
  const cur = editorRef.value?.getCursor()
  const value = editorRef.value?.getValue() ?? ''
  if (!cur) return
  const lines = value.split('\n')
  const prefix = [...lines.slice(0, cur.line), lines[cur.line]?.slice(0, cur.col) ?? ''].join('\n')
  const suffix = [lines[cur.line]?.slice(cur.col) ?? '', ...lines.slice(cur.line + 1)].join('\n')
  ghostBusy.value = true
  const resp = await props.backend.send<AiResult>('editor.complete', {
    prefix, suffix, language: lang.value, model,
  })
  ghostBusy.value = false
  if (resp.payload?.ok && resp.payload.text) {
    editorRef.value?.setGhost(resp.payload.text)
    editorRef.value?.focus()
  } else {
    toast(resp.payload?.error || '無補全建議', { type: 'info' })
  }
}

// ── Keyboard shortcuts (window-level) ─────────────────────────────────────────
function onKeydown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save() }
  else if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdK() }
  else if (mod && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); void requestGhost() }
}

onMounted(() => {
  document.title = `Editor · ${props.name}`
  window.addEventListener('keydown', onKeydown)
  // 編輯器為獨立視窗，開窗當下後端 WebSocket 通常尚未連上，
  // 若立即 send 會以「ws not open」reject 且不會重試，畫面卡在「載入中」。
  // 改為等 status 變 connected 後再讀檔。
  watch(
    () => props.backend.status.value,
    (s) => {
      if (s === 'connected' && !loaded.value && !loadError.value) void load()
    },
    { immediate: true },
  )
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="editor-pane">
    <!-- Tabs -->
    <div class="ep-tabs">
      <div class="ep-tab active">
        <span class="ep-tab-name">{{ name }}</span>
        <span v-if="dirty" class="ep-dirty" title="未存檔">●</span>
      </div>
      <div class="ep-spacer" />
      <button class="ep-act" :disabled="!dirty" title="存檔 (⌘S)" @click="save">儲存</button>
      <button class="ep-act" title="AI 補全 (⌘I)" :disabled="ghostBusy || !loaded" @click="requestGhost">
        {{ ghostBusy ? '…' : '✦ 補全' }}
      </button>
      <button class="ep-act" title="AI 改寫選取 (⌘K)" :disabled="!loaded" @click="openCmdK">✦ Cmd+K</button>
    </div>

    <!-- Editor -->
    <div class="ep-body">
      <div v-if="loadError" class="ep-error">{{ loadError }}</div>
      <EditorView
        v-else-if="loaded"
        ref="editorRef"
        :model-value="content"
        @update:model-value="onChange"
      />
      <div v-else class="ep-loading">載入中…</div>
    </div>

    <!-- Cmd+K bar -->
    <div v-if="cmdk.open" class="ep-cmdk">
      <span class="ep-cmdk-badge">✦ Cmd+K</span>
      <input
        ref="cmdkInput"
        v-model="cmdk.instruction"
        class="ep-cmdk-input"
        placeholder="描述你想對選取程式碼做的修改…"
        @keydown.enter="submitCmdK"
        @keydown.esc="closeCmdK"
      />
      <button class="ep-act primary" :disabled="cmdk.busy" @click="submitCmdK">{{ cmdk.busy ? '思考中…' : '改寫' }}</button>
      <button class="ep-act" @click="closeCmdK">取消</button>
    </div>

    <!-- AI diff proposal -->
    <div v-if="proposal" class="ep-proposal">
      <div class="ep-prop-head">
        <span>AI 建議改寫</span>
        <div class="ep-prop-actions">
          <button class="ep-act success" @click="acceptProposal">✓ 接受</button>
          <button class="ep-act" @click="rejectProposal">✕ 拒絕</button>
        </div>
      </div>
      <div class="ep-prop-diff">
        <pre class="ep-old">{{ proposal.oldText }}</pre>
        <pre class="ep-new">{{ proposal.newText }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
  color: var(--text-primary);
}
.ep-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 12px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
}
.ep-tab.active { border-color: var(--accent-emphasis); }
.ep-dirty { color: var(--attention-fg); font-size: 10px; }
.ep-spacer { flex: 1; }
.ep-act {
  font-size: 11.5px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ep-act:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ep-act:disabled { opacity: 0.5; cursor: default; }
.ep-act.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ep-act.success { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); }
.ep-body { flex: 1; position: relative; min-height: 0; }
.ep-error, .ep-loading { padding: 24px; color: var(--text-muted); font-size: 12px; }
.ep-error { color: var(--danger-fg); }

.ep-cmdk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.ep-cmdk-badge { font-size: 11px; font-weight: 700; color: var(--accent-fg); }
.ep-cmdk-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.ep-cmdk-input:focus { border-color: var(--accent-emphasis); }

.ep-proposal {
  flex-shrink: 0;
  max-height: 40%;
  overflow: auto;
  border-top: 1px solid var(--border-default);
  background: var(--bg-subtle);
}
.ep-prop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
}
.ep-prop-actions { display: flex; gap: 6px; }
.ep-prop-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border-muted); }
.ep-old, .ep-new {
  margin: 0;
  padding: 8px 12px;
  font: 12px/1.5 ui-monospace, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-base);
}
.ep-old { color: var(--diff-del-fg); background: var(--diff-del-bg); }
.ep-new { color: var(--diff-add-fg); background: var(--diff-add-bg); }
</style>
