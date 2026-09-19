// @vitest-environment happy-dom
// Dragging a folded row in the Auto / Spotlight / Fullscreen lists carries the
// family it hides — the same contract the sidebar's folded rows already have.
// App.vue cannot be mounted here (backend/terminal/onboarding lifecycles), so
// the wiring is asserted against its source and the behaviour is exercised
// through the shared composable with real DOM drag events.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PANE_BATCH_MIME, PANE_ID_MIME, type CliContextPayload } from '@navide/terminal'
import { reorderBatchByIds, resolveDragBatch, withFoldedSubtree } from '../../lib/paneBatchDrag'
import { usePaneReorderDrag } from '../../composables/usePaneReorderDrag'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('auxiliary list folded drag wiring', () => {
  it('tells the drag whether the grabbed row was folded, on all three surfaces', () => {
    // `!==` rather than `> 0`: a '>' inside the binding would cut short every
    // source-scan that slices a row's opening tag at the first one.
    const bindings = appSource.split(
      '@dragstart="onAuxiliaryPaneDragStart($event, p.id, p.descendantCount !== 0 && !p.expanded)"'
    )
    expect(bindings).toHaveLength(4) // 3 surfaces → 3 splits + 1
  })

  it('carries the hidden subtree and makes it the selection', () => {
    const start = appSource.indexOf('function auxiliaryDragBatch')
    const end = appSource.indexOf('/** Drag-reorder:')
    // Both anchors must exist and be in order, or the slice below would be
    // empty or inverted and every toContain under it would pass vacuously.
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const fn = appSource.slice(start, end)
    expect(fn).toContain('if (!folded) return batch')
    // The real helper — the same one this file's behaviour tests exercise.
    expect(fn).toContain('withFoldedSubtree(paneId, batch, panes.value)')
    // The drop consumers re-derive the batch from the selection, so the
    // descendants only travel if the selection carries them.
    expect(fn).toContain('if (full !== batch) selectedPaneIds.value = new Set(full)')
  })
})

describe('folded drag behaviour through the shared composable', () => {
  const panes = [
    { id: 'parent' },
    { id: 'child', spawnedBy: 'parent' },
    { id: 'grandchild', spawnedBy: 'child' },
    { id: 'other' },
    { id: 'other-kid', spawnedBy: 'other' },
    { id: 'lonely' },
  ]
  const payloads: Record<string, CliContextPayload> = Object.fromEntries(
    panes.map((p) => [p.id, { paneId: p.id, agentKey: 'claude' }])
  )

  // App.vue's auxiliaryDragBatch over a fixed pane list: the two helpers are
  // the real ones, so this exercises the shipped logic rather than a copy of
  // it. Only the reactive plumbing (panes.value, selectedPaneIds) is stood in
  // for, and the source-scan above pins App.vue to these same two calls.
  const setup = (selection: string[] = []) => {
    // Stands in for App.vue's `panes` — the live order a reorder splices.
    const items = panes.map((p) => ({ ...p }))
    const selected = new Set(selection)
    // Every batch App.vue would have written into selectedPaneIds. This write
    // is the mechanism that actually moves the descendants: reorderPane, the
    // tab drop and the cross-window hand-off all re-derive the batch from the
    // selection rather than from the drag payload.
    const selectionWrites: string[][] = []
    const handOff = vi.fn()
    const drag = usePaneReorderDrag({
      payloadFor: (paneId) => payloads[paneId] ?? null,
      // App.vue's auxiliaryDragBatch, with selectedPaneIds as a plain Set.
      batchFor(paneId, folded) {
        const batch = resolveDragBatch(paneId, selected, items.map((p) => p.id))
        if (!folded) return batch
        const full = withFoldedSubtree(paneId, batch, items)
        if (full !== batch) {
          selectionWrites.push(full)
          selected.clear()
          for (const id of full) selected.add(id)
        }
        return full
      },
      // App.vue's reorderPane: re-derives the batch from the selection.
      reorder(fromId, toId) {
        reorderBatchByIds(items, resolveDragBatch(fromId, selected, items.map((p) => p.id)), toId)
      },
      // App.vue's handOff: same re-derivation, for the other window.
      handOff: (paneId, x, y) => handOff(resolveDragBatch(paneId, selected, items.map((p) => p.id)), x, y),
    })
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'move',
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      setDragImage: vi.fn(),
    } as unknown as DataTransfer
    const dragEvent = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { dataTransfer })
      return event
    }
    return { drag, data, dragEvent, selectionWrites, items, handOff }
  }

  it('carries the whole subtree when the folded row is dragged', () => {
    const { drag, data, dragEvent } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', true)

    expect(data.get(PANE_ID_MIME)).toBe('parent')
    expect(data.get(PANE_BATCH_MIME)).toBe('parent\nchild\ngrandchild')
    expect(drag.draggingBatchIds.value).toEqual(['parent', 'child', 'grandchild'])
  })

  it('drags an expanded parent alone', () => {
    const { drag, data, dragEvent } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', false)

    expect(data.has(PANE_BATCH_MIME)).toBe(false)
    expect(drag.draggingBatchIds.value).toEqual(['parent'])
  })

  it('adds the subtree to a multi-selection without pulling in other families', () => {
    const { drag, data, dragEvent } = setup(['parent', 'other'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', true)

    // 'other' rides along because it was selected, but 'other-kid' stays put:
    // only the grabbed row's subtree joins.
    expect(data.get(PANE_BATCH_MIME)).toBe('parent\nchild\ngrandchild\nother')
  })

  it('leaves a childless row a single-pane drag', () => {
    const { drag, data, dragEvent, selectionWrites } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'lonely', true)

    expect(data.has(PANE_BATCH_MIME)).toBe(false)
    expect(drag.draggingBatchIds.value).toEqual(['lonely'])
    // Nothing was hidden, so the selection is left exactly as the user set it.
    expect(selectionWrites).toEqual([])
  })

  it('makes the carried subtree the selection, and only when folded', () => {
    const folded = setup()
    folded.drag.onDragStart(folded.dragEvent('dragstart') as DragEvent, 'parent', true)
    expect(folded.selectionWrites).toEqual([['parent', 'child', 'grandchild']])

    const expanded = setup()
    expanded.drag.onDragStart(expanded.dragEvent('dragstart') as DragEvent, 'parent', false)
    expect(expanded.selectionWrites).toEqual([])
  })

  it('moves the hidden children too when the folded row is dropped', () => {
    const { drag, dragEvent, items } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', true)
    drag.onDrop(dragEvent('drop') as DragEvent, 'lonely')

    // The whole family landed after 'lonely'; none of it stayed behind.
    expect(items.map((p) => p.id)).toEqual([
      'other', 'other-kid', 'lonely', 'parent', 'child', 'grandchild',
    ])
  })

  it('leaves the hidden children behind when the row was expanded', () => {
    const { drag, dragEvent, items } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', false)
    drag.onDrop(dragEvent('drop') as DragEvent, 'lonely')

    // The control case for the test above: without the fold, only the parent
    // moves — which is exactly the bug this feature fixes.
    expect(items.map((p) => p.id)).toEqual([
      'child', 'grandchild', 'other', 'other-kid', 'lonely', 'parent',
    ])
  })

  it('hands the whole family to the other window on a cross-window release', () => {
    const { drag, dragEvent, handOff } = setup()
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'parent', true)
    const end = dragEvent('dragend')
    Object.assign((end as DragEvent).dataTransfer as object, { dropEffect: 'none' })
    drag.onDragEnd(end as DragEvent)

    // Only the batch matters here; a synthetic Event carries no screen point.
    expect(handOff.mock.calls[0]?.[0]).toEqual(['parent', 'child', 'grandchild'])
  })
})
