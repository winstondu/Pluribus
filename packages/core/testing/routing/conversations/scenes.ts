import { provisionalLabel, type DirectiveState } from '@pluribus/protocol'
import { scene, type Scene, type SceneBuilder } from '../corpus/scene'
import type { Domain } from './types'

/**
 * The conversations of the conversation corpus. None of them is the
 * running example of the spec: the routing corpus already covers the Kyoto
 * trip, and a behavior that only holds there is not a behavior.
 *
 * A section's title is its request's first words, as a live run records it
 * (`provisionalLabel`), and an answer opens the way a model's answer does.
 */

interface Turn {
  readonly chain: string
  readonly on: string | null
  readonly request: string
  readonly answer?: string
  readonly state?: DirectiveState
  readonly consumed?: readonly string[]
  readonly message?: string
}

const turn = (t: Turn) => ({ ...t, label: provisionalLabel(t.request) })
const line = (s: SceneBuilder, handle: string, kind: 'root' | 'fork' | 'branch', request: string): SceneBuilder => s.chain(handle, kind, provisionalLabel(request))

// ── code: a two-turn line about a bug, and an unrelated line ──
const BUG = 'My Flask endpoint returns 500 when the JSON body has no "email" field. Why?'
const TEST = 'Write a pytest test that reproduces it'
const REGEX = 'Write a regex that matches ISO 8601 dates'
const flask = (() => {
  const s = scene()
  line(s, 'api', 'root', BUG)
  s.add('bug', turn({
    chain: 'api',
    on: null,
    request: BUG,
    answer: '`request.json["email"]` raises a `KeyError` when the key is missing, and Flask turns an unhandled exception into a 500. Read it with `request.json.get("email")` and return a 400 with a clear message when it is `None`:\n\n```python\n@app.post("/signup")\ndef signup():\n    email = request.json.get("email")',
  }))
  s.add('test', turn({
    chain: 'api',
    on: 'bug',
    request: TEST,
    answer: 'This test posts a body without the field and expects the 400:\n\n```python\ndef test_signup_without_email_returns_400(client):\n    response = client.post("/signup", json={"name": "Ada"})\n    assert response.status_code == 400\n```',
  }))
  line(s, 'regex', 'root', REGEX)
  s.add('regex', turn({
    chain: 'regex',
    on: null,
    request: REGEX,
    answer: 'For the calendar-date form, `^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$` matches `2026-03-09` and rejects month 13. The caret and the dollar sign anchor it to the whole string.',
  }))
  return s.build()
})()

// ── writing: a draft, a rewrite that continues it, and a short version on a branch ──
const DRAFT = 'Draft a cover letter for a data analyst job at a climate nonprofit. I have three years in retail analytics.'
const WARM = 'Make it warmer and less formal'
const SHORT = 'Give me a 100-word version'
const letter = (() => {
  const s = scene()
  line(s, 'letter', 'root', DRAFT)
  s.add('draft', turn({ chain: 'letter', on: null, request: DRAFT, answer: 'Dear Hiring Team,\n\nI am writing to apply for the Data Analyst position. Over three years in retail analytics I have built forecasting models and dashboards that turned sales data into decisions, and I would like to put that experience to work on climate.' }))
  s.add('warm', turn({ chain: 'letter', on: 'draft', request: WARM, answer: 'Hi there,\n\nI’ve spent the last three years finding the story in retail numbers, and I’d love to do the same for a cause I care about. Your work on community solar is exactly why I’m writing.' }))
  line(s, 'short', 'branch', SHORT)
  s.add('short', turn({ chain: 'short', on: 'draft', request: SHORT, answer: 'Dear Hiring Team, three years in retail analytics taught me to turn messy data into clear decisions. I would like to bring forecasting, SQL and dashboard skills to your climate mission.' }))
  return s.build()
})()

// ── data: a brief and two analyses forked from it, running or finished ──
const ORDERS = 'I have a CSV of our 2025 orders with date, region, product, units and revenue. I’ll ask for a few analyses.'
const TREND = 'Chart monthly revenue by region'
const TOP = 'Find the top five products by units sold'
const ordersBase = (open: boolean): SceneBuilder => {
  const s = scene()
  line(s, 'data', 'root', ORDERS)
  s.add('brief', turn({ chain: 'data', on: null, request: ORDERS, answer: 'Understood: one row per order, with date, region, product, units and revenue for 2025. Tell me which analysis you want first.' }))
  line(s, 'trend', 'fork', TREND)
  s.add('trend', turn({
    chain: 'trend',
    on: 'brief',
    request: TREND,
    consumed: ['brief'],
    ...(open ? { answer: 'Here is revenue by month, one line per', state: 'running' as const } : { answer: 'Here is revenue by month, one line per region. **North** leads all year; **South** dips in July and August and recovers by October; **West** is flat until a jump in November.' }),
  }))
  line(s, 'top', 'fork', TOP)
  s.add('top', turn({
    chain: 'top',
    on: 'brief',
    request: TOP,
    consumed: ['brief'],
    ...(open ? { state: 'running' as const } : { answer: 'By units sold in 2025: 1. Trail mug (18,240) 2. Canvas tote (15,010) 3. Enamel pin set (12,875) 4. Field notebook (11,300) 5. Wool beanie (9,960).' }),
  }))
  s.group('G', { base: 'data', start: 'brief', members: ['trend', 'top'], open })
  return s
}
const orders = ordersBase(true).build()
const ordersClosed = ordersBase(false).build()
const MEMO = 'Write a one-page memo for the sales team from both analyses'
const RETURNS = 'Which of those five has the highest return rate?'
const ordersDone = (() => {
  const s = ordersBase(false)
  s.add('memo', turn({ chain: 'data', on: 'jb_G', request: MEMO, consumed: ['brief', 'trend', 'top'], answer: '**To:** Sales team. **Summary:** North carried revenue all year, South has a summer dip worth a promotion, and five products account for most units, led by the trail mug.' }))
  line(s, 'returns', 'branch', RETURNS)
  s.add('returns', turn({ chain: 'returns', on: 'top', request: RETURNS, consumed: ['brief', 'top'], answer: 'The wool beanie: 7.9% of units came back, mostly for sizing. The trail mug is lowest at 0.8%.' }))
  return s.build()
})()

// ── cooking: a brief and three courses forked from it ──
const DINNER = 'I’m cooking for six on Saturday. One guest is vegetarian and one can’t eat gluten.'
const COURSES = [
  ['starter', 'Suggest a starter', 'A roasted beetroot and orange salad with toasted hazelnuts: vegetarian, no gluten, and it can be plated ahead.'],
  ['main', 'Suggest a main course', 'A mushroom and chestnut risotto for everyone, with pan-seared chicken thighs on the side for the meat eaters. Risotto rice has no gluten.'],
  ['dessert', 'Suggest a dessert', 'A flourless chocolate and almond torte with crème fraîche. No gluten, and it is better made the day before.'],
] as const
const dinnerBase = (open: boolean): SceneBuilder => {
  const s = scene()
  line(s, 'dinner', 'root', DINNER)
  s.add('brief', turn({ chain: 'dinner', on: null, request: DINNER, answer: 'Got it: six people on Saturday, one vegetarian, one gluten-free. I’ll keep every course safe for both unless you say otherwise.' }))
  for (const [handle, request, answer] of COURSES) {
    line(s, handle, 'fork', request)
    s.add(handle, turn({ chain: handle, on: 'brief', request, consumed: ['brief'], ...(open ? { state: 'running' as const } : { answer }) }))
  }
  s.group('G', { base: 'dinner', start: 'brief', members: COURSES.map(([handle]) => handle), open })
  return s
}
const dinner = dinnerBase(false).build()
const dinnerOpen = dinnerBase(true).build()
const LIST = 'Write a shopping list for all three courses'
const dinnerList = dinnerBase(false)
  .add('list', turn({ chain: 'dinner', on: 'jb_G', request: LIST, consumed: ['brief', 'starter', 'main', 'dessert'], answer: '**For six.** Produce: 6 beetroot, 3 oranges, 600 g chestnut mushrooms. Dry goods: 450 g risotto rice, 200 g ground almonds, 250 g dark chocolate. Meat: 4 chicken thighs.' }))
  .build()

// ── study: a goal, and a plan built on it that is still being written, or done ──
const GOAL = 'I’m sitting the AWS Solutions Architect Associate exam in six weeks and I work full time.'
const PLAN = 'Make me a four-week study plan for it'
const HAIKU = 'Write a haiku about Monday mornings'
const examBase = (running: boolean): Scene => {
  const s = scene()
  line(s, 'haiku', 'root', HAIKU)
  s.add('haiku', turn({ chain: 'haiku', on: null, request: HAIKU, answer: 'Alarm, then silence.\nThe kettle knows what I need\nbefore I can speak.' }))
  line(s, 'exam', 'root', GOAL)
  s.add('goal', turn({ chain: 'exam', on: null, request: GOAL, answer: 'Six weeks is workable alongside a full-time job: about eight hours a week, with the last week kept for practice exams. Tell me what you want first.' }))
  s.add('plan', turn({
    chain: 'exam',
    on: 'goal',
    request: PLAN,
    consumed: ['goal'],
    ...(running ? { answer: 'Week 1 covers', state: 'running' as const } : { answer: '**Week 1:** IAM, VPC basics. **Week 2:** EC2, storage. **Week 3:** databases, high availability. **Week 4:** cost, the Well-Architected pillars, two timed practice exams.' }),
  }))
  return s.build()
}
const exam = examBase(true)
const examDone = examBase(false)

// ── shopping: two recommendations of the same form, on unrelated lines ──
const LAPTOP = 'Recommend a laptop under $1,200 for photo editing'
const PHONE = 'Recommend a phone with a great camera under $700'
const gadgets = (() => {
  const s = scene()
  line(s, 'laptop', 'root', LAPTOP)
  s.add('laptop', turn({ chain: 'laptop', on: null, request: LAPTOP, answer: 'Three good options: the **Asus Zenbook 14 OLED** ($1,050) for its colour-accurate screen, the **MacBook Air M3** ($1,099) for battery life, and the **Lenovo Yoga 7** ($950) as the budget pick.' }))
  line(s, 'phone', 'root', PHONE)
  s.add('phone', turn({ chain: 'phone', on: null, request: PHONE, answer: 'Three good options: the **Pixel 9a** ($499) for point-and-shoot results, the **Galaxy S24 FE** ($650) for its telephoto lens, and the **iPhone 15** ($699) for video.' }))
  return s.build()
})()

// ── money: a budget and two questions that each build on the one before ──
const BUDGET = 'Help me build a monthly budget on a $3,400 take-home salary'
const SAVE = 'How much of that can go into savings?'
const CAR = 'Could I afford a $350 car payment on top?'
const budgetSolo = (() => {
  const s = scene()
  line(s, 'budget', 'root', BUDGET)
  s.add('budget', turn({ chain: 'budget', on: null, request: BUDGET, answer: 'On $3,400 a month, a workable split is **$1,700** for needs (rent, bills, groceries), **$1,020** for wants and **$680** for savings and debt.' }))
  return s.build()
})()
const budgetDeep = (() => {
  const s = scene()
  line(s, 'budget', 'root', BUDGET)
  s.add('budget', turn({ chain: 'budget', on: null, request: BUDGET, answer: 'On $3,400 a month, a workable split is **$1,700** for needs (rent, bills, groceries), **$1,020** for wants and **$680** for savings and debt.' }))
  s.add('save', turn({ chain: 'budget', on: 'budget', request: SAVE, consumed: ['budget'], answer: 'Aim for the full $680: $400 to an emergency fund until it holds three months of needs, and $280 to retirement.' }))
  s.add('car', turn({ chain: 'budget', on: 'save', request: CAR, consumed: ['budget', 'save'], answer: 'Only by cutting wants: $350 would take a third of the $1,020, or most of your savings if you leave wants alone.' }))
  return s.build()
})()

// ── work: a request waiting for the answer to a clarification question, beside a finished one ──
const SUBJECTS = 'Suggest three subject lines for our spring newsletter'
const REMINDER = 'Write a reminder email about the unpaid invoice'
const invoice = (() => {
  const s = scene()
  line(s, 'news', 'root', SUBJECTS)
  s.add('subject', turn({ chain: 'news', on: null, request: SUBJECTS, answer: '1. "Spring has sprung: what’s new this season" 2. "Fresh starts and a few surprises" 3. "Your April update, in five minutes"' }))
  line(s, 'mail', 'root', REMINDER)
  s.add('mail', turn({ chain: 'mail', on: null, request: REMINDER, state: 'awaiting-elicitation' }))
  s.question('Q', 'mail', 'Which unpaid invoice do you mean: the March one for Acme or the April one for Birch?')
  return s.build()
})()

// ── events: the only request so far is waiting for the answer to a clarification question ──
const PARTY = 'Plan a birthday party for my daughter'
const party = (() => {
  const s = scene()
  line(s, 'party', 'root', PARTY)
  s.add('party', turn({ chain: 'party', on: null, request: PARTY, state: 'awaiting-elicitation' }))
  s.question('Q', 'party', 'How old is she turning, and roughly how many children are coming?')
  return s.build()
})()

// ── cooking, with conversation-wide requirements in force ──
const LOAF = 'How do I make a basic sourdough loaf?'
const rules = (() => {
  const s = scene()
  line(s, 'bread', 'root', LOAF)
  s.add('loaf', turn({ chain: 'bread', on: null, request: LOAF, answer: 'Mix 500 g strong flour, 350 g water, 100 g active starter and 10 g salt. Fold every 30 minutes for two hours, shape, prove overnight in the fridge, and bake at 230 °C in a lidded pot.' }))
  s.sessionRequirement('R1', 'Use metric units in every answer')
  s.sessionRequirement('R2', 'Write in British English')
  return s.build()
})()

// ── teaching: one message answered in two sections ──
const handout = (() => {
  const s = scene()
  line(s, 'mito', 'root', 'Explain what mitochondria do')
  s.add('mito', turn({ chain: 'mito', on: null, message: 'X', request: 'Explain what mitochondria do', answer: 'Mitochondria turn the energy in food into ATP, the molecule cells spend to do work. They have their own DNA and two membranes; the inner one is folded to make room for the machinery.' }))
  line(s, 'quiz', 'root', 'Write five quiz questions on the French Revolution')
  s.add('quiz', turn({ chain: 'quiz', on: null, message: 'X', request: 'Write five quiz questions on the French Revolution', answer: '1. In which year was the Bastille stormed? 2. What was the Tennis Court Oath? 3. Who were the Jacobins? 4. What ended the Reign of Terror? 5. Which document set out the rights of man and of the citizen?' }))
  return s.build()
})()

// ── cooking, in Spanish: two unrelated lines ──
const PAELLA = '¿Cómo hago una paella valenciana para cuatro personas?'
const VINO = '¿Qué vino va bien con el marisco?'
const cena = (() => {
  const s = scene()
  line(s, 'paella', 'root', PAELLA)
  s.add('paella', turn({ chain: 'paella', on: null, request: PAELLA, answer: 'Sofríe 400 g de pollo y 300 g de conejo en aceite de oliva, añade judía verde y garrofó, tomate rallado y pimentón. Cubre con caldo, añade 400 g de arroz bomba y azafrán, y cuece 18 minutos sin remover.' }))
  line(s, 'vino', 'root', VINO)
  s.add('vino', turn({ chain: 'vino', on: null, request: VINO, answer: 'Un blanco seco y fresco: un albariño de Rías Baixas o un verdejo de Rueda. Con marisco a la plancha también va bien un cava brut.' }))
  return s.build()
})()

const empty = scene().build()

export const SCENES = { empty, flask, letter, orders, ordersClosed, ordersDone, dinner, dinnerOpen, dinnerList, exam, examDone, gadgets, budgetSolo, budgetDeep, invoice, party, rules, handout, cena } as const
export type SceneName = keyof typeof SCENES

export const SCENE_DOMAIN: { readonly [S in SceneName]: Domain } = {
  empty: 'none',
  flask: 'code',
  letter: 'writing',
  orders: 'data',
  ordersClosed: 'data',
  ordersDone: 'data',
  dinner: 'cooking',
  dinnerOpen: 'cooking',
  dinnerList: 'cooking',
  exam: 'study',
  examDone: 'study',
  gadgets: 'shopping',
  budgetSolo: 'money',
  budgetDeep: 'money',
  invoice: 'work',
  party: 'events',
  rules: 'cooking',
  handout: 'teaching',
  cena: 'cooking',
}
