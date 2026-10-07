// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import { registerStage } from '../../lib/stageTracker'

// Regression lock for the DAG engine: a legacy LINEAR pipeline (stages only,
// no graph) must run exactly as it did before the engine learned gates,
// reject loops and pins — same spawns, same kickoff text, same backend calls,
// same order. Written against the pre-DAG App.vue and kept green after.
//
// App.vue cannot be mounted (see App.pipelineStagePrewarm.test.ts), so the run
// path — onPipelineStart → preSpawnStage → activateStage → onPipelineNext — is
// lifted out, compiled and driven against recording stubs. Dependencies are
// passed by name, so a dependency the lifted code gains without the test
// knowing fails loudly as a ReferenceError instead of being stubbed silently.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const sources = [
  block('const stagePrewarms = new Map<number, Promise<void>>()', '\n/** Spawn all slots for one stage WITHOUT injecting kickoffs.'),
  block('async function preSpawnStage(index: number): Promise<void> {', '\n/** Build cross-stage context'),
  block('async function activateStage(index: number): Promise<void> {', '\nasync function spawnPipelineStage('),
  block(
    'async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string',
    '\n/** Before firing 🎉',
  ),
  block('async function onPipelineNext(): Promise<void> {', '\n/** Everything an abort does'),
]

interface Slot { label: string; agentKey: string; roleKey: string; kickoffBody: string }
interface Stage { id: string; title: string; sentinel: string; slots: Slot[]; allowQuestions?: boolean; docQuery?: string }

const STAGES: Stage[] = [
  {
    id: '01', title: 'Plan', sentinel: '---01---',
    slots: [
      { label: 'fe', agentKey: 'claude', roleKey: 'dev', kickoffBody: 'front {{task}}' },
      { label: 'be', agentKey: 'codex', roleKey: 'dev', kickoffBody: 'back {{task}}' },
    ],
  },
  { id: '02', title: 'Review', sentinel: '---02---', slots: [{ label: 'rv', agentKey: 'claude', roleKey: 'qa', kickoffBody: 'review' }] },
]

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function load(extraDeps: Record<string, unknown> = {}) {
  const { code } = await transformWithEsbuild(
    `${sources.join('\n')}\nreturn { onPipelineStart, onPipelineNext }`,
    'AppPipelineLinear.ts',
    { loader: 'ts' },
  )
  const events: string[] = []
  const pipeline = { state: 'idle', workspacePath: '', task: '', stageIndex: -1, globalManager: null as unknown, log: [] as string[] }
  const panes = { value: [] as Array<Record<string, unknown>> }
  let paneSeq = 0
  const deps: Record<string, unknown> = {
    pipeline,
    pipelinesApi: { activePipelineId: { value: 'pl-1' }, setActivePipeline: vi.fn(async () => true), error: { value: '' } },
    stagesApi: { isLoaded: { value: true }, stages: { value: STAGES }, refresh: vi.fn(), error: { value: '' } },
    panes,
    paneRefs: {},
    stageCompletions: new Map(),
    currentRunGroupId: { value: 'rg-1' },
    existingProject: { value: null },
    pipelineRunWorkspace: '',
    currentMode: { value: 'running' },
    watchers: new Map(),
    registerStage,
    releaseStageSlot: (i: number, key: string) => events.push(`release ${i} ${key}`),
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineRunGroupName: () => 'Pipeline',
    createRunGroup: (name: string) => events.push(`runGroup ${name}`),
    deriveGlobalManager: () => null,
    applyProjectPaths: vi.fn(),
    sendQuiet: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      events.push(`send ${type} ${JSON.stringify(payload)}`)
      return null
    }),
    spawnPane: vi.fn(async (opts: Record<string, unknown>) => {
      const id = `p${++paneSeq}`
      events.push(`spawn ${opts.stageId}/${opts.slotLabel} ${opts.agentKey} kickoff=${JSON.stringify(opts.kickoffPrompt ?? null)}`)
      panes.value.push({
        id, stageId: opts.stageId, slotLabel: opts.slotLabel, origin: 'pipeline', realized: true,
        roleKey: opts.roleKey, injectionStatus: 'sent', kickoffStatus: 'none', sessionMarker: `m-${id}`,
      })
      return id
    }),
    startGlobalManagerRouter: () => events.push('globalRouter'),
    fetchDocPrefix: async () => '',
    stageCommanderSlot: () => null,
    buildStageContext: (i: number) => `[ctx ${i}]`,
    renderSlotKickoff: (slot: Slot, task: string) => slot.kickoffBody.replace('{{task}}', task),
    sessionMarkerLine: (m: string) => ` <${m}>`,
    persistPaneMuted: vi.fn(),
    onKill: vi.fn(),
    paneAlive: () => true,
    injectPane: vi.fn(async (id: string, text: string) => {
      events.push(`inject ${id} ${JSON.stringify(text)}`)
      return true
    }),
    syncViews: vi.fn(),
    startStageWatcher: (i: number, id: string) => events.push(`watch ${i} ${id}`),
    startRouterPoll: vi.fn(),
    ensureStageRouter: vi.fn(),
    armRouterCursors: vi.fn(),
    rolesApi: { find: () => null },
    sleep: async () => {},
    waitForActivityThenSettle: async () => 'settled',
    agentSpecs: [],
    roleLabel: () => '',
    ROLE_STANDBY_SUFFIX: '',
    runPipelineKickoff,
    MAX_KICKOFF_ATTEMPTS,
    cancelWatcher: vi.fn(),
    globalManagerPaneId: () => null,
    disposeStageRouter: (i: number) => events.push(`disposeRouter ${i}`),
    waitForStagePanesSettled: async (i: number) => { events.push(`settle ${i}`) },
    stopGlobalManagerRouter: () => events.push('stopGlobalRouter'),
    reclaimCompletedStagePanes: async (i: number) => { events.push(`reclaim ${i}`) },
    ...extraDeps,
  }
  const factory = new Function(...Object.keys(deps), code)
  const api = factory(...Object.values(deps)) as {
    onPipelineStart: (p: { task: string; workspacePath: string; pipelineId?: string }) => Promise<void>
    onPipelineNext: () => Promise<void>
  }
  return { api, events, pipeline }
}

/** The exact event trace the pre-DAG engine produced for STAGES. */
const EXPECTED = [
  'runGroup Pipeline',
  'send pipeline.start {"workspace_path":"/ws","task_description":"ship","total_stages":2,"stage_blueprint":[{"stage_id":"01","title":"Plan","sentinel":"---01---","slots":[{"agent":"claude","role":"dev","label":"fe"},{"agent":"codex","role":"dev","label":"be"}]},{"stage_id":"02","title":"Review","sentinel":"---02---","slots":[{"agent":"claude","role":"qa","label":"rv"}]}],"pipeline_id":"pl-1"}',
  'spawn 01/fe claude kickoff=null',
  'spawn 01/be codex kickoff=null',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":0,"slot_label":"fe","pane_id":"p1","agent":"claude","role":"dev","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":0,"slot_label":"be","pane_id":"p2","agent":"codex","role":"dev","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  'inject p1 "[ctx 0]front ship <m-p1>"',
  'inject p2 "[ctx 0]back ship <m-p2>"',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":0,"slot_label":"fe","kickoff_status":"sent"}',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":0,"slot_label":"be","kickoff_status":"sent"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":0,"pane_id":"p1","agent":"claude","role":"dev"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":0,"pane_id":"p2","agent":"codex","role":"dev"}',
  'watch 0 p1',
  'watch 0 p2',
  'spawn 02/rv claude kickoff=null',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":1,"slot_label":"rv","pane_id":"p3","agent":"claude","role":"qa","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  // ── onPipelineNext: stage 01 → 02
  'disposeRouter 0',
  'reclaim 0',
  'inject p3 "[ctx 1]review <m-p3>"',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":1,"slot_label":"rv","kickoff_status":"sent"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":1,"pane_id":"p3","agent":"claude","role":"qa"}',
  'watch 1 p3',
  // ── onPipelineNext: final stage
  'disposeRouter 1',
  'settle 1',
  'stopGlobalRouter',
  'send pipeline.complete {"workspace_path":"/ws"}',
]

async function runLinear(extraDeps: Record<string, unknown> = {}) {
  const { api, events, pipeline } = await load(extraDeps)
  await api.onPipelineStart({ task: 'ship', workspacePath: '/ws' })
  await flush()
  events.push('// next')
  await api.onPipelineNext()
  await flush()
  events.push('// next')
  await api.onPipelineNext()
  await flush()
  return { events: events.filter((e) => !e.startsWith('// ')), pipeline }
}

describe('a legacy linear pipeline runs exactly as before', () => {
  it('produces the pre-DAG spawn / kickoff / backend trace, in order', async () => {
    const { events, pipeline } = await runLinear()
    expect(events).toEqual(EXPECTED)
    expect(pipeline.state).toBe('completed')
    expect(pipeline.stageIndex).toBe(1)
  })
})
