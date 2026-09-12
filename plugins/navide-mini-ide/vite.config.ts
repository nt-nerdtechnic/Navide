import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../..')
const packageRoot = resolve(__dirname)
const frontendRoot = resolve(packageRoot, 'frontend')
const outputRoot = process.env.NAVIDE_MINI_IDE_DIST_DIR
  ? resolve(process.env.NAVIDE_MINI_IDE_DIST_DIR)
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
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'))
    manifest.version = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).version
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
  resolve: {
    // These source mappings correspond exactly to published package exports.
    // The separate packed-consumer gate verifies their external delivery.
    alias: [
      { find: '@navide/navide-git/composition', replacement: resolve(repositoryRoot, 'plugins/navide-git/src/composition.ts') },
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/editor', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/editor/index.ts') },
      { find: '@navide/plugin-ui/shared', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/index.ts') },
      { find: '@navide/plugin-sdk', replacement: resolve(repositoryRoot, 'packages/plugin-sdk/src/index.ts') },
      { find: '@navide/plugin-contracts', replacement: resolve(repositoryRoot, 'packages/plugin-contracts/src/index.ts') },
    ],
  },
  build: {
    outDir: resolve(outputRoot, 'frontend'),
    emptyOutDir: true,
    rollupOptions: { input: { window: resolve(frontendRoot, 'window/index.html') } },
  },
})
