import type { ChannelPlatformSpec } from './types'

// Slack's link opens the app's DM.
export const SPEC = {
  id: 'slack',
  badge: 'SL',
  fields: [
    { key: 'app_token', secret: true },
    { key: 'bot_token', secret: true },
  ],
  singleReceiver: true,
  link: {
    targets: [{ target: 'direct', label: 'channels.link.open-slack', opensLink: true }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
