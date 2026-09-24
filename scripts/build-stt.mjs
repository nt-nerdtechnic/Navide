// Build the local speech-to-text sidecar: build/stt/navide-stt[.exe].
//
// electron-builder packages build/stt/ into <resources>/bin/ on every
// platform; the backend spawns it for push-to-talk voice input (see
// native/navide-stt/). Voice input is optional, so by default this script
// never fails: without cargo/cmake, or when the build breaks, it warns, leaves
// build/stt/ in place (possibly empty) and exits 0 — the packaged app then
// reports the feature as unavailable. Set NAVIDE_STT_REQUIRED=1 to make any
// failure fatal (release jobs that must ship the sidecar).
//
// Compiling whisper.cpp takes minutes, so the build is skipped while the
// staged binary is newer than every crate source.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'navide-stt')
const outDir = join(root, 'build', 'stt')
const binName = process.platform === 'win32' ? 'navide-stt.exe' : 'navide-stt'
const staged = join(outDir, binName)
const required = process.env.NAVIDE_STT_REQUIRED === '1'

function giveUp(message) {
  if (required) {
    console.error(`[stt] ${message} (NAVIDE_STT_REQUIRED=1)`)
    process.exit(1)
  }
  console.warn(`[stt] WARNING: ${message}; voice input will be unavailable in this build`)
  process.exit(0)
}

function newestMtime(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)))
  }
  return newest
}

mkdirSync(outDir, { recursive: true })

const sources = ['Cargo.toml', 'Cargo.lock', 'portable.cmake', 'src']
  .map((name) => join(crate, name))
  .filter((path) => existsSync(path))
if (existsSync(staged) && statSync(staged).mtimeMs > Math.max(...sources.map(newestMtime))) {
  console.log(`[stt] ${staged} is up to date; skipping`)
  process.exit(0)
}

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
if (probe.error || probe.status !== 0) giveUp('cargo not found')

const args = ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml')]
if (existsSync(join(crate, 'Cargo.lock'))) args.push('--locked')
const build = spawnSync('cargo', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    // whisper-rs-sys forwards CMAKE_* env vars to CMake as -D definitions;
    // this one turns off ggml's host-specific -march=native (see the file).
    CMAKE_PROJECT_INCLUDE_BEFORE: join(crate, 'portable.cmake').replaceAll('\\', '/'),
  },
})
if (build.error || build.status !== 0) giveUp('cargo build failed')

copyFileSync(join(crate, 'target', 'release', binName), staged)
chmodSync(staged, 0o755)
console.log(`[stt] built ${staged}`)
