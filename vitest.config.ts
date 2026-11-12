import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/{protocol,core,storage,providers}/src/**/*.test.ts'],
          exclude: ['**/*.smoke.test.ts'],
        },
      },
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'packages/web/src') } },
        define: { __DEV_OPENROUTER_KEY__: '""', __DEV_ANTHROPIC_KEY__: '""' },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['packages/web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['packages/web/src/test/setup.ts'],
        },
      },
    ],
  },
})
