import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import { workspaceAliasKey, workspaceBasename, workspaceDisplayName } from '../lib/workspaceAlias'
import type { useBackend } from './useBackend'
import type { RecentWorkspace } from './useRecentWorkspaces'

/** Where an adopted display name came from.
 *
 *  · `'peek'` — a `project.peek` reply. A READ, and reads go stale: a peek is
 *    often already in flight when the user renames, and its reply then carries
 *    the name from before the write.
 *  · `'peer'` — another window's `project.ui_state_changed` broadcast.
 *  · `'local'` — this window's own successful rename.
 *
 *  The last two are WRITES. Each write bumps the path's generation, and a read
 *  is only believed when it was issued at the current generation — a reply
 *  from before the write is dropped, a reply from after it is trusted. See
 *  `adopt` and `generationOf`.
 */
export type WorkspaceAliasSource = 'peek' | 'peer' | 'local'

/** Path → display name for every workspace this window can name.
 *
 *  Two sources, in this order of authority:
 *
 *  · the recent-workspaces store, whose `name` the backend already mirrors the
 *    alias into — so any workspace the user has ever opened is covered without
 *    a round trip of its own. The mirror holds the folder BASENAME for a
 *    workspace with no alias (that is what `touch()` writes), and such an
 *    entry is left out: this map answers "has the user named it", and the
 *    mirror's fallback is not a name the user gave;
 *  · overrides written from `project.peek`'s `display_name`, from a peer
 *    window's `project.ui_state_changed`, and from this window's own rename.
 *    These are the immediate truth: the recent store catches up a broadcast
 *    later, and until it does the sidebar must already show the new name.
 *    Among the overrides themselves a write beats a read that pre-dates it —
 *    once a rename or a peer broadcast has named a path, a `project.peek`
 *    reply issued before that write is dropped (see `adopt`).
 *
 *  An override of `''` is not "unknown" but "cleared", and shadows a stale
 *  recent-store name so the folder name comes back at once.
 */
export function useWorkspaceAliases(
  backend: ReturnType<typeof useBackend>,
  recent: Ref<RecentWorkspace[]>,
): {
  aliases: ComputedRef<Record<string, string>>
  displayNameOf: (path: string) => string
  generationOf: (path: string) => number
  adopt: (
    path: string,
    displayName: string | undefined,
    source?: WorkspaceAliasSource,
    generation?: number,
  ) => void
  setDisplayName: (path: string, displayName: string) => Promise<boolean>
  error: Ref<string>
} {
  const overrides = ref<Record<string, string>>({})
  const error = ref('')

  const aliases = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const entry of recent.value) {
      if (!entry?.path || !entry.name) continue
      // The mirror's basename fallback is not an alias. This also drops an
      // alias the user set to exactly the folder name — deliberately: on
      // screen the two are the same row, and a rename editor that opens empty
      // for it costs nothing, while treating the fallback as a name broke the
      // editor for every unnamed workspace.
      if (entry.name === workspaceBasename(entry.path)) continue
      out[workspaceAliasKey(entry.path)] = entry.name
    }
    for (const [key, name] of Object.entries(overrides.value)) {
      if (name) out[key] = name
      else delete out[key]
    }
    return out
  })

  /** Per path, how many WRITES this window has seen — its own successful
   *  renames and peer windows' broadcasts. Never decremented.
   *
   *  A `project.peek` reply is a READ and can pre-date a write: the run-group
   *  prefetch and the onMounted restore loop both peek every held workspace
   *  in sequence with no guard of their own, and `onWorkspaceCheck`'s seq
   *  guard only covers newer workspace checks, which a rename does not issue.
   *  So a caller records `generationOf(path)` BEFORE it sends the peek and
   *  hands it back with the reply: a reply from an older generation is
   *  dropped, one from the current generation is believed. Without this, a
   *  peek already in flight landed after a rename and put the folder name
   *  back — the "the rename did not take" this whole feature exists to remove.
   *
   *  A generation rather than a "written" flag because the truth can change
   *  without a broadcast reaching this window — two Navide builds sharing one
   *  `navide.db`, or a rename during a reconnect gap — and a flag would then
   *  pin the old name here until reload. A peek issued after the write is
   *  newer than it and self-heals that. */
  const generations = new Map<string, number>()

  function generationOf(path: string): number {
    return generations.get(workspaceAliasKey(path)) ?? 0
  }

  function adopt(
    path: string,
    displayName: string | undefined,
    source: WorkspaceAliasSource = 'peek',
    generation?: number,
  ): void {
    if (!path || typeof displayName !== 'string') return
    const key = workspaceAliasKey(path)
    if (source === 'peek') {
      // A caller that recorded no generation is taken to have read before any
      // write — trusted only while nothing has been written for the path.
      if ((generation ?? 0) < (generations.get(key) ?? 0)) return
    } else {
      generations.set(key, (generations.get(key) ?? 0) + 1)
    }
    const next = displayName.trim()
    if (overrides.value[key] === next) return
    overrides.value = { ...overrides.value, [key]: next }
  }

  function displayNameOf(path: string): string {
    return workspaceDisplayName(path, aliases.value)
  }

  /** Persist an alias; an empty string clears it and restores the folder name.
   *
   *  Returns whether the backend actually stored it, and leaves the reason in
   *  `error` when it did not. The caller has to be able to tell — a rename that
   *  silently did nothing leaves the old name on screen with no explanation,
   *  and reads as the gesture having missed rather than as a failure.
   *
   *  `ok` is faithful here and a refusal arrives as an ORDINARY response
   *  (`{ ok: false, error }`), not as an error frame — so the payload is what
   *  decides, and a truthy envelope proves only that the round trip happened.
   *  A failed call carries no `display_name`, so nothing is adopted. */
  async function setDisplayName(path: string, displayName: string): Promise<boolean> {
    if (!path) {
      error.value = 'workspace_path is required'
      return false
    }
    const next = displayName.trim()
    error.value = ''
    try {
      const resp = await backend.send<{ ok?: boolean; display_name?: string; error?: string }>(
        'project.set_display_name',
        { workspace_path: path, display_name: next },
      )
      if (!resp.ok || resp.payload?.ok !== true) {
        error.value =
          resp.payload?.error || resp.error?.message || 'could not save the display name'
        return false
      }
      // The backend's own normalised value, not the draft: it strips, and what
      // it stored is what the broadcast and the recent store will agree on.
      adopt(path, resp.payload.display_name ?? next, 'local')
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'could not save the display name'
      return false
    }
  }

  // A peer window's rename. Not folded into App.vue's existing
  // project.ui_state_changed handler: that one drops every delta for a
  // workspace other than the one on screen, and a renamed project still has a
  // sidebar row here whether or not it is the one being viewed.
  const off = backend.on('project.ui_state_changed', (raw) => {
    const d = raw as { workspace_path?: string; display_name?: string } | null
    if (!d?.workspace_path || typeof d.display_name !== 'string') return
    adopt(d.workspace_path, d.display_name, 'peer')
  })
  onScopeDispose(() => off?.())

  return { aliases, displayNameOf, generationOf, adopt, setDisplayName, error }
}
