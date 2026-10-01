import { execFileSync } from 'node:child_process'
import { isLinux } from '../shared/osplat'

// Linux keyring preflight. On a fresh or autologin GNOME session the login
// keyring either does not exist or is still locked, and Chromium's OSCrypt
// (behind safeStorage and cookie encryption) then raises the GNOME "Choose
// password for new keyring" / unlock dialog while the main process blocks on
// it — the whole app freezes until the user answers. Before the app is ready
// we ask the Secret Service over D-Bus, without triggering any prompt, whether
// a default collection exists and is unlocked; when it is not, index.ts falls
// back to `--password-store=basic` (applyLinuxKeyringPreflight).
//
// The probe takes the D-Bus call as a dependency so every outcome can be unit
// tested without a session bus.

/** Result of one D-Bus method call. */
export type DbusCallResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'timeout' | 'error'; detail: string }

/** Runs one `dbus-send` invocation (arguments after the executable). */
export type DbusCall = (args: string[]) => DbusCallResult

export type KeyringProbeReason =
  | 'available'
  | 'locked'
  | 'no-default-collection'
  | 'no-secret-service'
  | 'timeout'
  | 'unrecognized-reply'

export interface KeyringProbe {
  usable: boolean
  reason: KeyringProbeReason
  detail?: string
}

const SECRETS_DEST = 'org.freedesktop.secrets'

function failure(result: Extract<DbusCallResult, { ok: false }>): KeyringProbe {
  if (result.reason === 'timeout' || /NoReply|Timeout/.test(result.detail)) {
    return { usable: false, reason: 'timeout', detail: result.detail }
  }
  return { usable: false, reason: 'no-secret-service', detail: result.detail }
}

/**
 * Decide whether the Secret Service default collection can be used without a
 * prompt. Neither ReadAlias nor reading the Locked property prompts; only an
 * existing, unlocked default collection counts as usable.
 */
export function probeSecretService(call: DbusCall): KeyringProbe {
  const alias = call([
    `--dest=${SECRETS_DEST}`,
    '/org/freedesktop/secrets',
    'org.freedesktop.Secret.Service.ReadAlias',
    'string:default'
  ])
  if (!alias.ok) return failure(alias)
  const path = /object path "([^"]*)"/.exec(alias.stdout)?.[1]
  if (path === undefined) return { usable: false, reason: 'unrecognized-reply', detail: alias.stdout.trim() }
  if (path === '/') return { usable: false, reason: 'no-default-collection' }

  const locked = call([
    `--dest=${SECRETS_DEST}`,
    path,
    'org.freedesktop.DBus.Properties.Get',
    'string:org.freedesktop.Secret.Collection',
    'string:Locked'
  ])
  if (!locked.ok) return failure(locked)
  const value = /boolean (true|false)/.exec(locked.stdout)?.[1]
  if (value === undefined) return { usable: false, reason: 'unrecognized-reply', detail: locked.stdout.trim() }
  return value === 'false' ? { usable: true, reason: 'available' } : { usable: false, reason: 'locked' }
}

/** Real D-Bus call: `dbus-send` on the session bus with a short timeout. */
export function runDbusSend(args: string[], timeoutMs = 1000): DbusCallResult {
  try {
    const stdout = execFileSync(
      'dbus-send',
      ['--session', '--print-reply', `--reply-timeout=${timeoutMs}`, ...args],
      { encoding: 'utf-8', timeout: timeoutMs + 500, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return { ok: true, stdout }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout', detail: 'dbus-send timed out' }
    return { ok: false, reason: 'error', detail: String(err.stderr || err.message || e).trim() }
  }
}

/** The slice of Electron's `app.commandLine` the preflight needs. */
export interface PreflightCommandLine {
  hasSwitch(name: string): boolean
  appendSwitch(name: string, value?: string): void
}

/**
 * On Linux, when the user did not pick a --password-store, switch Chromium to
 * the basic store if the Secret Service keyring is not usable without a
 * prompt. Returns whether it switched. Off Linux it touches nothing.
 */
export function applyLinuxKeyringPreflight(
  commandLine: PreflightCommandLine,
  probe: () => KeyringProbe = () => probeSecretService(runDbusSend)
): boolean {
  if (!isLinux() || commandLine.hasSwitch('password-store')) return false
  const keyring = probe()
  if (keyring.usable) return false
  commandLine.appendSwitch('password-store', 'basic')
  console.warn(
    `[main] Secret Service keyring not usable (${keyring.reason}${keyring.detail ? `: ${keyring.detail}` : ''}) — ` +
      'using --password-store=basic; stored Git account tokens may need to be re-entered.'
  )
  return true
}
