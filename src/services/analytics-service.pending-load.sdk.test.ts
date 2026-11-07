import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as PostHogModule from 'posthog-js';
import { ANALYTICS_CONSENT, setAnalyticsConsent, startAnalyticsClient, trackProductEvent } from './analytics-service.ts';

// The installed SDK, loaded through the module's own loader while the reader
// changes their mind. This file runs in its own process, so the SDK's globals
// stay here and the module has not loaded PostHog before the test starts.

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

test('turning analytics off and on while PostHog is still loading does not bring back the earlier browser identity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const local = memoryStorage();
  const session = memoryStorage();
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
    document, location, navigator, localStorage: local, sessionStorage: session, screen: {}, innerWidth: 1, innerHeight: 1,
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const globals = { window, document, location, navigator, localStorage: local, sessionStorage: session, fetch: async () => new Response('{}') };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }

  // An earlier visit stored a browser identity.
  const { PostHog, posthog } = createRequire(import.meta.url)('posthog-js') as typeof PostHogModule;
  const earlier = new PostHog();
  startAnalyticsClient(earlier, ANALYTICS_CONSENT.ENABLED);
  earlier.capture('paper_open', { surface: 'feed' });
  const earlierId = earlier.get_distinct_id();
  const storedAnywhere = (id: string) => [...local.values.values(), ...session.values.values(), jar.cookie]
    .some(value => value.includes(id));
  assert.ok(storedAnywhere(earlierId), 'the earlier visit stored its browser identity');

  // This page's first event starts loading PostHog, and the reader turns
  // analytics off and on again before it has loaded.
  const sending = trackProductEvent('paper_open', { surface: 'feed' });
  assert.equal(posthog.__loaded, false, 'PostHog is still loading');
  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), true);
  assert.equal(posthog.__loaded, false, 'PostHog is still loading when analytics is turned off');
  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.ENABLED), true);
  assert.equal(posthog.__loaded, false, 'PostHog is still loading when analytics is turned on again');

  assert.equal(await sending, true);
  assert.equal(posthog.__loaded, true);
  assert.notEqual(posthog.get_distinct_id(), earlierId, 'the load starts a new browser identity');
  assert.equal(storedAnywhere(earlierId), false, 'the earlier identity is not written back');
});
