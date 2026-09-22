#!/usr/bin/env node
// Join the Windows arm64 installer into the x64 update manifest.
//
// Windows is the one platform electron-builder gives no per-arch update
// manifest: app-builder-lib suffixes the file name by architecture for Linux
// only, so `latest-linux-arm64.yml` exists but `latest-win-arm64.yml` does
// not — both Windows arches write a file called `latest.yml`. electron-updater
// asks for that single name and then picks the installer whose URL contains
// `process.arch`, so one manifest has to list both installers; publishing the
// second job's file on top of the first would instead leave one architecture
// updating itself with the other's binary.
//
// The two builds happen on two runners (PyInstaller cannot cross-compile), so
// the manifests can only be combined after the fact. This splices the arm64
// `files:` entries into the x64 manifest verbatim, leaving its `path:` and
// `sha512:` — the pre-2.15 electron-updater fallback, which has no notion of
// architecture — pointing at x64, the majority build.
//
// Usage: node scripts/merge-windows-update-manifest.mjs <base.yml> <extra.yml> <out.yml>

import { readFileSync, writeFileSync } from 'node:fs'

function fail(message) {
  console.error(message)
  process.exit(1)
}

// The `files:` block runs from the top-level `files:` key to the next line that
// starts in column zero; every entry line under it is indented.
function splitOnFiles(text, label) {
  const lines = text.split('\n')
  const start = lines.indexOf('files:')
  if (start < 0) fail(`${label}: no top-level 'files:' key`)
  let end = start + 1
  while (end < lines.length && lines[end].startsWith(' ')) end += 1
  const entries = lines.slice(start + 1, end)
  const urls = entries.filter((line) => line.trimStart().startsWith('- url:'))
  if (urls.length === 0) fail(`${label}: 'files:' lists nothing`)
  return { lines, end, entries, urls }
}

function versionOf(text, label) {
  const line = text.split('\n').find((l) => l.startsWith('version: '))
  if (!line) fail(`${label}: no top-level 'version:' key`)
  return line.slice('version: '.length).trim()
}

const [basePath, extraPath, outPath] = process.argv.slice(2)
if (!basePath || !extraPath || !outPath) {
  console.error('usage: node scripts/merge-windows-update-manifest.mjs <base.yml> <extra.yml> <out.yml>')
  process.exit(2)
}

// Normalised line endings: this runs on Windows, and a manifest that arrived
// with CRLF would leave a stray \r on every key and match nothing below.
const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const baseText = read(basePath)
const extraText = read(extraPath)

const baseVersion = versionOf(baseText, basePath)
const extraVersion = versionOf(extraText, extraPath)
if (baseVersion !== extraVersion) {
  fail(`version mismatch: ${basePath} is ${baseVersion}, ${extraPath} is ${extraVersion}`)
}

const base = splitOnFiles(baseText, basePath)
const extra = splitOnFiles(extraText, extraPath)

const seen = new Set(base.urls.map((line) => line.trim()))
const added = extra.urls.filter((line) => !seen.has(line.trim()))
if (added.length === 0) {
  fail(`${extraPath} adds no installer ${basePath} does not already list`)
}

const merged = [...base.lines.slice(0, base.end), ...extra.entries, ...base.lines.slice(base.end)].join('\n')

// The splice is textual, so prove the result before writing it: every URL from
// both inputs present exactly once, and nothing else duplicated.
const mergedUrls = merged
  .split('\n')
  .filter((line) => line.trimStart().startsWith('- url:'))
  .map((line) => line.trim())
const expected = [...base.urls, ...extra.urls].map((line) => line.trim())
if (mergedUrls.length !== expected.length || new Set(mergedUrls).size !== mergedUrls.length) {
  fail(`merge produced ${mergedUrls.length} entries (${mergedUrls.join(', ')}), expected ${expected.length} distinct`)
}
for (const url of expected) {
  if (!mergedUrls.includes(url)) fail(`merge lost ${url}`)
}

writeFileSync(outPath, merged)
console.log(`${outPath}: ${mergedUrls.length} installers`)
for (const url of mergedUrls) console.log(`  ${url.replace('- url: ', '')}`)
