import { toast } from 'sonner'
import { useOpenConversation, useSend } from '@/backend'
import { useUiState } from './ui-state'

/**
 * Create a conversation and open it. Every "New conversation" control uses
 * this, so creating one always lands the user in it (10 · Screens).
 * Resolves to whether it was created.
 */
export function useCreateConversation(): () => Promise<boolean> {
  const send = useSend()
  const openConversation = useOpenConversation()
  const resetForConversation = useUiState((state) => state.resetForConversation)
  return async () => {
    const result = await send({ type: 'create-conversation' })
    if (!result.ok) {
      toast.error('Could not start a conversation', { description: result.error.message })
      return false
    }
    resetForConversation()
    openConversation(result.output.conversation.id)
    return true
  }
}
