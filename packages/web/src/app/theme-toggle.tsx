import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useTheme } from './theme'
import { cn } from '@/lib/utils'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
] as const

/** Light, system or dark. A radio group, so arrow keys move between the three. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const current = theme

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn('inline-flex items-center gap-0.5 rounded-full border border-border bg-background/60 p-0.5', className)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const index = OPTIONS.findIndex((option) => option.value === current)
        const next = OPTIONS[(index + (event.key === 'ArrowRight' ? 1 : OPTIONS.length - 1)) % OPTIONS.length]
        if (next) {
          setTheme(next.value)
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
          buttons[OPTIONS.indexOf(next)]?.focus()
        }
      }}
    >
      {OPTIONS.map((option) => {
        const selected = current === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${option.label} theme`}
            title={`${option.label} theme`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTheme(option.value)}
            className={cn(
              'pressable grid size-6 place-items-center rounded-full text-faint-foreground hover:text-foreground',
              selected && 'bg-surface-raised text-foreground shadow-raised',
            )}
          >
            <option.icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
