// Hand-rolled RFC-4180-style delimited-text parser (no npm dependency).
// Handles quoted fields, escaped quotes ("") inside quoted fields, delimiters
// and newlines inside quotes, and CRLF/LF line endings. TSV uses '\t' as the
// delimiter (same quoting rules).

export interface ParsedTable {
  rows: string[][]
  truncated: boolean
}

// Parse `text` into rows of fields. Stops after `maxRows` rows and sets
// `truncated` when more input remains.
export function parseDelimited(text: string, delimiter: string, maxRows: number): ParsedTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < len) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += ch
        i++
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
      i++
    } else if (ch === delimiter) {
      pushField()
      i++
    } else if (ch === '\r' && text[i + 1] === '\n') {
      pushRow()
      i += 2
      if (rows.length >= maxRows) break
    } else if (ch === '\n' || ch === '\r') {
      pushRow()
      i++
      if (rows.length >= maxRows) break
    } else {
      field += ch
      i++
    }
  }

  // Trailing row without a final newline.
  if (rows.length < maxRows && (field !== '' || row.length > 0)) pushRow()

  // A file ending in a newline is not "more input remaining".
  const truncated = rows.length >= maxRows && i < len
  return { rows, truncated }
}

// Delimiter for a given file path: tab for .tsv, comma otherwise.
export function delimiterFor(relPath: string): string {
  return relPath.toLowerCase().endsWith('.tsv') ? '\t' : ','
}
