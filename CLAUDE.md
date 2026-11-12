# Committee

One visible chat that runs many model calls at once. The specification in `docs/spec/` is authoritative; read `docs/spec/README.md` first and use the glossary's terms with no synonyms. Where a prototype and the spec disagree, the spec wins (`docs/spec/09-debug-views.md` lists the differences).

- `docs/spec/` — behavior (01–08), debug views (09), front end (10), architecture (11), build plan (12). Every acceptance condition (D1–D5, P1–P13, C1–C20, T1–T3, R1–R8, E1–E5, F1–F9, DA1–DA5) becomes one deterministic test named after its ID.
- `docs/build/` — build-time decisions made while implementing (contracts, ownership, choices the spec leaves to the build).
- `prototypes/react/` — style reference for the five views (Sections chat, Compare, Genealogy, margin rails + Focus, operation graph). Not production code; do not import from it.

## Workspace

pnpm workspace, strict TypeScript. Libraries expose their source entry points through `package.json` exports and need no build step.

| Package | Contents | May depend on |
|---|---|---|
| `packages/protocol` | Command, event, projection, settings and ID types shared by client and backend. Types and tiny pure helpers only | nothing |
| `packages/core` | Event log, projections, coordinator, routing pipeline, validation. No I/O: model provider, decision provider, decomposer, stores, clock and timers are injected | `protocol` |
| `packages/storage` | Event store and projection cache adapters (IndexedDB, in-memory), local secrets store | `protocol`, `core` |
| `packages/providers` | OpenRouter and Claude streaming answers, decision provider over OpenRouter Decisions, generative decomposer | `protocol`, `core` |
| `packages/web` | Vite + React 19 + Tailwind v4 client; the backend runs embedded in a Web Worker | all of the above |

```sh
pnpm install
pnpm dev                                   # web dev server
pnpm typecheck                             # all packages
pnpm --filter @committee/core typecheck    # one package
pnpm test                                  # vitest: "unit" (node) and "web" (jsdom) projects
pnpm vitest run --project unit packages/core
pnpm smoke                                 # provider smoke suites (*.smoke.test.ts)
pnpm build
```

## Conventions

- Keep library `src/index.ts` files to re-exports. Import across packages through their declared entry points, including `@committee/core/ports` for adapter interfaces. Prefer discriminated unions and branded ID types over strings and booleans. No `any`; no non-null `!` outside tests.
- The client never decides placement, ordering, dependencies, or context. It renders the four projections (transcript, queue, genealogy, operation graph) and sends commands.
- Core is deterministic: no `Date.now()`, timers, randomness, `fetch`, or storage inside it except through injected ports. Tests drive it with the scripted fake provider and a fake clock.
- Put library suites in `test/`, grouped by source area, and shared test helpers in `testing/`. Keep web suites beside the code as `*.test.ts(x)`. Include the acceptance ID in each acceptance test title.
- No LangChain or LangGraph. No Vercel AI SDK `useChat` or provider-side conversation state; the backend assembles every run's context itself.

## Web stack

- Tailwind v4 (`@tailwindcss/vite`), tokens in `packages/web/src/index.css`. Import alias `@/` → `packages/web/src/`.
- shadcn/ui on the Radix base (`radix-nova`): `pnpm dlx shadcn@latest add <name>` from `packages/web`, components land in `src/components/ui/`.
- AI Elements for out-of-the-box chat UI, already installed in `src/components/ai-elements/` (message, conversation, prompt-input, queue, reasoning, suggestion, model-selector, confirmation, task, shimmer) plus shadcn `trace`, `message-scroller`, `code-block`. Use them as presentational components and adapt them freely; the code is ours. More: `cd packages/web && yes n | pnpm dlx ai-elements@latest add <name>` (answer "no" to overwrite prompts).
- Motion (`motion/react`, the successor to framer-motion) for layout, presence and spring animation. Animation decisions follow Emil Kowalski's skills vendored in `.claude/skills/` (`animate`, `choreograph`, `review-animations`, `animation-performance`, `emil-design-eng`): load `animate` before writing motion and `review-animations` before calling it done. Transform and opacity only, custom ease-out curves, UI motion under 300 ms, reduced-motion honoured, nothing animated that is triggered from the keyboard hundreds of times a day.
- Chromium and Playwright are pre-installed (`require('playwright')`); use them to look at what you built.

## OpenRouter

- The key is never committed, logged, written to the event log, or printed in tool output. In the app the user pastes it into the key prompt and it lives in the local secrets store. For testing it is in the environment as `OPENROUTER_KEY`: the smoke suite reads `process.env.OPENROUTER_KEY`, and the dev server exposes it to the key prompt as `__DEV_OPENROUTER_KEY__` (empty in production builds) so the prompt can offer "Use the key from this environment".
- Answers and decomposition: `POST https://openrouter.ai/api/v1/chat/completions`, SSE streaming, error mapping per `docs/spec/11-architecture.md`.
- Decisions, verified against the live API on 2026-11-11 (the spec's appendix is older; this is current):

```http
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <key>

{ "model": "typesafe/jev-1.13",
  "state": "<text the questions are asked about>",
  "questions": {
    "isGreeting": { "type": "noul",   "instructions": "Is this message a greeting?" },
    "kind":       { "type": "choice", "instructions": "What kind of message is it?",
                    "criteria": { "greet": "a greeting", "ask": "a question" } },
    "tone":       { "type": "score",  "instructions": "How polite is it?", "criteria": ["polite", "warm"] } } }

200 → { "model": "typesafe/jev-1.13-20260917",
        "answers": {
          "isGreeting": { "type": "noul", "noul": 0.99 },
          "kind": { "type": "choice", "choice": "greet", "probabilities": { "greet": 1, "ask": 0 }, "confidence": 1 },
          "tone": { "type": "score", "score": 0.28, "legend": { "0": "polite", "1": "warm" },
                    "probabilities": { "0": 0.72, "1": 0.28 }, "confidence": 0.44 } },
        "usage": { "input_tokens": 358, "output_tokens": 65, "cost": 0.000015 } }
```

  `questions` is a record keyed by question ID, not an array. Every question needs `instructions` (or `criteria`); `choice` takes `criteria` as a record of option → description; `score` takes `criteria` as an array. Errors come back as `{ "error": { "message", "code" } }`. `typesafe/jev-latest` does not exist on OpenRouter; pin `typesafe/jev-1.13`.
- Default models per role: answers and join-chain synthesis `anthropic/claude-sonnet-5.5`, decomposition `anthropic/claude-haiku-5.5`, decisions `typesafe/jev-1.13`. Use `anthropic/claude-haiku-5.5` in smoke tests to keep them cheap.

## Git

Develop on `claude/charming-rubin-ty8nfp`. When several agents work at once, each commits only its own paths (`git add <paths> && git commit -m "…" -- <paths>`), retries if `.git/index.lock` is held, and pushes with `git push -u origin claude/charming-rubin-ty8nfp`.
