#!/usr/bin/env node

import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packageRoot = join(projectRoot, 'dist', 'package')
mkdirSync(join(packageRoot, 'frontend'), { recursive: true })
cpSync(join(projectRoot, 'manifest.json'), join(packageRoot, 'manifest.json'))
cpSync(join(projectRoot, 'index.html'), join(packageRoot, 'frontend', 'index.html'))

const frontendFiles = readdirSync(join(packageRoot, 'frontend'), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `frontend/${entry.name}`)
  .sort()
writeFileSync(
  join(packageRoot, 'artifact-files.json'),
  `${JSON.stringify({ files: ['manifest.json', ...frontendFiles] }, null, 2)}\n`,
)
