import { afterEach, describe, it, expect, vi } from 'vitest'
import { platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import { applyLinuxKeyringPreflight, probeSecretService, type DbusCallResult, type KeyringProbe } from './linuxKeyring'

// Replies captured in the shape `dbus-send --print-reply` prints them.
const aliasReply = (path: string): DbusCallResult => ({
  ok: true,
  stdout: `method return time=1.0 sender=:1.9 -> destination=:1.80 serial=5 reply_serial=2\n   object path "${path}"\n`
})
const lockedReply = (locked: boolean): DbusCallResult => ({
  ok: true,
  stdout: `method return time=1.0 sender=:1.9 -> destination=:1.80 serial=6 reply_serial=2\n   variant       boolean ${locked}\n`
})

function scripted(...replies: DbusCallResult[]) {
  const calls: string[][] = []
  const call = (args: string[]): DbusCallResult => {
    calls.push(args)
    const next = replies.shift()
    if (!next) throw new Error('unexpected D-Bus call')
    return next
  }
  return { call, calls }
}

describe('probeSecretService', () => {
  it('is usable when the default collection exists and is unlocked', () => {
    const { call, calls } = scripted(aliasReply('/org/freedesktop/secrets/collection/login'), lockedReply(false))
    expect(probeSecretService(call)).toEqual({ usable: true, reason: 'available' })
    expect(calls[0]).toContain('org.freedesktop.Secret.Service.ReadAlias')
    expect(calls[1]).toContain('/org/freedesktop/secrets/collection/login')
    expect(calls[1]).toContain('string:Locked')
  })

  it('is unusable when the default collection is locked', () => {
    const { call } = scripted(aliasReply('/org/freedesktop/secrets/collection/login'), lockedReply(true))
    expect(probeSecretService(call)).toEqual({ usable: false, reason: 'locked' })
  })

  it('is unusable when no default alias exists, without querying a collection', () => {
    const { call, calls } = scripted(aliasReply('/'))
    expect(probeSecretService(call)).toEqual({ usable: false, reason: 'no-default-collection' })
    expect(calls).toHaveLength(1)
  })

  it('is unusable when no Secret Service is on the bus', () => {
    const { call } = scripted({
      ok: false,
      reason: 'error',
      detail: 'Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files'
    })
    expect(probeSecretService(call)).toMatchObject({ usable: false, reason: 'no-secret-service' })
  })

  it('treats a process timeout as unusable', () => {
    const { call } = scripted({ ok: false, reason: 'timeout', detail: 'dbus-send timed out' })
    expect(probeSecretService(call)).toMatchObject({ usable: false, reason: 'timeout' })
  })

  it('treats a D-Bus NoReply on the Locked query as a timeout', () => {
    const { call } = scripted(aliasReply('/org/freedesktop/secrets/collection/login'), {
      ok: false,
      reason: 'error',
      detail: 'Error org.freedesktop.DBus.Error.NoReply: Did not receive a reply.'
    })
    expect(probeSecretService(call)).toMatchObject({ usable: false, reason: 'timeout' })
  })

  it('treats an unparseable reply as unusable', () => {
    const { call } = scripted({ ok: true, stdout: 'garbage' })
    expect(probeSecretService(call)).toMatchObject({ usable: false, reason: 'unrecognized-reply' })
  })
})

describe('applyLinuxKeyringPreflight', () => {
  const BASELINE = platformId()
  afterEach(() => {
    setPlatformId(BASELINE)
    vi.restoreAllMocks()
  })

  function run(platform: PlatformId, probe: KeyringProbe, explicitStore = false) {
    setPlatformId(platform)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appended: Array<[string, string | undefined]> = []
    const probeFn = vi.fn(() => probe)
    const downgraded = applyLinuxKeyringPreflight(
      {
        hasSwitch: (name) => explicitStore && name === 'password-store',
        appendSwitch: (name, value) => appended.push([name, value])
      },
      probeFn
    )
    return { downgraded, appended, probed: probeFn.mock.calls.length }
  }

  it.each<PlatformId>(['darwin', 'win32'])('touches nothing on %s', (platform) => {
    expect(run(platform, { usable: false, reason: 'no-secret-service' })).toEqual({
      downgraded: false,
      appended: [],
      probed: 0
    })
  })

  it('switches Linux to the basic store when the keyring is not usable', () => {
    expect(run('linux', { usable: false, reason: 'locked' })).toEqual({
      downgraded: true,
      appended: [['password-store', 'basic']],
      probed: 1
    })
  })

  it('keeps the system keyring on Linux when it is usable', () => {
    expect(run('linux', { usable: true, reason: 'available' })).toEqual({
      downgraded: false,
      appended: [],
      probed: 1
    })
  })

  it('leaves an explicit --password-store alone without probing', () => {
    expect(run('linux', { usable: false, reason: 'locked' }, true)).toEqual({
      downgraded: false,
      appended: [],
      probed: 0
    })
  })
})
