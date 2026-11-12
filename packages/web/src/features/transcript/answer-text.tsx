import { memo } from 'react'
import { MessageResponse } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import './answer-text.css'

/**
 * Answer text, as Markdown, through the AI Elements response component
 * (Streamdown). While the attempt streams, incomplete Markdown is closed so
 * a half-written list or code fence does not flicker.
 */
export const AnswerText = memo(function AnswerText({ text, streaming, muted }: { text: string; streaming: boolean; muted?: boolean }) {
  return (
    <MessageResponse
      className={cn('answer-text text-prose', muted && 'text-muted-foreground')}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
    >
      {text}
    </MessageResponse>
  )
})
