import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Emulates how Windows' FlushFileBuffers treats handles: fsync of a directory
// handle or of a handle opened without write access fails with EPERM.
const fsyncLog = vi.hoisted(() => ({
  emulateWindows: false,
  handles: new Map<number, { directory: boolean; writable: boolean }>(),
  synced: [] as Array<{ directory: boolean; writable: boolean }>,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((path: string, flags?: string | number, mode?: number) => {
    const fd = actual.openSync(path, flags as never, mode)
    const writable = typeof flags === 'number'
      ? (flags & 3) !== actual.constants.O_RDONLY
      : flags !== undefined && flags !== 'r' && flags !== 'rs'
    fsyncLog.handles.set(fd, { directory: actual.statSync(path).isDirectory(), writable })
    return fd
  }) as typeof actual.openSync
  const fsyncSync = ((fd: number) => {
    const handle = fsyncLog.handles.get(fd) ?? { directory: false, writable: true }
    if (fsyncLog.emulateWindows && (handle.directory || !handle.writable)) {
      throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', errno: -4048 })
    }
    fsyncLog.synced.push(handle)
    // Record directory flushes without asking the kernel: the POSIX case
    // below must also pass on a Windows runner, whose kernel refuses them.
    if (!handle.directory) actual.fsyncSync(fd)
  }) as typeof actual.fsyncSync
  const patched = { ...actual, openSync, fsyncSync }
  return { ...patched, default: patched }
})

const { PluginActivationSelector } = await import('./pluginActivationSelector')
const { MiniIdeStorageLifecycleSelector } = await import('./miniIdeStorageLifecycle')
const { defaultInstallerDeps } = await import('./pluginInstaller')

const realPlatform = process.platform
const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-fsync-win-'))
  roots.push(root)
  return root
}

function spoofPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  fsyncLog.emulateWindows = platform === 'win32'
}

const candidate = { packageVersion: '1.0.0', target: 'universal', artifactDigest: 'a'.repeat(64) } as const

beforeEach(() => {
  fsyncLog.handles.clear()
  fsyncLog.synced.length = 0
})

afterEach(() => {
  spoofPlatform(realPlatform)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('plugin stores on Windows fsync semantics', () => {
  it('PluginActivationSelector writes its record without fsyncing a directory or read-only handle', () => {
    spoofPlatform('win32')
    const selector = new PluginActivationSelector(tempRoot())
    expect(() => selector.stageCandidate('acme.demo', candidate)).not.toThrow()
    expect(selector.read('acme.demo')?.candidate).toEqual(candidate)
    expect(fsyncLog.synced).toEqual([{ directory: false, writable: true }])
  })

  it('MiniIdeStorageLifecycleSelector remembers the active version without a directory fsync', () => {
    spoofPlatform('win32')
    const recordPath = join(tempRoot(), 'lifecycle', 'mini-ide.json')
    const selector = new MiniIdeStorageLifecycleSelector(recordPath)
    expect(selector.rememberActive('2.0.0', '1.0.0')).toBe(true)
    expect(JSON.parse(readFileSync(recordPath, 'utf8')).packageVersion).toBe('2.0.0')
    expect(fsyncLog.synced.every((handle) => !handle.directory)).toBe(true)
  })

  it('defaultInstallerDeps flushes written files and directories without EPERM', () => {
    spoofPlatform('win32')
    const root = tempRoot()
    const file = join(root, 'package.zip')
    expect(() => defaultInstallerDeps.writeFile(file, new Uint8Array([1, 2, 3]))).not.toThrow()
    expect(() => defaultInstallerDeps.syncDirectory!(root)).not.toThrow()
    expect([...readFileSync(file)]).toEqual([1, 2, 3])
  })

  it('keeps the parent directory fsync on POSIX', () => {
    spoofPlatform('darwin')
    new PluginActivationSelector(tempRoot()).stageCandidate('acme.demo', candidate)
    new MiniIdeStorageLifecycleSelector(join(tempRoot(), 'mini-ide.json')).rememberActive('2.0.0')
    defaultInstallerDeps.syncDirectory!(tempRoot())
    expect(fsyncLog.synced.filter((handle) => handle.directory)).toHaveLength(3)
  })
})
