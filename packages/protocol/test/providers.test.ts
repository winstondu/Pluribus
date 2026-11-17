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

  test('in a deployment whose models are set by the server, no role is editable', () => {
    const roles = describe_(false)
    expect(roles.every((entry) => !entry.editable && entry.note === SERVER_MODELS_NOTE)).toBe(true)
  })
})
