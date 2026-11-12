# Deploy: Cloudflare Workers Static Assets

The embedded deployment (`docs/spec/11-architecture.md`) is a static bundle: the backend runs in the browser's Web Worker over IndexedDB and calls OpenRouter and Anthropic directly. It is served from `https://pluribus.winstondu.com` by a Cloudflare Worker that has assets only and no Worker script.

## Files

| File | Role |
|---|---|
| `packages/web/wrangler.jsonc` | Worker `pluribus`, assets from `./dist`, single-page-application fallback, custom domain `pluribus.winstondu.com`; `workers.dev` and preview URLs off |
| `packages/web/public/_headers` | Content-Security-Policy and other security headers on every response; `/assets/*` (hashed names) cached for a year, immutable |
| `packages/web/public/theme-init.js` | The pre-paint theme script, kept out of `index.html` so `script-src` needs no `'unsafe-inline'` |

## Commands

```sh
cd packages/web
pnpm exec wrangler login        # once, or CLOUDFLARE_API_TOKEN in CI
pnpm run deploy                 # tsc -b && vite build && wrangler deploy
pnpm run preview:cf             # the production build on http://localhost:8787
pnpm exec wrangler deploy --dry-run
```

`pnpm run deploy`, not `pnpm deploy`: the latter is pnpm's own workspace command.

## Decisions

- **No server secrets.** Keys are pasted by each user and stay in that browser's secrets store. `OPENROUTER_KEY` is never set on the Worker, and `__DEV_*_KEY__` are empty in production builds.
- **CSP.** `connect-src` allows only `'self'`, `https://openrouter.ai` and `https://api.anthropic.com`. A new provider host, or any other runtime fetch, must be added there or the browser blocks it. `img-src` allows `https://models.dev` for model-selector logos. `style-src` keeps `'unsafe-inline'` because Motion and the markdown renderers set inline styles. `script-src` has `'wasm-unsafe-eval'` for syntax highlighting.
- **Custom domain.** `winstondu.com` must be a zone on the deploying Cloudflare account. Wrangler creates the DNS record and certificate; an existing record for `pluribus.winstondu.com` must be removed first.
- **Access.** The site is public and every visitor brings their own key. To restrict it, put Cloudflare Access in front of the domain; no code changes.
- **Server deployment.** Remains possible per the spec. It would add a Worker script (`main`) with `run_worker_first` for its API routes, with keys as Worker secrets.

## Verified (2026-11-12, Wrangler 4.161.0)

`wrangler deploy --dry-run` read 418 asset files with no bindings. Under `wrangler dev`, the security headers were served, a deep path fell back to `index.html`, hashed assets were served with the immutable header, the app loaded and created a conversation in its Web Worker with no CSP violations, a fetch to OpenRouter was allowed, and a fetch to another host was blocked. A live model call through the deployed site has not been run.
