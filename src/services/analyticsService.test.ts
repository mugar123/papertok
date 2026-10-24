import { markAppForcedReload, PRELOAD_RELOAD_KEY } from '../utils/appReload.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_CONSENT,
  ANALYTICS_CONSENT_COOKIE_KEY,
  ANALYTICS_CONSENT_KEY,
  inferAcquisitionChannel,
  markActivation,
  normalizeAnalyticsPath,
  persistAnalyticsConsent,
  readAnalyticsConsent,
  readStoredAnalyticsConsent,
  sanitizeAnalyticsCapture,
  sanitizeAnalyticsEventUrl,
  sanitizeAnalyticsLocation,
  sanitizeProductEventParams,
  sanitizeVercelEvent,
  setAnalyticsConsent,
  startAnalyticsClient,
  trackAcquisition,
  trackDay7Return,
} from './analyticsService.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

// Nobody is asked any more (2026-09-17): the analytics transport sets no cookies,
// so measurement is on unless the reader turns it off in Settings. An empty
// store therefore reads as granted, and only an explicit "denied" turns it off.
// The default is not written down -- it is not a choice, and a store that
// says "granted" must mean somebody said so.
test('reads as granted until an explicit choice is stored', () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.ANONYMOUS);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), null, 'the default must not be persisted as a choice');
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.ANONYMOUS, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.ANONYMOUS);
  assert.equal(persistAnalyticsConsent('unknown', storage), false);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.ANONYMOUS);
});

test('with neither storage nor cookie, consent is granted by default', t => {
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

  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ANONYMOUS);
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

  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.ANONYMOUS), true);
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ANONYMOUS);
  assert.equal(consentCookie, `${ANALYTICS_CONSENT_COOKIE_KEY}=${ANALYTICS_CONSENT.ANONYMOUS}`);
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
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.ANONYMOUS);
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
  assert.equal(normalizeAnalyticsPath('/public/paper/private-key'), '/public/paper/:id');
  assert.equal(normalizeAnalyticsPath('/public/list/private-key'), '/public/list/:id');
  // Profile pages are gone; an old link to one is a not-found page, and the
  // handle in it (a person) never reaches the report.
  assert.equal(normalizeAnalyticsPath('/public/user/private-handle?ref=share'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/public/entity/topic/private-key'), '/public/entity/topic/:id');
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

test('tracks acquisition once per browser session after consent', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const consentStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
  const localStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
    value: memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS }),
  });
  await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED);
  await setAnalyticsConsent(ANALYTICS_CONSENT.ANONYMOUS);
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
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
 * /privacy.html promises it never does: "Reading a specific paper is recorded
 * as /public/paper/:id [...] which one never travels. A search is recorded as
 * a search, with its type and how many results it returned, never with what
 * you searched for."
 *
 * Every route on this origin that carries something belonging to a reader is
 * here: the paper, the author, the list, the handle in an old profile link (a
 * person, not an id; the page is gone, so it files under /unknown) and the
 * search query (what they typed). None of them has a fragment any more.
 */
test('strips the identifier out of the real path before the page-view URL is sent', () => {
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
 * With the options in analyticsService.js every event carries the raw address
 * with the search in it and the words typed into a search engine, and page
 * views also carry the page title and the previous path. The referrer and
 * campaign ids appear only with other options, and are here so the allowlist is
 * tested against them too.
 */
function postHogCapture(event: string, properties: { search_type?: string; result_count?: number; has_results?: boolean; query?: string; $current_url?: string; $pathname?: string; kind?: string; message?: string; }) {
  return {
    uuid: '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d',
    event,
    timestamp: new Date('2026-10-15T08:00:00Z'),
    properties: {
      token: 'phc_test',
      distinct_id: '$posthog_cookieless',
      $cookieless_mode: true,
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
    ANALYTICS_CONSENT.ANONYMOUS,
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

test('an event keeps what PostHog needs to accept and count it without cookies', () => {
  const sent = sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.ANONYMOUS);
  // The server drops a cookieless event without the user agent or the host,
  // and the client drops one without its token. Without the cookieless
  // marker, every visitor would become one person.
  assert.equal(sent!.properties.token, 'phc_test');
  assert.equal(sent!.properties.distinct_id, '$posthog_cookieless');
  assert.equal(sent!.properties.$cookieless_mode, true);
  assert.equal(sent!.properties.$raw_user_agent, postHogCapture('$pageview', {}).properties.$raw_user_agent);
  assert.equal(sent!.properties.$host, 'papertok.app');
  assert.equal(sent!.uuid, '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d');
});

test('a page view on a paper is filed under the pattern, without the paper\'s title', () => {
  const sent = sanitizeAnalyticsCapture(
    postHogCapture('$pageview', { $current_url: 'https://papertok.app/public/paper/W2741809807', $pathname: '/public/paper/W2741809807' }),
    ANALYTICS_CONSENT.ANONYMOUS,
  );
  assert.equal(sent!.properties.$current_url, 'https://papertok.app/public/paper/:id');
  assert.equal(sent!.properties.$pathname, '/public/paper/:id');
  assert.equal(sent!.properties.title, undefined);
  assert.ok(!JSON.stringify(sent).includes('W2741809807'));
});

test('nothing leaves that is not a page view or a registered event, or once analytics is off', () => {
  for (const event of ['$autocapture', '$pageleave', '$exception', '$identify', 'made_up_event']) {
    assert.equal(sanitizeAnalyticsCapture(postHogCapture(event, {}), ANALYTICS_CONSENT.ANONYMOUS), null, event);
  }
  assert.equal(sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.DENIED), null);
  assert.equal(sanitizeAnalyticsCapture(null, ANALYTICS_CONSENT.ANONYMOUS), null);
});

test('a Vercel event leaves with the normalized address while analytics is on', () => {
  const sent = sanitizeVercelEvent(
    { type: 'pageview', url: 'https://papertok.app/public/paper/W2741809807' },
    ANALYTICS_CONSENT.ANONYMOUS,
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

/**
 * One configuration for both levels. Until the reader opts in, PostHog runs
 * cookieless and with no identity; replay masks every field, and every event
 * passes through the sanitizer. Only detailed consent opts in.
 */
function startedPostHog(consent: Parameters<typeof startAnalyticsClient>[1]) {
  const calls: unknown[] = [];
  let optedIn = false;
  startAnalyticsClient({
    init(_token, config) {
      calls.push(['init', {
        cookieless_mode: config.cookieless_mode,
        opt_out_capturing_by_default: config.opt_out_capturing_by_default,
        person_profiles: config.person_profiles,
        session_recording: config.session_recording,
        before_send: config.before_send,
      }]);
    },
    has_opted_in_capturing: () => optedIn,
    opt_in_capturing(options) {
      optedIn = true;
      calls.push(['opt_in_capturing', options]);
    },
    opt_out_capturing() {
      optedIn = false;
      calls.push(['opt_out_capturing']);
    },
  }, consent);
  return calls;
}

const PRIVATE_UNTIL_OPT_IN = ['init', {
  cookieless_mode: 'on_reject',
  opt_out_capturing_by_default: true,
  person_profiles: 'identified_only',
  session_recording: { maskAllInputs: true },
  before_send: sanitizeAnalyticsCapture,
}];

test('PostHog starts cookieless and stays anonymous without an opt-in', () => {
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.ANONYMOUS), [PRIVATE_UNTIL_OPT_IN]);
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.DENIED), [PRIVATE_UNTIL_OPT_IN]);
});

test('PostHog opts in, without an opt-in event, only for detailed consent', () => {
  assert.deepEqual(startedPostHog(ANALYTICS_CONSENT.DETAILED), [
    PRIVATE_UNTIL_OPT_IN,
    ['opt_in_capturing', { captureEventName: false }],
  ]);
});

test('a reader who opted in to detailed analytics sends events as PostHog built them', () => {
  const click = postHogCapture('$autocapture', { $current_url: 'https://papertok.app/public/paper/W2741809807' });
  assert.deepEqual(sanitizeAnalyticsCapture(click, ANALYTICS_CONSENT.DETAILED), click);
  assert.equal(sanitizeAnalyticsCapture(click, ANALYTICS_CONSENT.ANONYMOUS), null);
});

test('which paper and which search travel only at the detailed level', () => {
  const params = {
    surface: 'feed', destination: 'doi', position: 3,
    paper_id: ' W2741809807 ', paper_title: 'A'.repeat(400), url: 'https://example.com/private',
  };
  assert.deepEqual(sanitizeProductEventParams('paper_open', params, ANALYTICS_CONSENT.DETAILED), {
    surface: 'feed', destination: 'doi', position: 3, paper_id: 'W2741809807', paper_title: 'A'.repeat(300),
  });
  assert.deepEqual(sanitizeProductEventParams('paper_open', params, ANALYTICS_CONSENT.ANONYMOUS), {
    surface: 'feed', destination: 'doi', position: 3,
  });
  assert.equal(sanitizeProductEventParams('search_performed', { query: 'crispr' }, ANALYTICS_CONSENT.DETAILED).query, 'crispr');
});

test('time on a paper is whole seconds, and a tab left open counts four hours at most', () => {
  assert.equal(sanitizeProductEventParams('paper_dwell', { seconds: 12.4 }).seconds, 12);
  assert.equal(sanitizeProductEventParams('reader_time', { seconds: 1_000_000 }).seconds, 4 * 60 * 60);
  assert.equal(sanitizeProductEventParams('reader_time', { seconds: -3 }).seconds, 0);
});

test('the banner asks until a choice is stored, and the detailed choice is kept', () => {
  const storage = memoryStorage();
  assert.equal(readStoredAnalyticsConsent(storage), null);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.ANONYMOUS);
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.DETAILED, storage), true);
  assert.equal(readStoredAnalyticsConsent(storage), ANALYTICS_CONSENT.DETAILED);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.DETAILED);
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
  const sent = sanitizeAnalyticsCapture(capture, ANALYTICS_CONSENT.ANONYMOUS);
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
const crashReporterOfPage = async (page: string): Promise<typeof import('./analyticsService.ts').trackAppCrash> =>
  (await import(`./analyticsService.ts?page=${page}`)).trackAppCrash;

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
  const grantedStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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

  const failing = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
  assert.equal(await markActivation({ storage: failing, now: 1000, track: async () => false }), false);
  assert.equal(await markActivation({ storage: failing, now: 2000, track }), true, 'a failed send is retried');
});

test('a mark whose send has not finished is not stored as sent', async () => {
  // If the tab closes while PostHog is still loading, the send never settles,
  // and whatever storage says at that moment is what the next visit reads.
  // Nothing may say the mark left, or that visit would never send it.
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS });
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
    [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.ANONYMOUS,
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
