// User preference for what happens to previously spawned CLI panes when a
// workspace opens: resume their prior conversations ('always'), start fresh
// ones ('never'), or show a confirmation dialog ('ask'). Pure decision logic —
// App.vue supplies the setting value, the per-window decision cache, and the
// confirm-dialog `ask`.

export type ResumeBehavior = 'always' | 'never' | 'ask'

/** Settings-store key (ui_settings.json via lib/settings.ts). */
export const RESUME_BEHAVIOR_SETTING_KEY = 'agentTeam.resumeBehavior'

/** Guard for values read from the settings store: anything but a known
 *  behavior falls back to 'always' (the pre-preference behavior). */
export function normalizeResumeBehavior(v: unknown): ResumeBehavior {
  return v === 'never' || v === 'ask' ? v : 'always'
}

export type RestoreDecision = 'resume' | 'fresh'

/** Remove a hand-written `--session-id <uuid>` (or `--session-id=<uuid>`) from a
 *  saved custom command. Used only on the start-fresh path: that id's transcript
 *  still exists, so keeping it baked into the command would make the "fresh" pane
 *  resume (and re-persist) the old conversation instead of minting a new id.
 *  Leaves any other command untouched. */
export function stripPinnedSessionId(command: string): string {
  return command.replace(/\s*--session-id[=\s]+\S+/g, '').trim()
}

/** Decide whether a workspace-open restore resumes saved conversations or
 *  spawns fresh ones.
 *
 *  'ask' prompts at most once per workspace per window: onWorkspaceCheck
 *  re-runs on comm-failure retries and duplicate restores re-enter the restore
 *  path, so the first answer is cached under the workspace path and reused
 *  instead of re-prompting. With nothing restorable there is nothing to ask
 *  about — return 'resume' (a no-op) without prompting. */
export async function resolveRestoreDecision(opts: {
  behavior: ResumeBehavior
  restorableCount: number
  workspacePath: string
  decisionCache: Map<string, RestoreDecision>
  ask: () => Promise<boolean>
}): Promise<RestoreDecision> {
  if (opts.behavior === 'always') return 'resume'
  if (opts.behavior === 'never') return 'fresh'
  if (opts.restorableCount === 0) return 'resume'
  const cached = opts.decisionCache.get(opts.workspacePath)
  if (cached) return cached
  // Dialog dismissal resolves false — treated as "start fresh" (the cancel
  // button), never as silent resume.
  const decision: RestoreDecision = (await opts.ask()) ? 'resume' : 'fresh'
  opts.decisionCache.set(opts.workspacePath, decision)
  return decision
}
