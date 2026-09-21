/**
 * The sampling loop behind the resource pill, its summary card and the
 * Resource Manager window.
 *
 * The backend measures resource counters on request without keeping their
 * previous readings, so every consumer differences against its own sample. That
 * is what makes a second window free: it does not disturb the first one's
 * interval, and there is no shared "last reading" to race over.
 *
 * Two cadences. The pill carries a live figure even with nothing open, which
 * is what forces a background loop at all — it is deliberately slow, and stops
 * dead when there is no realized pane to measure. A panel in front of the user
 * gets the fast one.
 */

import { computed, onScopeDispose, ref, watch, type InjectionKey, type Ref } from 'vue'
import type { PortResponse } from '@navide/plugin-ui/shared'
import type { CliRiskAction, CliRiskPaneState, CliRiskProjection } from '../lib/cliRisk'
import {
  cpuPercent,
  machineCpuShare,
  machineMemoryShare,
  resourcePollIntervalMs,
  type CpuSample,
} from '../lib/resourceSampling'

/** One pane as the backend reports it. */
export interface ResourceUsagePaneWire {
  terminal_session_id: string
  pane_id: string
  bytes: number
  cpu_seconds: number
}

export interface ResourceUsageWire {
  cliRisks?: Record<string, CliRiskPaneState>
  available: boolean
  cpu_available: boolean
  /** Seconds since the epoch, as read after the sweep returned. */
  sampled_at: number
  panes: ResourceUsagePaneWire[]
  total_bytes: number
  cpu_count: number
  machine_memory_bytes: number
}

export interface UseResourceUsageOptions {
  /** Sends `terminal.resource_usage`; resolves null when the backend is away. */
  request: () => Promise<ResourceUsageWire | null>
  requestCliRiskAction?: (action: CliRiskAction) => Promise<PortResponse<CliRiskProjection>>
  /** How many panes are worth measuring. Zero stops the loop entirely. */
  paneCount: Ref<number>
  /** Whether a surface showing these numbers is open, which picks the cadence. */
  panelOpen: Ref<boolean>
}

export interface CliRiskContext {
  cliRisksByPaneId: Ref<Map<string, CliRiskPaneState>>
  cliRisksAvailable: Ref<boolean>
  paneIdByKey: Ref<Map<string, string>>
  actOnCliRisk: (paneId: string, signalId: string, action: CliRiskAction['action']) => Promise<PortResponse<CliRiskProjection>>
}

export const cliRiskKey: InjectionKey<CliRiskContext> = Symbol('cli-risk')

export function useResourceUsage(opts: UseResourceUsageOptions) {
  const cliRisksByPaneId = ref(new Map<string, CliRiskPaneState>())
  const cliRisksAvailable = ref(true)
  // A poll started before an action must not bring the dismissed finding back.
  let riskRevision = 0
  let riskGeneration = 0
  let actionTail: Promise<void> = Promise.resolve()

  async function actOnCliRisk(paneId: string, signalId: string, action: CliRiskAction['action']): Promise<PortResponse<CliRiskProjection>> {
    const request = opts.requestCliRiskAction
    if (!request) {
      return { ok: false, payload: null, error: { code: 'UNAVAILABLE', message: '' } }
    }
    const generation = riskGeneration
    // Every pane shares this queue. Do not send the next decision until the
    // previous projection arrived; otherwise reversed replies can undo it.
    const result = actionTail.then(async (): Promise<PortResponse<CliRiskProjection>> => {
      if (generation !== riskGeneration || opts.paneCount.value === 0) {
        return { ok: false, payload: null, error: { code: 'CANCELLED', message: '' } }
      }
      const response = await request({ paneId, signalId, action })
      if (response.ok && response.payload && generation === riskGeneration) {
        riskRevision += 1
        const next = new Map(cliRisksByPaneId.value)
        for (const [id, state] of Object.entries(response.payload.cliRisks)) next.set(id, state)
        cliRisksByPaneId.value = next
        cliRisksAvailable.value = true
      }
      return response
    })
    // A transport rejection still reaches its caller, but releases the queue.
    actionTail = result.then(() => {}, () => {})
    return result
  }

  const bytesByKey = ref(new Map<string, number>())
  const cpuPercentByKey = ref(new Map<string, number | null>())
  // The same readings indexed by pane id. The main window keys by terminal
  // session (a pane rebuilt around a new PTY keeps its history that way), but
  // the Resource Manager window only ever learns pane ids — the roster it lists
  // from carries no session id.
  const bytesByPaneId = ref(new Map<string, number>())
  const cpuPercentByPaneId = ref(new Map<string, number | null>())
  // Session key → the pane id the BACKEND reported it under. A pane rebuilt
  // around a new PTY keeps its session while the renderer's pane id moves on,
  // so these two differ exactly when it matters: a surface that lists panes by
  // pane id needs this to tell "already accounted for" from "a pane nobody
  // claimed", or the same CLI appears twice — once named at 0 B, once anonymous
  // holding the real figures.
  const paneIdByKey = ref(new Map<string, string>())
  const available = ref(true)
  const cpuAvailable = ref(true)
  const measured = ref(false)
  const cpuCount = ref(0)
  const machineMemoryBytes = ref(0)

  // The previous reading, per pane. Keyed the same way the rows are, so a pane
  // that is rebuilt (new pane id, same terminal session) keeps its history.
  const previous = new Map<string, CpuSample>()
  // One sweep at a time: at the fast cadence a machine deep in swap can take
  // longer than the interval, and queueing sweeps would make that worse
  // exactly when the user opened the panel to find out why it is slow.
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    if (inFlight) return
    inFlight = true
    const revision = riskRevision
    try {
      const wire = await opts.request()
      if (!wire) {
        cliRisksAvailable.value = false
        // The backend could not answer at all. Figures are hidden rather than
        // shown as zero, which would read as "these panes are free" — the
        // opposite of what a failed sweep means.
        available.value = false
        cpuAvailable.value = false
        measured.value = true
        return
      }
      if (revision === riskRevision) {
        cliRisksByPaneId.value = new Map(Object.entries(wire.cliRisks ?? {}))
        cliRisksAvailable.value = true
      }
      available.value = wire.available !== false
      cpuAvailable.value = wire.cpu_available !== false
      cpuCount.value = wire.cpu_count ?? 0
      machineMemoryBytes.value = wire.machine_memory_bytes ?? 0

      const sampledAtMs = (wire.sampled_at ?? 0) * 1000
      const bytes = new Map<string, number>()
      const percents = new Map<string, number | null>()
      const bytesPerPane = new Map<string, number>()
      const percentsPerPane = new Map<string, number | null>()
      const paneIds = new Map<string, string>()
      const seen = new Set<string>()
      for (const pane of wire.panes ?? []) {
        const key = pane.terminal_session_id || pane.pane_id
        if (!key) continue
        seen.add(key)
        bytes.set(key, pane.bytes ?? 0)
        const sample: CpuSample = { cpuSeconds: pane.cpu_seconds ?? 0, sampledAt: sampledAtMs }
        const percent = cpuPercent(previous.get(key), sample, cpuCount.value)
        percents.set(key, percent)
        previous.set(key, sample)
        if (pane.pane_id) {
          bytesPerPane.set(pane.pane_id, pane.bytes ?? 0)
          percentsPerPane.set(pane.pane_id, percent)
          paneIds.set(key, pane.pane_id)
        }
      }
      // Drop panes that are gone, so a pane id reused later does not inherit a
      // stale counter and report one enormous spike.
      for (const key of [...previous.keys()]) if (!seen.has(key)) previous.delete(key)
      bytesByKey.value = bytes
      cpuPercentByKey.value = percents
      bytesByPaneId.value = bytesPerPane
      cpuPercentByPaneId.value = percentsPerPane
      paneIdByKey.value = paneIds
      measured.value = true
    } finally {
      inFlight = false
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const intervalMs = computed(() =>
    resourcePollIntervalMs({ paneCount: opts.paneCount.value, panelOpen: opts.panelOpen.value })
  )

  watch(
    intervalMs,
    (ms) => {
      stop()
      if (ms === null) {
        // Nothing to measure: forget the counters too, or the first pane opened
        // later would difference against a reading from another era.
        previous.clear()
        measured.value = false
        bytesByKey.value = new Map()
        cpuPercentByKey.value = new Map()
        bytesByPaneId.value = new Map()
        cpuPercentByPaneId.value = new Map()
        paneIdByKey.value = new Map()
        riskRevision += 1
        riskGeneration += 1
        cliRisksByPaneId.value = new Map()
        return
      }
      void refresh()
      timer = setInterval(() => void refresh(), ms)
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    riskGeneration += 1
    stop()
  })

  const totalBytes = computed(() => {
    let sum = 0
    for (const value of bytesByKey.value.values()) sum += value
    return sum
  })

  // Null until at least one pane has two samples — the first tick after a
  // start has no interval to divide by, and a zero there would read as "idle".
  const totalCpuPercent = computed(() => {
    let sum = 0
    let known = false
    for (const value of cpuPercentByKey.value.values()) {
      if (value === null) continue
      known = true
      sum += value
    }
    return known ? sum : null
  })

  return {
    cliRisksByPaneId,
    cliRisksAvailable,
    actOnCliRisk,
    bytesByKey,
    cpuPercentByKey,
    bytesByPaneId,
    cpuPercentByPaneId,
    paneIdByKey,
    totalBytes,
    totalCpuPercent,
    cpuShare: computed(() => machineCpuShare(totalCpuPercent.value, cpuCount.value)),
    memoryShare: computed(() => machineMemoryShare(totalBytes.value, machineMemoryBytes.value)),
    cpuCount,
    machineMemoryBytes,
    available,
    cpuAvailable,
    measured,
    refresh,
    stop,
  }
}
