import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describeDeployFlagDrift, findDeployFlagDrift } from './src/utils/deployFlags.js'

// Shared with the `base` field below and with the service-worker precache
// derivation, which needs to strip this same prefix off every asset URL
// dist/index.html references. Since papertok.app the site is served from the
// domain root, not from the /papertok/ project path GitHub Pages imposed.
const BASE_PATH = '/'
// build.outDir is not overridden anywhere in this config, so it is Vite's
// default: 'dist' relative to this file's own directory.
const DIST_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')

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

// The service worker precaches the BOOT SET ONLY -- what a first visit
// already pays for -- not the naive "every js/css/html/svg/png/woff2 in
// dist" glob. That naive pattern would sweep in every lazy route chunk
// (katex ~258 KB, ScientificReport ~336 KB) and all 49 self-hosted font
// files (~1031 KiB across every script subset), when a Spanish/English
// reader's first paint downloads only 7 of those fonts (Inter 400/500/
// 600/700 + IBM Plex Mono 400/500/600, latin subset, ~139 KiB -- confirmed
// both by `du` on the built files and live, via performance.getEntriesByType
// against a built preview). Precaching the rest would make the FIRST visit
// pay well over a megabyte to make the second one fast, which is exactly
// the mobile cost this branch's audit calls dominant.
//
// But "the entry JS/CSS" undersold the boot set: dist/index.html also
// modulepreloads ~24 further chunks (firebase, the Scopus proxy client,
// every context provider, ...) that a first visit fetches unconditionally
// too, before the service worker has even claimed the page -- so on visit 2
// the CacheFirst runtime rule below found them, matched them, and MISSED,
// paying the full network fetch anyway. Those chunks are the boot set as
// much as the entry file is; they just don't share its filename pattern
// (`firebase-DkzlGfZ-.js` doesn't glob the way `index-*.js` does), so listing
// them by hand would silently rot the next time the chunk graph reshuffles.
// `bootSetManifestTransform` below reads the actual <script>/modulepreload/
// stylesheet references out of the built dist/index.html and adds whichever
// of them the glob patterns here didn't already catch -- the boot set, by
// construction, without re-admitting katex or ScientificReport (neither is
// referenced from index.html) and without hardcoding chunk names that
// change on every content-hash rebuild.
//
// The icons, the manifest, and just 7 of the ~49 font files (Inter 400/500/
// 600/700 + IBM Plex Mono 400/500/600, latin subset) round out the glob
// here; everything else -- katex, ScientificReport, the other 42 font
// files, every lazy route chunk -- is left to the CacheFirst runtime rule
// below, cached only once a reader's session actually asks for it.
//
// index.html is deliberately NOT in this list. It is not immutable the way
// a hashed asset is -- a new deploy means new content at the same URL -- so
// precaching it would freeze it until the whole service worker updates.
// Instead it is handled by the `navigate` runtimeCaching rule below, which
// is explicitly network-first.
const PRECACHE_GLOB_PATTERNS = [
  'assets/index-*.js',
  'assets/index-*.css',
  'favicon.svg',
  'icons/*.png',
  'manifest.webmanifest',
  'assets/inter-latin-{400,500,600,700}-normal-*.woff2',
  'assets/ibm-plex-mono-latin-{400,500,600}-normal-*.woff2',
]

// workbox-build calls `manifestTransforms` functions after its own glob
// walk -- which only happens once the build has already written dist/ --
// so this can read the real, just-built dist/index.html instead of
// re-deriving its reference list as a second glob. It adds whichever
// script/modulepreload/stylesheet targets PRECACHE_GLOB_PATTERNS above
// didn't already catch (the ~24 further boot-set chunks -- see the comment
// above), and leaves everything else (katex, ScientificReport, every lazy
// route chunk: none of them referenced from index.html) alone.
function bootSetManifestTransform(distDir) {
  // The one <script type="module"> is the entry chunk; used below only to
  // assert it survived into the final manifest, independent of whatever
  // name a future build gives it.
  const entryScriptPattern = new RegExp(`<script[^>]*\\ssrc="${BASE_PATH}(assets/[^"]+\\.js)"`)
  const referencePattern = new RegExp(`(?:src|href)="${BASE_PATH}(assets/[^"]+\\.(?:js|css))"`, 'g')

  return async (manifestEntries) => {
    const html = readFileSync(join(distDir, 'index.html'), 'utf8')

    const entryMatch = html.match(entryScriptPattern)
    if (!entryMatch) {
      throw new Error(
        'dist/index.html has no <script type="module" src="..."> -- cannot find the entry '
        + 'chunk to precache. The build output shape changed; update vite.config.js.',
      )
    }
    const entryUrl = entryMatch[1]

    const known = new Set(manifestEntries.map((entry) => entry.url))
    const manifest = [...manifestEntries]
    // `referencePattern` is a shared `g`-flagged regex reused across calls
    // (this transform closure is long-lived); reset its stateful lastIndex
    // so a second invocation in the same process -- watch mode, a future
    // multi-build script -- starts scanning from the top instead of
    // wherever the previous call's html happened to leave off.
    referencePattern.lastIndex = 0
    let match
    while ((match = referencePattern.exec(html))) {
      const url = match[1]
      if (known.has(url)) continue
      known.add(url)
      manifest.push({ url, revision: null, size: statSync(join(distDir, url)).size })
    }

    // A future chunking or globPatterns change could silently drop the
    // entry chunk from the precache -- green build, no warning, a service
    // worker that installs everything except what actually boots the app.
    // Prove the one file index.html itself designates as the entry point
    // made it into the final manifest, rather than trust every step above
    // did its job.
    if (!manifest.some((entry) => entry.url === entryUrl)) {
      throw new Error(
        `Service worker precache manifest is missing the entry chunk (${entryUrl}), which `
        + 'dist/index.html references directly. Update vite.config.js.',
      )
    }

    return { manifest }
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') verifyProductionEnv(mode)

  return {
    base: BASE_PATH,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        // We call `registerSW` ourselves in main.jsx so we control exactly
        // when registration happens; the plugin's own auto-injected
        // registration script would double-register.
        injectRegister: false,
        // public/manifest.webmanifest already exists and is already linked
        // from index.html -- the plugin must not generate a second one.
        manifest: false,
        workbox: {
          // The plugin only wires `skipWaiting`/`clientsClaim` on for us when
          // `injectRegister` is left at its default -- with it set to `false`
          // above, a new service worker would sit in the `waiting` state
          // forever (nothing ever tells it to activate), which is precisely
          // the failure mode where a service worker pins a reader to a stale
          // build. Setting both here reproduces what 'autoUpdate' means: a
          // detected update activates and takes control of open tabs without
          // waiting for every tab to close first.
          skipWaiting: true,
          clientsClaim: true,
          globPatterns: PRECACHE_GLOB_PATTERNS,
          manifestTransforms: [bootSetManifestTransform(DIST_DIR)],
          // A hand-written addition alongside the fully generated sw.js --
          // generateSW's own template has no hook for custom install logic,
          // but workbox-build passes this straight through to a plain
          // importScripts() call in the emitted file. Without it,
          // `papertok-html` below stays empty until a SECOND navigation
          // happens under an active service worker (a first visit always
          // completes before any worker controls the page), so a reader
          // who installs the PWA and opens it offline before a THIRD visit
          // gets the browser's offline error instead of the app. See
          // public/sw-html-warm.js.
          importScripts: ['sw-html-warm.js'],
          // HashRouter never asks the server for any path other than the
          // base URL itself -- '#/paper/123' never leaves the browser, so
          // there are no alternate server routes for a fallback to rescue.
          // The one real navigation target is covered by the `navigate`
          // runtimeCaching rule below (network-first, offline-cached), so a
          // navigateFallback here would do nothing for a legitimate route
          // and would only give a mistyped or removed URL a fake 200 from a
          // frozen cache instead of the real 404 GitHub Pages would return.
          navigateFallback: null,
          runtimeCaching: [
            {
              // The one page in this app. NetworkFirst means every
              // navigation tries the network first and only reads this
              // cache when offline, so a new deploy is visible on the very
              // next reload instead of being pinned to whatever shipped
              // when the service worker last updated.
              urlPattern: ({ request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'papertok-html',
                networkTimeoutSeconds: 3,
                expiration: { maxEntries: 5 },
              },
            },
            {
              // Every hashed, content-addressed build asset NOT already in
              // the boot-set precache above: lazy route chunks, katex,
              // ScientificReport, the other 42 font files. Filenames are
              // content-hashed, so CacheFirst is safe -- a changed file gets
              // a new URL -- and this is what actually kills the repeat
              // 10-minute-max-age re-fetch on a second visit. `sameOrigin`
              // keeps this from ever matching the Worker API or Firebase,
              // which must never be served from a cache.
              urlPattern: ({ url, sameOrigin }) => sameOrigin && /\.(?:js|css|woff2)$/.test(url.pathname),
              handler: 'CacheFirst',
              options: {
                cacheName: 'papertok-assets',
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
                // Status 0 means an opaque response, which only a cross-origin
                // no-cors request can produce -- unreachable here, since the
                // urlPattern above already requires `sameOrigin`. [200] says
                // what this route can actually see.
                cacheableResponse: { statuses: [200] },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
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
