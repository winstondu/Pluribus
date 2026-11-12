import type { ModelProviderName, ModelRole } from './model'
import { compatibleModels, isListedModelRole } from './models'
import { PROVIDER_DEFAULT_MODELS, type Settings } from './settings'

/**
 * What can be chosen for each role's model (10 · "User settings", 11 ·
 * "Models"). The backend decides this and reports it in the app snapshot;
 * the client renders it and sends `change-settings`. Nothing here is
 * computed in the client: which providers exist for a role, which of them
 * can be used now, which models each offers, and whether the client may
 * change anything at all are the backend's to say, so the same settings
 * work against an embedded backend and against a server whose models are
 * set by its environment (Q65).
 */

/** One model a role may be set to. */
export interface ModelChoiceOption {
  /** The model ID as the provider names it. */
  readonly id: string
  readonly name: string
  /** False for a listed model whose live smoke run is still outstanding (Q107). */
  readonly tested: boolean
}

/** One provider a role may be set to. */
export interface ProviderChoice {
  readonly provider: ModelProviderName
  /** False while it cannot be chosen; `unavailableReason` says why. */
  readonly available: boolean
  readonly unavailableReason: string | null
  /**
   * True when only `models` may be chosen (the tested compatibility list).
   * False when any model ID of the provider is accepted and `models` are
   * suggestions; an empty list then means the provider's whole catalog.
   */
  readonly restricted: boolean
  readonly models: readonly ModelChoiceOption[]
}

export interface ModelRoleChoice {
  readonly role: ModelRole
  /** The role's provider and model now: the same values as in the settings. */
  readonly provider: ModelProviderName
  readonly model: string
  /** False when this client may not change the role's provider or model: the deployment sets them. */
  readonly editable: boolean
  /** One line for the settings when something about the role is fixed; null otherwise. */
  readonly note: string | null
  /** The providers the role can run on, OpenRouter first. One entry means there is no provider to choose. */
  readonly providers: readonly ProviderChoice[]
}

export interface ModelChoiceInputs {
  /** Whether an Anthropic key is configured: the Claude API is usable only then. */
  readonly anthropicKeyConfigured: boolean
  /** False in a deployment whose models are set by its environment. */
  readonly editable: boolean
}

export const DECISION_PROVIDER_NOTE = 'Decisions always run on OpenRouter: the Claude API has no Decisions endpoint.'
export const SERVER_MODELS_NOTE = 'Set by the server.'
export const ANTHROPIC_KEY_NEEDED = 'Add an Anthropic key to use the Claude API.'

const ROLE_ORDER: readonly ModelRole[] = ['answer', 'synthesis', 'decomposition', 'decision']

function providerChoice(role: ModelRole, provider: ModelProviderName, inputs: ModelChoiceInputs): ProviderChoice {
  const available = provider === 'openrouter' || inputs.anthropicKeyConfigured
  const listed = isListedModelRole(role)
  const models: readonly ModelChoiceOption[] = listed
    ? compatibleModels(role, provider).map((model) => ({ id: model.id, name: model.name, tested: model.testedOn !== null }))
    : role === 'decision'
      ? // The pinned decision model (Q74). Another decision model's ID can be typed in.
        [{ id: PROVIDER_DEFAULT_MODELS.openrouter.decision, name: 'Jev 1.13', tested: true }]
      : []
  return { provider, available, unavailableReason: available ? null : ANTHROPIC_KEY_NEEDED, restricted: listed, models }
}

/** The description the backend reports. Pure: a function of the settings, the key status and the deployment. */
export function describeModelRoles(settings: Pick<Settings, 'models' | 'modelProviders'>, inputs: ModelChoiceInputs): readonly ModelRoleChoice[] {
  return ROLE_ORDER.map((role) => {
    const providers: readonly ModelProviderName[] = role === 'decision' ? ['openrouter'] : ['openrouter', 'anthropic']
    return {
      role,
      provider: settings.modelProviders[role],
      model: settings.models[role],
      editable: inputs.editable,
      note: !inputs.editable ? SERVER_MODELS_NOTE : role === 'decision' ? DECISION_PROVIDER_NOTE : null,
      providers: providers.map((provider) => providerChoice(role, provider, inputs)),
    }
  })
}
