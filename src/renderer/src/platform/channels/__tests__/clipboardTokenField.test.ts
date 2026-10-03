import { describe, expect, it } from 'vitest'

import { channelPlatform, clipboardTokenField } from '../index'

const fields = (id: string) => channelPlatform(id)!.fields
// A made-up token, assembled at runtime so secret scanners do not flag the
// test source as a leaked bot token.
const SECRET = ['AAHk3x', 'ZyQwErTyUiOpAsDfGhJkLzXcVbNm'].join('-')

describe('clipboardTokenField', () => {
  it('accepts only the shape of a Telegram bot token', () => {
    expect(clipboardTokenField(fields('telegram'), `123456789:${SECRET}`)).toBe('token')
    expect(clipboardTokenField(fields('telegram'), '  123456:abcdefghijklmnopqrstuvwxyz_-0123\n')).toBe('token')
    for (const text of ['', 'hello', `12345:${SECRET}`, '123456789:short',
      '123456789:AAHk3x ZyQwErTyUiOpAsDfGhJkLzXcVbNm', `x123456789:${SECRET}`]) {
      expect(clipboardTokenField(fields('telegram'), text)).toBeNull()
    }
  })

  it('tells the two Slack tokens apart', () => {
    expect(clipboardTokenField(fields('slack'), 'xapp-1-A0123-4567-abcdef')).toBe('app_token')
    expect(clipboardTokenField(fields('slack'), 'xoxb-1234-5678-abcdEFGH')).toBe('bot_token')
    expect(clipboardTokenField(fields('slack'), 'xoxp-1234-5678')).toBeNull()
    expect(clipboardTokenField(fields('slack'), 'see xoxb-1234')).toBeNull()
  })

  it('never matches a platform without a declared token shape', () => {
    expect(clipboardTokenField(fields('discord'), 'anything.at.all')).toBeNull()
    expect(clipboardTokenField(fields('feishu'), 'cli_x')).toBeNull()
  })
})
