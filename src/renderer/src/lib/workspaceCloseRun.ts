/** Does closing a workspace end the pipeline run this window is tracking?
 *
 *  A window holds several workspaces but exactly ONE pipeline run, tracked in
 *  `pipeline.workspacePath`. Closing a workspace kills that workspace's panes,
 *  and every kill releases the killed pane's stage slot — so a stage whose
 *  other slots already finished reaches N/N and advances, spawning the next
 *  stage into a workspace that is being torn down. That is why the close path
 *  has to stop the orchestration first.
 *
 *  Both halves of the question are load-bearing, and asking only one is worse
 *  than asking neither:
 *
 *   • Only "are any doomed panes pipeline-origin?" — a pane whose `origin` is
 *     'pipeline' outlives the run it belonged to, because abort is a PAUSE that
 *     leaves the agents alive. Close workspace B, whose old run was aborted
 *     when the user switched to A, while a NEW run is live in A: B's leftover
 *     panes match, and the guard tears down A's running pipeline and sends
 *     A's backend an abort. Closing B killed the run in A.
 *
 *   • Only "is the run's workspace the one closing?" — true, but says nothing
 *     about whether this close actually takes any of the run's panes with it,
 *     and the origin check is what documents which panes those are.
 *
 *  Paths are compared as given: callers normalize first (App.vue passes both
 *  through its `normWs`), because the trailing-slash rule belongs to the caller
 *  that reads these paths off panes and workspace lists.
 */
export interface WorkspaceCloseProbe {
  /** `pipeline.state` — only a run that is actually running can be ended. */
  state: string
  /** `pipeline.workspacePath`, normalized: the workspace the run belongs to. */
  runWorkspacePath: string
  /** The workspace being closed, normalized. */
  closingWorkspacePath: string
  /** `origin` of every pane this close will kill. */
  doomedOrigins: readonly string[]
}

export function closeEndsTheRun(probe: WorkspaceCloseProbe): boolean {
  if (probe.state !== 'running') return false
  if (probe.runWorkspacePath !== probe.closingWorkspacePath) return false
  return probe.doomedOrigins.includes('pipeline')
}

/** Does the window's pipeline run block restoring THIS workspace's panes?
 *
 *  A restore recreates panes from records, so it must not run for a workspace
 *  whose panes are already on screen — which is what a live or paused run
 *  means for the workspace it belongs to. Every OTHER workspace in the window
 *  is a different question, and answering it window-wide is what made a run
 *  paused in one project refuse to bring back another project's panes, whose
 *  records a workspace close deliberately keeps.
 *
 *  `runWorkspacePath` must come from a field that names the RUN's workspace
 *  and nothing else. `pipeline.workspacePath` is not that: onWorkspaceBrowse
 *  reassigns it to whatever workspace is being entered, so passing it compares
 *  a workspace with itself and blocks everything — the window-wide behaviour
 *  this replaced, wearing a scope that looks narrower than it is.
 *
 *  An empty `runWorkspacePath` means the run's workspace is unknown, and an
 *  unknown one blocks: restoring panes on top of live ones duplicates them,
 *  while refusing costs a reopen.
 */
export interface RestoreRunProbe {
  /** `pipeline.state`. Only 'running' and 'aborted' mean panes are alive. */
  state: string
  /** The run's own workspace, normalized. Empty when unknown. */
  runWorkspacePath: string
  /** The workspace whose panes are about to be restored, normalized. */
  restoringWorkspacePath: string
}

export function restoreBlockedByRun(probe: RestoreRunProbe): boolean {
  if (probe.state !== 'running' && probe.state !== 'aborted') return false
  if (!probe.runWorkspacePath) return true
  return probe.runWorkspacePath === probe.restoringWorkspacePath
}

/** Which confirm-close body the panes of a workspace call for.
 *
 *  Three sentences can be true of a close, and picking the wrong one makes the
 *  dialog promise something the teardown does not do: manual and mcp panes
 *  keep their records and come back as click-to-resume cards, while pipeline
 *  panes are unspawned with the run — so a body that speaks for "every pane"
 *  is only correct when the workspace holds none of the latter, and the body
 *  that names the ones that will not come back reads as nonsense when it is
 *  describing all of them.
 *
 *  Returns the full i18n key, so the caller interpolates once and the choice
 *  itself is testable without mounting anything.
 */
export function closeDialogBodyKey(counts: { count: number, pipelineCount: number }): string {
  if (counts.count <= 0) return 'confirm-close.sidebar-ws-body-empty'
  // >= rather than ===: a count that somehow exceeds the total still means
  // "nothing here survives the close", which is the sentence that stays true.
  if (counts.pipelineCount >= counts.count) return 'confirm-close.sidebar-ws-body-pipeline-only'
  if (counts.pipelineCount > 0) return 'confirm-close.sidebar-ws-body-pipeline'
  return 'confirm-close.sidebar-ws-body'
}
