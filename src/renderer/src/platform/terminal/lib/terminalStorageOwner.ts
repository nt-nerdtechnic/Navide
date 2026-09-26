import { validTerminalOwnerRequest, type TerminalStorageOwnerRequest, type TerminalStorageOwnerState } from '../../../../../shared/terminalStorageOwner'

/** Fixed projection over the existing origin's terminal keys. This module
 * loads without Vue, xterm, IDE components, backend transport or Plugin SDK. */
export function createTerminalStorageOwner(storage: Storage) {
  const live = new Set<string>()
  function fontSize(): number {
    const stored = storage.getItem('terminal.fontSize')
    const value = stored === null ? NaN : Number(stored)
    return Number.isFinite(value) && value > 0 && Math.round(value) > 0 ? Math.round(value) : 12
  }
  function evictOtherSnapshot(selfKey: string): boolean {
    let orphan = '', owned = '', orphanLength = -1, ownedLength = -1
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key || key === selfKey || !key.startsWith('terminal-scroll:')) continue
      const length = (storage.getItem(key) ?? '').length
      if (live.has(key.slice('terminal-scroll:'.length))) {
        if (length > ownedLength) { owned = key; ownedLength = length }
      } else if (length > orphanLength) { orphan = key; orphanLength = length }
    }
    const victim = orphan || owned
    if (!victim) return false
    storage.removeItem(victim)
    return true
  }
  return {
    execute(request: TerminalStorageOwnerRequest): TerminalStorageOwnerState | null {
      if (!validTerminalOwnerRequest(request)) throw new Error('Invalid terminal owner request')
      if (request.operation === 'font') {
        storage.setItem('terminal.fontSize', String(request.fontSize))
        return null
      }
      if (request.operation === 'size') {
        storage.setItem('terminal-last-size', JSON.stringify({ cols: request.cols, rows: request.rows }))
        return null
      }
      const key = request.resumeKey
      if (request.operation === 'release') { live.delete(key); return null }
      if (request.operation === 'session') {
        if (request.ptyId) storage.setItem(`terminal-pty:${key}`, request.ptyId)
        else {
          storage.removeItem(`terminal-pty:${key}`)
        }
        return null
      }
      if (request.operation === 'snapshot') {
        const snapshotKey = `terminal-scroll:${key}`
        if (!request.snapshots.length || !request.snapshots[0].trim()) {
          storage.removeItem(snapshotKey)
          return null
        }
        // The display owner serializes successively fewer lines, as the
        // existing useTerminal owner does; never truncate ANSI byte strings.
        for (const snapshot of request.snapshots) {
          for (;;) {
            try { storage.setItem(snapshotKey, `nv1\n${snapshot}`); return null }
            catch { if (!evictOtherSnapshot(snapshotKey)) break }
          }
        }
        throw new Error('Terminal snapshot could not be persisted')
      }
      live.add(key)
      let lastSize: TerminalStorageOwnerState['lastSize'] = null
      try {
        const size = JSON.parse(storage.getItem('terminal-last-size') ?? 'null')
        if (size && Number.isInteger(size.cols) && size.cols > 0 && Number.isInteger(size.rows) && size.rows > 0) lastSize = { cols: size.cols, rows: size.rows }
      } catch { /* Invalid legacy size falls back to normal terminal fitting. */ }
      const stored = storage.getItem(`terminal-scroll:${key}`)
      if (stored && !stored.startsWith('nv1\n')) storage.removeItem(`terminal-scroll:${key}`)
      return {
        fontSize: fontSize(), lastSize,
        ptyId: storage.getItem(`terminal-pty:${key}`),
        snapshot: stored?.startsWith('nv1\n') ? stored.slice(4) : null,
      }
    },
  }
}
