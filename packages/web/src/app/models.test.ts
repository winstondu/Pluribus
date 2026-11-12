import { MODEL_COMPATIBILITY } from '@committee/protocol'
import { expect, test } from 'vitest'
import { BUILT_IN_MODELS, modelsForRole, roleIsListed, type ModelOption } from './models'

const LOADED: readonly ModelOption[] = [
  ...BUILT_IN_MODELS.map((model) => (model.id === 'anthropic/claude-haiku-5.5' ? { ...model, contextLength: 200_000 } : model)),
  { id: 'example/other-model', name: 'Other', provider: 'example', contextLength: 32_000 },
]

test('Q107 · the answer and decomposition selectors offer the tested compatibility list only, whatever OpenRouter lists', () => {
  for (const role of ['answer', 'decomposition'] as const) {
    expect(roleIsListed(role)).toBe(true)
    const offered = modelsForRole(role, LOADED)
    expect(offered.map((model) => model.id)).toEqual(MODEL_COMPATIBILITY.filter((model) => model.roles.includes(role)).map((model) => model.id))
    // What the loaded list knows about a listed model is kept.
    expect(offered.find((model) => model.id === 'anthropic/claude-haiku-5.5')?.contextLength).toBe(200_000)
    // With nothing loaded the list is still offered.
    expect(modelsForRole(role, []).map((model) => model.id)).toEqual(offered.map((model) => model.id))
  }
})

test('synthesis comes from the tested list too, and decisions stay on the decision model', () => {
  expect(roleIsListed('synthesis')).toBe(true)
  expect(modelsForRole('synthesis', LOADED).map((model) => model.id)).not.toContain('example/other-model')
  expect(roleIsListed('decision')).toBe(false)
  expect(modelsForRole('decision', LOADED).map((model) => model.id)).toEqual(['typesafe/jev-1.13'])
})
