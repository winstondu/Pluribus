/** Number of chain color tokens (`--chain-0` … `--chain-7` in `index.css`). */
export const CHAIN_COLOR_COUNT = 8

/**
 * Chains past the eighth get a color derived from a token, so that no two
 * chains share one (01 · Chain colors: each chain has its own). Each round
 * of eight shifts lightness toward more contrast with the page
 * (`--chain-variant-l`, per theme, in `index.css`), changes chroma and turns
 * the hue a little, which keeps it apart from every token and from the other
 * rounds. Four rounds give 32 colors; a 33rd chain repeats the first.
 */
const VARIANTS: readonly ({ l: number; c: number; h: number } | null)[] = [
  null,
  { l: 1, c: 1, h: 18 },
  { l: 0.45, c: 0.45, h: -14 },
  { l: 1.5, c: 0.6, h: 30 },
]

/** Number of distinct chain colors before one repeats. */
export const CHAIN_COLOR_LIMIT = CHAIN_COLOR_COUNT * VARIANTS.length

/**
 * The CSS color of a chain. The backend assigns `colorIndex` when the chain
 * is created; the client never chooses or reorders.
 */
export function chainColor(colorIndex: number): string {
  const index = ((Math.trunc(colorIndex) % CHAIN_COLOR_LIMIT) + CHAIN_COLOR_LIMIT) % CHAIN_COLOR_LIMIT
  const token = `var(--chain-${index % CHAIN_COLOR_COUNT})`
  const variant = VARIANTS[Math.floor(index / CHAIN_COLOR_COUNT)]
  if (!variant) return token
  const hue = variant.h < 0 ? `h - ${-variant.h}` : `h + ${variant.h}`
  return `oklch(from ${token} calc(l + var(--chain-variant-l) * ${variant.l}) calc(c * ${variant.c}) calc(${hue}))`
}

/** The same color as a quiet tint, for backgrounds behind chain-colored content. */
export function chainTint(colorIndex: number): string {
  const index = ((Math.trunc(colorIndex) % CHAIN_COLOR_LIMIT) + CHAIN_COLOR_LIMIT) % CHAIN_COLOR_LIMIT
  if (index < CHAIN_COLOR_COUNT) return `var(--chain-${index}-tint)`
  return `color-mix(in oklab, ${chainColor(index)} 11%, transparent)`
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
