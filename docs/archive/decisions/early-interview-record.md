> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Early interview record: Q1–Q10 and Q24

Recovered from the original Committee design chat on November 10, 2026. Each entry gives the question context, the user's answer, and its meaning at that point. Quoted text is from the user; surrounding explanations are summaries. This is historical evidence, not a replacement for later accepted scenario decisions. The user's standing rule: a later answer supersedes an earlier one wherever the two clearly conflict. A supplemental Q12 entry records the change that superseded Q7's original answer-order rule.

## Q1 — Initial scope: conversation or shared-resource actions?

**Context:** Independent conversations can still conflict when agents edit the same file or change external resources. The question proposed starting with text and read-only research rather than shared-resource mutations.

**Answer:** “Yes, start with text and read only.”

**Decision:** Initial scope is text and read-only work. Concurrency for edits, sends, and other external mutations was not accepted as part of this initial scope.

## Q2 — What constitutes a dependency?

**Context:** “Which is cheaper?” after a comparison request might be independently answerable, whereas “Expand your second recommendation” requires an unavailable answer. The proposed distinction was needing an unavailable result rather than merely sharing a topic.

**Answer:** “yes, needing an unavailable result.”

**Decision:** Topic overlap alone is not a result dependency. If intended grounding requires a pending result, the follow-up waits. The answer also began an unfinished sentence about two queues; Q7 later supplied that distinction.

## Q3 — Preserve a composite message as a parent?

**Context:** Decomposition must not lose the user's original intent or turn an integrated request into unrelated answers. The question proposed preserving the original request while executing independently useful fragments.

**Answer:** “Preserve the original message, but the underlying message chains see the fragments.” The user added: “We should then ‘join’ trees only if truely necessary.”

**Decision:** Preserve the original message; route relevant fragments to chains. Do not automatically join branches merely because they came from one message. Q4 sharpens when decomposition is appropriate.

## Q4 — Do fragments inherit shared requirements?

**Context:** A fragment cannot follow audience or output constraints it never receives. The discussion used “explain caching and indexes for beginners” and distinguished per-answer limits from a combined limit.

**Answer:** “yes, decomposition should identify shared requirements.” The user corrected the example: caching and indexes are tightly linked, or require contrast, so “the err is towards one atomic, rather than decomposed.”

**Decision:** Decomposition identifies applicable shared requirements. Split independent intents, not simply multiple topics; conservatively keep tightly related or integrated requests atomic.

## Q5 — Does a join create a new chain?

**Context:** Comparing findings from A and B needs both results, but permanently merging A and B would make later A-only questions inherit unrelated B context.

**Answer:** “yes, a join can create a new agent chain.” It is “a child node attached to both previous leaf nodes on the two original chains (so visually new color).” A further request may use A, B, or the new join chain depending on which context it requires.

**Decision:** A join chain has multiple source parents and its own identity/color. Source chains remain separately continuable. This is distinct from bookkeeping join-back in Q8.

## Q6 — Are corrections a distinct routing outcome?

**Context:** “Actually, these are for database engineers” changes two in-flight explanations without needing their unfinished answers. The recommendation was to supersede affected attempts, cancel where possible, regenerate with corrected constraints, and review affected descendants.

**Answer:** “Correct, revision is a distinct routing outcome, and I agree with the recommendation.”

**Decision:** Revisions are not ordinary new requests or result-dependent follow-ups. They supersede affected work. Later revision scenarios refine the exact lifecycle.

## Q7 — Display order versus processing order

**Context:** A strict display completion queue can hide a quick answer behind unrelated slow work. The question proposed request-anchored answer areas that update independently.

**Answer:** “Preserve request order. The display is ordered by request order, and is distinct from the processing operation queue (which must be topological and on dependencies).” Processing should appear as a changing-status badge on the user message; an upward arrow could point to earlier pending work.

**Decision at the time:** Separate request-ordered display from dependency-based processing. This answer also established the distinction between display and operation queues.

**Later change:** Q12–Q14 replaced fixed request-ordered answer positions. User messages still retain submission order; independent replies take their positions at first visible answer output and pending bubbles may be overtaken. See the supplemental Q12 entry and [ADR-0003](../adr/0003-allow-replies-to-overtake-pending-work.md). The earlier badge/navigation concept must not silently override later accepted UX.

## Q8 — Bookkeeping join-back versus model synthesis

**Context:** Two parallel related requests can finish without needing another model run to reconcile them. The recommendation was to record both results and use synthesis only when a subsequent request needs reasoning across them.

**Answer:** “Yes, record both completed results.” For future API context it would look as if the model answered the first message and then the second. The mini-map should show a “dotted clear oval” around nodes representing parallel messages.

**Decision:** Join-back can assemble completed exchanges in request order for future continuation without automatic synthesis. The dotted oval preserves the fact that the original runs were parallel; assembling future context does not imply the second historical run saw the first result.

## Q9 — Independently streaming composite sections

**Context:** Requiring all fragments to finish before composing one answer would add a barrier. The recommendation was independently arriving answer sections associated with the original request.

**Answer:** “Yes, independently streaming answer sections.”

**Decision:** Composite answers can expose sections independently. Later Q18, Q19, Q23, Q25, and Q26 define grouping, cross-output constraints, and separate responses for clarification continuations; Q9 does not remove those exceptions.

## Q10 — Explicit reply targeting and ambiguity

**Context:** With several visible or streaming answers, “Make that shorter” may refer to something other than the most recent request or completion. The question proposed lightweight explicit targeting and inference when clear.

**Answer:** “Provide lightweight reply to this affordance badge on each assistant message. For user messages with none, do elicitation via UX when genuinely ambiguous.”

**Decision:** Provide explicit reply affordances; elicit clarification for genuinely ambiguous untargeted follow-ups. Later Q20 selects section-level targets, and the user subsequently adds Jev inference of one or multiple sections.

## Q24 — What happens to siblings when a directive fails?

**Context:** Q21 initially said to fail the overall request when a fragment fails. Q24 asked whether unfinished siblings should also stop while visible answers remain. The assistant recommended stopping siblings; that recommendation was rejected.

**Answer:** “Actually, don't stop unfinished siblings. Just indicate the failure of one directive.”

**Decision:** A directive's failure does not stop its unfinished siblings. Indicate that directive's failure and retain useful output from other directives.

**Clarification in Q27:** Asked whether the earlier overall-failure status still applied, the user answered: “I intended to replace overall failure with failure only on the affected directive”. Q27 therefore supersedes Q21's aggregate failed status, not merely its possible cancellation behavior. See [scenario 2](scenarios/02-composite-requests.md) and later recovery decisions for current behavior.

## Supplemental Q12 — Why the original Q7 answer order changed

**Context:** The question proposed keeping the viewport fixed while an earlier, request-anchored answer finished above the answer being read, with an “Earlier answer ready” affordance.

**Answer:** “actually, I think we don't need to preserve response order. Instead, we can just show ‘responding’ bubble for A that gets pushed down when B completes first.”

**Decision:** Replace fixed answer slots with pending bubbles that independent replies can overtake. Q13 then explicitly retains user-message submission order; Q14 fixes reply placement at first visible output rather than completion. The user emphasized that overtaking applies only without a result dependency. Q15 separately settles viewport following.

## Supplemental Q11 — recovered later

Q11's wording was missing from every record until the user supplied it on November 10, 2026. It asked whether an unrelated request should inherit only explicitly shared context; the recommendation (required inputs plus explicitly shared instructions and preferences, never another request's topic history) was accepted. The full question, recommendation, and answer are in the [Q89–Q98 review batch record](review-batch-q89-q98.md#q11--recovered-wording).

## Additional context from the same rounds

- The user explicitly excluded LangChain and LangGraph.
- Requested debug views: color-coded chain mini-map with IDs; chat chain association including multi-chain messages; rewritten-fragment inspection; and an operation topology showing reply generation, tools/subagents, and join-back.
- Selected visual styles and later refinements are recorded in [the prototype index](../../../prototypes/ui/README.md) and current scenarios. Those visual choices should not be inferred solely from these early questions.
