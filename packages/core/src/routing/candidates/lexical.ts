import type { ConversationId, SectionId } from '@pluribus/protocol'
import type { CandidateHit, CandidateQuery, CandidateSection, CandidateSource } from '../../ports'

/**
 * The lexical candidate source: a word index over the conversation's answer
 * sections, ranked BM25-style against the text of a unit.
 *
 * What it returns are seed hints: places a tree walk starts at besides the
 * roots. It confirms nothing, scores nothing that routing reads, and is not
 * the Estimate operation. A section it names is asked about by itself like
 * any other, and only that Point can make it a referent (DA3).
 *
 * Pure and deterministic: no clock, no randomness, no I/O. The same
 * sections and text give the same candidates in the same order, whether the
 * index was built at once or brought up to date section by section.
 */

// ───────────────────────────── words ─────────────────────────────

/**
 * Words that say nothing about which section is meant: English function
 * words, the pieces contractions leave behind, and the words of an
 * instruction that name the change and not its subject ("make that
 * shorter", "combine both"). A message made only of these has no words to
 * look up and gets no candidates.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  [
    // Function words.
    'a an the this that these those it its they them their there here one ones',
    'i me my we us our you your he she his her him',
    'is are was were be been being am do does did done doing have has had having',
    'will would can could should shall may might must',
    'and or but nor so yet if then than as of at by for from in into on onto to with without about over under',
    'up down out off above below between through after before again once',
    'not no yes too very just also only even still',
    'what which who whom whose when where why how',
    'some any all each every both either neither few many much most other another such same own',
    's t d m ll re ve don doesn didn isn aren wasn weren won wouldn couldn shouldn',
    'please thanks thank ok okay hi hello hey',
    // Words that name the change, not its subject.
    'make made give get go back let take put use using want need like know tell say see look show try',
    'add change edit rewrite redo revise update fix improve combine merge join',
    'short shorter shorten long longer lengthen more less bit little lot',
    'better simpler clearer different new now instead answer answers reply section sections part parts thing things',
  ]
    .join(' ')
    .split(' '),
)

/** Scripts written without spaces between words: a run of them is indexed as overlapping pairs of characters. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu
const WORD = /[\p{L}\p{N}\p{M}]+/gu
const ASCII_WORD = /^[a-z]+$/
const NON_ASCII = /[^\x00-\x7f]/

/** Folds an English plural onto its singular: "hostels" and "hostel", "entries" and "entry" are one word. Nothing else is stemmed. */
function singular(word: string): string {
  if (word.length <= 3 || !word.endsWith('s') || !ASCII_WORD.test(word)) return word
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (SIBILANT_PLURAL.test(word)) return word.slice(0, -2)
  if (NOT_A_PLURAL.test(word)) return word
  return word.slice(0, -1)
}
const SIBILANT_PLURAL = /(ss|x|z|ch|sh)es$/
const NOT_A_PLURAL = /(ss|us|is)$/

/**
 * The words of a text as they are indexed and looked up, in order, stop
 * words left out.
 *
 * - Compatibility forms are folded (NFKC) and case is lowered. Accents are
 *   kept: "café" and "cafe" are two words.
 * - A word is a run of letters, digits and combining marks in any script,
 *   so text in any language written with spaces is split into its words. A
 *   number is a word ("day 2").
 * - Chinese, Japanese, Thai, Lao, Khmer and Burmese are written without
 *   spaces: a run in those scripts is indexed as its overlapping pairs of
 *   characters, the usual stand-in for word segmentation.
 * - The stop list and the plural folding are English only. In another
 *   language every word counts, and a word common to the whole conversation
 *   weighs little because of how often it occurs, not because it is listed.
 */
export function lexicalTerms(text: string): string[] {
  const out: string[] = []
  eachTerm(text, (term) => out.push(term))
  return out
}

function eachTerm(text: string, emit: (term: string) => void): void {
  // Plain ASCII, which most text is, needs neither folding nor a look at scripts: one pass over its characters.
  if (!NON_ASCII.test(text)) {
    const lower = text.toLowerCase()
    let start = -1
    for (let i = 0; i <= lower.length; i++) {
      const c = i < lower.length ? lower.charCodeAt(i) : 0
      const inWord = (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      if (inWord) {
        if (start < 0) start = i
      } else if (start >= 0) {
        emitWord(lower.slice(start, i), emit)
        start = -1
      }
    }
    return
  }
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(WORD)) {
    const word = match[0]
    if (!NON_ASCII.test(word)) {
      emitWord(word, emit)
      continue
    }
    let at = 0
    for (const run of word.matchAll(UNSPACED)) {
      if (run.index > at) emitWord(word.slice(at, run.index), emit)
      const chars = [...run[0]]
      if (chars.length === 1) emit(run[0])
      for (let i = 0; i + 1 < chars.length; i++) emit(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`)
      at = run.index + run[0].length
    }
    if (at < word.length) emitWord(word.slice(at), emit)
  }
}

function emitWord(word: string, emit: (term: string) => void): void {
  if (STOP_WORDS.has(word)) return
  const folded = singular(word)
  if (folded === word || !STOP_WORDS.has(folded)) emit(folded)
}

// ───────────────────────────── the index ─────────────────────────────

/** What one answer section is indexed from. */
export interface LexicalDocument {
  readonly sectionId: SectionId
  readonly title: string
  /** The request the section answers. */
  readonly request: string
  /** The answer text so far. */
  readonly answer: string
}

export interface LexicalHit {
  readonly sectionId: SectionId
  /** The BM25 score of the section for the text. */
  readonly score: number
  /** The score as a share of the weight of the text's words: what `minShare` is compared with. */
  readonly share: number
}

export interface LexicalSearchOptions {
  /** The most hits returned. */
  readonly limit: number
  /** A section whose share is below this is not returned. */
  readonly minShare: number
  /** A section whose score is below this fraction of the best score among the sections that pass `minShare` is not returned. 0 keeps them all. */
  readonly minOfBest?: number
  /** Sections never returned. */
  readonly exclude?: ReadonlySet<SectionId>
}

/** BM25's saturation of repeated words and its correction for length, at their usual values. */
const K1 = 1.2
const B = 0.75
/** A word of the request counts this many times: the request names the subject in the user's own words; the answer is long and names much besides. */
const REQUEST_WEIGHT = 2

interface Entry {
  readonly doc: LexicalDocument
  /** Weighted occurrences by word. */
  readonly terms: ReadonlyMap<string, number>
  /** Weighted number of words. */
  readonly length: number
  /** Position in the conversation, oldest first: the later of two equal scores comes first. */
  position: number
  /** The `sync` that last saw it. */
  seen: number
}

interface Posting {
  readonly entries: Entry[]
  readonly counts: number[]
}

/**
 * An inverted index over answer sections: for each, the words of its title,
 * of the request it answered (counted twice) and of its answer.
 *
 * `sync` brings it up to date with the sections of a conversation and
 * touches only what changed: a section whose title, request and answer are
 * the strings it was indexed from is left alone, so a routing re-reads only
 * the sections written or revised since the one before. `search` reads the
 * postings of the text's words and nothing else.
 */
export class LexicalIndex {
  private readonly entries = new Map<SectionId, Entry>()
  /** By word: the sections it occurs in, each with the word's weighted count there. */
  private readonly postings = new Map<string, Posting>()
  private totalLength = 0
  private generation = 0

  get size(): number {
    return this.entries.size
  }

  /** Makes the index hold exactly these sections, oldest first. */
  sync(documents: Iterable<LexicalDocument>): void {
    this.generation += 1
    let position = 0
    for (const doc of documents) {
      const held = this.entries.get(doc.sectionId)
      if (held && held.doc.title === doc.title && held.doc.request === doc.request && held.doc.answer === doc.answer) {
        held.position = position++
        held.seen = this.generation
        continue
      }
      if (held) this.remove(held)
      this.add(doc, position++)
    }
    if (this.entries.size === position) return
    for (const entry of [...this.entries.values()]) if (entry.seen !== this.generation) this.remove(entry)
  }

  private add(doc: LexicalDocument, position: number): void {
    const terms = new Map<string, number>()
    let length = 0
    const count = (text: string, weight: number): void =>
      eachTerm(text, (term) => {
        terms.set(term, (terms.get(term) ?? 0) + weight)
        length += weight
      })
    count(doc.title, 1)
    count(doc.request, REQUEST_WEIGHT)
    count(doc.answer, 1)
    const entry: Entry = { doc, terms, length, position, seen: this.generation }
    this.entries.set(doc.sectionId, entry)
    this.totalLength += length
    for (const [term, tf] of terms) {
      let posting = this.postings.get(term)
      if (!posting) this.postings.set(term, (posting = { entries: [], counts: [] }))
      posting.entries.push(entry)
      posting.counts.push(tf)
    }
  }

  private remove(entry: Entry): void {
    this.entries.delete(entry.doc.sectionId)
    this.totalLength -= entry.length
    for (const term of entry.terms.keys()) {
      const posting = this.postings.get(term)
      const at = posting ? posting.entries.indexOf(entry) : -1
      if (!posting || at < 0) continue
      posting.entries.splice(at, 1)
      posting.counts.splice(at, 1)
      if (posting.entries.length === 0) this.postings.delete(term)
    }
  }

  /** How much a word tells: more the fewer sections it occurs in. Positive for every word, largest for one that occurs nowhere. */
  private weight(term: string): number {
    const df = this.postings.get(term)?.entries.length ?? 0
    return Math.log(1 + (this.entries.size - df + 0.5) / (df + 0.5))
  }

  /**
   * The sections closest to a text, best first; of equal scores the more
   * recent first.
   *
   * A section's score is BM25 over the distinct words of the text. Its
   * share is that score over the summed weight of all those words, the
   * ones no section contains included: about how much of what the text
   * says is found in the section. A text with no words left after the stop
   * list has no hits.
   */
  search(text: string, options: LexicalSearchOptions): LexicalHit[] {
    const terms = [...new Set(lexicalTerms(text))]
    if (terms.length === 0 || this.entries.size === 0 || options.limit <= 0) return []
    const average = this.totalLength / this.entries.size
    // A section's score is summed word by word in the order of the text, so it does not depend on how the index came about.
    const scores = new Map<Entry, number>()
    let total = 0
    for (const term of terms) {
      const weight = this.weight(term)
      total += weight
      const posting = this.postings.get(term)
      if (!posting) continue
      for (let i = 0; i < posting.entries.length; i++) {
        const entry = posting.entries[i]
        const tf = posting.counts[i]
        if (!entry || tf === undefined) continue
        const norm = average > 0 ? 1 - B + (B * entry.length) / average : 1
        scores.set(entry, (scores.get(entry) ?? 0) + (weight * tf * (K1 + 1)) / (tf + K1 * norm))
      }
    }
    const hits: (LexicalHit & { readonly position: number })[] = []
    for (const [entry, score] of scores) {
      const share = score / total
      if (share < options.minShare) continue
      hits.push({ sectionId: entry.doc.sectionId, score, share, position: entry.position })
    }
    hits.sort((a, b) => b.score - a.score || b.position - a.position)
    // The best is the best of every section that clears the share, an excluded one included: what is left out for
    // being asked anyway still says how close "close" is.
    const floor = (hits[0]?.score ?? 0) * (options.minOfBest ?? 0)
    return hits
      .filter((hit) => hit.score >= floor && !options.exclude?.has(hit.sectionId))
      .slice(0, options.limit)
      .map(({ sectionId, score, share }) => ({ sectionId, score, share }))
  }
}

// ───────────────────────────── the source ─────────────────────────────

/** The source's name in the settings and in the decision record. */
export const LEXICAL_SOURCE_NAME = 'lexical'

/**
 * A section is a candidate when its share of the text's weight is at least
 * this. Chosen on the routing corpus: the section a message names clears it, a section
 * that shares one incidental word with an unrelated message does not.
 */
export const LEXICAL_MIN_SHARE = 0.3

/**
 * A candidate also has to score at least this fraction of the best section
 * for the text. Where one section is clearly meant, the sections that only
 * share its vocabulary (the other days of the same plan) are left out;
 * where several are about equally close, all of them are kept.
 */
export const LEXICAL_MIN_OF_BEST = 0.5

/** The most candidates for one unit: the pipeline's own cap (`MAX_START_CANDIDATES`). */
export const LEXICAL_MAX_CANDIDATES = 12

/** Conversations whose index is kept between routings; the least recently routed is dropped first. */
const KEPT_INDEXES = 8

export interface LexicalSourceOptions {
  readonly minShare?: number
  readonly minOfBest?: number
  readonly limit?: number
}

/**
 * The candidate source over a `LexicalIndex`, one index per conversation,
 * kept between routings and brought up to date at each.
 *
 * - **Query.** The text of the unit: the message, or the instruction of one
 *   part.
 * - **Returned.** The sections whose share is at least `minShare` and whose
 *   score is at least `minOfBest` of the best such section, best first, at
 *   most `limit`. A score recorded with a candidate is the BM25 score;
 *   routing never reads it.
 * - **Left out.** The first-pass sections: every routing asks about each of
 *   them by itself in the routing request, so naming one adds nothing and
 *   would take a place from a section the walk might not reach. Other
 *   sections the routing request lists are kept: a tree walk asks about a
 *   listed section only when it lies on a line it follows.
 * - **Ties.** Equal scores are ordered by recency, the later section first.
 */
export function createLexicalCandidateSource(options: LexicalSourceOptions = {}): CandidateSource {
  const minShare = options.minShare ?? LEXICAL_MIN_SHARE
  const minOfBest = options.minOfBest ?? LEXICAL_MIN_OF_BEST
  const limit = options.limit ?? LEXICAL_MAX_CANDIDATES
  const indexes = new Map<ConversationId, LexicalIndex>()
  const indexFor = (conversationId: ConversationId): LexicalIndex => {
    const held = indexes.get(conversationId)
    const index = held ?? new LexicalIndex()
    // Most recently used last.
    indexes.delete(conversationId)
    indexes.set(conversationId, index)
    if (indexes.size > KEPT_INDEXES) {
      const oldest = indexes.keys().next()
      if (!oldest.done) indexes.delete(oldest.value)
    }
    return index
  }
  return {
    name: LEXICAL_SOURCE_NAME,
    async candidates(query: CandidateQuery): Promise<readonly CandidateHit[]> {
      const index = indexFor(query.conversationId)
      index.sync(documentsOf(query))
      return index.search(query.text, { limit, minShare, minOfBest, exclude: new Set(query.firstPass) }).map(({ sectionId, score }) => ({ sectionId, score }))
    },
  }
}

function* documentsOf(query: CandidateQuery): Generator<LexicalDocument> {
  for (const section of query.sections) yield documentOf(section, query.answerText(section))
}

function documentOf(section: CandidateSection, answer: string): LexicalDocument {
  return { sectionId: section.sectionId, title: section.title, request: section.request, answer }
}
