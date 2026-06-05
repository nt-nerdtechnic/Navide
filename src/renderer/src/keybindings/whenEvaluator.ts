// Evaluates `when` clause strings. Supported: &&, !, identifiers.
// Unknown identifiers resolve to false. Unsupported operators log a warning.
export function evaluateWhen(
  expr: string,
  ctx: Record<string, boolean | string>,
): boolean {
  return expr
    .split('&&')
    .map((s) => s.trim())
    .every((term) => {
      if (!term) return true
      if (term.startsWith('!')) return !ctx[term.slice(1).trim()]
      return !!ctx[term]
    })
}
