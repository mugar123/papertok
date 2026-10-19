import type { TestGlobals } from './test-types.ts';
import test from 'node:test';
import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery } from './institution-access.ts';
type ServicesOptions = { token?: string | null; resolver?: Resolver };
type Resolver = (issn: string, target?: URL) => Response | Promise<Response>;

import assert from 'node:assert/strict';
import { GETFTR_BATCH_SIZE, InstitutionAccessError } from './institution-access.ts';
import { SERVICE_CATALOGUE, SUBREQUEST_BUDGET, catalogueFingerprint, lookupInstitutionServices, servicesCacheParams } from './institution-services.ts';
import reportApi from './index.ts';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.ts';

// Captured 2026-10-13 from the USAL Alma resolver (svc_dat=CTO), cut down to
// the keys the parser reads: Cell, ISSN 0092-8674, 2020.
const CTO_ENTITLED = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u">
  <context_object><keys><key id="full_text_indicator">true</key></keys></context_object>
  <context_services>
    <context_service service_type="getFullTxt" context_service_id="8714574420005773">
      <keys>
        <key id="package_public_name">Cell Press Free Archives</key>
        <key id="Is_free">1</key>
      </keys>
      <resolution_url>https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=8714574420005773&amp;institutionId=5773&amp;customerId=5770</resolution_url>
    </context_service>
    <context_service service_type="getFullTxt" context_service_id="8714574410005773">
      <keys>
        <key id="package_public_name">Elsevier ScienceDirect Journals Complete</key>
        <key id="Is_free">0</key>
      </keys>
      <resolution_url>https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=8714574410005773&amp;institutionId=5773&amp;customerId=5770</resolution_url>
    </context_service>
  </context_services>
</uresolver_content>`;

// Captured the same day for a nonexistent ISSN, 1234-5678.
const CTO_NONE = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u">
  <context_object><keys><key id="full_text_indicator">false</key></keys></context_object>
  <context_services/>
</uresolver_content>`;

// Only the free archive: open access, not a subscription.
const CTO_FREE_ONLY = CTO_ENTITLED.replace(/<context_service service_type="getFullTxt" context_service_id="8714574410005773">[\s\S]*?<\/context_service>/, '');

/** A resolver answer listing the given paid packages, shaped like the captures. */
const ctoWith = (...packages: string[]) => `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u">
  <context_object><keys><key id="full_text_indicator">true</key></keys></context_object>
  <context_services>${packages.map((name, index) => `
    <context_service service_type="getFullTxt" context_service_id="87145744${index}0005773">
      <keys>
        <key id="package_public_name">${name}</key>
        <key id="Is_free">0</key>
      </keys>
      <resolution_url>https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=87145744${index}0005773&amp;institutionId=5773&amp;customerId=5770</resolution_url>
    </context_service>`).join('')}
  </context_services>
</uresolver_content>`;

// The package names USAL gave on 2026-10-13 for Advanced Materials (2021) and
// for the Journal of Fluid Mechanics (2021), which it only has through ProQuest.
const CTO_WILEY = ctoWith('Wiley Online Library All Journals');
const CTO_AGGREGATOR = ctoWith('Earth, Atmospheric &amp; Aquatic Science Collection', 'Proquest Central');

const ENTITY_ID = 'https://idp.usal.es/entity';
const GETFTR_ENV = { GETFTR_API_KEY: 'getftr-test-key' };
const ISSN_OF = Object.fromEntries(SERVICE_CATALOGUE.map(entry => [entry.id, entry.issn]));

const xml = (body: BodyInit|null|undefined) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml;charset=UTF-8' } });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));

/** A GetFTR response answering each DOI of a request through `verdict(doi)`. */
const getftrAnswering = (verdict: (doi: string) => Record<string, unknown>) => (dois: string[]) => jsonResponse({ entitlements: dois.map(doi => ({ doi, ...verdict(doi) })) });

/**
 * The resolver answering per journal and GetFTR per request (its `dois`
 * array), with overlapping calls counted.
 */
function upstreams({ resolver = () => xml(CTO_NONE), getftr = () => jsonResponse({ entitlements: [] }) }: { resolver?: Resolver; getftr?: (dois: string[], init: RequestInit) => Response | Promise<Response> } = {}) {
  const calls: Array<{ url: URL; init: RequestInit & { headers?: Record<string, string> } }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target, init: init as RequestInit & { headers?: Record<string, string> } });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (target.host === 'eu01.alma.exlibrisgroup.com') return await resolver(target.searchParams.get('rft.issn')!, target);
      if (target.host === 'entitlements.prod.getft.io') {
        const { dois } = JSON.parse(init.body as string);
        const answer = await getftr(dois, init);
        return answer;
      }
      throw new Error(`unexpected fetch ${target}`);
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

const NOW = () => Date.UTC(2026, 9, 13, 12);

test('lists the subscribed platforms in catalogue order with their collections', async () => {
  const subscribed = {
    [ISSN_OF.wiley]: CTO_WILEY,
    [ISSN_OF.sciencedirect]: CTO_ENTITLED,
    [ISSN_OF.cambridge]: CTO_AGGREGATOR,
    [ISSN_OF.nature]: CTO_FREE_ONLY,
  };
  const stub = upstreams({ resolver: (issn: string|number) => xml(subscribed[issn] || CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: NOW });
  assert.deepEqual(result, {
    services: [
      { id: 'sciencedirect', name: 'ScienceDirect', publisher: 'Elsevier', url: 'https://www.sciencedirect.com', monogram: 'SD', color: '#FF6C00', collection: 'Elsevier ScienceDirect Journals Complete', ownPlatform: true },
      { id: 'wiley', name: 'Wiley Online Library', publisher: 'Wiley', url: 'https://onlinelibrary.wiley.com', monogram: 'W', color: '#1F3F77', collection: 'Wiley Online Library All Journals', ownPlatform: true },
      { id: 'cambridge', name: 'Cambridge Core', publisher: 'Cambridge University Press', url: 'https://www.cambridge.org/core', monogram: 'CUP', color: '#D62E2E', collection: 'Earth, Atmospheric & Aquatic Science Collection', ownPlatform: false },
    ],
    partial: false,
    unchecked: SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET,
    checkedAt: '2026-10-13T12:00:00.000Z',
  });
  assert.equal(stub.calls.length, SUBREQUEST_BUDGET);
  const wiley = stub.calls.find(call => call.url.searchParams.get('rft.issn')! === '1521-4095');
  assert.equal(wiley!.url.pathname, '/view/uresolver/34BUC_USAL/openurl');
  assert.equal(wiley!.url.searchParams.get('svc_dat'), 'CTO');
  assert.equal(wiley!.url.searchParams.get('rft.date'), '2021');
});

test('the publisher\'s own package outranks an aggregator listed before it', async () => {
  const stub = upstreams({
    resolver: (issn: string) => xml(issn === ISSN_OF.nature ? ctoWith('Proquest Central', 'Nature') : CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services.map(service => [service.id, service.collection, service.ownPlatform]), [['nature', 'Nature', true]]);
});

// The first package of `ctoWith` marked as filtered out by Alma, with the
// indicator the resolver sends along: false when nothing is left, true when a
// live package follows. The date reason is Alma's own wording (captured for
// Pau on 2026-10-19); the other reasons' wording is a stand-in.
const ctoFiltered = (reason: string, ...packages: string[]) => ctoWith(...packages)
  .replace('<key id="Is_free">0</key>', `<key id="Is_free">0</key>\n        <key id="Filtered">true</key>\n        <key id="Filter reason">${reason}</key>`)
  .replace('<key id="full_text_indicator">true</key>', `<key id="full_text_indicator">${packages.length > 1 ? 'true' : 'false'}</key>`);

test('a platform whose only service Alma filtered out for the date is not listed', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? ctoFiltered('Date Filter', 'Nature') : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services, []);
  assert.equal(result.partial, false);
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET);
});

test('a live package next to a filtered one is listed, under the live package', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? ctoFiltered('Date Filter', 'Nature', 'Proquest Central') : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services.map(service => [service.id, service.collection, service.ownPlatform]), [['nature', 'Proquest Central', false]]);
});

test('a service filtered for a reason other than the date leaves the platform unchecked, not absent', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? ctoFiltered('IP Filter', 'Nature') : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services, []);
  assert.equal(result.partial, false);
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET + 1);
});

// A library that sends readers straight to one service answers without an
// indicator (Harvard, 2026-10-19); the package it lists is still its own.
const ctoSingleService = (...packages: string[]) => ctoWith(...packages)
  .replace('<key id="full_text_indicator">true</key>', '<key id="available_services">single_service</key>\n    <key id="rft.mms_id">990001299870203941</key>');

test('a platform answered without an indicator is listed from what it lists', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? ctoSingleService('Nature') : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services.map(service => [service.id, service.collection, service.ownPlatform]), [['nature', 'Nature', true]]);
  assert.equal(result.partial, false);
});

test('a probe cut short leaves its platform out and marks the list partial', async () => {
  const stub = upstreams({
    resolver: (issn: string) => (issn === ISSN_OF.wiley ? timeout() : xml(issn === ISSN_OF.ieee || issn === ISSN_OF.sciencedirect ? CTO_ENTITLED : CTO_NONE)),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.equal(result.partial, true);
  assert.deepEqual(result.services.map(service => service.id), ['sciencedirect', 'ieee']);
});

test('an unreadable resolver answer is a failed probe, not a missing subscription', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.acs ? '<html>Maintenance</html>' : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services, []);
  assert.equal(result.partial, true);
});

test('a single-service answer cut off before its services is a failed probe, not an empty list', async () => {
  const truncated = '<uresolver_content><context_object><keys><key id="rft.mms_id">990001299870203941</key><key id="available_services">single_service</key></keys></context_object><context_services>';
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? truncated : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services, []);
  assert.equal(result.partial, true);
});

test('a complete answer that is not well-formed XML still lists its platform', async () => {
  const unescaped = ctoWith('Taylor & Francis Current Content Access');
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.tandf ? unescaped : CTO_NONE) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services.map(({ id, collection, ownPlatform }) => ({ id, collection, ownPlatform })), [
    { id: 'tandf', collection: 'Taylor & Francis Current Content Access', ownPlatform: true },
  ]);
  assert.equal(result.partial, false);
});

test('is unavailable when every probe fails', async () => {
  const stub = upstreams({ resolver: () => new Response('down', { status: 503 }) });
  await assert.rejects(
    lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl }),
    error => error instanceof InstitutionAccessError && error.code === 'ACCESS_LOOKUP_UNAVAILABLE' && error.status === 502,
  );
});

test('refuses an institution no provider can answer for, without asking anyone', async () => {
  for (const [params, env] of [
    [{ domain: 'nowhere.example', entityId: ENTITY_ID }, {}],
    [{ domain: 'nowhere.example' }, GETFTR_ENV],
  ] as Array<[InstitutionQuery, WorkerEnv]>) {
    const stub = upstreams();
    await assert.rejects(
      lookupInstitutionServices(params, { fetchImpl: stub.fetchImpl, env }),
      error => (error as Error & { code?: string; status?: number }).code === 'INSTITUTION_NOT_SUPPORTED' && (error as Error & { code?: string; status?: number }).status === 404,
    );
    assert.equal(stub.calls.length, 0);
  }
});

// With a key, the catalogue goes to GetFTR twenty DOIs per request.
const GETFTR_BATCHES = Math.ceil(SERVICE_CATALOGUE.filter(entry => entry.doi).length / GETFTR_BATCH_SIZE);

test('GetFTR is asked about the whole catalogue in batches of twenty DOIs, and its yes carries no collection', async () => {
  const nature = SERVICE_CATALOGUE.find(entry => entry.id === 'nature');
  const stub = upstreams({
    getftr: getftrAnswering((doi: string) => ({
      statusCode: 200,
      entitled: doi === nature!.doi ? 'yes' : 'no',
      vor: [{ contentType: 'html', url: `https://www.nature.com/articles/${doi}` }],
    })),
  });
  const result = await lookupInstitutionServices({ domain: 'nowhere.example', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services, [
    { id: 'nature', name: 'Nature', publisher: 'Springer Nature', url: 'https://www.nature.com', monogram: 'N', color: '#1C1C1C', collection: null, ownPlatform: true },
  ]);
  assert.equal(result.partial, false);
  assert.equal(result.unchecked, 8); // Titles without a DOI need a resolver.
  const bodies = stub.calls.map(call => JSON.parse(call.init.body as string));
  assert.equal(bodies.length, GETFTR_BATCHES);
  assert.ok(bodies.length < SUBREQUEST_BUDGET);
  for (const body of bodies) {
    assert.deepEqual(body.org, { entityID: ENTITY_ID });
    assert.ok(body.dois.length > 0 && body.dois.length <= GETFTR_BATCH_SIZE);
  }
  assert.deepEqual(bodies.flatMap(body => body.dois), SERVICE_CATALOGUE.flatMap(entry => entry.doi ? [entry.doi] : []));
});

test('a GetFTR outage falls through to the resolver when the library has one', async () => {
  const stub = upstreams({
    getftr: () => jsonResponse({}, 503),
    resolver: (issn: string) => xml(issn === ISSN_OF.rsc ? ctoWith('Royal Society of Chemistry') : CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services.map(service => [service.id, service.collection, service.ownPlatform]), [['rsc', 'Royal Society of Chemistry', true]]);
  assert.equal(result.partial, false);
  // The failed GetFTR requests still count against the budget.
  const resolverCalls = stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com');
  assert.equal(resolverCalls.length, SUBREQUEST_BUDGET - GETFTR_BATCHES);
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - resolverCalls.length);
});

test('a GetFTR answer that decides nothing, with no resolver behind it, is unchecked rather than absent', async () => {
  const undecided = {
    [SERVICE_CATALOGUE[0].doi!]: { statusCode: 200, entitled: 'maybe' },
    [SERVICE_CATALOGUE[1].doi!]: { statusCode: 200, entitled: 'no', source: 'publisher_not_supported' },
    [SERVICE_CATALOGUE[2].doi!]: { statusCode: 404 },
    [SERVICE_CATALOGUE[3].doi!]: { statusCode: 200, entitled: 'yes' },
  };
  const stub = upstreams({
    getftr: getftrAnswering((doi: string|number) => undecided[doi] || { statusCode: 200, entitled: 'no' }),
  });
  const result = await lookupInstitutionServices({ domain: 'nowhere.example', rorId: 'https://ror.org/0nowher00' }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services, []);
  assert.equal(result.unchecked, 12); // Four undecided DOIs and eight titles without DOIs.
  assert.equal(result.partial, false);
});

test('a GetFTR maybe goes to the resolver when the library has one, which decides it', async () => {
  const stub = upstreams({
    getftr: getftrAnswering(() => ({ statusCode: 200, entitled: 'maybe' })),
    resolver: (issn: string) => xml(issn === ISSN_OF.wiley ? CTO_WILEY : CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services.map(service => service.id), ['wiley']);
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - (SUBREQUEST_BUDGET - GETFTR_BATCHES));
});

test('GetFTR verdicts are final for DOIs; publications without DOIs still use the resolver', async () => {
  const stub = upstreams({
    getftr: getftrAnswering(() => ({ statusCode: 200, entitled: 'no' })),
    resolver: () => xml(CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services, []);
  assert.equal(result.unchecked, 0);
  assert.equal(stub.calls.length, GETFTR_BATCHES + 8);
  assert.deepEqual(stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com').map(call => call.url.searchParams.get('rft.issn')), ['0013-0613', '0307-1766', '0099-9660', '0362-4331', '0028-792X', '0261-3077', '0017-8012', '0007-7135']);
});

test('a GetFTR outage with no resolver behind it is a failure, not an empty library', async () => {
  const stub = upstreams({ getftr: () => jsonResponse({}, 503) });
  await assert.rejects(
    lookupInstitutionServices({ domain: 'nowhere.example', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV }),
    error => (error as Error & { code?: string; status?: number }).code === 'ACCESS_LOOKUP_UNAVAILABLE' && (error as Error & { code?: string; status?: number }).status === 502,
  );
});

test('without GetFTR the resolver is asked the budget\'s worth of platforms, four at a time, and the rest are unchecked', async () => {
  const stub = upstreams();
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.ok(SERVICE_CATALOGUE.length > SUBREQUEST_BUDGET, 'the catalogue is what overran the budget');
  assert.equal(stub.calls.length, SUBREQUEST_BUDGET);
  assert.equal(stub.maxInFlight(), 4);
  // In catalogue order: the platforms most libraries hold are asked first.
  assert.deepEqual(
    stub.calls.map(call => call.url.searchParams.get('rft.issn')!),
    SERVICE_CATALOGUE.slice(0, SUBREQUEST_BUDGET).map(entry => entry.issn),
  );
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET);
  assert.equal(result.partial, false);
});

test('catalogue identifiers are distinct and well-formed, with DOI optional for press', () => {
  const issns = SERVICE_CATALOGUE.map(entry => entry.issn);
  const dois = SERVICE_CATALOGUE.flatMap(entry => entry.doi ? [entry.doi] : []);
  const ids = SERVICE_CATALOGUE.map(entry => entry.id);
  for (const list of [issns, dois, ids]) assert.equal(new Set(list).size, list.length);
  for (const entry of SERVICE_CATALOGUE) {
    assert.match(entry.issn, /^\d{4}-\d{3}[\dX]$/, entry.id);
    if (entry.doi) {
      assert.match(entry.doi, /^10\.\d{4,9}\/\S+$/, entry.id);
      assert.equal(entry.doi, entry.doi.toLowerCase(), entry.id);
    }
    assert.ok(Number.isInteger(entry.year), entry.id);
    assert.match(entry.url, /^https:\/\//, entry.id);
    assert.match(entry.color, /^#[0-9A-F]{6}$/, entry.id);
    assert.ok(entry.monogram.length >= 1 && entry.monogram.length <= 4, entry.id);
  }
});

const PROJECT_ID = 'papertok-168df';
const TOKEN = fakeIdToken({ aud: PROJECT_ID });
const ROUTE_ENV = { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID };

/** The route through the Worker's own dispatch, with the edge cache recorded. */
async function requestServices(search: string, { token = TOKEN, resolver = () => xml(CTO_ENTITLED) }: ServicesOptions = {}) {
  const calls: string[] = [];
  const puts: Array<{ key: string; response: Response }> = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.host);
    if (url.pathname.endsWith('accounts:lookup')) return jsonResponse({ users: [{ localId: 'alice-uid' }] });
    if (url.host === 'eu01.alma.exlibrisgroup.com') return resolver(url.searchParams.get('rft.issn')!);
    throw new Error(`unexpected upstream ${url}`);
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (key, response): Promise<void> => { puts.push({ key: (key as Request).url, response }); },
    },
  };
  try {
    const response = await reportApi.fetch(new Request(`https://api.papertok.test/institution/services?${search}`, {
      headers: { origin: 'https://papertok.app', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }), ROUTE_ENV);
    const servicePuts = puts.filter(put => put.key.startsWith('https://papertok.internal/cache/institution/services'));
    return { response, body: await response.json<Awaited<ReturnType<typeof lookupInstitutionServices>>>(), calls, servicePuts };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

test('the route caches a complete list for seven days under the library', async () => {
  const { response, body, servicePuts } = await requestServices('domain=USAL.es&entityId=https%3A%2F%2Fidp.usal.es%2Fentity');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://papertok.app');
  assert.equal(body.partial, false);
  assert.equal(body.services.length, SUBREQUEST_BUDGET);
  assert.equal(body.unchecked, SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET);
  assert.equal(servicePuts.length, 1);
  // Without a GetFTR key the entityId reaches no provider, so it does not
  // split the cache; the catalogue's fingerprint does, so a changed
  // catalogue is not served from a week-old list.
  assert.deepEqual([...new URL(servicePuts[0].key).searchParams], [
    ['library', '34BUC_USAL'],
    ['host', 'eu01.alma.exlibrisgroup.com'],
    ['catalogue', catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET)],
    ['reading', 'complete-answers'],
  ]);
  assert.match(servicePuts[0].response.headers.get('cache-control')!, /s-maxage=604800/);
});

test('the cache key changes with the catalogue and the budget, and with nothing else', () => {
  const fingerprint = catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET);
  assert.match(fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(catalogueFingerprint([...SERVICE_CATALOGUE], SUBREQUEST_BUDGET), fingerprint);
  assert.notEqual(catalogueFingerprint(SERVICE_CATALOGUE.slice(0, 14), SUBREQUEST_BUDGET), fingerprint);
  assert.notEqual(catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET + 30), fingerprint);
  const swapped = SERVICE_CATALOGUE.map((entry, index) => (index === 0 ? { ...entry, doi: '10.1016/j.other.2021.1' } : entry));
  assert.notEqual(catalogueFingerprint(swapped, SUBREQUEST_BUDGET), fingerprint);
  assert.deepEqual(servicesCacheParams({ domain: 'usal.es', entityId: ENTITY_ID }, {}), { library: '34BUC_USAL', host: 'eu01.alma.exlibrisgroup.com', catalogue: fingerprint, reading: 'complete-answers' });
  assert.deepEqual(
    servicesCacheParams({ domain: 'usal.es', entityId: ENTITY_ID }, GETFTR_ENV),
    { library: '34BUC_USAL', host: 'eu01.alma.exlibrisgroup.com', entityId: ENTITY_ID, catalogue: fingerprint, reading: 'complete-answers' },
  );
});

test('the route caches a partial list for an hour', async () => {
  const { response, body, servicePuts } = await requestServices('domain=usal.es', {
    resolver: (issn: string) => (issn === ISSN_OF.oup ? timeout() : xml(CTO_NONE)),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services, []);
  assert.equal(body.partial, true);
  assert.match(servicePuts[0].response.headers.get('cache-control')!, /s-maxage=3600\b/);
});

test('the route refuses a missing session or a malformed domain before any provider, uncached', async () => {
  for (const [search, options, status, code, upstreamCalls] of [
    ['domain=usal.es', { token: null }, 401, 'AUTH_REQUIRED', []],
    ['domain=localhost', {}, 400, 'INVALID_DOMAIN', null],
    ['domain=usal.es', { resolver: () => new Response('down', { status: 503 }) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE', null],
  ] as Array<[string, ServicesOptions, number, string, string[] | null]>) {
    const { response, body, calls, servicePuts } = await requestServices(search, options);
    assert.equal(response.status, status, search);
    assert.deepEqual(body, { code });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(servicePuts.length, 0);
    if (upstreamCalls) assert.deepEqual(calls, upstreamCalls);
  }
});


test('following pages checks the entire catalogue without exceeding the upstream budget', async () => {
  const stub = upstreams({ resolver: issn => xml(issn === '0007-7135' ? ctoWith('EBSCOhost Business Source Complete') : CTO_NONE) });
  const found: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const before = stub.calls.length;
    const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, offset });
    assert.ok(stub.calls.length - before <= 40);
    assert.equal(result.unchecked, 0);
    assert.equal(result.partial, false);
    found.push(...result.services.map(service => service.name));
    offset = result.nextOffset!;
  }
  assert.deepEqual(found, ['Bloomberg Businessweek']);
  assert.deepEqual(stub.calls.map(call => call.url.searchParams.get('rft.issn')), SERVICE_CATALOGUE.map(entry => entry.issn));
  assert.equal(stub.maxInFlight(), 4);
});

test('a paged GetFTR outage leaves enough budget to probe every title in the page', async () => {
  const stub = upstreams({ getftr: () => jsonResponse({}, 503) });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV, offset: 0 });
  assert.equal(result.nextOffset, 36);
  assert.equal(result.unchecked, 0);
  assert.equal(result.partial, false);
  assert.equal(stub.calls.length, 38);
});

test('press is checked by ISSN and year; a free Guardian service is not library access', async () => {
  const stub = upstreams({ resolver: issn => xml(issn === '0013-0613' ? ctoWith('ABI/INFORM Collection') : CTO_FREE_ONLY) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, offset: 36 });
  assert.deepEqual(result.services.map(service => [service.id, service.ownPlatform, service.collection]), [['economist', false, 'ABI/INFORM Collection']]);
  assert.match(result.services[0].url, /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\/view\/action\/uresolver\.do\?/);
  assert.equal(new URL(result.services[0].url).searchParams.get('institutionId'), '5773');
  const guardian = stub.calls.find(call => call.url.searchParams.get('rft.issn') === '0261-3077')!;
  assert.equal(guardian.url.searchParams.get('rft.date'), '2025');
  assert.equal(result.unchecked, 0);
});

test('paged responses and their cache keys keep offsets separate and canonical', async () => {
  const first = await requestServices('domain=usal.es&offset=00');
  const next = await requestServices('domain=usal.es&offset=36');
  assert.equal(first.body.services.length, 36);
  assert.equal(first.body.nextOffset, 36);
  assert.equal(first.body.unchecked, 0);
  assert.equal(next.body.nextOffset, 72);
  assert.equal(new URL(first.servicePuts[0].key).searchParams.get('offset'), '0');
  assert.equal(new URL(next.servicePuts[0].key).searchParams.get('offset'), '36');
  assert.notEqual(first.servicePuts[0].key, next.servicePuts[0].key);
  for (const raw of ['', '-1', '1.5', '1', 'NaN', '108', '9007199254740992']) {
    const result = await requestServices(`domain=usal.es&offset=${raw}`);
    assert.equal(result.response.status, 400, raw);
    assert.deepEqual(result.body, { code: 'INVALID_SERVICES_OFFSET' });
    assert.ok(!result.calls.includes('eu01.alma.exlibrisgroup.com'));
    assert.equal(result.servicePuts.length, 0);
  }
});

test('ISSN, coverage year, package matching and displayed changes invalidate the catalogue cache', () => {
  const original = catalogueFingerprint(SERVICE_CATALOGUE, 40);
  for (const change of [{ issn: '1234-5678' }, { year: 2025 }, { packageHint: 'Other' }, { name: 'Other name' }, { url: 'https://other.example' }]) {
    const changed = SERVICE_CATALOGUE.map((entry, index) => index === 0 ? { ...entry, ...change } : entry);
    assert.notEqual(catalogueFingerprint(changed, 40), original);
  }
});
