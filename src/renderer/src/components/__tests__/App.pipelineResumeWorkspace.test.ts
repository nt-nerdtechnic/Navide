// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so these tests parse
// the source text instead (see App.spawnAdvisories.test.ts for the pattern).
//
// The bug they guard: resuming a pipeline run derived the workspace by
// stripping `/.agent-team/project.json` off `projectFile`. Since the SQLite
// migration that file is `.agent-team/navide.db`, the strip matched nothing and
// the database FILE became the workspace — every pane the resumed stage spawned
// failed with "cwd does not exist: …/.agent-team/navide.db". The backend's half
// of the contract is pinned in backend/tests/test_project_payload_workspace_path.py.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('resuming a pipeline run spawns into the workspace directory', () => {
  const resume = block('async function onPipelineResume(', '\nasync function ')

  it('takes the workspace from the backend record', () => {
    expect(resume).toContain('const resumeWorkspacePath = info.workspacePath')
  })

  it('never derives the workspace from projectFile, a file inside it', () => {
    // Code, not prose: the comment above the assignment names projectFile to
    // explain the bug, and that must stay allowed.
    expect(resume).not.toContain('info.projectFile')
    expect(resume).not.toMatch(/\.replace\([^)]*agent-team/)
  })

  it('feeds that workspace to every place the resumed run reads it from', () => {
    expect(resume).toContain('setActivePipeline(info.pipelineId, resumeWorkspacePath)')
    expect(resume).toContain('pipeline.workspacePath = resumeWorkspacePath')
    expect(resume).toContain('pipelineRunWorkspace = resumeWorkspacePath')
  })
})

describe('a resume the backend refuses stops before spawning anything', () => {
  // sendQuiet returns null when the backend errors or never answers. The
  // function used to carry on regardless: activateStage spawned the next
  // stage into a run the backend never resumed.
  const resume = block('async function onPipelineResume(', '\nasync function ')
  const at = (needle: string): number => {
    const i = resume.indexOf(needle)
    expect(i, `${needle} should be in onPipelineResume`).toBeGreaterThan(-1)
    return i
  }

  it('snapshots the pipeline before flipping it to running', () => {
    expect(at('const before = {')).toBeLessThan(at("pipeline.state = 'running'"))
  })

  it('checks the backend answer right after the call, before any use of it', () => {
    const call = at("sendQuiet<ProjectPayload>('pipeline.resume'")
    const guard = at('if (!resp) {')
    expect(guard).toBeGreaterThan(call)
    expect(guard).toBeLessThan(at('applyProjectPaths(resp)'))
  })

  it('returns before the banner is cleared, panes are realized or a stage is activated', () => {
    const guard = at('if (!resp) {')
    const bail = resume.indexOf('return', guard)
    expect(bail).toBeGreaterThan(guard)
    expect(bail).toBeLessThan(at('existingProject.value = null'))
    expect(bail).toBeLessThan(at('realizeRestoredPane'))
    expect(bail).toBeLessThan(at('await activateStage(info.nextStageIndex)'))
  })

  it('puts back every field it overwrote, including the run workspace', () => {
    const branch = resume.slice(at('if (!resp) {'), resume.indexOf('return', at('if (!resp) {')))
    for (const restore of [
      'pipeline.task = before.task',
      'pipeline.workspacePath = before.workspacePath',
      'pipelineRunWorkspace = before.runWorkspace',
      'pipeline.stageIndex = before.stageIndex',
      'pipeline.state = before.state',
      'pipeline.log = before.log',
      'pipeline.globalManager = before.globalManager',
    ]) expect(branch).toContain(restore)
  })
})

describe('the resume banner carries the workspace the backend resolved', () => {
  it("maps the payload's project.workspace_path, not a path cut out of project_file", () => {
    const build = block('function buildExistingProjectInfo(', '\n}\n')
    expect(build).toContain('workspacePath: proj.workspace_path,')
  })
})
