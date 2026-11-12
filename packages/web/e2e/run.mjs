/**
 * End-to-end flows over the real product: Chromium, the dev server, the
 * backend in its Web Worker over IndexedDB, live OpenRouter calls on cheap
 * models. Not part of `pnpm test`.
 *
 *   OPENROUTER_KEY=… pnpm dev                       # the dev server offers the key to the prompt
 *   COMMITTEE_URL=http://localhost:5173/ pnpm e2e   # every flow
 *   pnpm e2e overtaking reload                      # some flows, by name
 *
 * Screenshots go to docs/build/screenshots/e2e/. Each flow prints what it saw
 * and the run exits non-zero if any flow failed.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  SCREENSHOTS,
  assert,
  redact,
  drawnOrder,
  freshContext,
  launch,
  newConversation,
  open,
  sections,
  send,
  settled,
  shot,
  sleep,
  until,
  applyCheapModels,
  applyEnvironmentKey,
  waitReady,
} from './lib.mjs'

const log = (...args) => console.log('  ', ...args)

// ───────────────────────── flows on one configured browser profile ─────────────────────────

async function overtaking({ page }) {
  await newConversation(page)
  // The slow request is a long answer; the quick one is unrelated. Both are sent at once.
  await send(page, 'Write a careful 700-word essay on how the printing press changed European science, with a title and five sections.')
  await send(page, 'What is the capital of Portugal? Answer in one word.')
  const [msgA, msgB] = await page.locator('[data-message-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id')))
  // Wait for B's reply to be placed (fixed by its first answer text).
  await until(
    page,
    () =>
      [...document.querySelectorAll('[data-response-id]')].some(
        (r) => r.getAttribute('data-placement') === 'fixed' && /Lisbon/i.test(r.textContent ?? ''),
      ),
    undefined,
    { what: "the quick answer's placement" },
  )
  const order = await drawnOrder(page)
  await shot(page, '01-overtaking-quick-answer-placed')
  log('order when the quick answer was placed:', order.map((o) => `${o.kind}:${o.placement ?? ''}:${o.text.slice(0, 30)}`).join(' | '))
  const quick = order.findIndex((o) => o.kind === 'response' && /Lisbon/i.test(o.text))
  const slow = order.findIndex((o) => o.kind === 'response' && !/Lisbon/i.test(o.text))
  const slowItem = order[slow]
  assert(order[0]?.id === msgA && order[1]?.id === msgB, 'user messages stay in submission order at the top')
  if (slowItem?.placement === 'pending') {
    assert(quick < slow, 'the quick answer is placed above the pending bubble of the slow one')
    log('overtaking observed: the slow request was still pending when the quick answer was placed above it')
  } else {
    // The slow answer showed text first, so it was placed first: the one rule says it stays above.
    assert(slow < quick, 'a reply placed first stays first')
    log('the slow answer happened to show text first; it was placed first and stays above (P2)')
  }
  await settled(page)
  const final = await drawnOrder(page)
  assert(final.findIndex((o) => /Lisbon/i.test(o.text)) === quick, 'a placed reply never moves')
  await shot(page, '01-overtaking-settled')
  return slowItem?.placement === 'pending' ? 'overtaken' : 'slow placed first'
}

async function replyGroup({ page }) {
  await newConversation(page)
  await send(page, 'Translate "good morning, my friend" into Italian. Also, separately, what is the boiling point of water in Fahrenheit at sea level?')
  await until(page, () => document.querySelector('[data-response-id][data-grouped]') !== null, undefined, {
    what: 'a reply group',
  })
  await shot(page, '02-reply-group-running')
  await settled(page)
  const groups = await page.locator('[data-response-id][data-grouped]').count()
  const list = await sections(page)
  log('sections:', list.map((s) => `${s.title}=${s.state}`).join(', '))
  assert(groups === 1, `one reply group (saw ${groups})`)
  assert(list.length === 2 && list.every((s) => s.state === 'completed'), 'two completed sections in it')
  await shot(page, '02-reply-group-settled')
}

async function dependentFollowUp({ page }) {
  await newConversation(page)
  await send(page, 'Write a 350-word short story about a lighthouse keeper who finds a message in a bottle.')
  // Reply to the story while it is still being written: the follow-up needs its result.
  const story = page.locator('[data-section-id]').first()
  await story.waitFor({ timeout: 60_000 })
  await story.hover()
  await story.getByRole('button', { name: 'Reply to this' }).click()
  await send(page, 'Give that story a short title of at most five words.')
  await until(page, () => document.querySelector('[data-queue-item]') !== null, undefined, { what: 'a queue item', timeout: 30_000 })
  const queueText = await page.locator('[data-queue-item]').first().innerText()
  log('queue item:', queueText.replace(/\s+/g, ' '))
  await shot(page, '03-dependent-queued')
  await until(page, () => document.querySelector('[data-queue-item]') === null, undefined, { what: 'the queue item to clear' })
  await settled(page)
  const list = await sections(page)
  log('sections:', list.map((s) => `${s.state}:${s.text.slice(0, 40)}`).join(' | '))
  assert(list.length === 2 && list.every((s) => s.state === 'completed'), 'story and title both completed')
  await shot(page, '03-dependent-ran')
}

async function corrective({ page }) {
  await newConversation(page)
  await send(page, 'List three fruits that are red. Just the names, one per line.')
  await settled(page)
  const first = page.locator('[data-section-id]').first()
  await first.hover()
  await first.getByRole('button', { name: 'Reply to this' }).click()
  await send(page, 'Sorry, I meant yellow fruits, not red ones.')
  await until(page, () => document.querySelector('[data-section-id][data-state="superseded"]') !== null, undefined, {
    what: 'the target to be superseded',
  })
  await settled(page)
  const list = await sections(page)
  log('sections:', list.map((s) => `${s.state}:${s.text.slice(0, 50)}`).join(' | '))
  assert(list.some((s) => s.state === 'superseded'), 'the red list is superseded')
  assert(list.some((s) => s.state === 'completed' && /banana|lemon|pineapple|yellow/i.test(s.text)), 'a replacement lists yellow fruits')
  await shot(page, '04-corrective-superseded')
}

async function stopAndRetry({ page }) {
  await newConversation(page)
  await send(page, 'Write a detailed 900-word history of the Roman aqueducts, in at least eight paragraphs.')
  await until(page, () => document.querySelector('[data-section-id][data-state="streaming"]') !== null, undefined, {
    what: 'streaming',
  })
  await sleep(1200)
  const section = page.locator('[data-section-id]').first()
  await section.hover()
  await section.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(page, () => document.querySelector('[data-section-id][data-state="stopped"]') !== null, undefined, { what: 'stopped' })
  await shot(page, '05-stopped')
  await section.hover()
  await section.getByRole('button', { name: 'Retry', exact: true }).click()
  await until(page, () => document.querySelector('[data-section-id][data-state="streaming"], [data-section-id][data-state="pending"]') !== null, undefined, {
    what: 'the retry to start',
  })
  await shot(page, '05-retrying')
  await settled(page, 180_000)
  const attempts = await section.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  log('attempts in the section:', attempts.join(', '))
  assert((await page.locator('[data-section-id]').count()) === 1, 'the retry ran in the same section')
  assert(attempts.length >= 2 && attempts.at(-1) === 'completed', 'a second attempt completed in the same bubble')
  await shot(page, '05-retried')
}

async function reloadMidAnswer({ page }) {
  await newConversation(page)
  await send(page, 'Write a detailed 900-word explanation of how tides work, in at least eight paragraphs.')
  await until(page, () => document.querySelector('[data-section-id][data-state="streaming"]') !== null, undefined, {
    what: 'streaming',
  })
  await sleep(1500)
  await shot(page, '06-before-reload')
  await page.reload()
  await waitReady(page)
  // The attempt that lost its executor is recorded as interrupted; Standard retries it at once.
  await until(page, () => document.querySelector('[data-attempt-id][data-state="interrupted"]') !== null, undefined, {
    what: 'the interrupted attempt',
    timeout: 30_000,
  })
  await shot(page, '06-after-reload-interrupted')
  await settled(page, 180_000)
  const attempts = await page.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  log('attempts after reload:', attempts.join(', '))
  assert(attempts[0] === 'interrupted' && attempts.at(-1) === 'completed', 'interrupted, then retried to completion')
  await shot(page, '06-recovered')
}

/** A dependent of work that is stopped pauses with the recovery choice; retrying the prerequisite releases it. */
async function pausedDependent({ page }) {
  await newConversation(page)
  await send(page, 'Write a 600-word short story about a clockmaker who repairs a clock that runs backwards.')
  const story = page.locator('[data-section-id]').first()
  await story.waitFor({ timeout: 60_000 })
  await story.hover()
  await story.getByRole('button', { name: 'Reply to this' }).click()
  await send(page, 'Summarize that story in one sentence.')
  await until(page, () => document.querySelector('[data-queue-item]') !== null, undefined, { what: 'a queue item', timeout: 30_000 })
  await until(page, () => document.querySelector('[data-section-id][data-state="streaming"]') !== null, undefined, { what: 'the story streaming' })
  await story.hover()
  await story.getByRole('button', { name: 'Stop', exact: true }).click()
  const choice = page.getByRole('group', { name: /^Recovery choice for / })
  await choice.waitFor({ timeout: 30_000 })
  log('paused item:', (await page.locator('[data-queue-item]').first().innerText()).replace(/\s+/g, ' '))
  await shot(page, '12-paused-dependent-recovery-choice')
  await choice.getByRole('button').first().click()
  await until(page, () => document.querySelector('[role="group"][aria-label^="Recovery choice for "]') === null, undefined, {
    what: 'the recovery choice to be answered',
    timeout: 30_000,
  })
  await settled(page, 180_000)
  const list = await sections(page)
  log('sections:', list.map((s) => `${s.state}:${s.text.slice(0, 40)}`).join(' | '))
  assert(list.length === 2 && list.every((s) => s.state === 'completed'), 'the story was retried and the summary then ran')
  await shot(page, '12-paused-dependent-released')
}

/** Under the Manual policy an interrupted attempt is not retried by itself: it waits for Retry. */
async function reloadUnderManual({ page }) {
  const policy = async (name) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'General' }).click()
    await page.getByRole('radio', { name: new RegExp(`^${name}`) }).click()
    await until(page, (n) => document.querySelector(`[role="dialog"] [role="radio"][aria-checked="true"]`)?.textContent?.startsWith(n) ?? false, name, {
      what: `the ${name} policy`,
      timeout: 10_000,
    })
    await page.keyboard.press('Escape')
  }
  await policy('Manual')
  try {
    await newConversation(page)
    await send(page, 'Write a detailed 900-word account of how glaciers carve valleys, in at least eight paragraphs.')
    await until(page, () => document.querySelector('[data-section-id][data-state="streaming"]') !== null, undefined, { what: 'streaming' })
    await sleep(1200)
    await page.reload()
    await waitReady(page)
    await until(page, () => document.querySelector('[data-section-id][data-state="interrupted"]') !== null, undefined, {
      what: 'the interrupted section',
      timeout: 30_000,
    })
    await sleep(3000)
    const attempts = await page.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    assert(attempts.length === 1 && attempts[0] === 'interrupted', `no automatic retry under Manual (${attempts})`)
    await shot(page, '06b-manual-interrupted-waits-for-retry')
    const section = page.locator('[data-section-id]').first()
    await section.hover()
    await section.getByRole('button', { name: 'Retry', exact: true }).click()
    await until(page, () => document.querySelector('[data-section-id][data-state="interrupted"]') === null, undefined, {
      what: 'the retry to start',
      timeout: 30_000,
    })
    await settled(page, 180_000)
    const after = await page.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    log('attempts after Retry:', after.join(', '))
    assert(after.at(-1) === 'completed', 'Retry completes it in the same section')
  } finally {
    await policy('Standard')
  }
}

// ───────────────────────── flows that need their own profile ─────────────────────────

async function invalidKey({ browser }) {
  const context = await freshContext(browser)
  try {
    const { page } = await open(context, 'invalid-key')
    await waitReady(page)
    const field = page.getByLabel('API key')
    await field.fill('sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000')
    await until(page, () => document.querySelector('[data-key-status="invalid"]') !== null, undefined, {
      what: 'the key to be rejected',
      timeout: 30_000,
    })
    const save = page.getByRole('button', { name: 'Save key' })
    assert(await save.isDisabled(), 'an invalid key cannot be saved')
    await shot(page, '07-invalid-key-rejected')

    // A key OpenRouter cannot check right now can be saved; if it turns out invalid, routing fails visibly.
    await context.route('https://openrouter.ai/api/v1/key', (route) => route.fulfill({ status: 503, body: '{}' }))
    await field.fill('sk-or-v1-1111111111111111111111111111111111111111111111111111111111111111')
    await until(page, () => document.querySelector('[data-key-status="unverified"]') !== null, undefined, {
      what: 'the key to be unverified',
      timeout: 30_000,
    })
    await save.click()
    await save.waitFor({ state: 'detached', timeout: 15_000 })
    await context.unroute('https://openrouter.ai/api/v1/key')
    await applyCheapModels(page)
    await newConversation(page)
    await send(page, 'Hello, what is 3 + 4?')
    await until(page, () => /401|User not found|No auth|invalid|not valid|Unauthorized/i.test(document.querySelector('[data-response-id]')?.textContent ?? ''), undefined, {
      what: 'the routing failure',
      timeout: 60_000,
    })
    const bubble = await page.locator('[data-response-id]').first().innerText()
    log('bubble with the invalid key:', bubble.replace(/\s+/g, ' ').slice(0, 200))
    await shot(page, '07-invalid-key-routing-failed')

    // Replace the key with the real one and retry the request: it routes and answers.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Key' }).click()
    await page.getByRole('button', { name: /Replace/ }).click()
    await applyEnvironmentKey(page)
    if (await page.getByRole('tab', { name: 'Key' }).isVisible()) await page.keyboard.press('Escape')
    const retry = page.getByRole('button', { name: /Retry/ }).first()
    await retry.click()
    await settled(page)
    const list = await sections(page)
    assert(list.length === 1 && list[0].state === 'completed' && /7|seven/i.test(list[0].text), 'the retried request is answered')
    await shot(page, '07-invalid-key-replaced-and-retried')
  } finally {
    await context.close()
  }
}

async function secondTab({ browser }) {
  const context = await freshContext(browser)
  try {
    const first = await open(context, 'first-tab')
    await waitReady(first.page)
    await applyEnvironmentKey(first.page)
    await applyCheapModels(first.page)
    await newConversation(first.page)
    await send(first.page, 'Write a 400-word description of a thunderstorm over the sea, in four paragraphs.')
    await until(first.page, () => document.querySelector('[data-section-id][data-state="streaming"]') !== null, undefined, {
      what: 'streaming in the first tab',
    })
    // A second tab of the same profile stands by: it never starts a backend over the same stores.
    const second = await open(context, 'second-tab')
    await second.page.getByText('Committee is open in another tab').waitFor({ timeout: 20_000 })
    await shot(second.page, '08-second-tab-standby')
    // The first tab's live answer is not touched: it finishes in one attempt, never marked interrupted.
    await settled(first.page)
    const firstAttempts = await first.page.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    assert(firstAttempts.length === 1 && firstAttempts[0] === 'completed', `the first tab's answer completed in one attempt (${firstAttempts})`)
    await first.page.close()
    // The second tab takes over once the first is gone, and shows the same conversation as it was left.
    await second.page.getByText('Committee is open in another tab').waitFor({ state: 'detached', timeout: 20_000 })
    await waitReady(second.page)
    await until(second.page, () => document.querySelector('[data-attempt-id]') !== null, undefined, { what: 'the conversation in the second tab' })
    const secondAttempts = await second.page.locator('[data-attempt-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    log('attempts seen by the second tab after takeover:', secondAttempts.join(', '))
    assert(secondAttempts.length === 1 && secondAttempts[0] === 'completed', 'nothing was recorded as interrupted')
    await shot(second.page, '08-second-tab-took-over')
  } finally {
    await context.close()
  }
}

/** Settings, the conversation list and the key survive a reload; the run inspector shows the model the settings chose. */
async function persistence({ page }) {
  const before = await page.locator('nav li').count()
  await page.reload()
  await waitReady(page)
  await until(page, (n) => document.querySelectorAll('nav li').length === n, before, { what: 'the conversation list after reload' })
  assert(!(await page.getByText('Bring your own OpenRouter key').isVisible()), 'the key is still configured after reload')

  // Settings flow to the backend and back: the models chosen before the reload are still set.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Models' }).click()
  for (const label of ['Answers', 'Synthesis', 'Decomposition']) {
    await page.getByRole('button', { name: `${label} model: anthropic/claude-haiku-5.5` }).waitFor({ timeout: 5_000 })
  }
  await page.getByRole('tab', { name: 'Debug views' }).click()
  const inspector = page.getByRole('switch', { name: /Run inspector/ })
  if ((await inspector.getAttribute('aria-checked')) !== 'true') await inspector.click()
  await page.keyboard.press('Escape')

  // The run inspector reads the exact input the backend recorded, and the model it used.
  await newConversation(page)
  await send(page, 'Name one prime number greater than 50. Just the number.')
  await settled(page)
  const section = page.locator('[data-section-id]').first()
  await section.hover()
  await section.getByRole('button', { name: 'Inspect run' }).click()
  const run = page.getByTestId('run-inspector')
  await run.waitFor({ timeout: 10_000 })
  await until(page, () => /claude-haiku-5\.5/.test(document.querySelector('[data-testid="run-inspector"]')?.textContent ?? ''), undefined, {
    what: 'the model in the run inspector',
    timeout: 10_000,
  })
  const input = await page.getByTestId('model-input').innerText()
  assert(/prime number greater than 50/.test(input), 'the recorded model input holds the request')
  await shot(page, '09-run-inspector-after-reload')

  // The key is in the secrets database only, never in the event log or the projection cache.
  const leaked = await page.evaluate(async (secret) => {
    if (!secret) return false
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('committee-events')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const names = [...db.objectStoreNames]
    let found = false
    for (const name of names) {
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (JSON.stringify(rows).includes(secret)) found = true
    }
    db.close()
    return found
  }, process.env.OPENROUTER_KEY ?? '')
  assert(leaked === false, 'the key appears nowhere in committee-events')
  log('key absent from the event log and projection cache')
}

/** Markdown answers: a fenced code block (and a table, when the model writes one) render as such, in light and dark. */
async function markdown({ page }) {
  await newConversation(page)
  await send(page, 'Show a TypeScript function that adds two numbers in a fenced code block, then a markdown table with two columns (planet, moons) and two rows. Nothing else.')
  await settled(page)
  const code = await page.locator('[data-section-id] pre').count()
  const table = await page.locator('[data-section-id] table').count()
  log(`code blocks: ${code}, tables: ${table}`)
  // Core's preamble asks for plain text, so the model does not always format the table; a fenced
  // code block it reliably keeps, and that is what this flow checks renders.
  assert(code >= 1, 'the answer shows a rendered code block')
  await shot(page, '11-markdown-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await sleep(300)
  await shot(page, '11-markdown-dark')
  await page.emulateMedia({ colorScheme: 'light' })
}

/** Conversations: create, list, delete; the deletion survives a reload. */
async function conversations({ page }) {
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await newConversation(page)
  await send(page, 'Say the word "ephemeral" and nothing else.')
  await settled(page)
  const title = (await page.locator('nav li').first().innerText()).split('\n')[0]
  const count = await page.locator('nav li').count()
  log(`deleting "${title}" of ${count}`)
  const row = page.locator('nav li').first()
  await row.hover()
  await row.getByRole('button', { name: /^Options for / }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await until(page, (n) => document.querySelectorAll('nav li').length === n - 1, count, { what: 'the list to shrink' })
  await page.reload()
  await waitReady(page)
  await until(page, (n) => document.querySelectorAll('nav li').length === n - 1, count, { what: 'the deletion to survive a reload' })
  const titles = await page.locator('nav li').allInnerTexts()
  assert(!titles.some((t) => t.includes('ephemeral')), 'the deleted conversation is gone after reload')
  await shot(page, '10-conversation-deleted')
}

/**
 * Export full logs: run a composite request, export from the header's debug menu (no debug view
 * open), read the downloaded file, and check it parses, holds the log with its routing decisions,
 * and does not hold the key.
 */
async function exportLogs({ page }) {
  await newConversation(page)
  await send(page, 'Name one prime number between 10 and 20. Also, separately, name the largest planet. One line each.')
  await settled(page)
  await page.getByRole('button', { name: 'Debug views' }).click()
  const item = page.getByRole('menuitem', { name: 'Export full logs' })
  await item.waitFor()
  const review = path.resolve(SCREENSHOTS, '../review')
  mkdirSync(review, { recursive: true })
  const [download] = await Promise.all([page.waitForEvent('download'), item.click()])
  const filename = download.suggestedFilename()
  assert(/^committee-log-cnv_[0-9A-Z]+-\d{8}-\d{6}\.json$/.test(filename), `the file is named committee-log-<conversation>-<timestamp>.json (${filename})`)
  const text = readFileSync(await download.path(), 'utf8')
  const doc = JSON.parse(text)
  assert(doc.schema === 'committee.log-export' && doc.version === 1, 'the file is a log export, version 1')
  assert(doc.events.length > 0 && doc.events.every((e, i) => e.seq === i + 1), 'every event of the log, in order')
  const decided = doc.events.filter((e) => e.type === 'routing-decided')
  assert(decided.length >= 1, 'the routing decision is in the log')
  assert(doc.derived.routingDecisions.length >= 1 && doc.derived.routingDecisions[0].routingInForce !== null, 'the routing decisions index points at it')
  assert(doc.derived.runs.length >= 1, 'a run inspection for every run')
  const key = process.env.OPENROUTER_KEY ?? ''
  assert(key === '' || !text.includes(key), 'the key is not in the export')
  assert(!/authorization/i.test(text), 'no Authorization value in the export')
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor()
  await page.screenshot({ path: path.join(review, 'export-full-logs-menu.png') })
  await page.keyboard.press('Escape')
  const kinds = [...new Set(doc.events.map((e) => e.type))].length
  log(`${filename}: ${(text.length / 1024).toFixed(0)} KB, ${doc.events.length} events of ${kinds} types, ${decided.length} routing-decided, ${doc.derived.runs.length} runs`)
  return `${doc.events.length} events, ${doc.derived.runs.length} runs`
}

// ───────────────────────── runner ─────────────────────────

const SHARED = { overtaking, replyGroup, dependentFollowUp, pausedDependent, corrective, stopAndRetry, reloadMidAnswer, reloadUnderManual, persistence, conversations, markdown, exportLogs }
const SEPARATE = { invalidKey, secondTab }

async function main() {
  const wanted = new Set(process.argv.slice(2))
  const pick = (name) => wanted.size === 0 || wanted.has(name)
  const browser = await launch()
  const results = []
  try {
    const sharedNames = Object.keys(SHARED).filter(pick)
    if (sharedNames.length > 0) {
      const context = await freshContext(browser)
      const { page } = await open(context, 'main')
      await waitReady(page)
      await applyEnvironmentKey(page)
      await applyCheapModels(page)
      await shot(page, '00-key-and-models-set')
      for (const name of sharedNames) {
        console.log(`▶ ${name}`)
        const started = Date.now()
        try {
          const note = await SHARED[name]({ page, context, browser })
          results.push({ name, ok: true, ms: Date.now() - started, note })
        } catch (error) {
          console.log(`  ✗ ${redact(error.message)}`)
          await shot(page, `failed-${name}`).catch(() => {})
          results.push({ name, ok: false, ms: Date.now() - started, note: redact(error.message.split('\n')[0]) })
        }
      }
      await context.close()
    }
    for (const name of Object.keys(SEPARATE).filter(pick)) {
      console.log(`▶ ${name}`)
      const started = Date.now()
      try {
        const note = await SEPARATE[name]({ browser })
        results.push({ name, ok: true, ms: Date.now() - started, note })
      } catch (error) {
        console.log(`  ✗ ${redact(error.message)}`)
        results.push({ name, ok: false, ms: Date.now() - started, note: redact(error.message.split('\n')[0]) })
      }
    }
  } finally {
    await browser.close()
  }
  console.log('\nResults')
  for (const r of results) console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.name}  ${(r.ms / 1000).toFixed(1)} s${r.note ? `  (${r.note})` : ''}`)
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

await main()
