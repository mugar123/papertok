import './RouteFallback.css'

// The Suspense fallback for lazy routes. `null` was fine on the measured
// desktop-with-cache path, where chunks arrive in tens of milliseconds, but a
// first visit on a slow phone got a blank screen for as long as the chunk
// took. The CSS keeps it invisible for the first 320 ms, so the fast case
// still shows nothing at all.
export default function RouteFallback() {
  // Purely decorative: `role="status"` with only an `aria-label` and no real
  // text content never gets announced (a live region speaks content changes,
  // not its own label), and it would be redundant here regardless —
  // RouteAnnouncer is mounted outside this Suspense boundary in App.jsx and
  // already announces the route change the moment navigation starts, before
  // this chunk even begins downloading.
  return <div className="route-fallback" aria-hidden="true" />
}
