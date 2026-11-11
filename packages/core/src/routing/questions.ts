import type { ChainId, DirectiveId, RequirementId, SectionId, SiblingGroupId } from '@committee/protocol'
import type { CandidateSection, RoutingInput } from '../ports'
import type { Answers, Batch } from './batch'
import type { Supplied } from './supply'

/**
 * The bounded questions asked about one unit: the whole message when it is
 * routed as one request, or one fragment of a composite (11 · "Routing",
 * stage 1). Each question selects among supplied candidates or answers yes
 * or no; none asks the model to write anything (invariant 9).
 *
 * Question IDs are `<unit>_<question>`, with candidates named by their
 * number in the state text: `m_s3` asks whether the message refers to
 * section S3, `f1_w2` whether fragment F2 needs the result of W2.
 */

export type BaseRelation = 'new' | 'addition' | 'result-dependent'

const RELATION_OPTIONS: { readonly [option: string]: string } = {
  new: 'New, unrelated work: it does not build on anything in the conversation',
  addition: 'Builds on existing answers or their context, without needing a result that is not available yet',
  dependent: 'Needs a result that is still being produced (listed under "Work whose result is not available yet")',
}

const OPTION_RELATION: { readonly [option: string]: BaseRelation } = {
  new: 'new',
  addition: 'addition',
  dependent: 'result-dependent',
}

export interface UnitScope {
  /** `m` for the message, `f<i>` for fragment i. */
  readonly key: string
  /** How questions name it: "the new message", "part F2". */
  readonly name: string
  /** Sections to score as reply targets, with their number in the state text. */
  readonly sections: readonly { readonly n: number; readonly section: CandidateSection }[]
  readonly corrective: boolean
  readonly relation: boolean
  readonly chain: boolean
  readonly dependencies: boolean
  readonly sessionRequirements: boolean
  readonly clarify: boolean
  /** Other fragments this one may need the result of (the decomposer's candidate dependencies). */
  readonly after: readonly { readonly key: string; readonly name: string }[]
}

export interface Scored<T> {
  readonly id: T
  readonly confidence: number
}

/** What the decision model answered about one unit. */
export interface UnitSignals {
  readonly key: string
  readonly corrective: number | null
  readonly shared: number | null
  readonly relation: { readonly value: BaseRelation; readonly confidence: number; readonly probabilities: { readonly [r in BaseRelation]?: number } } | null
  readonly targets: readonly Scored<SectionId>[]
  /** Probability that the unit refers to several sections at once. */
  readonly several: number | null
  readonly chain: Scored<ChainId> | null
  readonly needsWork: readonly Scored<DirectiveId>[]
  readonly needsGroups: readonly Scored<SiblingGroupId>[]
  readonly sessionRequirements: readonly Scored<RequirementId>[]
  /** Probability that, besides changing a session-wide requirement, the unit asks for an answer of its own. */
  readonly asks: number | null
  readonly clarify: number | null
  readonly clarifyReason: 'missing-information' | 'incompatible-requirements'
  readonly after: readonly Scored<string>[]
}

/** Section numbers as the state text shows them. */
export function sectionNumbers(supplied: Supplied): Map<SectionId, number> {
  return new Map(supplied.sections.map((s, i) => [s.sectionId, i + 1]))
}

export function askUnit(batch: Batch, supplied: Supplied, input: RoutingInput, scope: UnitScope): void {
  const k = scope.key
  const it = scope.name
  if (scope.corrective) {
    batch.noul(
      `${k}_corrective`,
      `Does ${it} use corrective or replacing wording ("actually", "instead", "change to", "no, …") to correct or replace something the user asked for earlier, rather than ask for more?`,
    )
    batch.noul(
      `${k}_shared`,
      `If ${it} corrects something, does it change a requirement or brief that several earlier requests relied on (for example the trip's length or budget), rather than one answer alone?`,
    )
  }
  if (scope.relation) batch.choice(`${k}_relation`, `How does ${it} relate to the existing work?`, RELATION_OPTIONS)
  if (scope.sections.length >= 2) {
    batch.noul(`${k}_several`, `Does ${it} plainly refer to more than one of the answer sections at once (for example "both", "compare", or two answers named)?`)
  }
  for (const { n, section } of scope.sections) {
    batch.noul(
      `${k}_s${n}`,
      section.asksElicitationId
        ? `Does ${it} answer the question S${n}?`
        : `Does ${it} refer to answer section S${n} ("${section.title}"): reply to it, build on it, or correct it?`,
    )
  }
  if (scope.chain && supplied.chains.length > 0) {
    const options: { [o: string]: string } = {}
    supplied.chains.forEach((c, i) => (options[`L${i + 1}`] = `Continue line L${i + 1}, "${c.label}"`))
    batch.choice(`${k}_chain`, `Which line of work's context does ${it} build on?`, options)
  }
  if (scope.dependencies) {
    supplied.inFlight.forEach((w, i) => {
      batch.noul(
        `${k}_w${i + 1}`,
        `Can ${it} only be answered with the finished result of W${i + 1} ("${w.label}"), so that it must wait for it? Shared subject matter alone is not enough.`,
      )
    })
    supplied.openGroups.forEach((g, i) => {
      batch.noul(`${k}_g${i + 1}`, `Does ${it} need the finished results of all of G${i + 1} ("${g.label}") together?`)
    })
  }
  if (scope.sessionRequirements) {
    input.sessionRequirements.forEach((_r, i) => {
      batch.noul(`${k}_r${i + 1}`, `Does ${it} change or take back the conversation-wide requirement R${i + 1}?`)
    })
    batch.noul(
      `${k}_asks`,
      `Leaving aside any change to a conversation-wide requirement, does ${it} also ask a question or request a task that needs an answer of its own?`,
    )
  }
  if (scope.clarify) {
    batch.noul(
      `${k}_clarify`,
      `Is ${it} impossible to answer well without first asking the user, because it lacks information it needs or its requirements contradict each other? Ordinary vagueness that a sensible default resolves is not enough.`,
    )
    batch.choice(`${k}_why`, `If ${it} needs a question to the user, why?`, {
      missing: 'Information it needs is missing',
      conflict: 'The user’s requirements contradict each other',
    })
  }
  for (const other of scope.after) {
    batch.noul(`${k}_after_${other.key}`, `Does ${it} need the finished result of ${other.name}, so that it must wait for it?`)
  }
}

export function readUnit(answers: Answers, supplied: Supplied, input: RoutingInput, scope: UnitScope): UnitSignals {
  const k = scope.key
  const relation = answers.choice(`${k}_relation`)
  const chain = answers.choice(`${k}_chain`)
  const chainIndex = chain ? Number(chain.choice.slice(1)) - 1 : -1
  const chainCandidate = supplied.chains[chainIndex]
  const probabilities: { [r in BaseRelation]?: number } = {}
  if (relation) for (const [o, p] of Object.entries(relation.probabilities)) {
    const r = OPTION_RELATION[o]
    if (r) probabilities[r] = p
  }
  const scored = <T>(id: T, q: string): Scored<T>[] => {
    const p = answers.noul(q)
    return p === null ? [] : [{ id, confidence: p }]
  }
  return {
    key: k,
    corrective: answers.noul(`${k}_corrective`),
    shared: answers.noul(`${k}_shared`),
    relation: relation ? { value: OPTION_RELATION[relation.choice] ?? 'addition', confidence: relation.confidence, probabilities } : null,
    targets: scope.sections.flatMap(({ n, section }) => scored(section.sectionId, `${k}_s${n}`)),
    several: answers.noul(`${k}_several`),
    chain: chain && chainCandidate ? { id: chainCandidate.chainId, confidence: chain.confidence } : null,
    needsWork: supplied.inFlight.flatMap((w, i) => scored(w.directiveId, `${k}_w${i + 1}`)),
    needsGroups: supplied.openGroups.flatMap((g, i) => scored(g.groupId, `${k}_g${i + 1}`)),
    sessionRequirements: input.sessionRequirements.flatMap((r, i) => scored(r.id, `${k}_r${i + 1}`)),
    asks: answers.noul(`${k}_asks`),
    clarify: answers.noul(`${k}_clarify`),
    clarifyReason: answers.choice(`${k}_why`)?.choice === 'conflict' ? 'incompatible-requirements' : 'missing-information',
    after: scope.after.flatMap((o) => scored(o.key, `${k}_after_${o.key}`)),
  }
}
