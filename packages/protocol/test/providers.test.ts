import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SERVER_MODELS_NOTE,
  describeModelRoles,
  type Settings,
} from '@pluribus/protocol'

/** What the backend reports for the Models section; the client renders it and decides nothing. */
describe('the backend\'s description of each role\'s model choice', () => {
  const describe_ = (editable = true, settings: Settings = DEFAULT_SETTINGS) => describeModelRoles(settings, { editable })
  const role = (roles: ReturnType<typeof describe_>, name: string) => {
    const found = roles.find((entry) => entry.role === name)
    if (!found) throw new Error(`no role ${name}`)
    return found
  }

  test('each provider offers its own models: the tested list for answers, synthesis and decomposition; the pinned model for decisions', () => {
    const roles = describe_()
    const [openRouter] = role(roles, 'answer').providers
    expect([openRouter?.restricted, openRouter?.models.map((m) => m.id)]).toEqual([true, ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']])
    expect(openRouter?.models.every((m) => m.tested)).toBe(true)
    expect(role(roles, 'synthesis').providers.map((p) => [p.provider, p.restricted, p.models.map((m) => m.id)])).toEqual([
      ['openrouter', true, ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']],
    ])
    expect(role(roles, 'decision').providers.map((p) => [p.restricted, p.models.map((m) => m.id)])).toEqual([[false, ['typesafe/jev-1.13']]])
  })

  test('in a deployment whose models are set by the server, no role is editable', () => {
    const roles = describe_(false)
    expect(roles.every((entry) => !entry.editable && entry.note === SERVER_MODELS_NOTE)).toBe(true)
  })
})
