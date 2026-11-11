import { createContext, useContext, useState, type RefObject } from 'react'

/**
 * Motion values for the transcript and the composer dock, in one place so
 * every part moves in the same timing family. Curves and durations are the
 * design tokens of `index.css` (`--ease-out`, `--ease-in-out`,
 * `--duration-*`), written out because Motion takes numbers.
 *
 * What moves, and why:
 * - A transcript item or a section whose place in the order changed slides
 *   to its new place (`MOVE`): a reply overtaking a pending bubble, the
 *   bubble being pushed down, a section taking its place in a group. Only
 *   a change of order starts it; text streaming above an item never does,
 *   so nothing jitters while answers grow.
 * - A reply or a section that arrives fades in (`ENTER`); a user message
 *   appears at once, because sending is a keystroke the user makes all day.
 *   Panels in the dock (a queue item, a modal, "New output ↓") fade in with
 *   a short rise.
 * - Something dropped fades out, faster, while its neighbours close the gap
 *   at the same time (`EXIT`, with `popLayout`).
 * - Partial text folds by height (`COLLAPSE`) when the reader opens or
 *   closes it: it is an accordion. When the backend collapses it (a retry
 *   began, the section was superseded) it is drawn closed at once, in the
 *   commit that adds the line replacing it, so nothing below hops.
 * - A queue item opens and closes its own height with its fade, because its
 *   height is the transcript's bottom edge; it is not popped out of flow.
 *
 * Reduced motion: both features sit inside `MotionConfig
 * reducedMotion="user"`, which keeps the fades and drops transforms and
 * layout movement. Height is covered by `useReducedMotion()` where used.
 */
const EASE_OUT = [0.23, 1, 0.32, 1] as const
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const

export const MOVE = { duration: 0.26, ease: EASE_IN_OUT } as const
export const ENTER = { duration: 0.2, ease: EASE_OUT } as const
export const EXIT = { duration: 0.14, ease: EASE_OUT } as const
export const COLLAPSE = { duration: 0.22, ease: EASE_OUT } as const

/** The rise of something entering, in px. Small: the fade does most of the work. */
export const RISE = 6

/**
 * Whether things that mount should play their entrance. False while a
 * conversation is first drawn, so opening one shows it at rest; true from
 * then on, so only what arrives afterwards animates in.
 */
export const EntranceContext = createContext<RefObject<boolean>>({ current: true })

/** Read once, when the component mounts. */
export function useEntrance(): boolean {
  const entrances = useContext(EntranceContext)
  const [enter] = useState(() => entrances.current)
  return enter
}

/**
 * The last value that was defined. A record that is removed from the
 * projection (a dropped status-only bubble, split messages after Undo
 * split) is drawn from this while its element fades out; without it the
 * element would empty in one frame and the fade would show nothing.
 */
export function useKept<T>(value: T | undefined): T | undefined {
  const [kept, setKept] = useState(value)
  if (value !== undefined && value !== kept) setKept(value)
  return value ?? kept
}
