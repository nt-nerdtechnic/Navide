// The IDE is a plugin-view host, not a Git or Plans client: it adds whatever
// left/detail contributions the Host catalogs and never names a plugin, a
// capability address, or a product component. This guards the source tree —
// `packageBoundary.test.ts` guards the built artifact.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(pluginRoot, 'src')
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '__tests__'])

/** Identifiers that only a Git/Plans client would contain. */
const FORBIDDEN = [
  'navide.git',
  'navide.plans',
  'shell.git',
  'shell.issue',
  'openGitWindow',
  'openGitHistoryWindow',
  'openBranchDiffWindow',
  'ui.openGitWindow',
  'git-composition',
  'GitPane',
  'DiffPane',
  'ConflictPane',
  'BranchDiffPane',
]

function collectSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectSources(path, found)
    else if (/\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) found.push(path)
  }
  return found
}

describe('mini-IDE plugin independence', () => {
  it('has no copied or half-migrated diff/review surface left behind', () => {
    for (const path of ['src/git-composition', 'src/composables/useGit.ts', 'src/components/ReviewPane.vue']) {
      expect(existsSync(join(pluginRoot, path)), path).toBe(false)
    }
  })

  it('names no plugin, capability address, or product component of its own', () => {
    const offenders: string[] = []
    for (const file of collectSources(sourceRoot)) {
      const text = readFileSync(file, 'utf8')
      for (const marker of FORBIDDEN) {
        if (text.includes(marker)) offenders.push(`${relative(pluginRoot, file)}: ${marker}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
