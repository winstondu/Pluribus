import type { KeyCheck, KeyProviderName } from '@pluribus/protocol'
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LockIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WifiOffIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useApp, type KeyProvision } from '@/backend'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { BrandMark } from './brand'
import { useKeyProvision } from './environment'
import { KEY_FORMATS, formatCredit, keyFormatProblem } from './key-validation'
import { useUiState } from './ui-state'

/**
 * The key prompt: the first-run experience, and the way a key is added or
 * replaced later. It asks for the OpenRouter key, which Pluribus needs.
 *
 * A key lives in this component's input state while it is typed and
 * checked, goes to the deployment's key provision once, and is then
 * dropped. It is never put in a store, `localStorage`, a URL or a backend
 * command, and this is the only file that reads `__DEV_OPENROUTER_KEY__`.
 *
 * In a deployment that does not take keys from the client
 * (`canProvideKeys` false) the prompt is never shown.
 */

type Check =
  | { readonly state: 'idle' }
  | { readonly state: 'format'; readonly message: string }
  | { readonly state: 'checking' }
  | { readonly state: 'result'; readonly result: KeyCheck }

type Saving = 'no' | 'typed' | 'environment' | 'saved'

const CHECK_DELAY_MS = 350

/** The keys from the dev server's environment. Empty in production builds and in tests. */
function environmentKey(): string {
  return typeof __DEV_OPENROUTER_KEY__ === 'string' ? __DEV_OPENROUTER_KEY__ : ''
}

const ENVIRONMENT_VARIABLE: { readonly [P in KeyProviderName]: string } = { openrouter: 'OPENROUTER_KEY' }

/** `keys` defaults to the app environment's key provision (the Worker's on the embedded backend, scripted with fixtures). */
export function KeyPrompt(props: { keys?: KeyProvision }) {
  const provided = useKeyProvision()
  const keys = props.keys ?? provided
  const open = useUiState((state) => state.keyPromptOpen)
  const closeKeyPrompt = useUiState((state) => state.closeKeyPrompt)
  // Keys that are not this client's to provide are never asked for.
  if (!keys.canProvideKeys) return null
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
        <KeyPromptBody keys={keys} onDone={closeKeyPrompt} />
      </DialogContent>
    </Dialog>
  )
}

/** One key being typed: its value, whether it is shown, and what the check says about it. */
interface KeyDraft {
  readonly provider: KeyProviderName
  readonly value: string
  readonly visible: boolean
  readonly check: Check
  setValue(value: string): void
  setVisible(visible: boolean): void
  /** Forgets the typed value. */
  clear(): void
  /** True when the typed key may be saved: the provider accepted it, or could not be asked. */
  readonly savable: boolean
  /** True when something is typed that may not be saved. */
  readonly blocking: boolean
}

function isSavable(result: KeyCheck): boolean {
  return result.status === 'valid' || result.status === 'offline' || result.status === 'unverified'
}

/** Format check at once; live check once the shape is plausible and typing has paused. */
function useKeyDraft(provider: KeyProviderName, keys: KeyProvision): KeyDraft {
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'idle' })

  useEffect(() => {
    const key = value.trim()
    if (key === '') {
      setCheck({ state: 'idle' })
      return
    }
    const problem = keyFormatProblem(key, provider)
    if (problem) {
      setCheck({ state: 'format', message: problem })
      return
    }
    setCheck({ state: 'checking' })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      keys.check(provider, key, controller.signal).then(
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
  }, [value, provider, keys])

  const result = check.state === 'result' ? check.result : null
  const savable = result !== null && isSavable(result)
  return {
    provider,
    value,
    visible,
    check,
    setValue,
    setVisible,
    clear: () => {
      setValue('')
      setVisible(false)
    },
    savable,
    blocking: value.trim() !== '' && !savable,
  }
}

function KeyPromptBody({ keys, onDone }: { keys: KeyProvision; onDone: () => void }) {
  const app = useApp()
  // Decided once per opening: saving the first key must not turn the prompt into "Replace your key" under the confirmation.
  const [replacing] = useState(() => app?.key.configured === true)
  const openRouter = useKeyDraft('openrouter', keys)
  const [saving, setSaving] = useState<Saving>('no')
  const [error, setError] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    },
    [],
  )

  const drafts = [openRouter]
  const typed = drafts.filter((draft) => draft.value.trim() !== '')
  // Something to save, and nothing typed that may not be saved.
  const canSave = saving === 'no' && typed.length > 0 && typed.every((draft) => draft.savable)
  const busy = saving !== 'no'

  async function save(entries: readonly { provider: KeyProviderName; key: string }[], how: Exclude<Saving, 'no' | 'saved'>): Promise<void> {
    setSaving(how)
    setError(null)
    let failure: string | null = null
    for (const entry of entries) {
      const outcome = await keys.set(entry.provider, entry.key)
      if (!outcome.ok) {
        failure = `The ${KEY_FORMATS[entry.provider].name} key was not saved: ${outcome.message}`
        break
      }
    }
    // The values are dropped whatever the outcome; a failed save is typed again.
    openRouter.clear()
    if (failure !== null) {
      setSaving('no')
      setError(failure)
      return
    }
    setSaving('saved')
    closeTimer.current = setTimeout(onDone, 900)
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    if (canSave) void save(typed.map((draft) => ({ provider: draft.provider, key: draft.value.trim() })), 'typed')
  }

  const heading = replacing ? 'Replace your OpenRouter key' : 'Bring your own OpenRouter key'
  const eyebrow = replacing ? 'OpenRouter key' : 'Before the first message'
  const primary = openRouter
  const format = KEY_FORMATS[primary.provider]
  const devKeys = drafts.flatMap((draft) => {
    const key = environmentKey()
    return key === '' ? [] : [{ provider: draft.provider, key }]
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-col">
      {/* On a short viewport this part scrolls and the actions stay in reach. */}
      <div className="scroll-quiet min-h-0 overflow-y-auto overscroll-contain px-6 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="eyebrow">{eyebrow}</span>
        </div>
        <DialogTitle className="mt-4 font-serif text-[1.75rem] leading-[1.15] font-[450] tracking-[-0.02em] text-balance">
          {heading}
        </DialogTitle>
        <DialogDescription className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          Pluribus runs every answer on models you reach through OpenRouter, billed to your account. The key is kept in this browser and sent only to OpenRouter.
        </DialogDescription>

        <KeyField draft={primary} label="API key" disabled={busy} saving={saving} error={error} className="mt-5" />
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-muted/50 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <a
            href={format.keysUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Create a key at {format.site}
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </a>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onDone} disabled={saving === 'typed' || saving === 'environment'}>
              {replacing ? 'Cancel' : 'Not now'}
            </Button>
            <Button type="submit" disabled={!canSave} className="min-w-[5.5rem]">
              <SwapLabel id={saving === 'saved' ? 'saved' : saving === 'typed' ? 'saving' : typed.length > 1 ? 'save-both' : 'save'}>
                {saving === 'saved' ? (
                  <>
                    <CheckIcon /> Saved
                  </>
                ) : saving === 'typed' ? (
                  'Saving…'
                ) : typed.length > 1 ? (
                  'Save keys'
                ) : (
                  'Save key'
                )}
              </SwapLabel>
            </Button>
          </div>
        </div>

        {devKeys.length > 0 ? (
          <button
            type="button"
            onClick={() => void save(devKeys, 'environment')}
            disabled={busy}
            className="pressable group flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border-strong bg-surface/60 px-3 py-2 text-left hover:bg-surface disabled:opacity-60"
          >
            <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">
                {saving === 'environment' ? 'Saving…' : devKeys.length > 1 ? 'Use the keys from this environment' : 'Use the key from this environment'}
              </span>
              <span className="block text-2xs text-muted-foreground">
                {devKeys.map((entry) => ENVIRONMENT_VARIABLE[entry.provider]).join(' and ')} {devKeys.length > 1 ? 'are' : 'is'} set on the dev
                server. Not offered in production builds.
              </span>
            </span>
          </button>
        ) : null}
      </div>
    </form>
  )
}

/** One key's field: the input with show/hide, and the line under it saying what is known about the key. */
function KeyField(props: { draft: KeyDraft; label: string; disabled: boolean; saving: Saving; error: string | null; className?: string }) {
  const { draft } = props
  const inputId = useId()
  const statusId = useId()
  const result = draft.check.state === 'result' ? draft.check.result : null
  const invalid = draft.check.state === 'format' || result?.status === 'invalid' || result?.status === 'blocked'
  const good = result?.status === 'valid' && result.credit.kind !== 'exhausted'
  return (
    <div className={props.className} data-key-field={draft.provider}>
      <label htmlFor={inputId} className="text-xs font-medium text-foreground">
        {props.label}
      </label>
      <div
        className={cn(
          'mt-1.5 flex h-10 items-center gap-1 rounded-lg border border-input bg-surface pr-1 pl-3 transition-[border-color,box-shadow] duration-(--duration-fast)',
          'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30',
          invalid && 'border-destructive/60 focus-within:border-destructive/60 focus-within:ring-destructive/15',
          good && 'border-success/50 focus-within:border-success/60 focus-within:ring-success/15',
        )}
      >
        <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-faint-foreground" />
        <input
          id={inputId}
          data-key-input
          type={draft.visible ? 'text' : 'password'}
          value={draft.value}
          onChange={(event) => draft.setValue(event.target.value)}
          placeholder={KEY_FORMATS[draft.provider].placeholder}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={props.disabled}
          aria-invalid={invalid}
          aria-describedby={statusId}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[0.8125rem] tracking-tight outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-faint-foreground"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={draft.visible ? 'Hide key' : 'Show key'}
          aria-pressed={draft.visible}
          onClick={() => draft.setVisible(!draft.visible)}
          disabled={props.disabled}
          className="text-muted-foreground"
        >
          {draft.visible ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>

      <div id={statusId} aria-live="polite" className="mt-2 min-h-10 text-xs leading-5">
        <StatusLine provider={draft.provider} check={draft.check} saving={props.saving} error={props.error} />
      </div>
    </div>
  )
}

/**
 * The line under a field. One message at a time; the swap is a short fade
 * so the state change is legible. Both providers are described in the same
 * terms: recognized or not, and what is known about the credit behind the
 * key.
 */
function StatusLine({ provider, check, saving, error }: { provider: KeyProviderName; check: Check; saving: Saving; error: string | null }) {
  const name = KEY_FORMATS[provider].name
  let id: string
  let tone: 'quiet' | 'bad' | 'good' | 'warn' = 'quiet'
  let icon: ReactNode = null
  let text: ReactNode

  if (error) {
    id = 'error'
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = `${error} Paste it again to retry.`
  } else if (saving === 'saved') {
    id = 'saved'
    tone = 'good'
    icon = <CheckIcon />
    text = 'Saved in this browser.'
  } else if (check.state === 'idle') {
    id = 'idle'
    icon = <LockIcon />
    text = `Paste the key. It is checked with ${name} before it is saved.`
  } else if (check.state === 'format') {
    id = `format:${check.message}`
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = check.message
  } else if (check.state === 'checking') {
    id = 'checking'
    icon = <Spinner />
    text = `Checking with ${name}…`
  } else if (check.result.status === 'valid') {
    const credit = check.result.credit
    id = `valid-${credit.kind}`
    tone = 'good'
    icon = <CheckIcon />
    if (credit.kind === 'remaining') {
      text = (
        <>
          Key works. <span className="tabular font-medium">{formatCredit(credit.dollars)}</span> of credit remaining.
        </>
      )
    } else if (credit.kind === 'unlimited') {
      text = 'Key works. No spending limit is set on it.'
    } else if (credit.kind === 'available') {
      text = `Key works, and a one-token test request was accepted, so the account has credit. ${name} does not let a key read its balance.`
    } else if (credit.kind === 'exhausted') {
      tone = 'warn'
      icon = <CircleAlertIcon />
      text = `Key works, but ${name} refused a one-token test request for lack of credit or at a spend limit. You can save it; runs will fail until credit is added.`
    } else {
      tone = 'warn'
      icon = <CircleAlertIcon />
      text = `Key works. Whether the account has credit could not be determined right now; ${name} does not let a key read its balance.`
    }
  } else if (check.result.status === 'invalid') {
    id = 'invalid'
    tone = 'bad'
    icon = <CircleAlertIcon />
    text = `${name} does not recognize this key. Check that it was copied whole and has not been revoked.`
  } else if (check.result.status === 'blocked') {
    id = 'blocked'
    tone = 'bad'
    icon = <ShieldAlertIcon />
    text = `${check.result.reason} Pluribus calls ${name} from this browser, so this key cannot be used here.`
  } else if (check.result.status === 'offline') {
    id = 'offline'
    tone = 'warn'
    icon = <WifiOffIcon />
    text = `Could not reach ${name} to check the key. You can save it; it is checked when first used.`
  } else {
    id = 'unverified'
    tone = 'warn'
    icon = <CircleAlertIcon />
    text = `${name} could not check the key right now (HTTP ${check.result.httpStatus}). You can save it; it is checked when first used.`
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
