import { InfoIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The git commit and time this client was built from, stamped by `vite.config.ts`. */
export const BUILD = __BUILD__

/** `abc1234`, `abc1234+` when built with uncommitted changes, or `unknown` outside a checkout. */
export function buildLabel(build: typeof BUILD = BUILD): string {
  if (build.commit === '') return 'unknown'
  return build.dirty ? `${build.commit}+` : build.commit
}

/**
 * An info icon beside the wordmark: hovering or focusing it shows which build
 * of the client is running, so a deploy can be told apart from the one before.
 */
export function BuildInfo() {
  const built = new Date(BUILD.builtAt)
  const when = Number.isNaN(built.getTime())
    ? BUILD.builtAt
    : built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Build ${buildLabel()}`}
          className="ml-auto text-faint-foreground hover:text-foreground"
          data-testid="build-info"
        >
          <InfoIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="flex-col items-start gap-0.5">
        <span>
          Build <span className="font-mono">{buildLabel()}</span>
          {BUILD.branch !== '' ? <span className="opacity-70"> on {BUILD.branch}</span> : null}
        </span>
        <span className="opacity-70">Built {when}</span>
        {BUILD.dirty ? <span className="opacity-70">Includes uncommitted changes</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}
