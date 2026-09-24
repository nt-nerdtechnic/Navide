// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Failure paths of the run-group menu and the voice wiring App owns.
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level declaration's text, up to the next one. */
function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

describe('run-group menu failure paths', () => {
  it('closing a group asks first when any of its CLIs is mid-turn, before killing anything', () => {
    const fn = body('closeRunGroup')
    const ask = fn.indexOf('countPanesBusyForRebuild(affected.map((p) => p.id))')
    expect(ask).toBeGreaterThan(0)
    expect(fn).toContain("i18n.global.t('stageTab.close-running-confirm-body', { count: runningCount })")
    expect(fn).toMatch(/if \(!ok\) return/)
    expect(ask).toBeLessThan(fn.indexOf('await onKill(p.id)'))
    expect(ask).toBeLessThan(fn.indexOf('onPipelineAbort()'))
  })

  it('a workspace switch that throws is reported, not left as an unhandled rejection', () => {
    const fn = body('runRunGroupCtxAction')
    expect(fn).toMatch(/try \{\s*await switchToWorkspace\(m\.workspacePath\)\s*\} catch \{/)
    expect(fn).toContain("i18n.global.t('switchWorkspace.failed', { name: wsDisplayName(m.workspacePath) })")
  })

  it('a rebuild asked for while one runs says so instead of doing nothing', () => {
    const fn = body('rebuildPanesViaResume')
    expect(fn).toMatch(/if \(rebuildingTabPanes\.value\) \{\s*notifyRestore\.toast\(i18n\.global\.t\('pane\.terminal\.rebuild-in-progress'\)/)
  })
})

describe('voice wiring in App', () => {
  it('the capsule never sends: it only dismisses, and dictation types through the paste path', () => {
    expect(appSource).toContain('<VoiceCapsule :state="voiceInput.state" @dismiss="voiceInput.dismiss" />')
    expect(appSource).toContain('insertText: (paneId, text) => paneRefs[paneId]?.insertText(text) ?? false,')
  })

  it('a failed pre-warm surfaces as a toast, not a modal', () => {
    expect(appSource).toContain("hint: (text) => notifyRestore.toast(text, { type: 'info' }),")
  })
})
