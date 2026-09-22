import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Windows has no O_NOFOLLOW; the reader must fall back to the lstat/fstat
// identity check there instead of refusing every package file read.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { O_NOFOLLOW: _dropped, ...constants } = actual.constants
  return { ...actual, constants }
})

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore untyped CLI module
import { readRegularFileNoFollow } from '../bin/package-files.mjs'

describe('readRegularFileNoFollow without O_NOFOLLOW', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-package-files-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads a regular file', () => {
    const file = join(root, 'manifest.json')
    writeFileSync(file, '{"id":"acme.demo"}')
    expect(Buffer.from(readRegularFileNoFollow(file)).toString('utf8')).toBe('{"id":"acme.demo"}')
  })

  it('still refuses a symlink through the lstat identity check', () => {
    const target = join(root, 'main.js')
    writeFileSync(target, 'export {}')
    const link = join(root, 'symlink-file')
    symlinkSync(target, link)
    expect(() => readRegularFileNoFollow(link)).toThrow(/must be a regular file/)
  })
})
