// navide:// deep links. The only accepted form is
// `navide://extension/<publisher>.<name>`, and it only ever opens that
// extension's Marketplace detail page — it never installs and never pre-answers
// any confirmation (plan marketplace-next-mockups, decision D4). A link comes
// from an arbitrary web page, so everything else is rejected.

export const DEEP_LINK_SCHEME = 'navide'

/** Renderer → main: this window can show deep-link targets; returns the queued ones. */
export const DEEP_LINK_READY_CHANNEL = 'deeplink:ready'
/** Main → renderer: open this extension's detail page. */
export const DEEP_LINK_OPEN_CHANNEL = 'deeplink:open-extension'

/** Longest link accepted; anything longer is rejected before it is parsed. */
export const MAX_DEEP_LINK_LENGTH = 256
/** Longest extension id accepted (`publisher.name`). */
export const MAX_EXTENSION_ID_LENGTH = 128

// Same shape as the manifest v2 `id` (packages/plugin-contracts): a publisher
// segment, then one or more dot-separated name segments. Lower-case ASCII only.
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const PREFIX = `${DEEP_LINK_SCHEME}://extension/`

export interface DeepLinkExtensionTarget {
  namespace: string
  name: string
}

export type DeepLinkParseResult =
  | { ok: true; target: DeepLinkExtensionTarget }
  | { ok: false; reason: string }

export interface DeepLinkApi {
  /** Mark this window ready and take the links that arrived before it was. */
  ready: () => Promise<DeepLinkExtensionTarget[]>
  onOpenExtension: (handler: (target: DeepLinkExtensionTarget) => void) => () => void
}

export function parseDeepLink(input: unknown): DeepLinkParseResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not a string' }
  if (input.length > MAX_DEEP_LINK_LENGTH) return { ok: false, reason: 'too long' }
  // Printable ASCII only: rejects non-ASCII look-alikes, whitespace and control
  // characters before any further interpretation.
  if (!/^[\x21-\x7e]+$/.test(input)) return { ok: false, reason: 'non-printable or non-ASCII' }
  // The scheme is case-insensitive (Windows may hand it back upper-cased); the
  // rest is matched exactly.
  if (input.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    return { ok: false, reason: 'unsupported link' }
  }
  let id = input.slice(PREFIX.length)
  // Some browsers / shells append a single trailing slash.
  if (id.endsWith('/')) id = id.slice(0, -1)
  if (id.length > MAX_EXTENSION_ID_LENGTH) return { ok: false, reason: 'id too long' }
  // No query, fragment, version, path segments or percent-escapes: the regex
  // only admits [a-z0-9-] segments joined by single dots.
  if (!EXTENSION_ID.test(id)) return { ok: false, reason: 'invalid extension id' }
  const dot = id.indexOf('.')
  return { ok: true, target: { namespace: id.slice(0, dot), name: id.slice(dot + 1) } }
}

/** The first navide:// argument in a process argv (Windows/Linux launches). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}:`
  return argv.find((a) => typeof a === 'string' && a.slice(0, prefix.length).toLowerCase() === prefix) ?? null
}
