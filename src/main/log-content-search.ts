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

export interface ChunkSearchState {
  /** Tail of the previously fed chunk, kept so a query straddling a chunk
   *  boundary is still found. Length is capped at queryLower.length - 1. */
  carry: string
}

export function createChunkSearchState(): ChunkSearchState {
  return { carry: '' }
}

/** Feeds one chunk of text into an in-progress case-insensitive substring
 *  search, stripping ANSI escapes first. Keeps a `query.length - 1` carry
 *  from the end of each chunk so a match split across chunk boundaries is
 *  still detected. Returns true if `queryLower` is found in this chunk
 *  (carry included). `queryLower` must already be lower-cased. */
export function feedChunk(state: ChunkSearchState, chunk: string, queryLower: string): boolean {
  const combined = state.carry + stripAnsiForSearch(chunk)
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
    return false
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

/** Searches each file for `query` (case-insensitive substring, ANSI-stripped)
 *  and returns the ids of files that matched. Files that don't exist or can't
 *  be read are silently skipped. */
export async function searchLogFiles(query: string, files: LogSearchFileInput[]): Promise<string[]> {
  const queryLower = query.trim().toLowerCase()
  if (!queryLower) return []
  const results = await Promise.all(
    files.map(async (file) => ((await fileContainsQuery(file.path, queryLower)) ? file.id : null))
  )
  return results.filter((id): id is string => id !== null)
}
