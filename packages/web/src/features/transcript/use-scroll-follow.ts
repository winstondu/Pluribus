import type { ConversationFrame, ConversationSnapshot } from '@committee/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useBackendStore } from '@/backend'

/** How close to the end counts as "at the live bottom", in px. */
const BOTTOM_THRESHOLD = 32

type FrameEffect = 'none' | 'output' | 'own-message'

/**
 * What a frame means for scrolling. A message the transcript has not seen
 * is the user's own submission; a change to a reply, a section or an
 * attempt is new output. Chain, queue, genealogy and operation-graph
 * patches show nothing new in the transcript.
 */
function effectOf(frame: ConversationFrame, known: Set<string>): FrameEffect {
  let effect: FrameEffect = 'none'
  for (const patch of frame.patches) {
    switch (patch.target) {
      case 'transcript.message':
        if (patch.value === null) known.delete(patch.id)
        else if (!known.has(patch.id)) {
          known.add(patch.id)
          effect = 'own-message'
        }
        break
      case 'transcript.attempt-text':
        if (effect === 'none') effect = 'output'
        break
      case 'transcript.response':
      case 'transcript.section':
      case 'transcript.attempt':
        if (patch.value !== null && effect === 'none') effect = 'output'
        break
      default:
        break
    }
  }
  return effect
}

export interface ScrollFollow {
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly content: (node: HTMLDivElement | null) => void
  /** True while output has arrived that a reader who scrolled away has not gone to. */
  readonly hasNewOutput: boolean
  onScroll(): void
  /** "New output ↓": go to the live bottom and follow again. */
  jumpToBottom(): void
}

/**
 * Scroll following (03 · "Scrolling", Q15, P5).
 *
 * - While the reader is at the live bottom, new output is followed: the
 *   view stays pinned to the end as content grows.
 * - Once the reader has scrolled away, nothing here ever sets the scroll
 *   position again. New output only raises `hasNewOutput`, which shows
 *   "New output ↓".
 * - Sending a message is the reader's own act, so it returns them to the
 *   bottom and resumes following.
 */
export function useScrollFollow(): ScrollFollow {
  const scroller = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  const [hasNewOutput, setHasNewOutput] = useState(false)
  const store = useBackendStore()

  const pin = useCallback(() => {
    const element = scroller.current
    if (!element || !following.current) return
    const top = element.scrollHeight - element.clientHeight
    if (top > element.scrollTop) element.scrollTop = top
    lastTop.current = element.scrollTop
  }, [])

  // A conversation opens at its live bottom.
  useLayoutEffect(() => {
    pin()
  }, [pin])

  const onScroll = useCallback(() => {
    const element = scroller.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const movedUp = element.scrollTop < lastTop.current
    lastTop.current = element.scrollTop
    if (movedUp && distance > 1) {
      // Any move up is the reader leaving, however small: they are not pulled back.
      following.current = false
    } else if (distance <= BOTTOM_THRESHOLD) {
      following.current = true
      setHasNewOutput(false)
    }
  }, [])

  useEffect(() => {
    // The messages already drawn. Filled when the conversation's snapshot is in the store, which can be
    // after this mounts; until then no frame can be told apart from the conversation loading.
    let known: Set<string> | null = null
    const learn = (): void => {
      const messages = store.getState().conversation?.transcript.messages
      if (known === null && messages) known = new Set(Object.keys(messages))
    }
    learn()
    const unsubscribeStore = store.subscribe(learn)
    let raf = 0
    const unsubscribe = store.onConversationFrame((frame: ConversationFrame, _snapshot: ConversationSnapshot) => {
      if (known === null) {
        learn()
        return
      }
      const effect = effectOf(frame, known)
      if (effect === 'none') return
      if (effect === 'own-message') following.current = true
      if (!following.current) {
        setHasNewOutput(true)
        return
      }
      // After React has drawn the frame; the size observer below covers growth that comes later.
      queueMicrotask(pin)
      if (typeof requestAnimationFrame === 'function') {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(pin)
      }
    })
    return () => {
      unsubscribe()
      unsubscribeStore()
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
  }, [store, pin])

  // Content that grows without a frame (highlighted code arriving, the dock resizing the pane).
  const observer = useRef<ResizeObserver | null>(null)
  const observed = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const created = new ResizeObserver(pin)
    observer.current = created
    if (scroller.current) created.observe(scroller.current)
    if (observed.current) created.observe(observed.current)
    return () => {
      created.disconnect()
      observer.current = null
    }
  }, [pin])

  // The content element comes and goes with the empty state, so it is observed as it mounts.
  const content = useCallback((node: HTMLDivElement | null) => {
    if (observed.current) observer.current?.unobserve(observed.current)
    observed.current = node
    if (node) {
      observer.current?.observe(node)
      pin()
    }
  }, [pin])

  const jumpToBottom = useCallback(() => {
    const element = scroller.current
    if (!element) return
    following.current = true
    setHasNewOutput(false)
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const top = element.scrollHeight - element.clientHeight
    if (reduce || typeof element.scrollTo !== 'function') element.scrollTop = top
    else element.scrollTo({ top, behavior: 'smooth' })
  }, [])

  return { scroller, content, hasNewOutput, onScroll, jumpToBottom }
}
