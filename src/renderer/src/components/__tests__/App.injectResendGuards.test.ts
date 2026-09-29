import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Supplemental production wiring only. Executable regression guarantees live
// in tests/cli/coordination.test.ts; source assertions do not count as contracts.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('App uses the executable CLI coordination seams', () => {
  it('routes both pipeline kickoff sites through the retry coordinator', () => {
    expect(source.match(/await runPipelineKickoff\(/g)).toHaveLength(2)
  })

  it('accepts turn text before dispatch and releases deduplication state on teardown', () => {
    const start = source.indexOf('function onTurnCompleteForMessaging(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body.indexOf('turnTextGate.accept(paneId, text, timestamp)')).toBeGreaterThan(-1)
    expect(body.indexOf('turnTextGate.accept(')).toBeLessThan(body.indexOf('const parsed = parseMessages(text)'))
    expect(source).toContain('turnTextGate.delete(paneId)')
  })

  it('routes normalized pane sessions through the bounded persistence coordinator', () => {
    const start = source.indexOf('async function persistPaneSession(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('normalizeResumeSessionId(pane.agentKey, sessionId)')
    expect(body).toContain('await persistSessionOnce(`${pane.id}:${id}`')
  })
})
