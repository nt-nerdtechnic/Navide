import { readFileSync, writeFileSync } from 'node:fs'

const requestedVersion = process.argv[2]
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

if (!requestedVersion || !semverPattern.test(requestedVersion)) {
  throw new Error('Usage: node scripts/set-release-version.mjs X.Y.Z')
}

const packagePath = 'package.json'
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const currentVersion = packageJson.version

function parts(version) {
  const match = semverPattern.exec(version)
  if (!match) throw new Error(`Invalid current version: ${version}`)
  return match.slice(1).map(BigInt)
}

function compareVersions(left, right) {
  const leftParts = parts(left)
  const rightParts = parts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

if (compareVersions(requestedVersion, currentVersion) <= 0) {
  throw new Error(`Release version ${requestedVersion} must be newer than ${currentVersion}`)
}

function replaceExactly(path, pattern, replacement) {
  const content = readFileSync(path, 'utf8')
  const matches = content.match(pattern)
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one version field in ${path}`)
  }
  writeFileSync(path, content.replace(pattern, replacement))
}

packageJson.version = requestedVersion
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
replaceExactly(
  'backend/pyproject.toml',
  /^version = "[^"]+"$/gm,
  `version = "${requestedVersion}"`,
)
replaceExactly(
  'backend/agent_team_backend/__init__.py',
  /^__version__ = "[^"]+"$/gm,
  `__version__ = "${requestedVersion}"`,
)

console.log(`Updated release version: ${currentVersion} -> ${requestedVersion}`)
