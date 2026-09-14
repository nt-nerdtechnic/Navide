import { describe, expect, it } from 'vitest'

import { failedInjectReleasesHold } from '../deliveryHold'

/** The pane's counter, as useTerminal keeps it: marks and releases, no
 *  identity. Enough to show what one release too many costs. */
function ledger() {
  let count = 0
  return {
    mark: () => { count += 1 },
    release: () => { count = Math.max(0, count - 1) },
    get held() { return count },
  }
}

describe('failedInjectReleasesHold', () => {
  it('gives the hold back when the bytes never reached the input box', () => {
    expect(failedInjectReleasesHold(false)).toBe(true)
  })

  it('keeps it when the payload is still sitting in the composer', () => {
    expect(failedInjectReleasesHold(true)).toBe(false)
  })

  // The scenario the rule exists for. Two deliveries are outstanding; the
  // second reports failure because three Enters never emptied the box, but the
  // text IS in the box. Releasing there, and again when the user submits it by
  // hand, spends two decrements for one mark — and the first delivery, still
  // unconsumed, loses its hold.
  it('leaves an unrelated delivery still held when the user submits by hand', () => {
    const pane = ledger()
    pane.mark()  // delivery A, in flight
    pane.mark()  // delivery B, injected
    if (failedInjectReleasesHold(true)) pane.release()  // B reports failure
    expect(pane.held).toBe(2)
    pane.release()  // the user pressed Enter; B's user record arrives
    expect(pane.held).toBe(1)  // A is still waiting to be consumed
  })
})
