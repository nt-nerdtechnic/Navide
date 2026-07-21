// Supply-chain verification for plugin installs — PURE logic, electron-free, so
// it can be unit-tested under Vitest's node environment (only `node:crypto` is
// imported, a runtime builtin available in any environment).
//
// The verification chain a marketplace package must pass before it is unpacked:
//   1. digest      — sha256 of the downloaded bytes MUST equal the registry's
//                    `X-Package-Digest` header (integrity / anti-tamper).
//   2. signature   — when a detached Ed25519 signature + publisher public key
//                    are available, it MUST verify over the digest; a *failed*
//                    verification blocks the install. Unsigned packages are not
//                    blocked (their trust tier is surfaced to the user instead).
//   3. capabilities— every declared `requires` namespace MUST be a known
//                    capability; an unknown namespace is a scope-escalation and
//                    is rejected (namespace over-reach).
// Zip-slip path-traversal defence lives here too (`assertSafeEntryPath`) and is
// applied by the unpack shell before any bytes hit disk.
//
// Mirrors the registry's own chain: `signing.py` signs/verifies a base64
// Ed25519 signature over the ascii-encoded sha256 *hex* digest; `trust.py`
// flags `fs`/`terminal` as sensitive. Kept in sync deliberately.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** Capability namespaces the host can authorize. Mirror of the backend
 *  `manifest.KNOWN_CAPABILITIES` (fs/git/terminal/search/chat/ui/issues). */
export const KNOWN_CAPABILITIES: readonly string[] = [
  'fs',
  'git',
  'terminal',
  'search',
  'chat',
  'ui',
  'issues',
]

/** Capabilities that grant filesystem / shell reach and warrant a second
 *  confirmation before install. Mirror of the registry `trust.py`. */
export const SENSITIVE_CAPABILITIES: readonly string[] = ['fs', 'terminal']

export const TRUST_SIGNED = 'signed-verified'
export const TRUST_UNSIGNED = 'unsigned'
export type TrustTier = typeof TRUST_SIGNED | typeof TRUST_UNSIGNED

/** Machine-readable reason an install was refused; the UI maps these to copy. */
export type VerifyErrorCode =
  | 'DIGEST_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'CAP_UNKNOWN'
  | 'ZIP_SLIP'

export class PluginVerifyError extends Error {
  constructor(
    readonly code: VerifyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PluginVerifyError'
  }
}

/** sha256 of `bytes` as a lowercase hex string (matches the registry digest). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verify a detached base64 Ed25519 `signature` over the ascii-encoded hex
 * `digest`, using a PEM SubjectPublicKeyInfo `publicKey`. Returns false (never
 * throws) on any malformed input — the caller decides whether false blocks.
 * This is the exact inverse of the registry's `Ed25519SignatureVerifier`.
 */
export function verifyEd25519(
  digest: string,
  signature: string | null | undefined,
  publicKey: string | null | undefined
): boolean {
  if (!signature || !publicKey) return false
  try {
    const key = createPublicKey(publicKey)
    const sig = Buffer.from(signature, 'base64')
    // Ed25519: algorithm arg must be null; message is the ascii hex digest.
    return cryptoVerify(null, Buffer.from(digest, 'ascii'), key, sig)
  } catch {
    return false
  }
}

/** Subset of declared capabilities flagged sensitive (fs/terminal). */
export function sensitiveCapabilities(requires: readonly string[]): string[] {
  return requires.filter((c) => SENSITIVE_CAPABILITIES.includes(c))
}

/**
 * Reject a `requires` list that names a namespace the host cannot authorize.
 * A third-party manifest asking for an unknown capability is treated as scope
 * over-reach and refused (`CAP_UNKNOWN`).
 */
export function assertKnownCapabilities(requires: readonly string[]): void {
  for (const cap of requires) {
    if (!KNOWN_CAPABILITIES.includes(cap)) {
      throw new PluginVerifyError(
        'CAP_UNKNOWN',
        `manifest requires unknown capability '${cap}' (known: ${KNOWN_CAPABILITIES.join(', ')})`
      )
    }
  }
}

/**
 * Reject a zip entry name that would escape the extraction root (zip-slip):
 * absolute paths, drive letters, backslashes, or any `..` segment. Called for
 * every archive entry before it is written.
 */
export function assertSafeEntryPath(name: string): void {
  const bad =
    name.length === 0 ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.includes('\\') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((seg) => seg === '..')
  if (bad) {
    throw new PluginVerifyError('ZIP_SLIP', `unsafe archive entry path: ${name}`)
  }
}

export interface VerifyPackageInput {
  /** The raw downloaded package (`.vsix`) bytes. */
  bytes: Uint8Array
  /** The registry's `X-Package-Digest` response header (sha256 hex). */
  expectedDigest: string
  /** Detached base64 Ed25519 signature, when the caller has it (else null). */
  signature?: string | null
  /** Publisher PEM public key, when available (else null). */
  publicKey?: string | null
  /** Trust tier the registry recorded for this version, consumed as a fallback
   *  when no signature material is available to re-verify client-side. */
  claimedTrustTier?: string | null
  /** The manifest's declared capability namespaces. */
  requires?: readonly string[]
}

export interface VerifyPackageResult {
  /** The computed (and now trusted) sha256 hex digest. */
  digest: string
  /** Effective trust tier after verification. */
  trustTier: TrustTier
  /** Declared sensitive capabilities the UI must warn about before install. */
  sensitive: string[]
}

/**
 * Run the full pre-unpack verification chain. Throws {@link PluginVerifyError}
 * on the first failure; on success returns the trusted digest, effective trust
 * tier, and the sensitive-capability set the UI should gate on.
 *
 * Policy:
 *   - digest mismatch                     → always blocks (`DIGEST_MISMATCH`).
 *   - signature + key present, verify OK  → `signed-verified`.
 *   - signature + key present, verify BAD → blocks (`SIGNATURE_INVALID`).
 *   - no signature material               → not blocked; trust tier falls back
 *     to the registry's recorded tier (or `unsigned`), surfaced to the user.
 *   - unknown capability in `requires`    → blocks (`CAP_UNKNOWN`).
 */
export function verifyPackage(input: VerifyPackageInput): VerifyPackageResult {
  const requires = input.requires ?? []
  assertKnownCapabilities(requires)

  const digest = sha256Hex(input.bytes)
  if (digest !== input.expectedDigest) {
    throw new PluginVerifyError(
      'DIGEST_MISMATCH',
      `package digest ${digest} does not match expected ${input.expectedDigest}`
    )
  }

  let trustTier: TrustTier
  const hasMaterial = Boolean(input.signature && input.publicKey)
  if (hasMaterial) {
    if (!verifyEd25519(digest, input.signature, input.publicKey)) {
      throw new PluginVerifyError(
        'SIGNATURE_INVALID',
        'package signature failed Ed25519 verification against the publisher key'
      )
    }
    trustTier = TRUST_SIGNED
  } else {
    trustTier = input.claimedTrustTier === TRUST_SIGNED ? TRUST_SIGNED : TRUST_UNSIGNED
  }

  return { digest, trustTier, sensitive: sensitiveCapabilities(requires) }
}
