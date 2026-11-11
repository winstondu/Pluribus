import { defineConfig } from 'vitest/config'

// Live smoke suite: a small number of real OpenRouter calls. Needs OPENROUTER_KEY in the environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.smoke.test.ts'],
    testTimeout: 120_000,
  },
})
