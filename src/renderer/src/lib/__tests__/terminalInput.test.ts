import { describe, it, expect } from 'vitest'
import { terminalMultilineRefusal } from '../terminalInput'

describe('terminalMultilineRefusal', () => {
  it('refuses a multi-line command for a shell without bracketed paste, saying what to do', () => {
    const r = terminalMultilineRefusal('cd app\nnpm test', false)
    expect(r).toMatch(/bracketed paste/)
    expect(r).toMatch(/one line at a time/)
  })

  it('lets a multi-line command through when the shell has bracketed paste on', () => {
    expect(terminalMultilineRefusal('cd app\nnpm test', true)).toBeNull()
  })

  it('never refuses a single line', () => {
    expect(terminalMultilineRefusal('npm test', false)).toBeNull()
  })
})
