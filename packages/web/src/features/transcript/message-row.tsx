import type { MessageId, MessageView, ReplyingToView } from '@committee/protocol'
import { WORDING } from '@committee/protocol'
import { CornerDownLeftIcon, RotateCwIcon, ScanSearchIcon, SquareIcon, Undo2Icon } from 'lucide-react'
import { Fragment, memo, useId } from 'react'
import { useUiState } from '@/app/ui-state'
import { useStore } from 'zustand'
import { useApp, useBackendStore, useMessage, useSplit } from '@/backend'
import { Button } from '@/components/ui/button'
import { ChainRail, useMessageFocus } from '@/features/association'
import { CompareCard, SourceMarks, useFragmentSelection } from '@/features/debug'
import { cn } from '@/lib/utils'
import { focusClass, FocusTag } from './focus-style'
import { useKept } from './motion'
import { useCommand } from './use-command'

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * A user message. It carries its rail, the reply target it was sent with,
 * and request-level controls. It never carries a status: pending status is
 * on the responding bubble (Q81, P7).
 */
export const MessageRow = memo(function MessageRow({ id }: { id: MessageId }) {
  const message = useKept(useMessage(id))
  return message ? <MessageBody message={message} /> : null
})

function MessageBody({ message }: { message: MessageView }) {
  const relation = useMessageFocus(message.id)
  const debug = useApp()?.settings.debug
  const inline = debug?.comparePlacement === 'inline'
  // Compare for an independent composite is behind its debug toggle (Q94).
  const decomposition = debug?.compareIndependent === true ? message.decomposition : null
  const open = useUiState((state) => state.inlineCompare.includes(message.id))
  const toggleInlineCompare = useUiState((state) => state.toggleInlineCompare)
  const [selected, select] = useFragmentSelection(decomposition)
  const cardId = useId()
  const card = inline && open && decomposition !== null ? decomposition : null
  // The message is the source: it carries the marks itself, unless its text is not the decomposed text.
  const marked = card !== null && card.originalText === message.text
  return (
    <div className="flex flex-col gap-2.5">
      {message.split && message.split.index > 0 ? (
        <SplitLink messageId={message.id} originalMessageId={message.split.originalMessageId} first={message.split.index === 1} />
      ) : null}
      <article
        aria-label="Your message"
        data-message-id={message.id}
        data-kind={message.kind}
        data-focus={relation}
        className={cn('flex gap-3.5', focusClass(relation))}
      >
        <ChainRail chainIds={message.chainIds} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
          <header className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-muted-foreground">You</span>
            <time dateTime={new Date(message.submittedAt).toISOString()} className="tabular text-faint-foreground">
              {TIME.format(message.submittedAt)}
            </time>
            {inline && decomposition !== null ? (
              <DecompositionToggle open={open} controls={cardId} onToggle={() => toggleInlineCompare(message.id)} />
            ) : null}
            <FocusTag relation={relation} reserve />
            <RequestControls message={message} />
          </header>
          {message.replyingTo ? <ReplyingTo replyingTo={message.replyingTo} /> : null}
          <p data-slot="message-text" className="text-prose break-words whitespace-pre-wrap">
            {marked ? <SourceMarks decomposition={card} selected={selected} inText /> : message.text}
          </p>
          {card !== null ? (
            <CompareCard id={cardId} decomposition={card} selected={selected} onSelect={select} showSource={!marked} />
          ) : null}
          {inline ? null : <DecompositionControl message={message} />}
        </div>
      </article>
    </div>
  )
}

/**
 * Shows or hides Compare on the message, when it is placed there. A quiet
 * text button in the header, so the message's height changes only by the
 * card itself.
 */
function DecompositionToggle(props: { open: boolean; controls: string; onToggle(): void }) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-controls={props.open ? props.controls : undefined}
      onClick={props.onToggle}
      className="pressable rounded-sm text-xs text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {props.open ? 'Hide decomposition' : 'Show decomposition'}
    </button>
  )
}

const MODE_SUFFIX = { explicit: null, inferred: 'inferred', elicited: 'you chose' } as const

/** The reply target the message was sent with; each names a section and goes to it. */
function ReplyingTo({ replyingTo }: { replyingTo: ReplyingToView }) {
  const revealSection = useUiState((state) => state.revealSection)
  if (replyingTo.targets.length === 0) return null
  const suffix = MODE_SUFFIX[replyingTo.mode]
  return (
    <p data-slot="replying-to" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <CornerDownLeftIcon aria-hidden className="size-3.5 flex-none text-faint-foreground" />
      <span>{replyingTo.note ?? 'Replying to'}</span>
      {replyingTo.note ? <span aria-hidden>·</span> : null}
      {replyingTo.targets.map((target, index) => (
        <Fragment key={target.sectionId}>
          {index > 0 ? <span aria-hidden>+</span> : null}
          <button
            type="button"
            onClick={() => revealSection(target.sectionId)}
            className="pressable rounded-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            {target.title}
          </button>
        </Fragment>
      ))}
      {suffix ? <span className="text-faint-foreground">· {suffix}</span> : null}
    </p>
  )
}

/**
 * Request-level Stop and Retry, as `message.actions` offers them. Controls
 * only: there is no status badge here and no arrow to pending work.
 *
 * They come and go while the request runs, so they sit at the end of the
 * header line and take no height of their own (the negative block margin
 * keeps a 24 px button inside the 16 px line): nothing under the message
 * moves when they appear or leave.
 */
function RequestControls({ message }: { message: MessageView }) {
  const command = useCommand()
  // A request answered by one section has the same Stop and Retry on that section, right below: one control, not two.
  const sole = useStore(useBackendStore(), (state) => {
    const transcript = state.conversation?.transcript
    if (!transcript) return undefined
    const sectionIds = message.responseIds.flatMap((responseId) => transcript.responses[responseId]?.sectionIds ?? [])
    const only = sectionIds.length === 1 && sectionIds[0] !== undefined ? transcript.sections[sectionIds[0]] : undefined
    return only?.actions
  })
  const stop = message.actions.stop && sole?.stop !== true
  const retry = message.actions.retry && sole?.retry !== true
  if (!stop && !retry) return null
  const target = { kind: 'request', messageId: message.id } as const
  return (
    <div data-slot="request-controls" className="-my-1 ml-auto flex flex-none items-center gap-0.5 self-center text-muted-foreground">
      {stop ? (
        <Button variant="ghost" size="xs" aria-label="Stop request" onClick={() => void command({ type: 'stop', target })}>
          <SquareIcon aria-hidden />
          Stop
        </Button>
      ) : null}
      {retry ? (
        <Button variant="ghost" size="xs" aria-label="Retry request" onClick={() => void command({ type: 'retry', target })}>
          <RotateCwIcon aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/** Inspect decomposition, behind its debug toggle. It stays for as long as the toggle is on, so it has its own line. */
function DecompositionControl({ message }: { message: MessageView }) {
  const openCompare = useUiState((state) => state.openCompare)
  const compareIndependent = useApp()?.settings.debug.compareIndependent === true
  if (!compareIndependent || message.decomposition === null) return null
  return (
    <div data-slot="decomposition-control" className="-ml-2 flex items-center text-muted-foreground">
      <Button variant="ghost" size="xs" onClick={() => openCompare(message.id)}>
        <ScanSearchIcon aria-hidden />
        Inspect decomposition
      </Button>
    </div>
  )
}

/**
 * The faint link that joins split messages (Q53). It opens Compare with the
 * exact original text, whatever the debug toggles say: in the side panel,
 * or, when Compare is placed on the message, as a card under the link.
 * Undo split sits beside the first link while the backend still offers it.
 */
function SplitLink(props: { messageId: MessageId; originalMessageId: MessageId; first: boolean }) {
  const { messageId, originalMessageId, first } = props
  const command = useCommand()
  const openCompare = useUiState((state) => state.openCompare)
  const toggleInlineCompare = useUiState((state) => state.toggleInlineCompare)
  const inline = useApp()?.settings.debug.comparePlacement === 'inline'
  const split = useSplit(originalMessageId)
  const undoAvailable = split?.undoAvailable === true
  const open = useUiState((state) => state.inlineCompare.includes(messageId))
  const [selected, select] = useFragmentSelection(split?.decomposition ?? null)
  const cardId = useId()
  const card = inline && open && split ? split.decomposition : null
  return (
    <div data-slot="split-link" className="-mt-4 flex gap-3.5">
      <span aria-hidden className="flex w-(--spacing-rail) flex-none justify-center self-stretch">
        <span className="w-px border-l border-dashed border-border-strong" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-expanded={inline ? open : undefined}
            aria-controls={card !== null ? cardId : undefined}
            onClick={() => (inline ? toggleInlineCompare(messageId) : openCompare(originalMessageId))}
            className="pressable rounded-sm text-xs text-faint-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-current"
          >
            {WORDING.splitLink}
          </button>
          {first && undoAvailable ? (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void command({ type: 'undo-split', originalMessageId })}>
              <Undo2Icon aria-hidden />
              Undo split
            </Button>
          ) : null}
        </div>
        {card !== null ? (
          <CompareCard id={cardId} decomposition={card} selected={selected} onSelect={select} showSource />
        ) : null}
      </div>
    </div>
  )
}
