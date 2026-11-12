import type { ModelProviderName, ModelRole } from './model'
import { DEFAULT_SETTINGS, type Settings } from './settings'

/**
 * What can be chosen for each role's model (10 · "User settings", 11 ·
 * "Models"). The backend decides this and reports it in the app snapshot;
 * the client renders it and sends `change-settings`. Nothing here is
 * computed in the client: which providers exist for a role, which models
 * each offers, and whether the client may
 * change anything at all are the backend's to say, so the same settings
 * work against an embedded backend and against a server whose models are
 * set by its environment (Q65).
 */

/** One model a role may be set to. */
export interface ModelChoiceOption {
  /** The model ID as the provider names it. */
  readonly id: string
  readonly name: string
}

/** One provider a role may be set to. */
export interface ProviderChoice {
  readonly provider: ModelProviderName
  readonly models: readonly ModelChoiceOption[]
}

export interface ModelRoleChoice {
  readonly role: ModelRole
  /** The role's model now: the same value as in the settings. */
  readonly model: string
  /** False when this client may not change the role's provider or model: the deployment sets them. */
  readonly editable: boolean
  /** One line for the settings when something about the role is fixed; null otherwise. */
  readonly note: string | null
  /** The providers the role can run on. One entry means there is no provider to choose. */
  readonly providers: readonly ProviderChoice[]
}

export interface ModelChoiceInputs {
  /** False in a deployment whose models are set by its environment. */
  readonly editable: boolean
}

export const SERVER_MODELS_NOTE = 'Set by the server.'

const ROLE_ORDER: readonly ModelRole[] = ['answer', 'synthesis', 'decomposition', 'decision']

function providerChoice(role: ModelRole, provider: ModelProviderName): ProviderChoice {
  const models: readonly ModelChoiceOption[] =
    role === 'decision'
      ? // The pinned decision model (Q74). Another decision model's ID can be typed in.
        [{ id: DEFAULT_SETTINGS.models.decision, name: 'Jev 1.13' }]
      : []
  return { provider, models }
}

/** The description the backend reports. Pure: a function of the settings, the key status and the deployment. */
export function describeModelRoles(settings: Pick<Settings, 'models'>, inputs: ModelChoiceInputs): readonly ModelRoleChoice[] {
  return ROLE_ORDER.map((role) => {
    const providers: readonly ModelProviderName[] = ['openrouter']
    return {
      role,
      model: settings.models[role],
      editable: inputs.editable,
      note: !inputs.editable ? SERVER_MODELS_NOTE : null,
      providers: providers.map((provider) => providerChoice(role, provider)),
    }
  })
}
