import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
    // A newer pnpm re-verifies the workspace before `run` and can replace
    // node_modules on a config mismatch.
    npm_config_verify_deps_before_run: 'false',
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
  }
  // Vitest sets NODE_ENV=test in this process. Inherited, it makes Vite and
  // @vitejs/plugin-vue emit a development build of plugin-ui that differs from
  // what `pnpm run build:public-packages` produces — and the Plans build ID
  // hashes these dists, so an artifact built before the run no longer matched.
  delete env.NODE_ENV
  return execFileSync(invocation.command, [...invocation.prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
    env,
  })
}

export function missingArtifactInputs(root: string): string[] {
  return [
    ...builtPackages.map((directory) => `${directory}/dist/index.js`),
    'packages/plugin-ui/dist/editor/index.js',
    'dist-plugins/navide-mini-ide/manifest.json',
    'dist-plugins/navide-mini-ide/frontend/window/index.html',
  ].filter((file) => !existsSync(join(root, file)))
}

export default function setup(project: TestProject): () => void {
  // CI has just run the unconditional application build in this same job.
  // Reuse those outputs without trusting a cache or rebuilding under Vitest's
  // NODE_ENV. A standalone artifact test prepares only the inputs it needs.
  if (process.env.NAVIDE_TEST_ARTIFACTS_PREBUILT === '1') {
    const missing = missingArtifactInputs(repositoryRoot)
    if (missing.length) throw new Error(`Prepared artifact inputs missing: ${missing.join(', ')}`)
  } else {
    pnpm(['run', 'build:public-packages'], repositoryRoot)
    pnpm(['run', 'build:mini-ide:v2'], repositoryRoot)
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
