import { defineConfig } from 'vitest/config'

// Provider smoke suites can make live calls when the relevant API key is configured.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.smoke.test.ts'],
    testTimeout: 120_000,
  },
})
