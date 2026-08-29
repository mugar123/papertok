// SPA navigation is silent by default: the route remounts, focus falls on
// <body> and nothing tells a screen reader the view changed (WCAG 2.4.2,
// 2.4.3). On every pathname change this sets the tab title, announces the
// new view through a polite live region, and moves focus to #main-content
// so Tab restarts at the content instead of the top of the page.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useLanguage } from '../../context/LanguageContext'
import { routeTitle, routeLabel } from '../../utils/routeMetadata'

export default function RouteAnnouncer() {
  const location = useLocation()
  const { isEnglish } = useLanguage()
  const liveRef = useRef(null)
  // Last pathname we actually announced, not "is this the first render":
  // React.StrictMode (src/main.jsx) double-invokes this effect on mount
  // against the same component instance, so a first-render flag flips to
  // false on the first invocation and no longer guards the second one. A
  // remembered pathname is stable across that double-invoke because both
  // runs see the same location.pathname.
  const lastAnnouncedPath = useRef(null)

  useEffect(() => {
    // The title updates on every run, including a same-route re-run caused
    // by a language toggle or StrictMode's double-invoke.
    const title = routeTitle(location.pathname, isEnglish)
    if (title) document.title = title

    if (lastAnnouncedPath.current === null) {
      // Initial load: the browser already owns focus, nothing to announce.
      lastAnnouncedPath.current = location.pathname
      return
    }
    if (lastAnnouncedPath.current === location.pathname) {
      // Same route as last time we announced (StrictMode's second
      // invocation, or a language toggle): title above is enough.
      return
    }
    lastAnnouncedPath.current = location.pathname
    const label = routeLabel(location.pathname, isEnglish)
    if (liveRef.current) liveRef.current.textContent = label || ''
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [location.pathname, isEnglish])

  // Rendered persistently and empty: live regions only announce content
  // *changes*, so the node must exist before the first navigation.
  return <span ref={liveRef} className="visually-hidden" role="status" aria-live="polite" />
}
