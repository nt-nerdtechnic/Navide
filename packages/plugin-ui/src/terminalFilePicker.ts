export interface PickerItem {
  abs: string
  name: string
  dir: string
}

export interface TerminalFilePickerOpenRequest {
  initialQuery: string
  lineNum?: number
  preferredAbsPath?: string
  displayText?: string
}

export interface TerminalFilePicker {
  open(request: TerminalFilePickerOpenRequest): void
  close(): void
  readonly active: boolean
}

export interface TerminalFilePickerOptions {
  /** Search is owned by the Host; returned paths are untrusted display data. */
  query(query: string): Promise<PickerItem[]>
  /** The Host owns opening the selected path and its line number. */
  onPick(item: PickerItem, lineNum: number | undefined, event: MouseEvent | KeyboardEvent): void
  onClose?(reason: 'cancel' | 'select'): void
  /** Optional display-only home collapsing, supplied by the Host. */
  collapsePath?(dir: string): string
}

export function mergePreferredPath(
  items: PickerItem[],
  preferredAbsPath: string | undefined,
  isInitialQuery: boolean
): PickerItem[] {
  if (!preferredAbsPath || !isInitialQuery) return items
  const idx = items.findIndex((item) => item.abs === preferredAbsPath)
  if (idx === 0) return items
  if (idx > 0) {
    const copy = items.slice()
    copy.unshift(copy.splice(idx, 1)[0])
    return copy
  }
  const parts = preferredAbsPath.split('/')
  const name = parts.pop() ?? preferredAbsPath
  return [{ abs: preferredAbsPath, name, dir: parts.join('/') }, ...items]
}

/** Mount the existing Cmd-click file picker overlay without owning filesystem
 *  or authority operations. The injected query and pick callbacks stay Host
 *  owned; this helper only renders and manages the picker interaction. */
export function createTerminalFilePicker(options: TerminalFilePickerOptions): TerminalFilePicker {
  let closeCurrent: ((reason?: 'cancel' | 'select') => void) | null = null

  function close(reason: 'cancel' | 'select' = 'cancel'): void {
    const current = closeCurrent
    closeCurrent = null
    current?.(reason)
  }

  function open(request: TerminalFilePickerOpenRequest): void {
    close()
    document.querySelector('.term-file-picker-root')?.remove()

    const root = document.createElement('div')
    root.className = 'term-file-picker-root'
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '80px', background: 'rgba(0,0,0,0.35)',
    })

    const card = document.createElement('div')
    Object.assign(card.style, {
      background: '#161b22', border: '1px solid #30363d', borderRadius: '8px',
      width: '560px', maxHeight: '420px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 16px 48px rgba(0,0,0,0.8)', overflow: 'hidden',
    })

    const pickerInput = document.createElement('input')
    pickerInput.value = request.displayText ?? request.initialQuery
    pickerInput.placeholder = 'Search files...'
    Object.assign(pickerInput.style, {
      background: 'transparent', border: 'none', borderBottom: '1px solid #21262d',
      color: '#e6edf3', fontSize: '14px', padding: '12px 16px', outline: 'none',
      fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
    })

    const itemList = document.createElement('div')
    Object.assign(itemList.style, { overflowY: 'auto', flex: '1' })

    card.appendChild(pickerInput)
    card.appendChild(itemList)
    root.appendChild(card)
    document.body.appendChild(root)

    let currentItems: PickerItem[] = []
    let selectedIdx = 0
    let debounceTimer: ReturnType<typeof setTimeout>
    let searchPending = true

    function renderList(): void {
      itemList.innerHTML = ''
      if (!currentItems.length) {
        const msg = document.createElement('div')
        msg.textContent = searchPending ? 'Searching…' : 'No files found'
        Object.assign(msg.style, { padding: '10px 16px', color: '#6e7681', fontSize: '12px' })
        itemList.appendChild(msg)
        return
      }
      currentItems.forEach((item, i) => {
        const row = document.createElement('div')
        Object.assign(row.style, {
          padding: '7px 16px', cursor: 'pointer',
          display: 'flex', gap: '10px', alignItems: 'baseline',
          background: i === selectedIdx ? 'rgba(56,139,253,0.2)' : '',
        })
        const nameSpan = document.createElement('span')
        nameSpan.textContent = item.name
        Object.assign(nameSpan.style, { color: '#e6edf3', fontSize: '13px' })
        const dirSpan = document.createElement('span')
        dirSpan.textContent = options.collapsePath?.(item.dir) ?? item.dir
        Object.assign(dirSpan.style, { color: '#8b949e', fontSize: '11px' })
        row.appendChild(nameSpan)
        row.appendChild(dirSpan)
        row.addEventListener('mouseenter', () => { selectedIdx = i; renderList() })
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          close('select')
          options.onPick(item, request.lineNum, e)
        })
        itemList.appendChild(row)
      })
    }

    const onDocKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() }
    }
    const localClose = (reason: 'cancel' | 'select' = 'cancel'): void => {
      clearTimeout(debounceTimer)
      document.removeEventListener('keydown', onDocKeydown, true)
      root.remove()
      options.onClose?.(reason)
    }
    closeCurrent = localClose

    async function doSearch(q: string): Promise<void> {
      searchPending = true
      let items: PickerItem[] = []
      try { items = await options.query(q) } catch { items = [] }
      currentItems = mergePreferredPath(items, request.preferredAbsPath, q === request.initialQuery)
      searchPending = false
      selectedIdx = 0
      renderList()
    }

    pickerInput.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void doSearch(pickerInput.value), 150)
    })

    pickerInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (selectedIdx < currentItems.length - 1) { selectedIdx++; renderList() }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (selectedIdx > 0) { selectedIdx--; renderList() }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = currentItems[selectedIdx]
        if (item) { close('select'); options.onPick(item, request.lineNum, e) }
      }
    })

    root.addEventListener('mousedown', (e) => { if (e.target === root) close() })
    document.addEventListener('keydown', onDocKeydown, true)
    pickerInput.focus()
    pickerInput.select()
    renderList()
    void doSearch(request.initialQuery)
  }

  return {
    open,
    close,
    get active() { return closeCurrent !== null },
  }
}
