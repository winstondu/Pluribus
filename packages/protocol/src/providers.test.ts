import { describe, expect, test } from 'vitest'
import {
  ANTHROPIC_KEY_NEEDED,
  DECISION_PROVIDER_NOTE,
  DEFAULT_SETTINGS,
  PROVIDER_DEFAULT_MODELS,
  SERVER_MODELS_NOTE,
  anthropicFallbackPatch,
  applySettingsPatch,
  compatibleModels,
  completeSettingsPatch,
  describeModelRoles,
  normalizeSettings,
  providerChoicePatch,
  rolesOnAnthropic,
  validateSettingsPatch,
  type Settings,
} from './index'

/** The per-role provider: a setting beside the model, validated and described by the backend. */
describe('per-role model providers', () => {
  test('by default every role is on OpenRouter, with the same models as before', () => {
    expect(DEFAULT_SETTINGS.modelProviders).toEqual({ answer: 'openrouter', decomposition: 'openrouter', synthesis: 'openrouter', decision: 'openrouter' })
    expect(DEFAULT_SETTINGS.models).toEqual({
      answer: 'anthropic/claude-sonnet-5.5',
      decomposition: 'anthropic/claude-haiku-5.5',
      synthesis: 'anthropic/claude-sonnet-5.5',
      decision: 'typesafe/jev-1.13',
    })
    expect(rolesOnAnthropic(DEFAULT_SETTINGS)).toEqual([])
  })

  test('settings stored before providers existed get OpenRouter for every role; a stored choice is kept; decisions are always OpenRouter', () => {
    const { modelProviders: _dropped, ...older } = DEFAULT_SETTINGS
    expect(normalizeSettings(older).modelProviders).toEqual(DEFAULT_SETTINGS.modelProviders)
    const stored = {
      ...DEFAULT_SETTINGS,
      models: { ...DEFAULT_SETTINGS.models, answer: 'claude-haiku-5-5', synthesis: 'claude-haiku-5-5' },
      modelProviders: { answer: 'anthropic', synthesis: 'anthropic', decomposition: 'openrouter', decision: 'anthropic' },
    } as Settings
    const normalised = normalizeSettings(stored)
    expect(normalised.modelProviders).toEqual({ answer: 'anthropic', synthesis: 'anthropic', decomposition: 'openrouter', decision: 'openrouter' })
    // The models are kept: each is valid for its role's provider.
    expect(normalised.models.answer).toBe('claude-haiku-5-5')
    expect(normalised.models.synthesis).toBe('claude-haiku-5-5')
    // A value that is not a provider falls back to OpenRouter.
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, modelProviders: { ...DEFAULT_SETTINGS.modelProviders, answer: 'elsewhere' as never } }).modelProviders.answer).toBe('openrouter')
  })

  test('a stored model that is not on its provider\'s list is replaced by that provider\'s default', () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      // An OpenRouter ID left on a role that runs on the Claude API.
      modelProviders: { ...DEFAULT_SETTINGS.modelProviders, answer: 'anthropic' },
    } as Settings
    expect(normalizeSettings(stored).models.answer).toBe(PROVIDER_DEFAULT_MODELS.anthropic.answer)
  })

  test('choosing a provider picks that provider\'s default model for the role, even when only the provider is sent', () => {
    expect(providerChoicePatch('answer', 'anthropic')).toEqual({ modelProviders: { answer: 'anthropic' }, models: { answer: 'claude-sonnet-5-5' } })
    const completed = completeSettingsPatch(DEFAULT_SETTINGS, { modelProviders: { decomposition: 'anthropic' } })
    expect(completed.models).toEqual({ decomposition: 'claude-haiku-5-5' })
    expect(validateSettingsPatch(completed, DEFAULT_SETTINGS)).toBeNull()
    const next = applySettingsPatch(DEFAULT_SETTINGS, completed)
    expect([next.modelProviders.decomposition, next.models.decomposition]).toEqual(['anthropic', 'claude-haiku-5-5'])
    // A model named in the patch is kept; an unchanged provider adds nothing.
    expect(completeSettingsPatch(DEFAULT_SETTINGS, { modelProviders: { answer: 'anthropic' }, models: { answer: 'claude-haiku-5-5' } }).models).toEqual({ answer: 'claude-haiku-5-5' })
    const same = { modelProviders: { answer: 'openrouter' as const } }
    expect(completeSettingsPatch(DEFAULT_SETTINGS, same)).toBe(same)
  })

  test('a model is checked against the list of the provider its role will have', () => {
    // An OpenRouter ID on the Claude API, and the reverse, are refused.
    expect(validateSettingsPatch({ modelProviders: { answer: 'anthropic' }, models: { answer: 'anthropic/claude-sonnet-5.5' } }, DEFAULT_SETTINGS)).toMatch(/claude-sonnet-5-5, claude-haiku-5-5/)
    expect(validateSettingsPatch({ models: { answer: 'claude-sonnet-5-5' } }, DEFAULT_SETTINGS)).toMatch(/tested models/)
    const onAnthropic = applySettingsPatch(DEFAULT_SETTINGS, providerChoicePatch('answer', 'anthropic'))
    expect(validateSettingsPatch({ models: { answer: 'claude-haiku-5-5' } }, onAnthropic)).toBeNull()
    expect(validateSettingsPatch({ models: { answer: 'anthropic/claude-haiku-5.5' } }, onAnthropic)).toMatch(/tested models/)
    // The provider alone, leaving the old model in place, is refused too.
    expect(validateSettingsPatch({ modelProviders: { answer: 'anthropic' } }, DEFAULT_SETTINGS)).toMatch(/tested models/)
    // Synthesis comes from its provider's list too.
    expect(validateSettingsPatch({ modelProviders: { synthesis: 'anthropic' }, models: { synthesis: 'claude-haiku-5-5' } }, DEFAULT_SETTINGS)).toBeNull()
    expect(validateSettingsPatch({ modelProviders: { synthesis: 'anthropic' }, models: { synthesis: 'claude-opus-5-5' } }, DEFAULT_SETTINGS)).toMatch(/tested models/)
  })

  test('decisions cannot leave OpenRouter, and an unknown provider is refused', () => {
    expect(validateSettingsPatch({ modelProviders: { decision: 'anthropic' } })).toBe('Decisions run on OpenRouter only')
    expect(validateSettingsPatch({ modelProviders: { decision: 'openrouter' } })).toBeNull()
    expect(validateSettingsPatch({ modelProviders: { answer: 'elsewhere' as never } })).toMatch(/Unknown model provider/)
  })

  test('removing the Anthropic key returns exactly the roles that used it to OpenRouter and its default models', () => {
    expect(anthropicFallbackPatch(DEFAULT_SETTINGS)).toBeNull()
    let settings = applySettingsPatch(DEFAULT_SETTINGS, providerChoicePatch('answer', 'anthropic'))
    settings = applySettingsPatch(settings, { modelProviders: { synthesis: 'anthropic' }, models: { synthesis: 'claude-haiku-5-5' } })
    // Decomposition stays on OpenRouter, on a non-default model that must survive.
    settings = applySettingsPatch(settings, { models: { decomposition: 'anthropic/claude-sonnet-5.5' } })
    expect(rolesOnAnthropic(settings)).toEqual(['answer', 'synthesis'])
    const fallback = anthropicFallbackPatch(settings)
    expect(fallback).toEqual({
      modelProviders: { answer: 'openrouter', synthesis: 'openrouter' },
      models: { answer: 'anthropic/claude-sonnet-5.5', synthesis: 'anthropic/claude-sonnet-5.5' },
    })
    const after = applySettingsPatch(settings, fallback ?? {})
    expect(after.modelProviders).toEqual(DEFAULT_SETTINGS.modelProviders)
    expect(after.models.decomposition).toBe('anthropic/claude-sonnet-5.5')
    expect(validateSettingsPatch(fallback ?? {}, settings)).toBeNull()
  })

  test('the compatibility list is per provider: the same two models, under each provider\'s IDs', () => {
    for (const role of ['answer', 'decomposition', 'synthesis'] as const) {
      expect(compatibleModels(role).map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'])
      expect(compatibleModels(role, 'anthropic').map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
    }
  })
})

/** What the backend reports for the Models section; the client renders it and decides nothing. */
describe('the backend\'s description of each role\'s model choice', () => {
  const describe_ = (anthropicKeyConfigured: boolean, editable = true, settings: Settings = DEFAULT_SETTINGS) => describeModelRoles(settings, { anthropicKeyConfigured, editable })
  const role = (roles: ReturnType<typeof describe_>, name: string) => {
    const found = roles.find((entry) => entry.role === name)
    if (!found) throw new Error(`no role ${name}`)
    return found
  }

  test('with the OpenRouter key alone, the Claude API is listed for the selectable roles but not usable, with the reason', () => {
    const roles = describe_(false)
    expect(roles.map((entry) => entry.role)).toEqual(['answer', 'synthesis', 'decomposition', 'decision'])
    for (const name of ['answer', 'synthesis', 'decomposition']) {
      expect(role(roles, name).providers.map((p) => [p.provider, p.available, p.unavailableReason])).toEqual([
        ['openrouter', true, null],
        ['anthropic', false, ANTHROPIC_KEY_NEEDED],
      ])
      expect(role(roles, name).editable).toBe(true)
    }
  })

  test('with both keys both providers are usable; decisions have OpenRouter only, with the reason in one line', () => {
    const roles = describe_(true)
    expect(role(roles, 'answer').providers.every((p) => p.available)).toBe(true)
    expect(role(roles, 'decision').providers.map((p) => p.provider)).toEqual(['openrouter'])
    expect(role(roles, 'decision').note).toBe(DECISION_PROVIDER_NOTE)
    expect(role(roles, 'answer').note).toBeNull()
  })

  test('each provider offers its own models: the tested list for answers, synthesis and decomposition; the pinned model for decisions', () => {
    const roles = describe_(true)
    const [openRouter, anthropic] = role(roles, 'answer').providers
    expect([openRouter?.restricted, openRouter?.models.map((m) => m.id)]).toEqual([true, ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']])
    expect([anthropic?.restricted, anthropic?.models.map((m) => m.id)]).toEqual([true, ['claude-sonnet-5-5', 'claude-haiku-5-5']])
    // The Claude API entries are offered but their live run is still outstanding, and say so.
    expect(openRouter?.models.every((m) => m.tested)).toBe(true)
    expect(anthropic?.models.every((m) => !m.tested)).toBe(true)
    expect(role(roles, 'synthesis').providers.map((p) => [p.provider, p.restricted, p.models.map((m) => m.id)])).toEqual([
      ['openrouter', true, ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']],
      ['anthropic', true, ['claude-sonnet-5-5', 'claude-haiku-5-5']],
    ])
    expect(role(roles, 'decision').providers.map((p) => [p.restricted, p.models.map((m) => m.id)])).toEqual([[false, ['typesafe/jev-1.13']]])
  })

  test('it reports the provider and model each role has now', () => {
    const settings = applySettingsPatch(DEFAULT_SETTINGS, providerChoicePatch('synthesis', 'anthropic'))
    const synthesis = role(describe_(true, true, settings), 'synthesis')
    expect([synthesis.provider, synthesis.model]).toEqual(['anthropic', 'claude-sonnet-5-5'])
  })

  test('in a deployment whose models are set by the server, no role is editable', () => {
    const roles = describe_(true, false)
    expect(roles.every((entry) => !entry.editable && entry.note === SERVER_MODELS_NOTE)).toBe(true)
  })
})
