import type { SectionId } from '@committee/protocol'
import { WORDING } from '@committee/protocol'
import { ArrowUpIcon, CornerDownLeftIcon, XIcon } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useStore } from 'zustand'
import { useUiState } from '@/app/ui-state'
import { useActiveConversationId, useApp, useBackendStore, useSection } from '@/backend'
import { Button } from '@/components/ui/button'
import { useCommand } from '@/features/transcript'

/**
 * The composer: text entry, the explicit reply targets chosen with "Reply
 * to this", and Send. Sending is always possible while a conversation is
 * open and a key is configured, whatever else is running: the backend
 * decides what the message waits for.
 */
export function ComposerInput() {
  const app = useApp()
  const command = useCommand()
  const conversationId = useActiveConversationId()
  const store = useBackendStore()
  const openKeyPrompt = useUiState((state) => state.openKeyPrompt)
  const replyTargets = useUiState((state) => state.replyTargets)
  const clearReplyTargets = useUiState((state) => state.clearReplyTargets)
  const [text, setText] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const hasKey = app?.key.configured === true
  const canSend = hasKey && conversationId !== null && text.trim() !== ''

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = text.trim()
    if (!canSend) return
    // A target whose section is gone (a dropped bubble) is not sent. A superseded one is: the backend resolves it (Q43).
    const sections = store.getState().conversation?.transcript.sections ?? {}
    const targets = replyTargets.filter((sectionId) => sections[sectionId] !== undefined)
    setText('')
    clearReplyTargets()
    void command({ type: 'submit-message', text: trimmed, ...(targets.length > 0 ? { targets } : {}) }).then((result) => {
      // A rejected message goes back into the box so nothing typed is lost.
      if (result && !result.ok) setText((current) => (current === '' ? trimmed : current))
    })
  }

  return (
    <form
      onSubmit={submit}
      data-slot="composer"
      className="rounded-2xl border border-border-strong/70 bg-surface shadow-raised transition-[border-color,box-shadow] duration-(--duration-fast) focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
    >
      {replyTargets.length > 0 ? <ReplyTargets targets={replyTargets} /> : null}
      {hasKey ? (
        <textarea
          ref={textarea}
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
          placeholder={replyTargets.length > 0 ? 'Write your reply' : 'Ask anything. Ask again while it answers.'}
          className="scroll-quiet block field-sizing-content max-h-48 min-h-[3.25rem] w-full resize-none bg-transparent px-4 pt-3.5 text-prose outline-none placeholder:text-faint-foreground"
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
        <Button type="submit" size="icon" aria-label="Send" disabled={!canSend} className="rounded-full">
          <ArrowUpIcon />
        </Button>
      </div>
    </form>
  )
}

/**
 * The explicit reply targets, one chip per section, each removable. A
 * target that was superseded after it was chosen is shown as its
 * replacement with the fixed note; the message will go to the revised
 * version (Q43).
 */
function ReplyTargets({ targets }: { targets: readonly SectionId[] }) {
  const anyRevised = useStore(useBackendStore(), (state) =>
    targets.some((sectionId) => state.conversation?.transcript.sections[sectionId]?.state === 'superseded'),
  )
  return (
    <div data-slot="reply-targets" className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
      <span className="inline-flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
        <CornerDownLeftIcon aria-hidden className="size-3.5 text-faint-foreground" />
        {anyRevised ? WORDING.replyingToRevised : 'Replying to'}
      </span>
      {targets.map((sectionId) => (
        <ReplyTargetChip key={sectionId} sectionId={sectionId} />
      ))}
    </div>
  )
}

function ReplyTargetChip({ sectionId }: { sectionId: SectionId }) {
  const section = useSection(sectionId)
  const toggleReplyTarget = useUiState((state) => state.toggleReplyTarget)
  const revealSection = useUiState((state) => state.revealSection)
  // What the chip names and goes to: the section, or its replacement once it was superseded.
  const replacementId = section?.state === 'superseded' ? (section.superseded?.replacementSectionId ?? null) : null
  const replacement = useStore(useBackendStore(), (state) =>
    replacementId ? state.conversation?.transcript.sections[replacementId] : undefined,
  )
  if (!section) return null
  const shown = replacement ?? section
  return (
    <span data-reply-target={sectionId} className="inline-flex h-6 max-w-full items-center rounded-full border border-border bg-muted/60 pl-2.5 text-xs">
      <button
        type="button"
        onClick={() => revealSection(shown.id)}
        className="truncate rounded-sm font-medium underline-offset-4 hover:underline"
      >
        {shown.title}
      </button>
      <button
        type="button"
        aria-label={`Remove reply target ${shown.title}`}
        onClick={() => toggleReplyTarget(sectionId)}
        className="pressable ml-0.5 grid size-6 flex-none place-items-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  )
}
