import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runsPrecachedBuild, shouldReloadForDeploy, watchServiceWorkerUpdates } from './serviceWorkerUpdates.ts'

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
