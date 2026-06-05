<script setup lang="ts">
import { ref } from 'vue'
import { useBackend } from './composables/useBackend'
import ExplorerPane from './components/ExplorerPane.vue'
import SearchPane from './components/SearchPane.vue'
import GitPane from './components/GitPane.vue'
import EditorPane from './editor/EditorPane.vue'
import NotificationHost from './components/NotificationHost.vue'

// ── window params (Electron appends ?window=editor&workspace_path=…&filepath=…) ──
const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const initialRel = params.get('filepath') ?? ''
const initialName = params.get('name') ?? (initialRel.split('/').pop() || initialRel)
const initialLine = Number(params.get('line')) || 0

const backend = useBackend()

// ── Open files (VS Code-style tabs); each EditorPane stays mounted (v-show) so
//    edits/undo survive tab switches. ──────────────────────────────────────────
interface OpenFile { relPath: string; name: string; line: number; dirty: boolean }
const openFiles = ref<OpenFile[]>([])
const activeRel = ref('')
const sidebarView = ref<'explorer' | 'search' | 'git'>('explorer')
const changesCount = ref(0)

function openFile(p: { filepath: string; name?: string; line?: number }): void {
  const relPath = p.filepath
  if (!relPath) return
  const name = p.name ?? (relPath.split('/').pop() || relPath)
  const existing = openFiles.value.find((f) => f.relPath === relPath)
  if (!existing) openFiles.value.push({ relPath, name, line: p.line ?? 0, dirty: false })
  activeRel.value = relPath
}

function closeFile(relPath: string): void {
  const i = openFiles.value.findIndex((f) => f.relPath === relPath)
  if (i === -1) return
  openFiles.value.splice(i, 1)
  if (activeRel.value === relPath) {
    activeRel.value = openFiles.value[Math.min(i, openFiles.value.length - 1)]?.relPath ?? ''
  }
}

function markDirty(relPath: string, v: boolean): void {
  const f = openFiles.value.find((x) => x.relPath === relPath)
  if (f) f.dirty = v
}

if (workspacePath && initialRel) openFile({ filepath: initialRel, name: initialName, line: initialLine })
</script>

<template>
  <div class="ide">
    <!-- Activity bar -->
    <div class="ide-activity">
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'explorer' }"
        title="Explorer"
        @click="sidebarView = 'explorer'"
      >
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'search' }"
        title="Search"
        @click="sidebarView = 'search'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'git' }"
        title="Source Control"
        @click="sidebarView = 'git'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/></svg>
        <span v-if="changesCount" class="ide-act-badge">{{ changesCount > 99 ? '99+' : changesCount }}</span>
      </button>
    </div>

    <!-- Sidebar -->
    <div class="ide-sidebar">
      <ExplorerPane
        v-show="sidebarView === 'explorer'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
      />
      <SearchPane
        v-show="sidebarView === 'search'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
      />
      <GitPane
        v-show="sidebarView === 'git'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        @open-file="openFile"
        @changes-count="changesCount = $event"
      />
    </div>

    <!-- Editor area -->
    <div class="ide-main">
      <div v-if="openFiles.length" class="ide-tabs">
        <div
          v-for="f in openFiles"
          :key="f.relPath"
          class="ide-tab"
          :class="{ active: f.relPath === activeRel }"
          :title="f.relPath"
          @click="activeRel = f.relPath"
        >
          <span class="ide-tab-name">{{ f.name }}</span>
          <span v-if="f.dirty" class="ide-tab-dirty" title="未存檔">●</span>
          <button class="ide-tab-close" title="關閉" @click.stop="closeFile(f.relPath)">✕</button>
        </div>
      </div>

      <div class="ide-editors">
        <EditorPane
          v-for="f in openFiles"
          v-show="f.relPath === activeRel"
          :key="f.relPath"
          :workspace-path="workspacePath"
          :backend="backend"
          :rel-path="f.relPath"
          :name="f.name"
          :initial-line="f.line"
          embedded
          @dirty="(v) => markDirty(f.relPath, v)"
        />
        <div v-if="!openFiles.length" class="ide-empty">
          從左側 Explorer 或 Search 開啟檔案
        </div>
      </div>
    </div>
  </div>
  <NotificationHost />
</template>

<style scoped>
.ide {
  display: flex;
  height: 100vh;
  background: var(--bg-base);
  color: var(--text-primary);
  overflow: hidden;
}
.ide-activity {
  flex-shrink: 0;
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 8px;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
}
.ide-act-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 0;
}
.ide-act-btn:hover { color: var(--text-bright); }
.ide-act-btn.active { color: var(--text-bright); border-left-color: var(--accent-emphasis); }
.ide-act-btn { position: relative; }
.ide-act-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 9px;
  line-height: 15px;
  text-align: center;
}

.ide-sidebar {
  flex-shrink: 0;
  width: 260px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-muted);
  overflow: hidden;
}
.ide-sidebar > * { flex: 1; min-height: 0; }

.ide-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ide-tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  overflow-x: auto;
  flex-shrink: 0;
}
.ide-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border-right: 1px solid var(--border-muted);
  cursor: pointer;
  white-space: nowrap;
  border-top: 2px solid transparent;
}
.ide-tab:hover { background: var(--bg-muted); }
.ide-tab.active {
  background: var(--bg-base);
  color: var(--text-bright);
  border-top-color: var(--accent-emphasis);
}
.ide-tab-dirty { color: var(--attention-fg); font-size: 10px; }
.ide-tab-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px;
  border-radius: 3px;
}
.ide-tab-close:hover { background: var(--bg-muted); color: var(--text-bright); }

.ide-editors { flex: 1; position: relative; min-height: 0; }
.ide-editors > * { height: 100%; }
.ide-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
