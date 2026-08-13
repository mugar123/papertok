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
  sanitizeAnalyticsLocation,
  sanitizeProductEventParams,
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

test('persists only an explicit analytics consent choice', () => {
  const storage = memoryStorage();
  assert.equal(readAnalyticsConsent(storage), null);
  assert.equal(persistAnalyticsConsent(ANALYTICS_CONSENT.GRANTED, storage), true);
  assert.equal(readAnalyticsConsent(storage), ANALYTICS_CONSENT.GRANTED);
  assert.equal(persistAnalyticsConsent('unknown', storage), false);
  assert.equal(storage.getItem(ANALYTICS_CONSENT_KEY), ANALYTICS_CONSENT.GRANTED);
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
