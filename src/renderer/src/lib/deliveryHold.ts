/**
 * deliveryHold.ts
 *
 * What a failed injection owes the delivered-pending hold it took out before
 * writing. The hold is a COUNTER on the pane (useTerminal's
 * deliveredPendingCount), not a per-message flag: every mark is matched by
 * exactly one release, and a release too many settles a DIFFERENT outstanding
 * delivery's hold — the badge drops to idle while that message is still
 * unconsumed, and the pane becomes eligible for idle reclaim.
 */

/** Does a failed injection release the hold it marked before writing?
 *
 *  `leftInComposer` is injectText's own answer to where the bytes ended up.
 *  False means they were never seen in the input box — nothing will ever
 *  consume them, so the hold is ours to give back. True means they are
 *  visibly sitting in the composer after every Enter we were willing to
 *  press: the message can still be submitted by hand, and the user record
 *  that follows releases the hold on its own. Releasing here too spends a
 *  decrement the ledger owes to whichever delivery is still in flight. */
export function failedInjectReleasesHold(leftInComposer: boolean): boolean {
  return !leftInComposer
}
