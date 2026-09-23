// The Tasker tab as one "what runs next" list: Navide's own jobs, the user
// crontab and the launchd jobs, sorted into four groups.
//
//   timeline   the next run is known exactly — sorted by that time
//   recurring  fires every few minutes, or on a launchd StartInterval
//   other      always-on, on-demand, or a schedule we cannot state exactly
//   disabled   switched off (or, for launchd, not loaded)
//
// The rule that shapes everything here: a clock time is shown only when it can
// be computed exactly. A launchd StartInterval counts from whenever the job was
// loaded, which the panel cannot see, and cron lists/ranges are not parsed — so
// those land in "recurring"/"other" with their description instead of a time
// that looks precise and is wrong (the same reasoning as cronDescribe.ts).
import type { CrontabEntry, LaunchAgentEntry, StartCalendarInterval } from './cronDescribe'
import { MINUTE_MS, type SchedulerJob } from './schedulerJobs'

/** Anything that fires at least this often is a heartbeat, not an event: a
 *  timeline row for it would read "in a minute" forever and bury the rest. */
export const HIGH_FREQUENCY_MS = 5 * MINUTE_MS

export type Group = 'timeline' | 'recurring' | 'other' | 'disabled'
export type Bucket = 'today' | 'tomorrow' | 'week' | 'later'

interface ItemBase {
  /** Unique across all three sources; also the row's expand/menu id. */
  key: string
  group: Group
  /** Epoch ms of the next run; non-null only in the timeline group. */
  next: number | null
  failing: boolean
}

export type TaskerItem =
  | (ItemBase & { kind: 'job'; job: SchedulerJob })
  | (ItemBase & { kind: 'crontab'; entry: CrontabEntry })
  | (ItemBase & { kind: 'launchagent'; agent: LaunchAgentEntry })

// ── Next-run computation (local time, exact shapes only) ────────────────────

type Field = { kind: 'any' } | { kind: 'value'; n: number } | { kind: 'step'; n: number }

function parseField(raw: string, min: number, max: number, allowStep: boolean): Field | null {
  if (raw === '*') return { kind: 'any' }
  if (allowStep) {
    const m = /^\*\/(\d+)$/.exec(raw)
    if (m) {
      const n = Number(m[1])
      return n >= 1 && n <= max ? { kind: 'step', n } : null
    }
  }
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? { kind: 'value', n } : null
}

function matches(f: Field, v: number): boolean {
  if (f.kind === 'any') return true
  if (f.kind === 'value') return f.n === v
  return v % f.n === 0
}

interface Matcher {
  minute: (m: number) => boolean
  hour: (h: number) => boolean
  day: (d: Date) => boolean
}

/** First local minute strictly after `now` that the matcher accepts, looking
 *  at most `horizonDays` ahead. Days that cannot match are skipped whole. */
function nextLocal(match: Matcher, now: number, horizonDays = 400): number | null {
  const start = new Date(now)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  for (let off = 0; off <= horizonDays; off++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + off)
    if (!match.day(day)) continue
    const first = off === 0
    for (let h = first ? start.getHours() : 0; h < 24; h++) {
      if (!match.hour(h)) continue
      const fromMinute = first && h === start.getHours() ? start.getMinutes() : 0
      for (let m = fromMinute; m < 60; m++) {
        if (match.minute(m)) {
          return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
        }
      }
    }
  }
  return null
}

const CRON_SPECIALS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

interface CronSpec {
  minute: Field
  hour: Field
  dom: Field
  month: Field
  dow: Field
}

/** Parse the cron shapes we can compute exactly: each field `*`, a number, or
 *  (minute/hour) `*\/N`. Lists, ranges, names and @reboot give null. So does a
 *  line restricting both day-of-month and day-of-week, which cron ORs. */
export function parseCron(schedule: string): CronSpec | null {
  let s = schedule.trim()
  if (s.startsWith('@')) {
    const expanded = CRON_SPECIALS[s.toLowerCase()]
    if (!expanded) return null
    s = expanded
  }
  const f = s.split(/\s+/)
  if (f.length !== 5) return null
  const spec = {
    minute: parseField(f[0], 0, 59, true),
    hour: parseField(f[1], 0, 23, true),
    dom: parseField(f[2], 1, 31, false),
    month: parseField(f[3], 1, 12, false),
    dow: parseField(f[4], 0, 7, false),
  }
  if (!spec.minute || !spec.hour || !spec.dom || !spec.month || !spec.dow) return null
  if (spec.dom.kind !== 'any' && spec.dow.kind !== 'any') return null
  return spec as CronSpec
}

export function nextCronRun(spec: CronSpec, now: number): number | null {
  const dow = spec.dow
  return nextLocal(
    {
      minute: (m) => matches(spec.minute, m),
      hour: (h) => matches(spec.hour, h),
      day: (d) =>
        matches(spec.dom, d.getDate()) &&
        matches(spec.month, d.getMonth() + 1) &&
        // cron accepts both 0 and 7 for Sunday.
        (dow.kind !== 'value' || dow.n % 7 === d.getDay()),
    },
    now
  )
}

/** True when the minute field fires every minute or every few minutes. */
export function cronIsHighFrequency(spec: CronSpec): boolean {
  if (spec.minute.kind === 'any') return true
  return spec.minute.kind === 'step' && spec.minute.n * MINUTE_MS <= HIGH_FREQUENCY_MS
}

/** Next run of a StartCalendarInterval. launchd treats a missing key as a
 *  wildcard, so an entry without Minute fires every minute of its window —
 *  that is not a single time, and gives null. Day together with Weekday is
 *  ambiguous the same way cron's is, and gives null too. */
export function nextCalendarRun(entries: StartCalendarInterval[], now: number): number | null {
  if (!entries.length) return null
  let best: number | null = null
  for (const e of entries) {
    if (typeof e.Minute !== 'number') return null
    if (typeof e.Day === 'number' && typeof e.Weekday === 'number') return null
    const at = nextLocal(
      {
        minute: (m) => m === e.Minute,
        hour: (h) => typeof e.Hour !== 'number' || h === e.Hour,
        day: (d) =>
          (typeof e.Day !== 'number' || d.getDate() === e.Day) &&
          (typeof e.Month !== 'number' || d.getMonth() + 1 === e.Month) &&
          (typeof e.Weekday !== 'number' || e.Weekday % 7 === d.getDay()),
      },
      now
    )
    if (at === null) return null
    if (best === null || at < best) best = at
  }
  return best
}

// ── Classification ──────────────────────────────────────────────────────────

/** Rows are keyed by plist path, not label: the same label legitimately exists
 *  in both the user and the system directory. */
export function agentKey(agent: LaunchAgentEntry): string {
  return agent.plist_path ?? agent.label
}

export function agentFailed(agent: LaunchAgentEntry): boolean {
  return agent.last_exit_code !== null && agent.last_exit_code !== 0
}

/** `failing` comes from the caller: a job's error light also depends on the
 *  ▶ grace window, which only the jobs composable knows about. */
export function classifyJob(job: SchedulerJob, failing: boolean): TaskerItem {
  const base = { kind: 'job' as const, key: `job:${job.id}`, job, failing, next: null }
  if (!job.enabled) return { ...base, group: 'disabled' }
  const s = job.schedule
  if (s.kind === 'every' && s.every_ms <= HIGH_FREQUENCY_MS) return { ...base, group: 'recurring' }
  const next = job.state?.next_run_at
  if (typeof next === 'number') return { ...base, group: 'timeline', next }
  return { ...base, group: 'other' }
}

export function classifyCron(entry: CrontabEntry, now: number): TaskerItem {
  const base = { kind: 'crontab' as const, key: entry.id, entry, failing: false, next: null }
  if (!entry.enabled) return { ...base, group: 'disabled' }
  const spec = parseCron(entry.schedule)
  if (!spec) return { ...base, group: 'other' }
  if (cronIsHighFrequency(spec)) return { ...base, group: 'recurring' }
  const next = nextCronRun(spec, now)
  return next === null ? { ...base, group: 'other' } : { ...base, group: 'timeline', next }
}

export function classifyAgent(agent: LaunchAgentEntry, now: number): TaskerItem {
  const base = {
    kind: 'launchagent' as const,
    key: agentKey(agent),
    agent,
    failing: agentFailed(agent),
    next: null,
  }
  if (agent.runtime_known && agent.loaded === false && agent.running !== true) {
    return { ...base, group: 'disabled' }
  }
  if (typeof agent.start_interval === 'number' && agent.start_interval > 0) {
    return { ...base, group: 'recurring' }
  }
  const next = nextCalendarRun(agent.start_calendar ?? [], now)
  return next === null ? { ...base, group: 'other' } : { ...base, group: 'timeline', next }
}

export function itemName(item: TaskerItem): string {
  if (item.kind === 'job') return item.job.name
  if (item.kind === 'crontab') return item.entry.name
  return item.agent.name
}

/** Timeline: soonest first. Other groups: failing first, then by name. */
export function sortItems(items: TaskerItem[], group: Group): TaskerItem[] {
  const byName = (a: TaskerItem, b: TaskerItem): number => itemName(a).localeCompare(itemName(b))
  if (group === 'timeline') return [...items].sort((a, b) => (a.next ?? 0) - (b.next ?? 0) || byName(a, b))
  return [...items].sort((a, b) => Number(b.failing) - Number(a.failing) || byName(a, b))
}

export function bucketOf(at: number, now: number): Bucket {
  const day = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  // Rounded: a DST day is 23 or 25 hours long.
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 7) return 'week'
  return 'later'
}

// ── Telling same-named launchd jobs apart ───────────────────────────────────

/** `com.google.keystone.agent` → `google`. Null when the label is not in
 *  reverse-DNS form — then there is no vendor to name, and we do not guess. */
export function vendorOf(label: string): string | null {
  const parts = label.split('.')
  return parts.length >= 3 && parts[1] ? parts[1] : null
}

/** The backend names a job after the last label segment, so
 *  com.google.keystone.agent and com.citrolabs.keystone.agent both read
 *  "agent". For every name shared by two or more rows, map each of those rows
 *  (by agentKey) to its vendor; rows with a unique name get no entry. */
export function vendorPrefixes(agents: LaunchAgentEntry[]): Map<string, string> {
  const seen = new Map<string, number>()
  for (const a of agents) seen.set(a.name, (seen.get(a.name) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const a of agents) {
    if ((seen.get(a.name) ?? 0) < 2) continue
    const vendor = vendorOf(a.label)
    if (vendor) out.set(agentKey(a), vendor)
  }
  return out
}
