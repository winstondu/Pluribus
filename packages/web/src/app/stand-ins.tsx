import type { AttemptId, MessageId, ResponseId, SectionId, SectionView } from '@committee/protocol'
import { ArrowUpIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  useActiveConversationId,
  useApp,
  useAttempt,
  useChain,
  useMessage,
  useQueue,
  useResponse,
  useSection,
  useSend,
  useTranscript,
  useTranscriptOrder,
} from '@/backend'
import { Button } from '@/components/ui/button'
import { chainColor, chainSegments } from '@/design/chains'
import { cn } from '@/lib/utils'
import { useUiState } from './ui-state'

/**
 * Stand-ins for the transcript and the composer, shown only while the
 * `transcript` and `composer` features do not exist. They render the
 * projections plainly, with no controls beyond Send, so the shell and the
 * fixture gallery are usable from the first commit. The features replace
 * them through `@/app/features` without touching this file.
 */

function Rail({ colorIndexes }: { colorIndexes: readonly number[] }) {
  return <span aria-hidden className="chain-rail" style={{ background: chainSegments(colorIndexes) }} />
}

function MessageRow({ id }: { id: MessageId }) {
  const message = useMessage(id)
  const chains = useTranscript().chains
  if (!message) return null
  const colors = message.chainIds.flatMap((chainId) => {
    const chain = chains[chainId]
    return chain ? [chain.colorIndex] : []
  })
  return (
    <article className="flex gap-3.5" data-message-id={id}>
      <Rail colorIndexes={colors} />
      <div className="min-w-0 py-0.5">
        <p className="text-xs font-medium text-muted-foreground">You</p>
        <p className="mt-1 text-prose whitespace-pre-wrap">{message.text}</p>
      </div>
    </article>
  )
}

function AttemptText({ id, className }: { id: AttemptId; className?: string }) {
  const attempt = useAttempt(id)
  if (!attempt) return null
  return (
    <>
      {attempt.text ? <p className={cn('text-prose whitespace-pre-wrap', className)}>{attempt.text}</p> : null}
      {attempt.markText ? <p className="mt-1 text-xs text-muted-foreground">{attempt.markText}</p> : null}
    </>
  )
}

function SectionBlock({ id, grouped }: { id: SectionId; grouped: boolean }) {
  const section = useSection(id)
  return section ? <SectionBody section={section} grouped={grouped} /> : null
}

function SectionBody({ section, grouped }: { section: SectionView; grouped: boolean }) {
  const chain = useChain(section.chainId)
  const lastAttemptId = section.attemptIds.at(-1)
  return (
    <div className="flex gap-3.5" data-section-id={section.id} data-state={section.state}>
      <span
        aria-hidden
        className="chain-rail"
        style={{ background: chain ? chainColor(chain.colorIndex) : 'var(--border-strong)' }}
      />
      <div className="min-w-0 flex-1 py-0.5">
        {grouped ? <p className="mb-1 text-[0.8125rem] font-medium">{section.title}</p> : null}
        {lastAttemptId ? (
          <AttemptText id={lastAttemptId} className={section.state === 'superseded' ? 'text-muted-foreground' : undefined} />
        ) : null}
        {section.status ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="animate-pending size-1.5 rounded-full bg-current" />
            {section.status.text}
          </p>
        ) : null}
        {section.state === 'failed' && section.failure ? (
          <p className="mt-1 text-sm text-destructive">{section.failure.message}</p>
        ) : null}
        {section.superseded ? <p className="mt-1 text-xs text-muted-foreground">{section.superseded.markText}</p> : null}
        {section.notes.map((note) => (
          <p key={note.kind + note.text} className="mt-1 text-xs text-muted-foreground">
            {note.text}
          </p>
        ))}
      </div>
    </div>
  )
}

function ResponseRow({ id }: { id: ResponseId }) {
  const response = useResponse(id)
  if (!response) return null
  return (
    <article className="flex flex-col gap-3" data-response-id={id} data-placement={response.placement}>
      <p className="flex items-baseline gap-2 pl-[calc(var(--spacing-rail)+0.875rem)] text-xs">
        <span className="font-medium text-muted-foreground">Committee</span>
        {response.header?.countText ? <span className="tabular text-faint-foreground">{response.header.countText}</span> : null}
      </p>
      {response.routing ? (
        <div className="flex gap-3.5">
          <span aria-hidden className="chain-rail bg-border-strong" />
          <p className={cn('flex items-center gap-2 py-0.5 text-sm text-muted-foreground', response.routing.state === 'failed' && 'text-destructive')}>
            {response.routing.state === 'failed' ? null : (
              <span aria-hidden className="animate-pending size-1.5 rounded-full bg-current" />
            )}
            {response.routing.text}
          </p>
        </div>
      ) : null}
      {response.sectionIds.map((sectionId) => (
        <SectionBlock key={sectionId} id={sectionId} grouped={response.grouped} />
      ))}
    </article>
  )
}

export function TranscriptStandIn() {
  const order = useTranscriptOrder()
  if (order.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6">
        <div className="max-w-sm text-center">
          <h2 className="display">One chat, many lines of work</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Ask for several things at once, or keep asking while an answer is still being written. Each request runs on
            its own and takes its place when its first words arrive.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto" data-stand-in="transcript">
      <div className="mx-auto flex w-full max-w-(--spacing-transcript) flex-col gap-7 px-4 py-8 sm:px-6">
        {order.map((item) =>
          item.kind === 'message' ? <MessageRow key={item.id} id={item.id} /> : <ResponseRow key={item.id} id={item.id} />,
        )}
      </div>
    </div>
  )
}

export function ComposerStandIn() {
  const app = useApp()
  const send = useSend()
  const conversationId = useActiveConversationId()
  const queue = useQueue()
  const openKeyPrompt = useUiState((state) => state.openKeyPrompt)
  const [text, setText] = useState('')
  const hasKey = app?.key.configured === true

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || !conversationId || !hasKey) return
    setText('')
    void send({ type: 'submit-message', conversationId, text: trimmed })
  }

  return (
    <div className="shrink-0 px-4 pb-4 sm:px-6" data-stand-in="composer">
      <div className="mx-auto w-full max-w-(--spacing-transcript)">
        {queue.items.length > 0 ? (
          <ul className="mb-2 flex flex-col gap-1">
            {queue.items.map((item) => (
              <li key={item.id} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
                {item.text}
              </li>
            ))}
          </ul>
        ) : null}
        <form
          onSubmit={submit}
          className="rounded-2xl border border-border-strong/70 bg-surface shadow-raised transition-[border-color,box-shadow] duration-(--duration-fast) focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
        >
          {hasKey ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              rows={2}
              aria-label="Message"
              placeholder="Ask anything. Ask again while it answers."
              className="block w-full resize-none bg-transparent px-4 pt-3.5 text-prose outline-none placeholder:text-faint-foreground"
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5 pb-1">
              <p className="text-sm text-muted-foreground">Add an OpenRouter key to send messages</p>
              <Button type="button" variant="outline" size="sm" onClick={openKeyPrompt}>
                Add key
              </Button>
            </div>
          )}
          <div className="flex items-center justify-end px-2.5 pb-2.5">
            <Button type="submit" size="icon" aria-label="Send" disabled={!hasKey || !conversationId || text.trim() === ''} className="rounded-full">
              <ArrowUpIcon />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
