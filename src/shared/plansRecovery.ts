/** Plans legacy-recovery vocabulary shared by the Host and the renderer.
 *
 * The Host decides recovery; the renderer only reports it. The one thing the
 * renderer has to tell apart is the storage entry, because that is the single
 * failure the repair action can actually act on — for every other entry the
 * repair reads a healthy record and answers "nothing to repair", which sends
 * the user looking at the wrong subsystem.
 */

/** Recovery entered because the durable Plans storage record could not be
 *  migrated or read. The only reason the storage repair addresses. */
export const PLANS_STORAGE_RECOVERY_REASON = 'storage-migration-failure'

export interface PlansV2RetryState {
  /** Whether the session is in legacy recovery at all. */
  recoveryEnabled: boolean
  /** NAVIDE_PLANS_RECOVERY=legacy — recovery is the operator's choice. */
  forced: boolean
  /** Whether a complete v2 package is still registered to re-arm. */
  hasCompleteV2Package: boolean
  /** Attempts left this session. */
  retriesLeft: number
}

export type PlansV2RetryDecision =
  | { outcome: 'not-in-recovery' }
  | { outcome: 'arm' }
  | { outcome: 'refused'; reason: string }

/**
 * Whether an explicit user retry may re-arm the v2 package.
 *
 * Unlike Git, re-arming is not proof of recovery: the Plans backend child is
 * spawned by the next Plans open, so this only restores the availability bit
 * and a still-broken package withdraws it again. Each attempt therefore costs
 * one from the budget with no refund, which is what stops a wedged package
 * from re-entering recovery on every tab switch for the rest of the session.
 */
export function decidePlansV2Retry(state: PlansV2RetryState): PlansV2RetryDecision {
  if (!state.recoveryEnabled) return { outcome: 'not-in-recovery' }
  if (state.forced) {
    return { outcome: 'refused', reason: 'NAVIDE_PLANS_RECOVERY=legacy is forcing legacy recovery' }
  }
  if (!state.hasCompleteV2Package) {
    return { outcome: 'refused', reason: 'no complete v2 package is registered this session' }
  }
  if (state.retriesLeft <= 0) return { outcome: 'refused', reason: 'no v2 attempt left this session' }
  return { outcome: 'arm' }
}
