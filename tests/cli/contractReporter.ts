import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Reporter, TestModule } from 'vitest/node'

export interface ContractResult {
  name: string
  state: string
  receipt: unknown
}

/** Gate on successful execution, not filenames or a declaration in a catalog.
 * The receipt is emitted only after the real contract assertions finish. */
export function missingContracts(vendors: string[], results: ContractResult[]): string[] {
  return vendors.filter((vendor) => {
    const matches = results.filter((result) => result.name === `frontend contract ${vendor}`)
    return matches.length !== 1 || matches[0].state !== 'passed' || matches[0].receipt !== vendor
  })
}

export default class CliContractReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    if (process.env.NAVIDE_CLI_COVERAGE_REQUIRED !== '1') return
    const catalog = JSON.parse(readFileSync(resolve('tests/fixtures/cli-regression/catalog.json'), 'utf8'))
    const vendors = Object.keys(catalog.vendors)
    if (!vendors.length) throw new Error('CLI coverage catalog has no vendors')
    const results = modules
      .filter((module) => module.moduleId.replaceAll('\\', '/').endsWith('/tests/cli/vendorContracts.test.ts'))
      .flatMap((module) => [...module.children.allTests()].map((test) => ({
        name: test.name, state: test.result().state, receipt: test.meta().cliContract,
      })))
    const missing = missingContracts(vendors, results)
    mkdirSync(resolve('test-results/ci'), { recursive: true })
    writeFileSync(resolve('test-results/ci/cli-contracts.json'), JSON.stringify({ vendors, results, missing }, null, 2) + '\n')
    if (missing.length) throw new Error(`CLI contracts did not execute successfully: ${missing.join(', ')}`)
  }
}
