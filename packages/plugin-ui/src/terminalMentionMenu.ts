import type { Terminal } from '@xterm/xterm'

import {
  filterMentionCandidates,
  foldMentionText,
  MENTION_BROADCAST_ADDRESS,
  type MentionCandidate,
} from './terminalMentionModel'

export interface TerminalMentionMenuOptions {
  terminal: Terminal
  host: () => HTMLElement | null
  onPick: (query: string, addresses: string[]) => void
}

export interface TerminalMentionMenu {
  open(candidates: readonly MentionCandidate[]): void
  onData(data: string): void
  close(): void
  readonly active: boolean
}

/** The imperative terminal @-mention menu shared by public terminal surfaces. */
export function createTerminalMentionMenu(
  options: TerminalMentionMenuOptions,
): TerminalMentionMenu {
  const term = options.terminal
  let cleanup: (() => void) | null = null
  let typedData: ((data: string) => void) | null = null

  function close(): void {
    if (!cleanup) return
    const dispose = cleanup
    cleanup = null
    dispose()
  }

  /** Dot colour per pane status, matching the sidebar's .status-dot. */
  function mentionStatusColor(status: string | undefined): string {
    switch (status) {
      case 'running': return 'var(--success-fg)'
      case 'awaiting': return 'var(--warning-fg)'
      case 'idle': return 'var(--status-idle-fg)'
      case 'starting': return 'var(--status-starting-fg)'
      case 'error': return 'var(--danger-fg)'
      case 'exited':
      case 'stopped': return 'var(--text-disabled)'
      default: return ''
    }
  }

  function open(candidates: readonly MentionCandidate[]): void {
    if (cleanup) return          // one menu at a time
    if (!candidates.length) return           // nothing to offer
    const host = options.host()
    const screen = host?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const rect = screen.getBoundingClientRect()
    const cellW = (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
    const cellH = (term as any)._core?._renderService?.dimensions?.css?.cell?.height || 0
    if (!cellW || !cellH) return
    const buf = term.buffer.active
    // buf.cursorX / buf.cursorY are viewport-relative (cursorY counts rows from
    // the top of the visible area), matching the .xterm-screen rect origin.
    const cellLeft = rect.left + buf.cursorX * cellW
    const cellTop = rect.top + buf.cursorY * cellH
    const cellBottom = cellTop + cellH

    const root = document.createElement('div')
    root.className = 'term-mention-menu-root'
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: 'calc(var(--z-toast) + 200)',
      background: 'transparent',
    })

    const card = document.createElement('div')
    // This menu floats over the terminal, and the terminal is black in every
    // app theme — so it follows the terminal, not the app chrome. Dressing it
    // in the chrome's popover surface put a white card on a black screen when
    // the app theme was light, which is the mismatch this fixes.
    //
    // The colours are the --gray-*/--blue-* primitives, which base.css keeps
    // constant across themes; the semantic roles (--bg-overlay, --text-primary)
    // deliberately do not, so they are the wrong vocabulary here. This is the
    // same palette showTerminalFilePicker uses for the same reason — it spells
    // the hex literals out, these name them.
    card.className = 'term-mention-card'
    Object.assign(card.style, {
      position: 'fixed', left: `${cellLeft}px`, top: `${cellBottom}px`,
      width: '248px', maxHeight: '260px', overflowY: 'auto',
      background: 'var(--gray-11)', border: '1px solid var(--gray-8)',
      borderRadius: 'var(--radius-md)', boxShadow: '0 8px 28px rgba(0, 0, 0, 0.6)',
      outline: 'none', padding: '4px', boxSizing: 'border-box',
    })

    // The query line only appears once there is something to report, so an
    // untouched menu looks exactly like the one that shipped before.
    const queryEl = document.createElement('div')
    queryEl.className = 'term-mention-query'
    Object.assign(queryEl.style, {
      display: 'none', gap: '8px', alignItems: 'center', padding: '4px 8px 6px',
      margin: '0 0 4px', borderBottom: '1px solid var(--gray-9)',
      color: 'var(--gray-4)', fontSize: '12px',
    })
    const queryTextEl = document.createElement('span')
    Object.assign(queryTextEl.style, { flex: '1', color: 'var(--gray-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    const queryCountEl = document.createElement('span')
    queryEl.append(queryTextEl, queryCountEl)

    const listEl = document.createElement('div')
    card.append(queryEl, listEl)

    let query = ''
    let selectedIdx = 0
    /** Addresses ticked with Space, in tick order — the order they are inserted. */
    const checked: string[] = []
    let visible: MentionCandidate[] = [...candidates]
    const rows: HTMLElement[] = []

    function renderSelection(): void {
      rows.forEach((row, i) => {
        const on = i === selectedIdx
        row.style.background = on ? 'var(--gray-9)' : ''
        row.classList.toggle('is-selected', on)
      })
      rows[selectedIdx]?.scrollIntoView({ block: 'nearest' })
    }

    /** Address text with the matched run tinted, so a filtered list shows WHY
     * each row survived. Built from indexOf rather than a regex: an address is
     * arbitrary user text and would otherwise need escaping. */
    function appendHighlighted(el: HTMLElement, address: string): void {
      // Same folding as filterMentionCandidates, so the tinted run is the run
      // that matched. Offsets are only trusted when folding kept the length
      // (it does for case and full-width ↔ half-width); otherwise skip the tint.
      const folded = foldMentionText(address)
      const needle = foldMentionText(query)
      const at = query && folded.length === address.length ? folded.indexOf(needle) : -1
      if (at < 0 || needle.length !== query.length) { el.textContent = address; return }
      const hit = document.createElement('span')
      hit.className = 'term-mention-hit'
      hit.textContent = address.slice(at, at + query.length)
      Object.assign(hit.style, { color: 'var(--blue-2)', fontWeight: '700' })
      el.append(
        document.createTextNode(address.slice(0, at)),
        hit,
        document.createTextNode(address.slice(at + query.length))
      )
    }

    function buildRows(): void {
      listEl.replaceChildren()
      rows.length = 0
      // Headers only earn their space when they separate something: a filtered
      // list is usually one group, and a lone header above every row is noise.
      const groups = new Set(visible.map((c) => c.group).filter(Boolean))
      const showGroups = groups.size > 1
      let lastGroup: string | undefined
      visible.forEach((cand, i) => {
        if (showGroups && cand.group && cand.group !== lastGroup) {
          lastGroup = cand.group
          const hdr = document.createElement('div')
          hdr.className = 'term-mention-group'
          // Keyed on `group` (a path for workspace sections), titled with
          // `groupLabel` — never print a raw key at the user.
          hdr.textContent = cand.groupLabel ?? cand.group
          Object.assign(hdr.style, {
            padding: '6px 8px 3px', color: 'var(--gray-4)', fontSize: '10.5px',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          })
          listEl.appendChild(hdr)
        }
        const row = document.createElement('div')
        row.className = 'term-mention-row'
        row.dataset.address = cand.address
        Object.assign(row.style, {
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '5px 8px', cursor: 'pointer', color: 'var(--gray-3)',
          fontSize: '13px', whiteSpace: 'nowrap',
          // Inset and rounded, so the selection reads as one item rather than a
          // band running edge to edge across the card.
          borderRadius: 'var(--radius-xs)',
        })

        const isChecked = checked.includes(cand.address)
        const box = document.createElement('span')
        box.className = 'term-mention-box'
        row.classList.toggle('is-checked', isChecked)
        Object.assign(box.style, {
          flex: 'none', width: '11px', height: '11px', borderRadius: '3px',
          border: `1px solid ${isChecked ? 'var(--blue-2)' : 'var(--gray-4)'}`,
          background: isChecked ? 'var(--blue-2)' : 'transparent',
        })

        const dot = document.createElement('span')
        dot.className = 'term-mention-dot'
        if (cand.status) dot.dataset.status = cand.status
        const fill = mentionStatusColor(cand.status)
        Object.assign(dot.style, {
          flex: 'none', width: '7px', height: '7px', borderRadius: '50%',
          background: fill || 'transparent',
          border: fill ? 'none' : '1px solid var(--gray-4)',
        })

        const name = document.createElement('span')
        name.className = 'term-mention-name'
        Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' })
        appendHighlighted(name, cand.address)

        row.append(box, dot, name)
        if (cand.statusLabel) {
          const tag = document.createElement('span')
          tag.className = 'term-mention-status'
          tag.textContent = cand.statusLabel
          Object.assign(tag.style, { flex: 'none', color: 'var(--gray-4)', fontSize: '11px' })
          row.appendChild(tag)
        }

        row.addEventListener('mouseenter', () => { selectedIdx = i; renderSelection() })
        row.addEventListener('mousedown', (e) => { e.preventDefault(); selectedIdx = i; pick() })
        rows.push(row)
        listEl.appendChild(row)
      })
    }

    function renderQueryLine(): void {
      const show = query !== '' || checked.length > 0
      queryEl.style.display = show ? 'flex' : 'none'
      if (!show) return
      queryTextEl.textContent = query ? `@${query}` : ''
      queryCountEl.textContent = checked.length
        ? `✓ ${checked.length}`
        : `${visible.length}`
    }

    /** Re-derive the visible list from the current query and redraw. Returns
     * false when nothing matches — the caller closes the menu and hands the
     * prompt back to the CLI's own completion. */
    function refilter(): boolean {
      const next = filterMentionCandidates(candidates, query)
      if (!next.length) return false
      const keep = visible[selectedIdx]?.address
      visible = next
      const at = keep ? next.findIndex((c) => c.address === keep) : -1
      selectedIdx = at >= 0 ? at : 0
      buildRows()
      renderQueryLine()
      renderSelection()
      placeCard()
      return true
    }

    function toggleCheck(): void {
      const cand = visible[selectedIdx]
      if (!cand) return
      const at = checked.indexOf(cand.address)
      if (at >= 0) {
        checked.splice(at, 1)
      } else if (cand.address === MENTION_BROADCAST_ADDRESS) {
        // Broadcast and roll-call are different gestures — "everyone" plus two
        // named panes would send those two twice.
        checked.length = 0
        checked.push(cand.address)
      } else {
        const bc = checked.indexOf(MENTION_BROADCAST_ADDRESS)
        if (bc >= 0) checked.splice(bc, 1)
        checked.push(cand.address)
      }
      buildRows()
      renderQueryLine()
      renderSelection()
    }

    function pick(): void {
      // No ticks means the highlighted row — so a user who never discovers
      // multi-select keeps the single-pick behaviour exactly as it was.
      const addresses = checked.length ? [...checked] : [visible[selectedIdx]?.address].filter(Boolean) as string[]
      close()
      term.focus()
      if (!addresses.length) return
      options.onPick(query, addresses)
    }

    /** Typed text arriving through term.onData while the menu is open. It has
     * already reached the PTY and inputBuffer by the ordinary path; the menu
     * only narrows the list. An IME commit lands here as one multi-character
     * chunk, which is the whole reason typing is read from onData rather than
     * keydown — during composition keydown carries pre-edit keystrokes, never
     * the text the user meant. */
    function onTypedData(data: string): void {
      if (data === '\x7f') {
        // Backspace past the query eats the '@' itself: nothing left to narrow.
        if (!query) { close(); return }
        query = [...query].slice(0, -1).join('')
      } else if (/[\x00-\x1f]/.test(data)) {
        // Control bytes and terminal reports (focus, mouse) are not typing.
        return
      } else {
        query += data
      }
      if (!refilter()) close()
    }

    /** Anchor the card under the cursor cell, clamped to the viewport. Re-run
     * after the list changes size: a filter that shortens the card would
     * otherwise leave a card flipped above the cursor floating away from it. */
    function placeCard(): void {
      const cardRect = card.getBoundingClientRect()
      let left = cellLeft
      let top = cellBottom
      if (left + cardRect.width > window.innerWidth) left = window.innerWidth - cardRect.width - 8
      if (left < 4) left = 4
      if (top + cardRect.height > window.innerHeight) top = cellTop - cardRect.height  // flip above
      if (top < 4) top = 4
      card.style.left = `${left}px`
      card.style.top = `${top}px`
    }

    buildRows()
    root.appendChild(card)
    document.body.appendChild(root)
    placeCard()

    // Document-capture keydown: intercept the menu's keys before xterm's textarea
    // can see them (capture phase + stopPropagation), so the CLI receives nothing
    // it should not while the menu is open. Every other key falls through to
    // xterm untouched — printable ones come back as term.onData, where
    // onTypedData narrows the list (see the header note).
    const onDocKeydown = (e: KeyboardEvent): void => {
      // IME guard: while a composition is live, e.key is a raw pre-edit
      // keystroke ('ㄒ', 'j', Enter to pick a candidate), NOT committed text.
      // Acting on it would steal the Enter/Backspace the IME needs. Let the
      // browser drive the composition; the committed text arrives through
      // term.onData and narrows the list from there.
      //
      // MUST stay the first branch: every branch below assumes e.key is real.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        if (selectedIdx < visible.length - 1) { selectedIdx++; renderSelection() }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        if (selectedIdx > 0) { selectedIdx--; renderSelection() }
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation()
        pick()
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        // Deliberately does NOT erase the query: the characters are already on
        // the prompt, and taking them back would undo typing the user meant.
        close(); term.focus()
      } else if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
        // Switching input source is how a CJK user reaches the keyboard they
        // came to search with, so it is the one chord that must not read as
        // "cancel": closing here lands exactly on the moment they were about
        // to start typing Chinese. Let it through untouched and keep the menu
        // open — whatever they commit afterwards arrives through term.onData
        // and narrows the list like any other typing.
        //
        // Stays ABOVE the chord branch, which would otherwise close, and above
        // the Space branch, which would otherwise tick a row.
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        // A shortcut chord (Cmd+A, etc.) — cancel the menu but let the chord
        // through rather than mangling it into a literal PTY keystroke. Refocus
        // the terminal so the chord (e.g. Cmd+V paste) lands there and typing
        // continues — closing the focused card would otherwise drop focus to
        // <body>, swallowing the chord and every keystroke after it.
        close(); term.focus()
      } else if (e.key === ' ') {
        e.preventDefault(); e.stopPropagation()
        toggleCheck()
      }
      // Backspace and printable keys fall through: xterm turns them into
      // onData ('\x7f', the character, or an IME-committed string), which
      // maintains inputBuffer as usual and then reaches onTypedData.
    }

    root.addEventListener('mousedown', (e) => { if (e.target === root) { close(); term.focus() } })
    // A click on the card (scrollbar, header) must not pull focus out of the
    // terminal: the textarea is where the next keystroke — and any IME
    // composition — has to land. Row picks already prevent default themselves.
    card.addEventListener('mousedown', (e) => e.preventDefault())
    document.addEventListener('keydown', onDocKeydown, true)
    typedData = onTypedData

    cleanup = (): void => {
      typedData = null
      document.removeEventListener('keydown', onDocKeydown, true)
      root.remove()
    }

    renderQueryLine()
    renderSelection()
  }

  return {
    open,
    onData(data: string): void {
      typedData?.(data)
    },
    close,
    get active(): boolean {
      return cleanup !== null
    },
  }
}
