import { DEFAULT_SETTINGS } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult } from '../../../src/ports'
import { createRouter } from '../../../src/routing/pipeline'
import { compare, corpusInput, oracleDecisionProvider, referenceDecomposer } from '../../../testing/routing/corpus/evaluate'
import { ROUTING_CORPUS } from '../../../testing/routing/corpus/examples'
import type { CorpusExample } from '../../../testing/routing/corpus/types'

/**
 * What a reply to one old answer costs in the corpus's 200-section
 * conversations, with the default settings (strategy by rules, the lexical
 * candidate source) and decisions as labelled. The probes are built here
 * from the corpus's scenes and are not corpus cases: one chain of 200
 * answers, and 199 unrelated answers, with a reply to the answer at
 * several depths. What is asserted is the shape of the spend (how many
 * requests, what a request names), not token figures.
 */

const sceneOf = (id: string): CorpusExample['scene'] => {
  const found = ROUTING_CORPUS.find((e) => e.id === id)?.scene
  if (!found) throw new Error(`no example ${id}`)
  return found
}
const chain = sceneOf('long-chain-old-section')
const roots = sceneOf('long-roots-old-section')
const titleOf = (scene: CorpusExample['scene'], handle: string): string => scene.candidates.sections.find((s) => s.sectionId === `sec_${handle}`)?.title ?? ''

function probe(kind: 'chain' | 'roots', k: number): CorpusExample {
  const handle = kind === 'chain' ? `E${k}` : `R${k}`
  const scene = kind === 'chain' ? chain : roots
  const topic = kind === 'chain' ? titleOf(scene, handle).replace('Next entry: ', '') : titleOf(scene, handle).replace('What should I know about ', '').replace(/\?$/, '')
  const text = kind === 'chain' ? `Make the entry on ${topic} shorter` : `Go back to the answer about ${topic} and add a diagram`
  return { id: `${kind}-${handle}`, covers: ['targets'], note: '05, Q20: a reply to one answer of a long conversation targets it however old it is.', scene, text, expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: [handle], placement: { continue: handle } }] } }
}

async function route(example: CorpusExample) {
  const input = corpusInput(example, DEFAULT_SETTINGS)
  const oracle = oracleDecisionProvider(example, input)
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const provider: DecisionProvider = {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: typeof NEVER_CANCELLED): Promise<DecisionResult<Q>> {
      requests.push(request)
      return oracle.decide(request, signal)
    },
  }
  const outcome = await createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
  /** The request texts the further requests name sections by: "Next entry: …" or "What should I know about …". */
  const named = requests.slice(1).flatMap((r) => Object.values(r.questions).flatMap((q) => q.instructions))
  return { outcome, requests, named, mismatches: compare(example, outcome) }
}

describe('spend in a 200-section conversation', () => {
  test.each([40, 100, 150, 172])('spend · a reply to the entry at depth %i of one chain: the candidate is asked about by itself, and the answers above it are neither asked about nor searched', async (k) => {
    const example = probe('chain', k)
    const routed = await route(example)
    expect(routed.mismatches).toEqual([])
    // The routing request, the candidate by itself, then the rest of the run below it.
    expect(routed.requests).toHaveLength(3)
    expect(Object.keys(routed.requests[1]?.questions ?? {})).toHaveLength(1)
    const topicAbove = titleOf(chain, `E${k - 1}`).replace('Next entry: ', '')
    expect(routed.named.some((text) => text.includes(`"Next entry: ${topicAbove}"`))).toBe(false)
  })

  test.each([5, 100, 172])('spend · a reply to old answer %i of 199 unrelated ones: its question rides in the search of the old answers, and no part is opened', async (k) => {
    const routed = await route(probe('roots', k))
    expect(routed.mismatches).toEqual([])
    expect(routed.requests).toHaveLength(2)
  })

  test.each([180, 190])('spend · a reply to answer %i, listed in the routing request and confirmed there: the old answers are not searched', async (k) => {
    const routed = await route(probe('roots', k))
    expect(routed.mismatches).toEqual([])
    expect(routed.requests).toHaveLength(1)
  })
})
