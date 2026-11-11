import type { EventId, IdFactory, IdKind, IdTypes, Ulid } from './ids'
import { makeId } from './ids'

/**
 * ULID helper. Pure: the time source and the randomness are passed in, so core
 * stays deterministic (no `Date.now()` or `Math.random()` inside it) and tests
 * get reproducible IDs from a fake clock and a seeded generator.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
const MAX_TIME = 2 ** 48 - 1

/** Encodes a millisecond timestamp as the 10-character time part of a ULID. */
export function encodeUlidTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${ms}`)
  }
  let rest = Math.floor(ms)
  let out = ''
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ALPHABET.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/** Millisecond timestamp encoded in a ULID, or in an entity ID that ends with one. */
export function ulidTimestamp(id: string): number {
  const ulid = id.slice(-26)
  if (!isUlid(ulid)) throw new Error(`Not a ULID: "${id}"`)
  let ms = 0
  for (let i = 0; i < TIME_LENGTH; i++) {
    ms = ms * 32 + ALPHABET.indexOf(ulid.charAt(i))
  }
  return ms
}

export function isUlid(value: string): value is Ulid {
  if (value.length !== TIME_LENGTH + RANDOM_LENGTH) return false
  for (let i = 0; i < value.length; i++) {
    if (ALPHABET.indexOf(value.charAt(i)) === -1) return false
  }
  return true
}

/**
 * A monotonic ULID generator: ULIDs minted within the same millisecond (or
 * while the clock stands still or runs backwards) still sort in mint order,
 * because the random part is incremented instead of redrawn.
 *
 * @param now    milliseconds since the epoch
 * @param random uniform in [0, 1), like `Math.random`
 */
export function createUlidFactory(now: () => number, random: () => number): () => Ulid {
  let lastTime = -1
  let lastRandom: number[] = []

  const draw = (): number[] => {
    const digits: number[] = []
    for (let i = 0; i < RANDOM_LENGTH; i++) {
      digits.push(Math.min(31, Math.floor(random() * 32)))
    }
    return digits
  }

  const increment = (digits: readonly number[]): number[] => {
    const next = [...digits]
    for (let i = next.length - 1; i >= 0; i--) {
      const digit = next[i] ?? 0
      if (digit < 31) {
        next[i] = digit + 1
        return next
      }
      next[i] = 0
    }
    // 80 bits overflowed within one millisecond: not reachable in practice.
    throw new Error('ULID randomness overflow')
  }

  return () => {
    const time = Math.floor(now())
    if (time > lastTime) {
      lastTime = time
      lastRandom = draw()
    } else {
      lastRandom = increment(lastRandom)
    }
    let out = encodeUlidTime(lastTime)
    for (const digit of lastRandom) out += ALPHABET.charAt(digit)
    return out as Ulid
  }
}

/** An {@link IdFactory} over a ULID generator. */
export function createIdFactory(nextUlid: () => Ulid): IdFactory {
  return {
    next<K extends IdKind>(kind: K): IdTypes[K] {
      return makeId(kind, nextUlid())
    },
    nextEventId(): EventId {
      return nextUlid() as string as EventId
    },
  }
}

/**
 * Small seeded generator (mulberry32) for deterministic tests and fixtures.
 * Not for anything that needs unpredictability.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
