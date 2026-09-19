import { describe, expect, it, vi, beforeEach } from 'vitest'

const mkdir = vi.fn()
vi.mock('node:fs/promises', () => ({ mkdir: (...args: unknown[]) => mkdir(...args) }))

import { createWorkspaceFolder } from './workspace-create'

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: mkdir failed`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('createWorkspaceFolder', () => {
  // Braces matter: an arrow that returns the mock hands Vitest a teardown
  // callback, which then calls the mock again after every test.
  beforeEach(() => {
    mkdir.mockReset()
  })

  it('creates the folder the user named and reports its path', async () => {
    mkdir.mockImplementation(async () => undefined)
    await expect(createWorkspaceFolder('/Users/me/my project')).resolves.toEqual({
      ok: true,
      path: '/Users/me/my project'
    })
  })

  it('never creates parents, so a typo cannot scatter empty folders', async () => {
    mkdir.mockImplementation(async () => undefined)
    await createWorkspaceFolder('/Users/me/proj')
    expect(mkdir).toHaveBeenCalledWith('/Users/me/proj')
    expect(mkdir).toHaveBeenCalledTimes(1)
  })

  it('reports a taken name instead of adopting the folder that holds it', async () => {
    mkdir.mockImplementation(async () => { throw errno('EEXIST') })
    const result = await createWorkspaceFolder('/Users/me/taken')
    expect(result).toMatchObject({ ok: false, reason: 'exists', path: '/Users/me/taken' })
  })

  it.each(['EACCES', 'EPERM', 'EROFS'])('reports %s as a permission problem', async (code) => {
    mkdir.mockImplementation(async () => { throw errno(code) })
    const result = await createWorkspaceFolder('/private/locked')
    expect(result).toMatchObject({ ok: false, reason: 'denied', path: '/private/locked' })
  })

  it('reports anything else as a plain failure, keeping the reason for the log', async () => {
    mkdir.mockImplementation(async () => { throw errno('ENOSPC') })
    const result = await createWorkspaceFolder('/Volumes/full/proj')
    expect(result).toMatchObject({ ok: false, reason: 'failed', path: '/Volumes/full/proj' })
    expect((result as { detail?: string }).detail).toContain('ENOSPC')
  })

  it('survives a rejection that is not an Error', async () => {
    mkdir.mockImplementation(async () => { throw 'boom' })
    const result = await createWorkspaceFolder('/Users/me/proj')
    expect(result).toMatchObject({ ok: false, reason: 'failed', detail: 'boom' })
  })
})
