/**
 * CONTRIBUTOR TEMPLATE — copy to `<your_id>.ts` and fill in, then register the
 * SPEC in `index.ts` (one line, display order). Files starting with `_` are
 * never registered. Full guide: docs/adding-a-chat-channel.md.
 */

import type { ChannelPlatformSpec } from './types'

// `as const satisfies` — NOT `: ChannelPlatformSpec`. The annotation would
// widen `id` to `string`, and index.ts derives the ChannelPlatform union from
// these literals: one annotated spec collapses the union for the whole app.
export const SPEC = {
  id: '_template', // must match the filename and the backend registry id
  badge: 'TP',
  fields: [
    { key: 'token', secret: true },
    // { key: 'domain', secret: false, optional: true, options: ['a', 'b'] },
  ],
  // macOnly: true,              // only offered on macOS
  // singleReceiver: true,       // long-poll/socket: steals messages from other receivers
  // configNoteKey: 'channels.<id>-note', // shown when `fields` is empty
  link: {
    targets: [{ target: 'direct', label: 'channels.link.get-code' }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
