export function summarizeTokens(values: number[]) {
  if (!values.length) return { count: 0, total: 0, mean: 0, median: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const total = values.reduce((sum, value) => sum + value, 0)
  const middle = Math.floor(sorted.length / 2)
  return { count: values.length, total, mean: total / values.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
}

export function movingAverage(values: number[], window = 10): number[] {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1)
    return values.slice(start, i + 1).reduce((sum, value) => sum + value, 0) / (i - start + 1)
  })
}

export function chartPoints(values: number[], maximum: number): string {
  return values.map((value, index) => `${24 + (values.length > 1 ? index / (values.length - 1) : 0.5) * 752},${176 - value / Math.max(1, maximum) * 152}`).join(' ')
}

export function comparePeriods<T extends { started_at: string | null; output: number }>(turns: T[], now: number) {
  const week = 7 * 86400_000
  const current = turns.filter(t => { const ts = Date.parse(t.started_at ?? ''); return ts > now - week && ts <= now })
  const previous = turns.filter(t => { const ts = Date.parse(t.started_at ?? ''); return ts > now - 2 * week && ts <= now - week })
  const recent = summarizeTokens(current.map(t => t.output))
  const baseline = summarizeTokens(previous.map(t => t.output))
  return { recent, baseline, change: recent.count >= 10 && baseline.count >= 10 && baseline.mean > 0
    ? (recent.mean / baseline.mean - 1) * 100 : null }
}
