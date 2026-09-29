import type { ChannelPlatformSpec } from './types'

// Discord's link installs the bot in a server; a DM needs the code typed by hand.
export const SPEC = {
  id: 'discord',
  badge: 'DC',
  fields: [{ key: 'token', secret: true }],
  singleReceiver: true,
  link: {
    targets: [
      { target: 'group', label: 'channels.link.add-server', opensLink: true },
      { target: 'direct', label: 'channels.link.get-code' },
    ],
    codeCommand: 'link',
    sendCodeKey: (target) => (target === 'direct' ? 'channels.link.send-code-discord' : 'channels.link.send-code'),
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
