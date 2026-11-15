import { describe, expect, test } from 'vitest'
import { corpusInput } from '../../testing/routing/corpus/evaluate'
import { scene } from '../../testing/routing/corpus/scene'
import type { CorpusExample } from '../../testing/routing/corpus/types'
import { describeState, supply } from '../../src/routing/supply'

/**
 * What the state text says of each line of work: its label, the listed
 * sections on it, and the title of its latest answer section, so that a
 * question about a line (`m_lines`, `m_chain`) can judge what the line is
 * about now and not only by its first answer.
 */

function exported(): CorpusExample {
  const s = scene()
  s.chain('K', 'root', 'kyoto overview')
  s.chain('B', 'root', 'sky color question')
  s.add('S1', { chain: 'K', on: null, label: 'kyoto overview', request: 'Tell me about kyoto', answerText: 'Kyoto was the imperial capital for a thousand years.' })
  s.add('S2', { chain: 'B', on: null, label: 'sky color question', request: 'why is hte sky blue?', answerText: 'Rayleigh scattering sends blue light across the sky.' })
  s.add('S3', { chain: 'B', on: 'S2', label: 'ocean sky reflection', request: 'And does the ocean reflect the sky?', answerText: 'Partly: the ocean also absorbs red light.' })
  return { id: 'lines', covers: ['targets'], note: 'the lines of the exported conversation', scene: s.build(), text: 'Tell me about the ocean and sky in kyoto', expect: {} }
}

const linesOf = (state: string): string[] => state.split('\n').filter((l) => /^L\d+\. /.test(l))

describe('the lines of work in the state text', () => {
  test('each line names its listed sections and the title of its latest one', () => {
    const input = corpusInput(exported())
    expect(linesOf(describeState(input, supply(input, []), 'subject'))).toEqual([
      'L1. "kyoto overview" (root): S1; latest "kyoto overview"',
      'L2. "sky color question" (root): S2, S3; latest "ocean sky reflection"',
    ])
  })

  test('a line whose sections are all outside the listed window shows only its latest section’s title', () => {
    const input = corpusInput(exported())
    const supplied = supply(input, [])
    const kyotoOnly = { ...supplied, sections: supplied.sections.filter((s) => s.request === 'Tell me about kyoto') }
    expect(linesOf(describeState(input, kyotoOnly, 'subject'))).toEqual(['L1. "kyoto overview" (root): S1; latest "kyoto overview"', 'L2. "sky color question" (root): latest "ocean sky reflection"'])
  })
})
