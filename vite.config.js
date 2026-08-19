import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/papertok/',
  plugins: [react()],
  server: {
    // Honors the harness-assigned port when two sessions run dev servers at
    // once; without PORT set, the default 5173 stands.
    port: Number(globalThis.process?.env?.PORT) || 5173,
    proxy: {
      '/api/arxiv': {
        // arXiv 301-redirects http to https and the proxy does not follow
        // redirects, so the http target made every dev request fail.
        target: 'https://export.arxiv.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/arxiv/, '/api/query'),
      },
    },
  },
})
