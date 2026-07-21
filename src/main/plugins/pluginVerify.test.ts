import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import {
  sha256Hex,
  verifyEd25519,
  assertKnownCapabilities,
  assertSafeEntryPath,
  sensitiveCapabilities,
  verifyPackage,
  PluginVerifyError,
  TRUST_SIGNED,
  TRUST_UNSIGNED,
} from './pluginVerify'

/** An Ed25519 keypair + a detached base64 signature over a hex digest, mirroring
 *  the registry's `sign_digest`. */
function signDigest(digest: string): {
  publicKey: string
  privateKey: string
  signature: string
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const signature = edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
  return { publicKey: pubPem, privateKey: '', signature }
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5])
const DIGEST = sha256Hex(BYTES)

describe('sha256Hex', () => {
  it('matches a known sha256', () => {
    expect(sha256Hex(new Uint8Array([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })
})

describe('verifyEd25519', () => {
  it('accepts a valid signature over the digest', () => {
    const { publicKey, signature } = signDigest(DIGEST)
    expect(verifyEd25519(DIGEST, signature, publicKey)).toBe(true)
  })

  it('rejects a signature over a different digest', () => {
    const { publicKey, signature } = signDigest(DIGEST)
    expect(verifyEd25519('deadbeef', signature, publicKey)).toBe(false)
  })

  it('returns false (not throw) for missing or malformed material', () => {
    expect(verifyEd25519(DIGEST, null, null)).toBe(false)
    expect(verifyEd25519(DIGEST, 'not-base64!!', 'not-a-pem')).toBe(false)
  })
})

describe('assertKnownCapabilities', () => {
  it('accepts the known set including issues', () => {
    expect(() => assertKnownCapabilities(['fs', 'git', 'issues'])).not.toThrow()
  })

  it('rejects an unknown namespace (scope over-reach)', () => {
    try {
      assertKnownCapabilities(['fs', 'network'])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginVerifyError)
      expect((err as PluginVerifyError).code).toBe('CAP_UNKNOWN')
    }
  })
})

describe('assertSafeEntryPath (zip-slip)', () => {
  it('accepts normal nested paths', () => {
    expect(() => assertSafeEntryPath('dist/mini-ide.js')).not.toThrow()
    expect(() => assertSafeEntryPath('manifest.json')).not.toThrow()
  })

  it.each([
    '../escape.js',
    'a/../../etc/passwd',
    '/abs/path',
    '\\windows\\path',
    'C:/win',
    '',
  ])('rejects unsafe path %j', (p) => {
    try {
      assertSafeEntryPath(p)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginVerifyError)
      expect((err as PluginVerifyError).code).toBe('ZIP_SLIP')
    }
  })
})

describe('sensitiveCapabilities', () => {
  it('flags fs/terminal only', () => {
    expect(sensitiveCapabilities(['fs', 'git', 'terminal', 'ui'])).toEqual(['fs', 'terminal'])
    expect(sensitiveCapabilities(['git', 'search'])).toEqual([])
  })
})

describe('verifyPackage policy', () => {
  it('blocks a forged/mismatched digest', () => {
    try {
      verifyPackage({ bytes: BYTES, expectedDigest: 'f'.repeat(64) })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as PluginVerifyError).code).toBe('DIGEST_MISMATCH')
    }
  })

  it('returns signed-verified for a valid signature', () => {
    const { publicKey, signature } = signDigest(DIGEST)
    const res = verifyPackage({
      bytes: BYTES,
      expectedDigest: DIGEST,
      signature,
      publicKey,
      requires: ['fs'],
    })
    expect(res.trustTier).toBe(TRUST_SIGNED)
    expect(res.sensitive).toEqual(['fs'])
  })

  it('blocks when signature material is present but verification fails', () => {
    const { publicKey } = signDigest(DIGEST)
    const wrong = signDigest(DIGEST) // signature from a different key
    try {
      verifyPackage({
        bytes: BYTES,
        expectedDigest: DIGEST,
        signature: wrong.signature,
        publicKey, // mismatched key → verify fails
      })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as PluginVerifyError).code).toBe('SIGNATURE_INVALID')
    }
  })

  it('does NOT block an unsigned package, marking it unsigned', () => {
    const res = verifyPackage({ bytes: BYTES, expectedDigest: DIGEST, requires: ['git'] })
    expect(res.trustTier).toBe(TRUST_UNSIGNED)
  })

  it('consumes the registry tier when no material is available to re-verify', () => {
    const res = verifyPackage({
      bytes: BYTES,
      expectedDigest: DIGEST,
      claimedTrustTier: TRUST_SIGNED,
    })
    expect(res.trustTier).toBe(TRUST_SIGNED)
  })

  it('blocks an unknown capability before any trust decision', () => {
    try {
      verifyPackage({ bytes: BYTES, expectedDigest: DIGEST, requires: ['fs', 'network'] })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as PluginVerifyError).code).toBe('CAP_UNKNOWN')
    }
  })
})
