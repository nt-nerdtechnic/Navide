import { readFileSync } from 'node:fs'

const expectedTag = process.argv[2]
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const packageVersion = packageJson.version

function capture(path, pattern, label) {
  const content = readFileSync(path, 'utf8')
  const match = content.match(pattern)
  if (!match) throw new Error(`Could not read ${label} from ${path}`)
  return match[1]
}

const versions = new Map([
  ['package.json', packageVersion],
  ['backend/pyproject.toml', capture('backend/pyproject.toml', /^version = "([^"]+)"/m, 'project version')],
  ['backend/agent_team_backend/__init__.py', capture('backend/agent_team_backend/__init__.py', /__version__ = "([^"]+)"/, 'module version')],
  ['backend/uv.lock', capture('backend/uv.lock', /name = "agent-team-backend"\nversion = "([^"]+)"/, 'locked backend version')],
])

const invalid = [...versions].filter(([, version]) => version !== packageVersion)
if (invalid.length) {
  const details = [...versions].map(([path, version]) => `${path}: ${version}`).join('\n')
  throw new Error(`Version sources are out of sync:\n${details}`)
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) {
  throw new Error(`Invalid semantic version in package.json: ${packageVersion}`)
}

if (expectedTag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedTag)) {
    throw new Error(`Release tag must use vX.Y.Z syntax: ${expectedTag}`)
  }
  if (expectedTag !== `v${packageVersion}`) {
    throw new Error(`Release tag ${expectedTag} does not match package version v${packageVersion}`)
  }
}

console.log(`Release version verified: ${packageVersion}${expectedTag ? ` (${expectedTag})` : ''}`)
