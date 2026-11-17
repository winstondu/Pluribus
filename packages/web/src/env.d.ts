/** OpenRouter key from the dev server's environment (`OPENROUTER_KEY`). Empty in production builds. */
declare const __DEV_OPENROUTER_KEY__: string
declare const __DEV_ANTHROPIC_KEY__: string
/** The git commit and time this client was built from (`vite.config.ts`). */
declare const __BUILD__: { commit: string; branch: string; dirty: boolean; builtAt: string }

interface ImportMetaEnv {
  /** `1` keeps `?fixture=<id>` and `?fixtures` available in a production build. */
  readonly VITE_FIXTURES?: string
}

interface Window {
  /** The fixture backend of a page opened with `?fixture=<id>`, for the gallery's stepper and for e2e tests. */
  __pluribusFixture?: import('./fixtures/types').FixtureBackend
}
