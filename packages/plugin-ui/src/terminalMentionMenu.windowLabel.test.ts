// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'

import { createTerminalMentionMenu } from './terminalMentionMenu'
import { AI_PANEL_ICON_PATH, type MentionCandidate } from './terminalMentionModel'

// An embedded AI panel (a Pipeline Manager / Plan / Git / Editor dock) sits on
// the messaging roster next to ordinary panes, and its address alone does not
// say it is a panel. A row that carries `windowLabel` names its window in a
// chip; every row without one is drawn exactly as it always was.

function fakeTerminal(): Terminal {
  return {
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 17 } } } } },
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    focus(): void {},
  } as unknown as Terminal
}

function openMenu(candidates: MentionCandidate[]) {
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  host.appendChild(screen)
  document.body.appendChild(host)
  const menu = createTerminalMentionMenu({ terminal: fakeTerminal(), host: () => host, onPick: () => {} })
  menu.open(candidates)
  return menu
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.term-mention-row')]

afterEach(() => {
  document.body.replaceChildren()
})

describe('mention menu — the window an embedded panel lives in', () => {
  it('draws a window chip for a panel row, after its address', () => {
    const menu = openMenu([
      { address: 'Agent-Team/pm-claude', group: '/ws', windowLabel: 'Pipeline Manager' },
    ])
    const row = rows()[0]
    const chip = row.querySelector('.term-mention-window')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('Pipeline Manager')
    expect(chip!.querySelector('svg path')!.getAttribute('d')).toBe(AI_PANEL_ICON_PATH)
    // The chip sits after the address, so the address column stays aligned.
    const kids = [...row.children].map((el) => el.className)
    expect(kids.indexOf('term-mention-window')).toBeGreaterThan(kids.indexOf('term-mention-name'))
    menu.close()
  })

  it('draws an ordinary pane row exactly as before — no chip, same DOM', () => {
    const menu = openMenu([
      { address: 'claude-1', group: 'g', status: 'running', statusLabel: 'Running' },
      { address: 'other/codex-1', group: 'h' },
    ])
    expect(document.querySelector('.term-mention-window')).toBeNull()
    expect(rows().map((r) => r.outerHTML)).toMatchSnapshot()
    menu.close()
  })

  it('keeps the fixed card width unless a panel is listed', () => {
    let menu = openMenu([{ address: 'claude-1' }])
    expect(document.querySelector<HTMLElement>('.term-mention-card')!.style.width).toBe('248px')
    menu.close()
    menu = openMenu([{ address: 'Agent-Team/pm-claude', windowLabel: 'Pipeline Manager' }])
    const card = document.querySelector<HTMLElement>('.term-mention-card')!
    expect(card.style.width).toBe('max-content')
    expect(card.style.maxWidth).toBe('360px')
    menu.close()
  })
})
