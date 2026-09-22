<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  createPluginViewRuntimeClient,
  type JsonValue,
  type PluginDetailCloseDecision,
  type PluginDetailCloseRequest,
  type PluginOpenDetailParams,
  type PluginOpenDetailResult,
} from '@navide/plugin-sdk'
import MultiRepoGit from './components/MultiRepoGit.vue'
import SettingsReadinessNotice from './components/SettingsReadinessNotice.vue'
import { onSettingsChanged, settingsGet, useKeybindings } from '@navide/plugin-ui/shared'
import { useTheme } from '@navide/plugin-ui/foundation'
import type { GitSurfacePorts, LegacyRepoSelectionPort } from './ports/gitSurface'
import { HOST_GIT_COMMAND_IDS, type GitContributionState } from './ports/gitContribution'
import type { PluginGitContributionHostPort } from './pluginSurfacePorts'

const props = defineProps<{
  surfacePorts: GitSurfacePorts
  hostPort: PluginGitContributionHostPort
  legacyRepoSelection: LegacyRepoSelectionPort
}>()

const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
const state = ref<GitContributionState>({
  workspacePath,
  analyzerModel: '',
  dispatchTargets: [],
  availableAgents: [],
  issueHandoffs: {},
})
const analyzerModel = ref(settingsGet('agentTeam.analyzerModel', ''))
let stopState: (() => void) | null = null
let stopSettings: (() => void) | null = null
const { registerCommand } = useKeybindings()
const branchDetailViewId = 'navide.git.branch-detail'
const viewRuntime = createPluginViewRuntimeClient()

// ── Receiver close participation ──────────────────────────────────
// The left provider answers the Host's private close preparation before any
// item is destroyed. MultiRepoGit aggregates the mounted panes and freezes
// selection, persisted selection and every pane mutation until commit or
// cancellation.
type MultiRepoCloseGuard = {
  prepareClose: () => Promise<{ accepted: true } | { accepted: false; reason: 'busy' | 'refused' }>
  releaseClose: () => void
}
const multiRepo = ref<MultiRepoCloseGuard | null>(null)
const closePrepared = ref(false)
const closeSubscription = viewRuntime.onPrepareClose(async (_request: PluginDetailCloseRequest): Promise<PluginDetailCloseDecision> => {
  if (closePrepared.value) return { accepted: false, reason: 'busy' }
  const guard = multiRepo.value
  if (!guard) return { accepted: false, reason: 'busy' }
  const result = await guard.prepareClose()
  if (!result.accepted) return { accepted: false, reason: result.reason }
  closePrepared.value = true
  return { accepted: true, reason: 'accepted' }
})
const closeCancelledSubscription = viewRuntime.onCloseCancelled(() => {
  closePrepared.value = false
  multiRepo.value?.releaseClose()
})

for (const command of HOST_GIT_COMMAND_IDS) {
  registerCommand(command, () => {
    void dispatch({ operation: 'execute_host_command', command })
  })
}

function applyState(next: GitContributionState): void {
  if (next.workspacePath === workspacePath) state.value = next
}

const { loadTheme } = useTheme()

onMounted(async () => {
  // mount.ts stamps data-theme once from the entry query so the first paint is
  // not a flash of the wrong theme. That snapshot goes stale the moment the
  // user switches theme, so adopt the store's value here and follow it after —
  // the same contract GitWindowApp keeps.
  loadTheme()
  const initial = await props.hostPort.getState().catch(() => null)
  if (initial) applyState(initial)
  stopState = props.hostPort.onStateChanged(applyState)
  stopSettings = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
    if (keys.includes('agentTeam.analyzerModel')) {
      analyzerModel.value = settingsGet('agentTeam.analyzerModel', '')
    }
  })
})

onUnmounted(() => {
  stopState?.()
  stopState = null
  stopSettings?.()
  stopSettings = null
  closeSubscription.dispose()
  closeCancelledSubscription.dispose()
})

async function dispatch(action: Parameters<PluginGitContributionHostPort['dispatch']>[0]): Promise<void> {
  try { await props.hostPort.dispatch(action) } catch { /* Host action failures are scoped and fail closed. */ }
}

function isSafePackagePath(filepath: string): boolean {
  return filepath.length > 0 && filepath.length <= 4096 &&
    !filepath.startsWith('/') && !filepath.includes('\\') && !filepath.includes('\0') &&
    filepath.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function repositoryRef(repositoryPath: string): string | null {
  const root = workspacePath === '/' ? '/' : workspacePath.replace(/\/+$/, '')
  if (!root) return null
  if (repositoryPath === root) return '.'
  const prefix = root === '/' ? '/' : `${root}/`
  if (!repositoryPath.startsWith(prefix)) return null
  const relative = repositoryPath.slice(prefix.length)
  return isSafePackagePath(relative) ? relative : null
}

async function openBranchDetail(payload: { workspace_path: string; base: string; compare: string }): Promise<void> {
  const repository = repositoryRef(payload.workspace_path)
  if (!payload.base || !repository) return
  const target: JsonValue = {
    resource: {
      kind: 'branch-comparison',
      repository,
      base: payload.base,
      compare: payload.compare,
    },
    presentation: { mode: 'branch-diff' },
  }
  const params: PluginOpenDetailParams = {
    contributionKey: branchDetailViewId,
    target,
  }
  try {
    const result: PluginOpenDetailResult = await viewRuntime.openDetail(params)
    if (!result.opened) {
      if (result.reason === 'receiver-unpaired') {
        await dispatch({ operation: 'open_branch_diff', payload })
      }
      return
    }
  } catch {
    // A missing, stale, or denied detail provider has no fallback route.
  }
}

async function openFileDetail(payload: { workspace_path: string; filepath: string; staged: boolean; name: string; commit?: string }): Promise<void> {
  const repository = repositoryRef(payload.workspace_path)
  if (!repository || !isSafePackagePath(payload.filepath)) return
  try {
    await viewRuntime.openDetail({
      contributionKey: branchDetailViewId,
      target: { resource: { kind: 'file-diff', repository, filepath: payload.filepath, staged: payload.staged, commit: payload.commit ?? '' }, presentation: { mode: 'diff' } },
    })
  } catch {
    // Detail admission failures never route elsewhere.
  }
}

async function openConflictDetail(payload: { workspace_path: string; filepath: string; name: string }): Promise<void> {
  const repository = repositoryRef(payload.workspace_path)
  if (!repository || !isSafePackagePath(payload.filepath)) return
  try {
    await viewRuntime.openDetail({
      contributionKey: branchDetailViewId,
      target: { resource: { kind: 'merge-conflict', repository, filepath: payload.filepath }, presentation: { mode: 'conflict' } },
    })
  } catch {
    // Detail admission failures never route elsewhere.
  }
}
</script>

<template>
  <div class="git-left-root">
    <SettingsReadinessNotice />
    <div class="git-left-content">
      <MultiRepoGit
        ref="multiRepo"
        :workspace-path="workspacePath"
        :legacy-repo-selection="legacyRepoSelection"
        :surface-ports="surfacePorts"
        :analyzer-model="analyzerModel"
        :dispatch-targets="state.dispatchTargets"
        :available-agents="state.availableAgents"
        :issue-handoffs="state.issueHandoffs"
        @changes-count="dispatch({ operation: 'changes_count', count: $event })"
        @open-workspace="dispatch({ operation: 'open_workspace', path: $event.path, grant: $event.grant })"
        @open-file="dispatch({ operation: 'open_file', payload: $event })"
        @open-conflict="openConflictDetail($event)"
        @open-diff="openFileDetail($event)"
        @open-branch-diff="openBranchDetail($event)"
        @dispatch-issue="dispatch({ operation: 'dispatch_issue', payload: $event })"
        @spawn-for-issue="dispatch({ operation: 'spawn_for_issue', payload: $event })"
        @focus-pane="dispatch({ operation: 'focus_pane', paneId: $event })"
        @open-git-accounts="dispatch({ operation: 'open_git_accounts' })"
      />
    </div>
  </div>
</template>

<style scoped>
.git-left-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
}

.git-left-content {
  /* The child pane fills this box with `flex: 1 1 0%`, which only takes
     effect when this element is itself a flex container. Without it the
     pane collapses to content height and everything below the first few
     sections is clipped away. */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
