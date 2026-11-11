import type { Fixture } from './types'

/**
 * Every case under `./cases/`, found by glob: a case file default-exports
 * one `Fixture` whose `id` equals its file name. Nobody adds a registry line.
 */
const modules = import.meta.glob<{ default: Fixture }>('./cases/*.ts', { eager: true })

function load(): Fixture[] {
  const found: Fixture[] = []
  for (const [path, module] of Object.entries(modules)) {
    const fileName = path.slice(path.lastIndexOf('/') + 1).replace(/\.ts$/, '')
    if (fileName.endsWith('.test')) continue
    const fixture = module.default
    if (!fixture || typeof fixture.id !== 'string') {
      throw new Error(`Fixture case ${path} must default-export a Fixture`)
    }
    if (fixture.id !== fileName) {
      throw new Error(`Fixture case ${path} has id "${fixture.id}"; it must equal its file name`)
    }
    found.push(fixture)
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** All fixtures, by ID order. */
export const fixtures: readonly Fixture[] = load()

export function getFixture(id: string): Fixture | undefined {
  return fixtures.find((fixture) => fixture.id === id)
}
