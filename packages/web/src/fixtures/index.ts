/**
 * Fixtures: the scripted backend the UI is built and tested against.
 *
 * Import everything from here (`@/fixtures`), in case files too. Do not
 * import a case file directly: look it up with `getFixture(id)`. The
 * registry below must stay the last export, because case files import `fx`
 * from this module while the registry is loading them.
 */
export { fx, ConversationBuilder, isBuilt, withThroughSeq } from './builder'
export type * from './builder'
export { createFixtureBackend } from './fixture-backend'
export type { Fixture, FixtureBackend, FixtureResponse, FixtureStep } from './types'

export { fixtures, getFixture } from './registry'
