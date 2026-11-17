import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/{protocol,core,storage,providers}/test/**/*.test.ts'],
          exclude: ['**/*.smoke.test.ts'],
        },
      },
    ],
  },
})
