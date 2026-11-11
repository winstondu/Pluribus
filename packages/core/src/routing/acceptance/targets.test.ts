import { describe, expect, test } from 'vitest'
import type { ConversationEventBody, MessageId, SectionId } from '@committee/protocol'
import type { RoutingPlan } from '../../ports'
import { supersedeSection, type CoreModule } from '../../engine'
import { answer } from '../../testing'
import { routingScenario } from './helpers'

/**
 * T1 (05 · "Reply targets and routing outcomes"). T2 and T3 are
 * core-recovery's canonical tests (PLAN §6: they need a superseded section,
 * which only a revision makes); here they are checked on the routing side,
 * with a stand-in for the revision applier.
 */

const SKY_MENU = 'Explain why the sky is blue, and separately translate this menu into French: soup, bread'

async function skyAndMenu() {
  const s = await routingScenario()
  s.t.model.script('Explain why the sky is blue', answer('Blue light scatters most.', 10, 20))
  s.t.model.script('Translate this menu', answer('Soupe, pain.', 10, 20))
  await s.send(SKY_MENU, { composite: 0.9 }, {
    decompose: [
      { part: 'Explain why the sky is blue', label: 'sky' },
      { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread', label: 'menu' },
    ],
  })
  await s.t.advance(50)
  return s
}

describe('reply targets', () => {
  test('T1 · an explicit section reply target resolves to its chosen fragment; an untargeted follow-up may have one or several section targets inferred', async () => {
    const s = await skyAndMenu()
    const sky = s.d('sky')
    const menu = s.d('menu')
    expect(s.state().responses[s.state().sections[sky.sectionId ?? '']?.responseId ?? '']?.grouped).toBe(true)

    // Explicit: the menu section of the composite answer, and only it.
    await s.send('Make it shorter', { message: { relation: 'addition' } }, { replyTo: ['menu'] })
    const explicit = s.d('Make it shorter')
    expect(explicit.targets).toEqual([menu.sectionId])
    expect(s.state().nodes[explicit.nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: menu.nodeId }])
    expect(s.state().messages[explicit.messageId]?.decision?.units[0]?.targets.mode).toBe('explicit')
    // The decision model was not asked to infer a target it was given.
    const asked = s.t.decisions.requests.at(-1)?.questions ?? {}
    expect(Object.keys(asked).filter((id) => /^m_s\d+$/.test(id))).toEqual([])

    // Inferred, one section.
    await s.send('Make the translation more formal', { message: { relation: 'addition', targets: { menu: 0.92, sky: 0.1 } } })
    const one = s.d('Make the translation more formal')
    expect(one.targets).toEqual([menu.sectionId])
    const decision = s.state().messages[one.messageId]?.decision?.units[0]
    expect(decision?.targets.mode).toBe('inferred')
    expect(decision?.targets.candidates.find((c) => c.sectionId === menu.sectionId)?.confidence).toBeCloseTo(0.92)

    // Inferred, both sections of the composite answer: a join chain over their lines.
    await s.send('Make both answers simpler', { message: { relation: 'addition', targets: { menu: 0.9, sky: 0.88 } } })
    const both = s.d('Make both answers simpler')
    expect(new Set(both.targets)).toEqual(new Set([sky.sectionId, menu.sectionId]))
    expect(s.state().chains[both.chainId]?.kind).toBe('join')

    // Below the threshold for both, and plausible for both: the user is asked, nothing is guessed.
    await s.send('Make that one shorter', { message: { relation: 'addition', targets: { menu: 0.5, sky: 0.45 } } })
    const ambiguous = Object.values(s.state().messages).find((m) => m.text === 'Make that one shorter')
    expect(ambiguous?.routing).toBe('awaiting-target')
    expect(ambiguous?.directiveIds).toEqual([])
  })

  test('T2 (routing) · corrective wording is planned as a revision of the target; additive wording is additional work and the target stays current', async () => {
    const plans: RoutingPlan[] = []
    const capture: CoreModule = { name: 'capture-revisions', planAppliers: [{ parts: ['revisions'], apply: (_s, plan) => void plans.push(plan) }] }
    const s = await routingScenario({ extraModules: [capture] })
    s.t.model.script('Suggest neighborhoods', answer('Gion.', 10, 20))
    await s.send('Suggest neighborhoods to stay in Kyoto')
    await s.t.advance(50)
    const a = s.d('Suggest neighborhoods to stay in Kyoto')
    await s.send('Actually, use a luxury budget', { message: { corrective: 0.95, relation: 'addition' } }, { replyTo: ['Suggest neighborhoods to stay in Kyoto'] })
    const revision = plans.at(-1)
    expect(revision?.units).toEqual([])
    expect(revision?.revisions).toHaveLength(1)
    expect(revision?.revisions[0]?.scope).toBe('work')
    expect(revision?.revisions[0]?.targetDirectiveIds).toEqual([a.id])
    expect(revision?.decision.units[0]?.relation.value).toBe('revision')

    // Not clearly corrective (below the threshold): additional work, nothing superseded.
    await s.send('What about some luxury places?', { message: { corrective: 0.6, relation: 'addition' } }, { replyTo: ['Suggest neighborhoods to stay in Kyoto'] })
    const added = s.d('What about some luxury places')
    expect(added.relation).toBe('addition')
    expect(added.targets).toEqual([a.sectionId])
    expect(s.state().sections[a.sectionId ?? '']?.supersession).toBeNull()
    const snap = await s.t.snapshot(s.c)
    expect(snap.transcript.sections[a.sectionId ?? '']?.state).toBe('completed')
  })

  test('T3 (routing) · a reply to a superseded section targets its replacement and says so', async () => {
    // Stand-in for core-recovery's revision applier: supersede the target and open its replacement.
    const reviser: CoreModule = {
      name: 'stand-in-revisions',
      planAppliers: [
        {
          parts: ['revisions'],
          apply(_s, plan, target, ctx) {
            for (const r of plan.revisions) {
              for (const id of r.targetDirectiveIds) {
                const d = ctx.state.directives[id]
                if (!d?.sectionId) continue
                ctx.emit({ type: 'revision-recorded', messageId: target.messageId, scope: 'work', correction: r.correction, fragmentId: null, targets: [{ directiveId: id, sectionId: d.sectionId, state: 'finished' }], requirementIds: [] })
                const responseId = ctx.ids.next('response')
                const sectionId = ctx.ids.next('section') as SectionId
                supersedeSection(ctx, d.sectionId, { kind: 'revision', revisionMessageId: target.messageId as MessageId }, sectionId)
                const events: ConversationEventBody[] = [
                  { type: 'response-opened', responseId, messageId: target.messageId, reason: 'revision-replacement', grouped: false, sectionOrder: 'first-output' },
                  { type: 'section-opened', sectionId, directiveId: id, responseId, title: d.label, replacesSectionId: d.sectionId, operationId: ctx.ids.next('operation'), explicitPosition: null },
                  { type: 'directive-ready', directiveId: id },
                ]
                for (const e of events) ctx.emit(e)
              }
            }
          },
        },
      ],
    }
    const s = await routingScenario({ extraModules: [reviser] })
    s.t.model.script('Suggest neighborhoods', answer('Gion.', 10, 20))
    await s.send('Suggest neighborhoods to stay in Kyoto')
    await s.t.advance(50)
    const a = s.d('Suggest neighborhoods to stay in Kyoto')
    const old = a.sectionId
    await s.send('Actually, use a luxury budget', { message: { corrective: 0.95 } }, { replyTo: ['Suggest neighborhoods to stay in Kyoto'] })
    await s.t.advance(50)
    const replacement = s.directive(a.id).sectionId
    expect(replacement).not.toBe(old)
    // The superseded section is not a candidate any more.
    await s.send('Which of those is quietest?', { message: { relation: 'addition' } })
    const lastInput = s.t.decisions.requests.at(-1)?.state ?? ''
    expect(lastInput.match(/^S\d+\./gm)).toHaveLength(1)

    // An explicit reply to the old section goes to its replacement, and the transcript says so.
    s.rules['Make it shorter'] = { message: { relation: 'addition' } }
    const messageId = await s.t.submit(s.c, 'Make it shorter', [old as SectionId])
    const message = s.state().messages[messageId]
    const unit = message?.decision?.units[0]
    expect(unit?.targets.sectionIds).toEqual([replacement])
    expect(unit?.targets.redirected).toEqual([{ from: old, to: replacement }])
    const snap = await s.t.snapshot(s.c)
    expect(snap.transcript.messages[messageId]?.replyingTo?.note).toBe('Replying to the revised version')
  })
})
