import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import GlobalErrorBoundary from './GlobalErrorBoundary.jsx'

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
// Newsreader is a two-axis variable font (optical size 6-72, weight
// 200-800). Fontsource's `wght.css`/`index.css` files pin opsz to its
// default and expose weight only — confirmed by reading their @font-face
// files and the fvar table inside the woff2 (fonttools ttx -t fvar). Only
// `opsz.css`/`opsz-italic.css` carry both axes, which is what reproduces
// the original two-axis Google Fonts request. No subset-scoped files exist
// for this package, so latin/latin-ext arrive together with vietnamese.
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
// Nunito carries the one warm line on a profile: the bio. Weight is its only
// real axis, so `wght.css` is the whole font — no opsz question like
// Newsreader's above. Only fetched when a profile card actually paints.
import '@fontsource-variable/nunito/wght.css'
// KaTeX's stylesheet ships with the on-demand KaTeX chunk (see
// components/ScientificText.js); loading it here put 23 KB of CSS in front of
// every first paint, math or no math.
import './styles/global.css'

// The app ships a complete PWA manifest but, until now, registered no
// service worker at all -- installable, zero offline capability, and every
// repeat visit re-fetching the whole chunk graph behind a 10-minute
// max-age. `registerType: 'autoUpdate'` (vite.config.js) means: when a new
// deploy's service worker is detected, skip waiting and take control
// automatically.
//
// What "take control automatically" actually does to an open tab:
// `registerSW()` below is called with no options, so `onNeedReload` is
// undefined and the plugin falls through to its own default handler on the
// `activated` event, which calls `window.location.reload()` itself --
// unprompted, the instant the new worker takes control. Not "the reader
// gets the new build next time they reload": the reload is not requested,
// it is forced. `isUpdate` is false on a first install, so this never fires
// for a first-time visitor; it fires on every revisit after a deploy. Since
// taking control follows precaching the whole boot set over the network, on
// a slow connection that forced reload can land mid-reading-session. It is
// not rescuing anyone from a stale build either -- the `navigate`
// runtimeCaching rule below is NetworkFirst, so an un-reloaded tab would
// already be showing the new HTML; the reload is close to pure cost.
// Left as-is anyway: without it, a tab that stays open across a deploy
// keeps the OLD `index.html` in memory, and that page's own lazy
// `import()` calls still ask for chunks by their old content hash, which
// the new deploy no longer serves -- a plain 404, and a route that simply
// will not open until the tab reloads some other way.
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
registerSW()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <GlobalErrorBoundary>
        <App />
      </GlobalErrorBoundary>
    </HashRouter>
  </React.StrictMode>,
)
