import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Fifteen services read `VITE_PAPER_API_BASE_URL` — arXiv, OpenAlex, Scopus, AI
// explanations, citations, related papers, Unpaywall, public lists and
// notifications among them. A bundle built without it reaches no backend at all,
// and it fails in the browser rather than at build time, so nothing about the
// deploy looks wrong. Since the arXiv proxy cascade was removed there is not even
// a fallback left to mask it. A production build without a Worker is a broken
// build, so it stops here instead of shipping.
function requireWorkerBaseUrl(mode) {
  const env = loadEnv(mode, globalThis.process?.cwd?.() || '.', 'VITE_')
  if (env.VITE_PAPER_API_BASE_URL) return
  throw new Error(
    'VITE_PAPER_API_BASE_URL is not set, so this build would ship a bundle that reaches no '
    + 'backend: arXiv, OpenAlex, Scopus, AI explanations, citations, related papers, public '
    + 'lists and notifications all read it.\n'
    + 'Set it in .env.local for a local build, or as the GitHub Actions repository variable '
    + 'for a deploy (see docs/DEVELOPMENT.md).',
  )
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') requireWorkerBaseUrl(mode)

  return {
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
  }
})
