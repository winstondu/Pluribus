import type { ModelProviderName, ModelRole } from './model'

/**
 * The tested compatibility list (Q107; 10 · "User settings", 11 · "Models").
 *
 * In the MVP the answer, decomposition and synthesis models are chosen from this list
 * and nowhere else. The list is per provider: a model reached through
 * OpenRouter and the same model reached through the Claude API are two
 * entries, each with its provider's ID, because the request and the stream
 * differ. A model is on it only after the live smoke suite has shown,
 * against that provider, the two things readiness needs of it:
 *
 * - **structured preparation**: it returns the typed readiness result of
 *   the preparation step under a strict JSON schema (Q103); used in the
 *   decomposition role, which also runs generative decomposition;
 * - **streamed clarification signal**: while streaming an answer it can
 *   stop and signal, in a typed way, that the user must be asked (Q106);
 *   used in the answer and synthesis roles: a synthesis run is an answer
 *   the user reads and must be able to stop and ask.
 *
 * Add a model here only together with a smoke run that covers it
 * (`packages/providers/test/smoke/readiness.smoke.test.ts` for OpenRouter,
 * `packages/providers/test/smoke/anthropic.smoke.test.ts` for the Claude API). An
 * entry whose `testedOn` is null is offered but has not had that run yet;
 * the settings say so. The decision model is
 * pinned and is not on this list (Q74).
 */

/** The roles whose choices come from the list. */
export type ListedModelRole = Extract<ModelRole, 'answer' | 'decomposition' | 'synthesis'>

export const LISTED_MODEL_ROLES: readonly ListedModelRole[] = ['answer', 'decomposition', 'synthesis']

export interface CompatibleModel {
  /** The provider this entry is for. */
  readonly provider: ModelProviderName
  /** The model ID as that provider names it. */
  readonly id: string
  /** Name shown in the model selector. */
  readonly name: string
  /** The roles it may be chosen for. */
  readonly roles: readonly ListedModelRole[]
  /** Returns the typed readiness result of the preparation step under a strict JSON schema. */
  readonly structuredPreparation: boolean
  /** Can stop a streamed answer with the typed clarification signal. */
  readonly streamedClarificationSignal: boolean
  /** The date the live smoke suite last showed both, as YYYY-MM-DD; null while that run is still outstanding. */
  readonly testedOn: string | null
}

export const MODEL_COMPATIBILITY: readonly CompatibleModel[] = [
  {
    provider: 'openrouter',
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    roles: ['answer', 'decomposition', 'synthesis'],
    structuredPreparation: true,
    streamedClarificationSignal: true,
    testedOn: '2026-11-12',
  },
  {
    provider: 'openrouter',
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    roles: ['answer', 'decomposition', 'synthesis'],
    structuredPreparation: true,
    streamedClarificationSignal: true,
    testedOn: '2026-11-12',
  },
  // The same two models through the Claude API. Covered by `anthropic.smoke.test.ts`, which needs an Anthropic key.
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    roles: ['answer', 'decomposition', 'synthesis'],
    structuredPreparation: true,
    streamedClarificationSignal: true,
    testedOn: null,
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    roles: ['answer', 'decomposition', 'synthesis'],
    structuredPreparation: true,
    streamedClarificationSignal: true,
    testedOn: null,
  },
]

/** The listed models a role may be set to on a provider, in list order. */
export function compatibleModels(role: ListedModelRole, provider: ModelProviderName = 'openrouter'): readonly CompatibleModel[] {
  return MODEL_COMPATIBILITY.filter((model) => model.provider === provider && model.roles.includes(role))
}

/** The list entry of a provider's model, or null when it is not listed. */
export function compatibleModel(id: string, provider: ModelProviderName = 'openrouter'): CompatibleModel | null {
  return MODEL_COMPATIBILITY.find((model) => model.provider === provider && model.id === id) ?? null
}

export function isListedModelRole(role: string): role is ListedModelRole {
  return (LISTED_MODEL_ROLES as readonly string[]).includes(role)
}

/** True when `id` may be chosen for `role` on `provider`: any model for an unlisted role, a listed one for a listed role. */
export function isCompatibleModel(role: ModelRole, id: string, provider: ModelProviderName = 'openrouter'): boolean {
  if (!isListedModelRole(role)) return true
  return compatibleModels(role, provider).some((model) => model.id === id)
}
