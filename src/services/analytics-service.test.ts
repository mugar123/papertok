import { markAppForcedReload, PRELOAD_RELOAD_KEY } from '../utils/app-reload.ts';
import { getPublicPaperPath } from '../utils/public-navigation.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostHogConfig } from 'posthog-js';
import {
  ANALYTICS_CONSENT,
  ANALYTICS_CONSENT_COOKIE_KEY,
  ANALYTICS_CONSENT_KEY,
  inferAcquisitionChannel,
  identifyAnalyticsUser,
  markActivation,
  normalizeAnalyticsPath,
  persistAnalyticsConsent,
  readAnalyticsConsent,
  sanitizeAnalyticsCapture,
  sanitizeAnalyticsEventUrl,
  sanitizeAnalyticsLocation,
  sanitizeProductEventParams,
  sanitizeVercelEvent,
  setAnalyticsConsent,
  startAnalyticsClient,
  trackAcquisition,
  trackDay7Return,
  trackProductEvent,
} from './analytics-service.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

test('enables persistent analytics by default without storing a preference', () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.ENABLED);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), null, 'the default must not be persisted as a choice');
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.ENABLED, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.ENABLED);
  assert.equal(persistAnalyticsConsent('unknown', storage), false);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.ENABLED);
});

test('enables analytics by default when neither storage nor cookies are available', t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage unavailable'); },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
  });

  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Partial<typeof globalThis>).document;
  });

  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ENABLED);
});

test('remembers a denied analytics choice as an explicit decision', () => {
  const storage = memoryStorage();
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.DENIED, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.DENIED);
});

test('falls back to a consent cookie when browser storage is unavailable', t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  let consentCookie = '';

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage unavailable'); },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return consentCookie; },
      set cookie(value) { consentCookie = value.split(';')[0]; },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'https:' },
  });

  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Partial<typeof globalThis>).document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete (globalThis as Partial<typeof globalThis>).location;
  });

  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.ENABLED), true);
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ENABLED);
  assert.equal(consentCookie, `${ANALYTICS_CONSENT_COOKIE_KEY}=${ANALYTICS_CONSENT.ENABLED}`);
});

// A visitor's Privacy panel says "Not saved" on exactly this `false`. A browser
// that keeps neither the storage entry nor the cookie must not be told the
// choice took, and nothing about the stored choice may change.
test('a choice neither browser storage nor a cookie will keep is reported as not saved', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage unavailable'); },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return ''; },
      set cookie(_value) {},
    },
  });

  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Partial<typeof globalThis>).document;
  });

  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), false);
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ENABLED);
});

test('restores a previous consent decision from its cookie after a reload', t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: `${ANALYTICS_CONSENT_COOKIE_KEY}=${ANALYTICS_CONSENT.DENIED}` },
  });

  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Partial<typeof globalThis>).document;
  });

  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.DENIED);
});

test('normalizes entity identifiers and strips query strings from analytics paths', () => {
  assert.equal(normalizeAnalyticsPath('/explorer/institution/02f40zc51'), '/explorer/institution/:id');
  assert.equal(normalizeAnalyticsPath('/explorer/topic/quantum-mechanics?source=openalex'), '/explorer/topic/:id');
  assert.equal(normalizeAnalyticsPath('/explorer/author/alice#publications'), '/explorer/author/:id');
  assert.equal(normalizeAnalyticsPath('/research/'), '/research');
  assert.equal(normalizeAnalyticsPath('/'), '/');
});

test('names the routes that reach analytics through the static list', () => {
  assert.equal(normalizeAnalyticsPath('/profile'), '/profile');
  assert.equal(normalizeAnalyticsPath('/settings/profile'), '/settings/profile');
  assert.equal(normalizeAnalyticsPath('/report'), '/report');
});

test('maps unknown and malformed routes to a fixed analytics path', () => {
  assert.equal(normalizeAnalyticsPath('/paper/10.1234/private-id'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/explorer/person/private-id'), '/explorer/entity/:id');
  assert.equal(normalizeAnalyticsPath('/search/private-query'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/paper/private-key'), '/paper/:id');
  // The address a paper had before ENG-44: an earlier visit's stored values
  // still carry it.
  assert.equal(normalizeAnalyticsPath('/public/paper/private-key'), '/public/paper/:id');
  assert.equal(normalizeAnalyticsPath('/public/list/private-key'), '/public/list/:id');
  // Profile pages are gone; an old link to one is a not-found page, and the
  // handle in it (a person) never reaches the report.
  assert.equal(normalizeAnalyticsPath('/public/user/private-handle?ref=share'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/public/entity/topic/private-key'), '/public/entity/topic/:id');
});

test('a link PaperTok makes for a paper is recorded under one fixed path', () => {
  assert.equal(normalizeAnalyticsPath(getPublicPaperPath('arxiv', '2401.12345')!), '/paper/:id');
});

test('classifies acquisition without exposing the referring URL', () => {
  assert.equal(inferAcquisitionChannel({ referrer: '', location: { search: '', origin: 'https://papertok.test' } }), 'direct');
  assert.equal(inferAcquisitionChannel({
    referrer: 'https://www.google.com/search?q=private',
    location: { search: '', origin: 'https://papertok.test' },
  }), 'organic_search');
  assert.equal(inferAcquisitionChannel({
    referrer: 'https://x.com/private-profile',
    location: { search: '', origin: 'https://papertok.test' },
  }), 'organic_social');
  assert.equal(inferAcquisitionChannel({
    referrer: 'https://example.edu/private-path',
    location: { search: '?utm_medium=email&utm_campaign=private', origin: 'https://papertok.test' },
  }), 'email');
});

test('files a referrer by its whole host, not by a fragment of its name', () => {
  const channelOf = (referrer: string) => inferAcquisitionChannel({
    referrer,
    location: { search: '', origin: 'https://papertok.test' },
  });
  const expected: Record<string, string> = {
    // Search engines, including Google's country domains, its search properties
    // (Scholar, Books, Images, News) and its Android search and News apps.
    'https://google.com/': 'organic_search',
    'https://www.google.com/': 'organic_search',
    'https://www.google.co.uk/': 'organic_search',
    'https://www.google.com.br/': 'organic_search',
    'https://www.google.co.jp/': 'organic_search',
    'https://www.google.de/': 'organic_search',
    'https://www.google.cat/': 'organic_search',
    'https://scholar.google.com/': 'organic_search',
    'https://scholar.google.co.uk/': 'organic_search',
    'https://scholar.google.de/': 'organic_search',
    'https://books.google.com/': 'organic_search',
    'https://images.google.com/': 'organic_search',
    'https://news.google.com/': 'organic_search',
    'https://ipv6.google.com/': 'organic_search',
    'android-app://com.google.android.googlequicksearchbox/': 'organic_search',
    'android-app://com.google.android.apps.searchlite/': 'organic_search',
    'android-app://com.google.android.apps.magazines/': 'organic_search',
    'https://www.bing.com/': 'organic_search',
    'https://duckduckgo.com/': 'organic_search',
    'https://html.duckduckgo.com/': 'organic_search',
    'https://www.ecosia.org/': 'organic_search',
    'https://ecosia.org/': 'organic_search',
    'https://search.yahoo.com/': 'organic_search',
    'https://uk.search.yahoo.com/': 'organic_search',
    'https://search.yahoo.co.jp/': 'organic_search',
    'https://de.search.yahoo.com/': 'organic_search',
    'https://search.brave.com/': 'organic_search',
    // Social networks, short links and the YouTube and YouTube Music apps included.
    'https://t.co/abc': 'organic_social',
    'https://x.com/': 'organic_social',
    'https://www.x.com/': 'organic_social',
    'https://mobile.twitter.com/': 'organic_social',
    'https://l.facebook.com/': 'organic_social',
    'https://old.reddit.com/': 'organic_social',
    'https://m.youtube.com/': 'organic_social',
    'android-app://com.google.android.youtube/': 'organic_social',
    'android-app://com.google.android.apps.youtube.music/': 'organic_social',
    // Other Google products and sites whose name only contains a search or social host.
    'https://docs.google.com/': 'referral',
    'https://mail.google.com/': 'referral',
    'https://gemini.google.com/': 'referral',
    'https://google.org/': 'referral',
    'https://google.dev/': 'referral',
    'https://translate.google.com/': 'referral',
    'android-app://com.google.android.gm/': 'referral',
    // A package name is matched whole: another vendor's package can end with a Google app's.
    'android-app://net.example.com.google.android.youtube/': 'referral',
    'android-app://net.example.com.google.android.googlequicksearchbox/': 'referral',
    // Listed hosts do not apply to a package, nor packages to a web host.
    'android-app://evil.t.co/': 'referral',
    'android-app://com.example.x.com/': 'referral',
    'android-app://com.example.youtube.com/': 'referral',
    'android-app://com.example.facebook.com/': 'referral',
    'android-app://t.co/': 'referral',
    'https://com.google.android.youtube/': 'referral',
    'https://com.google.android.googlequicksearchbox/': 'referral',

    'https://notgoogle.example.org/': 'referral',
    'https://www.yahoo.com/': 'referral',
    'https://search.yahoo.example.org/': 'referral',
    'https://notsearch.yahoo.com/': 'referral',
    'https://search.yahoo.com.evil.example/': 'referral',
    // A suffix that only looks like a country: any three-letter or generic TLD,
    // and `co.com` / `com.com`, which anyone can register.
    'https://search.yahoo.xyz/': 'referral',
    'https://search.yahoo.net/': 'referral',
    'https://a.search.yahoo.top/': 'referral',
    'https://search.yahoo.co.com/': 'referral',
    'https://search.yahoo.com.com/': 'referral',
    'https://www.google.co.com/': 'referral',
    'https://www.google.com.com/': 'referral',
    'https://scholar.google.co.com/': 'referral',
    'https://google.com.cat/': 'referral',
    // A search engine's other sites link out too: only its search host is search.
    'https://brave.com/download/': 'referral',
    'https://community.brave.com/': 'referral',
    'https://blog.ecosia.org/': 'referral',
    'https://google.com.evil.example/': 'referral',
    'https://chatgpt.com/': 'referral',
    'https://copilot.microsoft.com/': 'referral',
    'https://teams.microsoft.com/': 'referral',
    'https://getpocket.com/': 'referral',
    'https://dropbox.com/': 'referral',
    'https://www.netflix.com/': 'referral',
    'https://news.ycombinator.com/': 'referral',
    'https://arxiv.org/abs/2401.00001': 'referral',
    // A trailing dot names the host differently (referral, decided 2026-10-25) and
    // upper case does not, for a listed host and for a pattern alike.
    'https://t.co./': 'referral',
    'https://www.google.com./': 'referral',
    'https://search.yahoo.com./': 'referral',
    'https://T.CO/abc': 'organic_social',
    'https://WWW.Google.CO.UK/': 'organic_search',
    'https://Search.Yahoo.Com/': 'organic_search',
  };

  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(referrer => [referrer, channelOf(referrer)])), expected);
});

test('tracks acquisition once per browser session after consent', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const consentStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  const sessionStorage = memoryStorage();
  const events: unknown[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: consentStorage });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  });

  const options = {
    language: 'en',
    storage: sessionStorage,
    referrer: 'https://www.google.com/search?q=private',
    location: { search: '', origin: 'https://papertok.test' },
    track: async (eventName: string, params?: Record<string, unknown>) => {
      events.push([eventName, params]);
      return true;
    },
  };

  assert.equal(await trackAcquisition(options), true);
  assert.equal(await trackAcquisition(options), false);
  assert.deepEqual(events, [['acquisition_view', {
    acquisition_channel: 'organic_search',
    language: 'en',
  }]]);
});

test('a session after activation says how long ago, in weeks rather than days', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const day = 24 * 60 * 60 * 1000;
  const localStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  });
  const sessionAt = async (now: number) => {
    let sent: Record<string, unknown> | undefined;
    await trackAcquisition({
      storage: memoryStorage(),
      referrer: '',
      location: { search: '', origin: 'https://papertok.test' },
      now,
      track: async (_eventName: string, params?: Record<string, unknown>) => {
        sent = params;
        return true;
      },
    });
    return sent?.activation_age;
  };

  assert.equal(await sessionAt(1000), undefined);
  await markActivation({ now: 1000, track: async () => true });
  assert.equal(await sessionAt(1000 + day - 1), 'day_0');
  assert.equal(await sessionAt(1000 + day), 'day_1');
  assert.equal(await sessionAt(1000 + 9 * day), 'days_7_13');
  assert.equal(await sessionAt(1000 + 400 * day), 'days_60_plus');
});

test('tracks acquisition once even when session storage is unavailable', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED }),
  });
  await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED);
  await setAnalyticsConsent(ANALYTICS_CONSENT.ENABLED);
  t.after(async () => {
    await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED);
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  });

  let events = 0;
  const options = {
    language: 'en',
    storage: null,
    track: async () => {
      events += 1;
      return true;
    },
  };

  assert.equal(await trackAcquisition(options), true);
  assert.equal(await trackAcquisition(options), false);
  assert.equal(events, 1);
});

test('retries activation if the analytics transport is temporarily unavailable', async () => {
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  let attempts = 0;
  const track = async () => {
    attempts += 1;
    return attempts > 1;
  };

  assert.equal(await markActivation({ storage, now: 1000, track }), false);
  assert.equal(await markActivation({ storage, now: 2000, track }), true);
  assert.equal(attempts, 2);
});

test('builds page locations from the sanitized path and origin only', () => {
  const location = {
    origin: 'https://papertok.example',
    pathname: '/private/user-id',
    search: '?email=reader@example.com',
    hash: '#secret',
  };

  assert.equal(
    sanitizeAnalyticsLocation('/explorer/project/private-id?name=Secret#details', location),
    'https://papertok.example/explorer/project/:id',
  );
  assert.equal(sanitizeAnalyticsLocation('/search?q=private', location), 'https://papertok.example/search');
});

/**
 * The URL PostHog attaches to every event, not one this app hands it. It
 * reads `location.href`, and since the router moved off the fragment that URL
 * carries the real entity id in the PATH -- so this is the function standing
 * between a paper id and a request leaving the browser. The policy published at
 * /privacy.html promises it never does: "Page addresses have query strings,
 * fragments and individual paper, list and profile identifiers removed."
 *
 * Every route on this origin that carries something belonging to a reader is
 * here: the paper, the author, the list, the handle in an old profile link (a
 * person, not an id; the page is gone, so it files under /unknown) and the
 * search query (what they typed). None of them has a fragment any more.
 */
test('strips the identifier out of the real path before the page-view URL is sent', () => {
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/paper/W2741809807'),
    'https://papertok.app/paper/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/public/paper/W2741809807'),
    'https://papertok.app/public/paper/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/explorer/author/a5023888391'),
    'https://papertok.app/explorer/author/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/public/list/private-list-key'),
    'https://papertok.app/public/list/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/public/user/nicolas'),
    'https://papertok.app/unknown',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/search?q=private+query'),
    'https://papertok.app/search',
  );
  // No fragment anywhere in the inputs above, and none in the outputs: an `#`
  // in a returned value would mean the id survived somewhere this reads past.
  for (const url of [
    'https://papertok.app/paper/W2741809807',
    'https://papertok.app/public/paper/W2741809807',
    'https://papertok.app/explorer/author/a5023888391',
    'https://papertok.app/public/list/private-list-key',
    'https://papertok.app/public/user/nicolas',
    'https://papertok.app/search?q=private+query',
  ]) {
    assert.ok(!url.includes('#'), `the input ${url} must be a real path, not a fragment route`);
    assert.ok(!sanitizeAnalyticsEventUrl(url).includes('#'), `no fragment may survive ${url}`);
  }
});

/**
 * The fragment form is the legacy one, kept because it still arrives: a link
 * minted before the router moved lands as `/#/public/paper/<id>`, and the
 * translation that turns it into a real route runs inside the app -- so
 * `location.href` can carry the fragment for the length of one page view.
 * Until no such link exists in the wild, this door stays shut too.
 */
test('strips the identifier out of the hash before the page-view URL is sent', () => {
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/#/public/paper/10.1234%2Fprivate-doi'),
    'https://papertok.app/public/paper/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/#/explorer/author/a5023888391'),
    'https://papertok.app/explorer/author/:id',
  );
  assert.equal(
    sanitizeAnalyticsEventUrl('https://papertok.app/#/search?q=private+query'),
    'https://papertok.app/search',
  );
  assert.equal(sanitizeAnalyticsEventUrl('https://papertok.app/#/'), 'https://papertok.app/');
});

test('falls back to the real path when there is no hash route, and never returns the input', () => {
  // The ordinary case since the router moved off the fragment, plus the pages
  // that were never routes at all (/privacy.html). None may arrive as a raw
  // string, and a path nobody named is `/unknown`, not itself.
  assert.equal(sanitizeAnalyticsEventUrl('https://papertok.app/'), 'https://papertok.app/');
  assert.equal(sanitizeAnalyticsEventUrl('https://papertok.app/lists'), 'https://papertok.app/lists');
  assert.equal(sanitizeAnalyticsEventUrl('https://papertok.app/some/private/path'), 'https://papertok.app/unknown');
  assert.equal(sanitizeAnalyticsEventUrl('not a url at all'), '/');
  assert.equal(sanitizeAnalyticsEventUrl(undefined), '/');
});

/**
 * What posthog-js 1.435.5 hands `before_send` (real keys, synthetic values).
 * With the options in analytics-service.ts every event carries the raw address
 * with the search in it and the words typed into a search engine, and page
 * views also carry the page title and the previous path. The referrer and
 * campaign ids appear only with other options, and are here so the allowlist is
 * tested against them too.
 */
function postHogCapture(event: string, properties: { search_type?: string; result_count?: number; has_results?: boolean; query?: string; $current_url?: string; $pathname?: string; kind?: string; message?: string; $exception_message?: string; $exception_list?: unknown[]; action?: string; view?: string; paper_id?: string; }) {
  return {
    uuid: '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d',
    event,
    timestamp: new Date('2026-10-15T08:00:00Z'),
    properties: {
      token: 'phc_test',
      distinct_id: 'browser-123',
      $device_id: 'device-123',
      $session_id: 'session-123',
      $cookieless_mode: false,
      $process_person_profile: false,
      $raw_user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      $host: 'papertok.app',
      $timezone: 'Europe/Madrid',
      $insert_id: 'k3x9q2',
      $time: 1792051200,
      $lib: 'web',
      $lib_version: '1.435.5',
      $browser: 'Chrome',
      $os: 'Mac OS X',
      $device_type: 'Desktop',
      $current_url: 'https://papertok.app/search?q=crispr+gene&utm_source=newsletter&gclid=abc123#frag',
      $pathname: '/search',
      title: 'CRISPR base editing in human embryos | PaperTok',
      $prev_pageview_pathname: '/public/paper/W999',
      $referrer: 'https://www.google.com/search?q=private+words',
      $referring_domain: 'www.google.com',
      $search_engine: 'google',
      ph_keyword: 'private words',
      utm_source: 'newsletter',
      gclid: 'abc123',
      $screen_height: 1117,
      $lib_custom_api_host: '/ingest',
      ...properties,
    },
    $set_once: { $initial_current_url: 'https://papertok.app/public/paper/W999' },
  };
}

test('an event leaves with the normalized address and nothing that names a paper, a person or a search', () => {
  const sent = sanitizeAnalyticsCapture(
    postHogCapture('search_performed', { search_type: 'papers', result_count: 12, has_results: true, query: 'crispr' }),
    ANALYTICS_CONSENT.ENABLED,
  );

  assert.equal(sent!.properties.$current_url, 'https://papertok.app/search');
  assert.equal(sent!.properties.$pathname, '/search');
  // The event's own schema still decides its parameters: `query` is not one.
  assert.equal(sent!.properties.search_type, 'papers');
  assert.equal(sent!.properties.result_count, 12);
  assert.equal(sent!.properties.has_results, true);

  const payload = JSON.stringify(sent);
  // The time zone is in the list too: it says roughly where the reader is.
  for (const secret of ['crispr', 'CRISPR', 'W999', 'private words', 'abc123', 'newsletter', 'google', 'Europe/Madrid']) {
    assert.ok(!payload.includes(secret), `"${secret}" left with the event`);
  }
  assert.equal(sent!.$set_once, undefined, 'no person properties travel');
});

test('preserves persistent identity and session fields without the raw user agent', () => {
  const sent = sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.ENABLED);
  assert.equal(sent!.properties.token, 'phc_test');
  assert.equal(sent!.properties.distinct_id, 'browser-123');
  assert.equal(sent!.properties.$device_id, 'device-123');
  assert.equal(sent!.properties.$session_id, 'session-123');
  assert.equal(sent!.properties.$cookieless_mode, false);
  assert.equal(sent!.properties.$raw_user_agent, undefined);
  assert.equal(sent!.properties.$host, 'papertok.app');
  assert.equal(sent!.uuid, '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d');
});

test('a page view on a paper is filed under the pattern, without the paper\'s title', () => {
  const sent = sanitizeAnalyticsCapture(
    postHogCapture('$pageview', { $current_url: 'https://papertok.app/public/paper/W2741809807', $pathname: '/public/paper/W2741809807' }),
    ANALYTICS_CONSENT.ENABLED,
  );
  assert.equal(sent!.properties.$current_url, 'https://papertok.app/public/paper/:id');
  assert.equal(sent!.properties.$pathname, '/public/paper/:id');
  assert.equal(sent!.properties.title, undefined);
  assert.ok(!JSON.stringify(sent).includes('W2741809807'));
});

test('an error report leaves with its type and code location, never its message or page', () => {
  const sent = sanitizeAnalyticsCapture(postHogCapture('$exception', {
    $current_url: 'https://papertok.app/public/paper/W2741809807',
    $exception_message: 'Cannot read W2741809807',
    $exception_list: [{
      type: 'TypeError', value: 'Cannot read W2741809807', mechanism: { handled: false, synthetic: false },
      stacktrace: { type: 'raw', frames: [{ platform: 'web:javascript', filename: 'https://papertok.app/assets/index-abc.js', function: 'render', lineno: 3, colno: 9, in_app: true }] },
    }],
  }), ANALYTICS_CONSENT.ENABLED);

  assert.equal(sent!.event, '$exception');
  assert.equal(sent!.properties.$current_url, 'https://papertok.app/public/paper/:id');
  assert.deepEqual(sent!.properties.$exception_list, [{
    type: 'TypeError',
    value: 'Application error (message redacted)',
    mechanism: { type: 'generic', handled: false, synthetic: false },
    stacktrace: { type: 'raw', frames: [{ platform: 'web:javascript', filename: 'https://papertok.app/assets/index-abc.js', function: 'render', in_app: true, lineno: 3, colno: 9 }] },
  }]);
  assert.equal(sent!.properties.distinct_id, 'browser-123');
  assert.ok(!JSON.stringify(sent).includes('W2741809807'));
  assert.equal(sanitizeAnalyticsCapture(postHogCapture('$exception', {}), ANALYTICS_CONSENT.ENABLED), null, 'no exception to report');
});

test('nothing leaves that is not a page view, an error or a registered event, or once analytics is off', () => {
  for (const event of ['$autocapture', '$pageleave', '$snapshot', 'made_up_event']) {
    assert.equal(sanitizeAnalyticsCapture(postHogCapture(event, {}), ANALYTICS_CONSENT.ENABLED), null, event);
  }
  assert.equal(sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.DENIED), null);
  assert.equal(sanitizeAnalyticsCapture(null, ANALYTICS_CONSENT.ENABLED), null);
});

test('a Vercel event leaves with the normalized address while analytics is on', () => {
  const sent = sanitizeVercelEvent(
    { type: 'pageview', url: 'https://papertok.app/public/paper/W2741809807' },
    ANALYTICS_CONSENT.ENABLED,
  );
  assert.deepEqual(sent, { type: 'pageview', url: 'https://papertok.app/public/paper/:id' });
});

test('a Vercel event is dropped once another tab has turned analytics off', t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // This tab rendered while analytics was on; the other tab then stored the
  // reader's refusal. The send reads that, not this tab's state.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.DENIED }),
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  });

  assert.equal(sanitizeVercelEvent({ type: 'pageview', url: 'https://papertok.app/feed' }), null);
});

function startedPostHog(consent: Parameters<typeof startAnalyticsClient>[1], alreadyEnabled = false) {
  const calls: unknown[] = [];
  let optedIn = alreadyEnabled;
  let config: Partial<PostHogConfig> | undefined;
  startAnalyticsClient({
    init(_token, options) { config = options; },
    has_opted_in_capturing: () => optedIn,
    opt_in_capturing(options) {
      optedIn = true;
      calls.push(['enable', options]);
    },
    opt_out_capturing() {
      optedIn = false;
      calls.push(['disable']);
    },
    reset(resetDeviceId) { calls.push(['reset', resetDeviceId]); },
  }, consent);
  return { calls, config };
}

test('enables persistent analytics with curated events and no session recordings', () => {
  const { calls, config } = startedPostHog(ANALYTICS_CONSENT.ENABLED);
  assert.deepEqual(calls, [['enable', { captureEventName: false }]]);
  assert.equal(config?.cookieless_mode, undefined);
  assert.equal(config?.persistence, 'localStorage+cookie');
  assert.equal(config?.opt_out_capturing_by_default, true);
  assert.equal(config?.opt_out_persistence_by_default, true);
  assert.equal(config?.advanced_disable_flags, true);
  assert.equal(config?.disable_surveys, true);
  assert.equal(config?.disable_product_tours, true);
  assert.equal(config?.disable_conversations, true);
  assert.equal(config?.save_campaign_params, false);
  assert.equal(config?.save_referrer, false);
  assert.equal(config?.person_profiles, 'identified_only');
  assert.equal(config?.autocapture, false);
  assert.equal(config?.disable_session_recording, true);
  assert.equal(config?.capture_pageview, false);
  assert.equal(config?.capture_pageleave, false);
  assert.equal(config?.capture_heatmaps, false);
  assert.equal(config?.capture_dead_clicks, false);
  assert.equal(config?.capture_performance, false);
});

test('leaves an enabled SDK identity intact on reload and disables a previously enabled SDK on opt-out', () => {
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.ENABLED, true).calls, []);
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.DENIED, true).calls, [['reset', true], ['disable']]);
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.DENIED).calls, []);
});

test('preserves the account merge event while stripping automatic profile properties', () => {
  const identify = {
    ...postHogCapture('$identify', {}),
    properties: {
      distinct_id: 'account-123', $anon_distinct_id: 'browser-123',
      $user_id: 'account-123', $device_id: 'device-123',
      $process_person_profile: true, $set: { email: 'reader@example.com' },
    },
  };
  const sent = sanitizeAnalyticsCapture(identify, ANALYTICS_CONSENT.ENABLED);
  assert.equal(sent?.event, '$identify');
  assert.equal(sent?.properties.distinct_id, 'account-123');
  assert.equal(sent?.properties.$anon_distinct_id, 'browser-123');
  assert.equal(sent?.properties.$user_id, 'account-123');
  assert.equal(sent?.properties.$device_id, 'device-123');
  assert.equal(sent?.properties.$process_person_profile, true);
  assert.equal(sent?.properties.$set, undefined);
  assert.equal(sent?.$set_once, undefined);
  assert.equal(sanitizeAnalyticsCapture(identify, ANALYTICS_CONSENT.DENIED), null);
});

test('tracks paper identifiers but drops titles, search text and arbitrary URLs', () => {
  const params = {
    surface: 'feed', destination: 'doi', position: 3,
    paper_id: ' W2741809807 ', paper_title: 'A'.repeat(400), url: 'https://example.com/private',
  };
  assert.deepEqual(sanitizeProductEventParams('paper_open', params, ANALYTICS_CONSENT.ENABLED), {
    surface: 'feed', destination: 'doi', position: 3, paper_id: 'W2741809807',
  });
  assert.deepEqual(sanitizeProductEventParams('paper_open', params, ANALYTICS_CONSENT.DENIED), {
    surface: 'feed', destination: 'doi', position: 3,
  });
  assert.deepEqual(sanitizeProductEventParams('search_performed', { query: 'crispr' }), {});
  assert.deepEqual(sanitizeProductEventParams('follow_change', {
    action: 'add', entity_type: 'author', entity_id: 'A123', entity_name: 'Author Name',
  }), { action: 'add', entity_type: 'author', entity_id: 'A123' });
  // ENG-123: a journal follow keeps its type, as the app sends it with no id.
  assert.deepEqual(sanitizeProductEventParams('follow_change', {
    action: 'add', entity_type: 'journal', surface: 'other', entity_name: 'American Economic Review',
  }), { action: 'add', entity_type: 'journal', surface: 'other' });
});

test('a feed load error says why it failed with fixed labels only', () => {
  assert.deepEqual(sanitizeProductEventParams('app_error', {
    kind: 'feed_load_failed', reason: 'rejected', status: 400, error_code: 'LANES_REQUIRED', message: 'Paper store returned 400',
  }), { kind: 'feed_load_failed', reason: 'rejected', status: 400, error_code: 'LANES_REQUIRED' });
  assert.deepEqual(sanitizeProductEventParams('app_error', {
    kind: 'feed_load_failed', reason: 'made up', error_code: 'Paper 10.1234/x not found',
  }), { kind: 'feed_load_failed', error_code: 'other' });
});

test('time on a paper is whole seconds, and a tab left open counts four hours at most', () => {
  assert.equal(sanitizeProductEventParams('paper_dwell', { seconds: 12.4 }).seconds, 12);
  assert.equal(sanitizeProductEventParams('reader_time', { seconds: 1_000_000 }).seconds, 4 * 60 * 60);
  assert.equal(sanitizeProductEventParams('reader_time', { seconds: -3 }).seconds, 0);
});

test('preserves previous refusals of persistent tracking and restores previous detailed preferences', () => {
  for (const value of ['granted', 'denied']) {
    assert.equal(readAnalyticsConsent(memoryStorage({ [ANALYTICS_CONSENT_KEY]: value })), 'denied');
  }
  assert.equal(readAnalyticsConsent(memoryStorage({ [ANALYTICS_CONSENT_KEY]: 'detailed' })), 'enabled');
  assert.equal(readAnalyticsConsent(memoryStorage({ [ANALYTICS_CONSENT_KEY]: 'unknown' })), 'enabled');
});

test('identifies accounts by UID only, resets between accounts, and ignores stale or opted-out identity changes', async t => {
  const { posthog } = await import('posthog-js');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let online = false;
  const storage = memoryStorage();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'papertok.app' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get onLine() { return online; } } });
  t.after(() => {
    for (const [name, previous] of [['window', previousWindow], ['location', previousLocation], ['localStorage', previousStorage], ['navigator', previousNavigator]] as const) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const changes: unknown[] = [];
  let identifiedAs: string | null = null;
  let enabled = false;
  const init = t.mock.method(posthog, 'init', () => posthog);
  t.mock.method(posthog, 'has_opted_in_capturing', () => enabled);
  t.mock.method(posthog, 'opt_in_capturing', () => { enabled = true; });
  t.mock.method(posthog, 'get_property', () => identifiedAs ? 'identified' : 'anonymous');
  t.mock.method(posthog, 'get_distinct_id', () => identifiedAs ?? 'browser-123');
  const identify = t.mock.method(posthog, 'identify', (uid: string) => {
    identifiedAs = uid;
    changes.push(['identify', uid]);
  });
  t.mock.method(posthog, 'reset', () => {
    identifiedAs = null;
    enabled = false;
    changes.push(['reset']);
  });

  await identifyAnalyticsUser(null);
  await identifyAnalyticsUser({ uid: 'offline-account' });
  assert.equal(init.mock.callCount(), 0, 'an offline identity update must not initialize the uncached SDK');
  assert.deepEqual(changes, []);

  online = true;
  await identifyAnalyticsUser(null);
  assert.equal(init.mock.callCount(), 1, 'initialization must still work after connectivity returns');
  await identifyAnalyticsUser({ uid: 'account-a' });
  await identifyAnalyticsUser({ uid: 'account-a' });
  assert.deepEqual(changes, [['identify', 'account-a']]);
  assert.deepEqual(identify.mock.calls[0].arguments, ['account-a']);

  await identifyAnalyticsUser({ uid: 'account-b' });
  await identifyAnalyticsUser(null);
  assert.deepEqual(changes.slice(1), [['reset'], ['identify', 'account-b'], ['reset']]);
  assert.equal(enabled, true, 'reset must be followed by enabling the SDK again');

  changes.length = 0;
  await Promise.all([identifyAnalyticsUser({ uid: 'stale-account' }), identifyAnalyticsUser({ uid: 'current-account' })]);
  assert.deepEqual(changes, [['identify', 'current-account']]);

  changes.length = 0;
  const pending = identifyAnalyticsUser({ uid: 'discarded-account' });
  storage.setItem(ANALYTICS_CONSENT_KEY, 'denied');
  await pending;
  await identifyAnalyticsUser({ uid: 'also-discarded' });
  assert.deepEqual(changes, []);

  const capturedAccounts: Array<string | null> = [];
  t.mock.method(posthog, 'capture', () => { capturedAccounts.push(identifiedAs); return undefined; });
  storage.setItem(ANALYTICS_CONSENT_KEY, 'enabled');
  await Promise.all([
    identifyAnalyticsUser({ uid: 'next-account' }),
    trackProductEvent('paper_open', { surface: 'feed' }),
  ]);
  await Promise.all([
    identifyAnalyticsUser(null),
    trackProductEvent('paper_open', { surface: 'feed' }),
  ]);
  assert.deepEqual(capturedAccounts, ['next-account', null], 'events follow the essential identity coordinator across account changes');
});

test('keeps only event-specific categorical and bounded analytics parameters', () => {
  assert.deepEqual(sanitizeProductEventParams('paper_open', {
    surface: 'feed',
    destination: 'doi',
    position: 12.6,
    title: 'A private paper title',
    paper_id: '10.1234/private',
    url: 'https://example.com/private',
  }), {
    surface: 'feed',
    destination: 'doi',
    position: 13,
    paper_id: '10.1234/private',
  });

  assert.deepEqual(sanitizeProductEventParams('search_performed', {
    search_type: 'papers',
    result_count: 50000,
    has_results: true,
    query: 'private search text',
    email: 'reader@example.com',
  }), {
    search_type: 'papers',
    result_count: 1000,
    has_results: true,
  });
});

test('drops unapproved events, parameter values, and arbitrary identity fields', () => {
  assert.deepEqual(sanitizeProductEventParams('paper_view', {
    surface: 'paper-by-private-id',
    position: Number.NaN,
    name: 'Reader Name',
  }), {});
  assert.deepEqual(sanitizeProductEventParams('custom_event', { surface: 'feed' }), {});
});

test('opening connections or similar papers records where and whether a graph can exist, never which paper', () => {
  assert.deepEqual(sanitizeProductEventParams('connections_open', {
    surface: 'feed', graph_available: false, paper_id: 'W2741809807', paper_title: 'A private title', doi: '10.1234/private',
  }, ANALYTICS_CONSENT.ENABLED), { surface: 'feed', graph_available: false });
  assert.deepEqual(sanitizeProductEventParams('connections_open', { surface: 'connections', graph_available: true }), { surface: 'connections', graph_available: true });
  assert.deepEqual(sanitizeProductEventParams('similar_open', { surface: 'similar', paper_id: 'W2741809807' }, ANALYTICS_CONSENT.ENABLED), { surface: 'similar' });
  assert.deepEqual(sanitizeProductEventParams('similar_open', { surface: 'paper-W2741809807' }), {});
});

test('what a reader does in the connections map is one of six actions in the map or the list', () => {
  for (const action of ['select_node', 'centre', 'back', 'switch_view', 'export', 'open_paper']) {
    assert.deepEqual(sanitizeProductEventParams('connections_interact', { action, view: 'list' }), { action, view: 'list' });
  }
  assert.deepEqual(sanitizeProductEventParams('connections_interact', {
    action: 'drag', view: 'grid', paper_id: 'W2741809807', node: 'Smith 2019',
  }, ANALYTICS_CONSENT.ENABLED), {});

  const capture = postHogCapture('connections_interact', { action: 'open_paper', view: 'map', paper_id: 'W2741809807' });
  const sent = sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.ENABLED);
  assert.equal(sent?.event, 'connections_interact');
  assert.equal(sent?.properties.action, 'open_paper');
  assert.equal(sent?.properties.view, 'map');
  assert.ok(!JSON.stringify(sent).includes('W2741809807'));
  assert.equal(sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.DENIED), null);
});

test('connections and similar are allowed surfaces for paper events', () => {
  for (const surface of ['connections', 'similar']) {
    assert.deepEqual(sanitizeProductEventParams('paper_open', { surface, destination: 'pdf', position: 2 }), { surface, destination: 'pdf', position: 2 });
    assert.deepEqual(sanitizeProductEventParams('paper_view', { surface, position: 0 }), { surface, position: 0 });
    assert.deepEqual(sanitizeProductEventParams('paper_dwell', { surface, seconds: 9 }), { surface, seconds: 9 });
    assert.deepEqual(sanitizeProductEventParams('save_change', { action: 'add', surface }), { action: 'add', surface });
  }
});

test('an app error leaves with its kind and nothing from the error, and not at all once analytics is off', () => {
  for (const kind of ['render_crash', 'chunk_load_failed', 'feed_load_failed']) {
    assert.deepEqual(sanitizeProductEventParams('app_error', {
      kind,
      message: 'Cannot read properties of undefined',
      stack: 'TypeError at PaperCard (https://papertok.app/assets/index-abc.js:1:2)',
      url: 'https://papertok.app/public/paper/W999',
      surface: 'feed',
    }), { kind });
  }
  assert.deepEqual(sanitizeProductEventParams('app_error', { kind: 'TypeError: x is undefined' }), {});

  const capture = postHogCapture('app_error', { kind: 'render_crash', message: 'private words' });
  const sent = sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.ENABLED);
  assert.equal(sent?.event, 'app_error');
  assert.equal(sent?.properties.kind, 'render_crash');
  assert.equal(sent?.properties.$current_url, 'https://papertok.app/search');
  assert.ok(!JSON.stringify(sent).includes('private words'));
  assert.equal(sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.DENIED), null);
});

test('reader results keep outcomes, cache status and duration without paper or error content', () => {
  assert.deepEqual(sanitizeProductEventParams('paper_rewrite_result', {
    level: 'university', surface: 'reader', result: 'error', cached: false,
    duration_ms: 32_456.7, error_code: 'AI_TIMEOUT',
    title: 'Private paper', paper_id: 'W123', message: 'Private provider response',
  }), {
    level: 'university', surface: 'reader', result: 'error', cached: false,
    duration_ms: 32_457, error_code: 'AI_TIMEOUT',
  });
  assert.deepEqual(sanitizeProductEventParams('paper_rewrite_result', {
    result: 'incomplete', duration_ms: Infinity, error_code: 'Private error text',
  }), { result: 'incomplete', error_code: 'other' });
  assert.deepEqual(sanitizeProductEventParams('reader_open', { surface: 'reader', title: 'Private' }), { surface: 'reader' });
});

test('authentication outcomes retain GitHub and known failures without identity details', () => {
  assert.deepEqual(sanitizeProductEventParams('auth_result', {
    method: 'github', surface: 'auth_prompt', result: 'cancelled',
    error_code: 'auth/popup-closed-by-user', email: 'private@example.com', uid: 'private',
  }), {
    method: 'github', surface: 'auth_prompt', result: 'cancelled', error_code: 'auth/popup-closed-by-user',
  });
  assert.deepEqual(sanitizeProductEventParams('auth_result', {
    result: 'error', error_code: 'private@example.com',
  }), { result: 'error', error_code: 'other' });
  assert.deepEqual(sanitizeProductEventParams('auth_prompt_view', {
    reason: 'related', surface: 'auth_prompt', paper_id: 'W123',
  }), { reason: 'related', surface: 'auth_prompt' });
  assert.deepEqual(sanitizeProductEventParams('select_content', {
    content_type: 'signup_cta', method: 'github', surface: 'auth_prompt',
  }), { content_type: 'signup_cta', surface: 'auth_prompt', method: 'github' });
});

// Each import with its own query is a separate copy of the module, which is
// what the error boundary gets on a new page load.
const crashReporterOfPage = async (page: string): Promise<typeof import('./analytics-service.ts').trackAppCrash> =>
  (await import(`./analytics-service.ts?page=${page}`)).trackAppCrash;

function recordingTrack() {
  const events: [string, Record<string, unknown> | undefined][] = [];
  const track = async (eventName: string, params?: Record<string, unknown>) => {
    events.push([eventName, params]);
    return true;
  };
  return { events, track };
}

test('a page load reports one crash, however often the error boundary catches', async () => {
  const trackAppCrash = await crashReporterOfPage('crashed');
  const { events, track } = recordingTrack();
  const storage = memoryStorage();
  const pageLoadedAt = 1_000_000;

  assert.equal(await trackAppCrash({ storage, now: pageLoadedAt + 5_000, pageLoadedAt, track }), true);
  assert.equal(await trackAppCrash({ storage, now: pageLoadedAt + 6_000, pageLoadedAt, track }), false);
  assert.deepEqual(events, [['app_error', { kind: 'render_crash' }]]);
});

test('after a reload for a missing chunk, the reloaded page reports a chunk failure and the page it replaced reports nothing', async () => {
  const { events, track } = recordingTrack();
  const storage = memoryStorage();
  const firstLoad = 1_000_000;
  const reloadedAt = firstLoad + 30_000;
  // main.tsx's `vite:preloadError` handler leaves both marks before it reloads.
  storage.setItem(PRELOAD_RELOAD_KEY, String(reloadedAt));
  markAppForcedReload({ storage, now: reloadedAt });

  // The page main.tsx is reloading can crash on the chunk it could not load
  // before it unloads. The reload is the answer to that, not a failure yet.
  const leavingPage = await crashReporterOfPage('leaving');
  assert.equal(await leavingPage({ storage, now: reloadedAt + 50, pageLoadedAt: firstLoad, track }), false);

  const reloadedPage = await crashReporterOfPage('reloaded');
  await reloadedPage({ storage, now: reloadedAt + 2_000, pageLoadedAt: reloadedAt + 500, track });

  const laterPage = await crashReporterOfPage('later');
  await laterPage({ storage, now: reloadedAt + 10 * 60_000, pageLoadedAt: reloadedAt + 9 * 60_000, track });

  assert.deepEqual(events.map(([, params]) => params?.kind), ['chunk_load_failed', 'render_crash']);
});

test('marks activation only after consent and only once', async () => {
  const deniedStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.DENIED });
  const grantedStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  const events: unknown[] = [];
  const track = async (eventName: string) => {
    events.push(eventName);
    return true;
  };

  assert.equal(await markActivation({ storage: deniedStorage, now: 1000, track }), false);
  assert.equal(await markActivation({ storage: grantedStorage, now: 1000, track }), true);
  assert.equal(await markActivation({ storage: grantedStorage, now: 2000, track }), false);
  assert.deepEqual(events, ['activation']);
});

test('tracks a day-7 return at the boundary and only once', async () => {
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  const events: unknown[] = [];
  const track = async (eventName: string) => {
    events.push(eventName);
    return true;
  };
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  await markActivation({ storage, now: 1000, track });
  assert.equal(await trackDay7Return({ storage, now: 1000 + sevenDays - 1, track }), false);
  assert.equal(await trackDay7Return({ storage, now: 1000 + sevenDays, track }), true);
  assert.equal(await trackDay7Return({ storage, now: 1000 + sevenDays + 1, track }), false);
  assert.deepEqual(events, ['activation', 'day_7_return']);
});

/**
 * The first event of a page waits for PostHog to load, so two calls can be in
 * flight at once: opening `/` asks on the way in and again after the redirect
 * to `/feed`. Each mark still has to leave once, and stay unsent when the send
 * fails.
 */
test('a mark asked for twice while the first send is still waiting leaves once', async () => {
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  const events: unknown[] = [];
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  const track = async (eventName: string) => {
    events.push(eventName);
    await loaded;
    return true;
  };
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const activations = [markActivation({ storage, now: 1000, track }), markActivation({ storage, now: 1000, track })];
  release();
  assert.deepEqual(await Promise.all(activations), [true, false]);

  const returns = [
    trackDay7Return({ storage, now: 1000 + sevenDays, track }),
    trackDay7Return({ storage, now: 1000 + sevenDays, track }),
  ];
  assert.deepEqual(await Promise.all(returns), [true, false]);
  assert.deepEqual(events, ['activation', 'day_7_return']);

  const failing = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  assert.equal(await markActivation({ storage: failing, now: 1000, track: async () => false }), false);
  assert.equal(await markActivation({ storage: failing, now: 2000, track }), true, 'a failed send is retried');
});

test('a mark whose send has not finished is not stored as sent', async () => {
  // If the tab closes while PostHog is still loading, the send never settles,
  // and whatever storage says at that moment is what the next visit reads.
  // Nothing may say the mark left, or that visit would never send it.
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED });
  let settle!: (sent: boolean) => void;
  const pending = markActivation({ storage, now: 1000, track: () => new Promise(resolve => { settle = resolve; }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(storage.getItem('papertok_analytics_activation_sent'), null);
  settle(false);
  assert.equal(await pending, false);
});

test('clears consent-scoped activation state when consent is denied', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const storage = memoryStorage({
    [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ENABLED,
    papertok_analytics_activation_at: '1000',
    papertok_analytics_activation_sent: 'true',
    papertok_analytics_day_7_return_sent: 'true',
  });
  let consentCookie = '';

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return consentCookie; },
      set cookie(value) { consentCookie = value.split(';')[0]; },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'https:' },
  });

  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Partial<typeof globalThis>).document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete (globalThis as Partial<typeof globalThis>).location;
  });

  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), true);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.DENIED);
  assert.equal(storage.getItem('papertok_analytics_activation_at'), null);
  assert.equal(storage.getItem('papertok_analytics_activation_sent'), null);
  assert.equal(storage.getItem('papertok_analytics_day_7_return_sent'), null);
});

test('feed timing fields contain bounded measurements and deployment identifiers, never content', () => {
  const params = {
    load_type: 'initial', attempt: 'original', first_screen: true, duration_ms: 2175.8,
    result: 'success', degraded: false, client_release: '046af7e9a49ddab9114e7055c51d00316091c4bf',
    worker_version: 'bc13c637-c9af-4b4e-92a2-c4b3e9380a57',
    paper_id: 'W123', interests: ['oncology'], user_id: 'private', message: 'secret',
  };
  assert.deepEqual(sanitizeProductEventParams('feed_load_result', params), {
    load_type: 'initial', attempt: 'original', first_screen: true, duration_ms: 2176,
    result: 'success', degraded: false, client_release: '046af7e9a49ddab9114e7055c51d00316091c4bf',
    worker_version: 'bc13c637-c9af-4b4e-92a2-c4b3e9380a57',
  });
  assert.deepEqual(sanitizeProductEventParams('feed_load_result', {
    load_type: 'private text', attempt: 'user@example.com', result: 'private error', duration_ms: NaN,
    client_release: 'user@example.com', worker_version: 'private release tag', error_code: 'private details',
  }), { error_code: 'other' });
  assert.equal(sanitizeProductEventParams('feed_load_result', { duration_ms: 9_000_000 }).duration_ms, 3_600_000);
  for (const event of ['feed_load_started', 'feed_load_result']) {
    const capture = postHogCapture(event, params);
    assert.equal(sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.ENABLED)?.event, event);
    assert.equal(sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.DENIED), null);
  }
});
