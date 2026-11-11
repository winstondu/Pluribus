import { DEFAULT_SETTINGS, type ModelRole } from '@committee/protocol'

/** One model offered in the per-role model selector. */
export interface ModelOption {
  /** The OpenRouter model ID, sent to the backend as it is. */
  readonly id: string
  readonly name: string
  /** The part of the ID before the slash. */
  readonly provider: string
  readonly contextLength: number | null
}

export type ModelLoader = () => Promise<readonly ModelOption[]>

function option(id: string, name: string, contextLength: number | null = null): ModelOption {
  return { id, name, provider: id.slice(0, id.indexOf('/')), contextLength }
}

/** Shown when the model list cannot be loaded, and in fixtures and tests. */
export const BUILT_IN_MODELS: readonly ModelOption[] = [
  option('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
  option('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'),
  option('anthropic/claude-opus-5.5', 'Claude Opus 5.5'),
  option('typesafe/jev-1.13', 'Jev 1.13'),
]

const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'

/**
 * Loads OpenRouter's public model list (no key needed), once per page load.
 * Falls back to the built-in list when the request fails.
 */
export function createModelLoader(fetchFn: typeof fetch = (input, init) => fetch(input, init)): ModelLoader {
  let cached: Promise<readonly ModelOption[]> | null = null
  return () => {
    cached ??= (async () => {
      try {
        const response = await fetchFn(MODELS_ENDPOINT)
        if (!response.ok) return BUILT_IN_MODELS
        const body = (await response.json()) as { data?: { id?: unknown; name?: unknown; context_length?: unknown }[] }
        const models = (body.data ?? []).flatMap((entry): ModelOption[] => {
          if (typeof entry.id !== 'string' || !entry.id.includes('/')) return []
          const name = typeof entry.name === 'string' ? entry.name.replace(/^[^:]+:\s*/, '') : entry.id
          return [option(entry.id, name, typeof entry.context_length === 'number' ? entry.context_length : null)]
        })
        return models.length > 0 ? models : BUILT_IN_MODELS
      } catch {
        cached = null
        return BUILT_IN_MODELS
      }
    })()
    return cached
  }
}

export const builtInModelLoader: ModelLoader = async () => BUILT_IN_MODELS

/** What each role is for, as the settings show it (10 · "User settings", Q65, Q90). */
export const MODEL_ROLES: readonly { role: ModelRole; label: string; description: string }[] = [
  {
    role: 'answer',
    label: 'Answers',
    description: 'Writes every answer section, including work that continues from a join-back.',
  },
  {
    role: 'synthesis',
    label: 'Synthesis',
    description: 'Writes answers on a join chain, where lines of work that diverged are combined.',
  },
  {
    role: 'decomposition',
    label: 'Decomposition',
    description: 'Rewrites a composite message into its fragments. It never decides where work goes.',
  },
  {
    role: 'decision',
    label: 'Decisions',
    description: 'Chooses among candidates Committee supplies: targets, relations, placement. It selects; it does not write.',
  },
]

/** Models offered for a role. Decisions run on a decision model only. */
export function modelsForRole(role: ModelRole, models: readonly ModelOption[]): readonly ModelOption[] {
  const decisionProvider = DEFAULT_SETTINGS.models.decision.slice(0, DEFAULT_SETTINGS.models.decision.indexOf('/'))
  return role === 'decision'
    ? models.filter((model) => model.provider === decisionProvider)
    : models.filter((model) => model.provider !== decisionProvider)
}

/** "200K", "1M". */
export function formatContextLength(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1_000)}K`
}
