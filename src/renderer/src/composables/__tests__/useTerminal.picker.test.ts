import { describe, it, expect } from 'vitest'
import { mergePreferredPath, type PickerItem } from '../useTerminal'

const item = (abs: string): PickerItem => {
  const parts = abs.split('/')
  const name = parts.pop() ?? abs
  return { abs, name, dir: parts.join('/') }
}

// The exact bug-report path: a file on the Desktop, outside any workspace.
const PDF = '/Users/neillu/Desktop/NT-CRM系統說明書.pdf'

describe('mergePreferredPath', () => {
  it('surfaces the click-resolved path when the search found nothing (no workspace / outside it)', () => {
    // This is the screenshot case: workspace search returns [] (pane has no
    // workspace, or the file lives outside it), but the click already stat'd
    // the path as existing — it must still appear instead of "No files found".
    const out = mergePreferredPath([], PDF, true)
    expect(out).toEqual([{ abs: PDF, name: 'NT-CRM系統說明書.pdf', dir: '/Users/neillu/Desktop' }])
  })

  it('inserts the preferred path at the front when results omit it', () => {
    const results = [item('/ws/a.ts'), item('/ws/b.ts')]
    const out = mergePreferredPath(results, PDF, true)
    expect(out[0].abs).toBe(PDF)
    expect(out.map((i) => i.abs)).toEqual([PDF, '/ws/a.ts', '/ws/b.ts'])
  })

  it('pulls the preferred path to the front when results already contain it', () => {
    const results = [item('/ws/a.ts'), item('/ws/hit.ts'), item('/ws/b.ts')]
    const out = mergePreferredPath(results, '/ws/hit.ts', true)
    expect(out.map((i) => i.abs)).toEqual(['/ws/hit.ts', '/ws/a.ts', '/ws/b.ts'])
  })

  it('leaves results untouched when the preferred path is already first', () => {
    const results = [item('/ws/hit.ts'), item('/ws/a.ts')]
    const out = mergePreferredPath(results, '/ws/hit.ts', true)
    expect(out).toBe(results) // same reference — no copy, no reorder
  })

  it('does not insert the preferred path once the user types a new query', () => {
    const results = [item('/ws/a.ts')]
    expect(mergePreferredPath(results, PDF, false)).toBe(results)
  })

  it('returns results unchanged when there is no preferred path', () => {
    const results = [item('/ws/a.ts')]
    expect(mergePreferredPath(results, undefined, true)).toBe(results)
  })
})
