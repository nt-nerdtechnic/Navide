<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AGENT_SPECS } from '../lib/agentSpecs'
import {
  filterHistoryEntries,
  groupHistoryByDay,
  historyEntryLabel,
  type HistoryDayGroupKey,
  type HistoryOriginFilter,
  type HistoryStatusFilter,
  type SpawnHistoryEntry,
} from '../lib/spawnHistory'

// Agent History modal, extracted from App.vue. Owns only presentation-local
// state (search query, filters, selection, kill-all confirmation). Flows that
// are coupled to App.vue (resume via onManualResume, kill-all, log-preview
// open state fed into the keybinding modalOpen context) stay in App.vue and
// are wired through props + emits.
const props = defineProps<{
  show: boolean
  sessionHistory: SpawnHistoryEntry[]
  paneCount: number
  revivingPaneId: string
  unavailablePaneIds: Set<string>
  previewOpen: boolean
  previewTitle: string
  previewContent: string
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
const statusFilter = ref<HistoryStatusFilter>('all')
const originFilter = ref<HistoryOriginFilter>('all')
const selectedPaneId = ref('')
const confirmKillAll = ref(false)
const loadingMore = ref(false)

watch(() => props.show, (open) => {
  if (!open) {
    searchQuery.value = ''
    statusFilter.value = 'all'
    originFilter.value = 'all'
    selectedPaneId.value = ''
  }
})

const filteredSessionHistory = computed(() =>
  filterHistoryEntries(props.sessionHistory, {
    query: searchQuery.value,
    status: statusFilter.value,
    origin: originFilter.value,
  })
)

const groupedHistory = computed(() => groupHistoryByDay(filteredSessionHistory.value, new Date()))

const selectedEntry = computed(() =>
  filteredSessionHistory.value.find((entry) => entry.paneId === selectedPaneId.value) ?? null
)

// Default-select the first (newest) entry when the modal opens, and re-select
// the first entry whenever filtering drops the current selection.
watch([() => props.show, filteredSessionHistory], ([open, entries]) => {
  if (!open) return
  if (!entries.some((entry) => entry.paneId === selectedPaneId.value)) {
    selectedPaneId.value = entries[0]?.paneId ?? ''
  }
}, { immediate: true })

function agentLabelFor(entry: SpawnHistoryEntry): string {
  if (!entry.agentKey) return ''
  return agentSpecs.find((s) => s.agentKey === entry.agentKey)?.label ?? entry.agentKey
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function listTime(entry: SpawnHistoryEntry, groupKey: HistoryDayGroupKey): string {
  if (!entry.spawnedAt) return '—'
  const d = new Date(entry.spawnedAt)
  if (Number.isNaN(d.getTime())) return '—'
  return groupKey === 'earlier' ? d.toLocaleDateString() : d.toLocaleTimeString()
}

async function onLoadMore(): Promise<void> {
  if (loadingMore.value || !props.loadMoreHistory) return
  loadingMore.value = true
  try {
    await props.loadMoreHistory()
  } finally {
    loadingMore.value = false
  }
}
</script>

<template>
  <Teleport v-if="show" to="body">
    <div class="history-overlay" @click.self="emit('close')">
      <div class="history-modal">
        <div class="history-modal-header">
          <div class="history-header-left">
            <span>{{ $t('label.agent-history') }}</span>
            <button
              v-if="paneCount > 0"
              class="history-killall"
              @click="confirmKillAll = true"
              :title="$t('action.kill-all-agents')"
            >🗑 {{ $t('action.kill-all') }}</button>
          </div>
          <button class="history-close" @click="emit('close')">✕</button>
        </div>
        <div class="history-body">
          <div class="history-list-col">
            <div class="history-filters">
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
              <div class="history-filter-row">
                <select v-model="statusFilter" class="history-filter-select">
                  <option value="all">{{ $t('label.history-filter-status-all') }}</option>
                  <option value="active">{{ $t('label.history-filter-active') }}</option>
                  <option value="removed">{{ $t('label.history-filter-removed') }}</option>
                </select>
                <select v-model="originFilter" class="history-filter-select">
                  <option value="all">{{ $t('label.history-filter-origin-all') }}</option>
                  <option value="manual">{{ $t('label.history-filter-manual') }}</option>
                  <option value="pipeline">{{ $t('label.history-filter-pipeline') }}</option>
                </select>
              </div>
            </div>
            <div class="agent-history-list">
              <div v-if="sessionHistory.length === 0" class="agent-history-empty">{{ $t('label.no-history-yet') }}</div>
              <div v-else-if="filteredSessionHistory.length === 0" class="agent-history-empty">
                {{ $t('label.no-matching-history') }}
              </div>
              <template v-for="group in groupedHistory" :key="group.key">
                <div class="ah-group-title">{{ $t(`label.history-group-${group.key}`) }}</div>
                <button
                  v-for="entry in group.entries"
                  :key="entry.paneId"
                  class="agent-history-row"
                  :class="{ selected: entry.paneId === selectedPaneId }"
                  @click="selectedPaneId = entry.paneId"
                >
                  <span class="ah-dot" :class="entry.removedAt ? 'removed' : 'active'"></span>
                  <span class="ah-badge">{{ historyEntryLabel(entry) }}</span>
                  <span class="ah-time">{{ listTime(entry, group.key) }}</span>
                </button>
              </template>
              <button
                v-if="historyHasMore && filteredSessionHistory.length > 0"
                class="ah-load-more"
                :disabled="loadingMore"
                @click="onLoadMore"
              >{{ loadingMore ? $t('label.loading') : $t('label.load-more') }}</button>
            </div>
          </div>
          <div class="history-detail-col">
            <div v-if="!selectedEntry" class="agent-history-empty">{{ $t('label.history-no-selection') }}</div>
            <div v-else class="history-detail">
              <div class="detail-title-row">
                <span class="ah-badge detail-name">{{ historyEntryLabel(selectedEntry) }}</span>
                <span class="ah-status" :class="selectedEntry.removedAt ? 'removed' : 'active'">
                  {{ selectedEntry.removedAt ? $t('label.history-filter-removed') : $t('label.history-filter-active') }}
                </span>
              </div>
              <div class="detail-grid">
                <template v-if="agentLabelFor(selectedEntry)">
                  <span class="detail-label">{{ $t('label.history-detail-agent') }}</span>
                  <span class="detail-value">{{ agentLabelFor(selectedEntry) }}</span>
                </template>
                <span class="detail-label">{{ $t('label.history-detail-role') }}</span>
                <span class="detail-value">{{ selectedEntry.roleLabel || '—' }}</span>
                <span class="detail-label">{{ $t('label.history-detail-origin') }}</span>
                <span class="detail-value">{{ selectedEntry.origin === 'pipeline' ? $t('label.history-filter-pipeline') : $t('label.history-filter-manual') }}</span>
                <span class="detail-label">{{ $t('label.history-detail-spawned') }}</span>
                <span class="detail-value">{{ formatTimestamp(selectedEntry.spawnedAt) }}</span>
                <template v-if="selectedEntry.removedAt">
                  <span class="detail-label">{{ $t('label.history-detail-removed') }}</span>
                  <span class="detail-value">{{ formatTimestamp(selectedEntry.removedAt) }}</span>
                </template>
                <template v-if="selectedEntry.sessionId">
                  <span class="detail-label">{{ $t('label.history-detail-session') }}</span>
                  <span class="detail-value detail-session">{{ selectedEntry.sessionId }}</span>
                </template>
                <span class="detail-label">{{ $t('label.history-detail-workspace') }}</span>
                <span class="detail-value detail-path">{{ selectedEntry.workspacePath || '—' }}</span>
                <template v-if="selectedEntry.restoreMode">
                  <span class="detail-label">{{ $t('label.history-detail-restore') }}</span>
                  <span class="detail-value">
                    <span
                      v-if="selectedEntry.restoreMode === 'memory-resume'"
                      class="ah-restore-badge ah-resume"
                      :title="$t('label.history-memory-resume-title')"
                    >{{ $t('label.history-memory-resume') }}</span>
                    <span v-else class="ah-restore-badge ah-fresh">{{ $t('label.history-restore-fresh') }}</span>
                  </span>
                </template>
              </div>
              <div v-if="selectedEntry.removedAt" class="agent-history-actions">
                <span
                  v-if="unavailablePaneIds.has(selectedEntry.paneId)"
                  class="ah-session-unavailable"
                >{{ $t('label.history-session-unavailable') }}</span>
                <button
                  v-if="selectedEntry.sessionId && !unavailablePaneIds.has(selectedEntry.paneId)"
                  class="ah-revive"
                  :disabled="!!revivingPaneId"
                  @click="emit('resume', selectedEntry)"
                >{{ revivingPaneId === selectedEntry.paneId ? '…' : $t('action.resume-session') }}</button>
                <button
                  class="ah-revive ah-preview"
                  @click="emit('preview', selectedEntry)"
                >{{ $t('action.preview') }}</button>
              </div>
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
  width: min(880px, 92vw);
  height: 72vh;
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
.history-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.history-list-col {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.history-filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.history-filter-row {
  display: flex;
  gap: 6px;
}
.history-filter-select {
  flex: 1;
  min-width: 0;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 2px 4px;
  outline: none;
}
.history-filter-select:focus {
  border-color: var(--accent-muted);
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
  padding: 3px 20px 3px 8px;
  width: 100%;
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
  padding: 4px 0 8px;
}
.agent-history-empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.ah-group-title {
  position: sticky;
  top: 0;
  background: var(--bg-base);
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-muted);
}
.agent-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.agent-history-row:hover {
  background: var(--bg-subtle);
}
.agent-history-row.selected {
  background: var(--bg-selected);
}
.ah-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ah-dot.active { background: var(--success-fg); }
.ah-dot.removed { background: var(--text-muted); }
.ah-badge {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-history-row .ah-badge {
  flex: 1;
  min-width: 0;
}
.ah-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}
.ah-load-more {
  display: block;
  margin: 8px auto 4px;
  padding: 3px 14px;
  font-size: 11px;
  border-radius: 20px;
  border: 1px solid var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  cursor: pointer;
}
.ah-load-more:hover:not(:disabled) {
  color: var(--text-bright);
  border-color: var(--accent-muted);
}
.ah-load-more:disabled {
  cursor: wait;
  opacity: 0.55;
}
.history-detail-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.history-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.detail-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-name {
  font-size: 13px;
  padding: 2px 8px;
}
.ah-status {
  font-size: 10px;
  font-weight: 600;
}
.ah-status.active { color: var(--success-fg); }
.ah-status.removed { color: var(--text-muted); }
.detail-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  font-size: 12px;
  align-items: baseline;
}
.detail-label {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.detail-value {
  color: var(--text-primary);
  min-width: 0;
}
.detail-session {
  font-family: monospace;
  font-size: 11px;
  word-break: break-all;
}
.detail-path {
  word-break: break-all;
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
.ah-restore-badge.ah-resume {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  border: 1px solid var(--accent-muted);
}
.ah-restore-badge.ah-fresh {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
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
