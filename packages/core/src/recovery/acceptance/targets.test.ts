import { describe, expect, test } from 'vitest'
import { WORDING, type SectionId } from '@committee/protocol'
import { engineModule } from '../../engine'
import { routingModule } from '../../routing'
import { routingScenario } from '../../routing/acceptance/helpers'
import { answer } from '../../testing'
import { recoveryModule } from '../module'

/** T2 and T3 (05 · "Reply targets and routing outcomes"), over the real routing pipeline and the recovery slice. */

const A = 'Suggest neighborhoods to stay in Kyoto'

async function withA() {
  const s = await routingScenario({ modules: [engineModule, routingModule, recoveryModule] })
  s.t.model.script(A, answer('Gion.', 10, 20))
  await s.send(A)
  await s.t.advance(50)
  return s
}

describe('reply targets after revisions', () => {
  test('T2 · corrective wording supersedes the target; additive wording creates additional work and leaves the target current', async () => {
    const s = await withA()
    const a = s.d(A)
    s.t.model.script(A, answer('The Aman and the Park Hyatt.', 10, 20))
    await s.send('Actually, use a luxury budget', { message: { corrective: 0.95, relation: 'addition' } }, { replyTo: [A] })
    await s.t.advance(50)
    const revised = s.directive(a.id)
    expect(revised.sectionId).not.toBe(a.sectionId)
    let snap = await s.t.snapshot(s.c)
    expect(snap.transcript.sections[a.sectionId ?? '']?.state).toBe('superseded')
    expect(snap.transcript.sections[revised.sectionId ?? '']?.state).toBe('completed')
    expect(Object.values(s.state().directives).filter((d) => d.label.startsWith('Actually'))).toEqual([])

    // Additive wording (not clearly corrective): additional work, and the target stays current.
    await s.send('What about some luxury places?', { message: { corrective: 0.6, relation: 'addition' } }, { replyTo: [A] })
    await s.t.advance(50)
    const added = s.d('What about some luxury places')
    expect(added.relation).toBe('addition')
    expect(added.targets).toEqual([revised.sectionId])
    snap = await s.t.snapshot(s.c)
    expect(snap.transcript.sections[revised.sectionId ?? '']?.state).toBe('completed')
    expect(snap.transcript.sections[revised.sectionId ?? '']?.superseded).toBeNull()
  })

  test('T3 · a reply to a superseded section targets its replacement and says so', async () => {
    const s = await withA()
    const old = s.d(A).sectionId as SectionId
    await s.send('Actually, use a luxury budget', { message: { corrective: 0.95 } }, { replyTo: [A] })
    await s.t.advance(50)
    const replacement = s.d(A).sectionId
    expect(replacement).not.toBe(old)
    s.rules['Make it shorter'] = { message: { relation: 'addition' } }
    const messageId = await s.t.submit(s.c, 'Make it shorter', [old])
    const unit = s.state().messages[messageId]?.decision?.units[0]
    expect(unit?.targets.sectionIds).toEqual([replacement])
    expect(unit?.targets.redirected).toEqual([{ from: old, to: replacement }])
    expect(s.d('Make it shorter').targets).toEqual([replacement])
    const snap = await s.t.snapshot(s.c)
    expect(snap.transcript.messages[messageId]?.replyingTo).toMatchObject({ note: WORDING.replyingToRevised, targets: [{ sectionId: replacement }] })
    // The superseded attempt stays visible but is not a target for new work: its "Reply to this"
    // stays (10 · Controls, 06 · "The user replies to the superseded A afterwards") and a reply
    // through it targets the replacement, as above.
    expect(snap.transcript.sections[old]?.actions.reply).toBe(true)
  })
})
