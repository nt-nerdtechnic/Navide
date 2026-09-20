import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_SPECS } from '../../platform/plugin-shell/agents'
import { buildResumeCommand, normalizeResumeSessionId } from '../../platform/plugin-shell/lib/resume-command'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

// Execute the actual orchestration with fake I/O; mounting App would start
// unrelated workspace and terminal services.
function resumeHarness(record?: Record<string, unknown>, live?: Record<string, unknown>) {
  const functions = ['onManualResume', 'resumablePaneState', 'onResumeHistoryAgent'].map((name) => {
    const start = source.indexOf(`async function ${name}(`)
    return source.slice(start, source.indexOf('\n}\n', start) + 2)
  }).join('\n')
  const sendQuiet = vi.fn(async (type: string) => type === 'project.peek'
    ? { project: { panes: record ? [record] : [] } } : {})
  const spawnPane = vi.fn(async () => 'new-pane')
  const deps = {
    normalizeResumeSessionId, buildResumeCommand, sendQuiet, spawnPane,
    canResumeSession: async () => true,
    agentSpecs: AGENT_SPECS,
    skipFlagFor: () => '',
    savedHistoryFile: async () => '',
    panes: { value: live ? [live] : [] },
    spawnHistory: { value: [] },
    commandWithSelectedBinary: (_agent: string, command: string) => command,
    resolveReadySpawnGroupId: () => '',
    runGroups: { value: [] }, activeTab: { value: '' }, runGroupsReady: { value: true },
    revivingHistoryPaneId: { value: '' }, historyViewWorkspace: { value: '/foreign' },
    unavailableHistoryPaneIds: { value: new Set<string>() },
  }
  const javascript = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const { resume, resumeHistory } = new Function(...Object.keys(deps), `${javascript}; return { resume: onManualResume, resumeHistory: onResumeHistoryAgent }`)(...Object.values(deps))
  return { resume, resumeHistory, spawnPane, sendQuiet }
}

const payload = { agentKey: 'claude', workspacePath: '/workspace', sessionId: 'session-1', historyPaneId: 'old-pane' }

describe('closed history resume model and effort', () => {
  it('keeps a foreign history parent when the child record was pruned but the parent survives there', async () => {
    const { resumeHistory, spawnPane, sendQuiet } = resumeHarness({ pane_id: 'foreign-parent' })
    await resumeHistory({
      paneId: 'old-pane', agentKey: 'claude', workspacePath: '/foreign', sessionId: 'session-1',
      spawnedBy: 'foreign-parent', model: 'history-model', effort: 'high',
    })
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/foreign', spawnedBy: 'foreign-parent', model: 'history-model', effort: 'high',
    }))
    expect(sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      workspace_path: '/foreign', spawned_by: 'foreign-parent',
    }))
  })

  it.each([undefined, { pane_id: 'unrelated-parent' }])('does not restore a history parent absent from its workspace (%j)', async (record) => {
    const { resumeHistory, spawnPane } = resumeHarness(record, { id: 'foreign-parent' })
    await resumeHistory({
      paneId: 'old-pane', agentKey: 'claude', workspacePath: '/foreign', sessionId: 'session-1',
      spawnedBy: 'foreign-parent',
    })
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({ spawnedBy: undefined }))
  })

  it('keeps an explicit root record ahead of the history parent fallback', async () => {
    const { resumeHistory, spawnPane, sendQuiet } = resumeHarness()
    sendQuiet.mockResolvedValueOnce({ project: { panes: [
      { pane_id: 'old-pane', spawned_by: '' }, { pane_id: 'foreign-parent' },
    ] } })
    await resumeHistory({
      paneId: 'old-pane', agentKey: 'claude', workspacePath: '/foreign', sessionId: 'session-1',
      spawnedBy: 'foreign-parent',
    })
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({ spawnedBy: undefined }))
  })

  it('restores the original pane record and persists its choices onto the new pane', async () => {
    const { resume, spawnPane, sendQuiet } = resumeHarness({
      pane_id: 'old-pane', model: 'original-model', effort: 'high', spawned_by: 'parent',
    })
    expect(await resume(payload)).toBe(true)
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: 'claude --resume session-1 --model original-model --effort high',
      model: 'original-model', effort: 'high', spawnedBy: 'parent',
    }))
    expect(sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      model: 'original-model', effort: 'high',
    }))
  })

  it('uses the durable history entry after the pane record has been pruned', async () => {
    const { resume, spawnPane } = resumeHarness()
    await resume({ ...payload, model: 'history-model', effort: 'medium' })
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: 'claude --resume session-1 --model history-model --effort medium',
    }))
  })

  it('keeps explicit vendor defaults on the record instead of a stale history choice', async () => {
    const { resume, spawnPane } = resumeHarness({ pane_id: 'old-pane', model: '', effort: '' })
    await resume({ ...payload, model: 'stale-model', effort: 'high' })
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({ commandOverride: 'claude --resume session-1' }))
  })

  it('keeps a legacy entry without choices on the vendor default', async () => {
    const { resume, spawnPane } = resumeHarness()
    await resume(payload)
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({ commandOverride: 'claude --resume session-1' }))
  })

  it('preserves the current source pane choices when it is still open', async () => {
    const { resume, spawnPane } = resumeHarness(
      { pane_id: 'old-pane', model: 'older', effort: 'low' },
      { id: 'old-pane', model: 'live-model', effort: 'max' },
    )
    await resume(payload)
    expect(spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: 'claude --resume session-1 --model live-model --effort max',
    }))
  })
})
