import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, {
    needs?: string[]; if?: string; steps: Array<{ run?: string; if?: string; uses?: string }>
    strategy?: { matrix: { include: Array<{ platform: string; shard?: string }> } }
  }>
}

describe('required CI gate', () => {
  it('requires every verification job, including native speech tests', () => {
    expect(workflow.jobs['lint-and-test'].needs?.slice().sort())
      .toEqual(Object.keys(workflow.jobs).filter((name) => name !== 'lint-and-test').sort())
    expect(workflow.jobs['lint-and-test'].if).toContain('always()')
  })

  it.each(['failure', 'cancelled', 'skipped'])('rejects %s from an upstream job', (result) => {
    const run = spawnSync(process.execPath, [resolve('scripts/check-ci-results.mjs')], {
      encoding: 'utf8', env: { ...process.env, CI_NEEDS: JSON.stringify({ frontend: { result: 'success' }, backend: { result } }) },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`backend: ${result}`)
  })

  it('accepts only a nonempty set of successful checks', () => {
    for (const [needs, expected] of [[{ frontend: { result: 'success' } }, 0], [{}, 1]] as const) {
      const run = spawnSync(process.execPath, [resolve('scripts/check-ci-results.mjs')], {
        encoding: 'utf8', env: { ...process.env, CI_NEEDS: JSON.stringify(needs) },
      })
      expect(run.status).toBe(expected)
    }
    expect(workflow.jobs['lint-and-test'].steps.some((step) => step.run?.includes('scripts/check-ci-results.mjs'))).toBe(true)
  })

  it('retains complete source and artifact suites on every supported desktop platform', () => {
    for (const name of ['frontend', 'build-artifacts', 'backend']) {
      const job = workflow.jobs[name]
      expect([...new Set(job.strategy?.matrix.include.map((entry) => entry.platform))].sort())
        .toEqual(['Linux', 'Windows', 'macOS'])
      expect(job.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()')).toBe(true)
    }
    expect(workflow.jobs.backend.strategy?.matrix.include.filter((entry) => entry.platform === 'Windows')
      .map((entry) => entry.shard)).toEqual(['1/2', '2/2'])
  })
})
