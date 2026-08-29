// Imported into the generated service worker via `workbox.importScripts`
// (see vite.config.js) -- generateSW's own template offers no hook for
// custom install logic, so this small file sits alongside it instead.
//
// `papertok-html`, the NetworkFirst cache the generated sw.js reads and
// writes for every navigation, starts empty: it is first written on the
// SECOND navigation served under an active service worker, because the
// FIRST navigation always completes before any worker controls the page.
// A reader who installs the PWA (display: standalone) and opens it offline
// before that second navigation gets the browser's offline error instead
// of the app. Fetching the scope root during install closes that gap: by
// the time this worker activates, `papertok-html` already holds a shell.
//
// Best-effort only, on purpose: a failed fetch here (e.g. this exact
// install race happening while genuinely offline) must not fail the whole
// service worker install and block a legitimate update from ever
// activating.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open('papertok-html')
      .then((cache) => cache.add(self.registration.scope))
      .catch(() => {}),
  )
})
