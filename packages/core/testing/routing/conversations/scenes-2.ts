import { provisionalLabel, type DirectiveState } from '@pluribus/protocol'
import { scene, type Scene, type SceneBuilder } from '../corpus/scene'
import type { Domain } from './types'

/**
 * More conversations of the conversation corpus, for the shapes the first
 * set lacks: long lines whose referent is mid-line, a tree with two closed
 * sibling groups, work in flight on two unrelated lines at once, an open
 * group beside an unrelated finished line, conversations of up to twenty
 * sections, and conversations in French, German and Portuguese. Merged into
 * `SCENES` by `scenes.ts`.
 *
 * As there, a section's title is its request's first words, as a live run
 * records it (`provisionalLabel`), and an answer opens the way a model's
 * answer does.
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

/** A line of finished exchanges on one chain, each continuing the one before and reading everything above it. */
function run(s: SceneBuilder, chain: string, on: string | null, before: readonly string[], steps: readonly (readonly [handle: string, request: string, answer: string])[]): SceneBuilder {
  let parent = on
  const read = [...before]
  for (const [handle, request, answer] of steps) {
    s.add(handle, turn({ chain, on: parent, request, answer, ...(read.length > 0 ? { consumed: [...read] } : {}) }))
    read.push(handle)
    parent = handle
  }
  return s
}

// ── writing: one line of eight answers, a blog post built section by section ──
const ESSAY = [
  ['outline', 'Outline a 1,500-word blog post arguing that four-day weeks help small companies', '1. The hook: a bakery that stopped opening on Fridays. 2. What the trials found. 3. Why small firms gain the most. 4. The objections, taken seriously. 5. How to try it for one quarter.'],
  ['intro', 'Write the introduction', 'When Marta stopped opening her bakery on Fridays, her regulars expected the worst. Six months later sales were up 9%, nobody had quit, and she had stopped dreading Mondays. Her story is not unusual, and the evidence behind it is better than most people think.'],
  ['trials', 'Now the section on what the trials found', 'The largest trial so far followed 61 companies in the UK for six months in 2022. Afterwards 56 of them kept the shorter week, revenue was broadly flat, and sick days fell by about two thirds. Staff reported less burnout, and fewer of them left.'],
  ['small', 'Next, why small firms gain the most', 'A small company cannot outbid a large one on salary, but it can offer time. In a team of eight, losing one person costs months of hiring; a four-day week makes people stay. Small firms can also change their schedule in a week, without a committee.'],
  ['objections', 'Write the objections section', 'The strongest objection is coverage: a five-person firm cannot simply close on Fridays if customers call on Fridays. The answer is staggered days off, not a shared one. The second objection, that people cram five days into four, is real for the first month and fades after.'],
  ['conclusion', 'Write the conclusion', 'A four-day week is not a perk. It is a bet that focus beats hours, and for small companies it is a bet that has mostly paid off. Try it for one quarter, measure what matters to you, and keep it only if the numbers agree.'],
  ['titles', 'Suggest five titles for the post', '1. Fridays Off, Profits Up 2. The Small-Business Case for a Four-Day Week 3. What a Year of Trials Taught Us About Working Less 4. Time Is the Perk You Can Afford 5. Four Days, No Regrets'],
  ['thread', 'Turn the post into a five-tweet thread', '1/ When Marta stopped opening her bakery on Fridays, her regulars expected the worst. Six months later, sales were up 9%. 🧵\n2/ She is not alone: in the UK trial, nine in ten companies kept the four-day week.\n3/ Small firms gain the most. They cannot outbid big ones on salary, but they can offer time.'],
] as const
const essay = (() => {
  const s = scene()
  line(s, 'post', 'root', ESSAY[0][1])
  return run(s, 'post', null, [], ESSAY).build()
})()

// ── money: one line of eight answers about buying a flat ──
const MORTGAGE = [
  ['payment', 'I’m buying a flat for €320,000 with €64,000 down. What’s the monthly payment at 3.8% fixed over 25 years?', 'You would borrow €256,000. At 3.8% fixed over 25 years the monthly payment is about **€1,323**, and you would pay roughly €141,000 in interest over the whole term.'],
  ['thirty', 'And over 30 years?', 'About **€1,193** a month: €130 less, but around €173,000 in interest, some €32,000 more than over 25 years.'],
  ['overpay', 'What if I overpay €200 a month on the 25-year one?', 'You would clear it about four years early and save roughly €26,000 in interest, as long as your lender lets you overpay that much without a fee. Most allow 10% of the balance a year.'],
  ['fixvar', 'Should I fix the rate or go variable?', 'Fixed protects you if rates rise; variable is cheaper today, at around 3.2%, but your payment could move by €130 or more for each percentage point. On a tight budget, fixing for ten years is the safer of the two.'],
  ['costs', 'What other costs come with buying?', 'Budget about 8% of the price on top: transfer tax at 6% (€19,200), notary and land registry fees of around 2% (€6,400), and a valuation fee of €300 to €500. Most banks will not lend for these.'],
  ['insurance', 'Do I need life insurance for the mortgage?', 'Most lenders require it, or at least a policy that covers the outstanding balance. A decreasing-term policy is the cheapest kind, because the cover falls as the loan does.'],
  ['afford', 'Can I afford it on €4,100 a month take-home?', 'Yes, with care: €1,323 is 32% of €4,100, just under the 35% most banks use as a ceiling. Keep three months of costs in reserve before you sign.'],
  ['checklist', 'Make me a checklist for the meeting with the bank', '- Three recent payslips and your employment contract\n- Six months of bank statements\n- Proof of the €64,000 deposit\n- The reservation contract for the flat\n- Questions: overpayment limits, early repayment fees, fixed-period length'],
] as const
const mortgage = (() => {
  const s = scene()
  line(s, 'home', 'root', MORTGAGE[0][1])
  return run(s, 'home', null, [], MORTGAGE).build()
})()

// ── work: two unrelated lines with work in flight on each, and a finished one ──
const NOTES = 'Write release notes for v2.3 from this changelog: dark mode, CSV export, faster search, 14 bug fixes'
const HIRE = 'We’re hiring a senior backend engineer: Go and Postgres, remote within the EU, €85–100k. I’ll ask for a few things.'
const AD = 'Write the job ad'
const INCIDENT = 'Summarise yesterday’s incident report: the payments API was down for 47 minutes after a TLS certificate expired'
const launch = (() => {
  const s = scene()
  line(s, 'incident', 'root', INCIDENT)
  s.add('incident', turn({ chain: 'incident', on: null, request: INCIDENT, answer: '**What happened:** the TLS certificate on the payments API expired at 14:02 and every request failed until 14:49. **Impact:** about 3,100 failed checkouts. **Cause:** renewal was manual and the reminder went to a former employee. **Fix:** automatic renewal, and an alert 14 days before expiry.' }))
  line(s, 'hire', 'root', HIRE)
  s.add('hire', turn({ chain: 'hire', on: null, request: HIRE, answer: 'Got it: a senior backend engineer working in Go and Postgres, remote anywhere in the EU, paid €85–100k. Tell me what you need first.' }))
  s.add('ad', turn({ chain: 'hire', on: 'hire', request: AD, consumed: ['hire'], state: 'running' }))
  line(s, 'notes', 'root', NOTES)
  s.add('notes', turn({ chain: 'notes', on: null, request: NOTES, answer: '## What’s new in 2.3\n\n**Dark mode** is here, and it follows', state: 'running' }))
  return s.build()
})()

// ── teaching: three forks from a class brief, running or finished, beside an unrelated finished email ──
const CLASS = 'I teach a Year 9 science class of 28. Next week is photosynthesis, in 50-minute lessons.'
const LESSON_PARTS = [
  ['worksheet', 'Make a worksheet on the light and dark reactions', '**Photosynthesis: two stages.** 1. Label the thylakoid and the stroma on the diagram. 2. Which stage needs light, and what does it produce? 3. Fill in the gaps: carbon dioxide + ____ → glucose + ____.', '**Photosynthesis: two stages.** 1. Label the'],
  ['practical', 'Suggest a classroom experiment that shows plants producing oxygen', 'Pondweed in a beaker of water under a lamp: count the bubbles of oxygen per minute at three distances from the light. Groups of four, about 25 minutes, and it shows the effect of light intensity too.', undefined],
  ['quiz', 'Write a ten-question multiple-choice quiz', '1. Where in the cell does photosynthesis happen? (a) mitochondria (b) chloroplasts (c) nucleus 2. Which gas do plants take in? (a) oxygen (b) nitrogen (c) carbon dioxide 3. What is chlorophyll for?', undefined],
] as const
const PARENTS = 'Write a polite email to parents about the £12 deposit for the zoo trip'
const lessonBase = (open: boolean): Scene => {
  const s = scene()
  line(s, 'parents', 'root', PARENTS)
  s.add('parents', turn({ chain: 'parents', on: null, request: PARENTS, answer: 'Dear parents and carers,\n\nOur Year 9 trip to the zoo is on 14 May. To hold your child’s place, please pay the £12 deposit through the school app by Friday 2 May. If cost is a concern, please contact the office in confidence.' }))
  line(s, 'lesson', 'root', CLASS)
  s.add('brief', turn({ chain: 'lesson', on: null, request: CLASS, answer: 'Got it: 28 Year 9 students, a week on photosynthesis, 50 minutes a lesson. I’ll pitch everything at that level unless you say otherwise.' }))
  for (const [handle, request, answer, partial] of LESSON_PARTS) {
    line(s, handle, 'fork', request)
    s.add(handle, turn({ chain: handle, on: 'brief', request, consumed: ['brief'], ...(open ? { state: 'running' as const, ...(partial ? { answer: partial } : {}) } : { answer }) }))
  }
  s.group('G', { base: 'lesson', start: 'brief', members: LESSON_PARTS.map(([handle]) => handle), open })
  return s.build()
}
const lessonOpen = lessonBase(true)
const lessonDone = lessonBase(false)

// ── events: a brief, a closed group, a timeline from its join-back, a second closed group from the timeline, and a branch from one sibling ──
const WEDDING = 'We’re getting married on 12 September near Bath: 80 guests, a £15,000 budget, and the ceremony outdoors if the weather allows.'
const wedding = (() => {
  const s = scene()
  line(s, 'wedding', 'root', WEDDING)
  s.add('brief', turn({ chain: 'wedding', on: null, request: WEDDING, answer: 'Congratulations! So: 12 September, near Bath, 80 guests, £15,000 in all, outdoors if possible. I’ll keep a wet-weather fallback in everything I suggest.' }))
  line(s, 'venue', 'fork', 'Shortlist three venues')
  s.add('venue', turn({ chain: 'venue', on: 'brief', request: 'Shortlist three venues', consumed: ['brief'], answer: '1. **Priston Mill** (£4,800): a lawn by the mill stream and a barn if it rains. 2. **Kelston Orchard** (£3,900): ceremony under the apple trees, marquee extra. 3. **The Old Rectory, Bathford** (£5,600): walled garden and an orangery for 90.' }))
  line(s, 'catering', 'fork', 'Suggest three caterers')
  s.add('catering', turn({ chain: 'catering', on: 'brief', request: 'Suggest three caterers', consumed: ['brief'], answer: '1. **Honeybee Kitchen**: sharing platters, about £55 a head. 2. **The Long Table**: a seasonal three-course menu at £68. 3. **Fire & Fork**: wood-fired street food at £42, popular for evening receptions.' }))
  s.group('G1', { base: 'wedding', start: 'brief', members: ['venue', 'catering'], open: false })
  s.add('timeline', turn({ chain: 'wedding', on: 'jb_G1', request: 'Draft a timeline for the day from the venue and caterer shortlists', consumed: ['brief', 'venue', 'catering'], answer: '**13:00** guests arrive · **13:30** ceremony on the lawn · **14:15** drinks and photos · **16:00** wedding breakfast · **18:30** speeches · **19:30** evening guests and first dance · **23:30** carriages.' }))
  line(s, 'invite', 'fork', 'Write the invitation wording')
  s.add('invite', turn({ chain: 'invite', on: 'timeline', request: 'Write the invitation wording', consumed: ['brief', 'venue', 'catering', 'timeline'], answer: 'Together with their families, Alex and Sam invite you to celebrate their marriage on Saturday 12 September at 1.30pm, followed by dinner and dancing. RSVP by 1 July.' }))
  line(s, 'music', 'fork', 'Suggest a playlist for the evening')
  s.add('music', turn({ chain: 'music', on: 'timeline', request: 'Suggest a playlist for the evening', consumed: ['brief', 'venue', 'catering', 'timeline'], answer: 'Start gentle for dinner (Norah Jones, Leon Bridges), lift it for the first dance (“At Last”), then three hours of floor-fillers from Motown to Dua Lipa, ending on “Mr. Brightside”.' }))
  s.group('G2', { base: 'wedding', start: 'timeline', members: ['invite', 'music'], open: false })
  line(s, 'cake', 'branch', 'Which of those caterers can also make the cake?')
  s.add('cake', turn({ chain: 'cake', on: 'catering', request: 'Which of those caterers can also make the cake?', consumed: ['brief', 'catering'], answer: 'Two can. **Honeybee Kitchen** bakes in-house (three tiers for 80 from £420) and cuts and serves it for you. **The Long Table** works with a baker in Frome and adds £3 a head.' }))
  return s.build()
})()

// ── home: two unrelated finished answers about plants ──
const TOMATO = 'How do I grow tomatoes on a balcony?'
const HERBS = 'Which herbs grow well in shade?'
const garden = (() => {
  const s = scene()
  line(s, 'tomato', 'root', TOMATO)
  s.add('tomato', turn({ chain: 'tomato', on: null, request: TOMATO, answer: 'Pick a compact variety such as **Tumbling Tom** or **Sungold**, use a pot of at least 20 litres with drainage holes, and give it six to eight hours of direct sun. Stake it once it reaches 30 cm, and feed it with tomato fertiliser after the first flowers appear.' }))
  line(s, 'herbs', 'root', HERBS)
  s.add('herbs', turn({ chain: 'herbs', on: null, request: HERBS, answer: 'Mint, parsley, chives, coriander and lemon balm all cope with three or four hours of sun a day. Give mint a pot of its own, because it spreads, and cut parsley and chives often to keep them bushy.' }))
  return s.build()
})()

// ── study, in French: two unrelated finished answers ──
const GRAMMAIRE = 'Explique-moi la différence entre l’imparfait et le passé composé'
const COURSE = 'Fais-moi un plan d’entraînement pour courir 10 km en 8 semaines'
const francais = (() => {
  const s = scene()
  line(s, 'grammaire', 'root', GRAMMAIRE)
  s.add('grammaire', turn({ chain: 'grammaire', on: null, request: GRAMMAIRE, answer: 'Le passé composé raconte une action terminée, datée ou comptée : « Hier, j’ai mangé une pizza. » L’imparfait décrit le décor, une habitude ou une action en cours : « Quand j’étais petit, je mangeais souvent des pizzas. » Les deux se combinent : « Je lisais quand le téléphone a sonné. »' }))
  line(s, 'course', 'root', COURSE)
  s.add('course', turn({ chain: 'course', on: null, request: COURSE, answer: 'Trois sorties par semaine. **Mardi :** fractionné, de 6 × 400 m au début jusqu’à 5 × 1 000 m en semaine 6. **Jeudi :** footing tranquille de 30 à 45 minutes. **Dimanche :** sortie longue, de 5 km en semaine 1 à 9 km en semaine 7. La semaine 8 est allégée avant la course.' }))
  return s.build()
})()

// ── code, in German: a function with tests built on it, and an unrelated answer ──
const IBAN = 'Schreib mir eine Python-Funktion, die prüft, ob eine IBAN gültig ist'
const IBAN_TEST = 'Schreib dazu Tests mit pytest'
const ABSAGE = 'Wie formuliere ich eine höfliche Absage auf eine Einladung zum Abendessen?'
const deutsch = (() => {
  const s = scene()
  line(s, 'iban', 'root', IBAN)
  s.add('iban', turn({ chain: 'iban', on: null, request: IBAN, answer: 'Geprüft wird mit Modulo 97: die ersten vier Zeichen ans Ende stellen, Buchstaben in Zahlen umwandeln (A = 10 … Z = 35) und prüfen, ob der Rest 1 ist:\n\n```python\ndef iban_gueltig(iban: str) -> bool:\n    umgestellt = iban[4:] + iban[:4]\n    zahl = "".join(str(int(z, 36)) for z in umgestellt)\n    return int(zahl) % 97 == 1\n```' }))
  s.add('ibantest', turn({ chain: 'iban', on: 'iban', request: IBAN_TEST, consumed: ['iban'], answer: 'Drei Fälle: eine gültige deutsche IBAN, eine mit falscher Prüfziffer und eine zu kurze:\n\n```python\ndef test_gueltige_iban():\n    assert iban_gueltig("DE89370400440532013000")\n\ndef test_falsche_pruefziffer():\n    assert not iban_gueltig("DE88370400440532013000")\n```' }))
  line(s, 'absage', 'root', ABSAGE)
  s.add('absage', turn({ chain: 'absage', on: null, request: ABSAGE, answer: 'Zum Beispiel: „Vielen Dank für die Einladung! Leider bin ich an dem Abend schon verplant. Ich würde mich aber freuen, wenn wir das bald nachholen.“ Kurz, dankbar und mit einem Vorschlag für später: mehr braucht eine Absage nicht.' }))
  return s.build()
})()

// ── cooking, in Portuguese: a pressure cooker and a recipe, on unrelated lines ──
const PANELA = 'Qual é a melhor panela de pressão até R$ 400?'
const FEIJOADA = 'Me passa uma receita de feijoada para seis pessoas'
const cozinha = (() => {
  const s = scene()
  line(s, 'panela', 'root', PANELA)
  s.add('panela', turn({ chain: 'panela', on: null, request: PANELA, answer: 'Três boas opções: a **Tramontina Vancouver 6 L** (R$ 329), de inox e com fundo triplo; a **Clock Turbo 4,5 L** (R$ 189), de alumínio e leve; e a **Electrolux PCC20** elétrica (R$ 389), que desliga sozinha no fim do cozimento.' }))
  line(s, 'feijoada', 'root', FEIJOADA)
  s.add('feijoada', turn({ chain: 'feijoada', on: null, request: FEIJOADA, answer: 'Deixe 1 kg de feijão-preto de molho na véspera e dessalgue 500 g de carne-seca. Cozinhe o feijão com a carne-seca, 300 g de costelinha e louro por cerca de duas horas, junte linguiça e paio na última meia hora e finalize com um refogado de alho e cebola.' }))
  return s.build()
})()

// ── events: a request waiting for the answer to a clarification question, or the same request answered ──
const AGENDA = 'Write an agenda for Thursday’s planning meeting'
const RESTAURANT = 'Suggest a restaurant for the team dinner on Friday'
const teamDinner = (asked: boolean): Scene => {
  const s = scene()
  line(s, 'agenda', 'root', AGENDA)
  s.add('agenda', turn({ chain: 'agenda', on: null, request: AGENDA, answer: '**Thursday planning, 60 minutes.** 1. Last quarter in numbers (10 min) 2. What we stop doing (15 min) 3. Three bets for next quarter (25 min) 4. Owners and dates (10 min)' }))
  line(s, 'resto', 'root', RESTAURANT)
  if (asked) {
    s.add('resto', turn({ chain: 'resto', on: null, request: RESTAURANT, state: 'awaiting-elicitation' }))
    s.question('Q', 'resto', 'Which part of town should it be near, and roughly what budget per head?')
  } else {
    s.add('resto', turn({ chain: 'resto', on: null, request: RESTAURANT, answer: 'Three places that take groups of twelve on a Friday: **Dishoom** in Covent Garden (about £35 a head), **Padella** in Borough (£30, no bookings for large groups before 9pm) and **Hawksmoor** in Spitalfields (£70).' }))
  }
  return s.build()
}
const teamDinnerAsked = teamDinner(true)
const teamDinnerDone = teamDinner(false)

// ── events: two forks from a conference brief, both running ──
const CONFERENCE = 'We’re running a one-day, one-track developer conference for 200 people in Lyon on 3 June.'
const conference = (() => {
  const s = scene()
  line(s, 'conf', 'root', CONFERENCE)
  s.add('brief', turn({ chain: 'conf', on: null, request: CONFERENCE, answer: 'Noted: one day, one track, 200 attendees, Lyon, 3 June. With one track, about eight talks of 30 minutes fit with breaks. What would you like first?' }))
  line(s, 'talks', 'fork', 'Suggest ten talk topics')
  s.add('talks', turn({ chain: 'talks', on: 'brief', request: 'Suggest ten talk topics', consumed: ['brief'], state: 'running', answer: '1. **Postgres at the edge**: what' }))
  line(s, 'sponsors', 'fork', 'Draft three sponsorship tiers')
  s.add('sponsors', turn({ chain: 'sponsors', on: 'brief', request: 'Draft three sponsorship tiers', consumed: ['brief'], state: 'running' }))
  s.group('G', { base: 'conf', start: 'brief', members: ['talks', 'sponsors'], open: true })
  return s.build()
})()

// ── work: sixteen sections on seven trees, among them a line of three, a closed group continued from its join-back, and a line of three on a reply ──
const office = (() => {
  const s = scene()
  line(s, 'feedback', 'root', 'Summarise this customer feedback export: 412 responses from Q3')
  run(s, 'feedback', null, [], [
    ['feedback', 'Summarise this customer feedback export: 412 responses from Q3', 'Three things dominate the 412 responses: slow sync on Android (118 mentions), confusing billing emails (74), and praise for the new editor (66). Satisfaction is highest among teams of five or more.'],
    ['themes', 'Group the complaints into themes', '**Performance** (161): Android sync, slow search. **Billing** (98): unclear emails, surprise renewals. **Onboarding** (52): no templates, hard to invite a team. **Other** (31).'],
    ['fix', 'Which theme should we fix first?', 'Performance, and within it Android sync: it is the most mentioned single problem, it drives most of the one-star reviews, and the fix is contained to one client.'],
  ])
  line(s, 'agenda', 'root', 'Write the agenda for Monday’s product review')
  s.add('agenda', turn({ chain: 'agenda', on: null, request: 'Write the agenda for Monday’s product review', answer: '**Product review, Monday 10:00.** 1. Q3 metrics (10 min) 2. Customer feedback highlights (15 min) 3. Roadmap changes (20 min) 4. Decisions and owners (15 min)' }))
  line(s, 'pricing', 'root', 'Draft the copy for our pricing page: Pro at $12 and Team at $20 per seat')
  s.add('pricing', turn({ chain: 'pricing', on: null, request: 'Draft the copy for our pricing page: Pro at $12 and Team at $20 per seat', answer: '**Simple pricing that grows with you.** Pro, $12 a month: unlimited projects and version history. Team, $20 a seat: everything in Pro, plus shared workspaces, admin controls and priority support.' }))
  line(s, 'faq', 'fork', 'Write the FAQ for the pricing page')
  s.add('faq', turn({ chain: 'faq', on: 'pricing', request: 'Write the FAQ for the pricing page', consumed: ['pricing'], answer: '**Can I switch plans?** Yes, at any time; we prorate the difference. **Is there a free trial?** 14 days of Team, no card needed. **Do you offer refunds?** Within 30 days of any payment.' }))
  line(s, 'table', 'fork', 'Make a plan comparison table')
  s.add('table', turn({ chain: 'table', on: 'pricing', request: 'Make a plan comparison table', consumed: ['pricing'], answer: '| | Pro | Team |\n|---|---|---|\n| Price | $12 / month | $20 / seat / month |\n| Projects | Unlimited | Unlimited |\n| Shared workspaces | – | ✓ |\n| Admin controls | – | ✓ |' }))
  s.group('G', { base: 'pricing', start: 'pricing', members: ['faq', 'table'], open: false })
  s.add('page', turn({ chain: 'pricing', on: 'jb_G', request: 'Put the copy, the FAQ and the table together as one page', consumed: ['pricing', 'faq', 'table'], answer: '# Pricing\n\n**Simple pricing that grows with you.** Two plans, no surprises.\n\n| | Pro | Team |\n|---|---|---|\n| Price | $12 / month | $20 / seat / month |' }))
  line(s, 'arr', 'root', 'Explain the difference between ARR and MRR')
  s.add('arr', turn({ chain: 'arr', on: null, request: 'Explain the difference between ARR and MRR', answer: 'MRR is the recurring revenue you bill in a month; ARR is the same figure for a year, usually MRR × 12. Neither counts one-off fees. Monthly businesses track MRR, annual-contract businesses ARR.' }))
  line(s, 'refund', 'root', 'Draft a reply to a customer who wants a refund 45 days after renewal')
  run(s, 'refund', null, [], [
    ['refund', 'Draft a reply to a customer who wants a refund 45 days after renewal', 'Hi Sam,\n\nThanks for getting in touch. Our refund window is 30 days from each payment, so I’m afraid this renewal is outside it. What I can do is switch your account to monthly billing from today, so you are never locked in for a year again.'],
    ['firmer', 'Make it firmer', 'Hi Sam,\n\nThank you for your message. Refunds are available within 30 days of payment, and your renewal was 45 days ago, so we are unable to refund it. You can switch to monthly billing at any time from your account settings.'],
    ['german', 'Translate it into German', 'Hallo Sam,\n\nvielen Dank für Ihre Nachricht. Erstattungen sind innerhalb von 30 Tagen nach der Zahlung möglich. Ihre Verlängerung liegt 45 Tage zurück, daher können wir sie leider nicht erstatten.'],
  ])
  line(s, 'okr', 'root', 'Plan Q4 OKRs for the support team')
  run(s, 'okr', null, [], [
    ['okr', 'Plan Q4 OKRs for the support team', '**Objective:** customers get help that solves their problem the first time. **KR1:** first-contact resolution from 61% to 70%. **KR2:** CSAT at 4.6 or above. **KR3:** a help-centre article for each of the 20 most common questions.'],
    ['kr', 'Add a key result for first-response time', '**KR4:** median first response under two hours in business hours, down from five. Track it weekly in the support dashboard; it moves fastest if the morning shift starts with the overnight queue.'],
  ])
  line(s, 'series', 'root', 'Suggest three names for our new onboarding email series')
  run(s, 'series', null, [], [
    ['series', 'Suggest three names for our new onboarding email series', '1. **First Steps** 2. **The Welcome Week** 3. **Up and Running**'],
    ['email1', 'Write the first email of that series', '**Subject:** Welcome! Here’s your first five minutes\n\nHi there, you’re in. Start by creating a project and inviting one teammate: everything else is easier with two.'],
  ])
  return s.build()
})()

export const SCENES_2 = { essay, mortgage, launch, lessonOpen, lessonDone, wedding, garden, francais, deutsch, cozinha, teamDinnerAsked, teamDinnerDone, conference, office } as const

export const SCENE_DOMAIN_2: { readonly [S in keyof typeof SCENES_2]: Domain } = {
  essay: 'writing',
  mortgage: 'money',
  launch: 'work',
  lessonOpen: 'teaching',
  lessonDone: 'teaching',
  wedding: 'events',
  garden: 'home',
  francais: 'study',
  deutsch: 'code',
  cozinha: 'cooking',
  teamDinnerAsked: 'events',
  teamDinnerDone: 'events',
  conference: 'events',
  office: 'work',
}
