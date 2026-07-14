export interface WidthRebuildReadiness {
  displayStatus: string
  lastActiveAt: number
  turnCompleteAt: number
  lastRawActivityAt: number
  now: number
  rawQuietMs: number
}

export function isWidthRebuildReady(input: WidthRebuildReadiness): boolean {
  if (input.displayStatus !== 'idle') return false
  if (input.lastActiveAt > input.turnCompleteAt) return false
  return input.lastRawActivityAt <= 0 || input.now - input.lastRawActivityAt >= input.rawQuietMs
}

export interface WidthRebuildScheduleState {
  cols: number
  generation: number
  idleSince: number | null
}

export function coalesceWidthRebuild(
  current: WidthRebuildScheduleState | null,
  cols: number
): WidthRebuildScheduleState {
  if (current?.cols === cols) return current
  return {
    cols,
    generation: (current?.generation ?? 0) + 1,
    idleSince: null,
  }
}

export type WidthRebuildAdvance =
  | { action: 'retry'; idleSince: null; delayMs: number }
  | { action: 'wait'; idleSince: number; delayMs: number }
  | { action: 'rebuild'; idleSince: number; delayMs: 0 }

export function advanceWidthRebuild(
  idleSince: number | null,
  ready: boolean,
  now: number,
  idleGraceMs: number,
  retryMs: number
): WidthRebuildAdvance {
  if (!ready) return { action: 'retry', idleSince: null, delayMs: retryMs }
  if (idleSince === null) return { action: 'wait', idleSince: now, delayMs: idleGraceMs }
  const remaining = idleGraceMs - (now - idleSince)
  if (remaining > 0) return { action: 'wait', idleSince, delayMs: remaining }
  return { action: 'rebuild', idleSince, delayMs: 0 }
}
