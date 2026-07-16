import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { formatBackendExitError, watchBackendExit } from './backend-crash'

describe('formatBackendExitError', () => {
  it('reports the exit code', () => {
    expect(formatBackendExitError(1, null)).toBe('backend exited unexpectedly (code 1)')
  })

  it('prefers the signal when the process was killed', () => {
    expect(formatBackendExitError(null, 'SIGKILL')).toBe('backend exited unexpectedly (signal SIGKILL)')
  })

  it('tolerates both being null', () => {
    expect(formatBackendExitError(null, null)).toBe('backend exited unexpectedly (code unknown)')
  })
})

describe('watchBackendExit', () => {
  it('fires onCrash when the exiting process is still the active backend', () => {
    const proc = new EventEmitter()
    const onCrash = vi.fn()
    watchBackendExit(proc, () => true, onCrash)
    proc.emit('exit', 137, null)
    expect(onCrash).toHaveBeenCalledWith('backend exited unexpectedly (code 137)')
  })

  it('ignores the exit of a deliberately stopped/replaced handle', () => {
    const proc = new EventEmitter()
    const onCrash = vi.fn()
    // stop()/restart() clear the active handle before killing the process.
    watchBackendExit(proc, () => false, onCrash)
    proc.emit('exit', 0, 'SIGTERM')
    expect(onCrash).not.toHaveBeenCalled()
  })
})
