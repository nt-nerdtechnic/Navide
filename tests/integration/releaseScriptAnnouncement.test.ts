import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWindows } from '../../src/shared/osplat'

const releaseScript = resolve('release.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Loads only fail() and warn_missing_announcement() from release.sh (running
// the script itself would start a release) and calls the latter.
function warn(version: string, file: string): { status: number | null; stdout: string; stderr: string } {
  const program = `set -Eeuo pipefail
eval "$(sed -n -e '/^fail() {/,/^}/p' -e '/^warn_missing_announcement() {/,/^}/p' "$1")"
warn_missing_announcement "$2" "$3"`
  const result = spawnSync('bash', ['-c', program, 'test', releaseScript, version, file], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe.skipIf(isWindows())('release.sh What\'s New check', () => {
  it('warns when the file has no entry for the version', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-release-sh-'))
    roots.push(root)
    const file = join(root, 'whatsNew.ts')
    writeFileSync(file, "  version: '1.2.2',\n")
    const result = warn('1.2.3', file)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WARNING: no What's New entry for 1.2.3")
  })

  it('stays quiet when the entry exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-release-sh-'))
    roots.push(root)
    const file = join(root, 'whatsNew.ts')
    writeFileSync(file, "  version: '1.2.3',\n")
    const result = warn('1.2.3', file)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('fails loudly when the What\'s New file itself is missing', () => {
    const result = warn('1.2.3', join(tmpdir(), 'navide-no-such-dir', 'whatsNew.ts'))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("ERROR: What's New file not found")
    expect(result.stdout).not.toContain('WARNING')
  })
})
