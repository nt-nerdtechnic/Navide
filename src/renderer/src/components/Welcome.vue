<script setup lang="ts">
import { computed, ref } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useRecentWorkspaces, type RecentWorkspace } from '../composables/useRecentWorkspaces'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const emit = defineEmits<{ (e: 'select', path: string): void; (e: 'open-settings'): void }>()

const { recent, loaded, error, touch, pin, unpin } = useRecentWorkspaces(props.backend)

const picking = ref(false)

// Pinned first, then most-recent-first (backend already orders by recency).
const ordered = computed<RecentWorkspace[]>(() => {
  const pinned = recent.value.filter((r) => r.pinned)
  const rest = recent.value.filter((r) => !r.pinned)
  return [...pinned, ...rest]
})

function stateBadge(state: string): { icon: string; label: string; cls: string } {
  switch (state) {
    case 'completed':
      return { icon: '✓', label: 'completed', cls: 'completed' }
    case 'running':
      return { icon: '▶', label: 'running', cls: 'running' }
    case 'aborted':
      return { icon: '⏸', label: 'aborted', cls: 'aborted' }
    default:
      return { icon: '🔧', label: 'spawn-only', cls: 'spawn' }
  }
}

function timeAgo(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

async function openWorkspace(path: string): Promise<void> {
  await touch(path)
  emit('select', path)
}

async function browse(): Promise<void> {
  if (!window.agentTeam) return
  picking.value = true
  try {
    const picked = await window.agentTeam.pickWorkspace()
    if (picked) await openWorkspace(picked)
  } finally {
    picking.value = false
  }
}

async function togglePin(item: RecentWorkspace, ev: Event): Promise<void> {
  ev.stopPropagation()
  if (item.pinned) await unpin(item.path)
  else await pin(item.path)
}
</script>

<template>
  <div class="welcome-overlay">
    <div class="welcome-card">
      <header class="w-head">
        <h1>Agent-Team</h1>
        <p class="tagline">Drive Claude Code · Codex · Gemini CLI together</p>
      </header>

      <section class="w-open">
        <h2>📂 Open Workspace</h2>
        <div class="w-open-btns">
          <button class="primary" :disabled="picking" @click="browse">
            {{ picking ? '…' : 'Browse…' }}
          </button>
        </div>
      </section>

      <section class="w-recent">
        <h2>🕓 Recent</h2>

        <p v-if="error" class="w-error">{{ error }}</p>

        <ul v-if="ordered.length" class="recent-list">
          <li
            v-for="item in ordered"
            :key="item.path"
            class="recent-item"
            :class="{ stale: !item.exists }"
            @click="openWorkspace(item.path)"
          >
            <button
              class="pin"
              :class="{ on: item.pinned }"
              :title="item.pinned ? 'Unpin' : 'Pin'"
              @click="togglePin(item, $event)"
            >
              {{ item.pinned ? '★' : '☆' }}
            </button>
            <div class="r-body">
              <div class="r-top">
                <span class="r-name">{{ item.name }}</span>
                <span class="r-badge" :class="stateBadge(item.last_known_state).cls">
                  {{ stateBadge(item.last_known_state).icon }}
                  {{ stateBadge(item.last_known_state).label }}
                </span>
                <span v-if="!item.exists" class="r-missing" title="Folder not found">⚠ missing</span>
                <span class="r-time">{{ timeAgo(item.last_opened_at) }}</span>
              </div>
              <div class="r-path">{{ item.path }}</div>
              <div v-if="item.last_known_task" class="r-task">"{{ item.last_known_task }}"</div>
            </div>
          </li>
        </ul>

        <p v-else-if="loaded" class="w-empty">
          No recent workspaces yet. Click <strong>Browse…</strong> to open a project folder.
        </p>
      </section>

      <footer class="w-foot">
        <button class="link" @click="emit('open-settings')">⚙ Settings</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.welcome-overlay {
  position: fixed;
  inset: 0;
  background: #010409;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
}
.welcome-card {
  width: 560px;
  max-height: 86vh;
  overflow-y: auto;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 12px;
  padding: 28px 32px;
  color: #e6edf3;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}
.w-head h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.5px;
}
.tagline {
  margin: 4px 0 0;
  color: #8b949e;
  font-size: 12px;
}
.w-open,
.w-recent {
  margin-top: 24px;
}
.w-open h2,
.w-recent h2 {
  font-size: 13px;
  color: #8b949e;
  font-weight: 600;
  margin: 0 0 10px;
}
.w-open-btns {
  display: flex;
  gap: 10px;
}
button.primary {
  background: #238636;
  border: 1px solid #2ea043;
  color: #fff;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button.primary:hover:not(:disabled) {
  background: #2ea043;
}
button.ghost {
  background: transparent;
  border: 1px solid #30363d;
  color: #c9d1d9;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button.ghost:hover:not(:disabled) {
  background: #161b22;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recent-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.recent-item:hover {
  background: #161b22;
  border-color: #30363d;
}
.recent-item.stale {
  opacity: 0.55;
}
.pin {
  background: transparent;
  border: none;
  color: #6e7681;
  cursor: pointer;
  font-size: 15px;
  line-height: 1.4;
  padding: 0;
}
.pin.on {
  color: #d29922;
}
.r-body {
  flex: 1;
  min-width: 0;
}
.r-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.r-name {
  font-weight: 600;
  font-size: 13px;
}
.r-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: #21262d;
  color: #8b949e;
}
.r-badge.completed {
  color: #3fb950;
  background: #11331b;
}
.r-badge.running {
  color: #58a6ff;
  background: #0d2845;
}
.r-badge.aborted {
  color: #d29922;
  background: #341a00;
}
.r-missing {
  font-size: 10px;
  color: #f85149;
}
.r-time {
  margin-left: auto;
  font-size: 11px;
  color: #6e7681;
}
.r-path {
  font-size: 11px;
  color: #8b949e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-task {
  font-size: 12px;
  color: #c9d1d9;
  margin-top: 2px;
}
.w-empty {
  color: #8b949e;
  font-size: 12px;
  line-height: 1.6;
}
.w-error {
  color: #f85149;
  font-size: 12px;
}
.w-foot {
  margin-top: 24px;
  border-top: 1px solid #21262d;
  padding-top: 14px;
}
button.link {
  background: transparent;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
button.link:hover {
  color: #e6edf3;
}
</style>
