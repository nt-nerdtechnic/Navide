import type { ChannelPlatformSpec } from './types'

export const SPEC = {
  id: 'dingtalk',
  badge: 'DT',
  fields: [
    { key: 'client_id', secret: true },
    { key: 'client_secret', secret: true },
    { key: 'robot_code', secret: false, optional: true },
  ],
  singleReceiver: true,
  link: {
    targets: [{ target: 'direct', label: 'channels.link.get-code' }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
