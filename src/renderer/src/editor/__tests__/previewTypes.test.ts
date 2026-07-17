// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { buildPageUrl, previewKind } from '../previewTypes'

describe('previewKind – wave 2 kinds', () => {
  it('classifies .ipynb as notebook and .docx/.xlsx as office (over the binary fallback)', () => {
    expect(previewKind('nb/analysis.ipynb')).toBe('notebook')
    expect(previewKind('docs/report.docx')).toBe('office')
    expect(previewKind('docs/data.xlsx')).toBe('office')
    // Other office-ish extensions still fall back to the binary card.
    expect(previewKind('docs/slides.pptx')).toBe('binary')
  })
})

describe('buildPageUrl', () => {
  it('builds /fs/page/{ws_b64}/{rel} with unpadded URL-safe base64', () => {
    expect(buildPageUrl('http://127.0.0.1:8123', '/ws', 'site/index.html')).toBe(
      'http://127.0.0.1:8123/fs/page/L3dz/site/index.html',
    )
  })

  it('encodes non-ASCII workspace paths as UTF-8, matching python urlsafe_b64encode', () => {
    // python: base64.urlsafe_b64encode('/Users/dev/客戶名單'.encode()).rstrip(b'=')
    expect(buildPageUrl('http://h', '/Users/dev/客戶名單', 'index.html')).toBe(
      'http://h/fs/page/L1VzZXJzL2Rldi_lrqLmiLblkI3llq4/index.html',
    )
    // python: base64.urlsafe_b64encode('/tmp/專案 空格'.encode()).rstrip(b'=')
    expect(buildPageUrl('http://h', '/tmp/專案 空格', 'a.html')).toBe(
      'http://h/fs/page/L3RtcC_lsIjmoYgg56m65qC8/a.html',
    )
  })

  it('percent-encodes rel path segments while keeping slashes, and trims the base', () => {
    expect(buildPageUrl('http://h/', '/ws', 'sub dir/頁面.html')).toBe(
      'http://h/fs/page/L3dz/sub%20dir/%E9%A0%81%E9%9D%A2.html',
    )
  })
})
