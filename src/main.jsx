import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
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
// KaTeX's stylesheet ships with the on-demand KaTeX chunk (see
// components/ScientificText.js); loading it here put 23 KB of CSS in front of
// every first paint, math or no math.
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <GlobalErrorBoundary>
        <App />
      </GlobalErrorBoundary>
    </HashRouter>
  </React.StrictMode>,
)
