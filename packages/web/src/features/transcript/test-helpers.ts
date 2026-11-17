import { act } from '@testing-library/react'
import type { RenderWithBackendResult } from '@/test/render'

/** The transcript as drawn, top to bottom: `m:<id>` for a user message, `r:<id>` for a reply. */
export function drawnOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-message-id], [data-response-id]')].map((element) =>
    element.dataset.messageId ? `m:${element.dataset.messageId}` : `r:${element.dataset.responseId}`,
  )
}

/** Plays `count` fixture steps, letting React and the scroll follower settle after each. */
export async function play(view: RenderWithBackendResult, count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      view.backend?.step()
    })
  }
}

export function byId(container: HTMLElement, attribute: string, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[${attribute}="${id}"]`)
  if (!element) throw new Error(`Nothing drawn with ${attribute}="${id}"`)
  return element
}
