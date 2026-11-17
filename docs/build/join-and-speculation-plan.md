# Joins that hold, and speculative fan-out in decision requests

Plan, 2026-11-15. Source: the export `pluribus-log-cnv_01M78JH41T1Y9GQB9ZBBXNF43Q-20261112-191632.json` (five messages: Kyoto; why is the sky blue; does the ocean reflect the sky; "Tell me about the ocean and sky in kyoto"; "is kyotos ocean blue too?").

## 1. What the log shows

| Seq | Message | What routing did |
|---|---|---|
| 1–109 | "Tell me about kyoto", "why is hte sky blue?" | Two root chains, L1 and L2. One decision request each |
| 110–111 | "And does the ocean reflect the sky?" | Continues L2 (`m_s2` 0.71, target choice 0.7). Correct |
| 139–140 | "Tell me about the ocean and sky in kyoto" | **Asked which answer:** Kyoto 0.57, ocean 0.43, sky 0.39. None reached `targetChoice` (0.7), all were above the ambiguity floor (0.25), so the result was a target-ambiguity elicitation |
| 141–142 | The user ticked Kyoto only | Routed again with the chosen target. The whole gate was asked a second time (composite, relation, chain, clarify…), and the request continued L1. The sky and ocean context was lost |
| 201–202 | "is kyotos ocean blue too?" | Continues the answer from seq 142 (0.86). Correct given that answer, but it still sees no L2 context |

The causes, in order:

1. **The build that wrote the log had no joining.** The log's `thresholds` have no `joinChoice`. The export was written at 19:16 UTC on 2026-11-12, and `187a47c` (joining instead of asking) landed at 22:00 UTC. So that build could only ask. The current code handles this exact scene: it is the 05 edge case, test T4 (`join-lines.test.ts`, with the log's scores) and the corpus example `target-join-lines-instead-of-asking`. Stored settings are safe: `normalizeSettings` fills a missing `joinChoice` with 0.8.
2. **The current join is fragile.** It rests on one yes/no question (`m_lines`) at a thin margin: 0.85 to 0.88 on this state, against a threshold of 0.8 (PLAN §7). The corpus has one example of the case.
3. **A join is only reachable through the ambiguity path** (`joinedTargets` is called only where `resolveUnitTargets` would return `ambiguous`). This is correct per spec ("a follow-up with one clear target is not widened"). But if Kyoto had scored 0.72 and both sky sections had scored under 0.25, the sky line would have been dropped silently.
4. **The fallback question doesn't help the user join.** The panel lets the user tick several answers (`elicitation-modal.tsx`), and ticking answers on two lines does produce a join chain through `derivePlacement`. But nothing on the panel suggests that, so the user picked one answer.
5. **Answering the question costs a second full gate.** Seq 142 asks again everything seq 140's request asked, over the same state.
6. That build also did not record the decision behind the question, so the export cannot show `m_lines` or `m_several` for seq 140. This is fixed: `askRecord` is now on `elicitation-raised`.

## 2. Join fixes

**J1. Per-line need questions, in the same request.** In the gate (and in each fragment's request), add one yes/no question per listed line:

> Does the new message need the context of line L*i* ("…label…")?

Unlike `m_chain`, these are independent, so "both" can score high on each. The rule:

- Join when `m_lines` ≥ `joinChoice`, **or** when two or more lines reach a new `lineNeed` threshold (start at 0.6 and sweep it on the corpus).
- Keep the same guard as now: this applies only where Pluribus would otherwise ask, and never widens a clear single target.

Cost: about 7 tokens plus the question text (≈ 25) per line. Cap the lines asked about at the window's line count. This is the fan-out pattern applied to joining: all the questions are answerable from the gate's state, and code reads them only on the ambiguity branch.

**J2. A "together" option on the question panel** (web). When the candidates span two or more lines, add a "Use all of these together" choice that sends every candidate. Name the join in the help text. Routing is unchanged: chosen targets on several lines already make a join chain.

**J3. Reuse the gate on the re-route** (also fan-out item F3). The elicitation's recorded `decision` already holds every gate answer. When the user answers and the conversation has not changed since the question was raised, rebuild the signals from that record instead of asking again. Check "not changed" by the log's sequence, or by a hash of the supplied candidates. This saves one full request (≈ 1,300 tokens here) per answered question.

## 3. Speculative fan-out: where it pays

Decisions are charged by input tokens only. A request costs ≈ 300 fixed tokens, plus 0.35 per character of state, plus ≈ 7 + 0.32 × text per question, at about 0.15 s each (dependency-decisioning.md · Cost). A merged request saves the fixed part, the repeated state, and one round trip. An extra question costs only its own text. The Jev guide adds three conditions: every question must be answerable from the shared state, no question may need another's answer, and rare branches should stay sequential.

Here is every decision request the pipeline makes today (`pipeline.ts`):

| Request | Depends on | Verdict |
|---|---|---|
| Gate (`:250`) | the message | Stays. It is the carrier for everything below |
| Session-wide per requirement (`:309`) | the decomposer's requirement text | **F1:** merge into the per-fragment request |
| Ordered-output check (`:330`) | the decomposer's barrier | **F1:** merge into the per-fragment request |
| Per-fragment units (`:535`) | the decomposer's fragments | Stays. After F1 it carries the two above |
| Tree-walk further levels (`tree-walk.ts:123`) | which segments cleared the floor | **F2:** prefetch one level, gated |
| Re-route after an elicitation | the user's choice | **F3** (= J3): reuse the recorded answers |
| Affected work of a shared revision (`:1212`) | the gate finding a revision | Keep sequential: revisions are rare and the questions grow with the consumers |
| Strategy selector (decision mode) | nothing | Already off by default (`rules`) |

- **F1. One request after the decomposer, not three.** The session-wide confirmations and the ordered check depend only on the decomposition, as the per-fragment questions do. Put them in the `:535` batch, under their present IDs. No answer feeds another, so this is not even speculative. On a composite message that sets a conversation-wide rule, it saves up to two requests (≈ 600 fixed tokens plus two copies of the state) and ≈ 0.3 s.
- **F2. Prefetch the next tree-walk level when it is likely to be needed.** When the gate's referent questions include a branch point whose children are few (n₁ ≤ 3) and the lexical candidate source names a section below it, list those children in the gate's state and ask about them there. Use their answers only if the parent segment clears the floor, and fit them inside `fitWindow`'s budget as now.
  - Break-even: prefetching costs ≈ 125·n₁ tokens when it is not used, and saves ≈ 340 tokens plus a round trip when it is.
  - On the corpus the tree walk averages 1.61 requests, and the typical case is exactly one further level ("J, group closed": 1,274 + 625 tokens over two requests). Measure before keeping it.
- **F3.** See J3.

**Observability, as the guide asks.** Give `DecisionQuestionRecord` a `speculative: boolean` field and a `use: 'consumed' | 'ignored'` field, written by deterministic code. Show both in the run inspector and the log export. Add a per-question consumed-rate row to the corpus report. Remove a speculative question that never changes a decision on the corpus.

**Switch.** Add `routing.speculation: 'off' | 'on'` (default `on` once measured), so the corpus and the smoke tests can A/B it and a regression can be turned off in settings.

## 4. Smoke tests (live, `pnpm smoke`)

Core has no I/O, so both tests sit with the other live suites in `packages/providers/test/smoke/`. They drive the core engine through `createBackend`, as `j-request.smoke.test.ts` does. They use Haiku for every generative role. Each costs well under $0.01.

**S1. `join-lines.smoke.test.ts`: this log, end to end.**

- **Fixture:** the first four message texts of the export (a trimmed fixture with only those texts, nothing else from the log), sent in order, with the answers awaited. Three runs.
- **Asserts:**
  - Message 4 raises no elicitation.
  - Its directive is on a `join` chain whose planned parents are the Kyoto leaf and the ocean leaf (the sky answer is read through the ocean answer).
  - It runs with model role `synthesis`.
  - The `routing-decided` records `joinedLines`.
- **Negative control, same scene:** "Make that shorter" still raises a target-ambiguity elicitation.
- **Prints:** `m_lines` (and the `m_L*` scores once J1 lands) per run, so the margin over `joinChoice` is visible on every smoke run.

**S2. `speculative-fan-out.smoke.test.ts`: same plan, fewer tokens.**

- **Three scenes:**
  - A composite message with a conversation-wide requirement and an ordered list (F1).
  - The trip tree with one relevant branch point (F2).
  - This log's message 4 with joining off, answered through the elicitation (F3).
- **Method:** route each with `speculation: 'off'` and then `'on'`.
- **Asserts:**
  - The placement, targets and relation are identical.
  - With speculation on there are strictly fewer decision requests and lower total reported `usage.input_tokens`.
- **Prints:** the deltas, for the build record.

Each change also gets its deterministic twin in `packages/core/test/` with the scripted provider, named by acceptance ID (T4 for J1; the F tests under routing).

## 5. Order

1. S1 against the current code. This confirms the join works live today and records the `m_lines` margin. **Done 2026-11-15:** 6 of 6 joined; `m_lines` was 0.86 to 0.87, and "Make that shorter" scored 0.22 and was asked (STATUS.md · "The join through the whole backend, live").
2. J1, then the corpus sweep for `lineNeed`.
3. F1 and F3. They are low-risk and their savings are certain. Then S2.
4. F2, behind its gate, kept only if S2 and the corpus show a net saving.
5. J2 (web).
