import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'

/**
 * Light and dark, by a `dark` class on <html>, default `system`.
 *
 * The same contract as next-themes (`useTheme()` with `theme`, `setTheme`,
 * `resolvedTheme`; the choice stored under `theme` in localStorage). It is
 * written here because next-themes renders a <script> from a component,
 * which React 19 reports as an error on every load of a client-rendered
 * app. The class is first set by the inline script in index.html, before
 * paint, so there is no flash.
 */
export type ThemeChoice = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  readonly theme: ThemeChoice
  readonly resolvedTheme: 'light' | 'dark'
  setTheme(theme: ThemeChoice): void
}

const STORAGE_KEY = 'theme'
const ThemeContext = createContext<ThemeContextValue>({ theme: 'system', resolvedTheme: 'light', setTheme: () => {} })

function storedChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setChoice] = useState<ThemeChoice>(storedChoice)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const root = document.documentElement
    // No transition while the whole palette changes: a theme switch is one cut, not a hundred fades.
    const style = document.createElement('style')
    style.textContent = '*,*::before,*::after{transition:none!important}'
    document.head.appendChild(style)
    root.classList.toggle('dark', resolvedTheme === 'dark')
    void window.getComputedStyle(root).opacity
    const timer = setTimeout(() => style.remove(), 1)
    return () => {
      clearTimeout(timer)
      style.remove()
    }
  }, [resolvedTheme])

  // Another tab, or the fixture gallery around this frame, changed the theme.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) setChoice(storedChoice())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoice(next)
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // The choice still applies for this page load.
    }
  }, [])

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
