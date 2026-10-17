import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { watchServiceWorkerUpdates } from './serviceWorkerUpdates.ts'

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
