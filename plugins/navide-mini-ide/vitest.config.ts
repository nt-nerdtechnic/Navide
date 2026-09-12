import { defineConfig } from 'vitest/config'
import baseConfig from '../../vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Build the staged artifact first: `pnpm build:mini-ide:v2`.
    include: ['plugins/navide-mini-ide/tests/**/*.test.ts']
  }
})
