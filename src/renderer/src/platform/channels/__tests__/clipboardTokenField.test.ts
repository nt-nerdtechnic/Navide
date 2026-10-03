import { describe, expect, it } from 'vitest'

import { channelPlatform, clipboardTokenField } from '../index'

const fields = (id: string) => channelPlatform(id)!.fields

describe('clipboardTokenField', () => {
  it('accepts only the shape of a Telegram bot token', () => {
    expect(clipboardTokenField(fields('telegram'), '123456789:AAHk3x-ZyQwErTyUiOpAsDfGhJkLzXcVbNm')).toBe('token')
    expect(clipboardTokenField(fields('telegram'), '  123456:abcdefghijklmnopqrstuvwxyz_-0123\n')).toBe('token')
    for (const text of ['', 'hello', '12345:AAHk3x-ZyQwErTyUiOpAsDfGhJkLzXcVbNm', '123456789:short',
      '123456789:AAHk3x ZyQwErTyUiOpAsDfGhJkLzXcVbNm', 'x123456789:AAHk3x-ZyQwErTyUiOpAsDfGhJkLzXcVbNm']) {
      expect(clipboardTokenField(fields('telegram'), text)).toBeNull()
    }
  })

  it('never matches a platform without a declared token shape', () => {
    expect(clipboardTokenField(fields('discord'), 'anything.at.all')).toBeNull()
    expect(clipboardTokenField(fields('feishu'), 'cli_x')).toBeNull()
  })
})
