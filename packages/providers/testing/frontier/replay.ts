import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { providerError } from '@pluribus/protocol'
import type { CancelSignal, DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult } from '@pluribus/core/ports'
import { toWireRequest } from '../../src/openrouter/decision-provider'

/**
 * Test-only: record and replay of live decision answers, keyed by the exact
 * request (model, state text and questions, as the wire body carries them).
 *
 * A cache holds **replicas**: replica k is one live answer per distinct
 * request, recorded the first time any setting sends that request in
 * replica k and replayed to every setting after. So within a replica every
 * setting that sends the same request sees the same answer, as the
 * threshold tuning of PLAN §7 did, and the replicas together are as many
 * independent live runs. A threshold acts after the model answers, so a
 * threshold sweep over a replica sends nothing live except where the
 * threshold changes which requests are sent (`ReplayStats.recorded`).
 *
 * The files live where the caller says (`FRONTIER_CACHE_DIR`), never in the
 * repository. A line holds the key, the wire body and the parsed result; no
 * key, header or credential is ever written. Failed answers are not cached.
 */

export interface ReplayStats {
  /** Requests answered from the replica. */
  readonly replayed: number
  /** Requests sent live and recorded into the replica. */
  readonly recorded: number
  /** Requests that failed live (after retries) and were not recorded. */
  readonly failed: number
}

export interface ReplayCache {
  readonly replica: number
  readonly file: string
  /** Distinct requests the replica holds. */
  size(): number
  /** A decision provider over the replica: replayed when the request is held, otherwise sent to `live` and recorded. */
  provider(): DecisionProvider & { stats(): ReplayStats }
}

export interface ReplayOptions {
  readonly dir: string
  readonly replica: number
  /** Where a request the replica does not hold goes. Null: replay only, and a miss is a failure. */
  readonly live: DecisionProvider | null
  /** Retries of a failed live request; default 4, waiting 1, 2, 4, 8 s. */
  readonly retries?: number
}

interface Line {
  readonly key: string
  readonly body: ReturnType<typeof toWireRequest>
  readonly result: Extract<DecisionResult<DecisionQuestions>, { readonly ok: true }>
}

/** The key of a request: a hash of its wire body. */
export function requestKey(request: DecisionRequest<DecisionQuestions>): string {
  return createHash('sha256').update(JSON.stringify(toWireRequest(request))).digest('hex')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function openReplayCache(options: ReplayOptions): ReplayCache {
  mkdirSync(options.dir, { recursive: true })
  const file = path.join(options.dir, `replica-${options.replica}.jsonl`)
  const held = new Map<string, Line['result']>()
  if (existsSync(file)) {
    for (const text of readFileSync(file, 'utf8').split('\n')) {
      if (text.trim() === '') continue
      const line = JSON.parse(text) as Line
      held.set(line.key, line.result)
    }
  }
  const pending = new Map<string, Promise<DecisionResult<DecisionQuestions>>>()
  const retries = options.retries ?? 4

  async function sendLive(key: string, request: DecisionRequest<DecisionQuestions>, signal: CancelSignal): Promise<DecisionResult<DecisionQuestions>> {
    const live = options.live
    if (live === null) return { ok: false, error: providerError('invalid-request', `replica ${options.replica} holds no answer for this request`) }
    let result = await live.decide(request, signal)
    for (let attempt = 0; !result.ok && attempt < retries; attempt++) {
      await sleep(1_000 * 2 ** attempt)
      result = await live.decide(request, signal)
    }
    if (result.ok) {
      held.set(key, result)
      const line: Line = { key, body: toWireRequest(request), result }
      appendFileSync(file, `${JSON.stringify(line)}\n`)
    }
    return result
  }

  return {
    replica: options.replica,
    file,
    size: () => held.size,
    provider() {
      let replayed = 0
      let recorded = 0
      let failed = 0
      return {
        async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
          const generic = request as unknown as DecisionRequest<DecisionQuestions>
          const key = requestKey(generic)
          const hit = held.get(key)
          if (hit !== undefined) {
            replayed += 1
            return hit as unknown as DecisionResult<Q>
          }
          // Two routings that send the same request at once share one live call.
          const inFlight = pending.get(key)
          if (inFlight !== undefined) {
            const shared = await inFlight
            if (shared.ok) replayed += 1
            else failed += 1
            return shared as unknown as DecisionResult<Q>
          }
          const sent = sendLive(key, generic, signal)
          pending.set(key, sent)
          const result = await sent
          pending.delete(key)
          if (result.ok) recorded += 1
          else failed += 1
          return result as unknown as DecisionResult<Q>
        },
        stats: () => ({ replayed, recorded, failed }),
      }
    },
  }
}
