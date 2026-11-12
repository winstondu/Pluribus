import type { ReactNode } from 'react'
import { LogExportSourceContext, type LogExportSource } from './log-export'

/** Overrides where exports come from (a server deployment, a test). Without it the backend client is asked. */
export function LogExportSourceProvider(props: { source: LogExportSource; children: ReactNode }) {
  return <LogExportSourceContext.Provider value={props.source}>{props.children}</LogExportSourceContext.Provider>
}
