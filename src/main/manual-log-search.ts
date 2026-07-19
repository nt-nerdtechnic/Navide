import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Legacy spawnHistory entries predate outputLogFile persistence, and their
// spawnedAt can drift after restore/re-record — so reconstructing the log's
// date folder from spawnedAt (see legacyHistoryLogPath) is unreliable. The
// filename itself is unique (includes the paneId prefix), so search across
// date folders by filename instead.

/** Filename must be a bare basename — no separators or traversal segments —
 *  so a candidate path can never escape the manual log directory. */
export function isValidManualLogFileName(filename: string): boolean {
  return !!filename && !filename.includes('/') && !filename.includes('\\') && !filename.includes('..')
}

/** Searches one level of date subfolders under `<workspacePath>/.agent-team/manual/`
 *  for a file named `filename`. Returns the absolute path of the most recently
 *  modified match, or null if none is found (including when the manual
 *  directory doesn't exist). Never throws. */
export async function findManualLogFile(workspacePath: string, filename: string): Promise<string | null> {
  if (!isValidManualLogFileName(filename)) return null
  const manualDir = resolve(join(workspacePath, '.agent-team', 'manual'))

  let dateDirs: string[]
  try {
    dateDirs = await fs.readdir(manualDir)
  } catch {
    return null
  }

  let bestPath: string | null = null
  let bestMtime = -Infinity
  for (const dateDir of dateDirs) {
    const candidate = resolve(join(manualDir, dateDir, filename))
    if (!candidate.startsWith(manualDir + sep)) continue
    try {
      const stat = await fs.stat(candidate)
      if (!stat.isFile()) continue
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs
        bestPath = candidate
      }
    } catch {
      continue
    }
  }
  return bestPath
}
