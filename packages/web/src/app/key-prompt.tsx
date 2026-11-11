import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LockIcon,
  TerminalIcon,
  WifiOffIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useApp, useSend } from '@/backend'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { BrandMark } from './brand'
import { useAppEnvironment } from './environment'
import {
  OPENROUTER_KEYS_URL,
  formatCredit,
  keyFormatProblem,
  type KeyCheck,
  type KeyValidator,
} from './key-validation'
import { useUiState } from './ui-state'

/**
 * The OpenRouter key prompt: the first-run experience, and the way a key is
 * replaced later.
 *
 * The key lives in this component's input state while it is being typed and
 * checked, goes to the backend in one `change-settings` command, and is then
 * dropped. It is never put in a store, `localStorage` or a URL, and this is
 * the only file that reads `__DEV_OPENROUTER_KEY__`.
 */

type Check =
  | { readonly state: 'idle' }
  | { readonly state: 'format'; readonly message: string }
  | { readonly state: 'checking' }
  | { readonly state: 'result'; readonly result: KeyCheck }

type Saving = 'no' | 'typed' | 'environment' | 'saved'

const CHECK_DELAY_MS = 350

/** The key from the dev server's environment. Empty in production builds and in tests. */
function environmentKey(): string {
  return typeof __DEV_OPENROUTER_KEY__ === 'string' ? __DEV_OPENROUTER_KEY__ : ''
}

/** `validate` defaults to the app environment's validator (live on the Worker backend, scripted with fixtures). */
export function KeyPrompt(props: { validate?: KeyValidator }) {
  const environment = useAppEnvironment()
  const validate = props.validate ?? environment.validateKey
  const open = useUiState((state) => state.keyPromptOpen)
  const closeKeyPrompt = useUiState((state) => state.closeKeyPrompt)
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeKeyPrompt())}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[27.5rem]"
        onOpenAutoFocus={(event) => {
          // Focus the field, not the first link.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          content.querySelector<HTMLInputElement>('input[data-key-input]')?.focus()
        }}
      >
        {/*
          The body stays through the dialog's exit, so the exit has something to show. The dialog unmounts its
          content once closed, which is what forgets the typed value.
        */}
        <KeyPromptBody validate={validate} onDone={closeKeyPrompt} />
      </DialogContent>
    </Dialog>
  )
}

function KeyPromptBody({ validate, onDone }: { validate: KeyValidator; onDone: () => void }) {
  const app = useApp()
  const send = useSend()
  // Decided once per opening: saving the first key must not turn the prompt into "Replace your key" under the confirmation.
  const [replacing] = useState(() => app?.key.configured === true)
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [saving, setSaving] = useState<Saving>('no')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const statusId = useId()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const devKey = environmentKey()

  // Format check at once; live check once the shape is plausible and typing has paused.
  useEffect(() => {
    const key = value.trim()
    if (key === '') {
      setCheck({ state: 'idle' })
      return
    }
    const problem = keyFormatProblem(key)
    if (problem) {
      setCheck({ state: 'format', message: problem })
      return
    }
    setCheck({ state: 'checking' })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      validate(key, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setCheck({ state: 'result', result })
        },
        () => {
          if (!controller.signal.aborted) setCheck({ state: 'result', result: { status: 'offline' } })
        },
      )
    }, CHECK_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, validate])

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    },
    [],
  )

  const result = check.state === 'result' ? check.result : null
  const canSave =
    saving === 'no' && result !== null && (result.status === 'valid' || result.status === 'offline' || result.status === 'unverified')

  async function save(key: string, how: Exclude<Saving, 'no' | 'saved'>): Promise<void> {
    setSaving(how)
    setError(null)
    const outcome = await send({ type: 'change-settings', openRouterKey: { action: 'set', key } })
    // The value is dropped whatever the outcome; a failed save is typed again.
    setValue('')
    setVisible(false)
    if (!outcome.ok) {
      setSaving('no')
      setError(outcome.error.message)
      return
    }
    setSaving('saved')
    closeTimer.current = setTimeout(onDone, 900)
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    if (canSave) void save(value.trim(), 'typed')
  }

  const invalid = check.state === 'format' || result?.status === 'invalid'

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-col">
      {/* On a short viewport this part scrolls and the actions stay in reach. */}
      <div className="scroll-quiet min-h-0 overflow-y-auto overscroll-contain px-6 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="eyebrow">{replacing ? 'OpenRouter key' : 'Before the first message'}</span>
        </div>
        <DialogTitle className="mt-4 font-serif text-[1.75rem] leading-[1.15] font-[450] tracking-[-0.02em] text-balance">
          {replacing ? 'Replace your OpenRouter key' : 'Bring your own OpenRouter key'}
        </DialogTitle>
        <DialogDescription className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          Committee runs every answer on models you reach through OpenRouter, billed to your account. The key is kept in
          this browser and sent only to OpenRouter.
        </DialogDescription>

        <div className="mt-5">
          <label htmlFor={inputId} className="text-xs font-medium text-foreground">
            API key
          </label>
          <div
            className={cn(
              'mt-1.5 flex h-10 items-center gap-1 rounded-lg border border-input bg-surface pr-1 pl-3 transition-[border-color,box-shadow] duration-(--duration-fast)',
              'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30',
              invalid && 'border-destructive/60 focus-within:border-destructive/60 focus-within:ring-destructive/15',
              result?.status === 'valid' && 'border-success/50 focus-within:border-success/60 focus-within:ring-success/15',
            )}
          >
            <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              id={inputId}
              data-key-input
              type={visible ? 'text' : 'password'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={saving !== 'no'}
              aria-invalid={invalid}
              aria-describedby={statusId}
              className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[0.8125rem] tracking-tight outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-faint-foreground"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={visible ? 'Hide key' : 'Show key'}
              aria-pressed={visible}
              onClick={() => setVisible((shown) => !shown)}
              disabled={saving !== 'no'}
              className="text-muted-foreground"
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </div>

          <div id={statusId} aria-live="polite" className="mt-2 min-h-10 text-xs leading-5">
            <StatusLine check={check} saving={saving} error={error} />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-muted/50 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <a
            href={OPENROUTER_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Create a key at openrouter.ai
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </a>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onDone} disabled={saving === 'typed' || saving === 'environment'}>
              {replacing ? 'Cancel' : 'Not now'}
            </Button>
            <Button type="submit" disabled={!canSave} className="min-w-[5.5rem]">
              <SwapLabel id={saving === 'saved' ? 'saved' : saving === 'typed' ? 'saving' : 'save'}>
                {saving === 'saved' ? (
                  <>
                    <CheckIcon /> Saved
                  </>
                ) : saving === 'typed' ? (
                  'Saving…'
                ) : (
                  'Save key'
                )}
              </SwapLabel>
            </Button>
          </div>
        </div>

        {devKey !== '' ? (
          <button
            type="button"
            onClick={() => void save(devKey, 'environment')}
            disabled={saving !== 'no'}
            className="pressable group flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border-strong bg-surface/60 px-3 py-2 text-left hover:bg-surface disabled:opacity-60"
          >
            <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">
                {saving === 'environment' ? 'Saving…' : 'Use the key from this environment'}
              </span>
              <span className="block text-2xs text-muted-foreground">
                OPENROUTER_KEY is set on the dev server. Not offered in production builds.
              </span>
            </span>
          </button>
        ) : null}
      </div>
    </form>
  )
}

/** The line under the field. One message at a time; the swap is a short fade so the state change is legible. */
function StatusLine({ check, saving, error }: { check: Check; saving: Saving; error: string | null }) {
  let id: string
  let tone: 'quiet' | 'bad' | 'good' | 'warn' = 'quiet'
  let icon: ReactNode = null
  let text: ReactNode

  if (error) {
    id = 'error'
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = `The key was not saved: ${error} Paste it again to retry.`
  } else if (saving === 'saved') {
    id = 'saved'
    tone = 'good'
    icon = <CheckIcon />
    text = 'Key saved in this browser.'
  } else if (check.state === 'idle') {
    id = 'idle'
    icon = <LockIcon />
    text = 'Paste the key. It is checked with OpenRouter before it is saved.'
  } else if (check.state === 'format') {
    id = `format:${check.message}`
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = check.message
  } else if (check.state === 'checking') {
    id = 'checking'
    icon = <Spinner />
    text = 'Checking with OpenRouter…'
  } else if (check.result.status === 'valid') {
    id = 'valid'
    tone = 'good'
    icon = <CheckIcon />
    text =
      check.result.remaining === null ? (
        'Key works. No spending limit is set on it.'
      ) : (
        <>
          Key works. <span className="tabular font-medium">{formatCredit(check.result.remaining)}</span> of credit
          remaining.
        </>
      )
  } else if (check.result.status === 'invalid') {
    id = 'invalid'
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = 'OpenRouter does not recognize this key. Check that it was copied whole and has not been revoked.'
  } else if (check.result.status === 'offline') {
    id = 'offline'
    tone = 'warn'
    icon = <WifiOffIcon />
    text = 'Could not reach OpenRouter to check the key. You can save it; it is checked when first used.'
  } else {
    id = 'unverified'
    tone = 'warn'
    icon = <CircleAlertIcon />
    text = `OpenRouter could not check the key right now (HTTP ${check.result.httpStatus}). You can save it; it is checked when first used.`
  }

  return (
    <SwapLabel id={id} block>
      <span
        data-key-status={id.split(':')[0]}
        className={cn(
          'flex items-start gap-1.5 [&_svg]:mt-[3px] [&_svg]:size-3.5 [&_svg]:shrink-0',
          tone === 'quiet' && 'text-muted-foreground',
          tone === 'bad' && 'text-destructive',
          tone === 'good' && 'text-success',
          tone === 'warn' && 'text-warning',
        )}
      >
        {icon}
        <span>{text}</span>
      </span>
    </SwapLabel>
  )
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="animate-spin-fast" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.75" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Swaps its content when `id` changes: the old content fades out and the new
 * fades in, with a slight blur and rise so the eye reads one thing changing
 * and not two things overlapping. Reduced motion keeps the fade only.
 */
function SwapLabel({ id, block = false, children }: { id: string; block?: boolean; children: ReactNode }) {
  const reduce = useReducedMotion()
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(3px)', transform: 'translateY(3px)' }
  const shown = reduce ? { opacity: 1 } : { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' }
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={id}
        initial={hidden}
        animate={shown}
        exit={{ ...hidden, transition: { duration: 0.1, ease: [0.23, 1, 0.32, 1] } }}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        className={cn(block ? 'block' : 'inline-flex items-center gap-1.5')}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}
