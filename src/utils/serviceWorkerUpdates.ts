// Registration checks at page load are not enough for a tab or installed PWA
// that survives several deploys. Check again on resume and while in use.
export function watchServiceWorkerUpdates(registration, {
  windowTarget = window,
  documentTarget = document,
  navigatorTarget = navigator,
  now = Date.now,
} = {}) {
  if (!registration) return () => {}

  let checking = false
  let lastChecked = -Infinity
  const check = async () => {
    if (documentTarget.visibilityState !== 'visible' || navigatorTarget.onLine === false
      || registration.installing || checking || now() - lastChecked < 60_000) return
    checking = true
    try {
      await registration.update()
      lastChecked = now()
    } catch {
      // A failed check must not interrupt reading or prevent a later retry.
    } finally {
      checking = false
    }
  }

  documentTarget.addEventListener('visibilitychange', check)
  windowTarget.addEventListener('pageshow', check)
  windowTarget.addEventListener('online', check)
  const timer = windowTarget.setInterval(check, 5 * 60_000)

  return () => {
    documentTarget.removeEventListener('visibilitychange', check)
    windowTarget.removeEventListener('pageshow', check)
    windowTarget.removeEventListener('online', check)
    windowTarget.clearInterval(timer)
  }
}
