/**
 * Helpers for the end-to-end flows in `run.mjs`: a real Chromium against the
 * dev server, the backend in its Web Worker, live OpenRouter calls.
 *
 * The OpenRouter key never passes through this code. The page offers "Use the
 * key from this environment" (the dev server's OPENROUTER_KEY) and the flows
 * click it. Console output from the page is printed with the key redacted in
 * case anything ever leaks it.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

export const BASE_URL = process.env.COMMITTEE_URL ?? 'http://localhost:5173/'
export const SCREENSHOTS = path.resolve(import.meta.dirname, '../../../docs/build/screenshots/e2e')
export const CHEAP_MODEL = 'anthropic/claude-haiku-5.5'

const SECRET = process.env.OPENROUTER_KEY ?? ''
export const redact = (text) => (SECRET ? String(text).split(SECRET).join('[key]') : String(text))

mkdirSync(SCREENSHOTS, { recursive: true })

/** Launches Chromium; outbound HTTPS goes through the environment's proxy when one is set. */
export async function launch() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  return chromium.launch({
    headless: true,
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
  })
}

/** A fresh browser context: its own IndexedDB, so its own conversations, settings and key. */
export async function freshContext(browser, viewport = { width: 1360, height: 900 }) {
  return browser.newContext({ viewport, reducedMotion: 'reduce' })
}

export function watch(page, label) {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = redact(message.text())
      if (/React DevTools|\[vite\]/.test(text)) return
      console.log(`  [${label} ${message.type()}] ${text.slice(0, 400)}`)
      if (message.type() === 'error') errors.push(text)
    }
  })
  page.on('pageerror', (error) => {
    const text = redact(error.message)
    console.log(`  [${label} pageerror] ${text}`)
    errors.push(text)
  })
  return errors
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) })
}

export async function open(context, label = 'tab') {
  const page = await context.newPage()
  const errors = watch(page, label)
  await page.goto(BASE_URL)
  return { page, errors }
}

/** Waits for the backend to be ready: the shell is on screen and no standby notice is shown. */
export async function waitReady(page, timeout = 30_000) {
  // By text, not role: on first run the key prompt is open and the shell behind it is inert.
  await page.getByText('New conversation').first().waitFor({ timeout })
}

/** First run: the key prompt opens by itself; take the key from the dev server's environment. */
export async function useEnvironmentKey(page) {
  const button = page.getByRole('button', { name: /Use the key from this environment/ })
  await button.waitFor({ timeout: 30_000 })
  await button.click()
  await button.waitFor({ state: 'detached', timeout: 30_000 })
}

/** Settings → Models: every generative role on the cheap model. The decision model stays pinned. */
export async function useCheapModels(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Models' }).click()
  for (const label of ['Answers', 'Synthesis', 'Decomposition']) {
    const trigger = page.getByRole('button', { name: new RegExp(`^${label} model: `) })
    if ((await trigger.getAttribute('aria-label'))?.endsWith(CHEAP_MODEL)) continue
    await trigger.click()
    const input = page.getByPlaceholder(/Search models, or type an OpenRouter model ID/)
    await input.fill(CHEAP_MODEL)
    await page.getByRole('option', { name: new RegExp(CHEAP_MODEL.replace(/[.\/]/g, '\\$&')) }).first().click()
    await page.getByRole('button', { name: `${label} model: ${CHEAP_MODEL}` }).waitFor({ timeout: 10_000 })
  }
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'Models' }).waitFor({ state: 'detached' })
}

export async function newConversation(page) {
  const before = await page.locator('[data-message-id]').count()
  await page.getByRole('button', { name: 'New conversation' }).first().click()
  // The new conversation opens empty.
  if (before > 0) await page.waitForFunction(() => document.querySelectorAll('[data-message-id]').length === 0)
}

/** Types into the composer and sends. Resolves when the user message is on screen. */
export async function send(page, text) {
  const count = await page.locator('[data-message-id]').count()
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-message-id]').length > n, count)
  return page.locator('[data-message-id]').nth(count)
}

/** The transcript as drawn: message and response elements in document order. */
export async function drawnOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-message-id], [data-response-id]')].map((element) => {
      const response = element.getAttribute('data-response-id')
      return response
        ? { kind: 'response', id: response, placement: element.getAttribute('data-placement'), text: element.textContent?.slice(0, 120) ?? '' }
        : { kind: 'message', id: element.getAttribute('data-message-id'), text: element.textContent?.slice(0, 120) ?? '' }
    }),
  )
}

/** Sections in document order with their state. */
export async function sections(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-section-id]')].map((element) => ({
      id: element.getAttribute('data-section-id'),
      state: element.getAttribute('data-state'),
      placement: element.getAttribute('data-placement'),
      title: element.getAttribute('aria-label'),
      text: element.textContent?.slice(0, 160) ?? '',
    })),
  )
}

export async function until(page, predicate, arg, { timeout = 90_000, what = 'condition' } = {}) {
  try {
    await page.waitForFunction(predicate, arg, { timeout, polling: 100 })
  } catch (error) {
    throw new Error(`Timed out waiting for ${what}: ${error.message.split('\n')[0]}`)
  }
}

/** Waits until every section in the open conversation has settled (no pending, streaming or queued work). */
export async function settled(page, timeout = 120_000) {
  await until(
    page,
    () => {
      const busy = [...document.querySelectorAll('[data-section-id]')].some((s) =>
        ['pending', 'streaming', 'queued'].includes(s.getAttribute('data-state') ?? ''),
      )
      const routing = document.querySelector('[data-slot="routing-bubble"]')
      const queued = document.querySelector('[data-queue-item]')
      return !busy && !routing && !queued && document.querySelectorAll('[data-section-id]').length > 0
    },
    undefined,
    { timeout, what: 'every section to settle' },
  )
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
