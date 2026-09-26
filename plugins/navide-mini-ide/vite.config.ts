import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const packageRoot = resolve(__dirname)
const repositoryRoot = resolve(packageRoot, '../..')
const frontendRoot = resolve(packageRoot, 'frontend')
const sourceManifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'))
const artifactVersion = process.env.NAVIDE_PLUGIN_ARTIFACT_VERSION
  ?? (existsSync(resolve(repositoryRoot, 'package.json'))
    // The repository build stamps the root app version; an external consumer
    // that copies this config has no root package.json and keeps its own.
    ? JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).version
    : sourceManifest.version)
if (typeof artifactVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(artifactVersion)) {
  throw new Error('NAVIDE_PLUGIN_ARTIFACT_VERSION must be strict semver')
}
const outputRoot = process.env.NAVIDE_MINI_IDE_DIST_DIR
  ? (() => {
      if (!isAbsolute(process.env.NAVIDE_MINI_IDE_DIST_DIR)) throw new Error('NAVIDE_MINI_IDE_DIST_DIR must be absolute')
      return resolve(process.env.NAVIDE_MINI_IDE_DIST_DIR)
    })()
  : resolve(repositoryRoot, 'dist-plugins/navide-mini-ide')
function outputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? outputFiles(resolve(directory, entry.name)).map((file) => `${entry.name}/${file}`)
      : [entry.name]
  )).sort()
}

const emitManifest: Plugin = {
  name: 'emit-navide-mini-ide-manifest',
  closeBundle() {
    const manifest = { ...sourceManifest, version: artifactVersion }
    mkdirSync(outputRoot, { recursive: true })
    writeFileSync(resolve(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(
      resolve(outputRoot, 'artifact-files.json'),
      `${JSON.stringify({ files: ['manifest.json', ...outputFiles(resolve(outputRoot, 'frontend')).map((file) => `frontend/${file}`)] }, null, 2)}\n`,
    )
  },
}

export default defineConfig({
  root: frontendRoot,
  base: './',
  plugins: [vue(), emitManifest],
  build: {
    outDir: resolve(outputRoot, 'frontend'),
    emptyOutDir: true,
    rollupOptions: { input: { window: resolve(frontendRoot, 'window/index.html') } },
  },
})
