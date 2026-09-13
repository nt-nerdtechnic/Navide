import { describe, expect, it } from 'vitest'
import { subtreeSignals } from '../paneSubtreeStatus'

const pane = (id: string, status: string, spawnedBy?: string) => ({ id, status, spawnedBy })

describe('subtreeSignals', () => {
  it('reports the loudest descendant status and how many share it', () => {
    const out = subtreeSignals([
      pane('parent', 'idle'),
      pane('c1', 'idle', 'parent'),
      pane('c2', 'running', 'parent'),
      pane('c3', 'running', 'parent'),
    ])
    expect(out.get('parent')).toEqual({ state: 'running', count: 2 })
  })

  it('lets a child waiting on the user outrank a running one', () => {
    const out = subtreeSignals([
      pane('parent', 'running'),
      pane('c1', 'running', 'parent'),
      pane('c2', 'awaiting', 'parent'),
    ])
    expect(out.get('parent')).toEqual({ state: 'awaiting', count: 1 })
  })

  it('says nothing for a parent whose descendants are all quiet', () => {
    const out = subtreeSignals([
      pane('parent', 'running'),
      pane('c1', 'idle', 'parent'),
      pane('c2', 'exited', 'parent'),
      pane('c3', 'waiting', 'parent'),
    ])
    expect(out.has('parent')).toBe(false)
  })

  it('never reports a pane that spawned nothing, whatever its own status', () => {
    const out = subtreeSignals([pane('lone', 'running'), pane('other', 'awaiting')])
    expect(out.size).toBe(0)
  })

  it('counts grandchildren, and only on the ancestors above them', () => {
    const out = subtreeSignals([
      pane('root', 'idle'),
      pane('child', 'idle', 'root'),
      pane('grandchild', 'running', 'child'),
    ])
    expect(out.get('root')).toEqual({ state: 'running', count: 1 })
    expect(out.get('child')).toEqual({ state: 'running', count: 1 })
    expect(out.has('grandchild')).toBe(false)
  })

  it('treats a missing parent as a root rather than a phantom family', () => {
    const out = subtreeSignals([pane('orphan', 'running', 'gone')])
    expect(out.size).toBe(0)
  })

  it('survives a hand-edited cycle', () => {
    const out = subtreeSignals([pane('a', 'running', 'b'), pane('b', 'running', 'a')])
    expect(out.size).toBe(0)
  })
})
