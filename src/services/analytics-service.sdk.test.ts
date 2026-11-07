import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import type { PostHog } from 'posthog-js';
import { ANALYTICS_CONSENT, sanitizeAnalyticsCapture, startAnalyticsClient } from './analytics-service.ts';

/*
 * The installed posthog-js, started with the app's own options, in a browser
 * made of stubs. The SDK reads `window`, `navigator` and `fetch` once, when its
 * module loads, so they are stubbed before the import, in this file's own
 * process. Requests go to the stubbed `fetch` and `sendBeacon`: nothing leaves.
 * The SDK keeps timers running for as long as the page lives; they are unref'd
 * so this process can end.
 */
for (const name of ['setTimeout', 'setInterval'] as const) {
  const schedule: (callback: () => void, delay?: number) => NodeJS.Timeout = globalThis[name];
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (callback: () => void, delay?: number) => schedule(callback, delay).unref(),
  });
}

const browser = { userAgent: '', webdriver: false };
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, String(value)); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() { return store.size; },
};
const location = { hostname: 'papertok.app', host: 'papertok.app', protocol: 'https:', origin: 'https://papertok.app', href: 'https://papertok.app/feed', pathname: '/feed', search: '', hash: '' };
const unloadHandlers: Array<() => void> = [];
const requests: Array<{ url: string; body: Promise<Buffer> }> = [];
const element = () => ({ style: {}, setAttribute() {} });
const browserGlobals = {
  window: {
    location,
    addEventListener(type: string, handler: () => void) { if (type === 'pagehide' || type === 'beforeunload' || type === 'unload') unloadHandlers.push(handler); },
    removeEventListener() {},
    screen: { width: 1440, height: 900 },
    innerWidth: 1440,
    innerHeight: 900,
  },
  navigator: {
    get userAgent() { return browser.userAgent; },
    get webdriver() { return browser.webdriver; },
    language: 'en-GB',
    languages: ['en-GB'],
    onLine: true,
    vendor: 'Google Inc.',
    sendBeacon(url: string, body: Blob) {
      requests.push({ url, body: body.arrayBuffer().then(buffer => Buffer.from(buffer)) });
      return true;
    },
  },
  // The exception autocapture appends its script tag here, and nothing loads it.
  document: {
    cookie: '', location, referrer: '', title: 'PaperTok', readyState: 'complete', visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    createElement: element, head: { appendChild() {} }, body: { appendChild() {} },
  },
  location,
  localStorage: storage,
  sessionStorage: storage,
  fetch: (url: string, init: { body: BodyInit }) => {
    requests.push({ url, body: new Response(init.body).arrayBuffer().then(buffer => Buffer.from(buffer)) });
    return Promise.resolve(new Response('{}'));
  },
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(browserGlobals.window, name, { configurable: true, value });
  if (name !== 'window') Object.defineProperty(globalThis, name, { configurable: true, value });
}
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserGlobals.window });

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.91 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Mobile Safari/537.36';

/**
 * The SDK reads the user agent it reports when its module loads, while its
 * bot check reads the navigator at every capture. Each browser gets its own
 * copy of the module. Node resolves `posthog-js` to its CommonJS build
 * (`dist/main.js`); the app's browser bundle uses `dist/module.mjs` of the
 * same release.
 */
const requireModule = createRequire(import.meta.url);
function startSdk(userAgent: string) {
  browser.userAgent = userAgent;
  Reflect.deleteProperty(requireModule.cache, requireModule.resolve('posthog-js'));
  const { posthog } = requireModule('posthog-js') as { posthog: PostHog };
  startAnalyticsClient(posthog, ANALYTICS_CONSENT.ENABLED);
  return posthog;
}

const desktop = startSdk(DESKTOP);
const android = startSdk(ANDROID);

/** Leave the page so the SDK sends its queue, and read what it sent. */
async function leavePage() {
  for (const handler of unloadHandlers) handler();
  const sent = await Promise.all(requests.splice(0).map(async ({ url, body }) => {
    const bytes = await body;
    return { url, text: (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8') };
  }));
  return sent;
}

function captureAs(sdk: typeof desktop, userAgent: string, webdriver = false) {
  browser.userAgent = userAgent;
  browser.webdriver = webdriver;
  sdk.capture('$pageview');
}

test('the SDK runs the app\'s filter, and only the reduced user agent leaves the browser', async () => {
  for (const [sdk, userAgent, reduced] of [[desktop, DESKTOP, 'Chrome/130 (Mac OS X)'], [android, ANDROID, 'Chrome/130 (Android)']] as const) {
    assert.equal(sdk.config.before_send, sanitizeAnalyticsCapture, 'the app\'s options are the ones in use');
    captureAs(sdk, userAgent);
    const sent = await leavePage();
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /^\/ingest\//, 'to the app\'s own proxy path, here a stub');
    const events = (JSON.parse(sent[0].text) as { batch: Array<{ event: string; properties: Record<string, unknown> }> }).batch;
    assert.deepEqual(events.map(event => [event.event, event.properties.$raw_user_agent]), [['$pageview', reduced]]);
    for (const part of [userAgent, 'Mozilla', 'Macintosh', '10_15_7', 'AppleWebKit', 'KHTML', '6723', 'Android 14', 'SM-S918B', 'UP1A']) {
      assert.ok(!sent[0].text.includes(part), `"${part}" left the browser`);
    }
  }
});

test('the SDK still drops a webdriver or headless browser before the app\'s filter sees it', async () => {
  const filter = desktop.config.before_send;
  let filtered = 0;
  desktop.config.before_send = capture => {
    filtered += 1;
    return sanitizeAnalyticsCapture(capture);
  };
  try {
    captureAs(desktop, DESKTOP, true);
    captureAs(desktop, DESKTOP.replace('Chrome/', 'HeadlessChrome/'));
    assert.equal(filtered, 0, 'the bot check reads the browser\'s navigator, not the reduced string');
    assert.deepEqual(await leavePage(), []);

    captureAs(desktop, DESKTOP);
    assert.equal(filtered, 1, 'a person in the same browser still reaches the filter');
    const [sent] = await leavePage();
    assert.match(sent.text, /"\$raw_user_agent":"Chrome\/130 \(Mac OS X\)"/);
  } finally {
    desktop.config.before_send = filter;
  }
});
