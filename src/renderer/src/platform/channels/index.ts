/**
 * One file per chat platform; this assembler is the canonical list. Adding a
 * platform: copy `_template.ts` to `<id>.ts`, then register it here (one line,
 * in display order). The backend registry (channels/registry.py) owns the same
 * id set; the registry test cross-checks it.
 */

import type { ChannelField, ChannelPlatformSpec } from './types'
import { SPEC as telegram } from './telegram'
import { SPEC as discord } from './discord'
import { SPEC as slack } from './slack'
import { SPEC as feishu } from './feishu'
import { SPEC as dingtalk } from './dingtalk'
import { SPEC as matrix } from './matrix'
import { SPEC as mattermost } from './mattermost'
import { SPEC as imessage } from './imessage'

export type { ChannelField, ChannelLinkTarget, ChannelPlatformSpec } from './types'

// Display order (Settings, pickers) — deliberate, not alphabetical.
const ORDERED = [telegram, discord, slack, feishu, dingtalk, matrix, mattermost, imessage] as const

export type ChannelPlatform = (typeof ORDERED)[number]['id']

/** A registered spec: `id` narrowed to the known platform union. */
export type RegisteredChannelPlatform = ChannelPlatformSpec & { id: ChannelPlatform }

export const CHANNEL_PLATFORM_SPECS: readonly RegisteredChannelPlatform[] = ORDERED
export const CHANNEL_PLATFORM_IDS: readonly ChannelPlatform[] = ORDERED.map((s) => s.id)

const BY_ID = new Map<string, RegisteredChannelPlatform>(ORDERED.map((s) => [s.id, s]))

/** The spec for a platform id; undefined for an id this build does not know. */
export function channelPlatform(id: string): RegisteredChannelPlatform | undefined {
  return BY_ID.get(id)
}

/** The credential field whose `clipboardPattern` `text` matches; null when none does. */
export function clipboardTokenField(fields: readonly ChannelField[], text: string): string | null {
  const value = text.trim()
  return fields.find((f) => f.clipboardPattern?.test(value))?.key ?? null
}
