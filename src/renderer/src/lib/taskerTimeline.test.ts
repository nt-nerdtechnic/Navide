import { describe, expect, it } from 'vitest'
import type { CrontabEntry, LaunchAgentEntry } from './cronDescribe'
import type { SchedulerJob } from './schedulerJobs'
import {
  bucketOf,
  classifyAgent,
  classifyCron,
  classifyJob,
  cronIsHighFrequency,
  nextCalendarRun,
  nextCronRun,
  parseCron,
  sortItems,
  vendorOf,
  vendorPrefixes,
} from './taskerTimeline'

// Wednesday 2026-09-23 10:30:20 local time. Every expectation is built with
// the same local Date constructor, so the suite holds in any time zone.
const NOW = new Date(2026, 8, 23, 10, 30, 20).getTime()
const at = (d: number, h: number, m: number, month = 8): number => new Date(2026, month, d, h, m).getTime()

function cronNext(schedule: string): number | null {
  const spec = parseCron(schedule)
  return spec ? nextCronRun(spec, NOW) : null
}

function entry(over: Partial<CrontabEntry> = {}): CrontabEntry {
  return {
    id: 'c1',
    name: 'backup',
    schedule: '30 2 * * *',
    schedule_kind: 'standard',
    command: 'backup.sh',
    raw: '30 2 * * * backup.sh',
    enabled: true,
    ...over,
  }
}

function agent(over: Partial<LaunchAgentEntry> = {}): LaunchAgentEntry {
  return {
    label: 'com.example.job',
    name: 'job',
    plist_path: '/Users/t/Library/LaunchAgents/com.example.job.plist',
    plist_exists: true,
    scope: 'user',
    managed: true,
    runtime_known: true,
    loaded: true,
    running: false,
    pid: null,
    last_exit_code: 0,
    keep_alive: false,
    run_at_load: false,
    start_interval: null,
    start_calendar: [],
    comment: null,
    ...over,
  }
}

function job(over: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: 'j1',
    name: 'report',
    enabled: true,
    schedule: { kind: 'daily', at: '09:00', tz: 'UTC' },
    action: { kind: 'message', workspace: '/w', pane_name: 'p', text: 'x' },
    state: { next_run_at: at(24, 9, 0) },
    ...over,
  }
}

describe('nextCronRun', () => {
  it('computes the next exact slot for the recognised shapes', () => {
    expect(cronNext('* * * * *')).toBe(at(23, 10, 31))
    expect(cronNext('*/15 * * * *')).toBe(at(23, 10, 45))
    expect(cronNext('5 * * * *')).toBe(at(23, 11, 5))
    expect(cronNext('0 */4 * * *')).toBe(at(23, 12, 0))
    expect(cronNext('30 2 * * *')).toBe(at(24, 2, 30))
    expect(cronNext('45 10 * * *')).toBe(at(23, 10, 45))
    // Friday; 2026-09-25.
    expect(cronNext('0 9 * * 5')).toBe(at(25, 9, 0))
    // 7 and 0 both mean Sunday; 2026-09-27.
    expect(cronNext('0 9 * * 7')).toBe(at(27, 9, 0))
    expect(cronNext('0 9 * * 0')).toBe(at(27, 9, 0))
    expect(cronNext('0 0 1 * *')).toBe(at(1, 0, 0, 9))
    expect(cronNext('@daily')).toBe(at(24, 0, 0))
    expect(cronNext('@hourly')).toBe(at(23, 11, 0))
  })

  it('is strictly after now, even on the current minute', () => {
    expect(cronNext('30 10 * * *')).toBe(at(24, 10, 30))
  })

  it('refuses the shapes it cannot compute exactly', () => {
    for (const s of ['@reboot', '0 9-17 * * *', '0 1,13 * * *', '0 0 1 * 1', '0 9 * * mon', '0 25 * * *', '30 2 * *', '']) {
      expect(parseCron(s)).toBeNull()
    }
  })

  it('treats every-minute and every few minutes as high frequency', () => {
    expect(cronIsHighFrequency(parseCron('* * * * *')!)).toBe(true)
    expect(cronIsHighFrequency(parseCron('*/5 * * * *')!)).toBe(true)
    expect(cronIsHighFrequency(parseCron('* 3 * * *')!)).toBe(true)
    expect(cronIsHighFrequency(parseCron('*/10 * * * *')!)).toBe(false)
    expect(cronIsHighFrequency(parseCron('0 * * * *')!)).toBe(false)
  })
})

describe('nextCalendarRun', () => {
  it('takes the earliest of several entries, with a missing Hour as every hour', () => {
    expect(nextCalendarRun([{ Hour: 3, Minute: 0 }], NOW)).toBe(at(24, 3, 0))
    expect(nextCalendarRun([{ Minute: 40 }], NOW)).toBe(at(23, 10, 40))
    expect(nextCalendarRun([{ Hour: 3, Minute: 0 }, { Hour: 12, Minute: 15 }], NOW)).toBe(at(23, 12, 15))
    expect(nextCalendarRun([{ Weekday: 1, Hour: 8, Minute: 0 }], NOW)).toBe(at(28, 8, 0))
    expect(nextCalendarRun([{ Day: 1, Hour: 4, Minute: 0 }], NOW)).toBe(at(1, 4, 0, 9))
  })

  it('gives null when launchd would fire every minute of a window, or the entry is ambiguous', () => {
    // No Minute: launchd treats it as a wildcard — every minute of hour 3.
    expect(nextCalendarRun([{ Hour: 3 }], NOW)).toBeNull()
    expect(nextCalendarRun([{ Day: 1, Weekday: 1, Minute: 0 }], NOW)).toBeNull()
    expect(nextCalendarRun([], NOW)).toBeNull()
  })
})

describe('classification', () => {
  it('puts a job on the timeline only when the backend gave a next run', () => {
    expect(classifyJob(job(), false)).toMatchObject({ group: 'timeline', next: at(24, 9, 0), key: 'job:j1' })
    expect(classifyJob(job({ enabled: false }), false).group).toBe('disabled')
    expect(classifyJob(job({ state: {} }), false).group).toBe('other')
    expect(classifyJob(job({ schedule: { kind: 'every', every_ms: 60_000 } }), false)).toMatchObject({
      group: 'interval',
      intervalMs: 60_000,
    })
    expect(classifyJob(job({ schedule: { kind: 'every', every_ms: 3_600_000 } }), false).group).toBe('timeline')
    expect(classifyJob(job(), true).failing).toBe(true)
  })

  it('sorts crontab entries by what can be known about them', () => {
    expect(classifyCron(entry(), NOW)).toMatchObject({ group: 'timeline', next: at(24, 2, 30) })
    expect(classifyCron(entry({ schedule: '* * * * *' }), NOW)).toMatchObject({ group: 'interval', intervalMs: 60_000 })
    expect(classifyCron(entry({ schedule: '*/5 * * * *' }), NOW)).toMatchObject({ group: 'interval', intervalMs: 300_000 })
    expect(classifyCron(entry({ schedule: '@reboot' }), NOW).group).toBe('other')
    // Not computable: fixed-interval tail, interval unknown — never a guessed time.
    expect(classifyCron(entry({ schedule: '0 9-17 * * *' }), NOW)).toMatchObject({ group: 'interval', intervalMs: null })
    expect(classifyCron(entry({ enabled: false }), NOW).group).toBe('disabled')
  })

  it('never puts a launchd StartInterval on the clock — its phase is unknowable', () => {
    expect(classifyAgent(agent({ start_interval: 1800 }), NOW)).toMatchObject({
      group: 'interval',
      next: null,
      intervalMs: 1_800_000,
    })
    expect(classifyAgent(agent({ start_calendar: [{ Hour: 3, Minute: 0 }] }), NOW)).toMatchObject({
      group: 'timeline',
      next: at(24, 3, 0),
    })
    expect(classifyAgent(agent({ keep_alive: true }), NOW).group).toBe('other')
    expect(classifyAgent(agent(), NOW).group).toBe('other')
    expect(classifyAgent(agent({ loaded: false }), NOW).group).toBe('disabled')
    // Unknown runtime is never read as "not loaded".
    expect(
      classifyAgent(agent({ runtime_known: false, loaded: null, running: null }), NOW).group
    ).toBe('other')
    expect(classifyAgent(agent({ last_exit_code: 7 }), NOW).failing).toBe(true)
    expect(classifyAgent(agent({ last_exit_code: 0 }), NOW).failing).toBe(false)
  })

  it('orders the timeline by time and every other group failures first', () => {
    const early = classifyCron(entry({ id: 'a', name: 'zeta', schedule: '0 11 * * *' }), NOW)
    const late = classifyCron(entry({ id: 'b', name: 'alpha', schedule: '0 12 * * *' }), NOW)
    expect(sortItems([late, early], 'timeline').map((i) => i.key)).toEqual(['a', 'b'])

    const ok = classifyAgent(agent({ name: 'aaa', plist_path: '/a' }), NOW)
    const bad = classifyAgent(agent({ name: 'zzz', plist_path: '/z', last_exit_code: 1 }), NOW)
    expect(sortItems([ok, bad], 'other').map((i) => i.key)).toEqual(['/z', '/a'])
  })

  it('fills the list with fixed-interval rows when nothing has an exact time', () => {
    // The reported machine: no Navide job, launchd all StartInterval, one
    // every-minute crontab line. The list must not come out empty.
    const items = [
      classifyAgent(agent({ name: 'hourly', plist_path: '/h', start_interval: 3600 }), NOW),
      classifyAgent(agent({ name: 'half', plist_path: '/m', start_interval: 1800, last_exit_code: 3 }), NOW),
      classifyAgent(agent({ name: 'fast', plist_path: '/f', start_interval: 30 }), NOW),
      classifyCron(entry({ id: 'artisan', name: 'artisan', schedule: '* * * * *' }), NOW),
      classifyCron(entry({ id: 'list', name: 'list', schedule: '0,30 * * * *' }), NOW),
    ]
    expect(items.filter((i) => i.group === 'timeline')).toEqual([])
    const interval = sortItems(items.filter((i) => i.group === 'interval'), 'interval')
    // Most frequent first, unknown interval last; a failure keeps its place.
    expect(interval.map((i) => i.key)).toEqual(['/f', 'artisan', '/m', '/h', 'list'])
    expect(interval.find((i) => i.key === '/m')?.failing).toBe(true)
  })
})

describe('bucketOf', () => {
  it('splits by local calendar day', () => {
    expect(bucketOf(at(23, 23, 59), NOW)).toBe('today')
    expect(bucketOf(at(24, 0, 0), NOW)).toBe('tomorrow')
    expect(bucketOf(at(29, 9, 0), NOW)).toBe('week')
    expect(bucketOf(at(30, 9, 0), NOW)).toBe('later')
    // A time already in the past (backend slot not yet re-read) still reads as today.
    expect(bucketOf(at(23, 9, 0), NOW)).toBe('today')
  })
})

describe('vendor prefixes', () => {
  it('names the vendor only for names that collide', () => {
    expect(vendorOf('com.google.GoogleUpdater.wake')).toBe('google')
    expect(vendorOf('wake')).toBeNull()

    const agents = [
      agent({ label: 'com.google.GoogleUpdater.wake', name: 'wake', plist_path: '/g' }),
      agent({ label: 'com.citrolabs.EgoUpdater.wake', name: 'wake', plist_path: '/c' }),
      agent({ label: 'wake', name: 'wake', plist_path: '/bare' }),
      agent({ label: 'com.example.sync', name: 'sync', plist_path: '/s' }),
    ]
    const map = vendorPrefixes(agents)
    expect(map.get('/g')).toBe('google')
    expect(map.get('/c')).toBe('citrolabs')
    // Not reverse-DNS: no vendor to name, and we do not guess one.
    expect(map.has('/bare')).toBe(false)
    // Unique name: left alone.
    expect(map.has('/s')).toBe(false)
  })
})
