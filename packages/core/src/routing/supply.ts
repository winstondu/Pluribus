import { IN_FLIGHT_STATES, type DirectiveId, type NodeId, type SectionId, type SiblingGroupId } from '@committee/protocol'
import type { CandidateChain, CandidateGroup, CandidateSection, CandidateWork, DecisionContext, ReferentSection, RoutingInput } from '../ports'

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
 * The fewest sections and lines of work the pipeline's request lists when
 * it is cut to fit the routing's decision token budget: the latest answer,
 * and room for a small sibling group and what it was requested from.
 */
export const MIN_SECTIONS = 4
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
 * that its answer is still recognised.
 */
export function supply(input: RoutingInput, given: readonly SectionId[], window: number = MAX_SECTIONS): Supplied {
  const c = input.candidates
  const size = Math.min(MAX_SECTIONS, Math.max(1, Math.floor(window)))
  const recent = c.sections.slice(-size)
  const kept = (s: CandidateSection): boolean => given.includes(s.sectionId) || (size < MAX_SECTIONS && s.asksElicitationId !== null)
  const sections = [...c.sections.filter((s) => kept(s) && !recent.includes(s)), ...recent]
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

/** The most of a summary shown in a section's line. */
export const SUMMARY_SHOWN = 600
/** The most messages of a section's own content shown after a summary: the latest ones. */
export const OWN_MESSAGES_SHOWN = 6

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

/**
 * A section's line. With a summary: the summary of its context up to the
 * anchor, then the content specific to the section (the exchanges after
 * the anchor, the section's own last).
 */
export function sectionLine(s: CandidateSection, n: number, context: DecisionContext | null = null): string {
  if (s.asksElicitationId) return `S${n}. A question Committee asked the user, still unanswered: ${quote(s.excerpt || s.request)}`
  if (context?.kind === 'summary') {
    const own = context.own.slice(-OWN_MESSAGES_SHOWN).map((m) => `${m.role === 'assistant' ? 'answer' : 'request'} ${quote(m.content, m.role === 'assistant' ? 280 : 240)}`)
    const after = own.length > 0 ? `; after that: ${own.join('; ')}` : ''
    return `S${n}. "${s.title}": the work before it, summarised: ${quote(context.summary.text, SUMMARY_SHOWN)}${after}`
  }
  const answer = s.excerpt ? `answer ${s.state === 'completed' ? '' : `so far (${s.state}) `}${quote(s.excerpt)}` : `no answer yet (${s.state})`
  return `S${n}. "${s.title}": request ${quote(s.request, 240)}; ${answer}`
}

function chainLine(chain: CandidateChain, n: number): string {
  return `L${n}. "${chain.label}" (${chain.kind}${chain.busy ? ', work in progress' : ''})`
}

/**
 * The text every question of a call is asked about: the conversation as
 * the candidates describe it, then the subject. Candidates are numbered so
 * that questions can name them; the numbers are the option keys.
 */
export function describeState(input: RoutingInput, supplied: Supplied, subject: string): string {
  const lines: string[] = []
  if (supplied.sections.length > 0) {
    lines.push('Answer sections in this conversation, oldest first:')
    supplied.sections.forEach((s, i) => lines.push(sectionLine(s, i + 1, decisionContextOf(input, s))))
  } else {
    lines.push('The conversation has no answers yet.')
  }
  if (supplied.chains.length > 0) {
    lines.push('', 'Lines of work (each reads only its own history):')
    supplied.chains.forEach((c, i) => lines.push(chainLine(c, i + 1)))
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
