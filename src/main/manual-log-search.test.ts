import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findManualLogFile, isValidManualLogFileName } from './manual-log-search'

describe('isValidManualLogFileName', () => {
  it('accepts a bare filename', () => {
    expect(isValidManualLogFileName('claude-abcd1234.log')).toBe(true)
  })
  it('rejects separators and traversal segments', () => {
    expect(isValidManualLogFileName('../etc/passwd')).toBe(false)
    expect(isValidManualLogFileName('sub/claude.log')).toBe(false)
    expect(isValidManualLogFileName('sub\\claude.log')).toBe(false)
    expect(isValidManualLogFileName('')).toBe(false)
  })
})

describe('findManualLogFile', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'manual-log-search-'))
  })
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('finds a file nested under a date subfolder', async () => {
    const dateDir = join(workspace, '.agent-team', 'manual', '20260716')
    mkdirSync(dateDir, { recursive: true })
    const logPath = join(dateDir, 'claude-b0827123.log')
    writeFileSync(logPath, 'hello')

    expect(await findManualLogFile(workspace, 'claude-b0827123.log')).toBe(logPath)
  })

  it('returns null when the manual directory does not exist', async () => {
    expect(await findManualLogFile(workspace, 'claude-b0827123.log')).toBeNull()
  })

  it('returns null when no date folder has a matching file', async () => {
    mkdirSync(join(workspace, '.agent-team', 'manual', '20260716'), { recursive: true })
    expect(await findManualLogFile(workspace, 'claude-b0827123.log')).toBeNull()
  })

  it('picks the most recently modified match across duplicate date folders', async () => {
    const olderDir = join(workspace, '.agent-team', 'manual', '20260716')
    const newerDir = join(workspace, '.agent-team', 'manual', '20260719')
    mkdirSync(olderDir, { recursive: true })
    mkdirSync(newerDir, { recursive: true })
    const olderPath = join(olderDir, 'claude-b0827123.log')
    const newerPath = join(newerDir, 'claude-b0827123.log')
    writeFileSync(olderPath, 'old')
    writeFileSync(newerPath, 'new')
    const older = new Date('2026-07-16T00:00:00Z')
    const newer = new Date('2026-07-19T00:00:00Z')
    utimesSync(olderPath, older, older)
    utimesSync(newerPath, newer, newer)

    expect(await findManualLogFile(workspace, 'claude-b0827123.log')).toBe(newerPath)
  })

  it('rejects a traversal filename without touching the filesystem', async () => {
    mkdirSync(join(workspace, '.agent-team', 'manual', '20260716'), { recursive: true })
    expect(await findManualLogFile(workspace, '../../../etc/passwd')).toBeNull()
  })
})
