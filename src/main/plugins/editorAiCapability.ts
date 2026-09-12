import { randomUUID } from 'node:crypto'
import type { WsClient } from '../../shared/wsClient'

export const EDITOR_AI_METHODS = [
  'aiCli.rewrite', 'aiCli.complete', 'aiCli.reviewStart', 'aiCli.reviewStop',
  'aiCli.getModelPreferences', 'aiCli.setModelPreferences', 'aiCli.listModels',
  'aiCli.getEditorProfile', 'aiCli.setEditorProfile',
] as const
export const EDITOR_AI_EVENTS = ['aiCli.reviewResult', 'aiCli.reviewEnd', 'aiCli.reviewError'] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateEditorAiRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (address === 'aiCli.reviewStop' && (typeof value.reviewId !== 'string' || !value.reviewId)) return false
  const required: Record<string, readonly string[]> = {
    'aiCli.rewrite': ['code', 'instruction', 'language', 'model'],
    'aiCli.complete': ['prefix', 'suffix', 'language', 'model'],
    'aiCli.reviewStop': ['reviewId'],
    'aiCli.getModelPreferences': [],
    'aiCli.setModelPreferences': ['provider', 'model'],
    'aiCli.listModels': [],
    'aiCli.getEditorProfile': [],
    'aiCli.setEditorProfile': ['profileId'],
  }
  if (address === 'aiCli.reviewStart') {
    return (value.mode === 'working' || value.mode === 'branch') &&
      (value.base === undefined || typeof value.base === 'string') &&
      (value.compare === undefined || typeof value.compare === 'string') &&
      Object.keys(value).every(key => ['mode', 'base', 'compare'].includes(key))
  }
  const keys = required[address]
  return Boolean(keys && keys.every(key => typeof value[key] === 'string') &&
    Object.keys(value).every(key => keys.includes(key)))
}

export interface EditorAiExecution {
  instanceId: string
  workspacePath: string
  /** Rechecks the original Host-minted Initiator, Grant and live policy. */
  canDispatch(): boolean
}

export function validateEditorAiEvent(event: string, payload: unknown): boolean {
  if (!record(payload) || typeof payload.reviewId !== 'string' || !payload.reviewId) return false
  if (event === 'aiCli.reviewEnd') return Object.keys(payload).every(key => key === 'reviewId')
  if (event === 'aiCli.reviewError') return typeof payload.message === 'string' &&
    Object.keys(payload).every(key => key === 'reviewId' || key === 'message')
  if (event !== 'aiCli.reviewResult' ||
    Object.keys(payload).some(key => key !== 'reviewId' && key !== 'result')) return false
  const result = payload.result
  return record(result) && Object.keys(result).every(key => ['summary', 'verdict', 'findings'].includes(key)) &&
    typeof result.summary === 'string' &&
    ['approve', 'approve_with_comments', 'request_changes'].includes(String(result.verdict)) &&
    Array.isArray(result.findings) && result.findings.every(finding => record(finding) &&
      Object.keys(finding).every(key => ['id', 'file', 'line', 'severity', 'title', 'body'].includes(key)) &&
      ['id', 'file', 'title', 'body'].every(key => typeof finding[key] === 'string') &&
      (finding.line === null || (typeof finding.line === 'number' && Number.isInteger(finding.line))) &&
      ['critical', 'warning', 'suggestion'].includes(String(finding.severity)))
}

interface Review {
  id: string
  client: WsClient
  disposeListeners: Array<() => void>
}

/** Dedicated review sockets preserve the backend's per-session cancellation
 * semantics without allowing one Plugin instance to cancel another's work.
 * Only the Host holds these clients and mints review identities. */
export class EditorAiCapability {
  private readonly reviews = new Map<string, Review>()

  constructor(private readonly dependencies: {
    createReviewClient(onDisconnected: () => void): WsClient
    request(type: string, payload: Record<string, unknown>, beforeDispatch: () => boolean): Promise<unknown>
    publish(instanceId: string, event: string, payload: Record<string, unknown>): void
  }) {}

  close(instanceId: string): void {
    const review = this.reviews.get(instanceId)
    if (!review) return
    this.reviews.delete(instanceId)
    for (const dispose of review.disposeListeners) dispose()
    review.client.dispose('editor review closed')
  }

  closeAll(): void {
    for (const instanceId of this.reviews.keys()) this.close(instanceId)
  }

  async execute(address: string, args: Record<string, unknown>, context: EditorAiExecution): Promise<unknown> {
    if (!validateEditorAiRequest(address, args)) throw new Error('invalid editor AI request')
    if (!context.canDispatch()) throw new Error('editor AI operation denied')
    if (address === 'aiCli.getEditorProfile') {
      const result = await this.dependencies.request('ui.settings.get', {}, context.canDispatch)
      const settings = record(result) && record(result.settings) ? result.settings : {}
      const profileId = settings['ide-ai-panel-width.agent']
      return { profileId: typeof profileId === 'string' ? profileId : null }
    }
    if (address === 'aiCli.setEditorProfile') {
      await this.dependencies.request('ui.settings.set', {
        updates: { 'ide-ai-panel-width.agent': args.profileId },
      }, context.canDispatch)
      return { ok: true }
    }
    if (address === 'aiCli.reviewStop') {
      const review = this.reviews.get(context.instanceId)
      if (!review || review.id !== args.reviewId) throw new Error('review is not owned by this instance')
      this.close(context.instanceId)
      return { ok: true }
    }
    if (address === 'aiCli.reviewStart') {
      this.close(context.instanceId)
      const review: Review = {
        id: randomUUID(),
        client: this.dependencies.createReviewClient(() => {
          if (this.reviews.get(context.instanceId) === review) this.close(context.instanceId)
        }),
        disposeListeners: [],
      }
      this.reviews.set(context.instanceId, review)
      const current = (): boolean => this.reviews.get(context.instanceId) === review && context.canDispatch()
      const events = [
        ['ai.review.result', 'aiCli.reviewResult'],
        ['ai.review.end', 'aiCli.reviewEnd'],
        ['ai.review.error', 'aiCli.reviewError'],
      ] as const
      for (const [backendEvent, publicEvent] of events) {
        review.disposeListeners.push(review.client.on(backendEvent, payload => {
          if (!current() || !record(payload) || payload.review_id !== review.id) return
          const event: Record<string, unknown> = { reviewId: review.id }
          if (publicEvent === 'aiCli.reviewResult') event.result = payload.result
          if (publicEvent === 'aiCli.reviewError') event.message = payload.message
          if (!validateEditorAiEvent(publicEvent, event)) return
          this.dependencies.publish(context.instanceId, publicEvent, event)
          if (publicEvent !== 'aiCli.reviewResult') this.close(context.instanceId)
        }))
      }
      try {
        const result = await review.client.send('ai.review.start', {
          workspace_path: context.workspacePath, review_id: review.id,
          mode: args.mode, base: args.base ?? '', compare: args.compare ?? '',
        }, 10_000, { beforeDispatch: current })
        if (!result.ok) throw new Error(result.error?.message ?? 'review start failed')
        return { reviewId: review.id }
      } catch (error) {
        if (this.reviews.get(context.instanceId) === review) this.close(context.instanceId)
        throw error
      }
    }
    const routes: Record<string, string> = {
      'aiCli.rewrite': 'editor.rewrite',
      'aiCli.complete': 'editor.complete',
      'aiCli.getModelPreferences': 'ai.chat.settings.get',
      'aiCli.setModelPreferences': 'ai.chat.settings.set',
      'aiCli.listModels': 'analyzer.models',
    }
    const result = await this.dependencies.request(routes[address], args, context.canDispatch)
    if (address === 'aiCli.listModels') {
      return {
        ok: true,
        models: record(result) && Array.isArray(result.models)
          ? result.models.filter((model): model is Record<string, unknown> => record(model) && typeof model.name === 'string')
            .map(model => ({ name: model.name as string }))
          : [],
      }
    }
    if (address === 'aiCli.getModelPreferences' || address === 'aiCli.setModelPreferences') {
      return {
        provider: record(result) && typeof result.provider === 'string' ? result.provider : '',
        model: record(result) && typeof result.model === 'string' ? result.model : '',
      }
    }
    return result
  }
}
