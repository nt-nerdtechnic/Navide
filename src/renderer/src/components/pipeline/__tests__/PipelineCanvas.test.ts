// @vitest-environment happy-dom
// The canvas is Vue Flow; these check the parts this component owns: which
// nodes/handles it draws, which connections it accepts, and what it emits.
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PipelineCanvas from '../PipelineCanvas.vue'
import type { PipelineGraph } from '../../../lib/pipelineGraph'

i18n.global.locale.value = 'en-US'

const graph: PipelineGraph = {
  version: 1,
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Start', position: { x: 0, y: 0 } },
    { id: 'a', kind: 'slot', label: 'A', position: { x: 260, y: 0 }, slot: { agentKey: 'claude', roleKey: 'dev', label: 'A', kickoffBody: '', isCommander: false } },
    { id: 'g', kind: 'gate', label: 'Gate', position: { x: 560, y: 0 }, gate: {} },
  ],
  edges: [
    { id: 'e-trigger-a', from: 'trigger', to: 'a', kind: 'main' },
    { id: 'e-a-g', from: 'a', to: 'g', kind: 'main' },
    { id: 'r-g-a', from: 'g', to: 'a', kind: 'reject', maxLoops: 3 },
  ],
}

function mountCanvas(locked = false) {
  return mount(PipelineCanvas, {
    props: { graph, roleLabels: { dev: 'Developer' }, agentLabels: {}, runNodes: { a: { status: 'done' } }, now: 0, selectedId: null, locked, flowId: `t-${Math.random()}` },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

describe('PipelineCanvas', () => {
  it('draws every node as a card and labels the reject loop with its budget', async () => {
    const w = mountCanvas()
    await flushPromises()
    expect(w.findAll('[data-node-id]').map((n) => n.attributes('data-node-id')).sort()).toEqual(['a', 'g', 'trigger'])
    expect(w.text()).toContain('max 3')
    w.unmount()
  })

  it('gives gates a reject handle and the trigger no input', async () => {
    const w = mountCanvas()
    await flushPromises()
    const handles = (id: string) => w.find(`.vue-flow__node[data-id="${id}"]`).findAll('.vue-flow__handle').map((h) => h.attributes('data-handleid'))
    expect(handles('trigger')).toEqual(['out'])
    expect(handles('g')).toEqual(expect.arrayContaining(['in', 'out', 'reject-out', 'reject-in']))
    w.unmount()
  })

  it('marks a finished step\'s outgoing link as done', async () => {
    const w = mountCanvas()
    await flushPromises()
    expect(w.find('.vue-flow__edge[data-id="e-a-g"] .pcv-edge').classes()).toContain('is-done')
    w.unmount()
  })

  it('removes the selected node with Delete, but not while locked', async () => {
    const w = mountCanvas()
    await w.setProps({ selectedId: 'a' })
    await w.find('.pcv').trigger('keydown', { key: 'Delete' })
    expect(w.emitted('remove-node')?.[0]).toEqual(['a'])
    await w.setProps({ locked: true })
    await w.find('.pcv').trigger('keydown', { key: 'Delete' })
    expect(w.emitted('remove-node')).toHaveLength(1)
    w.unmount()
  })

  it('selects a reject loop from its label', async () => {
    const w = mountCanvas()
    await flushPromises()
    await w.find('.pcv-loop-label').trigger('click')
    await flushPromises()
    expect(w.emitted('select-edge')?.at(-1)).toEqual(['r-g-a'])
    w.unmount()
  })
})
