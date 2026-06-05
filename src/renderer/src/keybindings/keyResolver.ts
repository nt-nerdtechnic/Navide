import type { KeybindingRule, ParsedKey } from './types'
import { evaluateWhen } from './whenEvaluator'
import { matchesEvent, parsedKeyEquals, parseKeySpec, eventToParsedKey } from './parseKey'

interface ResolvedBinding {
  rule: KeybindingRule
  keys: ParsedKey[]
}

export class KeyResolver {
  // Rules are stored in priority order: last rule wins (user rules beat defaults).
  private readonly bindings: ResolvedBinding[]
  private chordState: ParsedKey | null = null

  constructor(rules: KeybindingRule[]) {
    // Reverse so rules appearing later have higher priority (checked first).
    this.bindings = rules
      .map((rule) => ({ rule, keys: parseKeySpec(rule.key) }))
      .reverse()
  }

  resolve(
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    // Ignore bare modifier key presses.
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null

    if (this.chordState) {
      const first = this.chordState
      this.chordState = null
      return this.resolveChord(first, e, ctx)
    }

    // Check if this key starts any chord that is eligible in the current context.
    const startsChord = this.bindings.some(
      (b) =>
        b.keys.length === 2 &&
        matchesEvent(b.keys[0], e) &&
        (!b.rule.when || evaluateWhen(b.rule.when, ctx)),
    )
    if (startsChord) {
      this.chordState = eventToParsedKey(e)
      return null
    }

    return this.resolveSingle(e, ctx)
  }

  resetChord(): void {
    this.chordState = null
  }

  private resolveSingle(
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    for (const { rule, keys } of this.bindings) {
      if (keys.length !== 1) continue
      if (!matchesEvent(keys[0], e)) continue
      if (rule.when && !evaluateWhen(rule.when, ctx)) continue
      return rule
    }
    return null
  }

  private resolveChord(
    first: ParsedKey,
    e: KeyboardEvent,
    ctx: Record<string, boolean | string>,
  ): KeybindingRule | null {
    for (const { rule, keys } of this.bindings) {
      if (keys.length !== 2) continue
      if (!parsedKeyEquals(keys[0], first)) continue
      if (!matchesEvent(keys[1], e)) continue
      if (rule.when && !evaluateWhen(rule.when, ctx)) continue
      return rule
    }
    return null
  }
}
