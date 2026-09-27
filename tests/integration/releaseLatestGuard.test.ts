import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { isWindows } from '../../src/shared/osplat'

const guard = resolve('scripts/release-latest-guard.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A fake `gh` whose `release view` (no tag) answers with FAKE_LATEST, or with
// GitHub's "release not found" when FAKE_LATEST is empty.
function runGuard(tag: string, latest: string, failWith?: string): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'navide-latest-guard-'))
  roots.push(root)
  const gh = join(root, 'gh')
  writeFileSync(gh, `#!/usr/bin/env bash
if [ -n "\${FAKE_FAIL:-}" ]; then echo "\${FAKE_FAIL}" >&2; exit 1; fi
if [ -z "\${FAKE_LATEST}" ]; then echo "release not found" >&2; exit 1; fi
echo "\${FAKE_LATEST}"
`)
  chmodSync(gh, 0o755)
  const result = spawnSync('bash', [guard, tag], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', FAKE_LATEST: latest, FAKE_FAIL: failWith ?? '' },
  })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr }
}

describe.skipIf(isWindows())('release Latest guard', () => {
  it('exists', () => {
    expect(existsSync(guard)).toBe(true)
  })

  it('refuses Latest to a tag older than the current Latest release', () => {
    const result = runGuard('v0.2.8', 'v0.2.9')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('false')
    expect(result.stderr).toContain('older than the current Latest')
  })

  it('compares versions numerically, not as strings', () => {
    expect(runGuard('v0.2.9', 'v0.2.10').stdout).toBe('false')
    expect(runGuard('v0.2.10', 'v0.2.9').stdout).toBe('true')
    expect(runGuard('v1.0.0', 'v0.9.99').stdout).toBe('true')
  })

  it('allows a newer tag, an equal tag (rerun) and a first release', () => {
    expect(runGuard('v0.2.10', 'v0.2.9').stdout).toBe('true')
    expect(runGuard('v0.2.9', 'v0.2.9').stdout).toBe('true')
    const first = runGuard('v0.1.0', '')
    expect(first.status).toBe(0)
    expect(first.stdout).toBe('true')
  })

  it('fails rather than guessing when the Latest release cannot be read', () => {
    const result = runGuard('v0.2.8', 'v0.2.9', 'HTTP 401: Bad credentials')
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toBe('true')
  })
})

describe('release workflows consult the Latest guard', () => {
  it('publishes with --latest only when the guard allows it', () => {
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
    const steps = workflow.jobs['publish-release'].steps as Array<{ name?: string; run?: string }>
    const publish = steps.find((step) => step.name === 'Publish the draft as the latest release')
    expect(publish?.run).toContain('scripts/release-latest-guard.sh')
    expect(publish?.run).toContain('--latest=false')
    expect(publish?.run).not.toMatch(/--draft=false --latest\b/)
  })

  it('leaves releases/latest/ alone when the guard refuses the tag', () => {
    const workflow = parse(readFileSync('.github/workflows/mirror.yml', 'utf8'))
    const steps = workflow.jobs.mirror.steps as Array<{ name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> }>
    const guardStep = steps.find((step) => step.id === 'latest_guard')
    expect(guardStep?.run).toContain('scripts/release-latest-guard.sh')
    expect(guardStep?.env?.GH_TOKEN).toBeDefined()
    // A manual refresh_latest=true run is the rollback path and skips it.
    expect(guardStep?.if).toContain("github.event_name != 'workflow_dispatch'")
    const replace = steps.find((step) => step.name === 'Replace releases/latest/')
    expect(replace?.if).toContain("steps.latest_guard.outputs.is_latest != 'false'")
    const guardIndex = steps.indexOf(guardStep!)
    expect(guardIndex).toBeLessThan(steps.indexOf(replace!))
  })
})
