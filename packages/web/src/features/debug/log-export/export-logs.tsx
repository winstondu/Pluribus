import { DownloadIcon, Loader2Icon } from 'lucide-react'
import { useRef, useState } from 'react'
import { saveLogExport, useActiveConversationId, useLogExportSource, type LogExportResult, type SaveEnvironment } from '@/backend'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

type ExportStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'saved'; readonly filename: string }
  | { readonly kind: 'error'; readonly message: string }

/**
 * "Export full logs" in the header's debug menu, which is there whether or
 * not a debug view is open. Asks the export source for the active
 * conversation's log (the backend builds it) and saves the file it gets,
 * a Blob or a download URL. The menu stays open so the busy and error
 * states can be seen; the outcome is announced.
 */
export function ExportLogsMenuItem(props: { save?: (result: LogExportResult) => void; saveEnvironment?: SaveEnvironment }) {
  const conversationId = useActiveConversationId()
  const source = useLogExportSource()
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' })
  const busy = useRef(false)

  const run = async (): Promise<void> => {
    if (busy.current || conversationId === null) return
    busy.current = true
    setStatus({ kind: 'busy' })
    try {
      const result = await source.exportLog(conversationId)
      if (props.save) props.save(result)
      else saveLogExport(result, props.saveEnvironment)
      setStatus({ kind: 'saved', filename: result.filename })
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      busy.current = false
    }
  }

  const isBusy = status.kind === 'busy'
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={conversationId === null || isBusy}
        aria-busy={isBusy}
        onSelect={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        {isBusy ? <Loader2Icon aria-hidden className="animate-spin" /> : <DownloadIcon aria-hidden />}
        {isBusy ? 'Preparing export…' : 'Export full logs'}
      </DropdownMenuItem>
      <p className="px-1.5 pb-1 text-xs text-muted-foreground">
        A JSON file of every event and routing decision. It contains the full text of this conversation and is saved to
        this device only.
      </p>
      <div role="status" aria-live="polite" className="px-1.5 text-xs empty:hidden">
        {status.kind === 'busy' ? <span className="sr-only">Preparing the export</span> : null}
        {status.kind === 'saved' ? <span className="break-all text-muted-foreground">Saved {status.filename}</span> : null}
      </div>
      {status.kind === 'error' ? (
        <p role="alert" className="px-1.5 pb-1 text-xs text-destructive">
          Export failed: {status.message}
        </p>
      ) : null}
    </>
  )
}
