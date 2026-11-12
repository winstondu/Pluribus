import type { DecompositionView, MessageId, TranscriptProjection } from '@committee/protocol'
import { XIcon } from 'lucide-react'
import { useUiState } from '@/app/ui-state'
import { useApp, useTranscript } from '@/backend'
import { Button } from '@/components/ui/button'
import { EmptyState } from '../parts'
import { CompareHeading, FragmentDetail, SourceSection, useFragmentSelection } from './compare-parts'

export { RequirementItem } from './compare-parts'

/**
 * The decompositions Compare can open. Split messages are always available
 * (Q53, Q87); an independent composite only behind its debug toggle (Q94).
 */
export function listDecompositions(
  transcript: TranscriptProjection,
  includeIndependent: boolean,
): { messageId: MessageId; decomposition: DecompositionView }[] {
  const found: { messageId: MessageId; decomposition: DecompositionView }[] = []
  const seen = new Set<string>()
  for (const item of transcript.order) {
    if (item.kind !== 'message') continue
    const message = transcript.messages[item.id]
    if (!message) continue
    const split = message.split ? transcript.splits[message.split.originalMessageId] : undefined
    if (split && !seen.has(split.originalMessageId)) {
      seen.add(split.originalMessageId)
      found.push({ messageId: split.originalMessageId, decomposition: split.decomposition })
    }
    if (message.decomposition && includeIndependent && !seen.has(message.id)) {
      seen.add(message.id)
      found.push({ messageId: message.id, decomposition: message.decomposition })
    }
  }
  return found
}

function findDecomposition(transcript: TranscriptProjection, messageId: MessageId): DecompositionView | null {
  return transcript.splits[messageId]?.decomposition ?? transcript.messages[messageId]?.decomposition ?? null
}

/**
 * The Compare decomposition inspector (09 §3): the exact original message
 * beside each fragment's rewritten instruction, and the requirements each
 * fragment inherited with where they came from. It exists so that a lost
 * constraint can be traced to decomposition. Its parts are shared with the
 * card on the message (`compare-card.tsx`).
 */
export function Compare() {
  const transcript = useTranscript()
  const compare = useUiState((state) => state.compare)
  const openCompare = useUiState((state) => state.openCompare)
  const includeIndependent = useApp()?.settings.debug.compareIndependent ?? false
  const decomposition = compare ? findDecomposition(transcript, compare) : null

  if (!decomposition) {
    const available = listDecompositions(transcript, includeIndependent)
    return (
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {available.length === 0 ? (
          <EmptyState title="No decomposed message here">
            When a message is split into parts, this shows its exact text beside what each part was asked.
          </EmptyState>
        ) : (
          <div className="px-4 py-3">
            <p className="text-xs leading-relaxed text-muted-foreground">Choose a message to see how it was split.</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {available.map((entry) => (
                <li key={entry.messageId}>
                  <button
                    type="button"
                    className="pressable w-full rounded-md border border-border bg-background px-2.5 py-2 text-left text-xs leading-relaxed hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => openCompare(entry.messageId)}
                  >
                    <span className="line-clamp-2">{entry.decomposition.originalText}</span>
                    <span className="mt-1 block text-2xs text-muted-foreground">
                      {entry.decomposition.fragments.length} parts ·{' '}
                      {entry.decomposition.presentation === 'split-messages' ? 'split messages' : 'one reply with sections'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  return <CompareView key={decomposition.originalMessageId} decomposition={decomposition} onClose={() => openCompare(null)} />
}

function CompareView({ decomposition, onClose }: { decomposition: DecompositionView; onClose(): void }) {
  const [selected, select] = useFragmentSelection(decomposition)
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto" data-testid="compare">
      <CompareHeading
        decomposition={decomposition}
        action={
          <Button variant="ghost" size="icon-sm" aria-label="Close Compare" onClick={onClose}>
            <XIcon />
          </Button>
        }
      />
      <SourceSection decomposition={decomposition} selected={selected} />
      <FragmentDetail decomposition={decomposition} selected={selected} onSelect={select} columns="fixed" />
    </div>
  )
}
