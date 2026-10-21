import type { TestGlobals } from './test-types.ts';
import test from 'node:test';
import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery } from './institution-access.ts';
type ServicesOptions = { token?: string | null; resolver?: Resolver; store?: ReturnType<typeof memoryStore> | null };
type Resolver = (issn: string, target?: URL) => Response | Promise<Response>;

import assert from 'node:assert/strict';
import { GETFTR_BATCH_SIZE, InstitutionAccessError, findResolver } from './institution-access.ts';
import { SERVICE_CATALOGUE, VERDICT_TTL_MS, lookupInstitutionServices, probeKey, servicesStoreKey } from './institution-services.ts';
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

// The SFX pilot's instances on the Bavarian network's server (2026-10-20).
const SFX_HOST = 'sfx.bib-bvb.de';
const TUM_ROR = 'https://ror.org/02kkvpp62';
const LMU_ROR = 'https://ror.org/05591te55';
const FAU_ROR = 'https://ror.org/00f7hpc57';
const TUM_LOGIN = 'https://tum-eaccess.de/login?qurl=';
const LMU_LOGIN = 'https://emedien.ub.uni-muenchen.de/login?qurl=';

/**
 * An SFX answer resolving `issn` with the given full-text targets, as
 * `[KB name, public name, link?]`, shaped like the captures in
 * institution-access.test.ts (sfx_tum, 2026-10-20).
 */
const sfxWith = (issn: string, ...targets: Array<[string, string, string?]>) => `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
  &lt;item key="rft.issn"&gt;${issn}&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>${targets.map(([name, publicName, link = `https://journals.example.org/${name.toLowerCase()}`]) => `
   <target>
    <target_name>${name}</target_name>
    <target_public_name>${publicName}</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>${link.replace(/&/g, '&amp;')}</target_url>
    <is_related>no</is_related>
   </target>`).join('')}
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

/**
 * The resolver answering per journal and GetFTR per request (its `dois`
 * array), with overlapping calls counted; `sfx` answers for the SFX instances.
 */
function upstreams({ resolver = () => xml(CTO_NONE), sfx = issn => xml(sfxWith(issn)), getftr = () => jsonResponse({ entitlements: [] }) }: { resolver?: Resolver; sfx?: Resolver; getftr?: (dois: string[], init: RequestInit) => Response | Promise<Response> } = {}) {
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
      if (target.host === SFX_HOST) return await sfx(target.searchParams.get('rft.issn')!, target);
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
    unchecked: 0,
    remaining: 0,
    checkedAt: '2026-10-13T12:00:00.000Z',
  });
  assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
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
  assert.equal(result.unchecked, 0);
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
  assert.equal(result.unchecked, 1);
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

test('an answer whose Filtered key never closes is a failed probe, not a platform', async () => {
  // Read by its keys, the package Alma filtered out for the date would count as live.
  const damaged = ctoFiltered('Date Filter', 'Nature').replace('<key id="Filtered">true</key>', '<key id="Filtered">true');
  const stub = upstreams({ resolver: (issn: string) => xml(issn === ISSN_OF.nature ? damaged : CTO_NONE) });
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

// One @hawaii.edu address serves every campus of the University of Hawaiʻi,
// and the only resolver found is Mānoa's library: the system's identity
// gets no list rather than Mānoa's (row withdrawn 2026-10-20).
const HAWAII_SYSTEM_ROR = 'https://ror.org/03tzaeb71';

test('the Hawaiʻi system is refused rather than listed from Mānoa\'s library', async () => {
  const stub = upstreams();
  await assert.rejects(
    lookupInstitutionServices({ domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR } as InstitutionQuery, { fetchImpl: stub.fetchImpl }),
    error => (error as Error & { code?: string; status?: number }).code === 'INSTITUTION_NOT_SUPPORTED' && (error as Error & { code?: string; status?: number }).status === 404,
  );
  assert.equal(stub.calls.length, 0);
});

test('UVic-UCC and PUC Chile are listed from their own libraries', () => {
  assert.deepEqual(findResolver({ domain: 'uvic-ucc.cat', rorId: 'https://ror.org/006zjws59' }), { host: 'csuc-uvic.alma.exlibrisgroup.com', institution: '34CSUC_UVIC' });
  assert.deepEqual(findResolver({ domain: 'uc.cl', rorId: 'https://ror.org/04teye511' }), { host: 'puc.alma.exlibrisgroup.com', institution: '56PUC_INST' });
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
  assert.equal(result.unchecked, 144); // Eight press titles and 136 journals need a resolver.
  const bodies = stub.calls.map(call => JSON.parse(call.init.body as string));
  assert.equal(bodies.length, GETFTR_BATCHES);
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
  // Every title falls through to the resolver.
  const resolverCalls = stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com');
  assert.equal(resolverCalls.length, SERVICE_CATALOGUE.length);
  assert.equal(result.unchecked, 0);
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
  assert.equal(result.unchecked, 148); // Four undecided DOIs plus 144 titles without DOIs.
  assert.equal(result.partial, false);
});

test('a GetFTR maybe goes to the resolver when the library has one, which decides it', async () => {
  const stub = upstreams({
    getftr: getftrAnswering(() => ({ statusCode: 200, entitled: 'maybe' })),
    resolver: (issn: string) => xml(issn === ISSN_OF.wiley ? CTO_WILEY : CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services.map(service => service.id), ['wiley']);
  assert.equal(result.unchecked, 0);
});

test('GetFTR verdicts are final for DOIs; publications without DOIs still use the resolver', async () => {
  const stub = upstreams({
    getftr: getftrAnswering(() => ({ statusCode: 200, entitled: 'no' })),
    resolver: () => xml(CTO_NONE),
  });
  const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(result.services, []);
  assert.equal(result.unchecked, 0);
  assert.equal(stub.calls.length, GETFTR_BATCHES + 144);
  assert.deepEqual(stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com').map(call => call.url.searchParams.get('rft.issn')), SERVICE_CATALOGUE.filter(entry => !entry.doi).map(entry => entry.issn));
});

test('a GetFTR outage with no resolver behind it is a failure, not an empty library', async () => {
  const stub = upstreams({ getftr: () => jsonResponse({}, 503) });
  await assert.rejects(
    lookupInstitutionServices({ domain: 'nowhere.example', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV }),
    error => (error as Error & { code?: string; status?: number }).code === 'ACCESS_LOOKUP_UNAVAILABLE' && (error as Error & { code?: string; status?: number }).status === 502,
  );
});

test('without GetFTR the resolver is asked about the whole catalogue in order, six at a time', async () => {
  const stub = upstreams();
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.equal(stub.maxInFlight(), 6);
  // In catalogue order: the platforms most libraries hold are asked first.
  assert.deepEqual(stub.calls.map(call => call.url.searchParams.get('rft.issn')!), SERVICE_CATALOGUE.map(entry => entry.issn));
  assert.equal(result.unchecked, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.partial, false);
});

test('catalogue identifiers are distinct and well-formed, with DOI optional for resolver-only titles', () => {
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

/** A KV namespace the verdicts are kept in, as the route's binding is. */
function memoryStore({ put }: { put?: (key: string, value: string) => Promise<void> } = {}) {
  const values = new Map<string, string>();
  const store = {
    values,
    async get(key: string, type?: string) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: put || (async (key: string, value: string) => { values.set(key, value); }),
  };
  return store as unknown as KVNamespace & { values: Map<string, string> };
}

/** The route through the Worker's own dispatch, with the store its verdicts land in. */
async function requestServices(search: string, { token = TOKEN, resolver = () => xml(CTO_ENTITLED), store = memoryStore() }: ServicesOptions = {}) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.host);
    if (url.pathname.endsWith('accounts:lookup')) return jsonResponse({ users: [{ localId: 'alice-uid' }] });
    if (url.host === 'eu01.alma.exlibrisgroup.com' || url.host === 'na03.alma.exlibrisgroup.com' || url.host === 'ca01.alma.exlibrisgroup.com' || url.host === SFX_HOST) return resolver(url.searchParams.get('rft.issn')!, url);
    throw new Error(`unexpected upstream ${url}`);
  };
  // The identity check keeps its answers at the edge; the list no longer does.
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (): Promise<void> => {},
    },
  };
  try {
    const response = await reportApi.fetch(new Request(`https://api.papertok.test/institution/services?${search}`, {
      headers: { origin: 'https://papertok.app', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }), { ...ROUTE_ENV, INSTITUTION_SERVICES_STORE: store ?? undefined });
    return { response, body: await response.json<Awaited<ReturnType<typeof lookupInstitutionServices>>>(), calls, store: store! };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

test('the services route reads CDATA filters and free flags before storing the list', async () => {
  const date = ctoFiltered('Date Filter', 'Nature')
    .replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>')
    .replace('<key id="Filter reason">Date Filter</key>', '<key id="Filter reason"><![CDATA[Date Filter]]></key>');
  const cases = [
    [date, 0],
    [date.replace('Date Filter', 'IP Filter'), 1],
    [CTO_FREE_ONLY.replace('<key id="Is_free">1</key>', '<key id="Is_free"><![CDATA[1]]></key>'), 0],
  ] as const;
  for (const [answer, unchecked] of cases) {
    const { response, body, store } = await requestServices('domain=usal.es', {
      resolver: issn => xml(issn === ISSN_OF.nature ? answer : CTO_NONE),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body.services, []);
    assert.equal(body.partial, false);
    assert.equal(body.unchecked, unchecked);
    assert.equal(store.values.size, 1);
  }
  const live = await requestServices('domain=usal.es', {
    resolver: issn => xml(issn === ISSN_OF.nature
      ? ctoFiltered('Date Filter', 'Nature', 'Proquest Central').replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>')
      : CTO_NONE),
  });
  assert.deepEqual(live.body.services.map(service => service.collection), ['Proquest Central']);
  const broken = await requestServices('domain=usal.es', {
    resolver: issn => xml(issn === ISSN_OF.nature ? date.replace('Date Filter]]>', 'Date Filter') : CTO_NONE),
  });
  assert.deepEqual(broken.body.services, []);
  assert.equal(broken.body.partial, true);
  // The failed probe is not stored: the next request asks about it again.
  const stored = JSON.parse([...broken.store.values.values()][0]) as Record<string, unknown>;
  assert.equal(Object.keys(stored).length, SERVICE_CATALOGUE.length - 1);
  assert.equal(probeKey(SERVICE_CATALOGUE.find(entry => entry.id === 'nature')!) in stored, false);
});

test('the services route accepts USC\'s stored SAML URN and queries its Alma library', async () => {
  const search = new URLSearchParams({ domain: 'usc.edu', rorId: 'https://ror.org/03taz7m60', entityId: 'urn:mace:incommon:usc.edu' }).toString();
  const { response, body, store } = await requestServices(search, {
    resolver: (issn, target) => {
      assert.equal(target!.host, 'na03.alma.exlibrisgroup.com');
      assert.equal(target!.pathname, '/view/uresolver/01USC_INST/openurl');
      return xml(issn === ISSN_OF.sciencedirect ? CTO_ENTITLED : CTO_NONE);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['sciencedirect']);
  assert.equal(body.partial, false);
  assert.deepEqual([...store.values.keys()], [await servicesStoreKey({ domain: 'usc.edu', rorId: 'https://ror.org/03taz7m60', entityId: 'urn:mace:incommon:usc.edu' }, ROUTE_ENV)]);
  const anonymous = await requestServices(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the services route accepts Manitoba\'s HTTP SAML identifier and queries its Alma library', async () => {
  const search = new URLSearchParams({ domain: 'umanitoba.ca', rorId: 'https://ror.org/02gfys938', entityId: 'http://CAF.AD.UMANITOBA.CA/adfs/services/trust' }).toString();
  const { response, body, store } = await requestServices(search, {
    resolver: (issn, target) => {
      assert.equal(target!.host, 'ca01.alma.exlibrisgroup.com');
      assert.equal(target!.pathname, '/view/uresolver/01UMB_INST/openurl');
      return xml(issn === ISSN_OF.sciencedirect ? CTO_ENTITLED : CTO_NONE);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['sciencedirect']);
  assert.equal(body.partial, false);
  assert.deepEqual([...store.values.keys()], [await servicesStoreKey({ domain: 'umanitoba.ca', rorId: 'https://ror.org/02gfys938', entityId: 'http://CAF.AD.UMANITOBA.CA/adfs/services/trust' }, ROUTE_ENV)]);
  const anonymous = await requestServices(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the services route rejects malformed URNs and unsafe schemes without provider work or caching', async () => {
  for (const entityId of ['urn:mace:', 'urn::usc.edu', 'urn:mace:incommon:usc edu', 'urn:mace:usc%ZZ', 'javascript:alert(1)', 'http://', 'http://bad host/idp', 'ftp://idp.example.edu', `urn:mace:${'x'.repeat(300)}`]) {
    const { response, body, calls, store } = await requestServices(new URLSearchParams({ domain: 'usc.edu', entityId }).toString());
    assert.equal(response.status, 400, entityId);
    assert.deepEqual(body, { code: 'INVALID_INSTITUTION_ID' });
    assert.ok(calls.every(host => host === 'identitytoolkit.googleapis.com'));
    assert.equal(store.values.size, 0);
  }
});

test('the services route refuses the Hawaiʻi system without asking Mānoa\'s resolver or caching', async () => {
  const search = new URLSearchParams({ domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR }).toString();
  const { response, body, calls, store } = await requestServices(search);
  assert.equal(response.status, 404);
  assert.deepEqual(body, { code: 'INSTITUTION_NOT_SUPPORTED' });
  assert.equal(store.values.size, 0);
  assert.ok(calls.every(host => !host.endsWith('.alma.exlibrisgroup.com')), `asked a resolver: ${calls.join(', ')}`);
});

test('the route stores the library\'s verdicts and answers the next request from them, uncached', async () => {
  const first = await requestServices('domain=USAL.es&entityId=https%3A%2F%2Fidp.usal.es%2Fentity');
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get('access-control-allow-origin'), 'https://papertok.app');
  assert.equal(first.response.headers.get('cache-control'), 'no-store');
  assert.equal(first.body.partial, false);
  assert.equal(first.body.remaining, 0);
  assert.equal(first.body.services.length, SERVICE_CATALOGUE.length);
  assert.equal(first.calls.filter(host => host === 'eu01.alma.exlibrisgroup.com').length, SERVICE_CATALOGUE.length);
  // Without a GetFTR key the entityId reaches no provider, so it is not in the key.
  assert.deepEqual([...first.store.values.keys()], [await servicesStoreKey({ domain: 'usal.es' }, ROUTE_ENV)]);
  const again = await requestServices('domain=usal.es', { store: first.store, resolver: () => { throw new Error('asked again'); } });
  assert.equal(again.response.status, 200);
  assert.deepEqual(again.body.services, first.body.services);
  assert.ok(again.calls.every(host => host === 'identitytoolkit.googleapis.com'), again.calls.join(', '));
});

test('the store key names the library, the ids only once GetFTR gets them, and the reading', async () => {
  const usal = await servicesStoreKey({ domain: 'usal.es', entityId: ENTITY_ID }, {});
  assert.match(usal, /^services:[0-9a-f]{64}$/);
  assert.equal(await servicesStoreKey({ domain: 'usal.es' }, {}), usal);
  assert.notEqual(await servicesStoreKey({ domain: 'usal.es', entityId: ENTITY_ID }, GETFTR_ENV), usal);
  assert.notEqual(await servicesStoreKey({ domain: 'uvic-ucc.cat', rorId: 'https://ror.org/006zjws59' }, {}), usal);
});

test('a changed probe (ISSN, year, DOI or package) is a new entry; a renamed or recoloured one keeps its verdict', () => {
  const [entry] = SERVICE_CATALOGUE;
  const original = probeKey(entry);
  for (const change of [{ issn: '1234-5678' }, { year: 2025 }, { doi: '10.1016/j.other.2021.1' }, { packageHint: 'Other' }]) {
    assert.notEqual(probeKey({ ...entry, ...change }), original);
  }
  for (const change of [{ name: 'Other name' }, { url: 'https://other.example' }, { color: '#000000' }]) {
    assert.equal(probeKey({ ...entry, ...change }), original);
  }
});

test('a probe the deadline cut is answered as partial, not stored, and asked again next time', async () => {
  const cut = await requestServices('domain=usal.es', {
    resolver: (issn: string) => (issn === ISSN_OF.oup ? timeout() : xml(CTO_NONE)),
  });
  assert.equal(cut.response.status, 200);
  assert.deepEqual(cut.body.services, []);
  assert.equal(cut.body.partial, true);
  const next = await requestServices('domain=usal.es', { store: cut.store, resolver: () => xml(CTO_ENTITLED) });
  assert.equal(next.body.partial, false);
  assert.deepEqual(next.body.services.map(service => service.id), ['oup']);
  assert.equal(next.calls.filter(host => host === 'eu01.alma.exlibrisgroup.com').length, 1);
});

test('the route refuses a missing session or a malformed domain before any provider, uncached', async () => {
  for (const [search, options, status, code, upstreamCalls] of [
    ['domain=usal.es', { token: null }, 401, 'AUTH_REQUIRED', []],
    ['domain=localhost', {}, 400, 'INVALID_DOMAIN', null],
    ['domain=usal.es', { resolver: () => new Response('down', { status: 503 }) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE', null],
  ] as Array<[string, ServicesOptions, number, string, string[] | null]>) {
    const { response, body, calls, store } = await requestServices(search, options);
    assert.equal(response.status, status, search);
    assert.deepEqual(body, { code });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(store.values.size, 0);
    if (upstreamCalls) assert.deepEqual(calls, upstreamCalls);
  }
});


test('press is checked by ISSN and year; a free Guardian service is not library access', async () => {
  const stub = upstreams({ resolver: issn => xml(issn === '0013-0613' ? ctoWith('ABI/INFORM Collection') : CTO_FREE_ONLY) });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result.services.map(service => [service.id, service.ownPlatform, service.collection]), [['economist', false, 'ABI/INFORM Collection']]);
  assert.match(result.services[0].url, /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\/view\/action\/uresolver\.do\?/);
  assert.equal(new URL(result.services[0].url).searchParams.get('institutionId'), '5773');
  const guardian = stub.calls.find(call => call.url.searchParams.get('rft.issn') === '0261-3077')!;
  assert.equal(guardian.url.searchParams.get('rft.date'), '2025');
  assert.equal(result.unchecked, 0);
});

test('an SFX library lists the platforms it subscribes to, under its own package, and not its free collections', async () => {
  const stub = upstreams({
    sfx: issn => xml(issn === ISSN_OF.nature
      ? sfxWith(issn, ['SPRINGER_LINK_JOURNALS_AUTOLOAD', 'SpringerLink Journals - AutoHoldings'], ['NATURE', 'Nature'])
      : issn === ISSN_OF.sage
        ? sfxWith(issn, ['EZB-NALIW-00495_SAGE_JOURNALS_KOMPLETT_AL', 'EZB-NALIW-00495 Sage Journals Komplett AL'])
        : issn === ISSN_OF.wiley
          ? sfxWith(issn, ['MISCELLANEOUS_FREE_EJOURNALS', 'Free E- Journals'], ['PUBMED_CENTRAL_JOURNALS', 'PubMed Central'])
          // TUM's answer for the AMS journal on 2026-10-20: its free collection only.
          : issn === ISSN_OF.ams
            ? sfxWith(issn, ['AMERICAN_MATHEMATICAL_SOCIETY_PUBLICATIONS_FREELY_ACCESSIBLE', 'American Mathematical Society Publications (Freely Accessible)'])
            : sfxWith(issn)),
  });
  const result = await lookupInstitutionServices({ domain: 'mytum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW });
  assert.deepEqual(result.services.map(({ id, collection, ownPlatform }) => ({ id, collection, ownPlatform })), [
    { id: 'nature', collection: 'Nature', ownPlatform: true },
    { id: 'sage', collection: 'EZB-NALIW-00495 Sage Journals Komplett AL', ownPlatform: true },
  ]);
  assert.equal(result.partial, false);
  assert.equal(result.unchecked, 0);
  assert.ok(stub.calls.every(call => call.url.host === SFX_HOST && call.url.pathname === '/sfx_tum'));
  assert.ok(stub.calls.every(call => call.url.searchParams.get('svc.fulltext') === 'yes'));
});

test('an SFX answer about another journal or with only a plain http link leaves the platform unchecked, and an unreadable one a partial list', async () => {
  const stub = upstreams({
    sfx: issn => (issn === ISSN_OF.nature
      ? xml(sfxWith('2345-6789', ['MISCELLANEOUS_FREE_EJOURNALS', 'Free E- Journals']))
      : issn === ISSN_OF.sage
        ? xml(sfxWith(issn, ['SAGE_JOURNALS_ALL_TITLES', 'Sage Journals All Titles']).replace('<target_url>https://', '<target_url>http://'))
        : issn === ISSN_OF.wiley ? xml('<html><body>Wartungsarbeiten</body></html>') : xml(sfxWith(issn))),
  });
  const result = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW });
  assert.deepEqual(result.services, []);
  assert.equal(result.unchecked, 2);
  assert.equal(result.partial, true);
});

test('the services route answers for an SFX library and stores its list under the instance', async () => {
  const search = new URLSearchParams({ domain: 'mytum.de', rorId: TUM_ROR }).toString();
  const { response, body, store } = await requestServices(search, {
    resolver: (issn, target) => xml(target!.pathname === '/sfx_tum' && issn === ISSN_OF.nature ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn)),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['nature']);
  assert.deepEqual([...store.values.keys()], [await servicesStoreKey({ domain: 'mytum.de', rorId: TUM_ROR }, ROUTE_ENV)]);
});

/**
 * A page clock that each SFX probe moves on by `step`, the stand-in for a slow
 * resolver: TUM's took about 1.3 s a probe, four at a time (2026-10-20).
 */
function slowSfx(step: number, answer: (issn: string) => string = issn => sfxWith(issn)) {
  let clock = 0;
  const stub = upstreams({ sfx: issn => { clock += step; return xml(answer(issn)); } });
  return { stub, now: () => clock, later: () => { clock += 60_000; } };
}

test('a slow library\'s list goes on from where each request ran out of time, through the catalogue once', async () => {
  const { stub, now, later } = slowSfx(400, issn => (issn === ISSN_OF.nature || issn === ISSN_OF.economist ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn)));
  const store = memoryStore();
  const requests: string[][] = [];
  let result;
  do {
    const before = stub.calls.length;
    result = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now, store });
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    requests.push(stub.calls.slice(before).map(call => call.url.searchParams.get('rft.issn')!));
    later();
  } while (result.remaining > 0);
  // Every platform asked about once, in catalogue order, with no gap and no repeat.
  assert.deepEqual(requests.flat(), SERVICE_CATALOGUE.map(entry => entry.issn));
  // Requests ended on time, well short of the catalogue.
  assert.ok(requests.length > 3);
  assert.ok(requests.every(request => request.length < SERVICE_CATALOGUE.length / 3));
  assert.deepEqual(result.services.map(service => service.id), ['nature', 'economist']);
  assert.ok(stub.maxInFlight() <= 6);
});

test('a probe cut short by the deadline is partial, not a missing platform, and is asked again next time', async () => {
  const cut = new Set([ISSN_OF.springerlink, ISSN_OF.wiley]);
  let cutting = true;
  const stub = upstreams({
    sfx: issn => (cutting && cut.has(issn) ? timeout() : xml(issn === ISSN_OF.nature || issn === ISSN_OF.acs ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn))),
  });
  const store = memoryStore();
  const first = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.equal(first.partial, true);
  assert.equal(first.remaining, 0);
  assert.deepEqual(first.services.map(service => service.id), ['nature', 'acs']);
  cutting = false;
  const before = stub.calls.length;
  const next = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.equal(next.partial, false);
  assert.deepEqual(stub.calls.slice(before).map(call => call.url.searchParams.get('rft.issn')).sort(), [...cut].sort());
  assert.deepEqual(next.services.map(service => service.id), ['nature', 'acs']);
});

test('the time GetFTR takes does not shorten the request, and a GetFTR held to the deadline makes it an outage', async () => {
  // GetFTR undecided, quickly or after 8 s, then a resolver at 400 ms a probe: as many probes either way.
  const probesAfter = async (wait: number) => {
    let clock = 0;
    const stub = upstreams({
      getftr: dois => { clock = Math.max(clock, wait); return getftrAnswering(() => ({ statusCode: 200, entitled: 'maybe' }))(dois); },
      resolver: () => { clock += 400; return xml(CTO_NONE); },
    });
    const result = await lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV, now: () => clock });
    assert.equal(result.partial, false);
    return { result, probes: stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com').length };
  };
  const quick = await probesAfter(0);
  const slow = await probesAfter(8_000);
  assert.ok(quick.probes > 4 && quick.probes < SERVICE_CATALOGUE.length);
  assert.equal(slow.probes, quick.probes);
  assert.equal(slow.result.remaining, quick.result.remaining);
  // GetFTR held until the deadline, which cuts every probe after it: an outage, not an empty library.
  let clock = 0;
  const held = upstreams({ getftr: () => { clock = 12_000; return timeout(); }, resolver: () => timeout() });
  await assert.rejects(
    lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: held.fetchImpl, env: GETFTR_ENV, now: () => clock }),
    error => error instanceof InstitutionAccessError && error.status === 502,
  );
});

test('a catalogue entry without a verdict is the only one asked about, and the list keeps what the store knows', async () => {
  const stub = upstreams({ resolver: issn => xml(issn === ISSN_OF.nature ? ctoWith('Nature') : CTO_NONE) });
  const store = memoryStore();
  const first = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.deepEqual(first.services.map(service => service.id), ['nature']);
  assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
  // Nothing left to ask: the store answers.
  const again = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.deepEqual(again, first);
  assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
  // An entry added to the catalogue, stood in for by one the store forgets.
  const [key] = store.values.keys();
  const record = JSON.parse(store.values.get(key)!) as Record<string, unknown>;
  const added = SERVICE_CATALOGUE.find(entry => entry.id === 'economist')!;
  delete record[probeKey(added)];
  store.values.set(key, JSON.stringify(record));
  const grown = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.deepEqual(stub.calls.slice(SERVICE_CATALOGUE.length).map(call => call.url.searchParams.get('rft.issn')), [added.issn]);
  assert.deepEqual(grown.services.map(service => service.id), ['nature']);
  assert.equal(Object.keys(JSON.parse(store.values.get(key)!) as object).length, SERVICE_CATALOGUE.length);
});

test('a verdict older than thirty days is asked again, and a key the catalogue dropped is left out of the record', async () => {
  const stub = upstreams({ resolver: issn => xml(issn === ISSN_OF.nature ? ctoWith('Nature') : CTO_NONE) });
  const store = memoryStore();
  let clock = NOW();
  await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: () => clock, store });
  const [key] = store.values.keys();
  const dropped = 'gone|0000-0000|2000||Gone';
  store.values.set(key, JSON.stringify({ ...JSON.parse(store.values.get(key)!), [dropped]: { at: clock, verdict: null } }));
  clock += VERDICT_TTL_MS - 1;
  await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: () => clock, store });
  assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
  clock += 1;
  const renewed = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: () => clock, store });
  assert.equal(stub.calls.length, 2 * SERVICE_CATALOGUE.length);
  assert.deepEqual(renewed.services.map(service => service.id), ['nature']);
  assert.equal(dropped in JSON.parse(store.values.get(key)!), false);
});

test('a store that cannot be written costs the next request its probes, not the answer', async (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const stub = upstreams({ resolver: issn => xml(issn === ISSN_OF.nature ? ctoWith('Nature') : CTO_NONE) });
  const store = memoryStore({ put: async () => { throw new Error('KV put failed'); } });
  const result = await lookupInstitutionServices({ domain: 'usal.es' }, { fetchImpl: stub.fetchImpl, now: NOW, store });
  assert.deepEqual(result.services.map(service => service.id), ['nature']);
  assert.equal(result.partial, false);
  assert.equal(quiet.mock.callCount(), 1);
  assert.equal(store.values.size, 0);
});

test('the route without the store binding answers as an outage and asks no resolver', async (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const { response, body, calls } = await requestServices('domain=usal.es', { store: null });
  assert.equal(response.status, 502);
  assert.deepEqual(body, { code: 'ACCESS_LOOKUP_UNAVAILABLE' });
  assert.ok(calls.every(host => host === 'identitytoolkit.googleapis.com'), calls.join(', '));
  assert.equal(quiet.mock.callCount(), 1);
});

test('the records of each library are kept apart, and a university\'s mail domains share one', async () => {
  const keys = new Set<string>();
  for (const [domain, rorId] of [['mytum.de', TUM_ROR], ['campus.lmu.de', LMU_ROR], ['fau.de', FAU_ROR], ['usal.es', null]] as Array<[string, string | null]>) {
    keys.add(await servicesStoreKey({ domain, rorId }, {}));
  }
  assert.equal(keys.size, 4);
  assert.ok(keys.has(await servicesStoreKey({ domain: 'tum.de', rorId: TUM_ROR }, {})));
});

test('a press title read through an aggregator opens through the library\'s login, except where that host signs in itself', async () => {
  const ebsco = 'https://search.ebscohost.com/direct.asp?jid=ARW&site=ehost-live&db=bsu';
  const gale = 'https://find.gale.com/openurl/openurl?res_id=info%3Asid%2Fgale%3AAONE&req_dat=info%3Asid%2Fgale%3Augnid%3Almum&rft.issn=0013-0613';
  const answer = (link: string) => (issn: string) => xml(issn === ISSN_OF.economist ? sfxWith(issn, ['EBSCOHOST_BUSINESS_SOURCE_ULTIMATE', 'EBSCOhost Business Source Ultimate', link]) : sfxWith(issn));
  const tum = await lookupInstitutionServices({ domain: 'mytum.de', rorId: TUM_ROR }, { fetchImpl: upstreams({ sfx: answer(ebsco) }).fetchImpl, now: NOW });
  const economist = tum.services.find(service => service.id === 'economist')!;
  assert.equal(economist.url, `${TUM_LOGIN}${encodeURIComponent(ebsco)}`);
  assert.equal(new URL(economist.url).searchParams.get('qurl'), ebsco);
  const lmu = await lookupInstitutionServices({ domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl: upstreams({ sfx: answer(gale) }).fetchImpl, now: NOW });
  assert.equal(lmu.services.find(service => service.id === 'economist')!.url, gale);
  const fau = await lookupInstitutionServices({ domain: 'fau.de', rorId: FAU_ROR }, { fetchImpl: upstreams({ sfx: answer(ebsco) }).fetchImpl, now: NOW });
  assert.equal(fau.services.find(service => service.id === 'economist')!.url, ebsco);
  // LMU's links for The Guardian (2026-10-20): Gale's reaches LMU's sign-in through Gale's own,
  // Nexis Uni's ends at LexisNexis's sign-in and goes through E-Medien.
  const galeLink = 'https://link.gale.com/apps/pub/0IOB/AONE?u=lmum';
  const nexis = 'https://advance.lexis.com/api/search?source=MTA2OTMyOA&context=1516831';
  const guardian = async (...targets: Array<[string, string, string]>) => {
    const fetchImpl = upstreams({ sfx: issn => xml(issn === ISSN_OF.guardian ? sfxWith(issn, ...targets) : sfxWith(issn)) }).fetchImpl;
    const result = await lookupInstitutionServices({ domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl, now: NOW });
    return result.services.find(service => service.id === 'guardian')!.url;
  };
  assert.equal(await guardian(['GALE_ACADEMIC_ONEFILE', 'Gale Academic OneFile', galeLink], ['NEXIS_UNI', 'Nexis Uni', nexis]), galeLink);
  assert.equal(await guardian(['NEXIS_UNI', 'Nexis Uni', nexis]), `${LMU_LOGIN}${encodeURIComponent(nexis)}`);
});


test('journal candidates keep canonical editions and discovery provenance without duplicating a probe', () => {
  const owners = new Map<string, string>();
  for (const entry of SERVICE_CATALOGUE) {
    for (const issn of [entry.issn, entry.eissn].filter((value): value is string => Boolean(value))) {
      assert.match(issn, /^\d{4}-\d{3}[\dX]$/);
      const digits = issn.replace('-', '').split('').map(value => value === 'X' ? 10 : Number(value));
      assert.equal(digits.reduce((sum, digit, index) => sum + digit * (8 - index), 0) % 11, 0, issn);
      assert.equal(owners.has(issn), false, `${issn} already belongs to ${owners.get(issn)}`);
      owners.set(issn, entry.id);
    }
    if (entry.kind !== 'journal') continue;
    assert.equal(entry.id, `journal-${entry.issn}`);
    assert.ok(entry.eissn);
    assert.equal(entry.doi, undefined);
    // The frontend's publisherLogos test checks every reference against bundled assets.
    assert.ok(entry.platformId);
    assert.ok(entry.sources && entry.sources.length >= 2);
    for (const source of entry.sources) assert.equal(new URL(source).protocol, 'https:');
  }
  assert.equal(owners.get('1361-6382'), 'journal-0264-9381');
  assert.equal(owners.get('1755-4349'), 'journal-1755-4330');
  assert.equal(owners.get('0953-8984'), 'iop');
});

// The whole catalogue is probed; the journal rows are the ones asked about 2021.
const JOURNAL_ISSNS = new Set(SERVICE_CATALOGUE.filter(entry => entry.kind === 'journal').map(entry => entry.issn));

test('new Nature and IOP journals resolve independently through Alma and SFX, preserving library links', async () => {
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(issn === '1755-4330' ? ctoWith('Nature Journals')
        : issn === '0264-9381' ? ctoWith('ProQuest Science Collection') : CTO_NONE),
      sfx: issn => xml(issn === '1755-4330' ? sfxWith(issn, ['NATURE', 'Nature Journals'])
        : issn === '0264-9381' ? sfxWith(issn, ['PROQUEST', 'ProQuest Science Collection']) : sfxWith(issn)),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-1755-4330', name: 'Nature Chemistry', platformId: 'nature', ownPlatform: true },
      { id: 'journal-0264-9381', name: 'Classical and Quantum Gravity', platformId: 'iop', ownPlatform: false },
    ]);
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.equal(stub.maxInFlight(), 6);
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});

test('new journal no-access, inconclusive and unavailable outcomes remain distinct', async () => {
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(issn === '1755-4330' ? '<html>Maintenance</html>' : CTO_NONE),
      sfx: issn => xml(issn === '1755-4330' ? '<html>Maintenance</html>'
        : issn === '1476-1122' ? sfxWith('0028-0836', ['NATURE', 'Nature']) : sfxWith(issn)),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services, []);
    assert.equal(result.partial, true);
    assert.equal(result.unchecked, domain === 'tum.de' ? 1 : 0);
    const unavailable = upstreams({ resolver: timeout, sfx: timeout });
    await assert.rejects(lookupInstitutionServices({ domain }, { fetchImpl: unavailable.fetchImpl }),
      error => error instanceof InstitutionAccessError && error.code === 'ACCESS_LOOKUP_UNAVAILABLE');
  }
  const stub = upstreams();
  const unchecked = await lookupInstitutionServices({ domain: 'nowhere.example', entityId: ENTITY_ID },
    { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.deepEqual(unchecked.services, []);
  assert.equal(unchecked.partial, false);
  assert.equal(unchecked.unchecked, SERVICE_CATALOGUE.length);
  assert.ok(stub.calls.every(call => call.url.host === 'entitlements.prod.getft.io'));
});


test('sport, social policy, education and law journals preserve independent library access and publisher logos', async () => {
  const packages: Record<string, string> = {
    '0736-5829': 'Human Kinetics Journals',
    '0305-5736': 'ProQuest Social Science Collection',
    '0002-8312': 'SAGE Journals',
    '0143-6503': 'Oxford University Press Journals',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, monogram, ownPlatform }) => ({ id, name, platformId, monogram, ownPlatform })), [
      { id: 'journal-0736-5829', name: 'Adapted Physical Activity Quarterly', platformId: 'humankinetics', monogram: 'HK', ownPlatform: true },
      { id: 'journal-0305-5736', name: 'Policy & Politics', platformId: 'bristol', monogram: 'PP', ownPlatform: false },
      { id: 'journal-0002-8312', name: 'American Educational Research Journal', platformId: 'sage', monogram: 'SAGE', ownPlatform: true },
      { id: 'journal-0143-6503', name: 'Oxford Journal of Legal Studies', platformId: 'oup', monogram: 'OUP', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Social Science Collection');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});


test('agriculture, management and environmental journals retain paid access independently of their platform sample', async () => {
  const packages: Record<string, string> = {
    '0021-8596': 'Cambridge University Press Journals',
    '1359-8546': 'ProQuest Business Collection',
    '0045-5067': 'Canadian Science Publishing Journals',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-0021-8596', name: 'The Journal of Agricultural Science', platformId: 'cambridge', ownPlatform: true },
      { id: 'journal-1359-8546', name: 'Supply Chain Management: An International Journal', platformId: 'emerald', ownPlatform: false },
      { id: 'journal-0045-5067', name: 'Canadian Journal of Forest Research', platformId: 'canscipub', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Business Collection');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});


test('humanities journals retain their own access route without granting their publisher collection', async () => {
  const packages: Record<string, string> = {
    '0011-3204': 'University of Chicago Press Journals',
    '0730-7829': 'EBSCOhost Academic Search Ultimate',
    '0161-0775': 'Duke University Press Journals',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-0011-3204', name: 'Current Anthropology', platformId: 'chicago', ownPlatform: true },
      { id: 'journal-0730-7829', name: 'Music Perception', platformId: 'ucpress', ownPlatform: false },
      { id: 'journal-0161-0775', name: 'Theater', platformId: 'dukeupress', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'EBSCOhost Academic Search Ultimate');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});


test('law, politics, economics, philosophy and literature journals use independent paid archive holdings', async () => {
  const packages: Record<string, string> = {
    '0008-1973': 'Cambridge University Press Journals',
    '0020-8183': 'ProQuest Political Science Database',
    '0045-5091': 'Cambridge University Press Journals',
    '0734-306X': 'University of Chicago Press Journals',
    '0009-837X': 'EBSCOhost Academic Search Ultimate',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-0008-1973', name: 'The Cambridge Law Journal', platformId: 'cambridge', ownPlatform: true },
      { id: 'journal-0020-8183', name: 'International Organization', platformId: 'cambridge', ownPlatform: false },
      { id: 'journal-0045-5091', name: 'Canadian Journal of Philosophy', platformId: 'cambridge', ownPlatform: true },
      { id: 'journal-0734-306X', name: 'Journal of Labor Economics', platformId: 'chicago', ownPlatform: true },
      { id: 'journal-0009-837X', name: 'Classical Philology', platformId: 'chicago', ownPlatform: false },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Political Science Database');
    assert.equal(result.services[4].collection, 'EBSCOhost Academic Search Ultimate');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});


test('nursing, veterinary, geography and operations journals retain independent holdings and aggregator routes', async () => {
  const packages: Record<string, string> = {
    '0309-2402': 'Wiley Online Library All Journals',
    '0161-3499': 'ProQuest Central',
    '0272-3638': 'Taylor &amp; Francis Journals',
    '0030-364X': 'EBSCOhost Business Source Complete',
    '0732-2399': 'EBSCOhost Business Source Complete',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-0309-2402', name: 'Journal of Advanced Nursing', platformId: 'wiley', ownPlatform: true },
      { id: 'journal-0161-3499', name: 'Veterinary Surgery', platformId: 'wiley', ownPlatform: false },
      { id: 'journal-0272-3638', name: 'Urban Geography', platformId: 'tandf', ownPlatform: true },
      { id: 'journal-0030-364X', name: 'Operations Research', platformId: 'informs', ownPlatform: false },
      { id: 'journal-0732-2399', name: 'Marketing Science', platformId: 'informs', ownPlatform: false },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Central');
    assert.equal(result.services[3].collection, 'EBSCOhost Business Source Complete');
    assert.equal(result.services[4].collection, 'EBSCOhost Business Source Complete');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});

test('language, religion and archaeology journals keep title-specific routes and reuse stored verdicts', async () => {
  const packages: Record<string, string> = {
    '1749-5032': 'Edinburgh University Press Journals',
    '0968-1361': 'JSTOR Arts and Sciences',
    '0029-5973': 'Brill Online Journals',
    '0570-5398': 'EBSCOhost Academic Search Premier',
    '1465-5187': 'Taylor &amp; Francis Journals',
  };
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(packages[issn] ? ctoWith(packages[issn]) : CTO_FREE_ONLY),
      sfx: issn => xml(packages[issn] ? sfxWith(issn, ['SUBSCRIBED', packages[issn]])
        : sfxWith(issn, ['FREE', 'Free E-Journals'])),
    });
    const store = memoryStore();
    const options = { fetchImpl: stub.fetchImpl, store, now: NOW };
    const result = await lookupInstitutionServices({ domain }, options);
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-1749-5032', name: 'Corpora', platformId: 'edinburghup', ownPlatform: true },
      { id: 'journal-0968-1361', name: 'Translation and Literature', platformId: 'edinburghup', ownPlatform: false },
      { id: 'journal-0029-5973', name: 'Numen', platformId: 'brill', ownPlatform: true },
      { id: 'journal-0570-5398', name: 'Arabica', platformId: 'brill', ownPlatform: false },
      { id: 'journal-1465-5187', name: 'Public Archaeology', platformId: 'tandf', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'JSTOR Arts and Sciences');
    assert.equal(result.services[3].collection, 'EBSCOhost Academic Search Premier');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(result.remaining, 0);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
    assert.ok(stub.calls.filter(({ url }) => JOURNAL_ISSNS.has(url.searchParams.get('rft.issn')!)).every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
    const cached = await lookupInstitutionServices({ domain }, options);
    assert.deepEqual(cached, result);
    assert.equal(stub.calls.length, SERVICE_CATALOGUE.length);
  }
});
