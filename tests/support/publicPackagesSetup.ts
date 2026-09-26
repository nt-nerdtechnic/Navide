import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

// Vitest globalSetup. The tests that consume the public packages — as packed
// tarballs, or as dists a real Vite build resolves — used to run
// `build:public-packages` themselves. Its plugin-ui step empties
// packages/plugin-ui/dist (emptyOutDir), so in a parallel run one file's
// rebuild broke another file's build. Build and pack once here, before any
// worker starts; the tests only read the result.

declare module 'vitest' {
  export interface ProvidedContext {
    // Package name -> absolute path of its packed tarball. Read-only: shared by
    // every test file in the run.
    publicPackageTarballs: Record<string, string>
  }
}

const repositoryRoot = resolve(import.meta.dirname, '../..')
const builtPackages = ['packages/plugin-contracts', 'packages/plugin-sdk', 'packages/plugin-ui']
const packedPackages = [...builtPackages, 'plugins/navide-git']
const stampFile = join(repositoryRoot, 'node_modules/.cache/navide-public-packages.stamp')

function packageManager(): { command: string; prefix: string[] } {
  // `pnpm` alone is a .cmd shim on Windows that execFile cannot start; under
  // `pnpm test:run` npm_execpath is pnpm's own script.
  const inherited = process.env.npm_execpath ?? ''
  const configured = process.env.NAVIDE_PNPM ?? (/pnpm/i.test(inherited) ? inherited : '')
  if (!configured) return { command: 'pnpm', prefix: [] }
  if (configured.endsWith('.js') || configured.endsWith('.cjs')) {
    return { command: process.execPath, prefix: [configured] }
  }
  return { command: configured, prefix: [] }
}

function pnpm(args: string[], cwd: string): string {
  const invocation = packageManager()
  return execFileSync(invocation.command, [...invocation.prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      CI: '1',
      PNPM_CONFIG_PM_ON_FAIL: 'ignore',
      // A newer pnpm re-verifies the workspace before `run` and can replace
      // node_modules on a config mismatch.
      npm_config_verify_deps_before_run: 'false',
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
}

function inputDigest(): string {
  const hash = createHash('sha256')
  const add = (path: string): void => {
    hash.update(`${relative(repositoryRoot, path)}\0`).update(readFileSync(path)).update('\0')
  }
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) add(path)
    }
  }
  for (const packageDirectory of builtPackages) walk(join(repositoryRoot, packageDirectory))
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.web.json']) add(join(repositoryRoot, file))
  return hash.digest('hex')
}

function distsPresent(): boolean {
  return builtPackages.every((packageDirectory) => {
    const dist = join(repositoryRoot, packageDirectory, 'dist')
    return existsSync(dist) && readdirSync(dist).length > 0
  })
}

export default function setup(project: TestProject): () => void {
  // Skipping an unchanged build keeps a single-file `pnpm test:run` fast; the
  // stamp is removed first so an interrupted build is never trusted.
  const digest = inputDigest()
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : ''
  if (stamp !== digest || !distsPresent()) {
    rmSync(stampFile, { force: true })
    pnpm(['run', 'build:public-packages'], repositoryRoot)
    mkdirSync(dirname(stampFile), { recursive: true })
    writeFileSync(stampFile, digest)
  }

  // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); tools
  // downstream resolve to the long form.
  const artifacts = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-public-packages-')))
  const tarballs: Record<string, string> = {}
  for (const packageDirectory of packedPackages) {
    const source = join(repositoryRoot, packageDirectory)
    const name = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }).name
    // One directory per package, so the tarball is found by listing it rather
    // than by parsing pack output, which differs between pnpm and npm.
    const destination = join(artifacts, packageDirectory.replaceAll('/', '_'))
    mkdirSync(destination)
    pnpm(['pack', '--pack-destination', destination], source)
    const packed = readdirSync(destination).filter((file) => file.endsWith('.tgz'))
    if (packed.length !== 1) throw new Error(`pnpm pack wrote ${packed.length} tarballs for ${name}`)
    tarballs[name] = join(destination, packed[0])
  }
  project.provide('publicPackageTarballs', tarballs)

  return () => rmSync(artifacts, { recursive: true, force: true })
}
