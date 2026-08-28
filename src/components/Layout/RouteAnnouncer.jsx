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
  const isFirstRender = useRef(true)

  useEffect(() => {
    const title = routeTitle(location.pathname, isEnglish)
    if (title) document.title = title
    if (isFirstRender.current) {
      // The initial load already has the browser's own focus and title.
      isFirstRender.current = false
      return
    }
    const label = routeLabel(location.pathname, isEnglish)
    if (liveRef.current) liveRef.current.textContent = label || ''
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [location.pathname, isEnglish])

  // Rendered persistently and empty: live regions only announce content
  // *changes*, so the node must exist before the first navigation.
  return <span ref={liveRef} className="visually-hidden" role="status" aria-live="polite" />
}
