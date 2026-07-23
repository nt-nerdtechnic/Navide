import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createChunkSearchState,
  feedChunk,
  fileContainsQuery,
  searchLogFiles,
  stripAnsiForSearch,
} from './log-content-search'

describe('stripAnsiForSearch', () => {
  it('removes CSI color/style sequences', () => {
    expect(stripAnsiForSearch('\x1b[31mhello\x1b[0m world')).toBe('hello world')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsiForSearch('hello world')).toBe('hello world')
  })
})

describe('feedChunk', () => {
  it('finds a match within a single chunk, case-insensitively', () => {
    const state = createChunkSearchState()
    expect(feedChunk(state, 'the Quick Brown Fox', 'quick')).toBe(true)
  })

  it('returns false when the query is absent', () => {
    const state = createChunkSearchState()
    expect(feedChunk(state, 'nothing to see here', 'quick')).toBe(false)
  })

  it('finds a match split across two chunk boundaries via the carry', () => {
    const state = createChunkSearchState()
    expect(feedChunk(state, 'the qui', 'quick')).toBe(false)
    expect(feedChunk(state, 'ck brown fox', 'quick')).toBe(true)
  })

  it('strips ANSI escapes before matching', () => {
    const state = createChunkSearchState()
    expect(feedChunk(state, '\x1b[31mquick\x1b[0m', 'quick')).toBe(true)
  })
})

describe('fileContainsQuery', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-content-search-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a match in a small file', async () => {
    const filePath = join(dir, 'a.log')
    writeFileSync(filePath, 'hello world')
    expect(await fileContainsQuery(filePath, 'world')).toBe(true)
  })

  it('returns false when the query is absent', async () => {
    const filePath = join(dir, 'a.log')
    writeFileSync(filePath, 'hello world')
    expect(await fileContainsQuery(filePath, 'missing')).toBe(false)
  })

  it('finds a match that straddles a chunk boundary in a larger file', async () => {
    const filePath = join(dir, 'big.log')
    // Chunk size is 64KB; place the needle so it spans byte offset 65536.
    const padLen = 64 * 1024 - 3
    const content = 'x'.repeat(padLen) + 'NEEDLE' + 'y'.repeat(1000)
    writeFileSync(filePath, content)
    expect(await fileContainsQuery(filePath, 'needle')).toBe(true)
  })

  it('resolves to false for a missing file instead of throwing', async () => {
    expect(await fileContainsQuery(join(dir, 'missing.log'), 'anything')).toBe(false)
  })
})

describe('searchLogFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-content-search-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns ids of files that match, skipping ones that do not or are missing', async () => {
    const matchPath = join(dir, 'match.log')
    const noMatchPath = join(dir, 'no-match.log')
    writeFileSync(matchPath, 'the answer is 42')
    writeFileSync(noMatchPath, 'nothing here')

    const result = await searchLogFiles('answer', [
      { id: 'a', path: matchPath },
      { id: 'b', path: noMatchPath },
      { id: 'c', path: join(dir, 'missing.log') },
    ])

    expect(result).toEqual(['a'])
  })

  it('returns an empty array for an empty/whitespace query', async () => {
    expect(await searchLogFiles('   ', [{ id: 'a', path: join(dir, 'anything.log') }])).toEqual([])
  })
})
