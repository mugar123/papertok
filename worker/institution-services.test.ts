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
  assert.equal('library' in servicesCacheParams({ domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR } as InstitutionQuery, {} as WorkerEnv), false);
});

test('UVic-UCC and PUC Chile are listed from their own libraries', () => {
  const catalogue = catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET);
  assert.deepEqual(
    servicesCacheParams({ domain: 'uvic-ucc.cat', rorId: 'https://ror.org/006zjws59' } as InstitutionQuery, {} as WorkerEnv),
    { library: '34CSUC_UVIC', host: 'csuc-uvic.alma.exlibrisgroup.com', catalogue, reading: 'balanced-tags-cdata' },
  );
  assert.deepEqual(
    servicesCacheParams({ domain: 'uc.cl', rorId: 'https://ror.org/04teye511' } as InstitutionQuery, {} as WorkerEnv),
    { library: '56PUC_INST', host: 'puc.alma.exlibrisgroup.com', catalogue, reading: 'balanced-tags-cdata' },
  );
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
  assert.equal(result.unchecked, 79); // Eight press titles and 71 journals need a resolver.
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
  assert.equal(result.unchecked, 83); // Four undecided DOIs plus 79 titles without DOIs.
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
  assert.equal(result.unchecked, 43); // Only 36 of the 79 DOI-less titles fit the unpaged request budget.
  assert.equal(stub.calls.length, 40);
  assert.deepEqual(stub.calls.filter(call => call.url.host === 'eu01.alma.exlibrisgroup.com').map(call => call.url.searchParams.get('rft.issn')), SERVICE_CATALOGUE.filter(entry => !entry.doi).slice(0, 36).map(entry => entry.issn));
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
    if (url.host === 'eu01.alma.exlibrisgroup.com' || url.host === 'na03.alma.exlibrisgroup.com' || url.host === 'ca01.alma.exlibrisgroup.com' || url.host === SFX_HOST) return resolver(url.searchParams.get('rft.issn')!, url);
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

test('the services route reads CDATA filters and free flags before caching the list', async () => {
  const date = ctoFiltered('Date Filter', 'Nature')
    .replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>')
    .replace('<key id="Filter reason">Date Filter</key>', '<key id="Filter reason"><![CDATA[Date Filter]]></key>');
  const cases = [
    [date, 0],
    [date.replace('Date Filter', 'IP Filter'), 1],
    [CTO_FREE_ONLY.replace('<key id="Is_free">1</key>', '<key id="Is_free"><![CDATA[1]]></key>'), 0],
  ] as const;
  for (const [answer, unchecked] of cases) {
    const { response, body, servicePuts } = await requestServices('domain=usal.es&offset=0', {
      resolver: issn => xml(issn === ISSN_OF.nature ? answer : CTO_NONE),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body.services, []);
    assert.equal(body.partial, false);
    assert.equal(body.unchecked, unchecked);
    assert.equal(servicePuts.length, 1);
    assert.deepEqual(await servicePuts[0].response.clone().json(), body);
  }
  const live = await requestServices('domain=usal.es&offset=0', {
    resolver: issn => xml(issn === ISSN_OF.nature
      ? ctoFiltered('Date Filter', 'Nature', 'Proquest Central').replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>')
      : CTO_NONE),
  });
  assert.deepEqual(live.body.services.map(service => service.collection), ['Proquest Central']);
  const broken = await requestServices('domain=usal.es&offset=0', {
    resolver: issn => xml(issn === ISSN_OF.nature ? date.replace('Date Filter]]>', 'Date Filter') : CTO_NONE),
  });
  assert.deepEqual(broken.body.services, []);
  assert.equal(broken.body.partial, true);
  assert.equal(broken.servicePuts.length, 1);
  assert.match(broken.servicePuts[0].response.headers.get('cache-control')!, /s-maxage=3600\b/);
});

test('the services route accepts USC\'s stored SAML URN and queries its Alma library', async () => {
  const search = new URLSearchParams({ domain: 'usc.edu', rorId: 'https://ror.org/03taz7m60', entityId: 'urn:mace:incommon:usc.edu', offset: '0' }).toString();
  const { response, body, servicePuts } = await requestServices(search, {
    resolver: (issn, target) => {
      assert.equal(target!.host, 'na03.alma.exlibrisgroup.com');
      assert.equal(target!.pathname, '/view/uresolver/01USC_INST/openurl');
      return xml(issn === ISSN_OF.sciencedirect ? CTO_ENTITLED : CTO_NONE);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['sciencedirect']);
  assert.equal(body.partial, false);
  assert.equal(servicePuts.length, 1);
  assert.equal(new URL(servicePuts[0].key).searchParams.get('library'), '01USC_INST');
  const anonymous = await requestServices(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the services route accepts Manitoba\'s HTTP SAML identifier and queries its Alma library', async () => {
  const search = new URLSearchParams({ domain: 'umanitoba.ca', rorId: 'https://ror.org/02gfys938', entityId: 'http://CAF.AD.UMANITOBA.CA/adfs/services/trust', offset: '0' }).toString();
  const { response, body, servicePuts } = await requestServices(search, {
    resolver: (issn, target) => {
      assert.equal(target!.host, 'ca01.alma.exlibrisgroup.com');
      assert.equal(target!.pathname, '/view/uresolver/01UMB_INST/openurl');
      return xml(issn === ISSN_OF.sciencedirect ? CTO_ENTITLED : CTO_NONE);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['sciencedirect']);
  assert.equal(body.partial, false);
  assert.equal(servicePuts.length, 1);
  assert.equal(new URL(servicePuts[0].key).searchParams.get('library'), '01UMB_INST');
  const anonymous = await requestServices(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the services route rejects malformed URNs and unsafe schemes without provider work or caching', async () => {
  for (const entityId of ['urn:mace:', 'urn::usc.edu', 'urn:mace:incommon:usc edu', 'urn:mace:usc%ZZ', 'javascript:alert(1)', 'http://', 'http://bad host/idp', 'ftp://idp.example.edu', `urn:mace:${'x'.repeat(300)}`]) {
    const { response, body, calls, servicePuts } = await requestServices(new URLSearchParams({ domain: 'usc.edu', entityId }).toString());
    assert.equal(response.status, 400, entityId);
    assert.deepEqual(body, { code: 'INVALID_INSTITUTION_ID' });
    assert.ok(calls.every(host => host === 'identitytoolkit.googleapis.com'));
    assert.equal(servicePuts.length, 0);
  }
});

test('the services route refuses the Hawaiʻi system without asking Mānoa\'s resolver or caching', async () => {
  const search = new URLSearchParams({ domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR, offset: '0' }).toString();
  const { response, body, calls, servicePuts } = await requestServices(search);
  assert.equal(response.status, 404);
  assert.deepEqual(body, { code: 'INSTITUTION_NOT_SUPPORTED' });
  assert.equal(servicePuts.length, 0);
  assert.ok(calls.every(host => !host.endsWith('.alma.exlibrisgroup.com')), `asked a resolver: ${calls.join(', ')}`);
});

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
    ['reading', 'balanced-tags-cdata'],
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
  assert.deepEqual(servicesCacheParams({ domain: 'usal.es', entityId: ENTITY_ID }, {}), { library: '34BUC_USAL', host: 'eu01.alma.exlibrisgroup.com', catalogue: fingerprint, reading: 'balanced-tags-cdata' });
  assert.deepEqual(
    servicesCacheParams({ domain: 'usal.es', entityId: ENTITY_ID }, GETFTR_ENV),
    { library: '34BUC_USAL', host: 'eu01.alma.exlibrisgroup.com', entityId: ENTITY_ID, catalogue: fingerprint, reading: 'balanced-tags-cdata' },
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
  // A page can start at any platform, since it ends where its time ran out.
  const later = await requestServices('domain=usal.es&offset=1');
  assert.equal(later.response.status, 200);
  assert.equal(later.body.nextOffset, 37);
  assert.equal(new URL(later.servicePuts[0].key).searchParams.get('offset'), '1');
  for (const raw of ['', '-1', '1.5', 'NaN', String(SERVICE_CATALOGUE.length), String(SERVICE_CATALOGUE.length + 1), '9007199254740992']) {
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
  const result = await lookupInstitutionServices({ domain: 'mytum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, offset: 0 });
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
  const result = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, offset: 0 });
  assert.deepEqual(result.services, []);
  assert.equal(result.unchecked, 2);
  assert.equal(result.partial, true);
});

test('the services route answers for an SFX library and caches its list under the instance and the product', async () => {
  const search = new URLSearchParams({ domain: 'mytum.de', rorId: TUM_ROR, offset: '0' }).toString();
  const { response, body, servicePuts } = await requestServices(search, {
    resolver: (issn, target) => xml(target!.pathname === '/sfx_tum' && issn === ISSN_OF.nature ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn)),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map(service => service.id), ['nature']);
  assert.equal(servicePuts.length, 1);
  const key = new URL(servicePuts[0].key).searchParams;
  assert.deepEqual([key.get('library'), key.get('host'), key.get('product')], ['sfx_tum', SFX_HOST, 'sfx']);
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

test('a slow library\'s list goes on from where each page ran out of time, through the catalogue once', async () => {
  const { stub, now, later } = slowSfx(400, issn => (issn === ISSN_OF.nature || issn === ISSN_OF.economist ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn)));
  const pages: Array<{ offset: number; next: number | null; probed: string[] }> = [];
  const listed: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const before = stub.calls.length;
    const result = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now, offset });
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    // Each page names the catalogue it was cut from, the one in its cache key.
    assert.equal(result.catalogue, catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET));
    pages.push({ offset, next: result.nextOffset!, probed: stub.calls.slice(before).map(call => call.url.searchParams.get('rft.issn')!) });
    listed.push(...result.services.map(service => service.id));
    later();
    offset = result.nextOffset!;
  }
  // Every platform asked about once, in catalogue order, with no gap and no repeat.
  assert.deepEqual(pages.flatMap(page => page.probed), SERVICE_CATALOGUE.map(entry => entry.issn));
  for (const [index, page] of pages.entries()) {
    assert.equal(page.offset + page.probed.length, page.next ?? SERVICE_CATALOGUE.length);
    if (index > 0) assert.equal(page.offset, pages[index - 1].next);
  }
  // Pages ended on time, well short of the 36 a fast library gets.
  assert.ok(pages.length > 3);
  assert.ok(pages.every(page => page.probed.length < 36));
  assert.deepEqual(listed, ['nature', 'economist']);
  assert.ok(stub.maxInFlight() <= 4);
});

test('a probe cut short by the deadline is a partial page, not a missing platform, and the next page goes on', async () => {
  const cut = new Set([ISSN_OF.springerlink, ISSN_OF.wiley]);
  const stub = upstreams({
    sfx: issn => (cut.has(issn) ? timeout() : xml(issn === ISSN_OF.nature || issn === ISSN_OF.acs ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn))),
  });
  const first = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, offset: 0 });
  assert.equal(first.partial, true);
  assert.deepEqual(first.services.map(service => service.id), ['nature', 'acs']);
  assert.equal(first.nextOffset, 36);
  const next = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now: NOW, offset: first.nextOffset! });
  assert.equal(next.partial, false);
  assert.equal(next.nextOffset, 72);
});

test('the time GetFTR takes does not shorten a page, and a GetFTR held to the deadline makes it an outage', async () => {
  // GetFTR undecided, quickly or after 8 s, then a resolver at 400 ms a probe: the page is as long either way.
  const pageAfter = async (wait: number) => {
    let clock = 0;
    const stub = upstreams({
      getftr: dois => { clock = Math.max(clock, wait); return getftrAnswering(() => ({ statusCode: 200, entitled: 'maybe' }))(dois); },
      resolver: () => { clock += 400; return xml(CTO_NONE); },
    });
    return lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV, now: () => clock, offset: 0 });
  };
  const quick = await pageAfter(0);
  const slow = await pageAfter(8_000);
  assert.ok(quick.nextOffset! > 4 && quick.nextOffset! < 36);
  assert.equal(slow.nextOffset, quick.nextOffset);
  assert.equal(slow.partial, false);
  // GetFTR held until the deadline, which cuts every probe after it: an outage, not an empty page.
  let clock = 0;
  const held = upstreams({ getftr: () => { clock = 12_000; return timeout(); }, resolver: () => timeout() });
  await assert.rejects(
    lookupInstitutionServices({ domain: 'usal.es', entityId: ENTITY_ID }, { fetchImpl: held.fetchImpl, env: GETFTR_ENV, now: () => clock, offset: 0 }),
    error => error instanceof InstitutionAccessError && error.status === 502,
  );
});

test('a request without paging is not cut at the start window: a slow library is asked the budget\'s worth', async () => {
  const { stub, now } = slowSfx(400);
  const result = await lookupInstitutionServices({ domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl, now });
  assert.equal(stub.calls.length, SUBREQUEST_BUDGET);
  assert.equal(result.unchecked, SERVICE_CATALOGUE.length - SUBREQUEST_BUDGET);
  assert.equal(result.nextOffset, undefined);
  assert.equal(result.catalogue, undefined);
});

/** The services route with an edge cache that keeps what it is given, for a run that stops and one that resumes. */
function keptEdgeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (key: RequestInfo | URL) => store.get((key as Request).url)?.clone() ?? null,
    put: async (key: RequestInfo | URL, response: Response) => { store.set((key as Request).url, response.clone()); },
  };
}

test('a list stopped after its first page resumes from the edge cache without asking again for what it has', async () => {
  const edge = keptEdgeCache();
  const asked: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith('accounts:lookup')) return jsonResponse({ users: [{ localId: 'alice-uid' }] });
    if (url.host !== SFX_HOST) throw new Error(`unexpected upstream ${url}`);
    asked.push(url.searchParams.get('rft.issn')!);
    const issn = url.searchParams.get('rft.issn')!;
    return xml(issn === ISSN_OF.nature || issn === ISSN_OF.businessweek ? sfxWith(issn, ['NATURE', 'Nature']) : sfxWith(issn));
  };
  (globalThis as TestGlobals).caches = { default: edge };
  const page = async (offset: number) => {
    const response = await reportApi.fetch(new Request(`https://api.papertok.test/institution/services?${new URLSearchParams({ domain: 'mytum.de', rorId: TUM_ROR, offset: String(offset) })}`, {
      headers: { origin: 'https://papertok.app', authorization: `Bearer ${TOKEN}` },
    }), ROUTE_ENV);
    return response.json<Awaited<ReturnType<typeof lookupInstitutionServices>>>();
  };
  try {
    // The first run stops after one page.
    const first = await page(0);
    const askedFirst = asked.length;
    assert.equal(first.nextOffset, 36);
    // The next run starts over: the page it has is served from the edge, the
    // rest is asked about, and nothing is lost or asked twice.
    const listed: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await page(offset);
      listed.push(...result.services.map(service => service.id));
      offset = result.nextOffset!;
    }
    assert.deepEqual(listed, ['nature', 'businessweek']);
    assert.deepEqual(asked, SERVICE_CATALOGUE.map(entry => entry.issn));
    assert.equal(askedFirst, 36);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('the cached pages of each library, product and page are kept apart, and an Alma library\'s carry no product', () => {
  const keys = new Set<string>();
  for (const [domain, rorId, product] of [['mytum.de', TUM_ROR, 'sfx'], ['campus.lmu.de', LMU_ROR, 'sfx'], ['fau.de', FAU_ROR, 'sfx'], ['usal.es', null, null]] as Array<[string, string | null, string | null]>) {
    for (const offset of [0, 18, 36]) {
      const params = servicesCacheParams({ domain, rorId }, {}, offset) as Record<string, unknown>;
      assert.equal(params.product, product ?? undefined, domain);
      assert.equal(params.offset, String(offset));
      keys.add(JSON.stringify(params));
    }
  }
  assert.equal(keys.size, 12);
});

test('a press title read through an aggregator opens through the library\'s login, except where that host signs in itself', async () => {
  const ebsco = 'https://search.ebscohost.com/direct.asp?jid=ARW&site=ehost-live&db=bsu';
  const gale = 'https://find.gale.com/openurl/openurl?res_id=info%3Asid%2Fgale%3AAONE&req_dat=info%3Asid%2Fgale%3Augnid%3Almum&rft.issn=0013-0613';
  const answer = (link: string) => (issn: string) => xml(issn === ISSN_OF.economist ? sfxWith(issn, ['EBSCOHOST_BUSINESS_SOURCE_ULTIMATE', 'EBSCOhost Business Source Ultimate', link]) : sfxWith(issn));
  const tum = await lookupInstitutionServices({ domain: 'mytum.de', rorId: TUM_ROR }, { fetchImpl: upstreams({ sfx: answer(ebsco) }).fetchImpl, now: NOW, offset: 36 });
  const economist = tum.services.find(service => service.id === 'economist')!;
  assert.equal(economist.url, `${TUM_LOGIN}${encodeURIComponent(ebsco)}`);
  assert.equal(new URL(economist.url).searchParams.get('qurl'), ebsco);
  const lmu = await lookupInstitutionServices({ domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl: upstreams({ sfx: answer(gale) }).fetchImpl, now: NOW, offset: 36 });
  assert.equal(lmu.services.find(service => service.id === 'economist')!.url, gale);
  const fau = await lookupInstitutionServices({ domain: 'fau.de', rorId: FAU_ROR }, { fetchImpl: upstreams({ sfx: answer(ebsco) }).fetchImpl, now: NOW, offset: 36 });
  assert.equal(fau.services.find(service => service.id === 'economist')!.url, ebsco);
  // LMU's links for The Guardian (2026-10-20): Gale's reaches LMU's sign-in through Gale's own,
  // Nexis Uni's ends at LexisNexis's sign-in and goes through E-Medien.
  const galeLink = 'https://link.gale.com/apps/pub/0IOB/AONE?u=lmum';
  const nexis = 'https://advance.lexis.com/api/search?source=MTA2OTMyOA&context=1516831';
  const guardian = async (...targets: Array<[string, string, string]>) => {
    const fetchImpl = upstreams({ sfx: issn => xml(issn === ISSN_OF.guardian ? sfxWith(issn, ...targets) : sfxWith(issn)) }).fetchImpl;
    const result = await lookupInstitutionServices({ domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl, now: NOW, offset: 36 });
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

test('new Nature and IOP journals resolve independently through Alma and SFX, preserving library links', async () => {
  for (const domain of ['usal.es', 'tum.de']) {
    const stub = upstreams({
      resolver: issn => xml(issn === '1755-4330' ? ctoWith('Nature Journals')
        : issn === '0264-9381' ? ctoWith('ProQuest Science Collection') : CTO_NONE),
      sfx: issn => xml(issn === '1755-4330' ? sfxWith(issn, ['NATURE', 'Nature Journals'])
        : issn === '0264-9381' ? sfxWith(issn, ['PROQUEST', 'ProQuest Science Collection']) : sfxWith(issn)),
    });
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl, offset: 74 });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-1755-4330', name: 'Nature Chemistry', platformId: 'nature', ownPlatform: true },
      { id: 'journal-0264-9381', name: 'Classical and Quantum Gravity', platformId: 'iop', ownPlatform: false },
    ]);
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(result.nextOffset, 110);
    assert.ok(stub.calls.every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    assert.equal(stub.calls.length, 36);
    assert.equal(stub.maxInFlight(), 4);
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
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl, offset: 74 });
    assert.deepEqual(result.services, []);
    assert.equal(result.partial, true);
    assert.equal(result.unchecked, domain === 'tum.de' ? 1 : 0);
    const unavailable = upstreams({ resolver: timeout, sfx: timeout });
    await assert.rejects(lookupInstitutionServices({ domain }, { fetchImpl: unavailable.fetchImpl, offset: 74 }),
      error => error instanceof InstitutionAccessError && error.code === 'ACCESS_LOOKUP_UNAVAILABLE');
  }
  const stub = upstreams();
  const unchecked = await lookupInstitutionServices({ domain: 'nowhere.example', entityId: ENTITY_ID },
    { fetchImpl: stub.fetchImpl, env: GETFTR_ENV, offset: 74 });
  assert.deepEqual(unchecked.services, []);
  assert.equal(unchecked.partial, false);
  assert.equal(unchecked.unchecked, 36);
  assert.equal(stub.calls.length, 0);
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
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl, offset: 103 });
    assert.deepEqual(result.services.map(({ id, name, platformId, monogram, ownPlatform }) => ({ id, name, platformId, monogram, ownPlatform })), [
      { id: 'journal-0736-5829', name: 'Adapted Physical Activity Quarterly', platformId: 'humankinetics', monogram: 'HK', ownPlatform: true },
      { id: 'journal-0305-5736', name: 'Policy & Politics', platformId: 'bristol', monogram: 'PP', ownPlatform: false },
      { id: 'journal-0002-8312', name: 'American Educational Research Journal', platformId: 'sage', monogram: 'SAGE', ownPlatform: true },
      { id: 'journal-0143-6503', name: 'Oxford Journal of Legal Studies', platformId: 'oup', monogram: 'OUP', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Social Science Collection');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(result.nextOffset, 139);
    assert.equal(stub.calls.length, 36);
    assert.ok(stub.calls.every(({ url }) => url.searchParams.get('rft.date') === '2021'));
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
    const result = await lookupInstitutionServices({ domain }, { fetchImpl: stub.fetchImpl, offset: 127 });
    assert.deepEqual(result.services.map(({ id, name, platformId, ownPlatform }) => ({ id, name, platformId, ownPlatform })), [
      { id: 'journal-0021-8596', name: 'The Journal of Agricultural Science', platformId: 'cambridge', ownPlatform: true },
      { id: 'journal-1359-8546', name: 'Supply Chain Management: An International Journal', platformId: 'emerald', ownPlatform: false },
      { id: 'journal-0045-5067', name: 'Canadian Journal of Forest Research', platformId: 'canscipub', ownPlatform: true },
    ]);
    assert.equal(result.services[1].collection, 'ProQuest Business Collection');
    assert.equal(result.partial, false);
    assert.equal(result.unchecked, 0);
    assert.equal(result.nextOffset, null);
    assert.equal(stub.calls.length, 18);
    assert.ok(stub.calls.every(({ url }) => url.searchParams.get('rft.date') === '2021'));
    for (const service of result.services) {
      assert.match(service.url, domain === 'tum.de' ? /^https:\/\/tum-eaccess\.de\/login\?qurl=/ : /^https:\/\/buc-usal\.alma\.exlibrisgroup\.com\//);
    }
  }
});
