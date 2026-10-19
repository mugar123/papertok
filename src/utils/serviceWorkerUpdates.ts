import { markAppForcedReload } from './appReload.ts'

interface UpdateRegistration { installing?: object | null; update(): Promise<unknown>; }
interface UpdateWindow extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}
type UpdateDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
interface UpdateOptions {
  windowTarget?: UpdateWindow | null;
  documentTarget?: UpdateDocument | null;
  navigatorTarget?: Pick<Navigator, 'onLine'> | null;
  now?: () => number;
}

// Registration checks at page load are not enough for a tab or installed PWA
// that survives several deploys. Check again on resume and while in use.
export function watchServiceWorkerUpdates(registration: UpdateRegistration | null | undefined, {
  windowTarget = window,
  documentTarget = document,
  navigatorTarget = navigator,
  now = Date.now,
}: UpdateOptions = {}) {
  if (!registration) return () => {}

  let checking = false
  let lastChecked = -Infinity
  const check = async () => {
    if (documentTarget!.visibilityState !== 'visible' || navigatorTarget!.onLine === false
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

  documentTarget!.addEventListener('visibilitychange', check)
  windowTarget!.addEventListener('pageshow', check)
  windowTarget!.addEventListener('online', check)
  const timer = windowTarget!.setInterval(check, 5 * 60_000)

  return () => {
    documentTarget!.removeEventListener('visibilitychange', check)
    windowTarget!.removeEventListener('pageshow', check)
    windowTarget!.removeEventListener('online', check)
    windowTarget!.clearInterval(timer)
  }
}

/**
 * Whether this page booted from the build that the newly active service worker
 * precaches. Workbox keeps that precache in `workbox-precache-v2-<scope>` and
 * deletes the previous build's entries before the worker reaches `activated`,
 * so the page's entry chunk is still there only when both run the same build.
 * The runtime asset cache is not consulted: it can still hold an older build's
 * entry chunk. One URL is enough because the entry chunk's hash changes with
 * the rest of the build (checked with a stylesheet-only change).
 */
export async function runsPrecachedBuild(entryUrl: string, scope: string, cacheStorage: Pick<CacheStorage, 'match'>) {
  try {
    // `ignoreSearch` covers the `__WB_REVISION__` query Workbox adds to entries
    // precached with a revision; hashed chunks are stored without one.
    return Boolean(await cacheStorage.match(entryUrl, { cacheName: `workbox-precache-v2-${scope}`, ignoreSearch: true }))
  } catch {
    // An unreadable precache proves nothing, so the page counts as behind and
    // the reload waits for the next route change.
    return false
  }
}

/**
 * Whether a route change is the moment to reload into a deploy this page is
 * behind on. `behindSince` is the path the reader was on when that deploy's
 * worker took control, or null when the page already runs its build.
 * Reloading under that page would close an open reader or PDF and cut off an
 * AI explanation; a route change means the reader is leaving it anyway.
 */
export function shouldReloadForDeploy(behindSince: string | null, pathname: string) {
  return behindSince !== null && pathname !== behindSince
}

let behindSince: string | null = null

/**
 * `registerSW`'s `onNeedReload`, which replaces Workbox's immediate reload on
 * `activated`. `entryUrl` is the entry module's `import.meta.url`.
 */
export async function noteDeployActivated(entryUrl: string) {
  if (behindSince !== null) return
  const { pathname } = window.location
  const { scope } = await navigator.serviceWorker.ready
  if (await runsPrecachedBuild(entryUrl, scope, window.caches)) return
  behindSince ??= pathname
}

/**
 * Called on every route change. A hidden tab is not used as the moment: a
 * phone can suspend the page before the reload runs, and the forced-reload
 * mark expires after a minute (appReload.ts), so the feed would start over.
 * Hiding the tab is also how a reader switches apps with a paper open.
 */
export function reloadIfBehindDeploy(pathname: string) {
  if (!shouldReloadForDeploy(behindSince, pathname)) return
  markAppForcedReload()
  window.location.reload()
}
