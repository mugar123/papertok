import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { describeDeployFlagDrift, findDeployFlagDrift } from './src/utils/deployFlags.js'

// Fifteen services read `VITE_PAPER_API_BASE_URL` — arXiv, OpenAlex, Scopus, AI
// explanations, citations, related papers, Unpaywall, public lists and
// notifications among them. A bundle built without it reaches no backend at all,
// and it fails in the browser rather than at build time, so nothing about the
// deploy looks wrong. Since the arXiv proxy cascade was removed there is not even
// a fallback left to mask it. A production build without a Worker is a broken
// build, so it stops here instead of shipping.
function requireWorkerBaseUrl(env) {
  if (env.VITE_PAPER_API_BASE_URL) return
  throw new Error(
    'VITE_PAPER_API_BASE_URL is not set, so this build would ship a bundle that reaches no '
    + 'backend: arXiv, OpenAlex, Scopus, AI explanations, citations, related papers, public '
    + 'lists and notifications all read it.\n'
    + 'Set it in .env.local for a local build, or as the GitHub Actions repository variable '
    + 'for a deploy (see docs/DEVELOPMENT.md).',
  )
}

// A flag whose value is a product decision is declared in
// `src/utils/deployFlags.js`, but the value that reaches the bundle comes from a
// GitHub Actions repository variable, which changes with no commit and no
// review. Nothing used to compare the two, so the bundle could ship the
// opposite of the decision on record and look entirely healthy doing it —
// `VITE_SCOPUS_ENABLED` has drifted that way twice, in both directions. This
// stops the build instead, before the bundle exists, because a warning is
// precisely what already proved too quiet to notice.
function requireDeclaredDeployFlags(env) {
  const drift = findDeployFlagDrift(env)
  if (drift.length === 0) return
  throw new Error(
    'This build disagrees with the deploy flags declared in src/utils/deployFlags.js:\n'
    + `${describeDeployFlagDrift(drift)}\n`
    + 'Change the decision in src/utils/deployFlags.js, in the commit that records why, '
    + 'or clear the disagreeing GitHub Actions repository variable (Settings -> Secrets '
    + 'and variables -> Actions -> Variables). Do not change only the variable: the value '
    + 'it carries is the one nobody reviews.',
  )
}

function verifyProductionEnv(mode) {
  const env = loadEnv(mode, globalThis.process?.cwd?.() || '.', 'VITE_')
  requireWorkerBaseUrl(env)
  requireDeclaredDeployFlags(env)
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') verifyProductionEnv(mode)

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
