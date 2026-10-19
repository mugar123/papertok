import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { noteDeployActivated, watchServiceWorkerUpdates, watchWorkerActivations } from './utils/serviceWorkerUpdates.ts'
import { applyReloadPolicy, markAppForcedReload } from './utils/appReload.ts'
import { applyLegacyHashRoute } from './utils/legacyHashRoute.ts'
import { clearStaleOverlayMarker } from './hooks/useOverlayHistory.ts'
import App from './App.tsx'
import GlobalErrorBoundary from './GlobalErrorBoundary.tsx'

// Self-hosted fonts, imported before the global CSS so their @font-face
// rules land first in the bundle and the browser can start the font
// fetch as soon as this chunk parses — no more render-blocking request to
// fonts.googleapis.com.
//
// Inter and IBM Plex Mono import the AGGREGATE per-weight file
// (`{weight}.css`), not the single-subset ones. Fontsource's single-subset
// files (`latin-400.css`, `latin-ext-400.css`, ...) carry NO unicode-range
// descriptor at all — both default to U+0-10FFFF and become two identical,
// overlapping faces, so the browser cannot tell them apart and fetches
// every one of them for any text at that weight, regardless of what the
// text contains. Verified: `fontTools` cmap inspection shows
// inter-latin-ext-400-normal.woff2 doesn't even contain plain ASCII like
// 'a' or 'H', yet a pure-ASCII page still downloaded it because nothing
// told the browser it could skip it. The aggregate file gives every
// subset its own real unicode-range, so a Spanish/English page fetches
// only the latin block — and latin-ext still loads automatically the
// moment a byline needs it (this is a feed of scientific papers; author
// names come from everywhere — Polish, Czech, Turkish, Hungarian,
// Vietnamese — and those need Latin-Extended, so it cannot simply be
// dropped). The tradeoff: this bundles all seven subsets (cyrillic,
// cyrillic-ext, greek, greek-ext, latin, latin-ext, vietnamese for Inter;
// five for Plex, no greek) into the built CSS/dist output, so more woff2
// files are EMITTED than a naive subset-only import — but strictly fewer
// are ever DOWNLOADED, because the browser now picks by range instead of
// fetching every candidate. Weights match the previous Google Fonts
// request exactly (Inter 400/500/600/700, IBM Plex Mono 400/500/600, both
// normal-style only).
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
// Newsreader roman is the paper title face.
import '@fontsource-variable/newsreader/opsz.css'
// KaTeX's stylesheet ships with the on-demand KaTeX chunk (see
// components/ScientificText.js); loading it here put 23 KB of CSS in front of
// every first paint, math or no math.
import './styles/global.css'

// The app ships a complete PWA manifest but, until now, registered no
// service worker at all -- installable, zero offline capability, and every
// repeat visit re-fetching the whole chunk graph behind a 10-minute
// max-age. `registerType: 'autoUpdate'` (vite.config.ts) means: when a new
// deploy's service worker is detected, skip waiting and take control
// automatically.
//
// Without `onNeedReload`, the plugin reloads the page itself when an updated
// worker reaches `activated` (never on a first install). That reload was
// redundant on the first visit after each deploy: navigations are
// NetworkFirst, so the page had already booted the new build, and the reload
// booted it a second time a few seconds later. It is still needed
// for a tab that stays open across a deploy: that page's lazy `import()`
// calls ask for chunks by their old content hash, which the new deploy no
// longer serves. Below, `onNeedReload` turns the plugin's reload off, and each
// worker that takes control is checked instead: nothing happens when the
// page runs the build that worker precaches, and otherwise the reload waits
// until the reader changes page (utils/serviceWorkerUpdates.ts). A chunk that
// fails before then is caught by `vite:preloadError` below.
//
// No `immediate: true` here, deliberately: that option calls
// `navigator.serviceWorker.register()` right away, which starts the new
// worker's OWN install fetches (4 icons + manifest + favicon, forced to
// network since they carry a cache-busting `__WB_REVISION__`, plus up to 3
// unused font weights) in parallel with everything this module's own
// imports just triggered -- on a branch whose entire subject is mobile
// first paint, the registration this call kicks off would compete with
// exactly what it exists to protect. Omitting it takes the plugin's
// default instead: `wb.register()` defers the actual `register()` call to
// the window's `load` event, so it starts once the initial resource graph
// is already underway rather than racing it. The service worker does
// nothing useful on a first visit regardless (nothing is cached yet), so
// there is no cost to the wait. `registerSW` is a no-op string import when
// the build has no service worker (e.g. `vite dev`), so this is safe
// outside a production build too.

// A deploy replaces every hashed chunk. A tab that outlives one keeps asking
// for chunks by their old hash; vercel.json keeps `/assets` out of the SPA
// rewrite so that request is a 404 and not app.html served as JavaScript,
// and Vite reports the failure here. One reload fetches the new graph. The
// timestamp is what keeps a deploy that is genuinely broken from reloading
// forever: a second failure inside a minute surfaces as the error it is.
const PRELOAD_RELOAD_KEY = 'papertok_preload_reloaded_at'
window.addEventListener('vite:preloadError', (event) => {
  const now = Date.now()
  let last
  try {
    last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0
    if (now - last < 60_000) return
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now))
  } catch {
    // No session storage means no way to stop a loop: let the error surface.
    return
  }
  event.preventDefault()
  // Marked as ours, so the feed knows this reload was not asked for and keeps
  // the reader's place (utils/appReload.js).
  markAppForcedReload()
  window.location.reload()
})

// First of the pre-React gestures, because it settles the URL that every one
// of them — and then the router — reads. The app was a HashRouter until this
// commit, so `papertok.app/#/public/paper/<key>` is the shape of every link
// ever shared out of it and every link its notification emails carry; the gate
// in index.html forwards those to `/feed` with the fragment intact, and this
// turns the fragment back into the route it always named, in place, before
// anything can paint a feed nobody asked for (utils/legacyHashRoute.js).
applyLegacyHashRoute({ history: window.history, location: window.location })

// Before React renders, because the feed reads both stores on its first
// render: a reload the READER asked for starts fresh, one the app forced does
// not.
applyReloadPolicy()

// A reload taken with the reader or the PDF viewer open lands on that
// overlay's own history entry, and its `overlay` marker outlives the component
// it described — react-router rewrites `history.state` only when `idx` is
// missing, and a cloned entry always has one. Cleared here, before React
// renders and so before anything can be armed, or the next `arm()` would find
// its own tag on an entry it never pushed (useOverlayHistory.js).
clearStaleOverlayMarker({ history: window.history, location: window.location })

registerSW({
  onRegisteredSW(_url, registration) {
    watchServiceWorkerUpdates(registration)
  },
  // Replaces the plugin's own reload on `activated`. The activation watch
  // below decides instead.
  onNeedReload() {},
})
// Read here, in the entry module: this is the entry chunk's URL, which names
// the build. In any other module it could name a shared chunk.
const entryUrl = import.meta.url
watchWorkerActivations(navigator.serviceWorker, () => {
  void noteDeployActivated(entryUrl)
})

// The phone-side record of the tab bar's taps (diagnostics/tapDiagnostics.ts):
// behind `?tapdiag=1`, remembered for the tab's session so the app's own
// reloads keep it, `?tapdiag=0` to stop. A separate chunk that never loads
// otherwise. The flag is read from the search AND the hash: the routes live in
// the path now, but a `#/feed?tapdiag=1` typed from memory or pasted from an
// old note still has to work, and by this line the translation above has
// already moved any such query into the search anyway.
try {
  const flag = /[?&]tapdiag=([01])\b/.exec(`${window.location.search} ${window.location.hash}`)
  if (flag) sessionStorage.setItem('papertok_tapdiag', flag[1])
  if (sessionStorage.getItem('papertok_tapdiag') === '1') {
    import('./diagnostics/tapDiagnostics.ts').then((m) => m.start()).catch(() => {})
  }
} catch {
  // No session storage: no diagnostics either.
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Not a React transition. React Router 7 wraps each navigation's state
        update in `startTransition`, which renders in the background at low
        priority — and the feed's per-frame work starves it. Measured on the
        tab bar (scripts/diagnostics/explorer-loading-probe.mjs tabswitch,
        mobile emulation, 2026-09-05): a tap on Following showed nothing —
        no underline, no exit — for 168 ms on a desktop CPU and 699 ms at
        CPU ×4, chunk warm, because the bar and PageTransition both read
        `useLocation()` and wait for that commit. Synchronous, the exit
        starts 3 ms / 11 ms after the tap. Lazy routes are unaffected:
        AnimatePresence mode="wait" mounts the incoming page after the exit,
        outside the router's update either way (utils/lazyPreload.js). */}
    <MotionConfig reducedMotion="user">
      <BrowserRouter useTransitions={false}>
        <GlobalErrorBoundary>
          <App />
        </GlobalErrorBoundary>
      </BrowserRouter>
    </MotionConfig>
  </React.StrictMode>,
)
