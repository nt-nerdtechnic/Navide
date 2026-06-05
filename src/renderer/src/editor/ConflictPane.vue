<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useNotify } from '../composables/useNotify'
import {
  parseConflicts, buildResolved, countConflicts, hasConflicts,
  type FileSection, type ConflictChoice,
} from '../lib/conflict-parser'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  workspacePath: string
  filepath: string
  name: string
  backend: ReturnType<typeof useBackend>
  // injected by parent when merge is no longer in progress (abort)
  mergeAborted?: boolean
}>()

const emit = defineEmits<{ resolved: [] }>()

const notify = useNotify()

const content = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const applying = ref(false)

const sections = computed<FileSection[]>(() =>
  content.value !== null ? parseConflicts(content.value) : [],
)
const totalConflicts = computed(() => countConflicts(sections.value))

// per-conflict-index choice: 'ours' | 'theirs' | 'both' | 'manual'
const choices = ref(new Map<number, ConflictChoice>())
// per-conflict-index manual edit text
const manualEdits = ref(new Map<number, string>())
const editingIdx = ref<number | null>(null)
const editBuf = ref('')

const resolvedCount = computed(() => choices.value.size)
const allResolved = computed(() => resolvedCount.value >= totalConflicts.value && totalConflicts.value > 0)

async function loadFile(): Promise<void> {
  loading.value = true
  loadError.value = ''
  choices.value = new Map()
  manualEdits.value = new Map()
  editingIdx.value = null
  try {
    const resp = await props.backend.send<{ ok: boolean; content: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.filepath },
    )
    if (resp.ok && resp.payload?.ok) {
      const raw = resp.payload.content ?? ''
      if (!hasConflicts(raw)) {
        loadError.value = '此檔案目前沒有衝突標記'
      } else {
        content.value = raw
      }
    } else {
      loadError.value = resp.payload?.error || resp.error?.message || '無法讀取檔案'
    }
  } finally {
    loading.value = false
  }
}

watch(
  () => props.backend.status.value,
  (s) => { if (s === 'connected' && content.value === null && !loadError.value) void loadFile() },
  { immediate: true },
)
watch([() => props.filepath], () => {
  content.value = null
  loadError.value = ''
  void loadFile()
})

function choose(conflictIdx: number, choice: ConflictChoice): void {
  if (choice === 'manual') {
    const sec = sections.value.filter((s) => s.kind === 'conflict')[conflictIdx]
    if (sec?.kind === 'conflict') {
      editBuf.value = manualEdits.value.get(conflictIdx) ?? sec.ours.join('\n')
      editingIdx.value = conflictIdx
    }
    choices.value = new Map(choices.value).set(conflictIdx, 'manual')
  } else {
    editingIdx.value = null
    choices.value = new Map(choices.value).set(conflictIdx, choice)
  }
}

function saveManual(conflictIdx: number): void {
  manualEdits.value = new Map(manualEdits.value).set(conflictIdx, editBuf.value)
  editingIdx.value = null
}

function cancelManual(conflictIdx: number): void {
  // If no prior choice saved, revert to unresolved
  if (!manualEdits.value.has(conflictIdx)) {
    const next = new Map(choices.value)
    next.delete(conflictIdx)
    choices.value = next
  }
  editingIdx.value = null
}

async function applyAndStage(): Promise<void> {
  if (!allResolved.value || applying.value) return
  applying.value = true
  try {
    const resolved = buildResolved(sections.value, choices.value, manualEdits.value)
    const writeResp = await props.backend.send<{ ok: boolean; error?: string }>(
      'fs.write_file',
      { workspace_path: props.workspacePath, rel_path: props.filepath, content: resolved },
    )
    if (!(writeResp.ok && writeResp.payload?.ok)) {
      notify.toast(writeResp.payload?.error || '寫入失敗', { type: 'error' })
      return
    }
    const stageResp = await props.backend.send<{ ok: boolean; error?: string }>(
      'git.stage',
      { workspace_path: props.workspacePath, files: [props.filepath] },
    )
    if (!(stageResp.ok && stageResp.payload?.ok)) {
      notify.toast(stageResp.payload?.error || 'stage 失敗', { type: 'error' })
      return
    }
    notify.toast(`${props.name} 衝突已解決`, { type: 'success' })
    emit('resolved')
  } finally {
    applying.value = false
  }
}

// helpers to split sections by kind for rendering
interface RenderBlock {
  type: 'context' | 'conflict'
  conflictIdx?: number
  lines?: string[]
  ours?: string[]
  theirs?: string[]
  oursLabel?: string
  theirsLabel?: string
}

const blocks = computed<RenderBlock[]>(() => {
  let ci = 0
  return sections.value.map((s) => {
    if (s.kind === 'context') return { type: 'context', lines: s.lines }
    const b: RenderBlock = {
      type: 'conflict',
      conflictIdx: ci,
      ours: s.ours,
      theirs: s.theirs,
      oursLabel: s.oursLabel,
      theirsLabel: s.theirsLabel,
    }
    ci++
    return b
  })
})

function choiceOf(idx: number): ConflictChoice | undefined {
  return choices.value.get(idx)
}
</script>

<template>
  <div class="cp-root">
    <!-- Toolbar -->
    <div class="cp-toolbar">
      <span class="cp-badge conflict">CONFLICT</span>
      <span class="cp-filepath" :title="filepath">{{ filepath }}</span>
      <span class="cp-progress">{{ resolvedCount }} / {{ totalConflicts }} 已解決</span>
      <button
        class="cp-apply"
        :disabled="!allResolved || applying || !!mergeAborted"
        :title="allResolved ? '寫入並 stage 此檔案' : '請先解決所有衝突'"
        @click="applyAndStage"
      >
        {{ applying ? '套用中…' : 'Apply & Stage' }}
      </button>
      <button class="cp-reload" title="重新載入" @click="loadFile">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
      </button>
    </div>

    <!-- Body -->
    <div class="cp-body">
      <div v-if="loading" class="cp-msg">載入中…</div>
      <div v-else-if="mergeAborted" class="cp-msg warn">Merge 已中止，衝突已取消。</div>
      <div v-else-if="loadError" class="cp-msg err">{{ loadError }}</div>
      <div v-else-if="content === null" class="cp-msg">尚未載入</div>

      <template v-else>
        <div v-for="(block, bi) in blocks" :key="bi">
          <!-- Context block -->
          <div v-if="block.type === 'context'" class="cp-context">
            <pre class="cp-ctx-text">{{ block.lines!.join('\n') }}</pre>
          </div>

          <!-- Conflict block -->
          <div v-else class="cp-conflict" :class="{ resolved: choiceOf(block.conflictIdx!) !== undefined }">
            <!-- Conflict header -->
            <div class="cp-conflict-head">
              <span class="cp-ci-num">#{{ block.conflictIdx! + 1 }}</span>
              <span class="cp-head-label ours">◀ {{ block.oursLabel || 'HEAD (ours)' }}</span>
              <span class="cp-head-sep">vs</span>
              <span class="cp-head-label theirs">▶ {{ block.theirsLabel || 'theirs' }}</span>
              <div class="cp-conflict-actions">
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'ours' }"
                  @click="choose(block.conflictIdx!, 'ours')"
                >Accept Ours</button>
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'theirs' }"
                  @click="choose(block.conflictIdx!, 'theirs')"
                >Accept Theirs</button>
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'both' }"
                  @click="choose(block.conflictIdx!, 'both')"
                >Accept Both</button>
                <button
                  class="cp-btn edit-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'manual' }"
                  @click="choose(block.conflictIdx!, 'manual')"
                >Edit</button>
              </div>
            </div>

            <!-- Manual edit textarea -->
            <div v-if="editingIdx === block.conflictIdx" class="cp-manual-edit">
              <textarea
                v-model="editBuf"
                class="cp-manual-ta"
                spellcheck="false"
                rows="6"
              />
              <div class="cp-manual-actions">
                <button class="cp-btn primary" @click="saveManual(block.conflictIdx!)">確認</button>
                <button class="cp-btn" @click="cancelManual(block.conflictIdx!)">取消</button>
              </div>
            </div>

            <!-- Side-by-side diff -->
            <div v-else class="cp-sbs">
              <!-- Ours -->
              <div
                class="cp-side ours-side"
                :class="{
                  'side-chosen': choiceOf(block.conflictIdx!) === 'ours' || choiceOf(block.conflictIdx!) === 'both',
                  'side-rejected': choiceOf(block.conflictIdx!) === 'theirs',
                }"
              >
                <div v-for="(line, li) in block.ours" :key="li" class="cp-line">
                  <span class="cp-lno">{{ li + 1 }}</span>
                  <span class="cp-ltext">{{ line }}</span>
                </div>
                <div v-if="!block.ours!.length" class="cp-empty-side">(空)</div>
              </div>
              <!-- Theirs -->
              <div
                class="cp-side theirs-side"
                :class="{
                  'side-chosen': choiceOf(block.conflictIdx!) === 'theirs' || choiceOf(block.conflictIdx!) === 'both',
                  'side-rejected': choiceOf(block.conflictIdx!) === 'ours',
                }"
              >
                <div v-for="(line, li) in block.theirs" :key="li" class="cp-line">
                  <span class="cp-lno">{{ li + 1 }}</span>
                  <span class="cp-ltext">{{ line }}</span>
                </div>
                <div v-if="!block.theirs!.length" class="cp-empty-side">(空)</div>
              </div>
            </div>

            <!-- Resolution preview -->
            <div v-if="choiceOf(block.conflictIdx!) !== undefined && editingIdx !== block.conflictIdx" class="cp-preview">
              <span class="cp-preview-label">
                <template v-if="choiceOf(block.conflictIdx!) === 'ours'">✓ 採用 Ours</template>
                <template v-else-if="choiceOf(block.conflictIdx!) === 'theirs'">✓ 採用 Theirs</template>
                <template v-else-if="choiceOf(block.conflictIdx!) === 'both'">✓ 保留兩者</template>
                <template v-else>✓ 手動編輯</template>
              </span>
              <button class="cp-undo-btn" @click="choices.value = new Map([...choices.value].filter(([k]) => k !== block.conflictIdx!))">撤銷</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* ── Toolbar ─────────────────────────────────────────────────────────── */
.cp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
  font-size: 12px;
}
.cp-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.cp-badge.conflict { background: #3a1f1f; color: #f85149; }
.cp-filepath {
  flex: 1;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Menlo, monospace;
}
.cp-progress { color: var(--text-muted); font-size: 11px; flex-shrink: 0; white-space: nowrap; }
.cp-apply {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--accent-emphasis, #1f6feb);
  background: rgba(31,111,235,0.18);
  color: var(--accent-fg, #58a6ff);
  cursor: pointer;
  flex-shrink: 0;
}
.cp-apply:hover:not(:disabled) { background: rgba(31,111,235,0.35); }
.cp-apply:disabled { opacity: 0.4; cursor: default; }
.cp-reload {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  background: transparent; border: none; border-radius: 4px;
  color: var(--text-muted); cursor: pointer;
}
.cp-reload:hover { background: var(--bg-muted); color: var(--text-primary); }

/* ── Body ─────────────────────────────────────────────────────────────── */
.cp-body { flex: 1; overflow-y: auto; }
.cp-msg { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.cp-msg.err { color: var(--danger-fg, #f85149); }
.cp-msg.warn { color: var(--warning-fg, #d29922); }

/* Context block */
.cp-context {
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
}
.cp-ctx-text {
  margin: 0;
  padding: 4px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* Conflict block */
.cp-conflict {
  border: 1px solid var(--danger-fg, #f85149);
  border-left-width: 3px;
  margin: 6px 8px;
  border-radius: 4px;
  overflow: hidden;
}
.cp-conflict.resolved {
  border-color: var(--success-fg, #3fb950);
}
.cp-conflict-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: rgba(248,81,73,0.08);
  border-bottom: 1px solid var(--border-muted);
  flex-wrap: wrap;
}
.cp-conflict.resolved .cp-conflict-head {
  background: rgba(63,185,80,0.07);
}
.cp-ci-num {
  font-size: 10px;
  font-weight: 700;
  color: var(--danger-fg, #f85149);
  flex-shrink: 0;
}
.cp-conflict.resolved .cp-ci-num { color: var(--success-fg, #3fb950); }
.cp-head-label { font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.cp-head-label.ours { color: #f0883e; }
.cp-head-label.theirs { color: #58a6ff; }
.cp-head-sep { font-size: 10px; color: var(--text-muted); }
.cp-conflict-actions { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; flex-wrap: wrap; }

.cp-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.cp-btn:hover { background: var(--bg-base); }
.cp-btn.active { border-color: var(--accent-emphasis); background: rgba(31,111,235,0.2); color: var(--accent-fg, #58a6ff); }
.cp-btn.primary { border-color: var(--accent-emphasis); background: rgba(31,111,235,0.25); color: var(--accent-fg, #58a6ff); }
.cp-btn.edit-btn.active { border-color: #d29922; background: rgba(210,153,34,0.15); color: #d29922; }

/* Side-by-side */
.cp-sbs { display: grid; grid-template-columns: 1fr 1fr; }
.cp-side {
  padding: 4px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  transition: opacity 0.15s;
}
.cp-side.ours-side { background: rgba(240,136,62,0.06); border-right: 1px solid var(--border-muted); }
.cp-side.theirs-side { background: rgba(88,166,255,0.06); }
.cp-side.side-chosen { opacity: 1; }
.cp-side.side-rejected { opacity: 0.3; }
.cp-line { display: flex; align-items: flex-start; }
.cp-lno { width: 36px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--text-muted); user-select: none; font-size: 11px; }
.cp-ltext { white-space: pre-wrap; word-break: break-all; color: var(--text-primary); }
.cp-empty-side { padding: 4px 8px; color: var(--text-muted); font-size: 11px; font-style: italic; }

/* Manual edit */
.cp-manual-edit { padding: 8px; background: var(--bg-subtle); }
.cp-manual-ta {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-base);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.cp-manual-ta:focus { border-color: var(--accent-emphasis); }
.cp-manual-actions { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }

/* Resolution preview strip */
.cp-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  background: rgba(63,185,80,0.07);
  border-top: 1px solid var(--border-muted);
  font-size: 11px;
}
.cp-preview-label { color: var(--success-fg, #3fb950); flex: 1; }
.cp-undo-btn {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.cp-undo-btn:hover { color: var(--text-primary); background: var(--bg-muted); }
</style>
