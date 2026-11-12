import { LOG_EXPORT_MEDIA_TYPE, type BackendClient, type ConversationId } from '@committee/protocol'
import { createContext, useContext, useMemo } from 'react'
import { useBackend } from './hooks'

/**
 * "Export full logs": the page asks where the export comes from, and saves
 * whatever it is given. The backend builds the export; the page never
 * assembles one from what it happens to hold.
 *
 * - Embedded (now): the Worker builds it and posts its JSON text in chunks;
 *   the page wraps the chunks in a Blob without parsing them.
 * - A server deployment: the server answers with a download URL (or the
 *   same chunks), and the button does not change.
 */

/** A file the UI can save. */
export type LogExportResult =
  | { readonly kind: 'blob'; readonly blob: Blob; readonly filename: string }
  | { readonly kind: 'url'; readonly url: string; readonly filename: string }

export interface LogExportSource {
  /** The full log export of a conversation. Rejects with a {@link LogExportError} the UI can show. */
  exportLog(conversationId: ConversationId): Promise<LogExportResult>
}

export class LogExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LogExportError'
  }
}

/** The source for a backend reached through `BackendClient`: the embedded Worker, or any transport that forwards snapshot queries. */
export function backendLogExportSource(client: BackendClient): LogExportSource {
  return {
    async exportLog(conversationId) {
      const result = await client.snapshot({ kind: 'log-export', conversationId })
      if (!result.ok) throw new LogExportError(result.error.message)
      const file = result.value
      return { kind: 'blob', blob: new Blob([...file.chunks], { type: file.mediaType || LOG_EXPORT_MEDIA_TYPE }), filename: file.filename }
    },
  }
}

/** Set by `LogExportSourceProvider`; without one, the backend client is asked. */
export const LogExportSourceContext = createContext<LogExportSource | null>(null)

/** Where exports come from on this page. */
export function useLogExportSource(): LogExportSource {
  const provided = useContext(LogExportSourceContext)
  const client = useBackend()
  return useMemo(() => provided ?? backendLogExportSource(client), [provided, client])
}

/** What saving needs from the page; tests pass their own. */
export interface SaveEnvironment {
  readonly document: Document
  readonly createObjectURL: (blob: Blob) => string
  readonly revokeObjectURL: (url: string) => void
  /** Runs `revoke` once the browser has started the download. */
  readonly later: (revoke: () => void) => void
}

function browserEnvironment(): SaveEnvironment {
  return {
    document,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    // A revocation in the same task can cancel the download in some browsers.
    later: (revoke) => void setTimeout(revoke, 10_000),
  }
}

/**
 * Starts the download of an export: a local download only, nothing is sent
 * anywhere. A Blob goes through an object URL that is revoked afterwards.
 */
export function saveLogExport(result: LogExportResult, environment: SaveEnvironment = browserEnvironment()): void {
  const href = result.kind === 'blob' ? environment.createObjectURL(result.blob) : result.url
  const anchor = environment.document.createElement('a')
  anchor.href = href
  anchor.download = result.filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  environment.document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    if (result.kind === 'blob') environment.later(() => environment.revokeObjectURL(href))
  }
}
