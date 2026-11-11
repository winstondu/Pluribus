import type { ComponentType } from 'react'

/**
 * Entry components of the feature directories, found by glob so the shell
 * compiles and runs whether or not a feature exists yet. Each feature's
 * `index.ts` exports exactly the names below; one that is missing renders
 * nothing (or the shell's stand-in, where it has one).
 */
const modules = import.meta.glob<Record<string, unknown>>('../features/*/index.ts', { eager: true })

export interface FeatureEntries {
  transcript: 'TranscriptPane'
  composer: 'ComposerDock'
  association: 'ChainRail' | 'FocusBar'
  debug: 'DebugSidePanel' | 'OperationGraphDrawer'
}

/** The entry component `exportName` of feature `feature`, or null while it does not exist. */
export function featureComponent<F extends keyof FeatureEntries>(
  feature: F,
  exportName: FeatureEntries[F],
): ComponentType | null {
  const module = modules[`../features/${feature}/index.ts`]
  const component = module?.[exportName]
  return typeof component === 'function' || (typeof component === 'object' && component !== null)
    ? (component as ComponentType)
    : null
}
