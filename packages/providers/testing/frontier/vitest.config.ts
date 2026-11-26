import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The referent frontier sweep (`test/smoke/referent-frontier.smoke.test.ts`)
 * with the ambiguity floor settable. Run from the repository root:
 *
 *   FRONTIER_CACHE_DIR=<a directory outside the repository> \
 *     pnpm vitest run --config packages/providers/testing/frontier/vitest.config.ts --reporter=verbose --silent=false
 *
 * The only difference from `vitest.smoke.config.ts`: core's
 * `AMBIGUITY_FLOOR` constant is turned, at load time and in memory only,
 * into a binding the sweep can set (`floor.ts`). The source file is not
 * changed. Under `pnpm smoke` the same suite runs with the floor fixed and
 * leaves the floor rows out.
 */

const FROM = 'export const AMBIGUITY_FLOOR = 0.25'
const SETTER = '__pluribusFrontierSetAmbiguityFloor'
const root = path.resolve(import.meta.dirname, '../../../..')

export default defineConfig({
  root,
  plugins: [
    {
      name: 'frontier-ambiguity-floor',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!id.replaceAll('\\', '/').endsWith('/packages/core/src/routing/derive.ts')) return null
        if (!code.includes(FROM)) throw new Error(`derive.ts no longer states "${FROM}": update the frontier config`)
        return { code: code.replace(FROM, `export let AMBIGUITY_FLOOR = 0.25\n;(globalThis as Record<string, unknown>)['${SETTER}'] = (value: number) => { AMBIGUITY_FLOOR = value }`), map: null }
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['packages/providers/test/smoke/referent-frontier.smoke.test.ts'],
    testTimeout: 7_200_000,
  },
})
