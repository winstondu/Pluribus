import { ArrowUpRightIcon, MonitorIcon, PlayIcon, RotateCcwIcon, SmartphoneIcon, StepForwardIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fixtures, type Fixture, type FixtureBackend } from '@/fixtures'
import { cn } from '@/lib/utils'
import { BrandMark, Wordmark } from './brand'
import { ThemeToggle } from './theme-toggle'

/**
 * The fixture gallery (`?fixtures`, development only): every fixture in the
 * real shell, with a stepper for its scripted playback and a phone-width
 * frame. The app runs in an iframe on `?fixture=<id>&manual`, so what is
 * shown is exactly the app, media queries included.
 */
export default function Gallery() {
  const [selected, setSelected] = useState<Fixture | undefined>(() => {
    const id = new URLSearchParams(window.location.search).get('fixtures')
    return fixtures.find((fixture) => fixture.id === id) ?? fixtures[0]
  })
  const [phone, setPhone] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [backend, setBackend] = useState<FixtureBackend | null>(null)
  const [, setTick] = useState(0)
  const [playing, setPlaying] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)

  const select = useCallback((fixture: Fixture) => {
    setSelected(fixture)
    setGeneration((value) => value + 1)
    const url = new URL(window.location.href)
    url.searchParams.set('fixtures', fixture.id)
    window.history.replaceState(null, '', url)
  }, [])

  // Find the fixture backend inside the frame once the app there has connected.
  useEffect(() => {
    setBackend(null)
    setPlaying(false)
    let unsubscribe: (() => void) | null = null
    const poll = setInterval(() => {
      const found = frame.current?.contentWindow?.__committeeFixture
      if (!found || found.fixture.id !== selected?.id) return
      clearInterval(poll)
      setBackend(found)
      unsubscribe = found.onProgress(() => setTick((value) => value + 1))
    }, 60)
    return () => {
      clearInterval(poll)
      unsubscribe?.()
    }
  }, [selected, generation])

  // Play: each remaining step after its own delay.
  useEffect(() => {
    if (!playing || !backend) return
    const next = backend.remaining[0]
    if (!next) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => backend.step(), next.delayMs)
    return () => clearTimeout(timer)
  })

  const remaining = backend?.remaining ?? []
  const played = backend?.played ?? 0
  const total = played + remaining.length

  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <nav aria-label="Fixtures" className="scroll-quiet flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar max-md:w-44">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <BrandMark />
          <Wordmark />
          <span className="text-xs text-faint-foreground max-md:hidden">fixtures</span>
        </div>
        <h2 className="eyebrow px-4 pt-2 pb-1.5">{fixtures.length} states</h2>
        <ul className="flex flex-col gap-px px-2 pb-4">
          {fixtures.map((fixture) => (
            <li key={fixture.id}>
              <button
                type="button"
                aria-current={fixture.id === selected?.id ? 'page' : undefined}
                onClick={() => select(fixture)}
                className={cn(
                  'flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-sidebar-accent/60',
                  fixture.id === selected?.id && 'bg-sidebar-accent hover:bg-sidebar-accent',
                )}
              >
                <span className="truncate font-mono text-xs">{fixture.id}</span>
                <span className="truncate text-2xs text-muted-foreground">{fixture.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{selected?.title ?? 'No fixtures'}</h1>
            <p className="truncate text-xs text-muted-foreground">{selected?.covers.join(' · ')}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="tabular mr-1 text-xs text-muted-foreground" aria-live="polite">
              {total === 0 ? 'No steps' : `Step ${played} of ${total}`}
            </span>
            <Button variant="outline" size="sm" disabled={remaining.length === 0 || playing} onClick={() => backend?.step()}>
              <StepForwardIcon /> Step
            </Button>
            <Button variant="outline" size="sm" disabled={remaining.length === 0 || playing} onClick={() => setPlaying(true)}>
              <PlayIcon /> Play
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setGeneration((value) => value + 1)}>
              <RotateCcwIcon /> Reset
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant={phone ? 'ghost' : 'secondary'}
              size="icon-sm"
              aria-label="Desktop width"
              aria-pressed={!phone}
              onClick={() => setPhone(false)}
            >
              <MonitorIcon />
            </Button>
            <Button
              variant={phone ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label="Phone width"
              aria-pressed={phone}
              onClick={() => setPhone(true)}
            >
              <SmartphoneIcon />
            </Button>
            <ThemeToggle className="ml-1" />
            {selected ? (
              <a
                href={`?fixture=${selected.id}`}
                target="_blank"
                rel="noreferrer"
                className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Open alone <ArrowUpRightIcon className="size-3.5" />
              </a>
            ) : null}
          </div>
        </header>

        {remaining[0] ? (
          <p className="shrink-0 border-b border-border bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
            Next: {remaining[0].label}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 place-items-center bg-muted/40 p-0 md:p-4">
          {selected ? (
            <iframe
              ref={frame}
              key={`${selected.id}:${generation}`}
              title={`Fixture ${selected.id}`}
              src={`?fixture=${encodeURIComponent(selected.id)}&manual`}
              className={cn(
                'h-full border-border bg-background md:rounded-xl md:border md:shadow-raised',
                phone ? 'w-[390px] max-w-full' : 'w-full',
              )}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Add a case under src/fixtures/cases/.</p>
          )}
        </div>
      </div>
    </div>
  )
}
