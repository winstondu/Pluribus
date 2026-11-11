/** Number of chain color tokens (`--chain-0` … `--chain-7` in `index.css`). */
export const CHAIN_COLOR_COUNT = 8

/**
 * The CSS color of a chain. The backend assigns `colorIndex` when the chain
 * is created; the client never chooses or reorders. A ninth chain repeats
 * the first color.
 */
export function chainColor(colorIndex: number): string {
  const slot = ((Math.trunc(colorIndex) % CHAIN_COLOR_COUNT) + CHAIN_COLOR_COUNT) % CHAIN_COLOR_COUNT
  return `var(--chain-${slot})`
}

/** The same color as a quiet tint, for backgrounds behind chain-colored content. */
export function chainTint(colorIndex: number): string {
  const slot = ((Math.trunc(colorIndex) % CHAIN_COLOR_COUNT) + CHAIN_COLOR_COUNT) % CHAIN_COLOR_COUNT
  return `var(--chain-${slot}-tint)`
}

/**
 * A mark for several chains: hard segments, top to bottom, never a gradient
 * that would read as a third chain color (09 §2). Returns a CSS `background`
 * value for a vertical rail.
 */
export function chainSegments(colorIndexes: readonly number[]): string {
  if (colorIndexes.length === 0) return 'transparent'
  if (colorIndexes.length === 1) return chainColor(colorIndexes[0] ?? 0)
  const step = 100 / colorIndexes.length
  const stops = colorIndexes.map((index, i) => {
    const from = (i * step).toFixed(3)
    const to = ((i + 1) * step).toFixed(3)
    return `${chainColor(index)} ${from}% ${to}%`
  })
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}
