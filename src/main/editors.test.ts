import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { delimiter, join, sep } from 'node:path'
import { platformId, setPlatformId } from '../shared/osplat'
import {
  BUILT_IN_EDITORS,
  buildEditorArgv,
  classifyOpenRequest,
  detectEditors,
  expandTemplate,
  launchEditorProcess,
  normalizeEditorId,
  resolveEditorCommand,
  whichIn,
  needsWindowsShell,
  quoteForCmd,
  type DetectedEditor,
  type EditorPreference,
  type EditorProcess
} from './editors'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

const prefer = (editorId: string, customCommand: string[] = []): EditorPreference => ({
  editorId,
  customCommand
})

describe('classifyOpenRequest exemptions', () => {
  // These are the requests an external editor structurally cannot serve. They
  // must ignore the preference entirely — a missed exemption turns the Git
  // window's "Open changes" into "open the raw file in VS Code".
  it('sends a diff open to the mini-IDE even when an external editor is chosen', () => {
    const route = classifyOpenRequest(
      { filepath: 'src/app.ts', diff_filepath: 'src/app.ts', diff_staged: '1' },
      prefer('vscode')
    )
    expect(route).toEqual({ via: 'mini-ide', reason: 'diff' })
  })

  it('sends a branch-diff open to the mini-IDE', () => {
    const route = classifyOpenRequest(
      { branch_diff_base: 'main', branch_diff_compare: 'feature' },
      prefer('vscode')
    )
    expect(route).toEqual({ via: 'mini-ide', reason: 'diff' })
  })

  it('sends a bare open (no filepath) to the mini-IDE', () => {
    expect(classifyOpenRequest({ workspace_path: '/ws' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'bare'
    })
  })

  it('sends sidebar-driven opens to the mini-IDE', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts', sidebar: 'search' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'sidebar'
    })
    expect(classifyOpenRequest({ filepath: 'a.ts', sidebar: 'git' }, prefer('vscode'))).toEqual({
      via: 'mini-ide',
      reason: 'sidebar'
    })
  })

  it('does not exempt the explorer sidebar', () => {
    expect(
      classifyOpenRequest({ filepath: 'a.ts', sidebar: 'explorer' }, prefer('vscode'))
    ).toEqual({ via: 'external', editorId: 'vscode' })
  })
})

describe('classifyOpenRequest routing', () => {
  it('defaults to the mini-IDE', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('mini-ide'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })

  it('routes to the OS default application', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('system'))).toEqual({ via: 'system' })
  })

  it('routes to a built-in external editor', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('cursor'))).toEqual({
      via: 'external',
      editorId: 'cursor'
    })
  })

  it('routes to custom only when a command exists', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('custom', ['code', '{file}']))).toEqual(
      { via: 'external', editorId: 'custom' }
    )
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('custom'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })

  it('falls back to the mini-IDE for an unknown editor id', () => {
    expect(classifyOpenRequest({ filepath: 'a.ts' }, prefer('emacs-from-the-future'))).toEqual({
      via: 'mini-ide',
      reason: 'preference'
    })
  })
})

describe('normalizeEditorId', () => {
  it('accepts known ids', () => {
    expect(normalizeEditorId('vscode')).toBe('vscode')
    expect(normalizeEditorId('system')).toBe('system')
    expect(normalizeEditorId(' cursor ')).toBe('cursor')
  })

  it('falls back for unknown, blank, and non-string values', () => {
    expect(normalizeEditorId('nope')).toBe('mini-ide')
    expect(normalizeEditorId('')).toBe('mini-ide')
    expect(normalizeEditorId(null)).toBe('mini-ide')
    expect(normalizeEditorId(42)).toBe('mini-ide')
  })

  it('rejects custom without a command', () => {
    expect(normalizeEditorId('custom')).toBe('mini-ide')
    expect(normalizeEditorId('custom', ['code'])).toBe('custom')
  })
})

describe('expandTemplate', () => {
  it('substitutes placeholders inside their own argv entry', () => {
    expect(
      expandTemplate(['code', '-g', '{file}:{line}'], { file: '/ws/a.ts', line: 12 })
    ).toEqual(['code', '-g', '/ws/a.ts:12'])
  })

  it('keeps a path with spaces as one argument', () => {
    expect(expandTemplate(['code', '{file}'], { file: '/My Projects/a b.ts' })).toEqual([
      'code',
      '/My Projects/a b.ts'
    ])
  })

  it('never splits shell metacharacters into extra arguments', () => {
    expect(expandTemplate(['code', '{file}'], { file: '/ws/a;rm -rf b.ts' })).toEqual([
      'code',
      '/ws/a;rm -rf b.ts'
    ])
  })

  it('drops an argument that is only an unset placeholder', () => {
    expect(expandTemplate(['code', '--line', '{line}', '{file}'], { file: '/ws/a.ts' })).toEqual([
      'code',
      '--line',
      '/ws/a.ts'
    ])
  })

  it('resolves an unset placeholder mixed with text to empty', () => {
    expect(expandTemplate(['code', '{file}:{line}'], { file: '/ws/a.ts' })).toEqual([
      'code',
      '/ws/a.ts:'
    ])
  })

  it('substitutes dir and workspace', () => {
    expect(expandTemplate(['code', '{dir}', '--ws', '{workspace}'], {
      dir: '/ws/sub',
      workspace: '/ws'
    })).toEqual(['code', '/ws/sub', '--ws', '/ws'])
  })

  it('treats line 0 as unset', () => {
    expect(expandTemplate(['code', '{line}', '{file}'], { file: '/a.ts', line: 0 })).toEqual([
      'code',
      '/a.ts'
    ])
  })
})

// PATH entries and hits are built with the host's own separators so the same
// expectations hold on Windows, where `join` answers with backslashes and
// PATH is `;`-separated.
const optBin = join(sep, 'opt', 'bin')
const usrBin = join(sep, 'usr', 'bin')
const searchPath = [optBin, usrBin].join(delimiter)

describe('whichIn', () => {
  // The fixtures are the POSIX shape (a bare `code` on PATH); pinned so the
  // Windows runner checks the same contract, and the `on Windows` block below
  // opts into the suffixed lookup explicitly.
  beforeEach(() => setPlatformId('linux'))
  afterEach(() => setPlatformId(BASELINE))

  const exists = (paths: string[]) => (p: string): boolean => paths.includes(p)
  const always = (): boolean => true

  it('returns the first PATH hit', () => {
    const hit = whichIn('code', searchPath, exists([join(usrBin, 'code'), join(optBin, 'other')]), always)
    expect(hit).toBe(join(usrBin, 'code'))
  })

  it('prefers earlier PATH entries', () => {
    const hit = whichIn('code', searchPath, exists([join(optBin, 'code'), join(usrBin, 'code')]), always)
    expect(hit).toBe(join(optBin, 'code'))
  })

  it('returns null when nothing is found', () => {
    expect(whichIn('code', searchPath, exists([]), always)).toBeNull()
  })

  it('requires the executable bit', () => {
    expect(whichIn('code', usrBin, exists([join(usrBin, 'code')]), () => false)).toBeNull()
  })

  it('accepts an absolute name directly', () => {
    const custom = join(sep, 'custom', 'code')
    expect(whichIn(custom, '', exists([custom]), always)).toBe(custom)
    expect(whichIn(custom, '', exists([]), always)).toBeNull()
  })

  it('tolerates an empty PATH', () => {
    expect(whichIn('code', '', exists([join(usrBin, 'code')]), always)).toBeNull()
  })

  describe('on Windows', () => {
    afterEach(() => setPlatformId(BASELINE))

    // VS Code and Cursor install `code.cmd` / `cursor.cmd` onto PATH; the bare
    // name that works from a shell there names nothing on disk.
    it('resolves a bare name through its PATHEXT suffix', () => {
      setPlatformId('win32')
      expect(whichIn('code', optBin, exists([join(optBin, 'code.cmd')]), always)).toBe(
        join(optBin, 'code.cmd')
      )
      expect(whichIn('cursor', optBin, exists([join(optBin, 'cursor.exe')]), always)).toBe(
        join(optBin, 'cursor.exe')
      )
    })

    // VS Code's bin\ ships the POSIX `code` shell script beside code.cmd; the
    // extensionless one is the file CreateProcess cannot start.
    it('never picks the extensionless script beside the .cmd', () => {
      setPlatformId('win32')
      expect(
        whichIn('code', optBin, exists([join(optBin, 'code'), join(optBin, 'code.cmd')]), always)
      ).toBe(join(optBin, 'code.cmd'))
      expect(whichIn('code', optBin, exists([join(optBin, 'code')]), always)).toBeNull()
    })

    it('looks a suffixed name up as written', () => {
      setPlatformId('win32')
      expect(whichIn('code.cmd', optBin, exists([join(optBin, 'code.cmd')]), always)).toBe(
        join(optBin, 'code.cmd')
      )
      expect(whichIn('code.cmd', optBin, exists([join(optBin, 'code.cmd.exe')]), always)).toBeNull()
    })

    it('does not resolve suffixes off Windows', () => {
      setPlatformId('linux')
      expect(whichIn('code', optBin, exists([join(optBin, 'code.cmd')]), always)).toBeNull()
    })
  })
})

describe('resolveEditorCommand', () => {
  // The fixtures are the POSIX shape (a bare `code` on PATH, an .app-bundled
  // CLI); pinned so the Windows runner checks the same contract.
  beforeEach(() => setPlatformId('linux'))
  afterEach(() => setPlatformId(BASELINE))

  const vscode = BUILT_IN_EDITORS.find((e) => e.id === 'vscode')!
  const always = (): boolean => true

  it('resolves from PATH', () => {
    const code = join(usrBin, 'code')
    const hit = resolveEditorCommand(vscode, usrBin, (p) => p === code, always)
    expect(hit).toBe(code)
  })

  it('falls back to the .app-bundled CLI when PATH has no hit', () => {
    // The common macOS case: VS Code is installed but its shell command was
    // never added to PATH (that is a separate opt-in step).
    setPlatformId('darwin')
    try {
      const bundled = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
      const hit = resolveEditorCommand(vscode, usrBin, (p) => p === bundled, always)
      expect(hit).toBe(bundled)
    } finally {
      setPlatformId(BASELINE)
    }
  })

  // The Linux shapes: a deb/rpm whose /usr/bin/code symlink is missing, a
  // snap on a distribution that does not put /snap/bin on PATH, and a Flatpak
  // — whose exported launcher is named after the app id, so no lookup for
  // `code` can ever find it.
  it.each([
    '/usr/share/code/bin/code',
    '/snap/bin/code',
    '/var/lib/flatpak/exports/bin/com.visualstudio.code',
  ])('falls back to %s on Linux', (bundled) => {
    setPlatformId('linux')
    try {
      expect(resolveEditorCommand(vscode, usrBin, (p) => p === bundled, always)).toBe(bundled)
    } finally {
      setPlatformId(BASELINE)
    }
  })

  it('does not look for the macOS bundle on Linux', () => {
    setPlatformId('linux')
    try {
      expect(vscode.bundledPaths().some((p) => p.includes('/Applications/'))).toBe(false)
    } finally {
      setPlatformId(BASELINE)
    }
  })

  it('returns null when the editor is not installed at all', () => {
    expect(resolveEditorCommand(vscode, usrBin, () => false, always)).toBeNull()
  })
})

describe('detectEditors', () => {
  // The fixtures are the POSIX shape (a bare `code` on PATH); pinned so the
  // Windows runner checks the same contract.
  beforeEach(() => setPlatformId('linux'))
  afterEach(() => setPlatformId(BASELINE))

  it('reports availability per editor', () => {
    const cursor = join(usrBin, 'cursor')
    const found = detectEditors(usrBin, (p) => p === cursor, () => true)
    expect(found.map((e) => e.id).sort()).toEqual(['cursor', 'vscode'])
    expect(found.find((e) => e.id === 'cursor')).toEqual({
      id: 'cursor',
      command: cursor,
      available: true
    })
    expect(found.find((e) => e.id === 'vscode')).toEqual({
      id: 'vscode',
      command: '',
      available: false
    })
  })
})

class FakeEditorProcess implements EditorProcess {
  private errorListeners: ((code: number | null) => void)[] = []
  private exitListeners: ((code: number | null) => void)[] = []
  unrefCount = 0

  once(event: 'error' | 'exit', listener: (code: number | null) => void): unknown {
    if (event === 'error') this.errorListeners.push(listener)
    else this.exitListeners.push(listener)
    return this
  }

  unref(): void {
    this.unrefCount += 1
  }

  emitError(): void {
    // The error listener takes no argument; the payload is ignored.
    for (const listener of this.errorListeners) listener(null)
  }

  emitExit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code)
  }
}

describe('launchEditorProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports failure when the process cannot be spawned', async () => {
    const launched = await launchEditorProcess(() => {
      throw new Error('ENOENT')
    })
    expect(launched).toBe(false)
  })

  it('reports failure on an error event', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitError()
    await expect(pending).resolves.toBe(false)
  })

  it('reports failure on a non-zero exit inside the window', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(1)
    await expect(pending).resolves.toBe(false)
  })

  it('treats an immediate exit 0 as success — GUI editors hand off and exit', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(0)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
  })

  it('reports success and detaches when nothing happens in the window', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
    expect(child.unrefCount).toBe(1)
  })

  it('does not detach when the launch already failed', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    child.emitExit(127)
    await expect(pending).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.unrefCount).toBe(0)
  })

  it('ignores a late failure after the window closed', async () => {
    vi.useFakeTimers()
    const child = new FakeEditorProcess()
    const pending = launchEditorProcess(() => child, 800)
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toBe(true)
    child.emitExit(1) // user quit the editor later — not a launch failure
    await expect(pending).resolves.toBe(true)
  })
})

describe('buildEditorArgv', () => {
  const detected: DetectedEditor[] = [
    { id: 'vscode', command: '/usr/bin/code', available: true },
    { id: 'cursor', command: '', available: false }
  ]

  it('builds a file open with a goto flag', () => {
    expect(buildEditorArgv('vscode', detected, [], { file: '/ws/a.ts', line: 7 })).toEqual([
      '/usr/bin/code',
      '-g',
      '/ws/a.ts:7'
    ])
  })

  it('omits the goto flag without a line', () => {
    expect(buildEditorArgv('vscode', detected, [], { file: '/ws/a.ts' })).toEqual([
      '/usr/bin/code',
      '/ws/a.ts'
    ])
  })

  it('builds a folder open', () => {
    expect(buildEditorArgv('vscode', detected, [], { dir: '/ws' })).toEqual(['/usr/bin/code', '/ws'])
  })

  it('returns null for an undetected editor', () => {
    expect(buildEditorArgv('cursor', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })

  it('returns null for an unknown editor id', () => {
    expect(buildEditorArgv('emacs', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })

  it('expands a custom template', () => {
    expect(
      buildEditorArgv('custom', detected, ['subl', '{file}:{line}'], { file: '/ws/a.ts', line: 3 })
    ).toEqual(['subl', '/ws/a.ts:3'])
  })

  it('returns null when the custom template is empty', () => {
    expect(buildEditorArgv('custom', detected, [], { file: '/ws/a.ts' })).toBeNull()
  })
})

describe('needsWindowsShell', () => {
  afterEach(() => setPlatformId(BASELINE))

  it('routes .cmd and .bat through the shell on Windows only', () => {
    setPlatformId('win32')
    expect(needsWindowsShell('C:\\Program Files\\VS Code\\bin\\code.cmd')).toBe(true)
    expect(needsWindowsShell('cursor.BAT')).toBe(true)
    expect(needsWindowsShell('C:\\tools\\code.exe')).toBe(false)
    setPlatformId('linux')
    expect(needsWindowsShell('code.cmd')).toBe(false)
  })
})

describe('quoteForCmd', () => {
  it('leaves a plain argument alone', () => {
    expect(quoteForCmd('-g')).toBe('-g')
    expect(quoteForCmd('C:\\src\\app.ts:12')).toBe('C:\\src\\app.ts:12')
  })

  it('quotes whitespace and cmd.exe metacharacters', () => {
    expect(quoteForCmd('C:\\Program Files\\VS Code\\bin\\code.cmd')).toBe(
      '"C:\\Program Files\\VS Code\\bin\\code.cmd"'
    )
    expect(quoteForCmd('a&b')).toBe('"a&b"')
    expect(quoteForCmd('')).toBe('""')
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""')
  })
})

