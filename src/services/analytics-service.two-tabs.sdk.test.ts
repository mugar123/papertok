import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as PostHogModule from 'posthog-js';
import * as tabA from './analytics-service.ts';

// Two tabs of one browser share local storage and cookies and keep their own
// session storage. Tab A loaded the installed SDK through the module's own
// loader; tab B is a second instance of the module that never loaded it. This
// file runs in its own process, so the SDK's globals stay here.

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
}

function cookieJar(hostname: string) {
  const cookies = new Map<string, { name: string; value: string; domain: string }>();
  return {
    cookies,
    get cookie() { return [...cookies.values()].map(({ name, value }) => `${name}=${value}`).join('; '); },
    set cookie(written: string) {
      const [pair, ...attributes] = written.split(';').map(part => part.trim());
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      const attribute = (key: string) => attributes.find(part => part.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      const domain = (attribute('domain') ?? '').replace(/^\./, '').toLowerCase();
      if (domain && (!domain.includes('.') || !`.${hostname}`.endsWith(`.${domain}`))) return;
      const key = `${name}@${domain || hostname}`;
      const expired = attribute('max-age') === '0' || /1970/.test(attribute('expires') ?? '');
      if (expired) cookies.delete(key);
      else cookies.set(key, { name, value, domain: domain || hostname });
    },
  };
}

// The consent update reaches a loaded SDK once its promise settles.
const settle = () => new Promise(resolve => { setImmediate(resolve); });

test('a tab where PostHog never loaded turns analytics off, and the tab where it did forgets its identity for good', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const local = memoryStorage();
  const sessionA = memoryStorage();
  const sessionB = memoryStorage();
  const jar = cookieJar('www.papertok.app');
  const location = { hostname: 'www.papertok.app', host: 'www.papertok.app', protocol: 'https:', href: 'https://www.papertok.app/feed', origin: 'https://www.papertok.app', pathname: '/feed', search: '', hash: '' };
  const document = Object.assign(jar, {
    location, referrer: '', title: '', readyState: 'complete', visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {} }),
    querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
    body: { appendChild() {} }, head: { appendChild() {} },
  });
  const navigator = { userAgent: 'Mozilla/5.0', language: 'en', onLine: true };
  const window = {
    document, location, navigator, localStorage: local, sessionStorage: sessionA, screen: {}, innerWidth: 1, innerHeight: 1,
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const define = (name: string, value: unknown) => { Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const globals = { window, document, location, navigator, localStorage: local, sessionStorage: sessionA, fetch: async () => new Response('{}') };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    define(name, value);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  // The module reads session storage from the global at each call.
  const inTab = (session: typeof sessionA) => { define('sessionStorage', session); };
  const tabB: typeof tabA = await import(new URL('./analytics-service.ts?tab=b', import.meta.url).href);

  inTab(sessionA);
  assert.equal(await tabA.trackProductEvent('paper_open', { surface: 'feed' }), true);
  const { posthog } = createRequire(import.meta.url)('posthog-js') as typeof PostHogModule;
  const firstId = posthog.get_distinct_id();
  const storedAnywhere = (id: string) => [...local.values.values(), ...sessionA.values.values(), ...sessionB.values.values(), jar.cookie]
    .some(value => value.includes(id));
  assert.ok(storedAnywhere(firstId), 'tab A stored its browser identity');

  inTab(sessionB);
  assert.equal(await tabB.setAnalyticsConsent(tabB.ANALYTICS_CONSENT.DENIED), true);
  assert.equal(storedAnywhere(firstId), false, 'tab B removed the stored identity');

  // Tab A's PrivacyProvider answers the storage event with the stored choice.
  inTab(sessionA);
  assert.equal(await tabA.setAnalyticsConsent(tabA.readAnalyticsConsent()), true);
  await settle();
  assert.equal(posthog.is_capturing(), false);
  assert.notEqual(posthog.get_distinct_id(), firstId, 'tab A dropped the identity it held in memory');
  assert.equal(storedAnywhere(firstId), false);

  assert.equal(await tabA.setAnalyticsConsent(tabA.ANALYTICS_CONSENT.ENABLED), true);
  await settle();
  assert.equal(await tabA.trackProductEvent('paper_open', { surface: 'feed' }), true);
  assert.notEqual(posthog.get_distinct_id(), firstId, 'turning analytics on again starts a new browser identity');
  assert.equal(storedAnywhere(firstId), false, 'the old identity is not written back');
});
