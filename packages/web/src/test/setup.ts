import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * What jsdom lacks and the installed components use. Kept minimal: each
 * polyfill does nothing, which is enough for Radix, cmdk, Motion and the
 * scroll helpers to mount.
 */

afterEach(() => {
  cleanup()
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
}

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
  const element = Element.prototype
  if (typeof element.scrollIntoView !== 'function') element.scrollIntoView = () => {}
  if (typeof element.scrollTo !== 'function') element.scrollTo = () => {}
  if (typeof element.hasPointerCapture !== 'function') element.hasPointerCapture = () => false
  if (typeof element.setPointerCapture !== 'function') element.setPointerCapture = () => {}
  if (typeof element.releasePointerCapture !== 'function') element.releasePointerCapture = () => {}
  if (typeof element.getAnimations !== 'function') element.getAnimations = () => []
}
