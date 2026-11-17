import { IN_FLIGHT_STATES, type DirectiveId, type NodeId, type SectionId, type SiblingGroupId } from '@pluribus/protocol'
import { firstPassSectionIds } from './referents/first-pass'
import type { CandidateChain, CandidateGroup, CandidateSection, CandidateWork, ReferentSection, RoutingInput } from '../ports'

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
export const MAX_DEPENDENCIES = 16
export const MAX_CHAINS = 24

export interface Supplied {
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
 * The first-pass sections are listed however old they are, because every
 * routing asks about each of them by itself.
 */
export function supply(input: RoutingInput, given: readonly SectionId[]): Supplied {
  const c = input.candidates
  const recent = new Set(c.sections.slice(-MAX_SECTIONS))
  const first = new Set(firstPassSectionIds(c))
  const kept = (s: CandidateSection): boolean => given.includes(s.sectionId) || first.has(s.sectionId)
  const sections = c.sections.filter((s) => recent.has(s) || kept(s))
  const inFlight = c.work.filter((w) => IN_FLIGHT_STATES.includes(w.state)).slice(-MAX_DEPENDENCIES)
  const openGroups = c.groups.filter((g) => g.open)
  const chains = c.chains.slice(-MAX_CHAINS)
  return {
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

export function sectionLine(s: CandidateSection, n: number): string {
  if (s.asksElicitationId) return `S${n}. A question Pluribus asked the user, still unanswered: ${quote(s.excerpt || s.request)}`
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
    supplied.sections.forEach((s, i) => lines.push(sectionLine(s, i + 1)))
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
