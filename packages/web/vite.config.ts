import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  worker: { format: 'es' as const },
  define: {
    // Dev-server convenience only: lets the key prompt offer "use the key from the
    // environment" while testing. Never inlined into a production build.
    __DEV_OPENROUTER_KEY__: JSON.stringify(
      command === 'serve' ? (process.env.OPENROUTER_KEY ?? '') : '',
    ),
  },
}))
