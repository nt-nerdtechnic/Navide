import { describe, expect, it } from 'vitest'
import { SINGLE_WRITE_MAX_JSON_BYTES } from '../../plugins/navide-plans/src/planPaging'
import { MAX_BACKEND_BRIDGE_QUEUE_BYTES } from '../../src/main/plugins/pluginBackendLimits'

describe('Plans single-write limit', () => {
  it('keeps a single plans.write_document at half the Host input queue, leaving room for envelope and concurrent frames', () => {
    expect(SINGLE_WRITE_MAX_JSON_BYTES).toBe(MAX_BACKEND_BRIDGE_QUEUE_BYTES / 2)
  })
})
