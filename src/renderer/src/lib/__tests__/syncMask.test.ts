import { describe, expect, it } from 'vitest'
import { MASK, maskArgs, maskMcpRecord, maskUrl } from '../syncMask'

// The 38 inputs from the D1/D2 security review (sec-review/D/mask.mjs). Each
// names the secret that must not survive; markers like S1 are matched as a
// whole token so S1 does not pass by hiding inside S10.
function leaks(output: string, secret: string): boolean {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![0-9])`).test(output)
}

const URLS: Array<[string, string]> = [
  ['https://user:tok@host/x', 'tok'],
  ['https://tok@host/x', 'tok'],
  ['https://host/x?api_key=S1&b=2', 'S1'],
  ['https://host/x#access_token=S2', 'S2'],
  ['https://host/mcp/S3secretpath', 'S3secretpath'],
  ['https://host/x;token=S4', 'S4'],
  ['https://a:b@c@host/x', 'b@c'],
  ['HTTPS://u:S5@h/', 'S5'],
]

const ARGS: Array<[string[], string | null]> = [
  [['-y', 'mcp-remote', 'https://host/sse?token=S6'], 'S6'],
  [['-y', 'mcp-remote', 'https://u:S7@host/sse'], 'S7'],
  [['--header', 'X-API-Key: S8'], 'S8'],
  [['-H', 'X-Api-Key:S9'], 'S9'],
  [['--header', 'Cookie: session=S10'], 'S10'],
  [['--pat', 'S11'], 'S11'],
  [['-k', 'S12'], 'S12'],
  [['--credentials', 'S13'], 'S13'],
  [['--api-key', 'S14', '--model', 'x'], 'S14'],
  [['--token=S15'], 'S15'],
  [['GITHUB_PERSONAL_ACCESS_TOKEN=S16'], 'S16'],
  [['--url=https://host/?x=S17'], 'S17'],
  [['--connection-string', 'postgres://u:S18@db/x'], 'S18'],
  [['postgres://u:S19@db/x'], 'S19'],
  [['--header', 'Authorization:Basic S20'], 'S20'],
  [['--header=Authorization: Bearer S21'], 'S21'],
  [['Authorization', 'Bearer S22'], 'S22'],
  [['--header', 'Proxy-Authorization: S23'], 'S23'],
  [['ghp_S24abcdefghijklmnopqrstuvwxyz0123456789'], 'S24'],
  [['--api-key', '--verbose', 'S25'], 'S25'],
  [['--key-file', '/path'], null],
  [['--access_token', 'S26'], 'S26'],
  [['--Token', 'S27'], 'S27'],
  [['-e', 'API_KEY=S28'], 'S28'],
  [['--env', 'OPENAI_API_KEY', 'S29'], 'S29'],
  [['--db', 'mysql://root:S30@h'], 'S30'],
  [['--sig=S31'], 'S31'],
  [['--client-secret', 'S32'], 'S32'],
  [['--header', 'x-goog-api-key: S33'], 'S33'],
  [['--password'], null],
]

describe('maskUrl', () => {
  it.each(URLS)('masks the secret in %s', (url, secret) => {
    const out = maskUrl(url)
    expect(leaks(out, secret)).toBe(false)
    expect(out).toContain(MASK)
  })

  it('keeps scheme, host and an ordinary path readable', () => {
    expect(maskUrl('https://api.example.com/v1/sse')).toBe('https://api.example.com/v1/sse')
    expect(maskUrl('https://host/x?api_key=S1&b=2')).toContain('api_key=')
  })
})

describe('maskArgs', () => {
  it.each(ARGS)('masks the secret in %j', (args, secret) => {
    const out = maskArgs(args)
    expect(out).toHaveLength(args.length)
    const text = JSON.stringify(out)
    if (secret) expect(leaks(text, secret)).toBe(false)
  })

  it('masks bare token shapes wherever they appear', () => {
    const bare = [
      'gho_abcdefghijklmnop1234',
      'github_pat_11ABCDEFG0123456789_abcdefghijk',
      'sk-proj-abcdefghij1234567890',
      'xoxb-1234567890-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      '0123456789abcdef0123456789abcdef',
      'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=',
    ]
    for (const token of bare) {
      expect(JSON.stringify(maskArgs([token]))).not.toContain(token.slice(4, 14))
      expect(JSON.stringify(maskArgs([`--foo=${token}`]))).not.toContain(token.slice(4, 14))
    }
  })

  it('keeps an ordinary command line readable', () => {
    expect(maskArgs(['-y', '@modelcontextprotocol/server-github', '--model', 'x', '--verbose'])).toEqual([
      '-y',
      '@modelcontextprotocol/server-github',
      '--model',
      'x',
      '--verbose',
    ])
    expect(maskArgs(['--env', 'OPENAI_API_KEY', 'S29'])[1]).toBe('OPENAI_API_KEY')
  })
})

describe('maskMcpRecord', () => {
  it('masks env and header values but keeps their names', () => {
    const out = maskMcpRecord({ env: { TOKEN: 'v1' }, headers: { 'X-Key': 'v2' } }) as Record<string, unknown>
    expect(out.env).toEqual({ TOKEN: MASK })
    expect(out.headers).toEqual({ 'X-Key': MASK })
  })
})
