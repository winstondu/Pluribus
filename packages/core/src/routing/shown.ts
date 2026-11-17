import { collapseShownText, type SectionId, type ShownAnswerForm, type ShownPiece, type ShownSection } from '@pluribus/protocol'
import type { AnswerSource, CandidateSection, DecisionContext } from '../ports'
import { lexicalTerms } from './candidates/lexical'
import { STATE_TOKENS_PER_CHARACTER } from './referents/ask'

/**
 * What a decision request shows of an answer section.
 *
 * Every listed section is shown by its line: title, request, and the
 * opening of its answer (`CandidateSection.excerpt`, 280 characters). A
 * section asked about by itself (a Point) is shown more of its answer, as
 * much as the request's budget allows, so that a part of the answer far
 * from its opening can be recognised:
 *
 * 1. `full`: the whole answer, when every Point's whole answer fits;
 * 2. `passages`: its opening and the passages of the answer that share the
 *    most words with the message, within the section's share;
 * 3. `opening`: the opening alone, as every listed section is shown.
 *
 * A stored context summary, where the summary provider has one, is shown
 * in place of the answer (`summary`) and is never expanded. The choice is
 * one function, `chooseShown`; the rest renders it.
 *
 * Pure and deterministic: the same sections, words and allowance give the
 * same lines.
 */

/** The form a section's answer is shown in, with the passages when it is `passages`. A summary is decided by the section's context, not here. */
export type ShownChoice =
  | { readonly form: 'full' }
  | { readonly form: 'passages'; readonly passages: readonly Span[] }
  | { readonly form: 'opening' }

export const OPENING: ShownChoice = { form: 'opening' }

/** Half-open character range into an answer's text. */
export interface Span {
  readonly start: number
  readonly end: number
}

/** The most characters one passage spans: a long block is cut into passages of about this size, at a space. */
export const PASSAGE_CHARACTERS = 600
/** The most passages shown for one section besides its opening. */
export const PASSAGES_SHOWN = 6

/** A piece of a line before it is recorded: an answer span carries the text it is read from. */
export type LinePiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'answer'; readonly source: AnswerSource; readonly start: number; readonly end: number }
  /** A stored summary as quoted in the line; recorded by its ID only, since no record may hold a summary (invariant 12). */
  | { readonly kind: 'summary'; readonly summaryId: string; readonly text: string }

/** A section's line as pieces, and the form its answer is shown in. */
export interface Line {
  readonly form: ShownAnswerForm
  readonly pieces: readonly LinePiece[]
}

export function renderLine(line: Line): string {
  return line.pieces.map((p) => (p.kind === 'answer' ? collapseShownText(p.source.text.slice(p.start, p.end)) : p.text)).join('')
}

/** The line as recorded: answer text by reference where the attempt is known, adjacent text merged. */
export function recordLine(sectionId: SectionId, line: Line): ShownSection {
  const out: ShownPiece[] = []
  const text = (t: string): void => {
    const last = out[out.length - 1]
    if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + t }
    else if (t) out.push({ kind: 'text', text: t })
  }
  for (const p of line.pieces) {
    if (p.kind === 'text') text(p.text)
    else if (p.kind === 'summary') out.push({ kind: 'summary', summaryId: p.summaryId, characters: p.text.length })
    else if (p.source.attemptId) out.push({ kind: 'answer', attemptId: p.source.attemptId, start: p.start, end: p.end })
    else text(collapseShownText(p.source.text.slice(p.start, p.end)))
  }
  return { sectionId, form: line.form, line: out }
}

function quote(text: string, max = 400): string {
  const flat = collapseShownText(text)
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`
}

/** The most of a summary shown in a section's line. */
export const SUMMARY_SHOWN = 600
/** The most messages of a section's own content shown after a summary: the latest ones. */
export const OWN_MESSAGES_SHOWN = 6

const SEPARATOR = '" … "'

/**
 * The texts the lines of one routing are made from: each section's answer,
 * and the message's words that passages are matched against. One per
 * routing; it keeps what it worked out about each answer.
 */
export interface Showing {
  /** The section's line as `S<n>`, its answer in the form chosen. With a summary, the summary stands for it whatever the choice. */
  line(section: CandidateSection, n: number, context: DecisionContext | null, choice?: ShownChoice): Line
  answer(section: CandidateSection): AnswerSource
  /** Whether the text at hand is the whole answer: only then can more than the opening be shown. */
  complete(section: CandidateSection): boolean
  /** The passages of the answer after its opening that share words with the message, best first. */
  passages(section: CandidateSection): readonly { readonly span: Span; readonly characters: number }[]
}

export function createShowing(options: { readonly answerOf?: ((section: CandidateSection) => AnswerSource) | undefined; readonly words?: readonly string[] | undefined }): Showing {
  const words = new Set(options.words ?? [])
  const answers = new Map<SectionId, AnswerSource>()
  const ranked = new Map<SectionId, readonly { readonly span: Span; readonly characters: number }[]>()
  const answer = (section: CandidateSection): AnswerSource => {
    const known = answers.get(section.sectionId)
    if (known) return known
    const given = options.answerOf?.(section)
    // The text given must be the answer the excerpt opens; anything else, and the excerpt is all there is.
    const source = given && given.text.startsWith(section.excerpt) ? given : { attemptId: section.attemptId ?? null, text: section.excerpt }
    answers.set(section.sectionId, source)
    return source
  }
  const complete = (section: CandidateSection): boolean => answer(section).text.length >= section.answerLength
  const passages = (section: CandidateSection): readonly { readonly span: Span; readonly characters: number }[] => {
    const known = ranked.get(section.sectionId)
    if (known) return known
    const found = complete(section) ? rankPassages(answer(section).text, section.excerpt.length, words) : []
    ranked.set(section.sectionId, found)
    return found
  }
  const line = (s: CandidateSection, n: number, context: DecisionContext | null, choice: ShownChoice = OPENING): Line => {
    if (s.asksElicitationId) return { form: 'opening', pieces: [{ kind: 'text', text: `S${n}. A question Pluribus asked the user, still unanswered: ${quote(s.excerpt || s.request)}` }] }
    if (context?.kind === 'summary') {
      const own = context.own.slice(-OWN_MESSAGES_SHOWN).map((m) => `${m.role === 'assistant' ? 'answer' : 'request'} ${quote(m.content, m.role === 'assistant' ? 280 : 240)}`)
      const after = own.length > 0 ? `; after that: ${own.join('; ')}` : ''
      return {
        form: 'summary',
        pieces: [
          { kind: 'text', text: `S${n}. "${s.title}": the work before it, summarised: ` },
          { kind: 'summary', summaryId: context.summary.provenance.summaryId, text: quote(context.summary.text, SUMMARY_SHOWN) },
          { kind: 'text', text: after },
        ],
      }
    }
    const head = `S${n}. "${s.title}": request ${quote(s.request, 240)}; `
    if (!s.excerpt) return { form: 'full', pieces: [{ kind: 'text', text: `${head}no answer yet (${s.state})` }] }
    const source = answer(s)
    const sofar = s.state === 'completed' ? '' : ` so far (${s.state})`
    const span = (start: number, end: number): LinePiece => ({ kind: 'answer', source, start, end })
    const opening = span(0, s.excerpt.length)
    if (choice.form === 'full' && complete(s)) return { form: 'full', pieces: [{ kind: 'text', text: `${head}answer${sofar} "` }, span(0, source.text.length), { kind: 'text', text: '"' }] }
    if (choice.form === 'passages' && choice.passages.length > 0 && complete(s)) {
      const pieces: LinePiece[] = [{ kind: 'text', text: `${head}answer${sofar}, its opening and the passages that share the most words with the message: "` }, opening]
      for (const p of choice.passages) pieces.push({ kind: 'text', text: SEPARATOR }, span(p.start, p.end))
      pieces.push({ kind: 'text', text: '"' })
      return { form: 'passages', pieces }
    }
    // The whole answer is its opening: nothing more could be shown.
    return { form: complete(s) && source.text.length === s.excerpt.length ? 'full' : 'opening', pieces: [{ kind: 'text', text: `${head}answer${sofar} "` }, opening, { kind: 'text', text: '"' }] }
  }
  return { line, answer, complete, passages }
}

/** A section asked about by itself, as `chooseShown` weighs it. */
export interface ShownPoint {
  readonly section: CandidateSection
  readonly n: number
  readonly context: DecisionContext | null
}

/**
 * The form each Point's answer is shown in, so that the lines together
 * grow the request by at most `extraTokens` (by the guard's estimate).
 *
 * - A section with a summary, or whose whole answer is not at hand, keeps
 *   its line.
 * - The extra room is shared evenly: the Points whose whole answer costs
 *   least are shown whole while it fits within an even share of what is
 *   left (so short answers are always whole), then each of the rest gets an
 *   even share of what remains for its opening and best passages, and
 *   keeps the opening alone when no passage fits or none shares a word with
 *   the message.
 * - Ties in size go to the earlier section. Nothing is dropped: every
 *   Point stays in the request whatever it is shown with.
 */
export function chooseShown(showing: Showing, points: readonly ShownPoint[], extraTokens: number): Map<SectionId, ShownChoice> {
  const out = new Map<SectionId, ShownChoice>()
  let left = Number.isFinite(extraTokens) ? Math.floor(Math.max(0, extraTokens - 1) / STATE_TOKENS_PER_CHARACTER) : Number.POSITIVE_INFINITY
  const length = (p: ShownPoint, choice: ShownChoice): number => renderLine(showing.line(p.section, p.n, p.context, choice)).length
  const items: { readonly point: ShownPoint; readonly base: number; readonly whole: number }[] = []
  for (const point of points) {
    if (point.context?.kind === 'summary' || point.section.asksElicitationId || !showing.complete(point.section) || out.has(point.section.sectionId)) continue
    const base = length(point, OPENING)
    out.set(point.section.sectionId, OPENING)
    items.push({ point, base, whole: length(point, { form: 'full' }) - base })
  }
  items.sort((x, y) => x.whole - y.whole || x.point.n - y.point.n)
  let i = 0
  for (; i < items.length; i++) {
    const item = items[i]
    if (!item || item.whole > left / (items.length - i)) break
    out.set(item.point.section.sectionId, { form: 'full' })
    left -= item.whole
  }
  for (; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const share = Math.floor(left / (items.length - i))
    const ranked = showing.passages(item.point.section)
    if (ranked.length === 0) continue
    // What the line's wording adds once it shows passages, before any passage.
    const first = ranked[0]
    if (!first) continue
    const label = length(item.point, { form: 'passages', passages: [first.span] }) - item.base - SEPARATOR.length - first.characters
    let used = label
    const chosen: Span[] = []
    for (const { span, characters } of ranked) {
      if (chosen.length >= PASSAGES_SHOWN) break
      if (used + SEPARATOR.length + characters > share) continue
      chosen.push(span)
      used += SEPARATOR.length + characters
    }
    if (chosen.length === 0) continue
    chosen.sort((x, y) => x.start - y.start)
    out.set(item.point.section.sectionId, { form: 'passages', passages: chosen })
    left -= used
  }
  return out
}

// ───────────────────────────── passages ─────────────────────────────

/** A heading line: Markdown `#`, or a line that is all bold. A heading starts a passage. */
const HEADING = /^\s{0,3}(?:#{1,6}\s+\S|\*\*[^*\n]+\*\*:?\s*$|__[^_\n]+__:?\s*$)/

interface Block {
  start: number
  end: number
  /** The heading the block falls under, for matching: a later piece of a long block still belongs to it. */
  heading: string
}

/**
 * The blocks of an answer: paragraphs separated by blank lines, a heading
 * starting a new one and carried by the paragraph it heads. A block longer
 * than `PASSAGE_CHARACTERS` is cut at spaces into passages of about that
 * size, each still under the block's heading.
 */
export function passagesOf(text: string): Block[] {
  const blocks: (Block & { onlyHeading: boolean })[] = []
  // Whether the last block is still open: a blank line closes it, unless it is only a heading, which heads what follows.
  let open = false
  let at = 0
  for (;;) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl
    const content = text.slice(at, end)
    const last = blocks[blocks.length - 1]
    if (content.trim() === '') open = open && last !== undefined && last.onlyHeading
    else if (HEADING.test(content)) {
      blocks.push({ start: at, end, heading: content.trim(), onlyHeading: true })
      open = true
    } else if (open && last) {
      last.end = end
      last.onlyHeading = false
    } else {
      blocks.push({ start: at, end, heading: '', onlyHeading: false })
      open = true
    }
    if (nl < 0) break
    at = nl + 1
  }
  const out: Block[] = []
  for (const block of blocks) {
    let start = block.start
    while (start < block.end) {
      let end = Math.min(block.end, start + PASSAGE_CHARACTERS)
      if (end < block.end) {
        const space = text.lastIndexOf(' ', end)
        if (space > start + PASSAGE_CHARACTERS / 2) end = space
      }
      out.push({ start, end, heading: block.heading })
      start = end
    }
  }
  return out
}

/**
 * The passages of an answer after its first `opening` characters that
 * share words with the message, best first: each scored by the message's
 * words it holds (its heading's included), a word that occurs in fewer of
 * the answer's passages weighing more; on equal scores the earlier passage
 * first. A passage that begins inside the opening is shown from where the
 * opening ends.
 */
export function rankPassages(text: string, opening: number, words: ReadonlySet<string>): { readonly span: Span; readonly characters: number }[] {
  if (words.size === 0 || text.length <= opening) return []
  const pieces = passagesOf(text).flatMap((p) => {
    const start = Math.max(p.start, opening)
    if (start >= p.end) return []
    const characters = collapseShownText(text.slice(start, p.end)).length
    if (characters === 0) return []
    const terms = new Set([...lexicalTerms(text.slice(start, p.end)), ...lexicalTerms(p.heading)].filter((t) => words.has(t)))
    return [{ span: { start, end: p.end }, characters, terms }]
  })
  const df = new Map<string, number>()
  for (const p of pieces) for (const t of p.terms) df.set(t, (df.get(t) ?? 0) + 1)
  const scored = pieces.map((p) => ({ ...p, score: [...p.terms].reduce((sum, t) => sum + Math.log(1 + pieces.length / (df.get(t) ?? 1)), 0) }))
  return scored
    .filter((p) => p.score > 0)
    .sort((x, y) => y.score - x.score || x.span.start - y.span.start)
    .map(({ span, characters }) => ({ span, characters }))
}

/** The words of a text that passages are matched against. */
export function shownWords(text: string): string[] {
  return [...new Set(lexicalTerms(text))]
}
