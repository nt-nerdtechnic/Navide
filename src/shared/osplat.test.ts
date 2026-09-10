import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultShell,
  isLinux,
  isMac,
  isWindows,
  loginPathFallbacks,
  loginShellFlags,
  needsDrawnWindowControls,
  needsLoginShellPath,
  normalizePlatformId,
  platformId,
  setPlatformId,
  type PlatformId,
} from './osplat'

// The module caches an injected value, so every test has to hand it back or
// the next one inherits a platform it did not ask for.
const asPlatform = (id: PlatformId, run: () => void): void => {
  setPlatformId(id)
  run()
}

afterEach(() => {
  // `process.platform` is what main and preload actually resolve against, so
  // restoring to it rather than to a fixed id keeps the suite honest about
  // which machine it is on.
  setPlatformId(normalizePlatformId(process.platform))
})

describe('normalizePlatformId', () => {
  it('keeps the two platforms that get their own arm', () => {
    expect(normalizePlatformId('darwin')).toBe('darwin')
    expect(normalizePlatformId('win32')).toBe('win32')
  })

  // Every other POSIX behaves like Linux for window controls, XDG paths and
  // signals, so collapsing them keeps the branch count at three.
  it('collapses every other platform onto linux', () => {
    expect(normalizePlatformId('linux')).toBe('linux')
    expect(normalizePlatformId('freebsd')).toBe('linux')
    expect(normalizePlatformId('openbsd')).toBe('linux')
    expect(normalizePlatformId(undefined)).toBe('linux')
    expect(normalizePlatformId('')).toBe('linux')
  })
})

describe('platform predicates', () => {
  it('reports exactly one platform at a time', () => {
    for (const id of ['darwin', 'win32', 'linux'] as PlatformId[]) {
      asPlatform(id, () => {
        expect(platformId()).toBe(id)
        expect([isMac(), isWindows(), isLinux()].filter(Boolean)).toHaveLength(1)
      })
    }
  })

  it('resolves from process.platform when nothing was injected', () => {
    // Main and preload have `process`; this is the path they take.
    expect(platformId()).toBe(normalizePlatformId(process.platform))
  })
})

describe('needsDrawnWindowControls', () => {
  // macOS paints traffic lights over a frameless window; the other two paint
  // nothing, which is why the buttons have to exist at all.
  it('is false only on macOS', () => {
    asPlatform('darwin', () => expect(needsDrawnWindowControls()).toBe(false))
    asPlatform('win32', () => expect(needsDrawnWindowControls()).toBe(true))
    asPlatform('linux', () => expect(needsDrawnWindowControls()).toBe(true))
  })
})

describe('defaultShell', () => {
  it('prefers whatever the environment already names', () => {
    asPlatform('linux', () => {
      expect(defaultShell({ SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    })
    asPlatform('darwin', () => {
      expect(defaultShell({ SHELL: '/opt/homebrew/bin/bash' })).toBe(
        '/opt/homebrew/bin/bash'
      )
    })
  })

  // The bug this replaced: a hard-coded '/bin/zsh' was handed to every
  // platform, naming a path that does not exist on Windows at all and is not
  // the default on most Linux installs.
  it('falls back to something that exists on each platform', () => {
    asPlatform('darwin', () => expect(defaultShell({})).toBe('/bin/zsh'))
    asPlatform('linux', () => expect(defaultShell({})).toBe('/bin/bash'))
    asPlatform('win32', () => expect(defaultShell({})).toBe('powershell.exe'))
  })

  it('honours COMSPEC on Windows before guessing at PowerShell', () => {
    asPlatform('win32', () => {
      expect(defaultShell({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toBe(
        'C:\\Windows\\system32\\cmd.exe'
      )
    })
  })

  it('treats an empty SHELL as unset rather than as a shell', () => {
    asPlatform('linux', () => expect(defaultShell({ SHELL: '' })).toBe('/bin/bash'))
  })
})

describe('needsLoginShellPath', () => {
  // Finder and .desktop launchers hand the app the session PATH, not the
  // shell's, so both POSIX platforms have to ask a login shell. Windows has
  // no equivalent to ask.
  it('is true on both POSIX platforms and false on Windows', () => {
    asPlatform('darwin', () => expect(needsLoginShellPath()).toBe(true))
    asPlatform('linux', () => expect(needsLoginShellPath()).toBe(true))
    asPlatform('win32', () => expect(needsLoginShellPath()).toBe(false))
  })
})

describe('loginShellFlags', () => {
  it('asks zsh for an interactive login shell everywhere', () => {
    asPlatform('darwin', () => expect(loginShellFlags('/bin/zsh')).toEqual(['-il', '-c']))
    asPlatform('linux', () => expect(loginShellFlags('/usr/bin/zsh')).toEqual(['-il', '-c']))
  })

  // Installers append to ~/.bashrc, which a plain login bash skips; on Linux,
  // where bash is the default, that is where pnpm and nvm put themselves.
  it('asks bash for an interactive shell on Linux', () => {
    asPlatform('linux', () => expect(loginShellFlags('/bin/bash')).toEqual(['-il', '-c']))
  })

  // The macOS default is zsh; the rare macOS bash user keeps the behaviour
  // that shipped there, so nothing on the release platform changed.
  it('keeps the plain login shell for bash on macOS', () => {
    asPlatform('darwin', () => expect(loginShellFlags('/bin/bash')).toEqual(['-l', '-c']))
  })

  it('uses a plain login shell for anything else', () => {
    asPlatform('linux', () => expect(loginShellFlags('/usr/bin/fish')).toEqual(['-l', '-c']))
  })
})

describe('loginPathFallbacks', () => {
  it('names the Homebrew prefixes on macOS', () => {
    asPlatform('darwin', () => {
      expect(loginPathFallbacks('/Users/x')).toEqual([
        '/Users/x/.local/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
      ])
    })
  })

  // The bug this closes: the onboarding wizard installs uv to ~/.local/bin
  // and pnpm to ~/.local/share/pnpm, and a .desktop-launched backend then
  // could not find either.
  it('names where the Linux installers put their binaries', () => {
    asPlatform('linux', () => {
      expect(loginPathFallbacks('/home/x')).toEqual([
        '/home/x/.local/bin',
        '/home/x/.local/share/pnpm',
        '/usr/local/bin',
        '/snap/bin',
      ])
    })
  })

  it('has nothing to add on Windows', () => {
    asPlatform('win32', () => expect(loginPathFallbacks('C:\\Users\\x')).toEqual([]))
  })
})
