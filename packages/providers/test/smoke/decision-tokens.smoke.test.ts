import { describe, expect, it } from 'vitest'
import { NEVER_CANCELLED } from '@pluribus/core/ports'
import { estimateRequestTokens } from '@pluribus/core'
import { costGridRows } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'
import { corpusThroughMock, settingsFor } from '../../testing/openrouter/corpus-through-mock'
import { FITTED_CALIBRATION, calibratedTokens, createDecisionsApiMock, contentCharacters, contentTokens, toPortRequest, type WireDecisionBody } from '../../testing/openrouter/decisions-api-mock'

/**
 * Calibrates the tokenizer of the Decisions mock against the live decision
 * model (docs/build/dependency-decisioning.md · "Measuring tokens"). Run with
 * `pnpm smoke`; skipped when OPENROUTER_KEY is absent. The key reaches the
 * provider through `getKey` only and is never printed.
 *
 * A handful of bodies of varied size, from the CLAUDE.md sample to the
 * corpus's largest routing request, each sent once. For each it prints the
 * input tokens the provider reported, the tokenizer's count of the body's
 * text (`o200k_base`, a proxy: the decision model's tokenizer is not
 * public), characters ÷ 4 of the same text, and the guard's estimate; then a
 * least-squares fit of reported = a + b × questions + c × tokenizer tokens,
 * from which `FITTED_CALIBRATION` is taken. Only a loose band is asserted.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const MODEL = 'typesafe/jev-1.13'

const SAMPLE: WireDecisionBody = {
  model: MODEL,
  state: 'Hi there!',
  questions: {
    isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
    kind: { type: 'choice', instructions: 'What kind of message is it?', criteria: { greet: 'a greeting', ask: 'a question' } },
    tone: { type: 'score', instructions: 'How polite is it?', criteria: ['polite', 'warm'] },
  },
}

/** Solves the least-squares fit y ≈ X·β by the normal equations (three unknowns at most). */
function leastSquares(rows: readonly (readonly number[])[], y: readonly number[]): number[] {
  const n = rows[0]?.length ?? 0
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => rows.reduce((s, r, k) => s + (r[i] ?? 0) * (j < n ? (r[j] ?? 0) : (y[k] ?? 0)), 0)))
  for (let i = 0; i < n; i++) {
    const pivot = a[i]?.[i] ?? 1
    for (let j = i; j <= n; j++) (a[i] as number[])[j] = (a[i]?.[j] ?? 0) / pivot
    for (let r = 0; r < n; r++) {
      if (r === i) continue
      const f = a[r]?.[i] ?? 0
      for (let j = i; j <= n; j++) (a[r] as number[])[j] = (a[r]?.[j] ?? 0) - f * (a[i]?.[j] ?? 0)
    }
  }
  return a.map((row) => row[n] ?? 0)
}

describe.skipIf(key === '')('decision tokens, live calibration', () => {
  it('compares the reported input tokens with the tokenizer and with characters ÷ 4', { timeout: 300_000 }, async () => {
    // Bodies exactly as the provider sends them, from the corpus routed by the default settings over the mock.
    const corpus = (await corpusThroughMock(settingsFor('selected by rules (the default)'))).flatMap((e) => e.calls.map((c) => c.body))
    const bySize = [...corpus].sort((x, y) => contentCharacters(x) - contentCharacters(y))
    const picks = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1].map((q) => bySize[Math.min(bySize.length - 1, Math.round(q * (bySize.length - 1)))])
    const bodies = [SAMPLE, ...picks.filter((b): b is WireDecisionBody => b !== undefined).map((b) => ({ ...b, model: MODEL }))]

    const provider = createOpenRouterDecisionProvider({ getKey })
    const rows: { questions: number; characters: number; tokenizer: number; quarter: number; estimate: number; reported: number }[] = []
    for (const body of bodies) {
      const request = toPortRequest(body)
      const result = await provider.decide(request, NEVER_CANCELLED)
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
      if (!result.ok || result.usage === null) continue
      const characters = contentCharacters(body)
      rows.push({
        questions: Object.keys(body.questions).length,
        characters,
        tokenizer: contentTokens(body),
        quarter: Math.ceil(characters / 4),
        estimate: estimateRequestTokens(request.state, request.questions),
        reported: result.usage.inputTokens,
      })
    }
    const [a = 0, b = 0, c = 0] = leastSquares(rows.map((r) => [1, r.questions, r.tokenizer]), rows.map((r) => r.reported))
    const [a1 = 0, b1 = 0] = leastSquares(rows.map((r) => [1, r.questions]), rows.map((r) => r.reported - r.tokenizer))
    const [a2 = 0, b2 = 0, c2 = 0] = leastSquares(rows.map((r) => [1, r.questions, r.characters]), rows.map((r) => r.reported))
    const withTemplate = (r: (typeof rows)[number]): number => calibratedTokens(FITTED_CALIBRATION, r.questions, r.tokenizer)
    console.log(
      [
        '| Questions | Characters | Reported | Tokenizer (text) | Tokenizer, calibrated | Characters ÷ 4 | Guard estimate | Reported ÷ calibrated | Reported ÷ estimate | Tokenizer ÷ (characters ÷ 4) |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...rows.map(
          (r) =>
            `| ${r.questions} | ${r.characters} | ${r.reported} | ${r.tokenizer} | ${withTemplate(r)} | ${r.quarter} | ${r.estimate} | ${(r.reported / withTemplate(r)).toFixed(3)} | ${(r.reported / r.estimate).toFixed(3)} | ${(r.tokenizer / r.quarter).toFixed(3)} |`,
        ),
        `fit: reported ≈ ${a.toFixed(1)} + ${b.toFixed(2)} × questions + ${c.toFixed(3)} × tokenizer`,
        `fit with the tokenizer's slope held at 1: reported − tokenizer ≈ ${a1.toFixed(1)} + ${b1.toFixed(2)} × questions`,
        `fit on characters: reported ≈ ${a2.toFixed(1)} + ${b2.toFixed(2)} × questions + ${c2.toFixed(4)} × characters (${(1 / c2).toFixed(2)} characters per token)`,
        `in use: FITTED_CALIBRATION = ${FITTED_CALIBRATION.perRequest} + ${FITTED_CALIBRATION.perQuestion} × questions + ${FITTED_CALIBRATION.perTextToken} × tokenizer`,
      ].join('\n'),
    )
    expect(rows.length).toBe(bodies.length)
    for (const r of rows) {
      // A loose band only: the reported count is within a factor of two of the calibrated tokenizer count, and of the estimate.
      expect(r.reported / withTemplate(r)).toBeGreaterThan(0.5)
      expect(r.reported / withTemplate(r)).toBeLessThan(2)
      expect(r.reported / r.estimate).toBeGreaterThan(0.5)
      expect(r.reported / r.estimate).toBeLessThan(2)
    }
  })

  it('compares the same for the cost grid’s requests, whose text is synthetic', { timeout: 300_000 }, async () => {
    // The requests of the cells worst by the tokenizer (120-token exchanges) and of a large one, as the provider sends them.
    const bodies: WireDecisionBody[] = []
    for (const [sections, exchange] of [[50, 120], [500, 2_000]] as const) {
      const captured: WireDecisionBody[] = []
      await costGridRows(sections, exchange, {
        unguarded: false,
        through: (worstCase) => {
          const api = createDecisionsApiMock({ answerer: worstCase })
          return { provider: createOpenRouterDecisionProvider({ getKey: async () => 'sk-or-v1-mock', fetch: api.fetch }), inputTokens: () => { captured.push(...api.calls.map((c) => c.body)); return 0 } }
        },
      })
      const unique = [...new Map(captured.map((b) => [JSON.stringify(b), b])).values()].sort((x, y) => contentCharacters(x) - contentCharacters(y))
      for (const q of [0, 0.5, 1]) {
        const b = unique[Math.round(q * (unique.length - 1))]
        if (b) bodies.push({ ...b, model: MODEL })
      }
    }
    const provider = createOpenRouterDecisionProvider({ getKey })
    const lines: string[] = []
    for (const body of bodies) {
      const request = toPortRequest(body)
      const result = await provider.decide(request, NEVER_CANCELLED)
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
      if (!result.ok || result.usage === null) continue
      const questions = Object.keys(body.questions).length
      const calibrated = calibratedTokens(FITTED_CALIBRATION, questions, contentTokens(body))
      const estimate = estimateRequestTokens(request.state, request.questions)
      const reported = result.usage.inputTokens
      lines.push(`| ${questions} | ${contentCharacters(body)} | ${reported} | ${contentTokens(body)} | ${calibrated} | ${estimate} | ${(reported / calibrated).toFixed(3)} | ${(reported / estimate).toFixed(3)} |`)
      expect(reported / calibrated).toBeGreaterThan(0.5)
      expect(reported / calibrated).toBeLessThan(2)
    }
    console.log(['| Questions | Characters | Reported | Tokenizer (text) | Tokenizer, calibrated | Guard estimate | Reported ÷ calibrated | Reported ÷ estimate |', '|---|---|---|---|---|---|---|---|', ...lines].join('\n'))
  })
})
