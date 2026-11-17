import { WORDING } from '@pluribus/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { useBackendStatus, useBackendStatusDetail } from '@/backend'
import { FIXTURES_ENABLED } from '@/backend/connect'
import { BrandMark } from './brand'

/**
 * What the window shows instead of the app while the backend cannot serve:
 * connecting, standing by because another tab runs it, or failed.
 */
export function BackendGate({ children }: { children: ReactNode }) {
  const status = useBackendStatus()
  const detail = useBackendStatusDetail()
  if (status === 'ready') return <>{children}</>
  if (status === 'standby') {
    return (
      <Notice title={WORDING.openInAnotherTab}>
        Only one tab runs the conversations at a time, so that nothing is answered twice. This tab takes over as soon as
        the other one is closed.
      </Notice>
    )
  }
  if (status === 'failed') {
    return (
      <Notice title="Pluribus could not start" tone="failed">
        {(detail ?? 'The backend did not start').replace(/[.\s]*$/, '.')}
        {FIXTURES_ENABLED ? (
          <>
            {' '}
            <a href="?fixtures" className="font-medium text-primary underline-offset-4 hover:underline">
              Open the fixture gallery
            </a>
            , or run one fixture with <code className="font-mono text-xs">?fixture=trip</code>.
          </>
        ) : null}
      </Notice>
    )
  }
  return <Connecting />
}

/** Nothing for the first moments, so a fast start shows no flash; then a quiet mark. */
function Connecting() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 350)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div role="status" aria-label="Starting Pluribus" className="grid h-full place-items-center bg-background">
      {visible ? <BrandMark className="animate-pending size-9" /> : null}
    </div>
  )
}

function Notice({ title, tone, children }: { title: string; tone?: 'failed'; children: ReactNode }) {
  return (
    <div role={tone === 'failed' ? 'alert' : 'status'} className="grid h-full place-items-center bg-background px-6">
      <div className="max-w-sm text-center">
        <BrandMark className="size-9" />
        <h1 className="display mt-5 text-balance">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}
