#!/usr/bin/env node
// Point the READMEs' hard-coded download links + version labels at a release
// version. release.sh runs this on every release (patch included) so the
// download point always reflects the latest version. The current version is
// discovered from an existing download URL, so no old version needs passing.
import { readFileSync, writeFileSync } from 'node:fs'

const nv = process.argv[2]
if (!nv || !/^\d+\.\d+\.\d+$/.test(nv)) {
  console.error('usage: update-readme-download-links.mjs X.Y.Z')
  process.exit(1)
}

const files = ['README.md', 'README.zh-TW.md', 'README.ja-JP.md']

const probe = readFileSync('README.md', 'utf8')
const m = probe.match(/releases\/download\/v(\d+\.\d+\.\d+)\//)
if (!m) {
  console.error('no download link found in README.md; nothing to update')
  process.exit(1)
}
const ov = m[1]
if (ov === nv) {
  console.log(`READMEs already point at v${nv}`)
  process.exit(0)
}

let total = 0
for (const f of files) {
  const s = readFileSync(f, 'utf8')
  const parts = s.split(ov)
  const n = parts.length - 1
  if (n > 0) writeFileSync(f, parts.join(nv))
  total += n
  console.log(`${f}: ${n} version reference(s) updated`)
}
console.log(`README download links: v${ov} -> v${nv} (${total} total)`)
