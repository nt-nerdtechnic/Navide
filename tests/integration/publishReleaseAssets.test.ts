import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWindows } from '../../src/shared/osplat'

const script = resolve('scripts/publish-release-assets.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A fake `gh` that records every call; the release exists, and its isDraft is
// FAKE_IS_DRAFT.
function publish(isDraft: boolean): { status: number | null; calls: string[]; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'navide-publish-assets-'))
  roots.push(root)
  const gh = join(root, 'gh')
  writeFileSync(gh, `#!/usr/bin/env bash
echo "$*" >> "${join(root, 'calls')}"
case "$*" in *"--json isDraft"*) echo "\${FAKE_IS_DRAFT}";; esac
exit 0
`)
  chmodSync(gh, 0o755)
  writeFileSync(join(root, 'Navide-1.2.3-win-x64.exe'), 'installer')
  writeFileSync(join(root, 'latest.yml'), 'version: 1.2.3\n')
  const result = spawnSync('bash', [script, 'v1.2.3', join(root, 'Navide-1.2.3-win-x64.exe'), join(root, 'latest.yml')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FAKE_IS_DRAFT: String(isDraft) },
  })
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
  return { status: result.status, calls, stderr: result.stderr }
}

describe.skipIf(isWindows())('publish-release-assets.sh', () => {
  it('uploads every asset, manifests included, to a draft release', () => {
    const result = publish(true)
    expect(result.status).toBe(0)
    const uploads = result.calls.filter((call) => call.startsWith('release upload'))
    expect(uploads.some((call) => call.includes('Navide-1.2.3-win-x64.exe'))).toBe(true)
    expect(uploads.some((call) => call.includes('latest.yml'))).toBe(true)
  })

  it('keeps the latest*.yml of an already published release', () => {
    // A "Re-run all jobs" after publishing would otherwise overwrite the
    // merged Windows latest.yml with the x64 job's x64-only copy.
    const result = publish(false)
    expect(result.status).toBe(0)
    const uploads = result.calls.filter((call) => call.startsWith('release upload'))
    expect(uploads.some((call) => call.includes('Navide-1.2.3-win-x64.exe'))).toBe(true)
    expect(uploads.some((call) => call.includes('latest.yml'))).toBe(false)
    expect(result.stderr).toContain('already published')
  })
})
