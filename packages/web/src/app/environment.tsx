import { createContext, useContext, type ReactNode } from 'react'
import { createKeyValidator, scriptedKeyValidator, type KeyValidator } from './key-validation'
import { builtInModelLoader, createModelLoader, type ModelLoader } from './models'

/**
 * The two things the shell does on the network by itself: checking a pasted
 * key and loading the model list. Both are injected so that fixtures and
 * tests never leave the page. The default is the offline pair; the app
 * provides the live pair when it runs on the Worker backend.
 */
export interface AppEnvironment {
  readonly validateKey: KeyValidator
  readonly loadModels: ModelLoader
}

export const OFFLINE_ENVIRONMENT: AppEnvironment = {
  validateKey: scriptedKeyValidator,
  loadModels: builtInModelLoader,
}

export function createLiveEnvironment(): AppEnvironment {
  return { validateKey: createKeyValidator(), loadModels: createModelLoader() }
}

const EnvironmentContext = createContext<AppEnvironment>(OFFLINE_ENVIRONMENT)

export function AppEnvironmentProvider(props: { environment: AppEnvironment; children: ReactNode }) {
  return <EnvironmentContext.Provider value={props.environment}>{props.children}</EnvironmentContext.Provider>
}

export function useAppEnvironment(): AppEnvironment {
  return useContext(EnvironmentContext)
}
