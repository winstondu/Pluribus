import { execSync } from 'node:child_process'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Git output for the build stamp, or '' outside a checkout. */
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

/** Which source this client was built from: shown in the sidebar's build tooltip. */
const BUILD = {
  commit: git('rev-parse --short HEAD'),
  branch: git('rev-parse --abbrev-ref HEAD'),
  dirty: git('status --porcelain --untracked-files=no') !== '',
  builtAt: new Date().toISOString(),
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  worker: { format: 'es' as const },
  define: {
    __BUILD__: JSON.stringify(BUILD),
    // Dev-server convenience only: lets the key prompt offer "use the key from the
    // environment" while testing. Never inlined into a production build.
    __DEV_OPENROUTER_KEY__: JSON.stringify(
      command === 'serve' ? (process.env.OPENROUTER_KEY ?? '') : '',
    ),
    // The same for the optional Anthropic key.
    __DEV_ANTHROPIC_KEY__: JSON.stringify(
      command === 'serve' ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
    ),
  },
}))
