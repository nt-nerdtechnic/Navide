import { ref, watch, onScopeDispose } from 'vue'
import type { useBackend } from './useBackend'
import type { DiscoveredRepo, GitStatus } from './useGit'

export interface RepoBadge {
  branch: string
  dirtyCount: number
}

export interface DiscoveredRepoWithBadge extends DiscoveredRepo {
  badge: RepoBadge
}

export function useRepoDiscovery(
  workspacePath: () => string,
  backend: ReturnType<typeof useBackend>,
) {
  const { send, on } = backend
  const repositories = ref<DiscoveredRepoWithBadge[]>([])

  async function refresh(): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      repositories.value = []
      return
    }

    let discovered: DiscoveredRepo[] = []
    try {
      const resp = await send<{ ok: boolean; repositories: DiscoveredRepo[] }>(
        'git.discover_repositories',
        { workspace_path: ws },
      )
      if (!resp.ok || !resp.payload?.ok || workspacePath() !== ws) return
      discovered = resp.payload.repositories ?? []
    } catch {
      return
    }

    // Fetch lightweight status badge for each repo in parallel.
    const withBadges = await Promise.all(
      discovered.map(async (repo) => {
        let badge: RepoBadge = { branch: repo.branch, dirtyCount: 0 }
        try {
          const sr = await send<GitStatus>('git.status', {
            workspace_path: repo.abs_path,
            include_ignored: false,
          })
          if (sr.ok && sr.payload) {
            const s = sr.payload
            badge = {
              branch: s.branch || repo.branch,
              dirtyCount: s.staged.length + s.unstaged.length + s.untracked.length,
            }
          }
        } catch {
          // leave default badge
        }
        return { ...repo, badge }
      }),
    )

    if (workspacePath() === ws) {
      repositories.value = withBadges
    }
  }

  // Re-discover when workspace changes.
  const _stopWatch = watch(workspacePath, () => void refresh(), { immediate: true })
  onScopeDispose(_stopWatch)

  // Re-discover on any git.changed broadcast (any workspace — discovery is cheap).
  let _timer: ReturnType<typeof setTimeout> | null = null
  const _offChanged = on('git.changed', () => {
    if (_timer !== null) clearTimeout(_timer)
    _timer = setTimeout(() => {
      _timer = null
      void refresh()
    }, 400)
  })
  onScopeDispose(() => {
    _offChanged()
    if (_timer !== null) clearTimeout(_timer)
  })

  return { repositories, refresh }
}
