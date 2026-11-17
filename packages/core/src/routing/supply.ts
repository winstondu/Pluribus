import { IN_FLIGHT_STATES, type DirectiveId, type NodeId, type SectionId, type SiblingGroupId } from '@pluribus/protocol'
import { FIRST_PASS_SECTIONS, firstPassSectionIds } from './referents/first-pass'
import type { AnswerSource, CandidateChain, CandidateGroup, CandidateSection, CandidateWork, DecisionContext, ReferentSection, RoutingInput } from '../ports'
import { createShowing, renderLine, shownWords, type Line, type Showing, type ShownChoice } from './shown'
import type { Batch } from './batch'

/**
 * Which candidates the decision model is asked about (12 · "Left to the
 * build"; PLAN §7 and the core-routing decisions). Everything comes from
 * `RoutingInput.candidates`; nothing here invents a candidate.
 *
 * - Reply targets: the most recent current sections, at most
 *   `MAX_SECTIONS`, explicit targets always included.
 * - Result dependencies: work still in flight (only an unavailable result
 *   can be waited for, Q2) and open sibling groups.
 * - Handling chain: every chain that has a node, most recent last.
 * - Session-wide requirements in force, for corrections to them.
 */
export const MAX_SECTIONS = 24
/**
 * The smallest window of the pipeline's request, when it is cut to fit the
 * routing's decision token budget: it then lists the first-pass sections
 * only (`firstPassSectionIds`: the most recent answer sections that no
 * later one of them builds on, at most this many), and as many lines of
 * work.
 */
export const MIN_SECTIONS = FIRST_PASS_SECTIONS
export const MAX_DEPENDENCIES = 16
export const MAX_CHAINS = 24

export interface Supplied {
  /** The most sections and lines of work listed: `MAX_SECTIONS` unless the request was cut to fit the token budget. */
  readonly window: number
  readonly sections: readonly CandidateSection[]
  readonly inFlight: readonly CandidateWork[]
  readonly openGroups: readonly CandidateGroup[]
  readonly chains: readonly CandidateChain[]
  /** Every candidate, by ID, for lookups. */
  readonly sectionById: ReadonlyMap<SectionId, CandidateSection>
  readonly workById: ReadonlyMap<DirectiveId, CandidateWork>
  readonly workByNode: ReadonlyMap<NodeId, CandidateWork>
  readonly groupById: ReadonlyMap<SiblingGroupId, CandidateGroup>
}

/**
 * `window` is the most sections, and the most lines of work, that are
 * listed. It is `MAX_SECTIONS` unless the pipeline's request has to be cut
 * to fit the routing's decision token budget; then the most recent stay,
 * and an open clarification question stays listed however old it is, so
 * that its answer is still recognised. The first-pass sections are listed
 * whatever the window, because every routing asks about each of them by
 * itself; at the smallest window (`MIN_SECTIONS`) they are the only answer
 * sections listed.
 */
export function supply(input: RoutingInput, given: readonly SectionId[], window: number = MAX_SECTIONS): Supplied {
  const c = input.candidates
  const size = Math.min(MAX_SECTIONS, Math.max(MIN_SECTIONS, Math.floor(window)))
  const recent = new Set(size === MIN_SECTIONS && c.sections.length > MIN_SECTIONS ? [] : c.sections.slice(-size))
  const first = new Set(firstPassSectionIds(c))
  const kept = (s: CandidateSection): boolean => given.includes(s.sectionId) || first.has(s.sectionId) || (size < MAX_SECTIONS && s.asksElicitationId !== null)
  const sections = c.sections.filter((s) => recent.has(s) || kept(s))
  const inFlight = c.work.filter((w) => IN_FLIGHT_STATES.includes(w.state)).slice(-MAX_DEPENDENCIES)
  const openGroups = c.groups.filter((g) => g.open)
  const chains = c.chains.slice(-Math.min(MAX_CHAINS, size))
  return {
    window: size,
    sections,
    inFlight,
    openGroups,
    chains,
    sectionById: new Map(c.sections.map((s) => [s.sectionId, s])),
    workById: new Map(c.work.map((w) => [w.directiveId, w])),
    workByNode: new Map(c.work.map((w) => [w.nodeId, w])),
    groupById: new Map(c.groups.map((g) => [g.groupId, g])),
  }
}

function quote(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`
}

export { SUMMARY_SHOWN, OWN_MESSAGES_SHOWN } from './shown'

/**
 * What the decision model is shown for a section in place of its usual
 * line: nothing unless the setting is on, the engine supplied a reader and
 * a summary is available for the section's node. A full chain is not a
 * summary: the usual line stands (docs/build/context-summaries.md).
 */
export function decisionContextOf(input: Pick<RoutingInput, 'settings' | 'decisionContext'>, section: CandidateSection): DecisionContext | null {
  if (!input.settings.routing.useSummaryIfAvailable || !input.decisionContext || section.asksElicitationId) return null
  const context = input.decisionContext(section.nodeId)
  return context?.kind === 'summary' ? context : null
}

/** The texts a routing shows answers from (`routing/shown.ts`): the whole answers the engine supplied, and the message's words. */
export function showingFor(input: Pick<RoutingInput, 'answerText' | 'text'>): Showing {
  return createShowing({ answerOf: answerOf(input), words: shownWords(input.text) })
}

/** A section's whole answer so far as the engine supplied it, with the attempt it is the text of. */
export function answerOf(input: Pick<RoutingInput, 'answerText'>): (section: CandidateSection) => AnswerSource {
  return (section) => ({ attemptId: section.attemptId ?? null, text: input.answerText?.(section.sectionId) ?? section.excerpt })
}

/** Lines with the excerpt alone: what every section shows unless it is a Point with room to show more. */
const PLAIN = createShowing({})

/**
 * A section's line, its answer by its opening. With a summary: the summary
 * of its context up to the anchor, then the content specific to the
 * section (the exchanges after the anchor, the section's own last). A
 * section asked about by itself may be shown more of its answer: see
 * `routing/shown.ts`.
 */
export function sectionLine(s: CandidateSection, n: number, context: DecisionContext | null = null): string {
  return renderLine(PLAIN.line(s, n, context))
}

/** What the sections of a request are shown with: the texts, and the form chosen for each Point (the opening for the rest). */
export interface Shown {
  readonly showing: Showing
  readonly choices: ReadonlyMap<SectionId, ShownChoice>
}

/** A listed section's line in the pipeline's state text. */
export function listedLine(input: RoutingInput, s: CandidateSection, n: number, shown: Shown | null): Line {
  return (shown?.showing ?? PLAIN).line(s, n, decisionContextOf(input, s), shown?.choices.get(s.sectionId))
}

/**
 * A line of work's entry in the state text: its label (its first answer's),
 * then the listed sections on it by number and the title of its latest
 * answer section, so that a question about a line can judge what the line
 * is about now, not only by how it began. A line whose sections are all
 * outside the listed window shows its latest section's title alone.
 */
function chainLine(chain: CandidateChain, n: number, input: RoutingInput, numbers: ReadonlyMap<SectionId, number>): string {
  const head = `L${n}. "${chain.label}" (${chain.kind}${chain.busy ? ', work in progress' : ''})`
  const own = input.candidates.sections.filter((s) => s.chainId === chain.chainId && !s.asksElicitationId)
  const latest = own[own.length - 1]
  if (!latest) return head
  const listed = own.flatMap((s) => {
    const number = numbers.get(s.sectionId)
    return number === undefined ? [] : [`S${number}`]
  })
  return `${head}: ${listed.length > 0 ? `${listed.join(', ')}; ` : ''}latest "${latest.title}"`
}

/**
 * The text every question of a call is asked about: the conversation as
 * the candidates describe it, then the subject. Candidates are numbered so
 * that questions can name them; the numbers are the option keys.
 */
export function describeState(input: RoutingInput, supplied: Supplied, subject: string, shown: Shown | null = null): string {
  const lines: string[] = []
  if (supplied.sections.length > 0) {
    lines.push('Answer sections in this conversation, oldest first:')
    supplied.sections.forEach((s, i) => lines.push(renderLine(listedLine(input, s, i + 1, shown))))
  } else {
    lines.push('The conversation has no answers yet.')
  }
  if (supplied.chains.length > 0) {
    lines.push('', 'Lines of work (each reads only its own history):')
    const numbers = new Map(supplied.sections.map((s, i) => [s.sectionId, i + 1]))
    supplied.chains.forEach((c, i) => lines.push(chainLine(c, i + 1, input, numbers)))
  }
  if (supplied.inFlight.length > 0 || supplied.openGroups.length > 0) {
    lines.push('', 'Work whose result is not available yet:')
    supplied.inFlight.forEach((w, i) => lines.push(`W${i + 1}. "${w.label}": ${quote(w.instruction, 240)} (${w.state})`))
    supplied.openGroups.forEach((g, i) => lines.push(`G${i + 1}. The parallel requests "${g.label}" together, still running`))
  }
  if (input.sessionRequirements.length > 0) {
    lines.push('', 'Requirements the user made conversation-wide:')
    input.sessionRequirements.forEach((r, i) => lines.push(`R${i + 1}. ${quote(r.text, 240)}`))
  }
  lines.push('', subject)
  return lines.join('\n')
}

/**
 * `describeState`, with the lines of the sections it lists put on the batch,
 * so that the request's state is recorded with answer text by reference.
 */
export function stateFor(input: RoutingInput, supplied: Supplied, subject: string, batch: Batch, shown: Shown | null = null): string {
  batch.list(supplied.sections.map((s, i) => ({ sectionId: s.sectionId, line: listedLine(input, s, i + 1, shown) })))
  return describeState(input, supplied, subject, shown)
}

/**
 * The answer sections a referent strategy may score, numbered as every
 * state text of the routing names them: the listed ones by their place in
 * the pipeline's state text, the ones beyond its window after them, in
 * conversation order. Open clarification questions are not among them.
 */
export function numberedAnswerSections(input: RoutingInput, supplied: Supplied): ReferentSection[] {
  const numbers = new Map(supplied.sections.map((s, i) => [s.sectionId, i + 1]))
  let next = supplied.sections.length
  const out: ReferentSection[] = []
  for (const section of input.candidates.sections) {
    if (section.asksElicitationId) continue
    const n = numbers.get(section.sectionId)
    out.push(n === undefined ? { n: (next += 1), section, listed: false } : { n, section, listed: true })
  }
  return out.sort((x, y) => x.n - y.n)
}
