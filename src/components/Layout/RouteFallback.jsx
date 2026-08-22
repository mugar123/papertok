import './RouteFallback.css'

// The Suspense fallback for lazy routes. `null` was fine on the measured
// desktop-with-cache path, where chunks arrive in tens of milliseconds, but a
// first visit on a slow phone got a blank screen for as long as the chunk
// took. The CSS keeps it invisible for the first 320 ms, so the fast case
// still shows nothing at all.
export default function RouteFallback() {
  return <div className="route-fallback" role="status" aria-label="Cargando" />
}
