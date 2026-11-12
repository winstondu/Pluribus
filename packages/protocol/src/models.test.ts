import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MODEL_COMPATIBILITY,
  applySettingsPatch,
  compatibleModel,
  compatibleModels,
  isCompatibleModel,
  normalizeSettings,
  validateSettingsPatch,
} from './index'

/** The tested compatibility list (Q107). */
describe('model compatibility list', () => {
  test('the defaults of the answer and decomposition roles are on the list, each tested for what its role needs', () => {
    expect(MODEL_COMPATIBILITY.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'])
    expect(compatibleModel(DEFAULT_SETTINGS.models.answer)?.streamedClarificationSignal).toBe(true)
    expect(compatibleModel(DEFAULT_SETTINGS.models.decomposition)?.structuredPreparation).toBe(true)
    for (const model of MODEL_COMPATIBILITY) {
      expect(model.testedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(model.roles.length).toBeGreaterThan(0)
    }
    expect(compatibleModels('answer').every((m) => m.streamedClarificationSignal)).toBe(true)
    expect(compatibleModels('decomposition').every((m) => m.structuredPreparation)).toBe(true)
  })

  test('answer, decomposition and synthesis can only be set to a listed model; the decision model is not on the list', () => {
    expect(validateSettingsPatch({ models: { answer: 'anthropic/claude-haiku-5.5' } })).toBeNull()
    expect(validateSettingsPatch({ models: { decomposition: 'anthropic/claude-sonnet-5.5' } })).toBeNull()
    expect(validateSettingsPatch({ models: { answer: 'example/untested-model' } })).toMatch(/tested models/)
    expect(validateSettingsPatch({ models: { decomposition: 'typesafe/jev-1.13' } })).toMatch(/tested models/)
    expect(validateSettingsPatch({ models: { synthesis: 'anthropic/claude-haiku-5.5' } })).toBeNull()
    expect(validateSettingsPatch({ models: { synthesis: 'example/untested-model' } })).toMatch(/tested models/)
    expect(isCompatibleModel('decision', 'typesafe/jev-1.13')).toBe(true)
    expect(compatibleModel('typesafe/jev-1.13')).toBeNull()
  })

  test('stored settings that name an unlisted answer, decomposition or synthesis model are normalised to the default; a listed choice is kept', () => {
    const stored = applySettingsPatch(DEFAULT_SETTINGS, { models: { synthesis: 'anthropic/claude-haiku-5.5' } })
    const normalised = normalizeSettings({ ...stored, models: { ...stored.models, answer: 'example/retired-model', decomposition: 'example/retired-too' } })
    expect(normalised.models).toEqual({ ...DEFAULT_SETTINGS.models, synthesis: 'anthropic/claude-haiku-5.5' })
    expect(normalizeSettings({ ...stored, models: { ...stored.models, synthesis: 'example/other' } }).models.synthesis).toBe(DEFAULT_SETTINGS.models.synthesis)
    // A listed choice survives.
    expect(normalizeSettings({ ...stored, models: { ...stored.models, answer: 'anthropic/claude-haiku-5.5' } }).models.answer).toBe('anthropic/claude-haiku-5.5')
  })
})
