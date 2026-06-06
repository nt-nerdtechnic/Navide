// Pure fold-range helpers extracted so they can be unit-tested independently.
// EditorView.vue imports and re-uses these; the component's reactive wrappers
// (foldedLines, version) stay inside the component.

export function getIndent(line: string): number {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return line.trim() === '' ? -1 : i
}

export function foldRangeEnd(
  getLine: (l: number) => string,
  lineCount: number,
  startLine: number,
): number {
  const startIndent = getIndent(getLine(startLine))
  if (startIndent < 0) return startLine
  let end = startLine
  let foundContent = false
  for (let l = startLine + 1; l < lineCount; l++) {
    const ind = getIndent(getLine(l))
    if (ind < 0) { end = l; continue }
    if (ind > startIndent) { foundContent = true; end = l }
    else break
  }
  return foundContent ? end : startLine
}

export function computeVisibleModelLines(
  lineCount: number,
  foldedLines: ReadonlySet<number>,
  getRangeEnd: (startLine: number) => number,
): number[] {
  const hidden = new Set<number>()
  for (const startLine of foldedLines) {
    const end = getRangeEnd(startLine)
    for (let l = startLine + 1; l <= end; l++) hidden.add(l)
  }
  const result: number[] = []
  for (let i = 0; i < lineCount; i++) {
    if (!hidden.has(i)) result.push(i)
  }
  return result
}
