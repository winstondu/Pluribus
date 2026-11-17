import { DEFAULT_SETTINGS, MODEL_COMPATIBILITY, describeModelRoles, type ModelProviderName, type ModelRole, type ProviderChoice } from '@pluribus/protocol'
import { expect, test } from 'vitest'
import { BUILT_IN_MODELS, optionsFor, type ModelOption } from './models'

const LOADED: readonly ModelOption[] = [
  ...BUILT_IN_MODELS.map((model) => (model.id === 'anthropic/claude-haiku-5.5' ? { ...model, contextLength: 200_000 } : model)),
  { id: 'example/other-model', name: 'Other', provider: 'example', contextLength: 32_000 },
]

/** What the backend reports for a role's provider. */
function reported(role: ModelRole, provider: ModelProviderName): ProviderChoice {
  const choice = describeModelRoles(DEFAULT_SETTINGS, { editable: true })
    .find((entry) => entry.role === role)
    ?.providers.find((entry) => entry.provider === provider)
  if (!choice) throw new Error(`no ${provider} choice for ${role}`)
  return choice
}

test('Q107 · the answer and decomposition selectors offer the tested compatibility list only, whatever OpenRouter lists', () => {
  for (const role of ['answer', 'decomposition'] as const) {
    const choice = reported(role, 'openrouter')
    expect(choice.restricted).toBe(true)
    const offered = optionsFor(choice, LOADED)
    expect(offered.map((model) => model.id)).toEqual(
      MODEL_COMPATIBILITY.filter((model) => model.roles.includes(role)).map((model) => model.id),
    )
    // What the loaded list knows about a listed model is kept.
    expect(offered.find((model) => model.id === 'anthropic/claude-haiku-5.5')?.contextLength).toBe(200_000)
    // With nothing loaded the list is still offered.
    expect(optionsFor(choice, []).map((model) => model.id)).toEqual(offered.map((model) => model.id))
  }
})

test('synthesis comes from the tested list too, and decisions stay on the decision model', () => {
  expect(reported('synthesis', 'openrouter').restricted).toBe(true)
  expect(optionsFor(reported('synthesis', 'openrouter'), LOADED).map((model) => model.id)).not.toContain('example/other-model')
  expect(reported('decision', 'openrouter').restricted).toBe(false)
  expect(optionsFor(reported('decision', 'openrouter'), LOADED).map((model) => model.id)).toEqual(['typesafe/jev-1.13'])
})
