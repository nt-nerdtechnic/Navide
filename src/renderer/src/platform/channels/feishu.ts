import type { ChannelPlatformSpec } from './types'

export const SPEC = {
  id: 'feishu',
  badge: 'FS',
  fields: [
    { key: 'app_id', secret: true },
    { key: 'app_secret', secret: true },
    { key: 'domain', secret: false, optional: true, options: ['feishu', 'lark'] },
  ],
  singleReceiver: true,
  link: {
    targets: [{ target: 'direct', label: 'channels.link.get-code' }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
