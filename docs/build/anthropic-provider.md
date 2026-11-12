# The Claude API as a model provider

Branch `claude/anthropic-key`, 2026-11-12. With an Anthropic key, answers, synthesis and decomposition can each run on the Claude API instead of through OpenRouter. Nothing changes for a user who does not add one: every role defaults to OpenRouter.

## What is and is not supported per role

| Role | OpenRouter | Claude API | Notes |
|---|---|---|---|
| Answers | yes (default) | yes | Models from the compatibility list of the chosen provider (Q107) |
| Synthesis | yes (default) | yes | Compatibility list of the chosen provider, as for answers (Q107) |
| Decomposition | yes (default) | yes | Compatibility list. The preparation step (Q103) and request labels use this role's provider and model |
| Decisions | yes, fixed | no | The Claude API has no Decisions endpoint (no calibrated probability per question). The settings type has a provider for every role, so a decision provider could be added |

The OpenRouter key therefore stays required. The Anthropic key is optional.

"Decision" in the request was read as above: the user asked for a provider choice on "Answers, Decision, Synthesis". Decisions were left on OpenRouter and decomposition was made selectable.

## Layers

**Configuration is the backend's.** Which provider and model a role uses is settings (`Settings.modelProviders` beside `Settings.models`, `packages/protocol/src/settings.ts`), changed by `change-settings` and validated by the backend. The backend also reports what can be chosen: `AppSnapshot.modelRoles` (`packages/protocol/src/model-choices.ts`, `describeModelRoles`) gives, for each role, its current provider and model, whether the client may change them, a note when something is fixed, and for each provider whether it is usable now, whether its models are a restricted list, and the models. The Models section renders that and computes nothing. The same holds for a server deployment: `CoreOptions.modelsEditable: false` makes the backend refuse a model or provider change and report every role as not editable.

Backend rules, in `packages/core/src/engine/backend.ts`:

- A provider sent without a model gets that provider's default model for the role (`completeSettingsPatch`).
- A model is checked against the compatibility list of the provider its role will have.
- A role can be moved to the Claude API only while an Anthropic key is configured.
- Decisions cannot leave OpenRouter.
- When the Anthropic key goes (removed, or found missing at start), every role on the Claude API returns to OpenRouter and its default model there, in the same step as the key status change.

**Core is provider-agnostic.** It passes `provider` through on `ModelRequest`, `DecomposeRequest`, `LabelRequest` and `PreparationRequest`, never branches on it, and records it on `attempt-started`. The run inspector shows it beside the model.

**Adapters** (`packages/providers`):

- `anthropic/`: `createAnthropicModelProvider` (streamed answers and synthesis, the clarification signal, exact token counts), `createAnthropicDecomposer` (structured output; labels), `createAnthropicPreparer` (structured output), `checkAnthropicKey`.
- `routed.ts`: `createRoutedModelProvider`, `createRoutedDecomposer`, `createRoutedPreparer` hand each request to the adapter of the provider it names. One conversation can answer on the Claude API and decompose through OpenRouter.
- The adapters use the official SDK (`@anthropic-ai/sdk`) with `fetch` injected. Prompts, schemas and the deterministic checks are shared with the OpenRouter adapters.

**Key provision is the deployment's.** The client reaches keys through one interface, `KeyProvision` (`packages/web/src/backend/key-provision.ts`):

```ts
interface KeyProvision {
  readonly canProvideKeys: boolean
  check(provider: KeyProviderName, key: string, signal: AbortSignal): Promise<KeyCheck>
  set(provider: KeyProviderName, key: string): Promise<KeyProvisionResult>
  remove(provider: KeyProviderName): Promise<KeyProvisionResult>
}
```

Whether a key is configured is not asked there: the backend reports it (`AppSnapshot.key`, `AppSnapshot.anthropicKey`).

- Embedded: `packages/web/src/worker/key-channel.ts` (a request/reply pair on the Worker's port, apart from the backend protocol) and `key-service.ts` (in the Worker: checks the key, writes the secrets store, calls `Backend.refreshKeyStatus()`).
- Server: `serverKeyProvision`, `canProvideKeys: false`. No prompt; the settings say "Configured on the server". A double for tests; no server is built.
- Fixtures: `createScriptedKeyProvision`.

Both keys follow this path. `change-settings` no longer carries a key, and no React component imports the Worker, `@committee/storage` or `@committee/providers` (asserted in `key-channel.test.ts`).

## Key handling

- Stored only in the local secrets store (`anthropic-key`, beside `openrouter-key`, in the `committee-secrets` database).
- Goes page → Worker once, in a `key-request`; no reply carries it. It is never in a command, an event, a projection, the stream, an export or a log. The SDK client is built with logging off.
- Sent only to `api.anthropic.com`.
- Settings show only whether it is configured, with replace and remove.
- Dev server: when `ANTHROPIC_API_KEY` is set, it is exposed to the key prompt as `__DEV_ANTHROPIC_KEY__` (empty in production builds) and the prompt offers "Use the key from this environment".

## Calling the Claude API from a browser

The embedded backend calls the Claude API from the user's browser. The API accepts a cross-origin request only with `anthropic-dangerous-direct-browser-access: true`; the SDK sends it when `dangerouslyAllowBrowser` is set, which every client here does. An organization with zero data retention or the Compliance API cannot call the API from a browser: it gets a 401 whose message starts "CORS requests are not allowed for this Organization". The key check reports that as its own outcome, and a run shows the provider's message.

## The key check and its limits

A standard API key cannot read a credit balance: the Claude API has no such endpoint (usage and cost reports need an Admin key). The check is two requests:

1. `GET /v1/models?limit=1`, free. 401 is "invalid"; the browser 401 above is "blocked".
2. One Messages request with `max_tokens: 1` on `claude-haiku-5-5`. Accepted means there is credit. 402 `billing_error`, 429 with `enforced_spend_limit_reached`, or 400 starting "You have reached your specified" means out of credit. Anything else (rate limit, overload, model not available) is "could not be determined".

The second request costs about ten input tokens and one output token, roughly a millionth of a dollar. The check never reports an amount.

The prompt presents OpenRouter and Anthropic keys in the same terms: recognized or not, then what is known about credit (an amount for OpenRouter; "a test request was accepted", "refused for lack of credit", or "could not be determined" for Anthropic).

## Error mapping

`mapAnthropicError` in `packages/providers/src/anthropic/client.ts`; the table is in 11 · "Claude API error mapping". The API has no error code for an input over the context window, so that one case reads the message.

## Choices

- **No provider choice with one key.** With the OpenRouter key alone the Models section looks as before and one line says how to get the choice. A disabled control on each role would repeat one hint three times.
- **No server-side refusal fallback.** An attempt records the model that ran it; a refusal is a typed failure.
- **Thinking is left at the model default** and is never answer text. `max_tokens` is the model's own cap, at most 64,000.
- **Every `system` message goes to the request's `system`.** Core puts them first, so nothing moves.

## Not verified

- **No live run.** `ANTHROPIC_API_KEY` is not set in this environment, so `packages/providers/test/smoke/anthropic.smoke.test.ts` was skipped. Nothing here has been sent to the Claude API.
- **The Claude API entries of the compatibility list are untested** (`testedOn: null`). They are offered and marked "live test pending". Set the date after the smoke suite passes.
- The exact response to an out-of-credit request is taken from the documentation.
- Motion has not had the `review-animations` pass; the skill cannot be invoked from an agent session.
