import type { ChannelPlatformSpec } from './types'

// Telegram deep links carry the code, so the code is sent as `/start <code>`.
export const SPEC = {
  id: 'telegram',
  badge: 'TG',
  fields: [{ key: 'token', secret: true }],
  singleReceiver: true,
  link: {
    targets: [
      { target: 'direct', label: 'channels.link.open-telegram', opensLink: true },
      { target: 'group', label: 'channels.link.add-group', opensLink: true },
    ],
    codeCommand: '/start',
    sendCodeKey: () => 'channels.link.send-code-telegram',
    waitingKey: 'channels.link.waiting-start',
  },
} as const satisfies ChannelPlatformSpec
