import { describe, expect, it } from 'vitest'
import {
  deviceLabel,
  displayState,
  isActionable,
  readApplyRows,
  readShareInventory,
  readSyncInventory,
  redactedFields,
  redactedKeys,
  rowKey,
  scopeNotice,
  type SyncRow,
} from '../sharing'

function row(over: Partial<SyncRow> = {}): SyncRow {
  return {
    itemId: 'x',
    localPresent: true,
    remotePresent: true,
    remoteReadable: true,
    deviceId: 'dev-1',
    updatedAt: '',
    state: 'diverged',
    ...over,
  }
}

describe('readShareInventory', () => {
  it('reads both the bare-array and the { items } spellings of a scope', () => {
    const view = readShareInventory({
      scopes: {
        prompts: [{ id: 'p1', label: 'One', size: 12, hasSecrets: false, eligible: true, reason: '' }],
        mcp: {
          items: [
            {
              id: 'srv',
              label: 'srv',
              size: 40,
              hasSecrets: true,
              mayLeakInArgsOrUrl: true,
              eligible: true,
              reason: '',
            },
          ],
        },
        skills: [{ id: 's', label: 's', size: 0, eligible: false, reason: 'not managed by Navide' }],
      },
    })
    expect(view.prompts.map((i) => i.id)).toEqual(['p1'])
    expect(view.mcp[0]).toMatchObject({ hasSecrets: true, mayLeakInArgsOrUrl: true })
    expect(view.skills[0]).toMatchObject({ eligible: false, reason: 'not managed by Navide' })
    expect(view.memory).toEqual([])
  })
})

describe('bundle redactions', () => {
  const bundle = {
    bundleVersion: 1,
    scopes: { mcp: { items: { srv: {} } } },
    redactions: [{ scope: 'mcp', item: 'srv', fields: ['env.TOKEN', 'headers.Authorization'] }],
  }

  it('names the items that arrived without their secrets', () => {
    expect(redactedKeys(bundle)).toEqual(new Set([rowKey('mcp', 'srv')]))
    expect(redactedFields(bundle, 'mcp', 'srv')).toEqual(['env.TOKEN', 'headers.Authorization'])
    expect(redactedFields(bundle, 'mcp', 'other')).toEqual([])
  })
})

describe('readApplyRows', () => {
  it('keeps every row, failed ones included, so a partial import is visible', () => {
    const rows = readApplyRows({
      ok: true,
      items: [
        { scope: 'prompts', id: 'a', action: 'create', ok: true, reason: '' },
        { scope: 'prompts', id: 'b', action: 'overwrite', ok: false, reason: 'refused' },
      ],
    })
    expect(rows.map((r) => r.ok)).toEqual([true, false])
    expect(rows[1].reason).toBe('refused')
  })
})

describe('displayState', () => {
  it('reports an unreadable cloud record as its own thing, never as diverged', () => {
    expect(displayState(row({ remoteReadable: false }))).toBe('unreadable')
    expect(isActionable(row({ remoteReadable: false }))).toBe(false)
  })

  it('leaves a missing cloud record readable — nothing there to fail to open', () => {
    const view = readSyncInventory({
      status: 'ok',
      scopes: { prompts: { status: 'ok', items: [{ itemId: 'a', local: { present: true }, remote: null, state: 'local-only' }] } },
    })
    expect(displayState(view.scopes.prompts.items[0])).toBe('local-only')
  })

  it('only offers to move rows a push or pull could actually change', () => {
    expect(isActionable(row({ state: 'in-sync' }))).toBe(false)
    expect(isActionable(row({ state: 'conflict' }))).toBe(false)
    expect(isActionable(row({ state: 'diverged' }))).toBe(true)
    expect(isActionable(row({ state: 'remote-only', localPresent: false }))).toBe(true)
  })
})

describe('scopeNotice', () => {
  const base = { scope: 'prompts', status: 'ok' as const, error: '', items: [] }

  it('tells the five empty reasons apart', () => {
    expect(scopeNotice({ ...base, status: 'not-connected' }, true)).toBe('not-connected')
    expect(scopeNotice({ ...base, status: 'no-key' }, true)).toBe('no-key')
    expect(scopeNotice({ ...base, status: 'unknown-scope' }, true)).toBe('unknown-scope')
    expect(scopeNotice({ ...base, status: 'error' }, true)).toBe('error')
    expect(scopeNotice(base, false)).toBe('disabled')
    expect(scopeNotice(base, true)).toBe('empty')
  })

  it('says nothing when a listed, enabled scope has rows', () => {
    expect(scopeNotice({ ...base, items: [row()] }, true)).toBeNull()
  })
})

describe('readSyncInventory devices', () => {
  it('keeps a device whose name is empty and keeps its two times apart', () => {
    const view = readSyncInventory({
      status: 'ok',
      scopes: {},
      devices: [
        { deviceId: 'abcdef0123456789', deviceName: '', lastSeenAt: null, lastWriteAt: '2026-09-16T00:00:00Z' },
      ],
      scopeEnabled: { prompts: true },
    })
    expect(view.devices).toHaveLength(1)
    expect(view.devices[0].lastWriteAt).toBe('2026-09-16T00:00:00Z')
    // A null lastSeenAt stays empty — it must not borrow the write time.
    expect(view.devices[0].lastSeenAt).toBe('')
    expect(deviceLabel(view.devices[0].deviceId, view.devices[0].deviceName)).toBe('abcdef01')
  })

  it('prefers the server name when there is one', () => {
    expect(deviceLabel('abcdef0123456789', 'laptop')).toBe('laptop')
  })
})
