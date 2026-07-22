<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AGENT_SPECS } from '../lib/agentSpecs'
import { historyEntryLabel, matchesHistorySearch, type SpawnHistoryEntry } from '../lib/spawnHistory'

// Agent History modal, extracted from App.vue. Owns only presentation-local
// state (search query, kill-all confirmation). Flows that are coupled to
// App.vue (resume via onManualResume, kill-all, log-preview open state fed
// into the keybinding modalOpen context) stay in App.vue and are wired
// through props + emits.
const props = defineProps<{
  show: boolean
  sessionHistory: SpawnHistoryEntry[]
  paneCount: number
  revivingPaneId: string
  unavailablePaneIds: Set<string>
  previewOpen: boolean
  previewTitle: string
  previewContent: string
  // Phase B data layer for the paged full history; the "load more" UI that
  // consumes these lands in Phase D.
  historyHasMore?: boolean
  loadMoreHistory?: () => Promise<void>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'kill-all'): void
  (e: 'resume', entry: SpawnHistoryEntry): void
  (e: 'preview', entry: SpawnHistoryEntry): void
  (e: 'close-preview'): void
}>()

const agentSpecs = AGENT_SPECS

const searchQuery = ref('')
watch(() => props.show, (open) => {
  if (!open) searchQuery.value = ''
})
const confirmKillAll = ref(false)

const filteredSessionHistory = computed(() =>
  props.sessionHistory.filter((entry) => matchesHistorySearch(entry, searchQuery.value))
)
</script>

<template>
  <Teleport v-if="show" to="body">
    <div class="history-overlay" @click.self="emit('close')">
      <div class="history-modal">
        <div class="history-modal-header">
          <div class="history-header-left">
            <span>{{ $t('label.agent-history') }}</span>
            <div class="agent-history-search">
              <input
                v-model="searchQuery"
                class="agent-history-search-input"
                :placeholder="$t('label.search-history')"
              />
              <button
                v-if="searchQuery"
                class="agent-history-search-clear"
                @click="searchQuery = ''"
              >✕</button>
            </div>
            <button
              v-if="paneCount > 0"
              class="history-killall"
              @click="confirmKillAll = true"
              :title="$t('action.kill-all-agents')"
            >🗑 {{ $t('action.kill-all') }}</button>
          </div>
          <button class="history-close" @click="emit('close')">✕</button>
        </div>
        <div class="agent-history-list">
          <div v-if="sessionHistory.length === 0" class="agent-history-empty">{{ $t('label.no-history-yet') }}</div>
          <div v-else-if="filteredSessionHistory.length === 0" class="agent-history-empty">
            {{ $t('label.no-matching-history') }}
          </div>
          <div
            v-for="entry in filteredSessionHistory"
            :key="entry.paneId"
            class="agent-history-row"
            :class="{ active: !entry.removedAt }"
          >
            <div class="agent-history-main">
              <span class="ah-badge">{{ historyEntryLabel(entry) }}</span>
              <span class="ah-origin">{{ entry.origin }}</span>
              <span
                v-if="entry.restoreMode === 'memory-resume'"
                class="ah-restore-badge ah-resume"
                :title="$t('label.history-memory-resume-title')"
              >{{ $t('label.history-memory-resume') }}</span>
              <span class="ah-status" :class="entry.removedAt ? 'removed' : 'active'">
                {{ entry.removedAt ? 'removed' : 'active' }}
              </span>
            </div>
            <div class="agent-history-meta">
              <span class="ah-role">
                <template v-if="entry.agentKey">{{ agentSpecs.find(s => s.agentKey === entry.agentKey)?.label ?? entry.agentKey }}<template v-if="entry.roleLabel"> · </template></template>{{ entry.roleLabel }}
              </span>
              <span class="ah-time">{{ new Date(entry.spawnedAt).toLocaleTimeString() }}</span>
              <span v-if="entry.sessionId" class="ah-session" :title="entry.sessionId">
                🔖 {{ entry.sessionId.slice(0, 8) }}…
              </span>
            </div>
            <div v-if="entry.removedAt" class="agent-history-actions">
              <span
                v-if="unavailablePaneIds.has(entry.paneId)"
                class="ah-session-unavailable"
              >{{ $t('label.history-session-unavailable') }}</span>
              <button
                v-if="entry.sessionId && !unavailablePaneIds.has(entry.paneId)"
                class="ah-revive"
                :disabled="!!revivingPaneId"
                @click="emit('resume', entry)"
              >{{ revivingPaneId === entry.paneId ? '…' : $t('action.resume-session') }}</button>
              <button
                class="ah-revive ah-preview"
                @click="emit('preview', entry)"
              >{{ $t('action.preview') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
  <Teleport v-if="confirmKillAll" to="body">
    <div class="history-overlay" @click.self="confirmKillAll = false">
      <div class="history-modal" style="height: auto; max-width: 400px;">
        <div class="history-modal-header">
          <span>🗑 Kill all agents?</span>
          <button class="history-close" @click="confirmKillAll = false">✕</button>
        </div>
        <div style="padding: 16px 14px; font-size: 13px; color: var(--text-primary);">
          {{ $t('label.kill-all-confirm-prefix') }}<strong>{{ $t('label.kill-all-confirm-count', { count: paneCount }) }}</strong>{{ $t('label.kill-all-confirm-suffix') }}
        </div>
        <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
          <button class="history-close" style="border: 1px solid var(--border-default); padding: 4px 12px; border-radius: 6px;" @click="confirmKillAll = false">{{ $t('action.cancel') }}</button>
          <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="() => { emit('kill-all'); confirmKillAll = false }">{{ $t('action.kill-all') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Log Preview Modal -->
  <div v-if="previewOpen" class="log-preview-overlay" @click.self="emit('close-preview')">
    <div class="log-preview-modal">
      <div class="log-preview-header">
        <h3>{{ previewTitle }}</h3>
        <button class="log-preview-close" @click="emit('close-preview')">✕</button>
      </div>
      <div class="log-preview-body">
        <pre>{{ previewContent }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  -webkit-app-region: no-drag;
}
.history-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: min(680px, 92vw);
  height: min(560px, 85vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px var(--shadow-overlay);
}
.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-muted);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
}
.history-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-killall {
  background: transparent;
  border: 1px solid var(--danger-muted);
  color: var(--danger-fg);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
}
.history-killall:hover {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
  opacity: 1;
}
.agent-history-search {
  position: relative;
  display: flex;
  align-items: center;
}
.agent-history-search-input {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 400;
  padding: 2px 20px 2px 8px;
  width: 160px;
  outline: none;
}
.agent-history-search-input:focus {
  border-color: var(--accent-muted);
}
.agent-history-search-clear {
  position: absolute;
  right: 2px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  padding: 1px 4px;
}
.agent-history-search-clear:hover {
  color: var(--text-bright);
}
.history-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.history-close:hover {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.agent-history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
}
.agent-history-empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.agent-history-row {
  padding: 8px 14px;
  border-bottom: 1px solid var(--bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-history-row.active {
  border-left: 3px solid var(--success-fg);
  padding-left: 11px;
}
.agent-history-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ah-badge {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-bright);
}
.ah-role {
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ah-origin {
  font-size: 10px;
  color: var(--text-secondary);
}
.ah-status {
  font-size: 10px;
  font-weight: 600;
}
.ah-status.active { color: var(--success-fg); }
.ah-status.removed { color: var(--text-muted); }
.agent-history-meta {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--text-muted);
}
.ah-session {
  font-family: monospace;
}
.ah-restore-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  letter-spacing: 0.2px;
}
.ah-restore-badge.ah-memory {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  border: 1px solid var(--accent-muted);
}
.agent-history-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.ah-session-unavailable {
  width: 100%;
  color: var(--warning-fg);
  font-size: 11px;
}
.ah-revive {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-bright);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ah-revive:hover {
  background: var(--bg-selected);
  border-color: var(--accent-bright);
  color: var(--accent-bright);
}
.ah-revive.ah-preview {
  border-color: var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.ah-revive:disabled {
  cursor: wait;
  opacity: 0.55;
}

/* Log Preview Modal */
.log-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}
.log-preview-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: 80vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.log-preview-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-subtle);
}
.log-preview-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.log-preview-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
}
.log-preview-close:hover {
  color: var(--text-primary);
}
.log-preview-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  background: var(--bg-base);
}
.log-preview-body pre {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
