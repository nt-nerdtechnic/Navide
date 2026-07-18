// Bootstrap hint pointing CLI agents at the workspace's plan-document spec.

/** One-line bootstrap hint telling any CLI agent where the plan rules live. */
export const PLAN_SPEC_HINT_LINE =
  'Plan documents for this workspace follow .agent-team/plans/_spec.md — read it before creating or updating any plan/report document.'

/** Block to append to injected bootstrap text; '' when the workspace has no provisioned spec. */
export function planSpecHintBlock(specAvailable: boolean): string {
  return specAvailable ? `\n\n${PLAN_SPEC_HINT_LINE}` : ''
}
