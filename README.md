# Pluribus

One visible chat that runs many model calls at once. Several requests can be answered in parallel, follow-ups wait for the answers they need, corrections supersede what they correct, and every run reads exactly the context it is shown to read. The backend runs in the browser, in a Web Worker, and talks to OpenRouter directly.

The specification is in [`docs/spec/`](docs/spec/README.md). What was built, what passes and what is still open is in [`docs/build/STATUS.md`](docs/build/STATUS.md); the build decisions are in [`docs/build/PLAN.md`](docs/build/PLAN.md).

## Run it

Needs Node 22 or later and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

On first open, the key prompt asks for an OpenRouter API key. It is stored in this browser only (IndexedDB database `pluribus-secrets`), never in the conversation history. If `OPENROUTER_KEY` is set in the environment of `pnpm dev`, the prompt offers "Use the key from this environment"; production builds never contain it.

Default models (changeable in Settings, per role): answers and join-chain synthesis `anthropic/claude-sonnet-5.5`, decomposition `anthropic/claude-haiku-5.5`, decisions `typesafe/jev-1.13`.

Other entry points on the dev server: `/?fixtures` (gallery of every UI state on a scripted backend) and `/?fixture=<id>`.

## Check it

```sh
pnpm typecheck                                   # all five packages
pnpm test                                        # vitest: "unit" (node) and "web" (jsdom) projects
pnpm vitest run --project unit packages/core     # one package
pnpm build                                       # all packages; the app lands in packages/web/dist
OPENROUTER_KEY=… pnpm smoke                      # live OpenRouter calls and the routing corpus
OPENROUTER_KEY=… pnpm dev                        # then, in another shell:
PLURIBUS_URL=http://localhost:5173/ pnpm e2e    # Playwright flows in Chromium, live models
pnpm --filter @pluribus/web lint
```

`pnpm smoke` and `pnpm e2e` make real, paid calls on cheap models.

## Layout

| Package | Contents |
|---|---|
| `packages/protocol` | Command, event, projection, settings and ID types shared by client and backend |
| `packages/core` | Event log, projections, coordinator, routing, recovery. Deterministic; all I/O injected |
| `packages/storage` | IndexedDB and in-memory event store, projection cache, secrets store |
| `packages/providers` | OpenRouter answers, Decisions and decomposition; scripted fakes for tests |
| `packages/web` | Vite + React 19 + Tailwind v4 client; the backend runs in a Web Worker. See its [README](packages/web/README.md) |
