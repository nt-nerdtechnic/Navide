import { defineConfig } from 'vitest/config'
import baseConfig from '../../vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: undefined,
    include: ['plugins/navide-mini-ide/tests/**/*.test.ts'],
    globalSetup: ['tests/support/publicPackagesSetup.ts'],
  }
})
