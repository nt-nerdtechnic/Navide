import { run, testEnvironment } from './test-process.mjs'

run(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--project', 'cli',
  '--reporter=default', '--reporter=./tests/cli/contractReporter.ts',
], testEnvironment({ NAVIDE_CLI_COVERAGE_REQUIRED: '1' }))
if (!process.argv.includes('--frontend-only')) {
  run('uv', ['--project', 'backend', 'run', '--locked', 'pytest', 'backend/tests', '-m', 'cli_regression'])
}
