import type { Command, CommandResult, ConversationId } from '@committee/protocol'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useActiveConversationId, useSend } from '@/backend'

type ConversationCommand = Extract<Command, { readonly conversationId: ConversationId }>
/** A command without its `conversationId`, which `useCommand` fills in. */
export type CommandInput = ConversationCommand extends infer C ? (C extends unknown ? Omit<C, 'conversationId'> : never) : never

/**
 * Sends a command for the open conversation and reports a rejection as a
 * toast. Resolves with the backend's verdict, or null when no conversation
 * is open. What an accepted command causes arrives on the stream.
 */
export function useCommand(): (command: CommandInput) => Promise<CommandResult | null> {
  const send = useSend()
  const conversationId = useActiveConversationId()
  return useCallback(
    async (command: CommandInput) => {
      if (conversationId === null) return null
      const result = await send({ ...command, conversationId } as ConversationCommand)
      if (!result.ok) toast.error(result.error.message)
      return result
    },
    [send, conversationId],
  )
}
