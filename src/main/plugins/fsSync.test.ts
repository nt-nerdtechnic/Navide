import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePlatformId, setPlatformId } from '../../shared/osplat'
import { fsyncFileSync, syncDirectory, syncDirectorySync, type SyncFileOps } from './fsSync'
import { NodePluginStorageFileSystem } from './pluginStorage'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'

// Every fsync the module under test issues, classified by what the descriptor
// points at, so a test can assert "the file was flushed, the directory was not".
const flushed = vi.hoisted(() => ({ kinds: [] as Array<'file' | 'directory'> }))
const opened = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      flushed.kinds.push(actual.fstatSync(fd).isDirectory() ? 'directory' : 'file')
      actual.fsyncSync(fd)
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      opened.paths.push(String(args[0]))
      return actual.open(...args)
    },
  }
})

function recordingOps(): SyncFileOps & { calls: string[]; flags: number[] } {
  const calls: string[] = []
  const flags: number[] = []
  return {
    calls,
    flags,
    openSync: (path, openFlags) => {
      calls.push(`open:${path}`)
      flags.push(openFlags)
      return 42
    },
    fsyncSync: (fd) => {
      calls.push(`fsync:${fd}`)
    },
    closeSync: (fd) => {
      calls.push(`close:${fd}`)
    },
  }
}

describe('fsSync', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-fs-sync-'))
    flushed.kinds.length = 0
    opened.paths.length = 0
  })
  afterEach(() => {
    setPlatformId(normalizePlatformId(process.platform))
    rmSync(root, { recursive: true, force: true })
  })

  describe('fsyncFileSync', () => {
    it('opens the file with write access, which FlushFileBuffers requires on Windows', () => {
      const ops = recordingOps()
      fsyncFileSync(join(root, 'state.json'), ops)
      expect(ops.flags).toEqual([constants.O_RDWR])
      expect(ops.calls).toEqual([`open:${join(root, 'state.json')}`, 'fsync:42', 'close:42'])
    })

    it('flushes a real file on every platform', () => {
      const file = join(root, 'state.json')
      writeFileSync(file, '{}', { mode: 0o600 })
      setPlatformId('win32')
      fsyncFileSync(file)
      expect(flushed.kinds).toEqual(['file'])
    })
  })

  describe('syncDirectorySync', () => {
    it('flushes the directory through the caller-supplied seam off Windows', () => {
      setPlatformId('linux')
      const ops = recordingOps()
      syncDirectorySync(root, { ops })
      expect(ops.flags).toEqual([constants.O_RDONLY])
      expect(ops.calls).toEqual([`open:${root}`, 'fsync:42', 'close:42'])
    })

    it('honours caller flags so the owner-only store keeps its stricter open', () => {
      setPlatformId('darwin')
      const ops = recordingOps()
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      syncDirectorySync(root, { ops, flags })
      expect(ops.flags).toEqual([flags])
    })

    it('never opens or flushes a directory on Windows', () => {
      setPlatformId('win32')
      const ops = recordingOps()
      syncDirectorySync(root, { ops })
      syncDirectorySync(root)
      expect(ops.calls).toEqual([])
      expect(flushed.kinds).toEqual([])
    })
  })

  describe('syncDirectory', () => {
    it('flushes the directory off Windows', async () => {
      setPlatformId('linux')
      await syncDirectory(root)
      expect(opened.paths).toEqual([root])
    })

    it('never opens a directory handle on Windows', async () => {
      setPlatformId('win32')
      await syncDirectory(root)
      expect(opened.paths).toEqual([])
      expect(flushed.kinds).toEqual([])
    })
  })

  describe('stores on Windows', () => {
    beforeEach(() => setPlatformId('win32'))

    it('PluginCapabilityGrantStore commits a write with a file flush only', () => {
      const store = new PluginCapabilityGrantStore(root)
      store.set('acme.files', { packageVersion: '1.0.0', system: ['fs'], storage: true })
      expect(flushed.kinds).toEqual(['file'])
      expect(new PluginCapabilityGrantStore(root).get('acme.files', '1.0.0')).toEqual({
        packageVersion: '1.0.0',
        system: ['fs'],
        storage: true,
      })
    })

    it('NodePluginStorageFileSystem.writeAtomic lands the file without a directory handle', async () => {
      const target = join(root, 'partition', 'state.json')
      await new NodePluginStorageFileSystem().writeAtomic(target, '{"ok":true}')
      expect(readFileSync(target, 'utf8')).toBe('{"ok":true}')
      // The temporary file is the only handle: no `open(dir, 'r')` for the
      // directory flush (the file's own flush goes through FileHandle.sync).
      expect(opened.paths).toHaveLength(1)
      expect(opened.paths[0]).toMatch(/state\.json\.[^/\\]+\.tmp$/)
    })
  })
})
