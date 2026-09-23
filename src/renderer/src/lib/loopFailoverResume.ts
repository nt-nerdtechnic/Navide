import type {
  FailoverMode,
  FailoverRestartStrategy,
  FailoverSwitchMode,
} from '../composables/useQuotaFailover'

/** Settings key: a looping pane that runs out of quota resumes its loop right
 *  after the automatic account switch instead of waiting for the reset.
 *  Default off; only meaningful while the failover policy is "auto". */
export const LOOP_FAILOVER_RESUME_SETTING_KEY = 'agentTeam.loopFailoverResume'

/** How long an armed pane may wait for its switch to settle (flag cleared,
 *  CLI back at its prompt) before falling back to the Continue button. A
 *  restarted CLI can sit silent for 20-30s while it reloads its transcript. */
export const LOOP_FAILOVER_RESUME_TIMEOUT_MS = 3 * 60_000

/** Whether a committed failover switch should resume the pane's loop on its
 *  own. Only the switches the automatic policy can make qualify: a hot swap,
 *  or a restart that resumes the same conversation. A partial commit leaves
 *  restart panes unrestarted and a new-conversation switch is not the loop's
 *  conversation, so both keep the existing Continue button. */
export function shouldResumeLoopAfterFailover(input: {
  enabled: boolean
  policyMode: FailoverMode | null | undefined
  loopActive: boolean
  commitState: 'committed' | 'partial'
  switchMode: FailoverSwitchMode
  restartStrategy: FailoverRestartStrategy
}): boolean {
  if (!input.enabled || input.policyMode !== 'auto' || !input.loopActive) return false
  if (input.commitState !== 'committed') return false
  return input.switchMode === 'hot' || (input.switchMode === 'restart' && input.restartStrategy === 'resume')
}

/** One poll of an armed pane: resume once the exhausted account's flag is
 *  gone and the CLI is free at its prompt; give up (fall back to the Continue
 *  button) when that has not happened within the timeout. */
export function loopFailoverResumeStep(input: {
  armedAt: number
  now: number
  limitLit: boolean
  promptFree: boolean
}): 'wait' | 'resume' | 'give-up' {
  if (!input.limitLit && input.promptFree) return 'resume'
  return input.now - input.armedAt >= LOOP_FAILOVER_RESUME_TIMEOUT_MS ? 'give-up' : 'wait'
}
