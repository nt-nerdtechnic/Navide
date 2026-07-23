import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

// Same ANSI-escape pattern the renderer's ansiRender.ts strips (CSI sequences,
// OSC sequences terminated by BEL/ST, a lone trailing ESC). Duplicated here
// because main-process code cannot import renderer bundle modules.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE =
  /\x1b\[([0-9;?]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]|\x1b/g

export function stripAnsiForSearch(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

// Trailing escape-sequence prefix the next chunk may complete: a lone ESC, an
// unterminated CSI (`ESC [ params`), an unterminated OSC (`ESC ] payload`,
// possibly ending in the ESC half of a split ST), or an nF sequence with only
// intermediate bytes so far. Stripping such a tail chunk-locally would eat
// only the ESC and leak the remainder (`[31`, `m`, …) into the searchable
// text, so feedChunk withholds it until more input arrives.
// eslint-disable-next-line no-control-regex
const INCOMPLETE_TRAILING_ANSI_RE = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*\x1b?|[\x20-\x2f]+)?$/

// Upper bound on the withheld escape tail. An unterminated OSC could
// otherwise accumulate the rest of the file into the carry; past this cap
// the tail is stripped as-is and the carry resets.
const MAX_ANSI_CARRY = 8192

export interface ChunkSearchState {
  /** Stripped tail of the previously fed text, kept so a query straddling a
   *  chunk boundary is still found. Capped at queryLower.length - 1. */
  carry: string
  /** Raw (unstripped) incomplete escape sequence withheld from the end of
   *  the previous chunk, re-prepended so it strips correctly once complete. */
  ansiCarry: string
}

export function createChunkSearchState(): ChunkSearchState {
  return { carry: '', ansiCarry: '' }
}

/** Feeds one chunk of text into an in-progress case-insensitive substring
 *  search, stripping ANSI escapes first. An incomplete escape sequence at
 *  the chunk's end is withheld (ansiCarry) and re-prepended to the next
 *  chunk so sequences split across chunk boundaries strip cleanly; a
 *  `query.length - 1` tail of the stripped text (carry) likewise keeps a
 *  query match that straddles the boundary detectable. Returns true if
 *  `queryLower` is found in this chunk (carries included). `queryLower`
 *  must already be lower-cased. */
export function feedChunk(state: ChunkSearchState, chunk: string, queryLower: string): boolean {
  const raw = state.ansiCarry + chunk
  let holdFrom = raw.length
  const incomplete = INCOMPLETE_TRAILING_ANSI_RE.exec(raw)
  if (incomplete && incomplete[0].length <= MAX_ANSI_CARRY) holdFrom = incomplete.index
  state.ansiCarry = raw.slice(holdFrom)
  const combined = state.carry + stripAnsiForSearch(raw.slice(0, holdFrom))
  const found = queryLower.length > 0 && combined.toLowerCase().includes(queryLower)
  const overlapLen = Math.max(0, queryLower.length - 1)
  state.carry = combined.slice(Math.max(0, combined.length - overlapLen))
  return found
}

const CHUNK_BYTES = 64 * 1024

/** True if `filePath` contains `queryLower` (case-insensitive, ANSI-stripped),
 *  reading in bounded chunks so multi-MB logs don't load fully into memory.
 *  Stops at the first match. Missing/unreadable files resolve to false. */
export async function fileContainsQuery(filePath: string, queryLower: string): Promise<boolean> {
  if (!queryLower) return false
  let handle: FileHandle
  try {
    handle = await fs.open(filePath, 'r')
  } catch {
    return false
  }
  try {
    const state = createChunkSearchState()
    const decoder = new TextDecoder('utf-8')
    const buf = Buffer.alloc(CHUNK_BYTES)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, position)
      if (bytesRead === 0) break
      position += bytesRead
      // stream: true carries partial multi-byte UTF-8 sequences to the next chunk.
      const text = decoder.decode(buf.subarray(0, bytesRead), { stream: true })
      if (feedChunk(state, text, queryLower)) return true
    }
    // Flush the decoder so bytes withheld at EOF (truncated multi-byte
    // sequence) aren't silently dropped.
    const tail = decoder.decode()
    return tail.length > 0 && feedChunk(state, tail, queryLower)
  } catch {
    return false
  } finally {
    await handle.close()
  }
}

export interface LogSearchFileInput {
  id: string
  path: string
}

// Cap on concurrently open files: histories can hold thousands of entries and
// an unbounded Promise.all over fs.open risks EMFILE (each failure would be
// silently skipped, i.e. a signal-less missed match).
const FILE_CONCURRENCY = 16

/** Searches each file for `query` (case-insensitive substring, ANSI-stripped)
 *  and returns the ids of files that matched, in input order. At most
 *  FILE_CONCURRENCY files are open at once. Files that don't exist or can't
 *  be read are silently skipped. */
export async function searchLogFiles(query: string, files: LogSearchFileInput[]): Promise<string[]> {
  const queryLower = query.trim().toLowerCase()
  if (!queryLower) return []
  const results = new Array<string | null>(files.length).fill(null)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= files.length) return
      results[i] = (await fileContainsQuery(files[i].path, queryLower)) ? files[i].id : null
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FILE_CONCURRENCY, files.length) }, () => worker())
  )
  return results.filter((id): id is string => id !== null)
}
