import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App.tsx'
import { ThemeProvider } from './app/theme.tsx'
import { FIXTURES_ENABLED } from './backend/connect.ts'

// The fixture gallery is a development route; its code is not in a production bundle.
const Gallery = FIXTURES_ENABLED ? lazy(() => import('./app/gallery.tsx')) : null
const showGallery = Gallery !== null && new URLSearchParams(window.location.search).has('fixtures')

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root element')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      {showGallery && Gallery ? (
        <Suspense fallback={null}>
          <Gallery />
        </Suspense>
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
)
