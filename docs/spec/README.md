# Committee specification

This folder is the complete, hand-off-able specification for Committee. Everything needed to plan and build the first version is here. The only outside reference is the set of [UI prototypes](../../prototypes/ui/README.md), which show the chosen visual directions.

## The problem

Most chat apps treat a conversation as one line. You send a message, wait for the whole answer, and only then does the next message get handled. A follow-up sent while an answer is streaming is queued behind it, or cannot be sent at all.

This comes directly from how a language model works:

- **A model writes one sequence, one token at a time.** Each token is predicted from everything before it. An answer cannot be produced out of order, and it cannot be split in half to go faster.
- **A run cannot take new input midway.** The model is given a block of text and continues it. Once it has started, nothing can be added to what it is reading. A new message can only be considered by a new run. (Steering, described below, works between runs, not inside one.)
- **A conversation is one growing sequence.** The model keeps no memory between runs, so the app re-sends the whole transcript every turn. The next turn's input has to include the previous answer, which means the previous answer has to be finished first.

So a single thread of conversation is serial by construction, and the app has little choice but to queue. That has three costs for the user:

- **You wait for no reason.** A quick translation queues behind a long research answer it has nothing to do with.
- **Every answer reads everything.** Unrelated earlier topics are fed into each new request, which costs tokens and lets one subject leak into another.
- **Mixed messages get one blended answer.** A message with two separate requests is answered as one reply, so neither part can finish, fail, or be corrected on its own.

Committee does not remove the limit; one run is still one sequence. It stops forcing everything through a single sequence. Because a run sees only the text it is handed, separate runs with separate contexts can proceed side by side on the same model. The work is then deciding which requests can be separate runs, what each run should read, what truly has to wait for what, and how to show the results as one coherent chat. That is what this specification settles.

## What existing products do about it

Two techniques already soften the queue. Neither removes it. (Facts as of November 2026; sources at the end of this section.)

### Steering

Agent harnesses let you send a message while the agent is still working, and it changes course without starting over. Claude Code, OpenAI's Codex CLI, and Cursor all do this.

It works because an agent's turn is not one model run. It is a loop: the model writes, calls a tool, the tool returns, the model is called again with the result, and so on. Between those calls there is a gap, and the harness can slip your message in before it makes the next call.

- **Claude Code** passes a message typed during tool calls to the model "as soon as those tool calls finish, within the same turn".
- **Codex** drains pending input into the history "before building the next model request", after the current sampling and its tools have finished.
- **Cursor** runs a queued message "at the next ideal time, usually after a tool call".

No product was found that inserts text into a generation that is already under way. When the model is in the middle of writing, the choices are to wait for the next gap or to cancel. Realtime voice APIs take the second path: when the user speaks over the model, OpenAI's Realtime API cancels the response and truncates what was not yet heard, and Gemini Live discards the generation in progress.

So steering is consistent with the limit above. It delivers your message sooner, at the next step boundary, into the same single sequence.

What it gives the user: you can redirect a long task without losing its work. What it does not give: a second answer. An unrelated question typed mid-task becomes part of that task's context. The agent either absorbs it and carries on, or stops what it was doing to answer. There is still one thread of attention.

### Subagent delegation

An orchestrating model hands pieces of a task to subagents. Each subagent runs with its own context, several can run at once, and each returns a summary. Anthropic's research system, Claude Code, Codex, and the OpenAI Agents SDK all work this way.

This is real concurrency, and it is close to what Committee does underneath. The differences are in who decides and what the user sees:

- **The model decides, inside one turn.** The orchestrator chooses to delegate while answering a single request. The user's conversation is still one line: in Anthropic's system the lead agent waits for each batch of subagents, and in Codex the parent waits and returns one combined response.
- **The results come back as summaries.** The user reads the orchestrator's account of the work. The subagents' own output is hidden or sits in a side panel.
- **Subagents do not share context.** Anthropic notes they cannot coordinate with each other, and Cognition argues that parallel agents without shared context make conflicting decisions.
- **It costs more.** Anthropic reports roughly 15 times the tokens of a chat for its multi-agent system.

### How Committee differs for the user

Committee applies concurrency to the conversation itself, where steering and delegation apply it inside one turn.

| | Steering | Subagent delegation | Committee |
|---|---|---|---|
| What runs at once | One sequence | Several, inside one turn | Several, across the user's own messages |
| Who decides to split | Nobody; nothing splits | The orchestrating model | Routing, from what the user sent |
| An unrelated question sent mid-answer | Joins the current task's context, or interrupts it | Waits for the turn to end | Gets its own answer right away, on its own chain |
| A follow-up that needs the pending answer | Folded into the current task | Waits for the turn to end | Waits, and the composer shows what it is waiting for |
| What the user reads | One answer | The orchestrator's summary | Each answer directly, in a stable place |
| What each answer read | Everything so far | Whatever the orchestrator passed | Its own chain, which can be inspected |
| Correcting one piece | Redirects the whole task | Re-run the turn | Supersedes that piece and what depended on it |
| When one piece fails | The turn fails or recovers as a whole | The orchestrator decides | Only that section fails; the rest stand |

In practice the user stops managing the queue. They do not hold a question until the current answer finishes, open a second chat to ask something unrelated, or split a message in two to keep topics apart. They send what they are thinking, and each answer arrives when it is ready.

Committee does not replace either technique. Steering still suits redirecting one long task, and delegation still suits one request that fans out. The first version of Committee has neither, because it has no tools and each directive is a single run.

Sources: [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works) · [Codex turn loop](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs) · [Cursor 1.4 changelog](https://cursor.com/en/changelog/1-4) · [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) · [Gemini Live capabilities](https://aistudio.google.com/docs/live-api/capabilities) · [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) · [Codex subagents](https://developers.openai.com/codex/concepts/subagents) · [Cognition, "Don't build multi-agents"](https://cognition.com/blog/dont-build-multi-agents)

## Executive summary

Committee is a chat product in which one visible conversation runs many model calls at once. A user can send a second request while the first is still answering, and the second does not wait unless it actually needs the first one's result.

Three ideas make that work:

1. **Each run reads only its own line of context.** The conversation is a tree of chains, not one transcript. An unrelated request starts a new chain; a related one continues an existing chain; parallel requests on the same chain become forks whose results are folded back together afterwards without a model call.
2. **Work waits only on results it needs.** A dependency means needing a result that is not available yet. Sharing a topic is not a dependency. Dependencies release only when the needed work finishes successfully.
3. **The transcript shows what happened, in a stable order.** User messages stay in the order sent. A reply takes its place when its first answer text appears and never moves again, so a quick answer can appear above a slow one that was requested earlier.

On top of this, Committee splits a message that contains several independent requests, lets the user correct earlier work without rewriting history, and keeps failure local: one failed part never fails the whole request.

The first version is text and read-only (no tools, no edits to outside resources). It runs entirely in the browser, calls models through OpenRouter with the user's own key, and keeps its records in an append-only event log. No LangChain or LangGraph.

**Status:** behavior and technical design are settled through question Q98, with no open questions. The first version is implemented in `packages/`; what is built, what was verified, and where it falls short of this specification are in [the build status](../build/STATUS.md). Where the code and this specification disagree, the specification wins.

## Documents

Read in order the first time. Each behavior document ends with its acceptance conditions, the architecture's section on dependency attachment ends with its own (DA1–DA5), and every acceptance condition becomes an automated test.

| # | Document | What it covers |
|---|---|---|
| | [Glossary](glossary.md) | The vocabulary. Use these terms and no synonyms |
| 01 | [Mental model](01-mental-model.md) | Chains, forks, sibling groups, join-back, join chains, and the three relationships that must stay separate |
| 02 | [Messages and decomposition](02-messages-and-decomposition.md) | Atomic and composite messages, fragments, requirement scope, split messages |
| 03 | [Transcript and placement](03-transcript-and-placement.md) | Where messages and replies appear, pending work, scrolling, the composer queue |
| 04 | [Chains, dependencies, and context](04-chains-dependencies-context.md) | Forks and join-back in detail, result dependencies, what each run reads |
| 05 | [Reply targets and routing outcomes](05-reply-targets-and-routing.md) | What a follow-up refers to and what kind of work it is |
| 06 | [Revisions](06-revisions.md) | Correcting earlier work, supersession, effects on dependents, Regenerate |
| 07 | [Elicitation](07-elicitation.md) | When Committee asks the user, and when it may act on a default |
| 08 | [Failure, stopping, and recovery](08-failure-and-recovery.md) | Retries, stop, paused dependents, interruption |
| 09 | [Debug views](09-debug-views.md) | Mini-map, association, Compare, operation graph, run inspector, and the prototypes that illustrate them |
| 10 | [Front-end interface](10-front-end.md) | What the user sees and can do, user settings, and the commands and events between client and backend |
| 11 | [Architecture](11-architecture.md) | Backend, event log, storage, providers, routing pipeline, dependency attachment (referent strategies, decision budget, context summaries for decisions, strategy selection), scheduling, error mapping |
| 12 | [Build plan](12-build-plan.md) | Packages, milestones, tests, and what is deliberately left to the build |

## How to read citations

Rules cite the question that settled them, such as (Q33). The questions, the user's answers, and the architecture decision records are kept in [the archive](../archive/README.md). The archive is history: it explains why, and it is not needed to build. If the archive and this folder disagree, this folder is current, because it applies the user's standing rule that **a later answer supersedes an earlier one wherever the two clearly conflict**.

## What is not specification

- [`docs/archive/`](../archive/README.md): decision questions Q1–Q98 with the user's answers, the scenario-by-scenario records they were settled in, the review findings, and six ADRs.
- [`prototypes/ui/`](../../prototypes/ui/README.md): five interactive style samples. They show the selected visual directions only; several behaviors changed after they were built. [Debug views](09-debug-views.md) lists the differences.

## Changing the specification

- Continue numbering after the latest question in the [implementation interview](../implementation/implementation-interview.md). Ask questions in dependency-ready batches, each with a recommendation so that "yes" accepts it.
- Record new questions, recommendations, and verbatim answers in that interview, then edit the affected specification so it states the current behavior. The Q1–Q98 archive remains historical and read-only.
- New terms go in the glossary, free of implementation detail. Write an ADR only for a substantial, hard-to-reverse trade-off.
- Choices that do not affect a user-visible promise are left to the build and listed in the [build plan](12-build-plan.md#left-to-the-build).
