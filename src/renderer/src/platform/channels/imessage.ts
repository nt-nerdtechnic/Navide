import type { ChannelPlatformSpec } from './types'

// No credentials: it reads the local Messages database, so it is macOS only.
export const SPEC = {
  id: 'imessage',
  badge: 'iM',
  fields: [],
  macOnly: true,
  configNoteKey: 'channels.imessage-note',
  link: {
    targets: [{ target: 'direct', label: 'channels.link.get-code' }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code-imessage',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
