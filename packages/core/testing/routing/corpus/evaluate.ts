import {
  DEFAULT_SETTINGS,
  createIdFactory,
  createSeededRandom,
  createUlidFactory,
  type DecisionQuestionRecord,
  type IdFactory,
  type PointRef,
  type PrerequisiteRef,
  type Settings,
  type RunEndRecord,
  type TextSpan,
} from '@pluribus/protocol'
import type {
  CancelSignal,
  DecisionProvider,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  DecomposeRequest,
  DecomposeResult,
  Decomposer,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
} from '../../../src/ports'
import { NEVER_CANCELLED } from '../../../src/ports'
import { createRouter } from '../../../src/routing/pipeline'
import { buildTree } from '../../../src/routing/referents/tree'
import { numberedAnswerSections, supply } from '../../../src/routing/supply'
import { ROUTING_CORPUS } from './examples'
import { ids } from './scene'
import type { CorpusExample, CorpusExpectation, CorpusTopic, ExpectationSet, PartExpectation, PlacementExpectation, ReferenceDecomposition } from './types'

export interface CorpusRun {
  readonly decisionProvider: DecisionProvider
  /** Defaults to the examples' reference decompositions, so the decision model is evaluated on its own. */
  readonly decomposer?: Decomposer
  /** Models and thresholds; default `DEFAULT_SETTINGS`. */
  readonly settings?: Pick<Settings, 'models' | 'thresholds' | 'routing'>
  readonly examples?: readonly CorpusExample[]
  readonly signal?: CancelSignal
}

export interface CorpusResult {
  readonly id: string
  readonly covers: readonly CorpusTopic[]
  readonly passed: boolean
  /** The expectations it was scored against: those for hop between branch points when the tree walk ran with the switch on. */
  readonly expectations: ExpectationSet
  /** What differed from the label, one line each. */
  readonly mismatches: readonly string[]
  readonly outcome: RoutingOutcome['kind']
  /** Every question asked and its answer, for threshold tuning. */
  readonly questions: readonly DecisionQuestionRecord[]
  /** What routing the example cost in decision calls. */
  readonly decisions: DecisionSpend
  /** The targets that hop between branch points placed on the last section of a run without a search inside it; empty when none. */
  readonly runEnds: readonly RunEndRecord[]
}

/** Decision calls made, and the input tokens the provider reported for them (0 where it reported none). */
export interface DecisionSpend {
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

/** A decision provider that counts what passes through it. */
export function meteredDecisionProvider(provider: DecisionProvider): DecisionProvider & { spent(): DecisionSpend } {
  let requests = 0
  let questions = 0
  let inputTokens = 0
  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
      requests += 1
      questions += Object.keys(request.questions).length
      const result = await provider.decide(request, signal)
      if (result.ok) inputTokens += result.usage?.inputTokens ?? 0
      return result
    },
    spent: () => ({ requests, questions, inputTokens }),
  }
}

export interface CorpusReport {
  readonly results: readonly CorpusResult[]
  readonly passed: number
  readonly total: number
  /** How many routings were scored against each set of expectations, and how many of the hop-on ones differ from the default. */
  readonly expectations: { readonly [S in ExpectationSet]: number } & { readonly hopDiffering: number }
  /** Decision calls over the whole run. */
  readonly decisions: DecisionSpend
  readonly byTopic: { readonly [T in CorpusTopic]?: { readonly passed: number; readonly total: number } }
}

/** The routing input for an example, as the engine would build it. */
export function corpusInput(example: CorpusExample, settings: Pick<Settings, 'models' | 'thresholds' | 'routing'> = DEFAULT_SETTINGS, idFactory?: IdFactory): RoutingInput {
  return {
    conversationId: 'cnv_corpus' as RoutingInput['conversationId'],
    messageId: ids.message('new'),
    text: example.text,
    explicitTargets: (example.replyTo ?? []).map(ids.section),
    redirects: [],
    chosenTargets: null,
    forcedComposition: null,
    candidates: example.scene.candidates,
    sessionRequirements: example.scene.sessionRequirements,
    settings: { models: settings.models, thresholds: settings.thresholds, routing: settings.routing },
    ids: idFactory ?? createIdFactory(createUlidFactory(() => 0, createSeededRandom(11))),
  }
}

function spansOf(text: string, part: string | readonly string[]): TextSpan[] {
  const parts = typeof part === 'string' ? [part] : part
  return parts.map((p) => {
    const start = text.indexOf(p)
    if (start < 0) throw new Error(`"${p}" is not in "${text}"`)
    return { start, end: start + p.length }
  })
}

/** A decomposer that returns an example's reference decomposition (one fragment for the whole message when it has none). */
export function referenceDecomposer(example: CorpusExample): Decomposer {
  const reference: ReferenceDecomposition = example.decomposition ?? {
    fragments: [{ part: example.text, instruction: example.text, label: example.text.split(/\s+/).slice(0, 4).join(' ') }],
  }
  return {
    async decompose(request: DecomposeRequest): Promise<DecomposeResult> {
      const text = request.text
      return {
        ok: true,
        decomposition: {
          fragments: reference.fragments.map((f, i) => ({
            key: `k${i}`,
            sourceSpans: spansOf(text, f.part),
            instruction: f.instruction,
            label: f.label,
            requirements: (f.requirements ?? []).map((r) => ({
              text: r.text,
              span: r.part ? (spansOf(text, r.part)[0] ?? null) : null,
              scope: r.scope ?? 'local',
            })),
            dependsOnFragments: (f.after ?? []).map((j) => `k${j}`),
            dependsOnCandidates: [],
          })),
          barrier: reference.barrier ?? null,
          outputOrder: reference.outputOrder ? reference.outputOrder.map((j) => `k${j}`) : null,
        },
      }
    },
  }
}

/** Runs the router over every example and compares each outcome with its label. */
export async function evaluateCorpus(run: CorpusRun): Promise<CorpusReport> {
  const results: CorpusResult[] = []
  let hopDiffering = 0
  for (const example of run.examples ?? ROUTING_CORPUS) {
    const input = corpusInput(example, run.settings)
    const metered = meteredDecisionProvider(run.decisionProvider)
    const router = createRouter({ decisionProvider: metered, decomposer: run.decomposer ?? referenceDecomposer(example) })
    const outcome = await router.route(input, run.signal ?? NEVER_CANCELLED)
    const expectations = expectationSetFor(input.settings, outcome)
    const mismatches = compare(example, outcome, expectations)
    if (expectations === 'hop' && example.hop) hopDiffering += 1
    results.push({
      id: example.id,
      covers: example.covers,
      passed: mismatches.length === 0,
      expectations,
      mismatches,
      outcome: outcome.kind,
      questions: outcome.kind === 'plan' ? outcome.plan.decision.questions : [],
      decisions: metered.spent(),
      runEnds: outcome.kind === 'plan' ? (outcome.plan.decision.runEnds ?? []) : [],
    })
  }
  const byTopic: { [T in CorpusTopic]?: { passed: number; total: number } } = {}
  for (const r of results) {
    for (const topic of r.covers) {
      const entry = byTopic[topic] ?? { passed: 0, total: 0 }
      entry.total += 1
      if (r.passed) entry.passed += 1
      byTopic[topic] = entry
    }
  }
  const decisions = results.reduce<DecisionSpend>(
    (sum, r) => ({ requests: sum.requests + r.decisions.requests, questions: sum.questions + r.decisions.questions, inputTokens: sum.inputTokens + r.decisions.inputTokens }),
    { requests: 0, questions: 0, inputTokens: 0 },
  )
  const expectations = { default: results.filter((r) => r.expectations === 'default').length, hop: results.filter((r) => r.expectations === 'hop').length, hopDiffering }
  return { results, passed: results.filter((r) => r.passed).length, total: results.length, expectations, decisions, byTopic }
}

/**
 * The expectations a routing is scored against: those for hop between
 * branch points when the switch is on and the tree walk ran; the default
 * ones otherwise. Read from the configuration, never from where the routing
 * placed anything.
 */
export function expectationSetFor(settings: Pick<Settings, 'routing'>, outcome: RoutingOutcome): ExpectationSet {
  const routing = settings.routing
  if (!routing.treeWalk.hopBetweenBranchPoints) return 'default'
  return routing.referentStrategy === 'tree-walk' ? 'hop' : 'default'
}

/** An example's expectation in one set: the hop's parts in place of the default ones where the example has them. */
export function expectationOf(example: CorpusExample, set: ExpectationSet): CorpusExpectation {
  return set === 'hop' && example.hop ? { ...example.expect, parts: example.hop.parts } : example.expect
}

export function formatCorpusReport(report: CorpusReport): string {
  const lines = [
    `Routing corpus: ${report.passed}/${report.total} examples as labelled, against ${expectationsText(report)}`,
    `  decision calls: ${report.decisions.requests} requests, ${report.decisions.questions} questions, ${report.decisions.inputTokens} input tokens reported`,
  ]
  for (const [topic, t] of Object.entries(report.byTopic)) lines.push(`  ${topic}: ${t.passed}/${t.total}`)
  for (const r of report.results) {
    if (r.passed) continue
    lines.push(`✗ ${r.id} (${r.outcome})`)
    for (const m of r.mismatches) lines.push(`    ${m}`)
  }
  return lines.join('\n')
}

function expectationsText(report: CorpusReport): string {
  const { hop, hopDiffering } = report.expectations
  if (hop === 0) return 'the default expectations'
  const which = `the hop-on expectations (hop between branch points, tree walk; ${hopDiffering} of them differ from the default)`
  return hop === report.total ? which : `${which} for ${hop} routings and the default expectations for ${report.total - hop}`
}

// ───────────────────────────── comparison ─────────────────────────────

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

function show(list: readonly string[]): string {
  return `[${list.join(', ')}]`
}

/** Every difference between an outcome and the example's label in one set of expectations, the default one unless named. */
export function compare(example: CorpusExample, outcome: RoutingOutcome, set: ExpectationSet = 'default'): string[] {
  const out: string[] = []
  const expect = expectationOf(example, set)
  const wanted = expect.outcome ?? 'plan'
  if (outcome.kind !== wanted) {
    out.push(`outcome: expected ${wanted}, got ${outcome.kind}${outcome.kind === 'failed' ? ` (${outcome.error.message})` : ''}`)
    return out
  }
  const handles = example.scene.handles
  const handle = (id: string): string => handles.get(id) ?? id
  if (outcome.kind === 'target-ambiguity') {
    const got = outcome.candidates.map((c) => handle(c.sectionId))
    if (expect.ambiguous && !sameSet(got, expect.ambiguous)) out.push(`ambiguous candidates: expected ${show(expect.ambiguous)}, got ${show(got)}`)
    return out
  }
  if (outcome.kind !== 'plan') return out
  const plan = outcome.plan
  if (expect.composition && plan.composition !== expect.composition) out.push(`composition: expected ${expect.composition}, got ${plan.composition}`)
  const answered = plan.answersElicitationId ? handle(plan.answersElicitationId) : null
  if ((expect.answers ?? null) !== answered) out.push(`answers: expected ${expect.answers ?? 'none'}, got ${answered ?? 'none'}`)
  if (expect.barrier !== undefined && (plan.barrier !== null) !== expect.barrier) out.push(`barrier: expected ${String(expect.barrier)}, got ${String(plan.barrier !== null)}`)
  if (expect.sessionWide !== undefined && (plan.sessionRequirements.length > 0) !== expect.sessionWide) {
    out.push(`session-wide requirement: expected ${String(expect.sessionWide)}, got ${String(plan.sessionRequirements.length > 0)}`)
  }
  if (expect.sharedClarification !== undefined) {
    const shared = plan.clarifications.some((c) => c.blockedDirectiveIds.length >= 2)
    if (shared !== expect.sharedClarification) out.push(`shared clarification: expected ${String(expect.sharedClarification)}, got ${String(shared)}`)
  }
  if (!expect.parts) return out

  // Parts in original text order: the units and revisions by their fragment's position.
  type Part = { readonly kind: 'unit'; readonly unit: RoutingPlan['units'][number] } | { readonly kind: 'revision'; readonly revision: RoutingPlan['revisions'][number] }
  const position = (spans: readonly TextSpan[] | undefined): number => spans?.[0]?.start ?? 0
  const parts: Part[] = [
    ...plan.units.map((unit): Part => ({ kind: 'unit', unit })),
    ...plan.revisions.map((revision): Part => ({ kind: 'revision', revision })),
  ].sort(
    (a, b) =>
      position(a.kind === 'unit' ? a.unit.fragment?.sourceSpans : a.revision.fragment?.sourceSpans) -
      position(b.kind === 'unit' ? b.unit.fragment?.sourceSpans : b.revision.fragment?.sourceSpans),
  )
  const partOf = new Map<string, number>()
  parts.forEach((p, i) => {
    if (p.kind === 'unit') partOf.set(p.unit.directiveId, i)
  })
  const ref = (id: string): string => (partOf.has(id) ? `part:${partOf.get(id) ?? ''}` : handle(id))
  const point = (p: PointRef): string => (p.kind === 'node' ? handle(p.nodeId) : p.kind === 'sibling-group' ? handle(p.groupId) : ref(p.directiveId))
  const prerequisite = (p: PrerequisiteRef): string => (p.kind === 'directive' ? ref(p.directiveId) : handle(p.groupId))
  if (parts.length !== expect.parts.length) {
    out.push(`parts: expected ${expect.parts.length}, got ${parts.length}`)
    return out
  }
  if (expect.order) {
    const got = plan.units.map((u) => partOf.get(u.directiveId) ?? -1)
    if (got.join() !== expect.order.join()) out.push(`order: expected ${show(expect.order.map(String))}, got ${show(got.map(String))}`)
  }
  expect.parts.forEach((want: PartExpectation, i) => {
    const got = parts[i]
    if (!got) return
    const at = `part ${i}`
    if (want.kind !== got.kind) {
      out.push(`${at}: expected a ${want.kind}, got a ${got.kind}`)
      return
    }
    if (want.kind === 'revision' && got.kind === 'revision') {
      const r = got.revision
      if (r.scope !== want.scope) out.push(`${at} scope: expected ${want.scope}, got ${r.scope}`)
      const targets = r.targetDirectiveIds.map(handle)
      if (!sameSet(targets, want.targets)) out.push(`${at} revises: expected ${show(want.targets)}, got ${show(targets)}`)
      if (want.requirements) {
        const reqs = r.targetRequirementIds.map(handle)
        if (!sameSet(reqs, want.requirements)) out.push(`${at} requirements: expected ${show(want.requirements)}, got ${show(reqs)}`)
      }
      if (want.affected) {
        const pre = r.affected.filter((a) => a.preselected).map((a) => handle(a.directiveId))
        if (!sameSet(pre, want.affected)) out.push(`${at} pre-selected: expected ${show(want.affected)}, got ${show(pre)}`)
      }
      return
    }
    if (want.kind !== 'unit' || got.kind !== 'unit') return
    const u = got.unit
    if (want.relation && u.relation !== want.relation) out.push(`${at} relation: expected ${want.relation}, got ${u.relation}`)
    if (want.targets) {
      const targets = u.targets.map(handle)
      if (!sameSet(targets, want.targets)) out.push(`${at} targets: expected ${show(want.targets)}, got ${show(targets)}`)
    }
    if (want.placement) {
      const placed = placementText(u.placement, point)
      const expected = expectedPlacementText(want.placement)
      if (placed !== expected) out.push(`${at} placement: expected ${expected}, got ${placed}`)
    }
    if (want.prerequisites) {
      const pre = u.prerequisites.map(prerequisite)
      if (!sameSet(pre, want.prerequisites)) out.push(`${at} prerequisites: expected ${show(want.prerequisites)}, got ${show(pre)}`)
    }
    if (want.clarification !== undefined) {
      const c = plan.clarifications.find((x) => x.blockedDirectiveIds.includes(u.directiveId))
      const got = c ? c.reason : false
      if (got !== want.clarification) out.push(`${at} clarification: expected ${String(want.clarification)}, got ${String(got)}`)
    }
  })
  return out
}

function placementText(p: RoutingPlan['units'][number]['placement'], point: (p: PointRef) => string): string {
  if (p.kind === 'new-chain') return 'new-chain'
  if (p.kind === 'continue') return `continue ${point(p.buildsOn)}`
  return `join ${[...p.parents.map(point)].sort().join('+')}`
}

function expectedPlacementText(p: PlacementExpectation): string {
  if (p === 'new-chain') return p
  if ('continue' in p) return `continue ${p.continue}`
  return `join ${[...p.join].sort().join('+')}`
}

// ───────────────────────────── the oracle ─────────────────────────────

const YES = 0.95
const NO = 0.05
const UNSURE = 0.5
/** A section on the line above a target: worth looking below, not a target. */
const PLAUSIBLE = 0.4

/**
 * A decision provider that answers every question as the example's label
 * says, by reading the question IDs. With it the corpus tests the
 * deterministic stages of the pipeline: given perfect decisions, does the
 * router produce the labelled outcome?
 */
export function oracleDecisionProvider(example: CorpusExample, input: RoutingInput): DecisionProvider {
  const expect = example.expect
  const supplied = supply(input, input.explicitTargets)
  const parts = expect.parts ?? []
  const partFor = (key: string): PartExpectation | undefined => (key === 'm' ? (parts.length === 1 ? parts[0] : undefined) : parts[Number(key.slice(1))])
  const answerSections = numberedAnswerSections(input, supplied)
  /** The handle of S<n>: a listed section by its place in the state text, one beyond the window by the number it was given. */
  const sectionHandle = (n: number): string =>
    example.scene.handles.get(supplied.sections[n - 1]?.sectionId ?? answerSections.find((x) => x.n === n)?.section.sectionId ?? '') ?? ''
  // The context tree as the referent strategies see it, for the questions about a group as a whole.
  const tree = buildTree({ sections: answerSections, candidates: input.candidates })
  const relationOption = (p: PartExpectation | undefined): string =>
    p?.kind === 'unit' ? (p.relation === 'result-dependent' ? 'dependent' : (p.relation ?? 'addition')) : p?.kind === 'revision' || expect.ambiguous ? 'addition' : 'new'

  const answer = (id: string, instructions: string, options: readonly string[]): { type: string; [k: string]: unknown } => {
    const noul = (yes: boolean | 'unsure'): { type: string; probability: number } => ({ type: 'noul', probability: yes === 'unsure' ? UNSURE : yes ? YES : NO })
    const choice = (option: string, confidence = YES): { type: string; choice: string; confidence: number; probabilities: { [o: string]: number } } => ({
      type: 'choice',
      choice: option,
      confidence,
      probabilities: Object.fromEntries(options.map((o) => [o, o === option ? confidence : (1 - confidence) / Math.max(1, options.length - 1)])),
    })
    if (id === 'composite') return noul(expect.composition !== undefined && expect.composition !== 'atomic')
    if (id === 'sessionwide' || /^rq\d+_sessionwide$/.test(id)) return noul(expect.sessionWide === true)
    if (id === 'barrier') return noul(expect.barrier === true)
    if (/^q\d+_clarify$/.test(id)) return noul(expect.sharedClarification === true)
    if (/^a\d+_\d+$/.test(id)) {
      const affected = parts.flatMap((p) => (p.kind === 'revision' ? (p.affected ?? []) : []))
      const labels = affected.map((h) => example.scene.candidates.work.find((w) => w.directiveId === ids.directive(h))?.label ?? h)
      return noul(labels.some((l) => instructions.includes(`"${l}"`)))
    }
    const match = /^(m|f\d+)_(.+)$/.exec(id)
    const key = match?.[1] ?? ''
    const question = match?.[2] ?? ''
    const part = partFor(key)
    const targets = part ? part.targets : []
    if (question === 'several') return noul((targets?.length ?? 0) >= 2)
    if (question === 'corrective') return noul(part?.kind === 'revision')
    if (question === 'shared') return noul(part?.kind === 'revision' && part.scope === 'shared-requirement')
    if (question === 'relation') return choice(relationOption(part))
    if (question === 'clarify') return noul(part?.kind === 'unit' && part.clarification !== undefined && part.clarification !== false)
    if (question === 'why') return choice(part?.kind === 'unit' && part.clarification === 'incompatible-requirements' ? 'conflict' : 'missing')
    if (question === 'chain') {
      const chainHandle = part?.kind === 'unit' ? part.chain : undefined
      const index = chainHandle ? supplied.chains.findIndex((c) => c.chainId === ids.chain(chainHandle)) : -1
      return index >= 0 ? choice(`L${index + 1}`) : choice(options[0] ?? 'L1', 0.3)
    }
    const section = /^s(\d+)$/.exec(question)
    if (section) {
      const h = sectionHandle(Number(section[1]))
      if (expect.answers && h === expect.answers) return noul(true)
      if (expect.ambiguous?.includes(h)) return noul('unsure')
      if (targets?.includes(h)) return noul(true)
      return expect.context?.includes(h) ? { type: 'noul', probability: PLAUSIBLE } : noul(false)
    }
    const together = /^j(\d+)$/.exec(question)
    if (together) {
      const node = [...tree.byGroup.values()].find((x) => x.index === Number(together[1]))
      const members = node ? node.members.map((x) => sectionHandle(x.n)) : []
      return noul(members.length >= 2 && members.every((h) => targets?.includes(h) ?? false))
    }
    // A part of a run being searched: yes when it names a section the part refers to.
    if (/^c\d+_\d+(_\d+)?$/.test(question)) {
      const named = [...instructions.matchAll(/S(\d+) \(/g)].map((m) => sectionHandle(Number(m[1])))
      if (expect.ambiguous?.some((h) => named.includes(h))) return noul('unsure')
      return noul(named.some((h) => targets?.includes(h) ?? false))
    }
    const work = /^w(\d+)$/.exec(question)
    if (work) {
      const w = supplied.inFlight[Number(work[1]) - 1]
      const h = w ? (example.scene.handles.get(w.directiveId) ?? '') : ''
      return noul(part?.kind === 'unit' && (part.prerequisites ?? []).includes(h))
    }
    const group = /^g(\d+)$/.exec(question)
    if (group) {
      const g = supplied.openGroups[Number(group[1]) - 1]
      const h = g ? (example.scene.handles.get(g.groupId) ?? '') : ''
      return noul(part?.kind === 'unit' && (part.prerequisites ?? []).includes(h))
    }
    const requirement = /^r(\d+)$/.exec(question)
    if (requirement) {
      const r = input.sessionRequirements[Number(requirement[1]) - 1]
      const h = r ? (example.scene.handles.get(r.id) ?? '') : ''
      return noul(part?.kind === 'revision' && (part.requirements ?? []).includes(h))
    }
    const after = /^after_f(\d+)$/.exec(question)
    if (after) return noul(part?.kind === 'unit' && (part.after ?? []).includes(Number(after[1])))
    return noul(false)
  }

  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      const answers: { [id: string]: unknown } = {}
      for (const [id, q] of Object.entries(request.questions)) {
        answers[id] = answer(id, q.instructions, q.type === 'choice' ? Object.keys(q.options) : [])
      }
      return { ok: true, model: `${request.model}-oracle`, answers: answers as never, usage: null }
    },
  }
}
