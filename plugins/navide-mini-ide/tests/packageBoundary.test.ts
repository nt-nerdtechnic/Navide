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
  writeFileSync,
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
  git: join(repositoryRoot, 'plugins/navide-git'),
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
    PATH: `${nodeDirectory}:${process.env.PATH ?? ''}`,
  }
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: subprocessEnvironment(),
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

function runNodeEntryOrThrow(entry: string, args: string[], cwd: string): CommandResult {
  const result = run(process.execPath, [entry, ...args], cwd)
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

function installedVersion(repository: string, packageName: string): string {
  const require = createRequire(join(repository, 'package.json'))
  const directory = resolveInstalledPackageDirectory(repository, packageName, require)
  return (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string }).version
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

function writeConsumerProject(project: string, sourceRoot: string, tarballs: Record<string, string>): void {
  const versions = {
    '@types/node': installedVersion(repositoryRoot, '@types/node'),
    '@vitejs/plugin-vue': installedVersion(repositoryRoot, '@vitejs/plugin-vue'),
    monaco: installedVersion(repositoryRoot, 'monaco-editor'),
    mermaid: installedVersion(repositoryRoot, 'mermaid'),
    typescript: installedVersion(repositoryRoot, 'typescript'),
    vite: installedVersion(repositoryRoot, 'vite'),
    vue: installedVersion(repositoryRoot, 'vue'),
    'vue-i18n': installedVersion(repositoryRoot, 'vue-i18n'),
    'vue-tsc': installedVersion(repositoryRoot, 'vue-tsc'),
    yaml: installedVersion(repositoryRoot, 'yaml'),
  }
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({
      name: 'navide-mini-ide-external-consumer',
      private: true,
      type: 'module',
      dependencies: {
        '@navide/navide-git': `file:${tarballs['@navide/navide-git']}`,
        '@navide/plugin-contracts': `file:${tarballs['@navide/plugin-contracts']}`,
        '@navide/plugin-sdk': `file:${tarballs['@navide/plugin-sdk']}`,
        '@navide/plugin-ui': `file:${tarballs['@navide/plugin-ui']}`,
        'monaco-editor': versions.monaco,
        vue: versions.vue,
        'vue-i18n': versions['vue-i18n'],
        yaml: versions.yaml,
        mermaid: versions.mermaid,
      },
      devDependencies: {
        '@types/node': versions['@types/node'],
        '@vitejs/plugin-vue': versions['@vitejs/plugin-vue'],
        typescript: versions.typescript,
        vite: versions.vite,
        'vue-tsc': versions['vue-tsc'],
      },
    }, null, 2)}\n`,
  )
  cpSync(sourceRoot, join(project, 'src'), { recursive: true })
  writeFileSync(
    join(project, 'index.html'),
    '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/index.ts"></script></body></html>\n',
  )
  writeFileSync(
    join(project, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['vite/client'],
      },
      include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts'],
    }, null, 2)}\n`,
  )
  writeFileSync(
    join(project, 'vite.config.ts'),
    `import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

function compositionBoundaryGuard(): Plugin {
  return {
    name: 'mini-ide-composition-boundary-guard',
    generateBundle() {
      const moduleIds = [...this.getModuleIds()]
      const expectedGitComponents = [
        'src/components/GitPane.vue',
        'src/editor/DiffPane.vue',
        'src/editor/BranchDiffPane.vue',
        'src/editor/ConflictPane.vue',
      ]
      const missingComponents = expectedGitComponents.filter((path) =>
        !moduleIds.some((id) => id.endsWith('/node_modules/@navide/navide-git/' + path)),
      )
      if (missingComponents.length) {
        this.error('Git composition components missing from Rollup graph:\\n' + missingComponents.join('\\n'))
      }
      const violations = moduleIds.filter((id) =>
        /[/\\\\]src[/\\\\]renderer[/\\\\]/.test(id) ||
        /[/\\\\]node_modules[/\\\\]@navide[/\\\\]navide-git[/\\\\]src[/\\\\](?:index|mount|capabilityBackend)\\.ts$/.test(id),
      )
      if (violations.length) {
        this.error('forbidden Mini-IDE module graph entries:\\n' + violations.join('\\n'))
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), compositionBoundaryGuard()],
  build: {
    outDir: ${JSON.stringify(join(project, 'dist'))},
    emptyOutDir: true,
  },
})
`,
  )
  writeFileSync(
    join(project, 'picker.html'),
    '<!doctype html><html><body><script type="module" src="/src/picker-entry.ts"></script></body></html>\n',
  )
  writeFileSync(
    join(project, 'src/picker-entry.ts'),
    `import {
  createTerminalFilePicker,
  mergePreferredPath,
  type PickerItem,
} from '@navide/plugin-ui/file-picker'

const items: PickerItem[] = [{ abs: '/workspace/main.ts', name: 'main.ts', dir: '/workspace' }]
const preferred = mergePreferredPath(items, '/workspace/main.ts', true)
const picker = createTerminalFilePicker({
  query: async () => preferred,
  onPick: () => undefined,
})
picker.close()
`,
  )
  writeFileSync(
    join(project, 'picker.vite.config.ts'),
    `import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: ${JSON.stringify(join(project, 'picker-dist'))},
    emptyOutDir: true,
    rollupOptions: {
      input: ${JSON.stringify(join(project, 'picker.html'))},
    },
  },
})
`,
  )
}

describe('navide Mini-IDE public package boundary', () => {
  it(
    'builds a copied Mini-IDE against packed public packages with portable Monaco workers',
    () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-mini-ide-external-'))
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
          '@navide/navide-git',
          '@navide/plugin-contracts',
          '@navide/plugin-sdk',
          '@navide/plugin-ui',
        ])

        writeConsumerProject(externalProject, join(repositoryRoot, 'plugins/navide-mini-ide/src'), packageTarballs)
        for (const packageName of Object.keys(packageTarballs)) {
          const installedPackage = join(externalProject, 'node_modules', packageName)
          extractPackageTarball(packageTarballs[packageName], installedPackage, externalProject)
          expect(lstatSync(installedPackage).isSymbolicLink(), packageName).toBe(false)
          expect(realpathSync(installedPackage)).not.toContain(repositoryRoot)
        }

        const externalGitPackage = join(externalProject, 'node_modules/@navide/navide-git')
        const gitPackageJson = JSON.parse(readFileSync(join(externalGitPackage, 'package.json'), 'utf8')) as {
          imports?: Record<string, string>
          exports?: Record<string, unknown>
        }
        expect(gitPackageJson.exports).toHaveProperty('./composition', './src/composition.ts')
        expect(gitPackageJson.imports).toMatchObject({ '#git-feature': './src/git-feature/index.ts' })
        expect(existsSync(join(externalGitPackage, 'src/git-feature/index.ts'))).toBe(true)

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
        runNodeEntryOrThrow(viteCli, ['build', '--config', join(externalProject, 'vite.config.ts')], externalProject)
        runNodeEntryOrThrow(
          viteCli,
          ['build', '--config', join(externalProject, 'picker.vite.config.ts')],
          externalProject,
        )

        const pickerDistFiles = collectFiles(join(externalProject, 'picker-dist'))
        const pickerJavaScript = pickerDistFiles
          .filter((path) => path.endsWith('.js'))
          .map((path) => readFileSync(path, 'utf8'))
          .join('\n')
        expect(pickerJavaScript).toContain('term-file-picker-root')
        expect(pickerJavaScript).toContain('Search files...')
        expect(pickerJavaScript).toContain('/workspace/main.ts')
        for (const forbiddenModule of [
          'SafeAiCliPanel',
          'MiniIdeApp',
          'EditorPane',
          'AiCliTerminal',
          'terminalInput',
        ]) {
          expect(pickerJavaScript, forbiddenModule).not.toContain(forbiddenModule)
        }

        rmSync(externalGitPackage, { recursive: true, force: true })
        expect(existsSync(externalGitPackage)).toBe(false)
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
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
