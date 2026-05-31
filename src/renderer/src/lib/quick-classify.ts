// Fast regex-based completion pre-filter for the watcher.
//
// Called BEFORE the LLM analyzer so obvious completions skip the expensive
// round-trip. Returns:
//   'completion' — high-confidence done: advance without calling LLM.
//   'uncertain'  — can't tell: let the LLM analyzer decide.
//
// Conservative on purpose: false-negatives (uncertain when actually done)
// just fall through to LLM and cost a little more. False-positives (done when
// actually still working) would mis-advance a stage, which is much worse.
// So every pattern here must be unambiguous in the agent outputs we see.

export type QuickIntent = 'completion' | 'uncertain'

// Patterns that, near the END of the slice, strongly indicate the agent
// finished its deliverable. Tested against the last TAIL_CHARS characters so
// early-output matches (e.g. "完成後請..." mid-task) don't trigger.
const TAIL_CHARS = 1500
const COMPLETION_PATTERNS: RegExp[] = [
  // Explicit sentinel-like markers the agent might write without exact format
  /---+(?:[A-Z0-9_\-]*(?:DONE|COMPLETE|FINISH|END)[A-Z0-9_\-]*)---+/i,

  // Chinese: "以上為...完整..." / "以上是...所有..."
  /以上(?:為|是)[^。\n]{0,40}(?:完整|全部|所有)/,

  // Chinese: "已完成全部/所有/上述..."
  /已完成(?:全部|所有|上述|以上)[^。\n]{0,60}/,

  // Chinese: standalone "任務完成" / "工作完成" on its own line
  /^(?:任務|工作|階段|本階段)(?:已\s*)?完成[。！\s]*$/m,

  // Deliverable summary tail: multiple ✅ lines in a row (completed checklist)
  /(?:^✅\s+.+\n){2,}/m,

  // English: ends with a clear "done" statement on its own line
  /^(?:Done|Completed|Finished|All done)[.!]?\s*$/im,
]

/** Return 'completion' when the buffer tail matches a high-confidence done
 *  pattern; 'uncertain' otherwise (caller should invoke LLM).
 *
 *  Only the last TAIL_CHARS are scanned — early-output matches (e.g. a
 *  "完成後請..." phrase mid-task) must not trigger. The caller (watcher) only
 *  passes this enough content to judge the CURRENT state, not the full history.
 */
export function quickClassify(slice: string): QuickIntent {
  if (!slice || !slice.trim()) return 'uncertain'
  // Only look at the tail so mid-task pattern echoes don't fire.
  const tail = slice.length > TAIL_CHARS ? slice.slice(slice.length - TAIL_CHARS) : slice
  for (const re of COMPLETION_PATTERNS) {
    if (re.test(tail)) return 'completion'
  }
  return 'uncertain'
}
