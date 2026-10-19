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
    // the reload waits for one of the moments below.
    return false
  }
}

/**
 * How long the tab has to have been hidden for coming back to it to count as
 * a moment for the deploy reload. A glance at another app does not count. It
 * stays under the feed snapshot's 15 minutes (FeedContext.tsx), so the reload
 * can still bring back the papers the reader left.
 */
const RETURN_AFTER_MS = 5 * 60_000

interface DeployMoment {
  /** The path the reader is on. */
  pathname: string
  online: boolean
  /** Set when the moment is the tab becoming visible again: how long it was hidden. */
  returnedAfterMs?: number
  /** Whether a modal dialog is open: the reader, the PDF viewer, a form. */
  modalOpen?: boolean
}

/**
 * Whether this is the moment to reload into a deploy this page is behind on.
 * `behindSince` is the path the reader was on when that deploy's worker took
 * control, or null when the page already runs its build.
 *
 * Reloading under that page would close an open reader or PDF and cut off an
 * AI explanation. Two moments avoid that:
 *   - a route change, because the reader is leaving the page anyway;
 *   - coming back to the tab after RETURN_AFTER_MS with no modal open, before
 *     the reader has started again. Without it a tab that stays on the feed
 *     would keep the old build, and keep calling Worker routes that a later
 *     deploy may retire: its lazy chunks are mostly loaded or cached, so
 *     `vite:preloadError` rarely fires there.
 *
 * Offline the reload waits. The page request would fail, the worker would
 * answer with a cached document, and that fresh boot has no Firestore cache
 * to read the profile from, so the reader would get the profile error screen
 * in place of a session that still works.
 */
export function shouldReloadForDeploy(behindSince: string | null, { pathname, online, returnedAfterMs, modalOpen = false }: DeployMoment) {
  if (behindSince === null || !online) return false
  if (returnedAfterMs === undefined) return pathname !== behindSince
  return returnedAfterMs >= RETURN_AFTER_MS && !modalOpen
}

let behindSince: string | null = null
let hiddenAt: number | null = null

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

/** Called on every route change. */
export function reloadIfBehindDeploy(pathname: string) {
  if (behindSince === null) return
  if (shouldReloadForDeploy(behindSince, { pathname, online: navigator.onLine !== false })) {
    markAppForcedReload()
    window.location.reload()
    return
  }
  // An offline route change still left the page, so the next one is the
  // moment.
  behindSince = pathname
}

/**
 * The document's `visibilitychange`. Hiding the tab is never the moment
 * itself: a phone can suspend the page before the reload runs, and the
 * forced-reload mark expires after a minute (appReload.ts), so the feed would
 * start over. Hiding is also how a reader switches apps with a paper open.
 * Coming back can be the moment, and then the reload starts while the page
 * is visible.
 */
export function reloadOnReturnIfBehindDeploy() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
    return
  }
  if (hiddenAt === null) return
  const returnedAfterMs = Date.now() - hiddenAt
  hiddenAt = null
  if (!shouldReloadForDeploy(behindSince, {
    pathname: window.location.pathname,
    online: navigator.onLine !== false,
    returnedAfterMs,
    // The probe searchShortcut.ts and FeedContainer already use.
    modalOpen: Boolean(document.querySelector('[aria-modal="true"]')),
  })) return
  markAppForcedReload()
  window.location.reload()
}
