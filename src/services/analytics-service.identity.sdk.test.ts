import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as PostHogModule from 'posthog-js';
import { ANALYTICS_CONSENT, ANALYTICS_CONSENT_KEY, clearStoredIdentityWhileAnalyticsOff, setAnalyticsConsent, startAnalyticsClient } from './analytics-service.ts';

// The installed SDK, run against a minimal browser: the storage names
// `removePostHogIdentity` clears are the ones this posthog-js really writes.
// This file runs in its own process, so the SDK's globals stay here.

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

// Cookies are kept per name and domain, as a browser does, and a domain that
// is a public suffix (`.app`) is refused, so the SDK settles on `.papertok.app`.
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

test('turning analytics off where PostHog never loaded removes the identity it stored, and the next start is a new browser', async t => {
  // The SDK's flush and session timers would otherwise keep the process open.
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

  const { PostHog } = createRequire(import.meta.url)('posthog-js') as typeof PostHogModule;
  const before = new PostHog();
  startAnalyticsClient(before, ANALYTICS_CONSENT.ENABLED);
  before.capture('paper_open', { surface: 'feed' });
  const firstId = before.get_distinct_id();

  const token = /^ph_(.+)_posthog$/.exec([...local.values.keys()].find(key => key.startsWith('ph_')) ?? '')?.[1];
  assert.ok(token, 'PostHog stored its state in local storage');
  const stored = () => [
    ...[...local.values.keys()].filter(key => key.includes(token)).map(key => `local:${key}`),
    ...[...session.values.keys()].filter(key => key.includes(token)).map(key => `session:${key}`),
    ...[...jar.cookies.values()].filter(({ name }) => name.includes(token)).map(({ name, domain }) => `cookie:${name}@${domain}`),
  ].sort();
  assert.deepEqual(stored(), [
    `cookie:ph_${token}_posthog@papertok.app`,
    `local:__ph_opt_in_out_${token}`,
    `local:ph_${token}_posthog`,
    `session:ph_${token}_posthog`,
    `session:ph_${token}_session_registered_properties`,
    `session:ph_${token}_window_id`,
  ]);
  assert.ok(jar.cookie.includes(firstId), 'the cookie carries the browser identity');

  // A new page: the module never loaded PostHog, and the reader turns analytics off.
  local.setItem('papertok_analytics_consent_changes', '1');
  local.setItem('papertok_theme', 'dark');
  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), true);
  assert.deepEqual(stored(), []);
  // Only PostHog's state goes: the choice, its change count and the app's own keys stay.
  assert.equal(local.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.DENIED);
  assert.equal(local.getItem('papertok_analytics_consent_changes'), '2');
  assert.equal(local.getItem('papertok_theme'), 'dark');

  local.setItem(ANALYTICS_CONSENT_KEY, ANALYTICS_CONSENT.ENABLED);
  const after = new PostHog();
  startAnalyticsClient(after, ANALYTICS_CONSENT.ENABLED);
  assert.notEqual(after.get_distinct_id(), firstId);

  // Analytics was turned off under an earlier build that left the identity
  // behind; the next start removes it although no one turns analytics off again.
  assert.ok(stored().length > 0, 'the new start stored an identity again');
  // While analytics is on, the cleanup leaves the identity alone.
  const whileEnabled = stored();
  clearStoredIdentityWhileAnalyticsOff();
  assert.deepEqual(stored(), whileEnabled);
  local.setItem(ANALYTICS_CONSENT_KEY, ANALYTICS_CONSENT.DENIED);
  clearStoredIdentityWhileAnalyticsOff();
  assert.deepEqual(stored(), []);
});
