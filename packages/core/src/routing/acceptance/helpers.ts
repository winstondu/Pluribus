import type { ConversationEvent, ConversationId, DirectiveId, MessageId } from '@committee/protocol'
import type { DecisionQuestions, DecisionRequest, DecisionResult, DecomposeResult, DecomposedFragment } from '../../ports'
import { createTestBackend, spanOf, type TestBackend, type TestBackendOverrides } from '../../testing'
import { engineModule } from '../../engine'
import type { ConversationState, DirectiveRow } from '../../engine'
import { routingModule } from '../module'

/**
 * Decisions for one message, by name rather than by question number: a
 * section by its title, work by its label, a line by its label. Anything
 * not stated is answered "no" (0.05), or, for a choice, with low confidence.
 */
export interface UnitRules {
  readonly corrective?: number
  readonly shared?: number
  readonly relation?: 'new' | 'addition' | 'dependent'
  /** Section title (or "Question") → probability that the unit refers to it. */
  readonly targets?: { readonly [title: string]: number }
  /** Probability that the unit refers to several sections at once. */
  readonly several?: number
  /** Line label the unit continues. */
  readonly chain?: string
  /** Work label, or a group label "a + b" → probability that the unit needs its result. */
  readonly needs?: { readonly [label: string]: number }
  readonly clarify?: number
  readonly why?: 'missing' | 'conflict'
  /** Other part number (1-based, as F1, F2) → probability that this part needs it. */
  readonly after?: { readonly [part: number]: number }
  /** Session requirement number (1-based) → probability that the unit changes it. */
  readonly requirements?: { readonly [n: number]: number }
}

export interface MessageRules {
  readonly composite?: number
  readonly sessionwide?: number
  readonly barrier?: number
  /** Shared requirement number (1-based) → probability that it is ambiguous. */
  readonly sharedClarify?: { readonly [n: number]: number }
  /** Consumer label → probability that the correction affects it. */
  readonly affected?: { readonly [label: string]: number }
  readonly message?: UnitRules
  /** Per part F1, F2, …: index 0 is F1. */
  readonly parts?: readonly UnitRules[]
}

function numbered(state: string, letter: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of state.split('\n')) {
    const m = new RegExp(`^${letter}(\\d+)\\. "([^"]*)"`).exec(line)
    if (m?.[1] && m[2] !== undefined) out.set(Number(m[1]), m[2])
    const q = new RegExp(`^${letter}(\\d+)\\. A question Committee asked`).exec(line)
    if (q?.[1]) out.set(Number(q[1]), 'Question')
    const g = new RegExp(`^${letter}(\\d+)\\. The parallel requests "([^"]*)"`).exec(line)
    if (g?.[1] && g[2] !== undefined) out.set(Number(g[1]), g[2])
  }
  return out
}

/** Answers a decision request from rules keyed by the message text. */
export function answerFrom(rules: { readonly [text: string]: MessageRules }) {
  return (request: DecisionRequest<DecisionQuestions>): DecisionResult<DecisionQuestions> => {
    const text = /New message: "([\s\S]*?)"\n/.exec(`${request.state}\n`)?.[1] ?? /Corrections in the new message "([\s\S]*?)":/.exec(request.state)?.[1] ?? ''
    const r = rules[text] ?? {}
    const sections = numbered(request.state, 'S')
    const lines = numbered(request.state, 'L')
    const work = numbered(request.state, 'W')
    const groups = numbered(request.state, 'G')
    const answers: { [id: string]: unknown } = {}
    const noul = (p: number | undefined): unknown => ({ type: 'noul', probability: p ?? 0.05 })
    const choice = (options: readonly string[], chosen: string | undefined, confidence = 0.9): unknown => {
      const option = chosen && options.includes(chosen) ? chosen : (options[0] ?? '')
      const c = chosen && options.includes(chosen) ? confidence : 0.3
      return { type: 'choice', choice: option, confidence: c, probabilities: Object.fromEntries(options.map((o) => [o, o === option ? c : (1 - c) / Math.max(1, options.length - 1)])) }
    }
    for (const [id, q] of Object.entries(request.questions)) {
      const options = q.type === 'choice' ? Object.keys(q.options) : []
      if (id === 'composite') answers[id] = noul(r.composite)
      else if (id === 'sessionwide') answers[id] = noul(r.sessionwide)
      else if (id === 'barrier') answers[id] = noul(r.barrier)
      else if (/^q(\d+)_clarify$/.test(id)) answers[id] = noul(r.sharedClarify?.[Number(/^q(\d+)/.exec(id)?.[1])])
      else if (/^a\d+_\d+$/.test(id)) {
        const label = Object.keys(r.affected ?? {}).find((l) => q.instructions.includes(`"${l}"`))
        answers[id] = noul(label ? r.affected?.[label] : undefined)
      } else {
        const m = /^(m|f(\d+))_(.+)$/.exec(id)
        const u: UnitRules = (m?.[1] === 'm' ? r.message : r.parts?.[Number(m?.[2])]) ?? {}
        const question = m?.[3] ?? ''
        const n = Number(/\d+$/.exec(question)?.[0])
        if (question === 'corrective') answers[id] = noul(u.corrective)
        else if (question === 'shared') answers[id] = noul(u.shared)
        else if (question === 'several') answers[id] = noul(u.several)
        else if (question === 'relation') answers[id] = choice(options, u.relation ?? 'new')
        else if (question === 'clarify') answers[id] = noul(u.clarify)
        else if (question === 'why') answers[id] = choice(options, u.why ?? 'missing')
        else if (question === 'chain') {
          const n2 = [...lines].find(([, label]) => label === u.chain)?.[0]
          answers[id] = choice(options, n2 ? `L${n2}` : undefined)
        } else if (/^s\d+$/.test(question)) answers[id] = noul(u.targets?.[sections.get(n) ?? ''])
        else if (/^w\d+$/.test(question)) answers[id] = noul(u.needs?.[work.get(n) ?? ''])
        else if (/^g\d+$/.test(question)) answers[id] = noul(u.needs?.[groups.get(n) ?? ''])
        else if (/^r\d+$/.test(question)) answers[id] = noul(u.requirements?.[n])
        else if (/^after_f\d+$/.test(question)) answers[id] = noul(u.after?.[n + 1])
        else answers[id] = noul(undefined)
      }
    }
    return { ok: true, model: 'typesafe/jev-1.13-20260917', answers: answers as never, usage: null }
  }
}

/** A fragment as a test states it: quoted from the message. */
export interface FragmentSpec {
  readonly part: string
  readonly instruction?: string
  readonly label: string
  readonly requirements?: readonly { readonly text: string; readonly part?: string; readonly scope?: 'local' | 'session-wide' }[]
  readonly after?: readonly number[]
}

export function decomposition(
  text: string,
  fragments: readonly FragmentSpec[],
  extra: { readonly barrier?: { readonly reason: 'explicit-order' | 'combined-limit' | 'integrated-presentation'; readonly qualifier: string }; readonly outputOrder?: readonly number[] } = {},
): DecomposeResult {
  return {
    ok: true,
    decomposition: {
      fragments: fragments.map(
        (f, i): DecomposedFragment => ({
          key: `k${i}`,
          sourceSpans: spanOf(text, f.part),
          instruction: f.instruction ?? f.part,
          label: f.label,
          requirements: (f.requirements ?? []).map((q) => ({ text: q.text, span: q.part ? (spanOf(text, q.part)[0] ?? null) : null, scope: q.scope ?? 'local' })),
          dependsOnFragments: (f.after ?? []).map((j) => `k${j}`),
          dependsOnCandidates: [],
        }),
      ),
      barrier: extra.barrier ?? null,
      outputOrder: extra.outputOrder ? extra.outputOrder.map((j) => `k${j}`) : null,
    },
  }
}

export interface RoutingScenario {
  readonly t: TestBackend
  readonly c: ConversationId
  readonly rules: { [text: string]: MessageRules }
  state(): ConversationState
  d(label: string): DirectiveRow
  /** Routes `text` with `rules` (and a decomposition when given), submits, settles. */
  send(text: string, rules?: MessageRules, options?: { readonly decompose?: readonly FragmentSpec[]; readonly extra?: Parameters<typeof decomposition>[2]; readonly replyTo?: readonly string[] }): Promise<MessageId>
  events(): Promise<ConversationEvent[]>
  directive(id: DirectiveId): DirectiveRow
}

/** A conversation on a backend with the engine and the routing slice, the real router over scripted decisions. */
export async function routingScenario(overrides: TestBackendOverrides = {}): Promise<RoutingScenario> {
  const t = await createTestBackend({ modules: [engineModule, routingModule], useScriptedRouter: false, ...overrides })
  const c = await t.createConversation()
  const rules: { [text: string]: MessageRules } = {}
  t.decisions.answerWith(answerFrom(rules))
  const state = (): ConversationState => t.state(c)
  const d = (label: string): DirectiveRow => {
    const s = state()
    const found = s.directiveOrder.map((id) => s.directives[id]).find((x) => x?.label === label)
    if (!found) throw new Error(`No directive labelled "${label}" (have: ${s.directiveOrder.map((id) => s.directives[id]?.label).join(', ')})`)
    return found
  }
  return {
    t,
    c,
    rules,
    state,
    d,
    directive(id) {
      const found = state().directives[id]
      if (!found) throw new Error(`No directive ${id}`)
      return found
    },
    async send(text, messageRules = {}, options = {}) {
      rules[text] = messageRules
      if (options.decompose) t.decomposer.push(decomposition(text, options.decompose, options.extra))
      const targets = (options.replyTo ?? []).map((label) => {
        const section = d(label).sectionId
        if (!section) throw new Error(`"${label}" has no section`)
        return section
      })
      return t.submit(c, text, targets)
    },
    async events() {
      const result = await t.backend.snapshot({ kind: 'events', conversationId: c, afterSeq: 0 })
      if (!result.ok) throw new Error(result.error.message)
      return [...result.value.events]
    },
  }
}
