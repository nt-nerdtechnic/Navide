import type { ChannelPlatformSpec } from './types'

// What the Slack adapter (backend channels/slack.py) needs, as an app manifest
// (https://docs.slack.dev/reference/app-manifest): Socket Mode for inbound,
// interactivity for the permission buttons (block_actions), the message events it
// reads (channel_type im / channel / group / mpim, plus app_mention), and the bot
// scopes of the Web API methods it calls: chat.postMessage / chat.update
// (chat:write), users.info and bots.info (users:read). The app-level token
// (connections:write) cannot come from a manifest; the user creates it.
export const SLACK_APP_MANIFEST = {
  display_information: { name: 'Navide' },
  features: {
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'Navide', always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: ['app_mentions:read', 'channels:history', 'chat:write', 'groups:history', 'im:history', 'mpim:history', 'users:read'],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
    },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
}

// Slack's link opens the app's DM.
export const SPEC = {
  id: 'slack',
  badge: 'SL',
  fields: [
    { key: 'app_token', secret: true, clipboardPattern: /^xapp-[A-Za-z0-9-]+$/ },
    { key: 'bot_token', secret: true, clipboardPattern: /^xoxb-[A-Za-z0-9-]+$/ },
  ],
  singleReceiver: true,
  setupLink: {
    label: 'channels.quick.slack-manifest',
    hint: 'channels.quick.slack-manifest-hint',
    url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST))}`,
  },
  link: {
    targets: [{ target: 'direct', label: 'channels.link.open-slack', opensLink: true }],
    codeCommand: 'link',
    sendCodeKey: () => 'channels.link.send-code',
    waitingKey: 'channels.link.waiting',
  },
} as const satisfies ChannelPlatformSpec
