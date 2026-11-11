import { describe, expect, test } from 'vitest'
import { asId, isId, makeId } from './ids'
import { createIdFactory, createSeededRandom, createUlidFactory, encodeUlidTime, isUlid, ulidTimestamp } from './ulid'

describe('ulid', () => {
  test('encodes the timestamp in the first ten characters and reads it back', () => {
    const next = createUlidFactory(() => 1_762_819_200_000, createSeededRandom(1))
    const id = next()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
    expect(id.slice(0, 10)).toBe(encodeUlidTime(1_762_819_200_000))
    expect(ulidTimestamp(id)).toBe(1_762_819_200_000)
  })

  test('is monotonic within one millisecond and when the clock runs backwards', () => {
    let now = 5_000
    const next = createUlidFactory(() => now, createSeededRandom(7))
    const ids = [next(), next(), next()]
    now = 4_000
    ids.push(next())
    now = 6_000
    ids.push(next())
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('is reproducible from the same clock and seed', () => {
    const a = createUlidFactory(() => 42, createSeededRandom(3))
    const b = createUlidFactory(() => 42, createSeededRandom(3))
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  test('rejects times outside the 48-bit range', () => {
    expect(() => encodeUlidTime(-1)).toThrow(RangeError)
    expect(() => encodeUlidTime(2 ** 48)).toThrow(RangeError)
  })
})

describe('ids', () => {
  test('entity IDs carry their kind prefix and a ULID', () => {
    const ids = createIdFactory(createUlidFactory(() => 1_000, createSeededRandom(9)))
    const message = ids.next('message')
    expect(message.startsWith('msg_')).toBe(true)
    expect(isUlid(message.slice(4))).toBe(true)
    expect(ulidTimestamp(message)).toBe(1_000)
    expect(isId('message', message)).toBe(true)
    expect(isId('section', message)).toBe(false)
    expect(isUlid(ids.nextEventId())).toBe(true)
  })

  test('asId refuses an ID of another kind', () => {
    const ulid = createUlidFactory(() => 1, createSeededRandom(2))()
    const section = makeId('section', ulid)
    expect(asId('section', section)).toBe(section)
    expect(() => asId('message', section)).toThrow(/Expected a message ID/)
  })
})
