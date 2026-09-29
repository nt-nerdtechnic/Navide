import type { ChannelPlatformSpec } from './types'

export const SPEC = {
  id: 'mattermost',
  badge: 'MM',
  fields: [
    { key: 'server_url', secret: false },
    { key: 'token', secret: true },
  ],
  link: {
    targets: [{ target: 'direct', label: 'channels.link.get-code' }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
