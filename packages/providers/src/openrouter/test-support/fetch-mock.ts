import type { FetchLike } from '../http'

/** Test-only: a scripted `fetch` that records every request. Not exported from the package. */

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly signal: AbortSignal | null
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>

export interface FetchMock {
  readonly fetch: FetchLike
  readonly requests: RecordedRequest[]
}

export function mockFetch(...responders: Responder[]): FetchMock {
  const requests: RecordedRequest[] = []
  let call = 0
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value
    })
    const recorded: RecordedRequest = {
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      signal: init.signal ?? null,
    }
    requests.push(recorded)
    const responder = responders[Math.min(call, responders.length - 1)]
    call += 1
    if (responder === undefined) throw new Error('mockFetch: no responder')
    return responder(recorded)
  }
  return { fetch, requests }
}

const encoder = new TextEncoder()

/** An SSE response whose body yields exactly these string pieces (split anywhere the test likes). */
export function sseResponse(pieces: readonly (string | Uint8Array)[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece)
      controller.close()
    },
  })
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...init.headers },
  })
}

/**
 * An SSE response that sends `pieces` and then stays open until the
 * request's signal aborts, when the body errors like a real aborted fetch.
 */
export function hangingSseResponse(request: RecordedRequest, pieces: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      const abort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'))
      if (request.signal?.aborted === true) abort()
      else request.signal?.addEventListener('abort', abort, { once: true })
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** One SSE `data:` event for a content delta. */
export function delta(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finishReason }] })}\n\n`
}

export function usageChunk(prompt: number, completion: number): string {
  return `data: ${JSON.stringify({ id: 'gen-1', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`
}

export const DONE = 'data: [DONE]\n\n'

export const TEST_KEY = 'sk-or-v1-test-key-0000'

export const withKey = async (): Promise<string | null> => TEST_KEY
export const withoutKey = async (): Promise<string | null> => null
