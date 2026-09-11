import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// child_process is mocked at module level so no terminal ever actually opens
// during the suite; each test decides what `spawn` pretends happened.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { normalizePlatformId, setPlatformId, type PlatformId } from '../shared/osplat'
import * as terminal from './external-terminal'

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn> }

// Created at spawn() time, never ahead of it: the event fires on a microtask,
// and a child built while setting up a mock chain would emit before the
// code under test has attached its listeners.
function fakeChild(outcome: 'spawn' | 'error' | { close: number }): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.unref = vi.fn()
  queueMicrotask(() => {
    if (outcome === 'spawn') child.emit('spawn')
    else if (outcome === 'error') child.emit('error', new Error('spawn ENOENT'))
    else child.emit('close', outcome.close)
  })
  return child
}

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => spawnMock.mockReset())
afterEach(() => {
  setPlatformId(normalizePlatformId(process.platform))
  vi.restoreAllMocks()
})

const on = (id: PlatformId): void => setPlatformId(id)

/** A directory holding executable stand-ins for the named emulators. */
function binDirWith(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-term-'))
  for (const name of names) {
    const file = join(dir, name)
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
  }
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The same, but without the executable bit — what every file is on Windows. */
function plainDirWith(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-term-'))
  for (const name of names) writeFileSync(join(dir, name), '')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

describe('findOnPath', () => {
  it('returns null when the binary is on no PATH entry', () => {
    expect(terminal.findOnPath('definitely-not-a-real-binary-xyz', '/nonexistent')).toBeNull()
  })

  it('finds an executable that is present', () => {
    // `sh` exists on every POSIX machine the suite runs on.
    const found = terminal.findOnPath('sh', '/bin:/usr/bin')
    expect(found === '/bin/sh' || found === '/usr/bin/sh').toBe(true)
  })

  it('skips empty PATH segments instead of probing the cwd', () => {
    expect(terminal.findOnPath('sh', '::/nonexistent::')).toBeNull()
  })

  it('requires the executable bit on POSIX', () => {
    on('linux')
    expect(terminal.findOnPath('tool', plainDirWith('tool'))).toBeNull()
  })

  describe('on Windows', () => {
    // `code` on a Windows PATH is `code.cmd`, `wt` is `wt.exe`; cmd.exe
    // resolves a bare name through PATHEXT and so must this.
    it('finds a command through its PATHEXT suffix', () => {
      on('win32')
      const dir = plainDirWith('code.cmd')
      expect(terminal.findOnPath('code', dir)).toBe(join(dir, 'code.cmd'))
    })

    it('tries the bare name before the suffixes', () => {
      on('win32')
      const dir = plainDirWith('wt.exe')
      expect(terminal.findOnPath('wt.exe', dir)).toBe(join(dir, 'wt.exe'))
      expect(terminal.findOnPath('wt', dir)).toBe(join(dir, 'wt.exe'))
    })

    it('does not rely on an executable bit that Windows does not have', () => {
      on('win32')
      const dir = plainDirWith('tool.exe')
      expect(terminal.findOnPath('tool', dir)).toBe(join(dir, 'tool.exe'))
    })

    it('does not treat a PATHEXT suffix as a hit off Windows', () => {
      on('linux')
      const dir = binDirWith('code.cmd')
      expect(terminal.findOnPath('code', dir)).toBeNull()
    })
  })
})

describe('openInExternalTerminal', () => {
  describe('on macOS', () => {
    it('drives Terminal.app through osascript, exactly as before', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 0 }))
      await expect(terminal.openInExternalTerminal('brew install uv')).resolves.toEqual({ ok: true })
      const [bin, argv] = spawnMock.mock.calls[0]
      expect(bin).toBe('osascript')
      expect(argv[1]).toContain('tell application "Terminal" to do script "brew install uv"')
    })

    it('AppleScript-escapes quotes and backslashes in the command', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 0 }))
      await terminal.openInExternalTerminal('echo "hi" \\ there')
      const script: string = spawnMock.mock.calls[0][1][1]
      expect(script).toContain('do script "echo \\"hi\\" \\\\ there"')
    })

    it('reports a non-zero osascript exit as a failure', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 1 }))
      await expect(terminal.openInExternalTerminal('x')).resolves.toEqual({
        ok: false,
        error: 'osascript exited 1',
      })
    })
  })

  describe('on Linux', () => {
    // The bug this fixes: every needs_terminal install (fourteen agent CLIs
    // plus Ollama) went through osascript, which does not exist on Linux.
    it('never touches osascript', async () => {
      on('linux')
      await terminal.openInExternalTerminal('x', binDirWith())
      for (const call of spawnMock.mock.calls) expect(call[0]).not.toBe('osascript')
    })

    it('launches the first emulator on PATH and hands the command to bash -c verbatim', async () => {
      on('linux')
      // x-terminal-emulator absent, gnome-terminal present: the second entry wins.
      const bin = binDirWith('gnome-terminal', 'xterm')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      const command = 'curl -fsSL https://ollama.com/install.sh | sh'
      await expect(terminal.openInExternalTerminal(command, bin)).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, 'gnome-terminal'))
      // argv form, not a quoted string: the command reaches bash unmangled.
      expect(argv.slice(0, 3)).toEqual(['--', 'bash', '-c'])
      // The shell stays open afterwards, as Terminal.app's `do script` does.
      expect(argv[3]).toBe(`${command}; exec bash`)
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    })

    it('prefers the Debian alternatives symlink over guessing the desktop', async () => {
      on('linux')
      const bin = binDirWith('x-terminal-emulator', 'gnome-terminal', 'konsole')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await terminal.openInExternalTerminal('x', bin)
      expect(spawnMock.mock.calls[0][0]).toBe(join(bin, 'x-terminal-emulator'))
    })

    it('does not hold the reply open while the install runs', async () => {
      on('linux')
      let child!: FakeChild
      spawnMock.mockImplementation(() => (child = fakeChild('spawn')))
      await terminal.openInExternalTerminal('sleep 600', binDirWith('xterm'))
      expect(child.unref).toHaveBeenCalledTimes(1)
    })

    it('falls through to the next emulator when one is on PATH but will not start', async () => {
      on('linux')
      const bin = binDirWith('x-terminal-emulator', 'konsole')
      spawnMock
        .mockImplementationOnce(() => fakeChild('error'))
        .mockImplementationOnce(() => fakeChild('spawn'))
      await expect(terminal.openInExternalTerminal('x', bin)).resolves.toEqual({ ok: true })
      expect(spawnMock.mock.calls.map((c) => c[0])).toEqual([
        join(bin, 'x-terminal-emulator'),
        join(bin, 'konsole'),
      ])
    })

    it('names every emulator it tried when none is available', async () => {
      on('linux')
      const result = await terminal.openInExternalTerminal('x', binDirWith())
      expect(result.ok).toBe(false)
      expect(result.error).toContain('x-terminal-emulator')
      expect(result.error).toContain('gnome-terminal')
      expect(result.error).toContain('konsole')
      expect(result.error).toContain('xterm')
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('on Windows', () => {
    it('prefers Windows Terminal when it is on PATH', async () => {
      on('win32')
      const bin = plainDirWith('wt.exe')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      const command = 'winget install --id OpenAI.Codex'
      await expect(terminal.openInExternalTerminal(command, bin)).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, 'wt.exe'))
      // argv form: the command reaches PowerShell unmangled, and -NoExit
      // keeps the window open the way Terminal.app's `do script` does.
      expect(argv).toEqual(['powershell.exe', '-NoExit', '-Command', command])
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    })

    it('falls back to `cmd /c start powershell` without Windows Terminal', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      await expect(terminal.openInExternalTerminal('x', plainDirWith())).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe('cmd.exe')
      expect(argv).toEqual(['/c', 'start', 'powershell.exe', '-NoExit', '-Command', 'x'])
      // The launcher cmd.exe must not flash its own console; the PowerShell
      // window `start` opens is a new console and is unaffected.
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })
    })

    it('falls through to conhost when Windows Terminal is present but will not start', async () => {
      on('win32')
      const bin = plainDirWith('wt.exe')
      spawnMock
        .mockImplementationOnce(() => fakeChild('error'))
        .mockImplementationOnce(() => fakeChild('spawn'))
      await expect(terminal.openInExternalTerminal('x', bin)).resolves.toEqual({ ok: true })
      expect(spawnMock.mock.calls.map((c) => c[0])).toEqual([join(bin, 'wt.exe'), 'cmd.exe'])
    })

    it('reports the failure when even the conhost route cannot start', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('error'))
      const result = await terminal.openInExternalTerminal('x', plainDirWith())
      expect(result.ok).toBe(false)
      expect(result.error).toContain('ENOENT')
    })

    it('never touches osascript', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await terminal.openInExternalTerminal('x', plainDirWith())
      for (const call of spawnMock.mock.calls) expect(call[0]).not.toBe('osascript')
    })
  })
})
