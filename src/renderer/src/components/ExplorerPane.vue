<script setup lang="ts">
import { ref, computed, onMounted, watch, toRef } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useExplorer, type FsEntry } from '../composables/useExplorer'
import { useGit } from '../composables/useGit'
import { useNotify } from '../composables/useNotify'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
}>()

const wsRef = toRef(props, 'workspacePath')
const explorer = useExplorer(props.backend, wsRef)
const git = useGit(() => props.workspacePath, props.backend)
const { toast, alert, confirm } = useNotify()

type FsResult = { ok: boolean; error?: string }

const statusMap = computed(() => explorer.buildStatusMap(git.gitStatus.value))

interface Row {
  entry: FsEntry
  depth: number
}

// Flatten the lazily-loaded cache + expanded set into a render list.
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (rel: string, depth: number): void => {
    const children = explorer.childrenCache.value.get(rel) ?? []
    for (const entry of children) {
      out.push({ entry, depth })
      if (entry.is_dir && explorer.isExpanded(entry.rel_path)) {
        walk(entry.rel_path, depth + 1)
      }
    }
  }
  walk('', 0)
  return out
})

const wsName = computed(() => {
  const p = props.workspacePath.replace(/\/+$/, '')
  return p.split('/').pop() || p
})

function absPath(rel: string): string {
  return `${props.workspacePath.replace(/\/+$/, '')}/${rel}`
}

function statusFor(rel: string): { letter: string; staged: boolean } | undefined {
  return statusMap.value.get(rel)
}

const STATUS_CLASS: Record<string, string> = {
  M: 'st-mod', A: 'st-add', D: 'st-del', U: 'st-untracked',
  R: 'st-mod', C: 'st-mod', '?': 'st-untracked',
}

// Folders inheriting the status of any descendant change (VS Code-style):
// a tracked change (M/A/D/R/C) tints the folder yellow, untracked-only green.
const dirStatusMap = computed(() => {
  const map = new Map<string, string>()
  for (const [path, info] of statusMap.value) {
    const cls = info.letter === 'U' ? 'st-untracked' : 'st-mod'
    let idx = path.lastIndexOf('/')
    while (idx > 0) {
      const dir = path.slice(0, idx)
      if (map.get(dir) !== 'st-mod') map.set(dir, cls) // tracked wins over untracked
      idx = dir.lastIndexOf('/')
    }
  }
  return map
})

// Status class for an entry, applied to the filename (VS Code-style tint) and
// the trailing letter badge. Folders inherit from descendants; '' = clean.
function statusClassFor(entry: FsEntry): string {
  if (entry.is_dir) return dirStatusMap.value.get(entry.rel_path) || ''
  const st = statusFor(entry.rel_path)
  return st ? STATUS_CLASS[st.letter] || 'st-mod' : ''
}

function onRowClick(entry: FsEntry): void {
  if (entry.is_dir) {
    void explorer.toggleDir(entry.rel_path)
  } else {
    openInEditor(entry)
  }
}

function openDiff(entry: FsEntry): void {
  const st = statusFor(entry.rel_path)
  void window.agentTeam?.openDiffWindow({
    workspace_path: props.workspacePath,
    filepath: entry.rel_path,
    staged: st?.staged ?? false,
    name: entry.name,
  })
}

function openInEditor(entry: FsEntry): void {
  void window.agentTeam?.openEditorWindow({
    workspace_path: props.workspacePath,
    filepath: entry.rel_path,
    name: entry.name,
  })
}

// ── Context menu ─────────────────────────────────────────────────────────────
const ctx = ref<{ x: number; y: number; entry: FsEntry | null } | null>(null)

function openCtx(e: MouseEvent, entry: FsEntry | null): void {
  e.preventDefault()
  ctx.value = { x: e.clientX, y: e.clientY, entry }
}
function closeCtx(): void {
  ctx.value = null
}

// ── Inline prompt (create / rename) ──────────────────────────────────────────
const prompt = ref<{
  kind: 'new-file' | 'new-folder' | 'rename'
  title: string
  value: string
  parentRel: string
  srcRel?: string
} | null>(null)
const promptInput = ref<HTMLInputElement | null>(null)

function startNew(kind: 'new-file' | 'new-folder', entry: FsEntry | null): void {
  // New items go inside the entry if it's a dir, else alongside it (its parent).
  const parentRel = entry ? (entry.is_dir ? entry.rel_path : parentOf(entry.rel_path)) : ''
  prompt.value = {
    kind,
    title: kind === 'new-file' ? '新增檔案' : '新增資料夾',
    value: '',
    parentRel,
  }
  focusPrompt()
}

function startRename(entry: FsEntry): void {
  prompt.value = {
    kind: 'rename',
    title: '重新命名',
    value: entry.name,
    parentRel: parentOf(entry.rel_path),
    srcRel: entry.rel_path,
  }
  focusPrompt()
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function focusPrompt(): void {
  void Promise.resolve().then(() => promptInput.value?.focus())
}

async function submitPrompt(): Promise<void> {
  const p = prompt.value
  if (!p) return
  const name = p.value.trim()
  if (!name) {
    prompt.value = null
    return
  }
  const rel = p.parentRel ? `${p.parentRel}/${name}` : name
  let res: { payload: FsResult | null }
  if (p.kind === 'new-file') {
    res = await props.backend.send<FsResult>('fs.create_file', { workspace_path: props.workspacePath, rel_path: rel })
  } else if (p.kind === 'new-folder') {
    res = await props.backend.send<FsResult>('fs.mkdir', { workspace_path: props.workspacePath, rel_path: rel })
  } else {
    res = await props.backend.send<FsResult>('fs.rename', {
      workspace_path: props.workspacePath,
      src_path: p.srcRel,
      dst_path: rel,
    })
  }
  prompt.value = null
  if (!res.payload?.ok) {
    void alert(res.payload?.error || '操作失敗', { title: '錯誤' })
    return
  }
  // Make sure the affected dir is expanded so the result is visible.
  if (p.kind !== 'rename' && p.parentRel && !explorer.isExpanded(p.parentRel)) {
    await explorer.toggleDir(p.parentRel)
  }
  await explorer.refreshVisible()
}

async function doDelete(entry: FsEntry): Promise<void> {
  const ok = await confirm(`確定刪除「${entry.name}」？此操作無法復原。`, {
    title: '刪除',
    confirmText: '刪除',
  })
  if (!ok) return
  const res = await props.backend.send<FsResult>('fs.delete', {
    workspace_path: props.workspacePath,
    rel_path: entry.rel_path,
  })
  if (!res.payload?.ok) {
    void alert(res.payload?.error || '刪除失敗', { title: '錯誤' })
    return
  }
  await explorer.refreshVisible()
}

async function reveal(entry: FsEntry): Promise<void> {
  await window.agentTeam?.revealPath(absPath(entry.rel_path))
}

async function copyPath(entry: FsEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(absPath(entry.rel_path))
    toast('已複製路徑', { type: 'success' })
  } catch {
    toast('複製失敗', { type: 'error' })
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(() => {
  if (props.workspacePath) {
    void explorer.loadDir('')
    void git.loadStatus()
  }
})
watch(wsRef, (v) => {
  if (v) {
    void explorer.loadDir('')
    void git.loadStatus()
  }
})
</script>

<template>
  <div class="explorer" @click="closeCtx">
    <!-- Header -->
    <div class="exp-header">
      <span class="exp-ws" :title="workspacePath">{{ wsName || 'No workspace' }}</span>
      <div class="exp-actions">
        <button
          class="exp-icon-btn"
          :class="{ on: explorer.showHidden.value }"
          title="顯示隱藏檔"
          @click="explorer.setShowHidden(!explorer.showHidden.value)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.5 0 6.4 2.3 7.5 5.5C14.4 10.7 11.5 13 8 13S1.6 10.7.5 7.5C1.6 4.3 4.5 2 8 2Zm0 1.5C5.4 3.5 3.2 5 2.1 7.5 3.2 10 5.4 11.5 8 11.5s4.8-1.5 5.9-4C12.8 5 10.6 3.5 8 3.5Zm0 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>
        </button>
        <button class="exp-icon-btn" title="重新整理" @click="explorer.reloadAll()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.364-.626A6.5 6.5 0 1 1 8 1.5V0l3 2-3 2V3Z"/></svg>
        </button>
        <button class="exp-icon-btn" title="新增檔案" @click.stop="startNew('new-file', null)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2H6.5a1 1 0 0 0-1 1v3.5"/><path d="M8.5 14H12a1 1 0 0 0 1-1V5l-3-3"/><path d="M10 2v3h3"/><path d="M3.5 9.5v4M1.5 11.5h4"/></svg>
        </button>
        <button class="exp-icon-btn" title="新增資料夾" @click.stop="startNew('new-folder', null)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10.5V4.5a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v1.5"/><path d="M13.5 7.5V12a1 1 0 0 1-1 1H7"/><path d="M3.5 9.5v4M1.5 11.5h4"/></svg>
        </button>
      </div>
    </div>

    <!-- Tree -->
    <div class="exp-tree" @contextmenu="openCtx($event, null)">
      <div
        v-for="row in rows"
        :key="row.entry.rel_path"
        class="exp-row"
        :class="{ noise: row.entry.is_noise, hidden: row.entry.is_hidden }"
        :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
        @click.stop="onRowClick(row.entry)"
        @contextmenu.stop="openCtx($event, row.entry)"
      >
        <span class="exp-chevron" :class="{ open: explorer.isExpanded(row.entry.rel_path) }">
          <svg v-if="row.entry.is_dir" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4V4Z"/></svg>
        </span>
        <span class="exp-glyph" :class="row.entry.is_dir ? 'is-dir' : 'is-file'">
          <svg v-if="row.entry.is_dir" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v8.5C0 13.216.784 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-7.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 1A1.75 1.75 0 0 0 2 2.75v10.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0 0 14 13.25V5.5L9.5 1H3.75ZM9 2.5 12.5 6H9V2.5Z"/></svg>
        </span>
        <span class="exp-name" :class="statusClassFor(row.entry)">{{ row.entry.name }}</span>
        <span v-if="statusFor(row.entry.rel_path)" class="exp-status" :class="statusClassFor(row.entry)">
          {{ statusFor(row.entry.rel_path)!.letter }}
        </span>
      </div>

      <div v-if="rows.length === 0 && workspacePath" class="exp-empty">
        {{ explorer.error.value || '此目錄沒有可顯示的項目' }}
      </div>
      <div v-if="!workspacePath" class="exp-empty">先選擇一個 workspace</div>
    </div>

    <!-- Inline prompt -->
    <div v-if="prompt" class="exp-prompt-overlay" @click.self="prompt = null">
      <div class="exp-prompt">
        <div class="exp-prompt-title">{{ prompt.title }}</div>
        <input
          ref="promptInput"
          v-model="prompt.value"
          class="exp-prompt-input"
          type="text"
          spellcheck="false"
          placeholder="名稱"
          @keydown.enter="submitPrompt"
          @keydown.esc="prompt = null"
        />
        <div class="exp-prompt-actions">
          <button class="exp-btn ghost" @click="prompt = null">取消</button>
          <button class="exp-btn primary" @click="submitPrompt">確定</button>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <div v-if="ctx" class="exp-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <button class="exp-ctx-item" @click="startNew('new-file', ctx.entry); closeCtx()">新增檔案</button>
      <button class="exp-ctx-item" @click="startNew('new-folder', ctx.entry); closeCtx()">新增資料夾</button>
      <template v-if="ctx.entry">
        <div class="exp-ctx-sep" />
        <button v-if="!ctx.entry.is_dir" class="exp-ctx-item" @click="openDiff(ctx.entry!); closeCtx()">Open Diff</button>
        <button v-if="!ctx.entry.is_dir" class="exp-ctx-item" @click="openInEditor(ctx.entry!); closeCtx()">在編輯器開啟</button>
        <button class="exp-ctx-item" @click="startRename(ctx.entry!); closeCtx()">重新命名</button>
        <button class="exp-ctx-item danger" @click="doDelete(ctx.entry!); closeCtx()">刪除</button>
        <div class="exp-ctx-sep" />
        <button class="exp-ctx-item" @click="reveal(ctx.entry!); closeCtx()">Reveal in Finder</button>
        <button class="exp-ctx-item" @click="copyPath(ctx.entry!); closeCtx()">複製路徑</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
}
.exp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.exp-ws {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.exp-actions { display: flex; gap: 2px; flex-shrink: 0; }
.exp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.exp-icon-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.exp-icon-btn.on { color: var(--accent-fg); }

.exp-tree { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 0; }
.exp-row {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  white-space: nowrap;
}
.exp-row:hover { background: var(--bg-hover); }
.exp-row.noise .exp-name { color: var(--text-muted); }
.exp-row.hidden .exp-name,
.exp-row.hidden .exp-glyph { opacity: 0.55; }
.exp-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  color: var(--text-muted);
  transition: transform 0.1s;
  flex-shrink: 0;
}
.exp-chevron.open { transform: rotate(90deg); }
.exp-glyph { display: inline-flex; align-items: center; color: var(--text-secondary); flex-shrink: 0; }
.exp-glyph.is-dir svg { color: var(--accent-fg); }
.exp-glyph.is-file svg { color: var(--text-muted); }
.exp-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}
.exp-status {
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}
.st-mod { color: var(--attention-fg); }
.st-add { color: var(--success-fg); }
.st-del { color: var(--danger-fg); }
.st-untracked { color: var(--success-fg); }

.exp-empty {
  padding: 16px 12px;
  font-size: 11.5px;
  color: var(--text-muted);
  text-align: center;
}

/* Inline prompt */
.exp-prompt-overlay {
  position: absolute;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 60px;
  z-index: 40;
}
.exp-prompt {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 14px;
  width: 84%;
  max-width: 280px;
  box-shadow: 0 8px 28px var(--shadow-overlay);
}
.exp-prompt-title { font-size: 12px; font-weight: 600; color: var(--text-bright); margin-bottom: 8px; }
.exp-prompt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.exp-prompt-input:focus { border-color: var(--accent-emphasis); }
.exp-prompt-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.exp-btn {
  font-size: 11.5px;
  padding: 5px 12px;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
}
.exp-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.exp-btn.ghost:hover { background: var(--bg-muted); color: var(--text-bright); }

/* Context menu */
.exp-ctx {
  position: fixed;
  z-index: 50;
  min-width: 160px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 8px 28px var(--shadow-overlay);
}
.exp-ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
.exp-ctx-item:hover { background: var(--bg-muted); }
.exp-ctx-item.danger:hover { color: var(--danger-fg); }
.exp-ctx-sep { height: 1px; background: var(--border-muted); margin: 4px 0; }
</style>
