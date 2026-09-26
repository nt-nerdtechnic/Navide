import { describe, expect, it } from 'vitest'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packageRoots = {
  contracts: join(repositoryRoot, 'packages/plugin-contracts'),
  sdk: join(repositoryRoot, 'packages/plugin-sdk'),
  ui: join(repositoryRoot, 'packages/plugin-ui'),
}

function packageManager(): { command: string; prefix: string[] } {
  const inherited = process.env.npm_execpath ?? ''
  const configured = process.env.NAVIDE_PNPM ?? (/pnpm/i.test(inherited) ? inherited : '')
  if (!configured) return { command: 'pnpm', prefix: [] }
  if (configured.endsWith('.js') || configured.endsWith('.cjs')) {
    return { command: process.execPath, prefix: [configured] }
  }
  return { command: configured, prefix: [] }
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath)
  return {
    ...process.env,
    CI: '1',
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
    // A newer pnpm than the repo's pinned 10.x enables verify-deps-before-run
    // by default and can wipe node_modules on a lockfile-config mismatch.
    npm_config_verify_deps_before_run: 'false',
    PATH: `${nodeDirectory}:${process.env.PATH ?? ''}`,
  }
}

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...subprocessEnvironment(), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runPnpmOrThrow(args: string[], cwd: string): CommandResult {
  const invocation = packageManager()
  const result = run(invocation.command, [...invocation.prefix, ...args], cwd)
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function runNodeEntryOrThrow(entry: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): CommandResult {
  const result = run(process.execPath, [entry, ...args], cwd, extraEnv)
  if (result.status !== 0) {
    throw new Error(`node ${entry} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function runCommandOrThrow(command: string, args: string[], cwd: string): CommandResult {
  const result = run(command, args, cwd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function resolveInstalledPackageDirectory(
  repository: string,
  packageName: string,
  require: NodeRequire,
): string {
  try {
    return dirname(realpathSync(require.resolve(`${packageName}/package.json`)))
  } catch {
    const directPackage = join(repository, 'node_modules', packageName)
    if (existsSync(join(directPackage, 'package.json'))) return realpathSync(directPackage)
    const pnpmStore = join(repository, 'node_modules', '.pnpm')
    const packageDirectory = readdirSync(pnpmStore).find((entry) =>
      entry.startsWith(`${packageName.replace('/', '+')}@`),
    )
    if (!packageDirectory) throw new Error(`Could not locate installed package ${packageName}`)
    return dirname(
      realpathSync(join(pnpmStore, packageDirectory, 'node_modules', packageName, 'package.json')),
    )
  }
}

function resolveInstalledPackageBin(
  repository: string,
  packageName: string,
  binaryName: string,
  require: NodeRequire,
): string {
  const packageDirectory = resolveInstalledPackageDirectory(repository, packageName, require)
  const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binaryName]
  if (!bin) throw new Error(`Could not locate ${binaryName} in ${packageName}`)
  return join(packageDirectory, bin)
}

function packedPath(result: CommandResult, artifacts: string, packageName: string): string {
  const reportedPath = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'))
  if (!reportedPath) throw new Error(`pnpm pack did not report a tarball for ${packageName}`)
  const path = realpathSync(isAbsolute(reportedPath) ? reportedPath : join(artifacts, reportedPath))
  expect(existsSync(path), packageName).toBe(true)
  return path
}

function extractPackageTarball(tarball: string, packageDirectory: string, cwd: string): void {
  mkdirSync(packageDirectory, { recursive: true })
  runCommandOrThrow(
    'tar',
    ['-xzf', tarball, '--strip-components=1', '-C', packageDirectory],
    cwd,
  )
}

function linkThirdPartyPackage(repository: string, consumer: string, packageName: string): void {
  if (packageName.startsWith('@navide/')) {
    throw new Error(`Refusing to symlink Navide package ${packageName}`)
  }
  const source = join(repository, 'node_modules', packageName)
  const destination = join(consumer, 'node_modules', packageName)
  expect(existsSync(source), packageName).toBe(true)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination)
  expect(lstatSync(destination).isSymbolicLink(), packageName).toBe(true)
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path)
    return entry.isFile() ? [path] : []
  })
}

function writeConsumerProject(project: string, packageRoot: string): void {
  for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'manifest.json']) {
    cpSync(join(packageRoot, file), join(project, file))
  }
  cpSync(join(packageRoot, 'frontend'), join(project, 'frontend'), { recursive: true })
  // Test sources are not part of the shipped package and would demand test-only
  // dev dependencies in the external consumer typecheck.
  cpSync(join(packageRoot, 'src'), join(project, 'src'), {
    recursive: true,
    filter: (source) => !/(?:[/\\]__tests__[/\\]|\.test\.ts$)/.test(source),
  })
}

describe('navide Mini-IDE public package boundary', () => {
  it(
    'builds a copied Mini-IDE against packed public packages with portable Monaco workers',
    () => {
      // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); vite
      // resolves inputs to the long form, so a short root puts index.html outside it.
      const temporaryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-mini-ide-external-')))
      const artifacts = join(temporaryRoot, 'artifacts')
      const externalProject = join(temporaryRoot, 'consumer')
      mkdirSync(artifacts)
      mkdirSync(externalProject)
      try {
        runPnpmOrThrow(['run', 'build:public-packages'], repositoryRoot)

        const packageTarballs: Record<string, string> = {}
        for (const [key, packageDirectory] of Object.entries(packageRoots)) {
          const packageName = (JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as { name: string }).name
          const result = runPnpmOrThrow(['pack', '--pack-destination', artifacts], packageDirectory)
          packageTarballs[packageName] = packedPath(result, artifacts, key)
        }
        expect(Object.keys(packageTarballs).sort()).toEqual([
          '@navide/plugin-contracts',
          '@navide/plugin-sdk',
          '@navide/plugin-ui',
        ])

        const packageRoot = join(repositoryRoot, 'plugins/navide-mini-ide')
        writeConsumerProject(externalProject, packageRoot)
        const copiedPackageJson = JSON.parse(readFileSync(join(externalProject, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, unknown>
          devDependencies?: Record<string, unknown>
        }
        expect(copiedPackageJson.dependencies).not.toHaveProperty('@navide/navide-git')
        expect(existsSync(join(externalProject, 'node_modules/@navide/navide-git'))).toBe(false)
        expect(collectFiles(externalProject).some((path) => /[/\\]src[/\\]renderer[/\\]/.test(path))).toBe(false)
        expect(collectFiles(externalProject).some((path) => /[/\\]plugins[/\\]navide-(git|plans)[/\\]/.test(path))).toBe(false)
        for (const packageName of Object.keys(packageTarballs)) {
          const installedPackage = join(externalProject, 'node_modules', packageName)
          extractPackageTarball(packageTarballs[packageName], installedPackage, externalProject)
          expect(lstatSync(installedPackage).isSymbolicLink(), packageName).toBe(false)
          expect(realpathSync(installedPackage)).not.toContain(repositoryRoot)
        }

        for (const packageName of [
          '@types/node',
          '@vitejs/plugin-vue',
          'monaco-editor',
          'mermaid',
          'typescript',
          'vite',
          'vue',
          'vue-i18n',
          'vue-tsc',
          'yaml',
        ]) {
          linkThirdPartyPackage(repositoryRoot, externalProject, packageName)
        }

        const externalRequire = createRequire(join(externalProject, 'package.json'))
        const vueTscCli = resolveInstalledPackageBin(externalProject, 'vue-tsc', 'vue-tsc', externalRequire)
        runNodeEntryOrThrow(vueTscCli, ['--noEmit', '--project', join(externalProject, 'tsconfig.json')], externalProject)

        const viteCli = resolveInstalledPackageBin(externalProject, 'vite', 'vite', externalRequire)
        runNodeEntryOrThrow(viteCli, ['build', '--config', join(externalProject, 'vite.config.ts')], externalProject, {
          NAVIDE_MINI_IDE_DIST_DIR: join(externalProject, 'dist'),
        })

        const distFiles = collectFiles(join(externalProject, 'dist'))
        const workerFiles = distFiles.filter((path) => /(?:editor|ts|json|css|html)\.worker-[^/]+\.js$/.test(path))
        const workerPrefixes = ['editor.worker-', 'ts.worker-', 'json.worker-', 'css.worker-', 'html.worker-']
        for (const workerPrefix of workerPrefixes) {
          expect(workerFiles.some((path) => path.includes(workerPrefix)), workerPrefix).toBe(true)
        }
        expect(workerFiles.length).toBeGreaterThanOrEqual(5)

        const builtJavaScript = distFiles
          .filter((path) => path.endsWith('.js'))
          .map((path) => readFileSync(path, 'utf8'))
          .join('\n')
        expect(builtJavaScript.length).toBeGreaterThan(0)
        expect(builtJavaScript).not.toContain('src/renderer')
        expect(builtJavaScript).not.toContain('capabilityBackend')
        expect(builtJavaScript).not.toContain('GitWindowApp')
        expect(builtJavaScript).not.toMatch(/(?:from|import)\s*['"][^'"]*navide-git/)
        // No copied Git product code: the IDE asks the Git plugin for its
        // surfaces, so the Git feature's own transport inventory — the request
        // literals only that implementation emits — must not ship here. The
        // IDE's own reads (`git.status`, `git.branches`) stay out of this list
        // because they are part of its explorer and review affordances.
        for (const gitFeatureRequest of [
          'git.compare_branches',
          'git.list_conflicts',
          'git.mark_resolved',
          'git.stash_pop',
          'git.diff_blame',
          'resolveTheirs',
        ]) {
          expect(builtJavaScript, gitFeatureRequest).not.toContain(gitFeatureRequest)
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
