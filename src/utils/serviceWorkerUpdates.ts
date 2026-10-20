import { markAppForcedReload } from './appReload.ts'
import { settleWithin } from './asyncTiming.ts'

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
 * entry chunk.
 *
 * One URL stands for the build because the entry chunk's name changes with
 * the rest of it. Vite adds the names of a chunk's own stylesheets to its hash
 * (`augmentChunkHash` in vite:css-post, active while `build.cssCodeSplit`
 * keeps its default), and the entry chunk names the chunks and route
 * stylesheets it loads. With vite 8.0.16, changing one declaration in
 * styles/global.css, components/ui/button.css or Reader/PaperReader.css
 * renamed the entry chunk each time. A deploy that changes only revisioned
 * public files (icons, manifest) keeps the entry URL and counts as the same
 * build; the page does not run those files.
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
 *
 * Offline the reload waits. The page request would fail, the worker would
 * answer with a cached document, and that fresh boot has no Firestore cache
 * to read the profile from, so the reader would get the profile error screen
 * in place of a session that still works.
 */
export function shouldReloadForDeploy(behindSince: string | null, { pathname, online }: { pathname: string; online: boolean }) {
  return behindSince !== null && online && pathname !== behindSince
}

type ActivatingWorker = Pick<ServiceWorker, 'state' | 'addEventListener' | 'removeEventListener'>
type WorkerContainer = Pick<EventTarget, 'addEventListener'> & { readonly controller: ActivatingWorker | null }

/**
 * Calls `onActivated` each time a new service worker takes control of this
 * page and finishes activating, a first install included. The worker claims
 * every open tab (`clientsClaim`, vite.config.ts), so `controllerchange`
 * reaches each tab on every deploy. workbox-window's `activated` does not: once
 * it attributes an update to another page it stops listening for updates
 * (`_onUpdateFound`), so a tab that skipped one reload would never hear of a
 * later deploy. Activation is awaited because Workbox deletes the previous
 * build's precache entries while the worker activates.
 */
export function watchWorkerActivations(container: WorkerContainer | undefined, onActivated: () => void) {
  container?.addEventListener('controllerchange', () => {
    const worker = container.controller
    if (!worker) return
    const settle = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return
      worker.removeEventListener('statechange', settle)
      if (worker.state === 'activated') onActivated()
    }
    worker.addEventListener('statechange', settle)
    settle()
  })
}

let behindSince: string | null = null

/**
 * Records whether the worker that just activated precaches a build other than
 * the one this page runs. `entryUrl` is the entry module's `import.meta.url`.
 */
export async function noteDeployActivated(entryUrl: string) {
  if (behindSince !== null) return
  const { pathname } = window.location
  const { scope } = await navigator.serviceWorker.ready
  if (await runsPrecachedBuild(entryUrl, scope, window.caches)) return
  behindSince ??= pathname
}

/**
 * How long a route-change reload waits for Firestore to acknowledge the writes
 * already issued. Past it, the reload waits for the next route change.
 */
const WRITES_SETTLE_MS = 1_000

/**
 * Called on every route change. `writesSettled` resolves once Firestore has
 * acknowledged the writes issued so far, after issuing the interaction
 * aggregate still waiting on its debounce (App.tsx). Firestore keeps
 * unacknowledged writes in memory only (services/firebase.ts), so a reload
 * would drop them, and a route change can follow one closely: onboarding
 * sends the email opt-in without awaiting it, then navigates to the feed.
 * Writes still pending after WRITES_SETTLE_MS, a rejected wait (Firestore
 * rejects it when the signed-in user changes), or a dialog open when the wait
 * ends leave the reload to the next route change.
 * A further route change during the wait, such as a redirect, does not: the
 * reload opens the page the tab is on by then.
 *
 * A hidden tab is not used as the moment: a phone can suspend the page before
 * the reload runs, and the forced-reload mark expires after a minute
 * (appReload.ts), so the feed would start over. Hiding the tab is also how a
 * reader switches apps with a paper open.
 */
export async function reloadIfBehindDeploy(pathname: string, writesSettled: () => Promise<unknown>) {
  if (behindSince === null) return
  if (shouldReloadForDeploy(behindSince, { pathname, online: navigator.onLine !== false })) {
    const writes = await settleWithin(writesSettled(), WRITES_SETTLE_MS)
    if (writes.status === 'fulfilled' && !document.querySelector('[aria-modal="true"]')) {
      markAppForcedReload()
      window.location.reload()
      return
    }
  }
  // An offline route change, or one the reload could not follow, still left
  // the page, so the next one is the moment.
  behindSince = window.location.pathname
}
