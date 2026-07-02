<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { defineAsyncComponent } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { Issue, IssueDetail, IssueProvider, IssueHandlerMode } from '../composables/useIssues'
import { useRepoDiscovery } from '../composables/useRepoDiscovery'
import { useI18n } from 'vue-i18n'

const GitPane = defineAsyncComponent(() => import('./GitPane.vue'))

const props = defineProps<{
  workspacePath: string
  analyzerModel?: string
  backend: ReturnType<typeof useBackend>
  embedded?: boolean
  dispatchTargets?: { id: string; label: string }[]
  availableAgents?: { key: string; label: string }[]
  issueHandoffs?: Record<string, { paneId: string; mode: string; state: string }>
}>()

const emit = defineEmits<{
  (e: 'changes-count', n: number): void
  (e: 'open-workspace', path: string): void
  (e: 'open-file', payload: { filepath: string; name: string }): void
  (e: 'open-conflict', payload: { filepath: string; name: string }): void
  (e: 'open-diff', payload: { filepath: string; staged: boolean; name: string }): void
  (e: 'open-branch-diff', payload: { base: string; compare: string }): void
  (e: 'dispatch-issue', payload: { paneId: string; issue: IssueDetail }): void
  (e: 'spawn-for-issue', payload: { agentKey: string; mode: IssueHandlerMode; issue: Issue; provider: IssueProvider }): void
  (e: 'focus-pane', paneId: string): void
}>()

const { t } = useI18n()

const { repositories } = useRepoDiscovery(() => props.workspacePath, props.backend)

// When root is not a git repo, inject it as the first tab so init/connect features remain accessible.
const allTabs = computed(() => {
  const repos = repositories.value
  const rootIncluded = repos.some((r) => r.rel_path === '.')
  if (rootIncluded || !props.workspacePath) return repos
  return [
    { rel_path: '.', abs_path: props.workspacePath, branch: '', badge: { branch: '', dirtyCount: 0 } },
    ...repos,
  ]
})

// Multi-repo mode when >=2 repos discovered.
const isMulti = computed(() => allTabs.value.length >= 2)

// --- Single-repo mode: forward changes-count directly ---
const singleChangesCount = ref(0)
watch(singleChangesCount, (n) => {
  if (!isMulti.value) emit('changes-count', n)
})

// --- Multi-repo accordion mode ---
const EXPANDED_PREFIX = 'agentTeam.gitExpanded.'

// Which repos are expanded (multi-expand supported).
const expandedRepos = ref<Set<string>>(new Set())

// Which repos have been mounted at least once (lazy-mount guard).
const mounted = ref<Set<string>>(new Set())

// Per-repo changes count (keyed by abs_path).
const repoChangesCounts = ref<Record<string, number>>({})

const totalChangesCount = computed(() =>
  Object.values(repoChangesCounts.value).reduce((s, n) => s + n, 0),
)

watch(totalChangesCount, (n) => {
  if (isMulti.value) emit('changes-count', n)
})

// Restore expanded state from localStorage when tabs change.
watch(
  allTabs,
  (tabs) => {
    if (tabs.length === 0) return
    tabs.forEach((repo) => {
      let saved: string | null = null
      try { saved = localStorage.getItem(EXPANDED_PREFIX + repo.abs_path) } catch { /* ignore */ }
      // Default: first repo expanded, others collapsed.
      const shouldExpand = saved !== null ? saved === '1' : repo === tabs[0]
      if (shouldExpand) {
        expandedRepos.value.add(repo.abs_path)
        mounted.value.add(repo.abs_path)
      }
    })
  },
  { immediate: true },
)

function toggleRepo(absPath: string): void {
  const next = new Set(expandedRepos.value)
  if (next.has(absPath)) {
    next.delete(absPath)
    try { localStorage.setItem(EXPANDED_PREFIX + absPath, '0') } catch { /* ignore */ }
  } else {
    next.add(absPath)
    mounted.value.add(absPath)
    try { localStorage.setItem(EXPANDED_PREFIX + absPath, '1') } catch { /* ignore */ }
  }
  expandedRepos.value = next
}

function repoLabel(relPath: string): string {
  if (relPath === '.') return t('label.git-repo-root')
  // Use the last path segment as the short name.
  return relPath.split('/').filter(Boolean).pop() ?? relPath
}
</script>

<template>
  <!-- Single-repo (or 0 repo): transparent passthrough to GitPane -->
  <GitPane
    v-if="!isMulti"
    :workspace-path="workspacePath"
    :analyzer-model="analyzerModel"
    :backend="backend"
    :embedded="embedded"
    :dispatch-targets="dispatchTargets"
    :available-agents="availableAgents"
    :issue-handoffs="issueHandoffs"
    @changes-count="singleChangesCount = $event; $emit('changes-count', $event)"
    @open-workspace="$emit('open-workspace', $event)"
    @open-file="$emit('open-file', $event)"
    @open-conflict="$emit('open-conflict', $event)"
    @open-diff="$emit('open-diff', $event)"
    @open-branch-diff="$emit('open-branch-diff', $event)"
    @dispatch-issue="$emit('dispatch-issue', $event)"
    @spawn-for-issue="$emit('spawn-for-issue', $event)"
    @focus-pane="$emit('focus-pane', $event)"
  />


  <!-- Multi-repo: accordion (VS Code style, multi-expand) -->
  <div v-else class="repos-list">
    <div class="repos-header">{{ t('pane.git.repositories') }}</div>

    <div v-for="repo in allTabs" :key="repo.abs_path" class="repo-block">
      <!-- Section header -->
      <button
        class="repo-header"
        :aria-expanded="expandedRepos.has(repo.abs_path)"
        :title="repo.abs_path"
        @click="toggleRepo(repo.abs_path)"
      >
        <svg
          class="chevron"
          :class="{ expanded: expandedRepos.has(repo.abs_path) }"
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
        >
          <path d="M6 3l5 5-5 5V3z"/>
        </svg>
        <span class="repo-name">{{ repoLabel(repo.rel_path) }}</span>
        <span v-if="repo.badge.branch" class="repo-branch">{{ repo.badge.branch }}</span>
        <span v-if="repo.badge.dirtyCount > 0" class="repo-dirty-badge">
          {{ repo.badge.dirtyCount > 99 ? '99+' : repo.badge.dirtyCount }}
        </span>
      </button>

      <!-- Lazy-mounted GitPane -->
      <div v-show="expandedRepos.has(repo.abs_path)" class="repo-pane-wrapper">
        <GitPane
          v-if="mounted.has(repo.abs_path)"
          :workspace-path="repo.abs_path"
          :analyzer-model="analyzerModel"
          :backend="backend"
          :embedded="embedded"
          :dispatch-targets="dispatchTargets"
          :available-agents="availableAgents"
          :hide-discovered-repos="true"
          :issue-handoffs="issueHandoffs"
          @changes-count="repoChangesCounts[repo.abs_path] = $event"
          @open-workspace="$emit('open-workspace', $event)"
          @open-file="$emit('open-file', $event)"
          @open-conflict="$emit('open-conflict', $event)"
          @open-diff="$emit('open-diff', $event)"
          @open-branch-diff="$emit('open-branch-diff', $event)"
          @dispatch-issue="$emit('dispatch-issue', $event)"
          @spawn-for-issue="$emit('spawn-for-issue', $event)"
          @focus-pane="$emit('focus-pane', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── REPOSITORIES accordion ─────────────────────────── */
.repos-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.repos-header {
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  flex-shrink: 0;
}

.repo-block {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.repo-header {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 4px 8px 4px 10px;
  background: none;
  border: none;
  border-top: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.repo-header:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.chevron {
  flex-shrink: 0;
  transition: transform 0.15s;
}
.chevron.expanded {
  transform: rotate(90deg);
}

.repo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-branch {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-dirty-badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--attention-fg);
  color: var(--bg-base);
  font-size: 9px;
  font-weight: 700;
  border-radius: 999px;
  line-height: 1;
  flex-shrink: 0;
}

.repo-pane-wrapper {
  min-height: 200px;
  flex: 1;
  position: relative;
}
</style>
