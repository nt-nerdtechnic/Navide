import { describe, expect, it } from 'vitest'
import { awaitingPromptText, parseMenuOptions, resolveAnswerKeys, type PaneAnswer } from '../paneAnswerKeys'

const CLAUDE_PERMISSION = [
  'Do you want to make this edit to useTerminal.ts?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again this session",
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n')

const CLAUDE_QUESTION = [
  '  1. Merge them into one state',
  '  2. Keep them separate',
  '  3. Type something.',
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate· Esc to cancel',
].join('\n')

const CODEX_PERMISSION = [
  'Would you like to run the following command?',
  '› 1. Yes, just this once',
  "  2. Yes, and don't ask again for this command in this session",
  '  3. No, and tell Codex what to do differently',
].join('\n')

function resolve(agentKey: string, answer: PaneAnswer, screen: string, awaitingKind: string | null = answer.kind) {
  return resolveAnswerKeys({ agentKey, displayStatus: 'awaiting', awaitingKind, screen, answer })
}

describe('parseMenuOptions', () => {
  it('reads the numbered options with or without a cursor marker', () => {
    expect(parseMenuOptions(CLAUDE_PERMISSION)).toEqual([
      'Yes',
      "Yes, and don't ask again this session",
      'No, and tell Claude what to do differently (esc)',
    ])
    expect(parseMenuOptions(CLAUDE_QUESTION)).toHaveLength(4)
    expect(parseMenuOptions(CODEX_PERMISSION)[0]).toBe('Yes, just this once')
  })

  it('keeps the last menu when an older numbered list is still on screen', () => {
    expect(parseMenuOptions(`1. old\n2. list\nprose\n${CODEX_PERMISSION}`)[0]).toBe('Yes, just this once')
  })

  it('finds nothing in ordinary output', () => {
    expect(parseMenuOptions('Running tests…\n12 passed')).toEqual([])
  })
})

describe('awaitingPromptText', () => {
  it('keeps the last 12 non-empty lines within 800 characters', () => {
    const screen = Array.from({ length: 30 }, (_, i) => (i % 2 ? '' : `line ${i}`)).join('\n')
    const text = awaitingPromptText(screen)
    expect(text.split('\n')).toHaveLength(12)
    expect(text.endsWith('line 28')).toBe(true)
    expect(awaitingPromptText('x'.repeat(2000))).toHaveLength(800)
  })
})

describe('resolveAnswerKeys', () => {
  it('maps a claude permission to 1 / Esc', () => {
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION)).toEqual({ ok: true, keys: '1' })
    expect(resolve('claude', { kind: 'permission', choice: 'deny' }, CLAUDE_PERMISSION)).toEqual({ ok: true, keys: '\x1b' })
  })

  it('maps a codex permission the same way', () => {
    expect(resolve('codex', { kind: 'permission', choice: 'allow' }, CODEX_PERMISSION)).toEqual({ ok: true, keys: '1' })
    expect(resolve('codex', { kind: 'permission', choice: 'deny' }, CODEX_PERMISSION)).toEqual({ ok: true, keys: '\x1b' })
  })

  it('maps a question option to its digit, only if the menu has it', () => {
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION)).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 5 }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'question', option: 0 }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
  })

  it('answers aider with y/n and Enter, and refuses questions there', () => {
    expect(resolve('aider', { kind: 'permission', choice: 'allow' }, '')).toEqual({ ok: true, keys: 'y\r' })
    expect(resolve('aider', { kind: 'permission', choice: 'deny' }, '')).toEqual({ ok: true, keys: 'n\r' })
    expect(resolve('aider', { kind: 'question', option: 1 }, '')).toEqual({ ok: false, error: 'unsupported for aider' })
  })

  it('refuses a vendor with no known mapping', () => {
    expect(resolve('kimi', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION)).toEqual({
      ok: false,
      error: 'unsupported for kimi',
    })
  })

  it('refuses unless the pane is awaiting the same kind', () => {
    expect(
      resolveAnswerKeys({
        agentKey: 'claude',
        displayStatus: 'running',
        awaitingKind: null,
        screen: CLAUDE_PERMISSION,
        answer: { kind: 'permission', choice: 'allow' },
      })
    ).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_PERMISSION, 'question')).toMatchObject({ ok: false })
  })

  it('answers a question menu whatever awaitingKind says, as long as the option is on screen', () => {
    // claude's AskUserQuestion box reports awaitingKind 'permission'.
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION, 'permission')).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 2 }, CLAUDE_QUESTION, 'question')).toEqual({ ok: true, keys: '2' })
    expect(resolve('claude', { kind: 'question', option: 5 }, CLAUDE_QUESTION, 'permission')).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'question', option: 1 }, 'no menu here', 'question')).toMatchObject({ ok: false })
  })

  it('refuses when the screen does not show the menu the answer assumes', () => {
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, 'plain output')).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'allow' }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
    expect(resolve('claude', { kind: 'permission', choice: 'deny' }, CLAUDE_QUESTION)).toMatchObject({ ok: false })
  })
})
