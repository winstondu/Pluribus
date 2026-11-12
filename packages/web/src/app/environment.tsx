import { createContext, useContext, type ReactNode } from 'react'
import { createScriptedKeyProvision, type KeyProvision } from '@/backend'
import { builtInModelLoader, createModelLoader, type ModelLoader } from './models'

/**
 * What the shell needs besides the backend: the deployment's key provision,
 * and OpenRouter's public model catalog for roles whose model is not
 * restricted to a list. Both are injected so that fixtures and tests never
 * leave the page. The default is the offline pair; the app provides the
 * connection's key provision and the live catalog when it runs on the
 * Worker backend.
 */
export interface AppEnvironment {
  readonly keys: KeyProvision
  readonly loadModels: ModelLoader
}

export const OFFLINE_ENVIRONMENT: AppEnvironment = {
  keys: createScriptedKeyProvision(null),
  loadModels: builtInModelLoader,
}

export function createEnvironment(keys: KeyProvision, live: boolean): AppEnvironment {
  return { keys, loadModels: live ? createModelLoader() : builtInModelLoader }
}

const EnvironmentContext = createContext<AppEnvironment>(OFFLINE_ENVIRONMENT)

export function AppEnvironmentProvider(props: { environment: AppEnvironment; children: ReactNode }) {
  return <EnvironmentContext.Provider value={props.environment}>{props.children}</EnvironmentContext.Provider>
}

export function useAppEnvironment(): AppEnvironment {
  return useContext(EnvironmentContext)
}

/** How this deployment provides provider keys. */
export function useKeyProvision(): KeyProvision {
  return useContext(EnvironmentContext).keys
}
