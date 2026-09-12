import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultShell,
  isLinux,
  isMac,
  isWindows,
  editorBundledPaths,
  loginPathFallbacks,
  loginShellFlags,
  needsDrawnWindowControls,
  needsLoginShellPath,
  normalizePlatformId,
  platformId,
  setPlatformId,
  shellCommandArgv,
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

  // COMSPEC is set on every Windows session and names cmd.exe, whose syntax
  // is nothing like what the spawn paths assume — honouring it would have made
  // cmd.exe the effective default for everyone.
  it('ignores COMSPEC on Windows and still lands on PowerShell', () => {
    asPlatform('win32', () => {
      expect(defaultShell({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toBe('powershell.exe')
    })
  })

  it('still prefers SHELL on Windows when a user has set one', () => {
    asPlatform('win32', () => {
      expect(defaultShell({ SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toBe(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
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
        '/home/x/.npm-global/bin',
        '/home/x/.cargo/bin',
        '/home/x/.bun/bin',
        '/usr/local/bin',
        '/snap/bin',
      ])
    })
  })

  // nvm is how most Linux users have node — and `claude`/`codex` with it —
  // and it exports its bin only from ~/.bashrc, which is what the probe
  // could not read when this fallback is the one in use.
  it('slots the nvm bins the caller enumerated ahead of the system dirs on Linux', () => {
    asPlatform('linux', () => {
      const nvm = ['/home/x/.nvm/versions/node/v22.11.0/bin', '/home/x/.nvm/versions/node/v20.19.0/bin']
      const dirs = loginPathFallbacks('/home/x', nvm)
      expect(dirs.slice(5, 7)).toEqual(nvm)
      expect(dirs.at(-2)).toBe('/usr/local/bin')
    })
  })

  it('never adds nvm bins on macOS or Windows', () => {
    const nvm = ['/Users/x/.nvm/versions/node/v22.11.0/bin']
    asPlatform('darwin', () => expect(loginPathFallbacks('/Users/x', nvm)).not.toContain(nvm[0]))
    asPlatform('win32', () => expect(loginPathFallbacks('C:\\Users\\x', nvm)).toEqual([]))
  })

  it('has nothing to add on Windows', () => {
    asPlatform('win32', () => expect(loginPathFallbacks('C:\\Users\\x')).toEqual([]))
  })
})

describe('shellCommandArgv', () => {
  // Exactly what App.vue and AiCliDock built inline before the helper existed;
  // the POSIX arms must not move by a single flag.
  it('keeps the POSIX form the panes always used', () => {
    asPlatform('darwin', () => {
      expect(shellCommandArgv('/bin/zsh', 'claude')).toEqual(['/bin/zsh', '-ilc', 'claude'])
      expect(shellCommandArgv('/bin/bash', 'claude')).toEqual(['/bin/bash', '-lc', 'claude'])
    })
    asPlatform('linux', () => {
      expect(shellCommandArgv('/usr/bin/zsh', 'codex')).toEqual(['/usr/bin/zsh', '-ilc', 'codex'])
      expect(shellCommandArgv('/usr/bin/fish', 'codex')).toEqual(['/usr/bin/fish', '-lc', 'codex'])
    })
  })

  it('uses -NoExit -Command for both PowerShells on Windows', () => {
    asPlatform('win32', () => {
      expect(shellCommandArgv('powershell.exe', 'claude')).toEqual([
        'powershell.exe',
        '-NoLogo',
        '-NoExit',
        '-Command',
        'claude',
      ])
      expect(shellCommandArgv('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'claude')).toEqual([
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        '-NoLogo',
        '-NoExit',
        '-Command',
        'claude',
      ])
      expect(shellCommandArgv('pwsh', 'claude')[1]).toBe('-NoLogo')
    })
  })

  it('uses /k for cmd.exe on Windows', () => {
    asPlatform('win32', () => {
      expect(shellCommandArgv('C:\\Windows\\system32\\cmd.exe', 'claude')).toEqual([
        'C:\\Windows\\system32\\cmd.exe',
        '/k',
        'claude',
      ])
    })
  })

  it('hands any other Windows shell the POSIX flags', () => {
    asPlatform('win32', () => {
      expect(shellCommandArgv('C:\\Program Files\\Git\\bin\\bash.exe', 'claude')).toEqual([
        'C:\\Program Files\\Git\\bin\\bash.exe',
        '-lc',
        'claude',
      ])
    })
  })

  it('does not apply the Windows forms off Windows', () => {
    asPlatform('linux', () => {
      expect(shellCommandArgv('powershell.exe', 'x')).toEqual(['powershell.exe', '-lc', 'x'])
    })
  })
})

describe('editorBundledPaths', () => {
  const hints = {
    command: 'code',
    macApp: 'Visual Studio Code',
    linuxPrefixes: ['/usr/share/code'],
    flatpakId: 'com.visualstudio.code',
  }

  it('names the .app-bundled CLI on macOS', () => {
    asPlatform('darwin', () => {
      expect(editorBundledPaths('/Users/x', hints)).toEqual([
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        '/Users/x/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ])
    })
  })

  it('names the package prefix, snap and Flatpak launchers on Linux', () => {
    asPlatform('linux', () => {
      expect(editorBundledPaths('/home/x', hints)).toEqual([
        '/usr/share/code/bin/code',
        '/snap/bin/code',
        '/var/lib/flatpak/exports/bin/com.visualstudio.code',
        '/home/x/.local/share/flatpak/exports/bin/com.visualstudio.code',
      ])
    })
  })

  it('has nothing to add on Windows', () => {
    asPlatform('win32', () => expect(editorBundledPaths('C:\\Users\\x', hints)).toEqual([]))
  })
})
