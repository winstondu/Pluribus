import { LOG_EXPORT_SCHEMA, type ConversationId, type LogExportDocument } from '@pluribus/protocol'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Header } from '@/app/header'
import { LogExportError, LogExportSourceProvider, saveLogExport, type LogExportResult, type LogExportSource, type SaveEnvironment } from '@/backend'
import { getFixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

/** "Export full logs" in the header's debug menu, over the embedded source and over a source that answers with a URL. */

interface Clicked {
  readonly href: string
  readonly download: string
}

function captureDownloads(): Clicked[] {
  const clicked: Clicked[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute('href') ?? '', download: this.download })
  })
  return clicked
}

function stubObjectUrls() {
  const blobs: Blob[] = []
  const revoked: string[] = []
  const create = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return `blob:pluribus/${blobs.length}`
  })
  const revoke = vi.fn((url: string) => revoked.push(url))
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  return { blobs, revoked, create }
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(blob)
  })
}

async function renderHeader(source?: LogExportSource) {
  const fixture = getFixture('run-inspection')
  if (!fixture) throw new Error('missing fixture')
  const header = <Header sidePanelAsSheet={false} sidePanelAvailable={false} onOpenSidePanel={() => {}} />
  const rendered = renderWithBackend(source ? <LogExportSourceProvider source={source}>{header}</LogExportSourceProvider> : header, { fixture })
  await act(() => rendered.ready)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Debug views' }))
  return { ...rendered, user }
}

afterEach(() => vi.restoreAllMocks())

describe('export full logs', () => {
  test('export · the item is in the debug menu with every debug view off, and says the file holds the conversation text', async () => {
    const { user } = await renderHeader()
    for (const box of screen.getAllByRole('menuitemcheckbox')) {
      if (box.getAttribute('aria-checked') === 'true') await user.click(box)
    }
    await waitFor(() => {
      for (const box of screen.getAllByRole('menuitemcheckbox')) expect(box).toHaveAttribute('aria-checked', 'false')
    })
    expect(screen.getByRole('menuitem', { name: 'Export full logs' })).toBeEnabled()
    expect(screen.getByText(/contains the full text of this conversation/)).toBeInTheDocument()
  })

  test('export · the embedded source asks the backend and saves its chunks as a Blob through an object URL', async () => {
    const urls = stubObjectUrls()
    const clicked = captureDownloads()
    const { user, store } = await renderHeader()
    await user.click(screen.getByRole('menuitem', { name: 'Export full logs' }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    const conversationId = store.getState().activeConversationId ?? ''
    expect(clicked[0]?.href).toBe('blob:pluribus/1')
    expect(clicked[0]?.download).toMatch(new RegExp(`^pluribus-log-${conversationId}-\\d{8}-\\d{6}\\.json$`))
    const blob = urls.blobs[0]
    expect(blob?.type).toBe('application/json')
    const doc = JSON.parse(await readBlob(blob ?? new Blob())) as LogExportDocument
    expect(doc.schema).toBe(LOG_EXPORT_SCHEMA)
    expect(doc.conversation.id).toBe(conversationId)
    expect(doc.derived.runs.length).toBeGreaterThan(0)
    expect(await screen.findByRole('status')).toHaveTextContent(`Saved ${clicked[0]?.download ?? ''}`)
  })

  test('export · a source that answers with a download URL is saved from the URL, with no object URL', async () => {
    const urls = stubObjectUrls()
    const clicked = captureDownloads()
    const asked: ConversationId[] = []
    const server: LogExportSource = {
      exportLog: (conversationId) => {
        asked.push(conversationId)
        return Promise.resolve({ kind: 'url', url: 'https://pluribus.example/exports/42.json', filename: 'pluribus-log-server.json' })
      },
    }
    const { user, store } = await renderHeader(server)
    await user.click(screen.getByRole('menuitem', { name: 'Export full logs' }))
    await waitFor(() => expect(clicked).toEqual([{ href: 'https://pluribus.example/exports/42.json', download: 'pluribus-log-server.json' }]))
    expect(asked).toEqual([store.getState().activeConversationId])
    expect(urls.create).not.toHaveBeenCalled()
  })

  test('export · busy while the backend builds it, then an error that is announced, then it can be tried again', async () => {
    captureDownloads()
    stubObjectUrls()
    let reject: (error: Error) => void = () => {}
    let calls = 0
    const source: LogExportSource = {
      exportLog: () => {
        calls += 1
        return new Promise<LogExportResult>((_, rejectWith) => {
          reject = rejectWith
        })
      },
    }
    const { user } = await renderHeader(source)
    await user.click(screen.getByRole('menuitem', { name: 'Export full logs' }))
    const busy = await screen.findByRole('menuitem', { name: 'Preparing export…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('data-disabled')
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the export')
    await user.click(busy)
    expect(calls).toBe(1)
    await act(async () => reject(new LogExportError('The export contained the stored OpenRouter key and was not produced.')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: The export contained the stored OpenRouter key')
    await user.click(screen.getByRole('menuitem', { name: 'Export full logs' }))
    expect(calls).toBe(2)
  })

  test('export · saving a Blob revokes its object URL afterwards; saving a URL creates none', () => {
    const clicked = captureDownloads()
    const later: (() => void)[] = []
    const revoked: string[] = []
    const environment: SaveEnvironment = {
      document,
      createObjectURL: () => 'blob:one',
      revokeObjectURL: (url) => revoked.push(url),
      later: (revoke) => later.push(revoke),
    }
    saveLogExport({ kind: 'blob', blob: new Blob(['{}']), filename: 'a.json' }, environment)
    expect(clicked).toEqual([{ href: 'blob:one', download: 'a.json' }])
    expect(revoked).toEqual([])
    later.forEach((run) => run())
    expect(revoked).toEqual(['blob:one'])
    saveLogExport({ kind: 'url', url: 'https://pluribus.example/x.json', filename: 'b.json' }, environment)
    expect(later).toHaveLength(1)
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })
})
