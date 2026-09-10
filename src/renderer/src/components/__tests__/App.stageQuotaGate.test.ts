// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of the pipeline quota gate. The decisions themselves are
// covered by real behaviour tests in lib/__tests__/completion.test.ts and
// lib/__tests__/managerStageWatchdog.test.ts; what cannot be asserted there is
// the WIRING — that every path which can advance a stage actually passes the
// quota answer in. Miss one and the pure functions stay green while the
// cascade comes back: a quota-exhausted turn read as the slot finishing its
// work, N/N, advance, and the limit message handed to the next stage as if it
// were output.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('the quota answer comes from one place', () => {
  it('pairs the flag with usageLimitDue instead of reading it bare', () => {
    // Only the pane health watcher's 5-second poll clears usageLimitAt, so a
    // bare `!= null` can be a poll stale — long enough to hold a stage on a
    // window that already reset.
    const helper = body('function paneUsageLimited(', '\n}')
    expect(helper).toContain('usageLimitDue(pane.usageLimitAt, pane.usageLimitUntil ?? null, Date.now())')
    expect(helper).toContain('return false')
  })
})

describe('every stage-advancing path passes the quota answer', () => {
  it('marks a quota-blocked slot in the signals the stage gate reads', () => {
    // computeStageSlotSignals is the ONLY SlotSignal builder, so this is the
    // single point where allSlotsFinished can learn about the quota.
    const fn = body('function computeStageSlotSignals(', '\n}')
    expect(fn).toContain('quotaBlocked: paneUsageLimited(p.id)')
  })

  it('raises a quota stall from the stage watcher rather than leaving it to the cap', () => {
    // The hour-long cap would eventually fire, but it says nothing about WHY
    // the stage went quiet — and it fires an hour late.
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const quota = watcher.indexOf('const quotaBlocked = paneUsageLimited(paneId)')
    const done = watcher.indexOf('turnCompleteDone({')
    expect(quota).toBeGreaterThan(-1)
    expect(done).toBeGreaterThan(quota)
    // The guard itself, not just the call inside it. Asserting only the
    // promptStageStall line let `if (false)` through — the branch was dead and
    // every assertion here still passed (found by mutation testing).
    expect(watcher).toContain('if (quotaBlocked) {')
    expect(watcher).toContain("promptStageStall(stageIndex, paneId, 'quota', detail)")
  })

  it('also poisons the completion verdict, because the stall can be suppressed', () => {
    // promptStageStall returns early when another prompt is already showing.
    // Without this the same poll falls straight through to the false completion
    // it just declined to raise.
    const watcher = body('function startStageWatcher(', '\n      // 3. Analyzer')
    const call = watcher.slice(watcher.indexOf('turnCompleteDone({'))
    expect(call).toContain('quotaBlocked')
  })

  it('gives Full auto its own quota arm, because single-slot advances blind', () => {
    // fullAutoStallAction force-advances a single-slot stage without consulting
    // the slot gate at all, so the multi-slot SlotSignal route cannot cover it.
    const prompt = body('function promptStageStall(', '\n/** User clicked')
    const call = prompt.slice(prompt.indexOf('fullAutoStallAction({'))
    expect(call).toContain("quotaBlocked: p.reason === 'quota' || paneUsageLimited(p.paneId)")
  })

  it('tells the Manager watchdog about the Manager pane', () => {
    // Manager mode arms no per-pane watcher, so nothing else notices.
    const scan = body('const verdict = evaluateManagerStage({', '\n    })')
    expect(scan).toContain('managerQuotaBlocked: paneUsageLimited(router.managerPaneId)')
  })
})

describe('the stall says which kind of stall it is', () => {
  it('carries a quota reason through the prompt type and the signature', () => {
    // Two separate declarations — the interface field and the function
    // parameter. Updating only one is a type error, but only for the callers
    // that pass the new value.
    expect(appSource).toContain("reason: 'idle' | 'cap' | 'quota'")
    expect(appSource).toContain("reason: 'idle' | 'cap' | 'quota',")
  })

  it('maps the Manager quota verdict to the quota reason, not to idle', () => {
    // The old mapping was `verdict === 'timeout' ? 'cap' : 'idle'`, which would
    // label a quota stall "no output detected".
    const scan = body('const stallReason =', '\n      promptStageStall')
    expect(scan).toContain("verdict === 'quota' ? 'quota'")
  })

  it('renders a third reason label instead of falling into the timeout wording', () => {
    // The template ternary was binary: anything that was not 'idle' printed
    // "已達時間上限", so a quota stall would have claimed a timeout.
    expect(appSource).toContain("stageStallPrompt.reason === 'quota'")
    expect(appSource).toContain('⛔ 額度已用完')
  })

  it('explains that waiting does not auto-resume', () => {
    // The residual this change does not fix: the window resets on its own but
    // nothing re-drives the stage, so the hint must not imply it will.
    expect(appSource).toContain('重置後不會自動接續')
  })
})

describe('the loop no longer resends into an exhausted CLI', () => {
  it('passes the quota flag to loopContinueReady', () => {
    // The loop's quota branch schedules a timed resume only when a reset time
    // was resolvable; when it was not it fails open and leaves loopWaitUntil
    // null, and the next poll used to fall through to auto-continue.
    const watcher = body('function startLoopLimitWatcher(', '}, LOOP_LIMIT_POLL_MS)')
    const call = watcher.slice(watcher.indexOf('loopContinueReady({'))
    expect(call).toContain('quotaBlocked: pane.usageLimitAt != null')
  })
})
