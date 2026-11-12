import { scene } from './scene'
import type { CorpusExample } from './types'

/**
 * Scenes: the running examples of 01–07, as the router's candidates show
 * them. Section, directive and node handles are the same name.
 */
const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'

const empty = scene().build()

const sky = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering: air scatters blue light more than red.' })
  .build()

const twoAnswers = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering: air scatters blue light more than red.' })
  .chain('menu', 'root', 'menu translation')
  .add('M', { chain: 'menu', on: null, label: 'menu translation', request: 'Translate this menu into French: soup, bread, cheese', answer: 'Soupe, pain, fromage.' })
  .build()

/**
 * Two lines that never met: a city, and the sky with a follow-up about the
 * ocean. A message about the ocean and sky in that city is about all three
 * answers a little and about none of them clearly (the conversation
 * exported on 2026-11-12, where routing asked which answer was meant).
 */
const cityAndSky = scene()
  .chain('city', 'root', 'kyoto city')
  .add('K', {
    chain: 'city',
    on: null,
    label: 'kyoto city',
    request: 'Tell me about kyoto',
    answer: 'Kyoto is a city in Japan\'s Kansai region, on the island of Honshu. It was the imperial capital for more than a thousand years, and is known for its temples, shrines and gardens.',
  })
  .chain('sky', 'root', 'sky color question')
  .add('S', {
    chain: 'sky',
    on: null,
    label: 'sky color question',
    request: 'why is the sky blue?',
    answer: 'The sky is blue because of Rayleigh scattering: air molecules scatter short blue wavelengths of sunlight far more than long red ones.',
  })
  .add('O', {
    chain: 'sky',
    on: 'S',
    label: 'ocean sky reflection',
    request: 'And does the ocean reflect the sky?',
    answer: 'Partly. The surface reflects some skylight, but the ocean is blue mainly because water absorbs red light and scatters blue back.',
  })
  .build()

/**
 * Three answers about one city, each on its own line. Only the history's
 * answer has a part about the city today, under a heading far below its
 * opening: a message about that part is identifiable only from later in the
 * answer (docs/build/dependency-decisioning.md · "What a Point shows").
 */
const kyotoTopics = scene()
  .chain('city', 'root', 'kyoto city')
  .add('C', {
    chain: 'city',
    on: null,
    label: 'kyoto city',
    request: 'Tell me about Kyoto the city',
    answerText:
      'Kyoto is a city in the Kansai region of Japan, known for its temples, gardens and wooden machiya houses. The centre sits between the Kamo and Katsura rivers, and most visitors stay near Shijo or Kyoto Station, where the trains and buses meet.',
  })
  .chain('food', 'root', 'kyoto food')
  .add('F', {
    chain: 'food',
    on: null,
    label: 'kyoto food',
    request: 'What is the food like in Kyoto?',
    answerText: 'Kyoto cooking is known for kaiseki, tofu, yuba and pickles. Nishiki Market is the place to taste them, and the tea houses of Uji are a short train ride away.',
  })
  .chain('history', 'root', 'kyoto history')
  .add('H', {
    chain: 'history',
    on: null,
    label: 'kyoto history',
    request: 'Give me the history of Kyoto',
    answerText: [
      'Kyoto was the imperial capital for more than a thousand years, from 794 until 1869, and the grid of its streets still follows the plan laid out for the Heian court. The city was spared the worst of the bombing in the Second World War, which is why so many wooden buildings survive.',
      '',
      '## The Heian court',
      '',
      'The court gave the city its calendar of festivals: the Aoi Matsuri in May, the Gion Matsuri in July, the Jidai Matsuri in October. Each procession is run by the same neighbourhood associations that have run it for centuries.',
      '',
      '## Warlords and temples',
      '',
      'Oda Nobunaga and Toyotomi Hideyoshi rebuilt the city after the Onin War, walled it, and moved the temples into the long street of Teramachi.',
      '',
      '## The move to Tokyo',
      '',
      'In 1869 the emperor moved to Tokyo. The city lost a third of its people within a decade and answered by building the first elementary schools in Japan, a canal from Lake Biwa and the first electric tram in the country.',
      '',
      '## Modern Kyoto',
      '',
      'Modern Kyoto is a university city of 1.4 million with a busy technology industry: Nintendo, Kyocera and Omron have their headquarters here. Housing is the sore point: short-term rentals and tourist crowds have pushed residents out of the centre, and the city now limits both.',
    ].join('\n'),
  })
  .build()

const compositeAnswer = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', message: 'X', request: 'Explain why the sky is blue', answer: 'Sunlight scatters off air molecules; blue scatters most.' })
  .chain('menu', 'root', 'menu translation')
  .add('M', { chain: 'menu', on: null, label: 'menu translation', message: 'X', request: 'Translate this menu into French: soup, bread', answer: 'Soupe, pain.' })
  .build()

const tripBrief = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .build()

const tripOneRunning = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .add('A', { chain: 'trip', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .build()

const tripRunning = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', state: 'running', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: true })
  .build()

const tripQueuedJ = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', state: 'running', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: true })
  .add('J', { chain: 'trip', on: 'brief', label: 'itinerary', request: 'Use those recommendations to make a five-day itinerary', state: 'dependency-queued' })
  .build()

const tripClosed = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Stay in Gion or Higashiyama for walkable temples.', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', answer: 'The National Museum, a tea ceremony, and Nishiki Market.', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: false })
  .build()

const tripDoneSteps = () =>
  scene()
    .chain('trip', 'root', 'trip')
    .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
    .chain('A', 'fork', 'neighborhoods')
    .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Stay in Gion or Higashiyama.', consumed: ['brief'] })
    .chain('B', 'fork', 'activities')
    .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', answer: 'The National Museum and a tea ceremony.', consumed: ['brief'] })
    .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: false })
    .add('J', { chain: 'trip', on: 'jb_G', label: 'itinerary', request: 'Use those recommendations to make a five-day itinerary', answer: 'Day 1: Gion. Day 2: museum…', consumed: ['brief', 'A', 'B'] })
    .chain('sky', 'root', 'sky')
    .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering.' })

const tripDone = tripDoneSteps().build()

const tripBranch = tripDoneSteps()
  .chain('b2', 'branch', 'cheaper activities')
  .add('B2', { chain: 'b2', on: 'B', label: 'cheaper activities', request: 'Give me three cheaper alternatives', answer: 'Free shrines, Philosopher’s Path, Kamo river walk.', consumed: ['brief', 'B'] })
  .build()

const recommendationRunning = scene()
  .chain('rec', 'root', 'laptop')
  .add('R', { chain: 'rec', on: null, label: 'laptop recommendation', request: 'Recommend a laptop for programming, with reasons', state: 'running', answer: 'For programming I would' })
  .build()

const questionOpen = scene()
  .chain('menu', 'root', 'menu translation')
  .add('T', { chain: 'menu', on: null, label: 'menu translation', message: 'Y', request: 'Translate this menu into French: soup, bread', answer: 'Soupe, pain.' })
  .chain('event', 'root', 'yesterday')
  .add('E', { chain: 'event', on: null, label: 'yesterday', message: 'Y', request: 'Explain what happened yesterday', state: 'awaiting-elicitation' })
  .question('Q', 'E', 'Which event yesterday do you mean: the office fire drill or the city marathon?')
  .build()

const session = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering.' })
  .sessionRequirement('R1', 'Keep every answer under 100 words')
  .build()

/**
 * The trip as a live run records it: a section's title is the request's
 * first words (`provisionalLabel`), not a tidy noun, and an answer's
 * opening is 280 characters of markdown. The scenes above use short labels;
 * the live decision model reads these.
 */
const LIVE_BRIEF = 'I’m planning a five-day trip to Kyoto in November on a moderate budget.'
const LIVE_BRIEF_ANSWER =
  'That sounds like a wonderful trip! Kyoto in November is at its best: the maple leaves usually peak in the second half of the month, days are mild and evenings are cool. Tell me what you would like help with: where to stay, what to do, or how to get around.'
const LIVE_A_ANSWER =
  'For five days in November on a moderate budget, three areas stand out.\n\n**Gion / Higashiyama** puts you within walking distance of Kiyomizu-dera and the old lanes. **Downtown Kawaramachi** is best for food and transit. **Kyoto Station area** is the cheapest and handy for day trips'
const LIVE_B_ANSWER =
  'November showers are common, so here are indoor options that still feel like Kyoto:\n\n1. **Kyoto National Museum** for a half day.\n2. **A tea ceremony in Gion.**\n3. **Nishiki Market**, which is covered.\n4. **The Railway Museum.**\n5. **Sake tasting in Fushimi.**'

const liveTrip = (open: boolean) =>
  scene()
    .chain('trip', 'root', 'I’m planning a five-day trip to…')
    .add('brief', { chain: 'trip', on: null, label: 'I’m planning a five-day trip to…', request: LIVE_BRIEF, answer: LIVE_BRIEF_ANSWER })
    .chain('A', 'fork', 'Suggest neighborhoods to stay in')
    .add('A', {
      chain: 'A',
      on: 'brief',
      label: 'Suggest neighborhoods to stay in',
      request: 'Suggest neighborhoods to stay in',
      consumed: ['brief'],
      ...(open ? { answer: 'For five days in November on a moderate budget, three areas', state: 'running' as const } : { answer: LIVE_A_ANSWER }),
    })
    .chain('B', 'fork', 'Suggest rainy-day activities')
    .add('B', {
      chain: 'B',
      on: 'brief',
      label: 'Suggest rainy-day activities',
      request: 'Suggest rainy-day activities',
      consumed: ['brief'],
      ...(open ? { state: 'running' as const } : { answer: LIVE_B_ANSWER }),
    })
    .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open })

const liveTripClosed = liveTrip(false).build()
const liveTripRunning = liveTrip(true).build()

/** The closed trip beside two unrelated answers, so a follow-up has other sections to confuse the referents with. */
const liveMixed = liveTrip(false)
  .chain('sky', 'root', 'Why is the sky blue?')
  .add('S', {
    chain: 'sky',
    on: null,
    label: 'Why is the sky blue?',
    request: 'Why is the sky blue?',
    answer: 'Because of **Rayleigh scattering**. Sunlight is a mix of colours; air molecules scatter the short blue wavelengths far more strongly than the long red ones, so blue light reaches your eyes from every direction of the sky.',
  })
  .chain('menu', 'root', 'Translate this menu into French: soup,…')
  .add('M', {
    chain: 'menu',
    on: null,
    label: 'Translate this menu into French: soup,…',
    request: 'Translate this menu into French: soup, bread, cheese',
    answer: 'Here is the menu in French:\n\n- **Soupe** (soup)\n- **Pain** (bread)\n- **Fromage** (cheese)',
  })
  .build()

/**
 * A long conversation: the closed trip and its itinerary, then more
 * unrelated questions than the pipeline lists (`MAX_SECTIONS` is 24), so
 * the whole trip is older than the window.
 */
const TRIVIA = [
  ['Why is the sky blue?', 'Because of Rayleigh scattering: air scatters short blue wavelengths far more than long red ones.'],
  ['How do vaccines work?', 'They show the immune system a harmless piece or copy of a pathogen so that it learns to recognise the real one.'],
  ['What causes tides?', 'Mostly the Moon’s gravity, which pulls the ocean into two bulges that the Earth rotates through each day.'],
  ['Why do cats purr?', 'Rapid twitching of the laryngeal muscles; cats purr when content, and also to soothe themselves.'],
  ['How does a refrigerator work?', 'A compressor circulates refrigerant that absorbs heat inside as it evaporates and releases it outside as it condenses.'],
  ['What is inflation?', 'A sustained rise in the general price level, which lowers what a unit of money can buy.'],
  ['Why do leaves change color?', 'Chlorophyll breaks down in autumn and unmasks the yellow and orange carotenoids; some trees add red anthocyanins.'],
  ['How do airplanes stay up?', 'The wing deflects air downwards and the air pushes the wing up: lift, which balances weight.'],
  ['What is a black hole?', 'A region where gravity is so strong that nothing, not even light, can escape from inside its event horizon.'],
  ['Why is the sea salty?', 'Rivers carry dissolved minerals from rocks to the sea, and evaporation leaves the salts behind.'],
  ['How does Wi-Fi work?', 'A router and your device exchange data as radio waves, usually in the 2.4 and 5 GHz bands.'],
  ['What is photosynthesis?', 'Plants use light to turn carbon dioxide and water into sugar, releasing oxygen.'],
  ['Why do we yawn?', 'Nobody is certain; the leading idea is that it cools the brain and raises alertness.'],
  ['How are rainbows formed?', 'Sunlight is refracted, reflected inside raindrops and dispersed into its colours.'],
  ['What is the speed of light?', 'About 299,792 kilometres per second in a vacuum.'],
  ['Why do onions make you cry?', 'Cutting them releases a sulphur compound that irritates the eyes, which tear up to wash it away.'],
  ['How do bees make honey?', 'They collect nectar, add enzymes, and fan it in the comb until most of the water has evaporated.'],
  ['What is a prime number?', 'A whole number greater than 1 whose only divisors are 1 and itself.'],
  ['Why does ice float?', 'Water expands as it freezes, so ice is less dense than liquid water.'],
  ['How do magnets work?', 'The magnetic moments of their atoms are aligned, which adds up to a field that attracts or repels.'],
  ['What causes earthquakes?', 'Stress built up along faults between tectonic plates is released suddenly as the rock slips.'],
  ['Why is Pluto not a planet?', 'It has not cleared its orbit of other bodies, one of the three criteria set in 2006.'],
  ['How does GPS work?', 'A receiver times signals from several satellites and solves for its own position.'],
  ['What is DNA?', 'The molecule that carries genetic instructions, as a sequence of four bases along a double helix.'],
  ['Why do we dream?', 'Possibly to consolidate memories and process emotions; there is no settled answer.'],
  ['How do volcanoes form?', 'Magma rises where plates pull apart or one sinks beneath another, and erupts through the crust.'],
] as const

const longConversation = (() => {
  const s = liveTrip(false).add('J', {
    chain: 'trip',
    on: 'jb_G',
    label: 'Use those recommendations to make a…',
    request: 'Use those recommendations to make a five-day itinerary.',
    answer: '**Day 1:** arrive, settle into Gion, evening walk through Pontocho. **Day 2:** Kiyomizu-dera and the Higashiyama lanes. **Day 3 (rain plan):** Kyoto National Museum, then a tea ceremony.',
    consumed: ['brief', 'A', 'B'],
  })
  TRIVIA.forEach(([question, answer], i) => {
    s.chain(`t${i}`, 'root', question).add(`T${i}`, { chain: `t${i}`, on: null, label: question, request: question, answer })
  })
  return s.build()
})()

/**
 * Long runs (docs/build/dependency-decisioning.md · "Long runs"): 200
 * answer sections, far more than the pipeline lists, as one chain that
 * never splits and as 200 unrelated one-answer lines; and a tree whose
 * branches are long runs of only children.
 */
const GUIDE_TOPICS = [
  'the sky being blue',
  'vaccines',
  'tides',
  'cats purring',
  'refrigerators',
  'inflation',
  'autumn leaves',
  'airplanes',
  'black holes',
  'sea salt',
  'Wi-Fi',
  'photosynthesis',
  'yawning',
  'rainbows',
  'the speed of light',
  'onions',
  'honey bees',
  'prime numbers',
  'floating ice',
  'magnets',
  'earthquakes',
  'Pluto',
  'GPS',
  'DNA',
  'dreams',
  'volcanoes',
  'sourdough bread',
  'the stock market',
  'compound interest',
  'chess openings',
  'the Roman Empire',
  'the French Revolution',
  'jazz harmony',
  'guitar tuning',
  'oil painting',
  'watercolor',
  'marathon training',
  'sleep cycles',
  'caffeine',
  'vitamin D',
  'antibiotics',
  'the immune system',
  'blood pressure',
  'cholesterol',
  'solar panels',
  'wind turbines',
  'nuclear fusion',
  'batteries',
  'electric cars',
  'jet engines',
  'sonar',
  'lighthouses',
  'suspension bridges',
  'skyscrapers',
  'concrete',
  'glass making',
  'steel',
  'plastic recycling',
  'composting',
  'coral reefs',
  'rainforests',
  'deserts',
  'glaciers',
  'hurricanes',
  'tornadoes',
  'lightning',
  'fog',
  'the ozone layer',
  'carbon dating',
  'fossils',
  'dinosaurs',
  'mammoths',
  'evolution',
  'bacteria',
  'viruses',
  'mushrooms',
  'yeast',
  'cheese making',
  'wine',
  'coffee roasting',
  'tea',
  'chocolate',
  'spices',
  'knife sharpening',
  'cast iron pans',
  'pressure cookers',
  'microwave ovens',
  'induction stoves',
  'dishwashers',
  'vacuum cleaners',
  'sewing machines',
  'zippers',
  'velcro',
  'ballpoint pens',
  'paper',
  'the printing press',
  'typewriters',
  'keyboards',
  'touch screens',
  'LCD displays',
  'lasers',
  'fiber optics',
  'radio',
  'television',
  'podcasts',
  'search engines',
  'encryption',
  'passwords',
  'blockchains',
  'neural networks',
  'compilers',
  'operating systems',
  'databases',
  'spreadsheets',
  'version control',
  'open source',
  'copyright',
  'patents',
  'trademarks',
  'contracts',
  'juries',
  'elections',
  'parliaments',
  'central banks',
  'taxes',
  'insurance',
  'mortgages',
  'pensions',
  'trade unions',
  'supply chains',
  'container ships',
  'canals',
  'railways',
  'subways',
  'traffic lights',
  'roundabouts',
  'bicycles',
  'helmets',
  'running shoes',
  'tennis rackets',
  'golf balls',
  'the offside rule',
  'cricket',
  'baseball statistics',
  'the Olympics',
  'sumo',
  'origami',
  'bonsai',
  'haiku',
  'sonnets',
  'the novel',
  'film editing',
  'animation',
  'photography',
  'darkrooms',
  'telescopes',
  'microscopes',
  'thermometers',
  'barometers',
  'clocks',
  'calendars',
  'time zones',
  'leap years',
  'the metric system',
  'pi',
  'zero',
  'infinity',
  'probability',
  'statistics',
  'game theory',
  'logic puzzles',
  'sudoku',
  'crosswords',
  'Rubik’s cubes',
  'kites',
  'hot air balloons',
  'parachutes',
  'rockets',
  'satellites',
  'the Moon',
  'Mars',
  'Jupiter',
  'comets',
  'eclipses',
  'auroras',
  'constellations',
  'the Big Bang',
  'dark matter',
  'quantum computers',
  'superconductors',
  'semiconductors',
  'transistors',
  'LEDs',
  'thermostats',
  'heat pumps',
  'insulation',
  'plumbing',
  'septic tanks',
  'wells',
] as const

const guideEntry = (topic: string): string => `**${topic.charAt(0).toUpperCase()}${topic.slice(1)}.** A short entry for the guide: what ${topic} are, how they work in plain words, and one thing a curious reader can try or look for.`

/** One chain: a brief, then 199 entries of a guide, each a follow-up on the same line of work. */
const longChain = (() => {
  const s = scene()
    .chain('guide', 'root', 'I’m writing a pocket guide to…')
    .add('brief', {
      chain: 'guide',
      on: null,
      label: 'I’m writing a pocket guide to…',
      request: 'I’m writing a pocket guide to science and everyday technology for curious teenagers. I’ll name a topic each time; write a short entry for it.',
      answer: 'Happy to help. Name the first topic and I’ll write a short, friendly entry: what it is, how it works, and something to try.',
    })
  GUIDE_TOPICS.forEach((topic, i) => {
    s.add(`E${i}`, { chain: 'guide', on: i === 0 ? 'brief' : `E${i - 1}`, label: `Next entry: ${topic}`, request: `Next entry: ${topic}`, answer: guideEntry(topic) })
  })
  return s.build()
})()

/** The same 199 topics as unrelated questions: every answer is a root. */
const longRoots = (() => {
  const s = scene()
  GUIDE_TOPICS.forEach((topic, i) => {
    const question = `What should I know about ${topic}?`
    s.chain(`r${i}`, 'root', question).add(`R${i}`, { chain: `r${i}`, on: null, label: question, request: question, answer: guideEntry(topic) })
  })
  return s.build()
})()

/** The closed trip and its itinerary, continued day by day on the base chain; the neighborhoods branch into a run about cheaper stays. */
const deepRuns = (() => {
  const s = liveTrip(false).add('J', {
    chain: 'trip',
    on: 'jb_G',
    label: 'Use those recommendations to make a…',
    request: 'Use those recommendations to make a five-day itinerary.',
    answer: '**Day 1:** arrive, settle into Gion, evening walk through Pontocho. **Day 2:** Kiyomizu-dera and the Higashiyama lanes. **Day 3 (rain plan):** Kyoto National Museum, then a tea ceremony.',
    consumed: ['brief', 'A', 'B'],
  })
  const days = [
    'Check in by 15:00, then a slow first evening: Yasaka Shrine at dusk, dinner on Pontocho, an early night.',
    'An early start at Kiyomizu-dera, the Sannenzaka lanes before the crowds, lunch near Kodai-ji, Philosopher’s Path in the afternoon.',
    'The rain plan: Kyoto National Museum in the morning, Nishiki Market for lunch, a tea ceremony in Gion at four.',
    'A day trip: Fushimi Inari at sunrise, sake tasting in Fushimi, back for an evening in Kawaramachi.',
    'Arashiyama: the bamboo grove early, Tenryu-ji, the river, and a last dinner near the station.',
  ]
  days.forEach((answer, i) => {
    s.add(`D${i + 1}`, { chain: 'trip', on: i === 0 ? 'J' : `D${i}`, label: `Plan day ${i + 1} hour by hour`, request: `Plan day ${i + 1} hour by hour`, answer })
  })
  s.chain('stay', 'branch', 'Which of those is cheapest?')
  const stays: readonly (readonly [string, string])[] = [
    ['Which of those is cheapest?', 'The Kyoto Station area: business hotels there run well below Gion prices in November.'],
    ['Find hostels around there', 'Three well-reviewed hostels within ten minutes of the station, each with private rooms as well as dorms.'],
    ['Any capsule hotels?', 'Yes: two capsule hotels near the station and one in Kawaramachi, all with luggage storage.'],
    ['Compare their prices for November', 'Hostel dorms are the cheapest, capsules next, private hostel rooms about the price of a business hotel.'],
  ]
  stays.forEach(([request, answer], i) => {
    s.add(`H${i + 1}`, { chain: 'stay', on: i === 0 ? 'A' : `H${i}`, label: request, request, answer })
  })
  return s.build()
})()

// ───────────────────────────── examples ─────────────────────────────

const SKY_MENU = 'Explain why the sky is blue, and separately translate this menu into French: soup, bread. Keep both accessible to a beginner.'
const SUMMARY_MENU = 'Summarize that recommendation and separately translate this menu: soup, bread'
const SUMMARY_MENU_FIRST = 'Summarize that recommendation and separately translate this menu: soup, bread, but put the translation first'
const SUMMARY_MENU_TOTAL = 'Summarize that recommendation and translate this menu: soup, bread. Keep both answers under 100 words total.'
const BCJ = 'Suggest rainy-day activities, suggest evening activities, and then make an itinerary from the neighborhoods and both of those'

export const ROUTING_CORPUS: readonly CorpusExample[] = [
  // ── targets ──
  {
    id: 'target-single-recent',
    covers: ['targets'],
    note: '05: "Make that shorter" with one recent answer: the target is inferred.',
    scene: sky,
    text: 'Make that shorter',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['S'], placement: { continue: 'S' } }] },
  },
  {
    id: 'target-ambiguous-shorter',
    covers: ['targets'],
    note: '05 edge case: "Make that shorter" with several recent answers and no clear one: the user picks among the candidate sections.',
    scene: twoAnswers,
    text: 'Make that shorter',
    expect: { outcome: 'target-ambiguity', ambiguous: ['S', 'M'] },
  },
  {
    id: 'target-ambiguous-use-that-one',
    covers: ['targets'],
    note: '05 edge case: "Use that one" with several possible referents: ask, never assume from topic similarity.',
    scene: twoAnswers,
    text: 'Use that one',
    expect: { outcome: 'target-ambiguity', ambiguous: ['S', 'M'] },
  },
  {
    id: 'target-join-lines-instead-of-asking',
    covers: ['targets', 'placement'],
    note: '05 "Joining instead of asking": no section is a clear target, and the message brings two lines of work together, so "which one?" has no answer: the lines are joined. S is read through O, which continues it.',
    scene: cityAndSky,
    text: 'Tell me about the ocean and sky in kyoto',
    expect: { composition: 'atomic', joinsLines: true, parts: [{ kind: 'unit', relation: 'addition', targets: ['K', 'S', 'O'], placement: { join: ['K', 'O'] } }] },
  },
  {
    id: 'target-explicit',
    covers: ['targets', 'placement'],
    note: 'T1: an explicit reply target resolves to its own section, whatever else is recent.',
    scene: twoAnswers,
    text: 'Make it shorter',
    replyTo: ['M'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['M'], placement: { continue: 'M' } }] },
  },
  {
    id: 'target-both-sections-of-composite',
    covers: ['targets', 'placement'],
    note: 'T1, 05 edge case: an untargeted follow-up that plainly addresses two sections of one composite answer targets both.',
    scene: compositeAnswer,
    text: 'Make both of those answers simpler',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['S', 'M'], placement: { join: ['S', 'M'] } }] },
  },
  {
    id: 'target-explicit-question-answer',
    covers: ['targets', 'clarification'],
    note: 'Q98: a reply targeted at a clarification question is its answer.',
    scene: questionOpen,
    text: 'The office fire drill',
    replyTo: ['Q'],
    expect: { composition: 'atomic', answers: 'Q', parts: [] },
  },
  {
    id: 'target-inferred-question-answer',
    covers: ['targets', 'clarification'],
    note: 'Q98: an untargeted message may be recognised as the answer to the open question.',
    scene: questionOpen,
    text: 'I meant the fire drill at the office',
    expect: { composition: 'atomic', answers: 'Q', parts: [] },
  },
  {
    id: 'target-later-in-answer',
    covers: ['targets', 'placement'],
    note: 'The referent is identifiable only from a part of its answer far below the opening: three answers about Kyoto, and only the history has a section on the city today. Shown only openings, the question about the history answer cannot see it.',
    scene: kyotoTopics,
    text: 'What are the problems of modern Kyoto you mentioned, and how is the city dealing with them?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['H'], placement: { continue: 'H' } }] },
  },
  // ── placement ──
  {
    id: 'placement-first-message',
    covers: ['placement'],
    note: '01: the first message of a conversation starts a new chain.',
    scene: empty,
    text: 'Why is the sky blue?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'placement-unrelated',
    covers: ['placement'],
    note: '05: new independent work with no relation to existing work: a new chain.',
    scene: tripBrief,
    text: 'Explain how volcanoes form',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'placement-continue-chain',
    covers: ['placement'],
    note: '01: related work continues the chain it builds on.',
    scene: tripBrief,
    text: 'What should I pack for that trip?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['brief'], placement: { continue: 'brief' } }] },
  },
  {
    id: 'placement-fork-while-running',
    covers: ['placement', 'dependencies'],
    note: '04: B sent while A runs on the trip chain builds on the brief and becomes a fork beside A; it does not wait for A.',
    scene: tripOneRunning,
    text: 'Also suggest rainy-day activities for the trip',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', chain: 'trip', placement: { continue: 'brief' }, prerequisites: [] }] },
  },
  {
    id: 'placement-join-back',
    covers: ['placement'],
    note: '04, C19: work needing both siblings continues from their join-back, on the base chain.',
    scene: tripClosed,
    text: 'Use the neighborhoods and the activities to make a five-day itinerary',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: [] }] },
  },
  {
    id: 'placement-branch-from-sibling',
    covers: ['placement'],
    note: '04 step 5, C8: a reply to B alone branches from B and does not import A.',
    scene: tripClosed,
    text: 'Give me three cheaper alternatives',
    replyTo: ['B'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['B'], placement: { continue: 'B' } }] },
  },
  {
    id: 'placement-join-chain-separate-trees',
    covers: ['placement'],
    note: '05: work across diverged lines (the itinerary and the sky explanation) is a join chain.',
    scene: tripDone,
    text: 'Compare the itinerary with the sky explanation',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['J', 'S'], placement: { join: ['J', 'S'] } }] },
  },
  {
    id: 'placement-join-chain-cousins',
    covers: ['placement'],
    note: '04 edge case: a request needing both J and the B-only branch is a join chain over those two leaves.',
    scene: tripBranch,
    text: 'Fit the cheaper alternatives into the itinerary',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['J', 'B2'], placement: { join: ['J', 'B2'] } }] },
  },
  {
    id: 'placement-additional-not-revision',
    covers: ['placement', 'revision'],
    note: '06 edge case: "Also give me luxury options" as a reply to A is not a revision; it builds on A and A stays current.',
    scene: tripClosed,
    text: 'Also give me luxury options',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A'], placement: { continue: 'A' } }] },
  },
  // ── dependencies ──
  {
    id: 'dependency-expand-running',
    covers: ['dependencies'],
    note: '05: "Expand the recommendation you are preparing" needs a result not yet available: result-dependent.',
    scene: recommendationRunning,
    text: 'Expand the recommendation you are preparing',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] }] },
  },
  {
    id: 'dependency-unrelated-runs-now',
    covers: ['dependencies', 'placement'],
    note: '05, C1: unrelated work runs at once on its own chain while a long answer streams.',
    scene: recommendationRunning,
    text: 'Translate "good morning" into French',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] }] },
  },
  {
    id: 'dependency-topic-is-not-dependency',
    covers: ['dependencies'],
    note: 'Q2, 04: shared subject matter is not a result dependency; a general question about Macs and PCs can be answered without the pending recommendation.',
    scene: recommendationRunning,
    text: 'In general, are Macs or PCs cheaper?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', prerequisites: [] }] },
  },
  {
    id: 'dependency-full-group',
    covers: ['dependencies', 'placement'],
    note: 'Q30, C9: work needing both running siblings waits for their full join-back.',
    scene: tripRunning,
    text: 'Make an itinerary from the neighborhoods and the activities',
    expect: {
      composition: 'atomic',
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: ['group:G'] }],
    },
  },
  {
    id: 'dependency-one-sibling',
    covers: ['dependencies', 'placement'],
    note: '01: a request that consumes one member’s result is that member’s descendant, and waits for it alone.',
    scene: tripRunning,
    text: 'Expand the neighborhoods you are preparing',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A'], placement: { continue: 'A' }, prerequisites: ['A'] }] },
  },
  // ── revision versus addition ──
  {
    id: 'revision-actually',
    covers: ['revision'],
    note: '06: "Actually, use a luxury budget for the neighborhood recommendations" corrects A only.',
    scene: tripClosed,
    text: 'Actually, use a luxury budget for the neighborhood recommendations',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['A'] }] },
  },
  {
    id: 'revision-inferred-target',
    covers: ['revision', 'targets'],
    note: '05: corrective wording ("No, … instead") with one clear referent revises it.',
    scene: sky,
    text: 'No, explain it for a five-year-old instead',
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['S'] }] },
  },
  {
    id: 'revision-unclear-is-addition',
    covers: ['revision'],
    note: '05 edge case: ambiguous between correcting and adding: additional work, and the target stays current.',
    scene: tripClosed,
    text: 'What about some luxury places?',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A'], placement: { continue: 'A' } }] },
  },
  {
    id: 'revision-shared-brief',
    covers: ['revision'],
    note: '06: "Actually, the trip is four days, not five" changes the brief A, B and J consumed; J is the work judged actually affected (Q44).',
    scene: tripDone,
    text: 'Actually, the trip is four days, not five',
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'shared-requirement', targets: ['brief'], affected: ['J'] }] },
  },
  {
    id: 'revision-queued-work',
    covers: ['revision'],
    note: '06 edge case: revising J while it is still queued is a revision of J.',
    scene: tripQueuedJ,
    text: 'Actually, make the itinerary three days',
    replyTo: ['J'],
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['J'] }] },
  },
  {
    id: 'revision-session-requirement',
    covers: ['revision', 'requirements'],
    note: 'Q17: a correction to a conversation-wide requirement replaces it.',
    scene: session,
    text: 'Actually, from now on keep answers under 200 words',
    decomposition: {
      fragments: [
        {
          part: 'Actually, from now on keep answers under 200 words',
          instruction: 'Keep answers under 200 words from now on.',
          label: 'answer length',
          requirements: [{ text: 'Keep every answer under 200 words', part: 'keep answers under 200 words', scope: 'session-wide' }],
        },
      ],
    },
    expect: { composition: 'atomic', sessionWide: true, parts: [{ kind: 'revision', scope: 'shared-requirement', targets: [], requirements: ['R1'] }] },
  },
  // ── splits ──
  {
    id: 'split-atomic-related-topics',
    covers: ['splits'],
    note: '02: tightly related topics for one audience stay atomic.',
    scene: empty,
    text: 'Explain caching and indexes for beginners',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'split-atomic-contrast',
    covers: ['splits'],
    note: '02: a requested contrast is one integrated output.',
    scene: empty,
    text: 'Compare Python and Go for writing web servers',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'split-independent',
    covers: ['splits', 'requirements'],
    note: '02: two independent intents with a shared requirement: one reply group, the requirement on both.',
    scene: empty,
    text: SKY_MENU,
    decomposition: {
      fragments: [
        { part: 'Explain why the sky is blue', instruction: 'Explain why the sky is blue.', label: 'sky', requirements: [{ text: 'Keep it accessible to a beginner', part: 'Keep both accessible to a beginner' }] },
        { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread.', label: 'menu translation', requirements: [{ text: 'Keep it accessible to a beginner', part: 'Keep both accessible to a beginner' }] },
      ],
    },
    expect: {
      composition: 'independent-composite',
      sessionWide: false,
      parts: [
        { kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false },
        { kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false },
      ],
    },
  },
  {
    id: 'split-sequential',
    covers: ['splits', 'dependencies'],
    note: 'Q53: a later part needs an earlier part’s result: split messages, in dependency order.',
    scene: empty,
    text: 'Find three good neighborhoods in Kyoto, then make a two-day plan around the best one',
    decomposition: {
      fragments: [
        { part: 'Find three good neighborhoods in Kyoto', instruction: 'Find three good neighborhoods in Kyoto.', label: 'neighborhoods' },
        { part: 'make a two-day plan around the best one', instruction: 'Make a two-day plan around the best of the neighborhoods found.', label: 'two-day plan', after: [0] },
      ],
    },
    expect: {
      composition: 'sequential-composite',
      order: [0, 1],
      parts: [
        { kind: 'unit', relation: 'new', placement: 'new-chain' },
        { kind: 'unit', relation: 'result-dependent', placement: { continue: 'part:0' }, prerequisites: ['part:0'], after: [0] },
      ],
    },
  },
  {
    id: 'split-ready-and-blocked',
    covers: ['splits', 'dependencies'],
    note: 'D2, 02 edge case: the translation runs now; the summary of the recommendation in flight is dependency-queued.',
    scene: recommendationRunning,
    text: SUMMARY_MENU,
    decomposition: {
      fragments: [
        { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
        { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      barrier: false,
      parts: [
        { kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] },
        { kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] },
      ],
    },
  },
  {
    id: 'split-output-order-barrier',
    covers: ['splits', 'dependencies'],
    note: 'D3, Q19: "put the translation first" relates the outputs, so the whole request waits.',
    scene: recommendationRunning,
    text: SUMMARY_MENU_FIRST,
    decomposition: {
      fragments: [
        { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
        { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
      ],
      barrier: { reason: 'explicit-order', qualifier: 'put the translation first' },
      outputOrder: [1, 0],
    },
    expect: {
      composition: 'independent-composite',
      barrier: true,
      parts: [
        { kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] },
        { kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] },
      ],
    },
  },
  {
    id: 'combined-limit-atomic',
    covers: ['splits', 'dependencies'],
    note: 'D5, Q102: "under 100 words total" is one combined limit, so the separable summary and translation stay one request, not decomposed; it needs the recommendation in flight, so the whole request waits for it.',
    scene: recommendationRunning,
    text: SUMMARY_MENU_TOTAL,
    expect: {
      composition: 'atomic',
      combinedLimit: true,
      decomposed: false,
      barrier: false,
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] }],
    },
  },
  {
    id: 'combined-limit-atomic-new',
    covers: ['splits'],
    note: 'D5, Q102: two separable explanations under one total limit are one request, answered by one directive that carries the limit.',
    scene: empty,
    text: 'Explain photosynthesis and explain gravity, under 100 words total',
    expect: { composition: 'atomic', combinedLimit: true, decomposed: false, parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'split-per-part-limit-no-barrier',
    covers: ['splits'],
    note: 'D5, Q25, Q102: a requirement applied to each part separately ("each under 100 words") neither keeps the message atomic nor makes a barrier.',
    scene: empty,
    text: 'Explain photosynthesis and explain gravity, each answer under 100 words',
    decomposition: {
      fragments: [
        { part: 'Explain photosynthesis', instruction: 'Explain photosynthesis.', label: 'photosynthesis', requirements: [{ text: 'Under 100 words', part: 'each answer under 100 words' }] },
        { part: 'explain gravity', instruction: 'Explain gravity.', label: 'gravity', requirements: [{ text: 'Under 100 words', part: 'each answer under 100 words' }] },
      ],
    },
    expect: { composition: 'independent-composite', combinedLimit: false, decomposed: true, barrier: false, parts: [{ kind: 'unit', relation: 'new' }, { kind: 'unit', relation: 'new' }] },
  },
  {
    id: 'split-topological-order',
    covers: ['splits', 'dependencies', 'placement'],
    note: '02: with A already sent and one message asking for B, C and J (J needs A, B and C), the split messages appear as B, C, J.',
    scene: tripOneRunning,
    text: BCJ,
    decomposition: {
      fragments: [
        { part: 'Suggest rainy-day activities', instruction: 'Suggest rainy-day activities for the trip.', label: 'activities' },
        { part: 'suggest evening activities', instruction: 'Suggest evening activities for the trip.', label: 'evening activities' },
        {
          part: 'make an itinerary from the neighborhoods and both of those',
          instruction: 'Make an itinerary from the neighborhoods, the rainy-day activities and the evening activities.',
          label: 'itinerary',
          after: [0, 1],
        },
      ],
    },
    expect: {
      composition: 'sequential-composite',
      order: [0, 1, 2],
      parts: [
        { kind: 'unit', relation: 'addition', chain: 'trip', placement: { continue: 'brief' }, prerequisites: [] },
        { kind: 'unit', relation: 'addition', chain: 'trip', placement: { continue: 'brief' }, prerequisites: [] },
        { kind: 'unit', relation: 'result-dependent', targets: ['A'], placement: { join: ['A', 'part:0', 'part:1'] }, prerequisites: ['A', 'part:0', 'part:1'], after: [0, 1] },
      ],
    },
  },
  {
    id: 'split-correction-and-new-work',
    covers: ['splits', 'revision'],
    note: 'PLAN §2: a composite with one corrective fragment and one new fragment: a revision beside a unit, not grouped.',
    scene: tripClosed,
    text: 'Actually use a luxury budget for the neighborhoods, and also suggest some day trips',
    decomposition: {
      fragments: [
        { part: 'Actually use a luxury budget for the neighborhoods', instruction: 'Use a luxury budget for the neighborhood recommendations.', label: 'luxury neighborhoods' },
        { part: 'also suggest some day trips', instruction: 'Suggest some day trips from Kyoto.', label: 'day trips' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      parts: [
        { kind: 'revision', scope: 'work', targets: ['A'] },
        { kind: 'unit', relation: 'addition', chain: 'trip', placement: { continue: 'group:G' } },
      ],
    },
  },
  // ── clarification ──
  {
    id: 'clarification-missing',
    covers: ['clarification'],
    note: 'E2: a consequential missing preference elicits a clarification.',
    scene: empty,
    text: 'Recommend a hotel near the conference',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: 'missing-information' }] },
  },
  {
    id: 'clarification-incompatible',
    covers: ['clarification'],
    note: 'E2: incompatible user requirements elicit a clarification.',
    scene: empty,
    text: 'Write a 50-word summary of the Roman Empire that covers every emperor in detail',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: 'incompatible-requirements' }] },
  },
  {
    id: 'clarification-not-needed',
    covers: ['clarification'],
    note: 'Q34: ordinary vagueness that a sensible default resolves needs no question.',
    scene: empty,
    text: 'Recommend a good book for a long flight',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false }] },
  },
  {
    id: 'clarification-one-part',
    covers: ['clarification', 'splits'],
    note: '02 edge case: the translation is answered at once; only the unclear explanation waits for a question.',
    scene: empty,
    text: 'Translate this menu into French: soup, bread, and explain what happened yesterday',
    decomposition: {
      fragments: [
        { part: 'Translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread.', label: 'menu translation' },
        { part: 'explain what happened yesterday', instruction: 'Explain what happened yesterday.', label: 'yesterday' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      parts: [
        { kind: 'unit', relation: 'new', clarification: false },
        { kind: 'unit', relation: 'new', clarification: 'missing-information' },
      ],
    },
  },
  {
    id: 'clarification-shared-requirement',
    covers: ['clarification', 'requirements'],
    note: '07: an ambiguous shared requirement blocks every fragment it applies to and is asked once.',
    scene: empty,
    text: 'Suggest a hotel and a restaurant, both near the venue',
    decomposition: {
      fragments: [
        { part: 'Suggest a hotel', instruction: 'Suggest a hotel.', label: 'hotel', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
        { part: 'a restaurant', instruction: 'Suggest a restaurant.', label: 'restaurant', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
      ],
    },
    expect: { composition: 'independent-composite', sharedClarification: true, parts: [{ kind: 'unit', relation: 'new' }, { kind: 'unit', relation: 'new' }] },
  },
  // ── requirement scope ──
  {
    id: 'requirements-local-brevity',
    covers: ['requirements'],
    note: 'D1: a local brevity instruction does not become a conversation-wide preference.',
    scene: sky,
    text: 'Explain rainbows briefly',
    expect: { composition: 'atomic', sessionWide: false, parts: [{ kind: 'unit' }] },
  },
  {
    id: 'requirements-session-wide',
    covers: ['requirements'],
    note: 'Q17: "from now on" makes a requirement conversation-wide.',
    scene: empty,
    text: 'From now on, keep every answer under 100 words. Why is the sky blue?',
    decomposition: {
      fragments: [
        {
          part: 'Why is the sky blue?',
          instruction: 'Why is the sky blue?',
          label: 'sky',
          requirements: [{ text: 'Keep every answer under 100 words', part: 'keep every answer under 100 words', scope: 'session-wide' }],
        },
      ],
    },
    expect: { composition: 'atomic', sessionWide: true, parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  // ── referents with live-style titles (docs/build/dependency-decisioning.md) ──
  {
    id: 'live-j-those-recommendations',
    covers: ['placement', 'targets'],
    note: '04, the running example’s J ("Use those recommendations to make a five-day itinerary."), C19: it needs both siblings, so it continues from their join-back and reads every member.',
    scene: liveTripClosed,
    text: 'Use those recommendations to make a five-day itinerary.',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: [] }] },
  },
  {
    id: 'live-j-named',
    covers: ['placement', 'targets'],
    note: '01, C19: J names the neighborhoods and the activities; it is a child of both siblings through their join-back, on the base chain.',
    scene: liveTripClosed,
    text: 'Make an itinerary from the neighborhoods and the activities',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: [] }] },
  },
  {
    id: 'live-j-those-recommendations-running',
    covers: ['dependencies', 'placement'],
    note: '04 edge case "J is requested while B is still streaming", Q30, C9, C15: J waits for the whole group, never for one member.',
    scene: liveTripRunning,
    text: 'Use those recommendations to make a five-day itinerary.',
    expect: {
      composition: 'atomic',
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: ['group:G'] }],
    },
  },
  {
    id: 'live-j-named-running',
    covers: ['dependencies', 'placement'],
    note: 'Q30, C9: work needing both running siblings depends on their full join-back.',
    scene: liveTripRunning,
    text: 'Make an itinerary from the neighborhoods and the activities',
    expect: {
      composition: 'atomic',
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: ['group:G'] }],
    },
  },
  {
    id: 'live-j-among-other-answers',
    covers: ['placement', 'targets'],
    note: '01, C19: with unrelated answers in the conversation, J still refers to both siblings and to nothing else.',
    scene: liveMixed,
    text: 'Use those recommendations to make a five-day itinerary.',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: [] }] },
  },
  {
    id: 'live-two-sections-siblings',
    covers: ['targets', 'placement'],
    note: '05: "Compare the two answers" about two siblings of one group is work on their join-back, not a join chain. The follow-up names both sections; both are inferred.',
    scene: liveMixed,
    text: 'Compare the neighborhoods answer with the rainy-day activities answer',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' } }] },
  },
  {
    id: 'live-two-sections-separate-trees',
    covers: ['targets', 'placement'],
    note: 'Q20, 05: a follow-up that names two sections of separate trees has both inferred and is a join chain over their leaves (Q86).',
    scene: liveMixed,
    text: 'Put the sky explanation and the menu translation into one handout',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['S', 'M'], placement: { join: ['S', 'M'] } }] },
  },
  {
    id: 'live-one-sibling-only',
    covers: ['targets', 'placement'],
    note: '01: a reply to one sibling branches from that sibling; the group as a whole is not what it refers to.',
    scene: liveMixed,
    text: 'Expand the neighborhoods answer with one more option',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A'], placement: { continue: 'A' } }] },
  },
  {
    id: 'live-referent-beyond-window',
    covers: ['targets', 'placement'],
    note: '05, Q20: the itinerary is the target however long ago it was written. It is older than the 24 sections the pipeline lists, so only a strategy that walks the context tree can find it.',
    scene: longConversation,
    text: 'Swap days 2 and 3 of the Kyoto itinerary',
    beyondWindow: true,
    below: ['brief'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['J'], placement: { continue: 'J' } }] },
  },
  {
    id: 'live-unrelated-in-long-conversation',
    covers: ['placement'],
    note: '05: unrelated new work in a long conversation starts a new chain; nothing is walked into.',
    scene: longConversation,
    text: 'How do submarines dive and surface?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'live-unrelated-among-many',
    covers: ['placement'],
    note: '05: new work unrelated to everything in the conversation starts a new chain; no line of work is walked into.',
    scene: liveMixed,
    text: 'Explain how volcanoes form',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  // ── long runs (docs/build/dependency-decisioning.md · "Long runs") ──
  {
    id: 'long-chain-old-section',
    covers: ['targets', 'placement'],
    note: '05, Q20: the entry on tides is the target although 190 sections were written after it on the same chain. Only a strategy that reaches beyond the pipeline\u2019s window can find it.',
    scene: longChain,
    text: 'Make the entry on tides shorter',
    beyondWindow: true,
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['E2'], placement: { continue: 'E2' } }] },
    hop: {
      note: '11 · hop between branch points, DA3: the chain never splits, so it is one unbranched run of 200 sections (a trunk). The unit refers to it (E2 is in it) and to nothing built on it (it has nothing below it), and is not a correction: it is placed on the run’s last section, whose context holds E2.',
      parts: [{ kind: 'unit', targets: ['E198'], placement: { continue: 'E198' } }],
    },
  },
  {
    id: 'long-chain-latest-section',
    covers: ['targets', 'placement'],
    note: '05 edge case "Make that shorter": in a long chain a reply to the latest answer continues from the tip, whether the section is inferred as its target or the line is chosen as its handling chain.',
    scene: longChain,
    text: 'Make that last entry about wool a bit longer',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', chain: 'guide', placement: { continue: 'E198' } }] },
  },
  {
    id: 'long-chain-unrelated',
    covers: ['placement'],
    note: '05: new work unrelated to a 200-section chain starts a new chain.',
    scene: longChain,
    text: 'What is the capital of Australia?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'long-roots-old-section',
    covers: ['targets', 'placement'],
    note: '05, Q20: one of 199 unrelated answers, far older than the window, is the target; the reply continues that line.',
    scene: longRoots,
    text: 'Go back to the answer about honey bees and add a diagram',
    beyondWindow: true,
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['R16'], placement: { continue: 'R16' } }] },
  },
  {
    id: 'deep-run-middle-section',
    covers: ['targets', 'placement'],
    note: '05: a reply to a section in the middle of a run of only children targets that section, not the end of the run; the work branches from it.',
    scene: deepRuns,
    text: 'Make the day 2 plan less packed',
    below: ['brief'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['D2'], placement: { continue: 'D2' } }] },
    hop: {
      note: '11 · hop between branch points, DA3: the itinerary and the day plans (J, D1 to D5) are one unbranched run below the join-back; the unit refers to it (D2) and to nothing built on it (D5 is a leaf), and D3 and D4 are not asked about by themselves: it is placed on the run’s last section, D5. Not reached without a candidate source (`below`), as with the switch off.',
      parts: [{ kind: 'unit', targets: ['D5'], placement: { continue: 'D5' } }],
    },
  },
  {
    id: 'deep-run-end-section',
    covers: ['targets', 'placement'],
    note: '05: a reply to the last section of a run continues from it.',
    scene: deepRuns,
    text: 'Add a farewell dinner to the day 5 plan',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['D5'], placement: { continue: 'D5' } }] },
  },
  {
    id: 'deep-run-other-branch',
    covers: ['targets', 'placement'],
    note: '05: a reply to a section inside the other branch\u2019s run targets it; the day plans are not walked into for it.',
    scene: deepRuns,
    text: 'Which of those hostels has private rooms with a bathroom?',
    below: ['brief'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', targets: ['H2'], placement: { continue: 'H2' } }] },
    hop: {
      note: '11 · hop between branch points, DA3: the cheaper stays (H1 to H4) are one unbranched run below A, a member of a sibling group (A does not count for the run). The unit refers to it (H2) and to nothing built on it (H4 is a leaf), and H3 is not asked about by itself: it is placed on the run’s last section, H4. Not reached without a candidate source (`below`), as with the switch off.',
      parts: [{ kind: 'unit', targets: ['H4'], placement: { continue: 'H4' } }],
    },
  },
]
