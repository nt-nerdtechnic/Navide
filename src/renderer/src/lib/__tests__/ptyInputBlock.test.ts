import { describe, expect, it, vi } from 'vitest'

import {
  awaitEcho, awaitInputUnblocked, createInputBlockTracker, needsInputWait,
  INPUT_BLOCK_PROBE_MS, MESSAGE_OUTPUT_ROUNDS, PROBE_SESSION_GONE,
  type EchoWatchDeps, type InputWaitDeps,
} from '../ptyInputBlock'

describe('createInputBlockTracker', () => {
  it('keeps one episode per session and its original start', () => {
    const t = createInputBlockTracker()
    expect(t.get('s1')).toBeNull()
    t.onBlocked('s1', 779, 1_000)
    t.onBlocked('s1', 1_200, 5_000)
    expect(t.get('s1')).toEqual({ pending: 1_200, since: 1_000 })
    expect(t.get('s2')).toBeNull()
    t.onUnblocked('s1')
    expect(t.get('s1')).toBeNull()
  })
})

describe('needsInputWait', () => {
  it('waits on pending bytes or an open episode, and only then', () => {
    expect(needsInputWait(0, false)).toBe(false)
    expect(needsInputWait(300, false)).toBe(true)
    expect(needsInputWait(0, true)).toBe(true)
  })
})

describe('awaitInputUnblocked', () => {
  /** A fake clock the poll sleeps advance, so the probe cadence is exact. */
  function harness(over: Partial<InputWaitDeps<'tail'>> = {}) {
    let clock = 0
    const onHold = vi.fn()
    const deps: InputWaitDeps<'tail'> = {
      ackPending: 300,
      blocked: () => false,
      probe: vi.fn(async (): Promise<number | null> => 0),
      drained: vi.fn(),
      echoed: () => null,
      aborted: () => false,
      onHold,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      pollMs: 200,
      ...over,
    }
    // Spies read back through `deps`, so an override is the one asserted on.
    return { deps, onHold, drained: deps.drained, probe: deps.probe, clock: () => clock }
  }

  it('hands over to the echo watch once a probe finds nothing pending', async () => {
    const h = harness()
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'watch' })
    // One probe, at the first probe tick, and it was what ended the wait.
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.clock()).toBeGreaterThanOrEqual(INPUT_BLOCK_PROBE_MS)
    expect(h.clock()).toBeLessThan(INPUT_BLOCK_PROBE_MS + 400)
    // A drained probe closes the session's episode on the caller's side.
    expect(h.drained).toHaveBeenCalledTimes(1)
    // A queue that drained within one probe was never confirmed as a block.
    expect(h.onHold).not.toHaveBeenCalled()
  })

  // The bug this exists for: the PTY is not reading, and the old echo timeout
  // resent the whole payload. A blocked session waits with no upper bound —
  // here 60s, forty times the echo timeout — probing once a second, and
  // reports why.
  it('holds on pty-blocked for as long as probes find bytes pending', async () => {
    let probes = 0
    const h = harness({ probe: async () => (++probes >= 60 ? 0 : 300) })
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'watch' })
    expect(probes).toBe(60)
    expect(h.clock()).toBeGreaterThanOrEqual(60 * INPUT_BLOCK_PROBE_MS)
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  it('reports the hold once, not on every poll or probe', async () => {
    let probes = 0
    const h = harness({ probe: async () => (++probes >= 5 ? 0 : 300) })
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'watch' })
    expect(h.onHold).toHaveBeenCalledTimes(2)
  })

  // The events are accelerators: an episode closing after it was seen open
  // ends the wait on the next poll, without waiting for the probe tick.
  it('ends on the unblocked event before the next probe', async () => {
    let blocked = true
    const h = harness({ blocked: () => blocked, probe: vi.fn(async () => 300) })
    const run = awaitInputUnblocked({
      ...h.deps,
      // The event lands during the first poll's sleep.
      sleep: async (ms) => { await h.deps.sleep(ms); blocked = false },
    })
    await expect(run).resolves.toEqual({ outcome: 'watch' })
    expect(h.clock()).toBeLessThan(INPUT_BLOCK_PROBE_MS)
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  // The tracker says blocked but the unblocked event was lost: the probe is
  // still consulted, finds nothing pending, closes the episode through
  // `drained`, and the wait ends — it can never wedge on a stale episode.
  it('recovers from a lost unblocked event through the probe', async () => {
    const tracker = createInputBlockTracker()
    tracker.onBlocked('s1', 300, 0)
    const h = harness({
      ackPending: 0,
      blocked: () => tracker.get('s1') !== null,
      probe: vi.fn(async () => 0),
      drained: () => tracker.onUnblocked('s1'),
    })
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'watch' })
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(tracker.get('s1')).toBeNull()
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  // The session exited mid-episode: the backend refuses the probe (unknown
  // session). Nothing will ever read those bytes, so the wait ends as an
  // abort — the caller's give-up path — rather than polling a ghost forever.
  it('aborts when the probe says the session is gone', async () => {
    const h = harness({ probe: vi.fn(async () => PROBE_SESSION_GONE as typeof PROBE_SESSION_GONE) })
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'aborted' })
    expect(h.probe).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting on a failed probe until one answers', async () => {
    let probes = 0
    const h = harness({ probe: async () => (++probes < 3 ? null : 0) })
    await expect(awaitInputUnblocked(h.deps)).resolves.toEqual({ outcome: 'watch' })
    expect(probes).toBe(3)
  })

  it('is ready the moment the echo shows, even mid-episode', async () => {
    let polls = 0
    const h = harness({
      blocked: () => true,
      probe: vi.fn(async () => 300),
      echoed: () => (polls >= 3 ? 'tail' : null),
    })
    const run = awaitInputUnblocked({
      ...h.deps,
      sleep: async (ms) => { polls++; await h.deps.sleep(ms) },
    })
    await expect(run).resolves.toEqual({ outcome: 'ready', echo: 'tail' })
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  // The only way out the CLI does not provide: the pane closes, or the user
  // withdraws the message. The hold is released so the row does not keep
  // claiming a wait that ended.
  it('aborts when told to and releases the hold', async () => {
    let polls = 0
    const h = harness({
      blocked: () => true,
      probe: vi.fn(async () => 300),
      aborted: () => polls >= 2,
    })
    const run = awaitInputUnblocked({
      ...h.deps,
      sleep: async (ms) => { polls++; await h.deps.sleep(ms) },
    })
    await expect(run).resolves.toEqual({ outcome: 'aborted' })
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })
})

describe('awaitEcho', () => {
  /** Output is scripted per poll; the clock advances by the sleeps. */
  function harness(over: Partial<EchoWatchDeps<'tail'>> = {}) {
    let clock = 0
    let output = 0
    const onHold = vi.fn()
    const deps: EchoWatchDeps<'tail'> = {
      echoed: () => null,
      outputBytes: () => output,
      aborted: () => false,
      onHold,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      roundMs: 1_000,
      maxSilentRounds: 2,
      pollMs: 200,
      ...over,
    }
    return { deps, onHold, clock: () => clock, print: (n: number) => { output += n } }
  }

  it('is ready on the echo', async () => {
    let polls = 0
    const h = harness({ echoed: () => (polls >= 2 ? 'tail' : null) })
    const run = awaitEcho({ ...h.deps, sleep: async (ms) => { polls++; await h.deps.sleep(ms) } })
    await expect(run).resolves.toEqual({ outcome: 'ready', echo: 'tail' })
    expect(h.onHold).not.toHaveBeenCalled()
  })

  // A capped caller (kickoff, stage prompt, loop): the pane is alive and
  // painting but our tail is not in it. Said once, after one round — the
  // caller pastes exactly once and decides the rest (a kickoff re-types into
  // a blank composer at its own level).
  it('reports a painting-but-not-echoing pane after one round to a capped caller', async () => {
    const h = harness()
    const run = awaitEcho({ ...h.deps, sleep: async (ms) => { await h.deps.sleep(ms); h.print(40) } })
    await expect(run).resolves.toEqual({ outcome: 'resend' })
    expect(h.clock()).toBeGreaterThanOrEqual(1_000)
    expect(h.clock()).toBeLessThan(1_400)
  })

  // The message path never re-pastes, so output without our tail — B1 backlog
  // landing late, a footer repaint, a slow echo on a loaded host — is given
  // another round rather than turning into inject.failed + Ctrl-U after one.
  it('gives the message path more rounds when the pane paints without our tail', async () => {
    let rounds = 0
    const h = harness({
      maxSilentRounds: null,
      echoed: () => (rounds >= 2 ? 'tail' : null),
    })
    const run = awaitEcho({
      ...h.deps,
      // Paints every poll; the tail shows only in round 3.
      sleep: async (ms) => {
        await h.deps.sleep(ms)
        h.print(10)
        rounds = Math.floor(h.clock() / 1_000)
      },
    })
    await expect(run).resolves.toEqual({ outcome: 'ready', echo: 'tail' })
    expect(h.clock()).toBeGreaterThanOrEqual(2_000)
    expect(h.onHold).not.toHaveBeenCalled()
  })

  it('gives up the message path after MESSAGE_OUTPUT_ROUNDS painting rounds with no tail', async () => {
    const h = harness({ maxSilentRounds: null })
    const run = awaitEcho({ ...h.deps, sleep: async (ms) => { await h.deps.sleep(ms); h.print(10) } })
    await expect(run).resolves.toEqual({ outcome: 'unechoed' })
    expect(h.clock()).toBeGreaterThanOrEqual(MESSAGE_OUTPUT_ROUNDS * 1_000)
    expect(h.clock()).toBeLessThan(MESSAGE_OUTPUT_ROUNDS * 1_000 + 400)
  })

  // Silence is waited out without limit; only painting rounds count toward
  // the cap, and they need not be consecutive.
  it('does not count silent rounds toward the painting cap', async () => {
    let polls = 0
    const h = harness({ maxSilentRounds: null })
    const run = awaitEcho({
      ...h.deps,
      // Rounds 1 and 3 paint, rounds 2 and 4–10 are silent, round 11 paints.
      sleep: async (ms) => {
        polls++
        await h.deps.sleep(ms)
        const round = Math.ceil(polls / 5)
        if (round === 1 || round === 3 || round === 11) h.print(1)
      },
    })
    await expect(run).resolves.toEqual({ outcome: 'unechoed' })
    expect(h.clock()).toBeGreaterThanOrEqual(11_000)
  })

  // The user's exact case: 779 bytes fit the kernel's ~1KB queue, so the ack
  // said pending 0 and no episode was announced, yet nothing was reading. The
  // old echo timeout then re-pasted, only the second copy hit EAGAIN, and the
  // CLI read both copies as one prompt. Silence is not an invitation.
  it('never resends into a pane that printed nothing — capped callers give up', async () => {
    const h = harness({ maxSilentRounds: 2 })
    await expect(awaitEcho(h.deps)).resolves.toEqual({ outcome: 'silent' })
    expect(h.clock()).toBeGreaterThanOrEqual(2_000)
    expect(h.clock()).toBeLessThan(2_400)
    // Held after the first silent round, released on the way out.
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  it('waits out silence with no upper bound for the messaging path', async () => {
    let polls = 0
    const h = harness({
      maxSilentRounds: null,
      // Sixty rounds of nothing, then the CLI wakes and echoes.
      echoed: () => (polls >= 300 ? 'tail' : null),
    })
    const run = awaitEcho({ ...h.deps, sleep: async (ms) => { polls++; await h.deps.sleep(ms) } })
    await expect(run).resolves.toEqual({ outcome: 'ready', echo: 'tail' })
    expect(h.clock()).toBeGreaterThanOrEqual(60_000)
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })

  // Output the backend had buffered BEFORE the write (a reader paused under
  // back-pressure, catching up after the ack) is not a reaction to it. The
  // baseline is taken at the top of the round, so that backlog does not count.
  it('does not read pre-write backlog as the pane reacting', async () => {
    const h = harness()
    // Backlog lands between the ack and the first round's baseline.
    h.print(5_000)
    await expect(awaitEcho(h.deps)).resolves.toEqual({ outcome: 'silent' })
  })

  it('judges each round on its own output, not the previous one', async () => {
    let polls = 0
    const h = harness({ maxSilentRounds: 3 })
    const run = awaitEcho({
      ...h.deps,
      // Prints only during round 1; rounds 2 and 3 are silent.
      sleep: async (ms) => { polls++; await h.deps.sleep(ms); if (polls === 1) h.print(30) },
    })
    // Round 1 printed → resend is allowed at once; the rule is per round.
    await expect(run).resolves.toEqual({ outcome: 'resend' })
  })

  it('aborts when told to and releases the hold', async () => {
    let polls = 0
    const h = harness({ maxSilentRounds: null, aborted: () => polls >= 7 })
    const run = awaitEcho({ ...h.deps, sleep: async (ms) => { polls++; await h.deps.sleep(ms) } })
    await expect(run).resolves.toEqual({ outcome: 'aborted' })
    expect(h.onHold.mock.calls).toEqual([[true], [false]])
  })
})

// The two waits back to back, as injectText runs them: a pending ack goes to
// the blocked wait, and once that hands over, the echo watch judges silence on
// its own — a stale `pending > 0` from the ack cannot short-circuit the rule.
describe('blocked wait handing over to the echo watch', () => {
  it('ack 1026 → probe 0 → watch → silent round → no resend', async () => {
    let clock = 0
    const sleep = async (ms: number): Promise<void> => { clock += ms }
    const now = (): number => clock
    const waited = await awaitInputUnblocked<'tail'>({
      ackPending: 1_026,
      blocked: () => false,
      probe: async () => 0,
      drained: () => {},
      echoed: () => null,
      aborted: () => false,
      onHold: () => {},
      sleep,
      now,
    })
    expect(waited).toEqual({ outcome: 'watch' })
    const watched = await awaitEcho<'tail'>({
      echoed: () => null,
      outputBytes: () => 0,
      aborted: () => false,
      onHold: () => {},
      sleep,
      now,
      roundMs: 1_000,
      maxSilentRounds: 2,
    })
    expect(watched).toEqual({ outcome: 'silent' })
  })
})
