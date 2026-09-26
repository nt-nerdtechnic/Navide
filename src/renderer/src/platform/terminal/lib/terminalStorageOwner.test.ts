import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { editorTerminalResumeKey, type TerminalStorageOwnerRequest } from '../../../../../shared/terminalStorageOwner'
import { createTerminalStorageOwner } from './terminalStorageOwner'

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()
  readonly writes: Array<{ key: string; value: string }> = []
  onSet: ((key: string, value: string) => void) | undefined

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    const stringValue = String(value)
    this.onSet?.(key, stringValue)
    this.writes.push({ key, value: stringValue })
    this.values.set(key, stringValue)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }
}

const workspacePath = '/workspaces/navide'
const resumeKey = editorTerminalResumeKey(workspacePath)

function request(value: unknown): TerminalStorageOwnerRequest {
  return value as TerminalStorageOwnerRequest
}

describe('terminal storage owner', () => {
  it('keeps the owner bootstrap lazy and separate from the recovery IDE graph', () => {
    const bootstrap = readFileSync(new URL('../../../../plugins/mini-ide/mount.ts', import.meta.url), 'utf8')

    expect(bootstrap).toContain("get('terminal_owner') === '1'")
    expect(bootstrap).toContain("void import('./terminalOwner')")
    expect(bootstrap).toContain("void import('./recoveryMount')")
    expect(bootstrap).not.toContain('EditorWindowApp')
  })

  it('reads the fixed terminal projection, including font, size, PTY and nv1 history', () => {
    const storage = new MemoryStorage()
    storage.values.set('terminal.fontSize', '15')
    storage.values.set('terminal-last-size', JSON.stringify({ cols: 127, rows: 41 }))
    storage.values.set(`terminal-pty:${resumeKey}`, 'pty-123')
    storage.values.set(`terminal-scroll:${resumeKey}`, 'nv1\n\u001b[31mhistory\u001b[0m')
    storage.values.set('plugin.private-setting', 'keep')

    const state = createTerminalStorageOwner(storage).execute({ operation: 'read', resumeKey })

    expect(state).toEqual({
      fontSize: 15,
      lastSize: { cols: 127, rows: 41 },
      ptyId: 'pty-123',
      snapshot: '\u001b[31mhistory\u001b[0m',
    })
    expect(storage.getItem('plugin.private-setting')).toBe('keep')
  })

  it('rejects unknown resume keys, fields and value types', () => {
    const owner = createTerminalStorageOwner(new MemoryStorage())
    const invalidRequests = [
      { operation: 'read', resumeKey: 'not-derived-from-host' },
      { operation: 'read', resumeKey, extra: true },
      { operation: 'session', resumeKey, ptyId: 42 },
      { operation: 'snapshot', resumeKey, snapshots: ['ok', 42] },
      { operation: 'font', fontSize: Number.NaN },
      { operation: 'size', cols: 80, rows: '24' },
    ]

    for (const invalid of invalidRequests) {
      expect(() => owner.execute(request(invalid))).toThrow('Invalid terminal owner request')
    }
  })

  it('writes only the owner projection keys and leaves unrelated storage intact', () => {
    const storage = new MemoryStorage()
    const otherKey = editorTerminalResumeKey('/workspaces/other')
    storage.values.set(`terminal-pty:${otherKey}`, 'other-pty')
    storage.values.set(`terminal-scroll:${otherKey}`, 'nv1\nother-history')
    storage.values.set('plugin.private-setting', 'keep')
    const owner = createTerminalStorageOwner(storage)

    owner.execute({ operation: 'font', fontSize: 16 })
    owner.execute({ operation: 'size', cols: 120, rows: 32 })
    owner.execute({ operation: 'session', resumeKey, ptyId: 'pty-new' })
    owner.execute({ operation: 'snapshot', resumeKey, snapshots: ['owner-history'] })

    expect(storage.getItem('terminal.fontSize')).toBe('16')
    expect(storage.getItem('terminal-last-size')).toBe(JSON.stringify({ cols: 120, rows: 32 }))
    expect(storage.getItem(`terminal-pty:${resumeKey}`)).toBe('pty-new')
    expect(storage.getItem(`terminal-scroll:${resumeKey}`)).toBe('nv1\nowner-history')
    expect(storage.getItem(`terminal-pty:${otherKey}`)).toBe('other-pty')
    expect(storage.getItem(`terminal-scroll:${otherKey}`)).toBe('nv1\nother-history')
    expect(storage.getItem('plugin.private-setting')).toBe('keep')
  })

  it('tries successive serializer candidates without truncating their contents', () => {
    const storage = new MemoryStorage()
    const snapshotKey = `terminal-scroll:${resumeKey}`
    const longCandidate = '\u001b[31mFULL-ANSI-CANDIDATE\u001b[0m'
    const shortCandidate = '\u001b[31mSHORT-ANSI-CANDIDATE\u001b[0m'
    const attempts: string[] = []
    storage.onSet = (key, value) => {
      if (key !== snapshotKey) return
      attempts.push(value)
      if (value === `nv1\n${longCandidate}`) throw new Error('QuotaExceededError')
    }

    createTerminalStorageOwner(storage).execute({
      operation: 'snapshot', resumeKey, snapshots: [longCandidate, shortCandidate],
    })

    expect(attempts).toEqual([`nv1\n${longCandidate}`, `nv1\n${shortCandidate}`])
    expect(storage.getItem(snapshotKey)).toBe(`nv1\n${shortCandidate}`)
  })

  it('evicts an orphan snapshot before one belonging to a live owner', () => {
    const storage = new MemoryStorage()
    const liveKey = editorTerminalResumeKey('/workspaces/live')
    const orphanKey = editorTerminalResumeKey('/workspaces/orphan')
    const targetStorageKey = `terminal-scroll:${resumeKey}`
    const liveStorageKey = `terminal-scroll:${liveKey}`
    const orphanStorageKey = `terminal-scroll:${orphanKey}`
    storage.values.set(liveStorageKey, 'nv1\nlive-history')
    storage.values.set(orphanStorageKey, 'nv1\norphan-history')
    const owner = createTerminalStorageOwner(storage)
    owner.execute({ operation: 'read', resumeKey: liveKey })
    storage.onSet = (key) => {
      if (key === targetStorageKey && storage.getItem(orphanStorageKey) !== null) throw new Error('QuotaExceededError')
    }

    owner.execute({ operation: 'snapshot', resumeKey, snapshots: ['new-history'] })

    expect(storage.getItem(orphanStorageKey)).toBeNull()
    expect(storage.getItem(liveStorageKey)).toBe('nv1\nlive-history')
    expect(storage.getItem(targetStorageKey)).toBe('nv1\nnew-history')
  })

  it('keeps a session snapshot when the PTY session is cleared, until an empty snapshot is explicit', () => {
    const storage = new MemoryStorage()
    const ptyKey = `terminal-pty:${resumeKey}`
    const snapshotKey = `terminal-scroll:${resumeKey}`
    storage.values.set(ptyKey, 'pty-old')
    storage.values.set(snapshotKey, 'nv1\nold-history')
    const owner = createTerminalStorageOwner(storage)

    owner.execute({ operation: 'session', resumeKey, ptyId: null })
    expect(storage.getItem(ptyKey)).toBeNull()
    expect(storage.getItem(snapshotKey)).toBe('nv1\nold-history')

    owner.execute({ operation: 'snapshot', resumeKey, snapshots: [] })
    expect(storage.getItem(snapshotKey)).toBeNull()
  })

  it('drops an unversioned snapshot while reading it instead of replaying raw bytes', () => {
    const storage = new MemoryStorage()
    const snapshotKey = `terminal-scroll:${resumeKey}`
    storage.values.set(snapshotKey, '\u001b[5;10Hraw-history')

    const state = createTerminalStorageOwner(storage).execute({ operation: 'read', resumeKey })

    expect(state?.snapshot).toBeNull()
    expect(storage.getItem(snapshotKey)).toBeNull()
  })
})
