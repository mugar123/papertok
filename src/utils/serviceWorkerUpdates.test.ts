import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APP_RELOAD_KEY } from './appReload.ts'
import {
  noteDeployActivated, reloadIfBehindDeploy, runsPrecachedBuild, shouldReloadForDeploy, watchServiceWorkerUpdates, watchWorkerActivations,
} from './serviceWorkerUpdates.ts'

function setup(update = async () => {}) {
  const windowTarget = new EventTarget() as EventTarget & { setInterval(callback: () => void, delay: number): number; clearInterval(id: number): void }
  const documentTarget = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState }
  documentTarget.visibilityState = 'visible'
  const navigatorTarget = { onLine: true }
  let tick!: () => void
  let interval: number
  let cleared = false
  let time = 0
  let calls = 0
  windowTarget.setInterval = (callback, ms) => { tick = callback; interval = ms; return 1 }
  windowTarget.clearInterval = (id: unknown) => { assert.equal(id, 1); cleared = true }
  const registration = { installing: null as object | null, update: () => { calls++; return update() } }
  const stop = watchServiceWorkerUpdates(registration, {
    windowTarget, documentTarget, navigatorTarget, now: () => time,
  })
  return {
    windowTarget, documentTarget, navigatorTarget, registration, stop,
    tick: () => tick(),
    advance: (ms: number) => { time += ms },
    calls: () => calls,
    interval: () => interval,
    cleared: () => cleared,
  }
}

const settle = async () => { await Promise.resolve(); await Promise.resolve() }

test('resuming a visible tab checks for a deployment and throttles repeated events', async () => {
  const env = setup()
  env.documentTarget.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(env.calls(), 1)
  env.windowTarget.dispatchEvent(new Event('pageshow'))
  await settle()
  assert.equal(env.calls(), 1)
  env.advance(60_000)
  env.windowTarget.dispatchEvent(new Event('pageshow'))
  await settle()
  assert.equal(env.calls(), 2)
})

test('periodic checks run every five minutes only while visible and online', async () => {
  const env = setup()
  assert.equal(env.interval(), 300_000)
  env.documentTarget.visibilityState = 'hidden'
  await env.tick()
  env.documentTarget.visibilityState = 'visible'
  env.navigatorTarget.onLine = false
  await env.tick()
  assert.equal(env.calls(), 0)
  env.navigatorTarget.onLine = true
  env.windowTarget.dispatchEvent(new Event('online'))
  await settle()
  assert.equal(env.calls(), 1)
  env.advance(300_000)
  await env.tick()
  assert.equal(env.calls(), 2)
})

test('an ongoing install or update check is not duplicated', async () => {
  let resolveUpdate!: () => void
  const env = setup(() => new Promise<void>(resolve => { resolveUpdate = resolve }))
  env.registration.installing = {}
  await env.tick()
  assert.equal(env.calls(), 0)
  env.registration.installing = null
  env.windowTarget.dispatchEvent(new Event('online'))
  env.documentTarget.dispatchEvent(new Event('visibilitychange'))
  assert.equal(env.calls(), 1)
  resolveUpdate()
  await settle()
})

test('a failed update check is silent and can retry when connectivity returns', async () => {
  const env = setup(async () => { throw new Error('network unavailable') })
  await env.tick()
  env.windowTarget.dispatchEvent(new Event('online'))
  await settle()
  assert.equal(env.calls(), 2)
})

test('disposing the watcher removes resume checks and the timer', async () => {
  const env = setup()
  env.stop()
  env.windowTarget.dispatchEvent(new Event('online'))
  env.windowTarget.dispatchEvent(new Event('pageshow'))
  env.documentTarget.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(env.calls(), 0)
  assert.equal(env.cleared(), true)
})

test('an unavailable registration is harmless', () => {
  assert.doesNotThrow(() => watchServiceWorkerUpdates(undefined, {
    windowTarget: null, documentTarget: null, navigatorTarget: null,
  })())
})

test('navigation does not race cached HTML against a slow successful network request', () => {
  const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
  const navigation = config.slice(config.indexOf("handler: 'NetworkFirst'"), config.indexOf("handler: 'CacheFirst'"))
  assert.ok(navigation.includes("cacheName: 'papertok-html'"))
  assert.doesNotMatch(navigation, /networkTimeoutSeconds\s*:/)
  assert.ok(navigation.includes('handlerDidError:'))
})

// Cache Storage as a browser holds it once a deploy's worker has activated.
// The cache names are Workbox's: its precache is `workbox-precache-v2-<scope>`.
const SCOPE = 'https://papertok.app/'
const PRECACHE = `workbox-precache-v2-${SCOPE}`
const OLD_ENTRY = 'https://papertok.app/assets/index-CfK2jTtr.js'
const NEW_ENTRY = 'https://papertok.app/assets/index-C43svN_0.js'

function cacheStorage(caches: Record<string, string[]>) {
  return {
    async match(request: RequestInfo | URL, options: MultiCacheQueryOptions = {}) {
      const key = (url: string) => (options.ignoreSearch ? url.split('?')[0] : url)
      const names = options.cacheName ? [options.cacheName] : Object.keys(caches)
      const found = names.some((name) => (caches[name] ?? []).some((url) => key(url) === key(String(request))))
      return found ? new Response('') : undefined
    },
  }
}

test('a page that booted the build the new worker precaches owes no reload', async () => {
  const storage = cacheStorage({ [PRECACHE]: [NEW_ENTRY, `${SCOPE}favicon.svg?__WB_REVISION__=b01d`] })
  assert.equal(await runsPrecachedBuild(NEW_ENTRY, SCOPE, storage), true)
  // Also when the entry was precached with a revision query.
  const revisioned = cacheStorage({ [PRECACHE]: [`${NEW_ENTRY}?__WB_REVISION__=1a2b`] })
  assert.equal(await runsPrecachedBuild(NEW_ENTRY, SCOPE, revisioned), true)
})

test('a tab still on the previous build is behind, even with its chunk in the runtime cache', async () => {
  // A page that booted a new build under the previous worker fetched its entry
  // chunk through the CacheFirst rule, so `papertok-assets` keeps it after the
  // precache has moved on to a later deploy.
  const storage = cacheStorage({ [PRECACHE]: [NEW_ENTRY], 'papertok-assets': [OLD_ENTRY] })
  assert.equal(await runsPrecachedBuild(OLD_ENTRY, SCOPE, storage), false)
})

test('an unreadable precache counts as behind instead of failing', async () => {
  const storage = { match: async () => { throw new Error('SecurityError') } }
  assert.equal(await runsPrecachedBuild(NEW_ENTRY, SCOPE, storage), false)
})

test('a deploy the page is behind on waits until the reader leaves the page they were on', () => {
  const online = true
  assert.equal(shouldReloadForDeploy(null, { pathname: '/feed', online }), false)
  assert.equal(shouldReloadForDeploy(null, { pathname: '/lists', online }), false)
  // Behind since /feed: re-renders and remounts on /feed do not reload.
  assert.equal(shouldReloadForDeploy('/feed', { pathname: '/feed', online }), false)
  assert.equal(shouldReloadForDeploy('/feed', { pathname: '/lists', online }), true)
  assert.equal(shouldReloadForDeploy('/feed', { pathname: '/public/paper/10.1234%2Fabc', online }), true)
})

test('offline, the deploy reload waits for a route change taken online', () => {
  // Behind since /feed, the reader taps Lists without a connection.
  assert.equal(shouldReloadForDeploy('/feed', { pathname: '/lists', online: false }), false)
  // That tap still left /feed, so /lists is now the page the reload waits on,
  // and leaving it online reloads, back to /feed included.
  assert.equal(shouldReloadForDeploy('/lists', { pathname: '/lists', online: true }), false)
  assert.equal(shouldReloadForDeploy('/lists', { pathname: '/following', online: true }), true)
  assert.equal(shouldReloadForDeploy('/lists', { pathname: '/feed', online: true }), true)
})

// What a tab sees when a deploy's worker claims it: `controllerchange` while
// the worker is still activating, then its `statechange` to `activated`.
function workerContainer() {
  const container = Object.assign(new EventTarget(), {
    controller: null as (EventTarget & { name: string; state: ServiceWorkerState }) | null,
  })
  const claim = (name: string) => {
    const worker = Object.assign(new EventTarget(), { name, state: 'activating' as ServiceWorkerState })
    container.controller = worker
    container.dispatchEvent(new Event('controllerchange'))
    return (state: ServiceWorkerState) => {
      worker.state = state
      worker.dispatchEvent(new Event('statechange'))
    }
  }
  return { container, claim }
}

test('every deploy that takes control of a long-lived tab is checked, once its worker has activated', () => {
  const { container, claim } = workerContainer()
  const checked: string[] = []
  watchWorkerActivations(container, () => checked.push(container.controller!.name))
  for (const name of ['B', 'C', 'D']) {
    const finish = claim(name)
    // The previous build's precache entries are still being deleted.
    assert.equal(checked.includes(name), false)
    finish('activated')
  }
  assert.deepEqual(checked, ['B', 'C', 'D'])
})

test('a worker that never finishes activating is not checked', () => {
  const { container, claim } = workerContainer()
  const checked: string[] = []
  watchWorkerActivations(container, () => checked.push(container.controller!.name))
  claim('B')('redundant')
  claim('C')('activated')
  assert.deepEqual(checked, ['C'])
})

function stubGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

// A tab on the old build whose new worker precaches the next one, as far as
// the module reads the browser: the location, the precache, the session
// storage that holds the forced-reload mark, and any open dialog.
function tabBehindDeploy(t: TestContext, pathname: string) {
  const tab = { pathname, reloads: 0, dialog: null as object | null, session: new Map<string, string>() }
  stubGlobal(t, 'window', {
    location: { get pathname() { return tab.pathname }, reload: () => { tab.reloads++ } },
    caches: cacheStorage({ [PRECACHE]: [NEW_ENTRY] }),
    sessionStorage: {
      getItem: (key: string) => tab.session.get(key) ?? null,
      setItem: (key: string, value: string) => { tab.session.set(key, value) },
      removeItem: (key: string) => { tab.session.delete(key) },
    },
  })
  stubGlobal(t, 'navigator', { onLine: true, serviceWorker: { ready: Promise.resolve({ scope: SCOPE }) } })
  stubGlobal(t, 'document', { querySelector: (selector: string) => (selector === '[aria-modal="true"]' ? tab.dialog : null) })
  return tab
}

test('a route-change reload waits until Firestore has acknowledged the writes already issued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tab = tabBehindDeploy(t, '/onboarding')
  await noteDeployActivated(OLD_ENTRY)

  // Finishing onboarding: the email opt-in is still unacknowledged when the
  // route moves to the feed.
  let acknowledge!: () => void
  const optIn = new Promise<void>((resolve) => { acknowledge = resolve })
  tab.pathname = '/feed'
  const reload = reloadIfBehindDeploy('/feed', () => optIn)
  await settle()
  assert.equal(tab.reloads, 0)
  acknowledge()
  await reload
  assert.equal(tab.reloads, 1)
  assert.ok(tab.session.has(APP_RELOAD_KEY), 'the reload is marked as the app\'s own')

  // The fake reload left the tab in place, still behind. A write that is not
  // acknowledged within a second holds the reload, unmarked, until the next
  // route change.
  tab.session.clear()
  tab.pathname = '/lists'
  const stalled = reloadIfBehindDeploy('/lists', () => new Promise(() => {}))
  t.mock.timers.tick(1_000)
  await stalled
  assert.equal(tab.reloads, 1)
  assert.equal(tab.session.has(APP_RELOAD_KEY), false)
  tab.pathname = '/following'
  await reloadIfBehindDeploy('/following', async () => {})
  assert.equal(tab.reloads, 2)

  // A paper opened while the writes settled holds it too.
  tab.pathname = '/feed'
  tab.dialog = {}
  await reloadIfBehindDeploy('/feed', async () => {})
  assert.equal(tab.reloads, 2)
  tab.dialog = null
  tab.pathname = '/lists'
  await reloadIfBehindDeploy('/lists', async () => {})
  assert.equal(tab.reloads, 3)
})
