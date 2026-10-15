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
  PRODUCT_ANALYTICS_EVENTS,
  readAnalyticsConsent,
  sanitizeAnalyticsCapture,
  sanitizeAnalyticsEventUrl,
  sanitizeAnalyticsLocation,
  sanitizeProductEventParams,
  sanitizeVercelEvent,
  setAnalyticsConsent,
  trackAcquisition,
  trackDay7Return,
} from './analyticsService.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

// Nobody is asked any more (2026-09-17): the analytics transport sets no cookies,
// so measurement is on unless the reader turns it off in Settings. An empty
// store therefore reads as granted, and only an explicit "denied" turns it off.
// The default is not written down -- it is not a choice, and a store that
// says "granted" must mean somebody said so.
test('reads as granted until an explicit choice is stored', () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.GRANTED);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), null, 'the default must not be persisted as a choice');
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.GRANTED, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.GRANTED);
  assert.equal(persistAnalyticsConsent('unknown', storage), false);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.GRANTED);
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
    else delete globalThis.localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });

  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.GRANTED);
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
    else delete globalThis.localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });

  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.GRANTED), true);
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.GRANTED);
  assert.equal(consentCookie, `${ANALYTICS_CONSENT_COOKIE_KEY}=${ANALYTICS_CONSENT.GRANTED}`);
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
    else delete globalThis.localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });

  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), false);
  assert.equal(readAnalyticsConsent(), ANALYTICS_CONSENT.GRANTED);
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
    else delete globalThis.localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
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
  assert.equal(normalizeAnalyticsPath('/settings/comments'), '/settings/comments');
  assert.equal(normalizeAnalyticsPath('/admin/moderation'), '/admin/moderation');
  assert.equal(normalizeAnalyticsPath('/report'), '/report');
  assert.equal(normalizeAnalyticsPath('/public/user/nicolas?ref=share'), '/public/user/:handle');
});

test('maps unknown and malformed routes to a fixed analytics path', () => {
  assert.equal(normalizeAnalyticsPath('/paper/10.1234/private-id'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/explorer/person/private-id'), '/explorer/entity/:id');
  assert.equal(normalizeAnalyticsPath('/search/private-query'), '/unknown');
  assert.equal(normalizeAnalyticsPath('/public/paper/private-key'), '/public/paper/:id');
  assert.equal(normalizeAnalyticsPath('/public/list/private-key'), '/public/list/:id');
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
  const consentStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  const sessionStorage = memoryStorage();
  const events = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: consentStorage });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });

  const options = {
    language: 'en',
    storage: sessionStorage,
    referrer: 'https://www.google.com/search?q=private',
    location: { search: '', origin: 'https://papertok.test' },
    track: async (eventName, params) => {
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

test('tracks acquisition once even when session storage is unavailable', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED }),
  });
  await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED);
  await setAnalyticsConsent(ANALYTICS_CONSENT.GRANTED);
  t.after(async () => {
    await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED);
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
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
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
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
 * here: the paper, the author, the list, the handle (a person, not an id) and
 * the search query (what they typed). None of them has a fragment any more.
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
    'https://papertok.app/public/user/:handle',
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
function postHogCapture(event, properties) {
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
    ANALYTICS_CONSENT.GRANTED,
  );

  assert.equal(sent.properties.$current_url, 'https://papertok.app/search');
  assert.equal(sent.properties.$pathname, '/search');
  // The event's own schema still decides its parameters: `query` is not one.
  assert.equal(sent.properties.search_type, 'papers');
  assert.equal(sent.properties.result_count, 12);
  assert.equal(sent.properties.has_results, true);

  const payload = JSON.stringify(sent);
  // The time zone is in the list too: it says roughly where the reader is.
  for (const secret of ['crispr', 'CRISPR', 'W999', 'private words', 'abc123', 'newsletter', 'google', 'Europe/Madrid']) {
    assert.ok(!payload.includes(secret), `"${secret}" left with the event`);
  }
  assert.equal(sent.$set_once, undefined, 'no person properties travel');
});

test('an event keeps what PostHog needs to accept and count it without cookies', () => {
  const sent = sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.GRANTED);
  // The server drops a cookieless event without the user agent or the host,
  // and the client drops one without its token. Without the cookieless
  // marker, every visitor would become one person.
  assert.equal(sent.properties.token, 'phc_test');
  assert.equal(sent.properties.distinct_id, '$posthog_cookieless');
  assert.equal(sent.properties.$cookieless_mode, true);
  assert.equal(sent.properties.$raw_user_agent, postHogCapture('$pageview', {}).properties.$raw_user_agent);
  assert.equal(sent.properties.$host, 'papertok.app');
  assert.equal(sent.uuid, '0199c5a1-7f3e-7c4a-9d2b-1f6e8a4b3c2d');
});

test('a page view on a paper is filed under the pattern, without the paper\'s title', () => {
  const sent = sanitizeAnalyticsCapture(
    postHogCapture('$pageview', { $current_url: 'https://papertok.app/public/paper/W2741809807', $pathname: '/public/paper/W2741809807' }),
    ANALYTICS_CONSENT.GRANTED,
  );
  assert.equal(sent.properties.$current_url, 'https://papertok.app/public/paper/:id');
  assert.equal(sent.properties.$pathname, '/public/paper/:id');
  assert.equal(sent.properties.title, undefined);
  assert.ok(!JSON.stringify(sent).includes('W2741809807'));
});

test('nothing leaves that is not a page view or a registered event, or once analytics is off', () => {
  for (const event of ['$autocapture', '$pageleave', '$exception', '$identify', 'made_up_event']) {
    assert.equal(sanitizeAnalyticsCapture(postHogCapture(event, {}), ANALYTICS_CONSENT.GRANTED), null, event);
  }
  assert.equal(sanitizeAnalyticsCapture(postHogCapture('$pageview', {}), ANALYTICS_CONSENT.DENIED), null);
  assert.equal(sanitizeAnalyticsCapture(null, ANALYTICS_CONSENT.GRANTED), null);
});

test('a Vercel event leaves with the normalized address while analytics is on', () => {
  const sent = sanitizeVercelEvent(
    { type: 'pageview', url: 'https://papertok.app/public/paper/W2741809807' },
    ANALYTICS_CONSENT.GRANTED,
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
    else delete globalThis.localStorage;
  });

  assert.equal(sanitizeVercelEvent({ type: 'pageview', url: 'https://papertok.app/feed' }), null);
});

/**
 * The options are where PostHog's own collection is switched off, and each one
 * below stands for a promise: no cookies or storage, no person profiles, no
 * clicks or page views read off the screen, no recordings or surveys, nothing
 * the PostHog dashboard can switch back on, no script fetched besides the
 * module, and every event through the sanitizer. Read from the source because
 * the library only runs in a browser.
 */
test('SOURCE: PostHog starts cookieless, with its own collection off and every event sanitized', async () => {
  const { readFile } = await import('node:fs/promises');
  const code = (await readFile(new URL('./analyticsService.js', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const options = code.match(/const POSTHOG_OPTIONS = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(options, 'the PostHog options are gone');

  for (const setting of [
    /cookieless_mode: 'always'/,
    /person_profiles: 'never'/,
    /autocapture: false/,
    /capture_pageview: false/,
    /disable_session_recording: true/,
    /disable_surveys: true/,
    /advanced_disable_flags: true/,
    /disable_external_dependency_loading: true/,
    /before_send: sanitizeAnalyticsCapture/,
  ]) {
    assert.match(options, setting);
  }
  assert.match(code, /posthog\.init\(POSTHOG_PROJECT_TOKEN, POSTHOG_OPTIONS\)/);
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

test('marks activation only after consent and only once', async () => {
  const deniedStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.DENIED });
  const grantedStorage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  const events = [];
  const track = async eventName => {
    events.push(eventName);
    return true;
  };

  assert.equal(await markActivation({ storage: deniedStorage, now: 1000, track }), false);
  assert.equal(await markActivation({ storage: grantedStorage, now: 1000, track }), true);
  assert.equal(await markActivation({ storage: grantedStorage, now: 2000, track }), false);
  assert.deepEqual(events, ['activation']);
});

test('tracks a day-7 return at the boundary and only once', async () => {
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  const events = [];
  const track = async eventName => {
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
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  const events = [];
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  const track = async eventName => {
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

  const failing = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  assert.equal(await markActivation({ storage: failing, now: 1000, track: async () => false }), false);
  assert.equal(await markActivation({ storage: failing, now: 2000, track }), true, 'a failed send is retried');
});

test('a mark whose send has not finished is not stored as sent', async () => {
  // If the tab closes while PostHog is still loading, the send never settles,
  // and whatever storage says at that moment is what the next visit reads.
  // Nothing may say the mark left, or that visit would never send it.
  const storage = memoryStorage({ [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED });
  let settle;
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
    [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT.GRANTED,
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
    else delete globalThis.localStorage;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });

  assert.equal(await setAnalyticsConsent(ANALYTICS_CONSENT.DENIED), true);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.DENIED);
  assert.equal(storage.getItem('papertok_analytics_activation_at'), null);
  assert.equal(storage.getItem('papertok_analytics_activation_sent'), null);
  assert.equal(storage.getItem('papertok_analytics_day_7_return_sent'), null);
});

/**
 * Every `trackEvent` call site in the app, checked against the two allowlists
 * that decide whether it survives.
 *
 * `trackProductEvent` returns `false` on its first line for a name that is not
 * in `EVENT_PARAMETER_SCHEMAS`, and `sanitizeProductEventParams` drops a value
 * that is not in its category. Neither logs anything. So an unregistered event
 * is not a smaller event, it is no event, and an unregistered `surface` is an
 * event that no longer says where it happened — both indistinguishable from
 * working, from the call site and from the dashboard, until someone goes
 * looking for numbers that were never collected.
 *
 * The light redesign shipped four of these at once: `paper_rewrite` and
 * `paper_highlight` unregistered entirely, and the `reader` and `auth_prompt`
 * surfaces stripped off the events that did survive. This test is why that can
 * only happen once.
 */
test('every event the app emits is registered, with a surface that survives', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const roots = [new URL('../', import.meta.url)];
  const sources = [];
  while (roots.length) {
    const dir = roots.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) roots.push(child);
      // `analyticsService.js` is the vocabulary, not a caller: its schema
      // entries read `surface: 'surface'`, naming the category rather than a
      // value, and scanning them would flag the declaration as a violation of
      // itself.
      else if (
        /\.jsx?$/.test(entry.name)
        && !entry.name.endsWith('.test.js')
        && entry.name !== 'analyticsService.js'
      ) sources.push(child);
    }
  }

  const emitted = new Map();
  const surfaces = new Map();
  for (const file of sources) {
    const code = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const [, name] of code.matchAll(/\btrackEvent\(\s*'([a-z0-9_]+)'/g)) {
      emitted.set(name, (emitted.get(name) || []).concat(file.pathname));
    }
    for (const [, value] of code.matchAll(/\bsurface:\s*'([a-z0-9_]+)'/g)) {
      surfaces.set(value, (surfaces.get(value) || []).concat(file.pathname));
    }
  }

  assert.ok(emitted.size > 0, 'the scan found call sites at all');

  const unregistered = [...emitted.keys()].filter(name => !PRODUCT_ANALYTICS_EVENTS.includes(name));
  assert.deepEqual(unregistered, [], `emitted but never recorded: ${unregistered.join(', ')}`);

  // A surface only survives if `sanitizeProductEventParams` keeps it, which is
  // the same question the dashboard asks. Ask it directly rather than
  // re-declaring the category list here and letting the two drift.
  const stripped = [...surfaces.keys()].filter(value => (
    sanitizeProductEventParams('paper_view', { surface: value }).surface !== value
  ));
  assert.deepEqual(stripped, [], `surface dropped by the sanitizer: ${stripped.join(', ')}`);
});


/**
 * A route the router serves but `normalizeAnalyticsPath` does not name is not a
 * missing label — it is a page that disappears. Every one of them lands on
 * `/unknown`, where they pile up as a single anonymous row: `/profile`,
 * `/settings/profile`, `/settings/comments` and `/admin/moderation` spent three
 * months there, together the third most viewed "page" on the site, and nothing
 * about the report said which pages they were.
 *
 * Reading the routes out of `App.jsx` rather than restating them here is the
 * point: the list cannot pass by being edited alongside the router, only by
 * matching it.
 */
test('every route the app declares is a named analytics path', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');

  const declared = [...app.matchAll(/\bpath="([^"]+)"/g)]
    .map(([, path]) => path)
    // The catch-all is React Router's fallback, not a page anyone lands on.
    .filter(path => path !== '*');

  assert.ok(declared.length > 10, 'the scan found the router at all');

  // Fill the parameters with values that must never survive into the report,
  // so a route that leaks one fails here rather than in production.
  const sample = path => path.replace(/:[A-Za-z]\w*/g, 'private-value');

  const unnamed = declared.filter(path => normalizeAnalyticsPath(sample(path)) === '/unknown');
  assert.deepEqual(unnamed, [], `routes filed under /unknown: ${unnamed.join(', ')}`);

  const leaked = declared
    .filter(path => path.includes(':'))
    .filter(path => normalizeAnalyticsPath(sample(path)).includes('private-value'));
  assert.deepEqual(leaked, [], `routes leaking their parameter: ${leaked.join(', ')}`);
});
