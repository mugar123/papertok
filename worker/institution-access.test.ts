import type { TestGlobals } from './test-types.ts';
import test from 'node:test';
import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery } from './institution-access.ts';
type AccessOptions = { token?: string | null; method?: string; resolver?: (target: URL) => Response | Promise<Response> };
type Resolver = (issn: string, target?: URL) => Response | Promise<Response>;

import assert from 'node:assert/strict';
import {
  InstitutionAccessError,
  lookupInstitutionAccess,
  parseResolverAnswer,
  readAccessQuery,
  upstreamParams,
} from './institution-access.ts';
import reportApi from './index.ts';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.ts';

// Captured 2026-10-13 from the USAL Alma resolver (svc_dat=CTO), with the
// performance counters removed: Cell, ISSN 0092-8674, 2020.
const CTO_CELL = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="rft.stitle">Cell</key>
      <key id="rft.pub">MIT Press,</key>
      <key id="rft.place">Cambridge, Mass :</key>
      <key id="licenseEnable">false</key>
      <key id="sfx.sid">DEFAULT</key>
      <key id="rft.jtitle">Cell</key>
      <key id="available_services">viewit</key>
      <key id="available_services">getit</key>
      <key id="rft.genre">article</key>
      <key id="Incoming_URL">http%3A%2F%2Feu01.alma.exlibrisgroup.com%2Fview%2Furesolver%2F34BUC_USAL%2Fopenurl%3Fdebug%3Dtrue%26svc_dat%3DCTO%26rft.genre%3Darticle%26rft.issn%3D0092-8674%26rft.date%3D2020</key>
      <key id="institution">5773</key>
      <key id="rft.normalized_issn">0092-8674</key>
      <key id="NZMaterialVideo">false</key>
      <key id="http_request_type">GET</key>
      <key id="rft.issn">0092-8674</key>
      <key id="prefer_ordered_resources">false</key>
      <key id="rft.year">2020</key>
      <key id="rft.mms_id">991007658309705773</key>
      <key id="user_ip" xsi:nil="true"/>
      <key id="rft.orig_genre">article</key>
      <key id="inventory_id">5177780100005773</key>
      <key id="inventory_id">2150437040005773</key>
      <key id="resource_type">journals</key>
      <key id="rft.inventory_id">5177780100005773</key>
      <key id="rft.inventory_id">2150437040005773</key>
      <key id="publication_place">Cambridge, Mass :</key>
      <key id="rft.object_type">JOURNAL</key>
      <key id="rft.date">2020</key>
      <key id="rft.publisher">MIT Press,</key>
      <key id="ctx_id">8714942920005773</key>
      <key id="rft.pubdate">1974-</key>
      <key id="full_text_indicator">true</key>
      <key id="rft.atitle">Cell</key>
      <key id="rft.title">Cell</key>
      <key id="customer">5770</key>
    </keys>
  </context_object>
  <context_services>
    <context_service service_type="getFullTxt" context_service_id="8714574420005773">
      <keys>
        <key id="package_name">Cell Press</key>
        <key id="package_public_name">Cell Press Free Archives</key>
        <key id="package_original_name">Cell Press Free Archives</key>
        <key id="package_display_name">Cell Press Free Archives</key>
        <key id="package_internal_name">CELL_PRESS_FREE_ARCHIVES</key>
        <key id="interface_name">Cell Press</key>
        <key id="db_id">FCP</key>
        <key id="package_pid">6175053350005773</key>
        <key id="service_type_description">Full text available via</key>
        <key id="character_set">iso-8859-1</key>
        <key id="Is_free">1</key>
        <key id="request_source">Unknown</key>
        <key id="portfolio_PID">5382282360005773</key>
        <key id="cz_link_id">533840000000654407</key>
        <key id="electronic_material_type">JOURNAL</key>
        <key id="Availability">Available from 1995.&lt;br>Most recent 1 year(s) not available.&lt;br></key>
        <key id="static_url">true</key>
        <key id="parser_program">Bulk::BULK</key>
        <key id="parse_parameters">jkey=http://www.cell.com/archive</key>
        <key id="Authentication_note"/>
        <key id="public_note"/>
        <key id="proxy_enabled">false</key>
        <key id="proxy_selected">DEFAULT</key>
        <key id="related_title">@TITLE (@RelationType)</key>
        <key id="is_related_service">false</key>
        <key id="is_closly_related">false</key>
        <key id="license_exist">false</key>
        <key id="crossref_enabled">no</key>
        <key id="current_access">false</key>
        <key id="preferred_link">false</key>
      </keys>
      <resolution_url>https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=8714574420005773&amp;institutionId=5773&amp;customerId=5770</resolution_url>
    </context_service>
    <context_service service_type="getFullTxt" context_service_id="8714574410005773">
      <keys>
        <key id="package_name">Elsevier ScienceDirect</key>
        <key id="package_public_name">Elsevier ScienceDirect Journals Complete</key>
        <key id="package_original_name">Elsevier ScienceDirect Journals Complete</key>
        <key id="package_display_name">Elsevier ScienceDirect Journals Complete</key>
        <key id="package_internal_name">ELSEVIER_SCIENCEDIRECT_AUTOLOAD_JOURNALS</key>
        <key id="interface_name">Elsevier ScienceDirect</key>
        <key id="db_id">.5U,.66,.DM,3PG,4CK,ASVRZ,AXIYT,BODNO,DAHGL,G.7,G.9,IQM,JLM,JLP,KZC,KZD,OPF,SDC,SDG,SDP,SEM,SES,SFE,SNL,SPA,SPD,9JM,9JN,9JO,AFTJW,NZPBE,COIAO,SNG,T5K,AVARZ,SAD,ABKYH,ANZVX,AABNK,AIIAU,AKIFW,ACPOH,ARUGR,ARUHI,ABMGF,ABQEM,ABQZK,ACHRH,ADCUG,ACIUM,AOOFG,AIALX,AAXLA,AMXTC,ADGUI</key>
        <key id="package_pid">6183067780005773</key>
        <key id="service_type_description">Full text available via</key>
        <key id="character_set">utf8</key>
        <key id="Is_free">0</key>
        <key id="request_source">Unknown</key>
        <key id="portfolio_PID">5383226620005773</key>
        <key id="cz_link_id">532560000001602555</key>
        <key id="electronic_material_type">JOURNAL</key>
        <key id="Availability">Available from 01/01/1974 volume: 1 issue: 1 until 17/04/2025 volume: 188 issue: 8.&lt;br>Most recent 1 year(s) not available.&lt;br></key>
        <key id="static_url">false</key>
        <key id="parser_program">ELSEVIER::SCIENCE_DIRECT</key>
        <key id="parse_parameters">host=https://www.sciencedirect.com/science/ &amp; prefsite = sd &amp; shib=YES &amp; u_shib= &amp;uis=00928674</key>
        <key id="Authentication_note"/>
        <key id="public_note"/>
        <key id="proxy_enabled">true</key>
        <key id="proxy_selected">DEFAULT</key>
        <key id="related_title">@TITLE (@RelationType)</key>
        <key id="is_related_service">false</key>
        <key id="is_closly_related">false</key>
        <key id="license_exist">false</key>
        <key id="crossref_enabled">yes</key>
        <key id="current_access">false</key>
        <key id="preferred_link">false</key>
      </keys>
      <resolution_url>https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=8714574410005773&amp;institutionId=5773&amp;customerId=5770</resolution_url>
    </context_service>
  </context_services>
</uresolver_content>`;

// Captured the same day for a nonexistent ISSN, 1234-5678.
const CTO_CONTROL = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="user_ip" xsi:nil="true"/>
      <key id="rft.orig_genre">article</key>
      <key id="licenseEnable">false</key>
      <key id="sfx.sid">DEFAULT</key>
      <key id="available_services">getit</key>
      <key id="rft.genre">article</key>
      <key id="Incoming_URL">http%3A%2F%2Feu01.alma.exlibrisgroup.com%2Fview%2Furesolver%2F34BUC_USAL%2Fopenurl%3Fdebug%3Dtrue%26svc_dat%3DCTO%26rft.genre%3Darticle%26rft.issn%3D1234-5678%26rft.date%3D2020</key>
      <key id="institution">5773</key>
      <key id="rft.date">2020</key>
      <key id="avoidFuzzySearch">false</key>
      <key id="rft.normalized_issn">1234-5678</key>
      <key id="NZMaterialVideo">false</key>
      <key id="ctx_id">8714942940005773</key>
      <key id="full_text_indicator">false</key>
      <key id="http_request_type">GET</key>
      <key id="rft.issn">1234-5678</key>
      <key id="prefer_ordered_resources">false</key>
      <key id="customer">5770</key>
      <key id="rft.year">2020</key>
    </keys>
  </context_object>
  <context_services/>
</uresolver_content>`;

const CELL_WORK = {
  DOI: '10.1016/j.cell.2020.01.001',
  ISSN: ['0092-8674', '1097-4172'],
  'issn-type': [{ value: '0092-8674', type: 'print' }, { value: '1097-4172', type: 'electronic' }],
  issued: { 'date-parts': [[2020, 1, 23]] },
  volume: '180',
  issue: '1',
  page: '1-3',
};
const DOI = '10.1016/j.cell.2020.01.001';
const ELSEVIER_URL = 'https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=8714574410005773&institutionId=5773&customerId=5770';
const ENTITY_ID = 'https://idp.usal.es/entity';
const ROR_ID = 'https://ror.org/02f40zc51';
const USAL_HOST = 'eu01.alma.exlibrisgroup.com';
// A well-formed ROR id that no census will ever list.
const OTHER_ROR_ID = 'https://ror.org/0nowher00';
const GETFTR_ENV = { GETFTR_API_KEY: 'getftr-test-key' };

const xml = (body: BodyInit|null|undefined) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml;charset=UTF-8' } });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * Crossref, the resolver and GetFTR, each answering per call. `resolver`
 * receives the ISSN asked about so a test can answer per journal.
 */
function upstreams({
  crossref = () => jsonResponse({ message: CELL_WORK }),
  resolver = () => xml(CTO_CELL),
  getftr = () => jsonResponse({ entitlements: [] }),
}: { crossref?: (target: URL) => Response | Promise<Response>; resolver?: Resolver; getftr?: (body: unknown, init: RequestInit) => Response | Promise<Response> } = {}) {
  const calls: Array<{ url: URL; init: RequestInit & { headers?: Record<string, string> } }> = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target, init: init as RequestInit & { headers?: Record<string, string> } });
    if (target.host === 'api.crossref.org') return crossref(target);
    if (target.host === 'eu01.alma.exlibrisgroup.com') return resolver(target.searchParams.get('rft.issn')!, target);
    if (target.host === 'entitlements.prod.getft.io') return getftr(JSON.parse(init.body as string), init);
    throw new Error(`unexpected fetch ${target}`);
  };
  const of = (host: string) => calls.filter(call => call.url.host === host);
  return {
    fetchImpl,
    calls,
    crossrefCalls: () => of('api.crossref.org'),
    resolverCalls: () => of('eu01.alma.exlibrisgroup.com'),
    getftrCalls: () => of('entitlements.prod.getft.io'),
  };
}

async function rejectsWith(promise: Promise<unknown>|(() => Promise<unknown>), code: string, status: number) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof InstitutionAccessError, `expected InstitutionAccessError, got ${(error as Error)?.name}: ${(error as Error)?.message}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

const query = (params: string|Record<string,string>|Iterable<Iterable<string>>|undefined) => readAccessQuery(new URLSearchParams(params));

test('parses the captured Cell answer into its two full-text services, unescaped', () => {
  assert.deepEqual(parseResolverAnswer(CTO_CELL), {
    fullText: true,
    matched: true,
    services: [
      {
        name: 'Cell Press Free Archives',
        free: true,
        url: 'https://buc-usal.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=8714574420005773&institutionId=5773&customerId=5770',
      },
      { name: 'Elsevier ScienceDirect Journals Complete', free: false, url: ELSEVIER_URL },
    ],
    restricted: false,
  });
});

test('parses the captured control answer as no full text and anything else as no answer', () => {
  assert.deepEqual(parseResolverAnswer(CTO_CONTROL), { fullText: false, matched: false, services: [], restricted: false });
  assert.equal(parseResolverAnswer('<html>Service unavailable</html>'), null);
});

// Captured 2026-10-19 for the Université de Pau (33BUPAU_INST on eu03), Nature
// 1476-4687, 2020, with the article's locators: the only service is one Alma
// itself filtered out, since its coverage ended in 2012, and it still carries
// a resolution URL. Keys the Worker does not read are left out.
const PAU_URL = 'https://uppa.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=19758124930006166&institutionId=6166&customerId=6165';
const CTO_FILTERED_BY_DATE = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="rft.jtitle">Nature</key>
      <key id="rft.issn">1476-4687</key>
      <key id="rft.date">2020</key>
      <key id="rft.mms_id">995703704006166</key>
      <key id="full_text_indicator">false</key>
    </keys>
  </context_object>
  <context_services>
    <context_service service_type="getFullTxt" context_service_id="19758124930006166">
      <keys>
        <key id="package_public_name">Nature revues Istex</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 01/01/1869 volume: 1 issue: 1 until 28/12/2012 volume: 492.&lt;br></key>
        <key id="Filtered">true</key>
        <key id="Filter reason">Date Filter</key>
      </keys>
      <resolution_url>${PAU_URL.replace(/&/g, '&amp;')}</resolution_url>
    </context_service>
  </context_services>
</uresolver_content>`;

// The same answer with a live subscription next to the filtered service.
const NATURE_URL = 'https://uppa.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=19758124940006166&institutionId=6166&customerId=6165';
const CTO_FILTERED_AND_LIVE = CTO_FILTERED_BY_DATE
  .replace('<key id="full_text_indicator">false</key>', '<key id="full_text_indicator">true</key>')
  .replace('  </context_services>', `    <context_service service_type="getFullTxt" context_service_id="19758124940006166">
      <keys>
        <key id="package_public_name">Nature</key>
        <key id="Is_free">0</key>
      </keys>
      <resolution_url>${NATURE_URL.replace(/&/g, '&amp;')}</resolution_url>
    </context_service>
  </context_services>`);

// A filter that is not about the date. Alma's wording for its other filters
// (IP, user group) was not captured; the Worker treats any reason but the
// date as a restriction it cannot see through, so the wording here is only
// a stand-in.
const CTO_RESTRICTED = CTO_FILTERED_BY_DATE.replace('Date Filter', 'IP Filter');

test('a service Alma filtered out for the date is no access: the Pau answer is a refusal', async () => {
  assert.deepEqual(parseResolverAnswer(CTO_FILTERED_BY_DATE), { fullText: false, matched: true, services: [], restricted: false });
  const stub = upstreams({ resolver: () => xml(CTO_FILTERED_BY_DATE) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  assert.equal(stub.resolverCalls().length, 2);
});

test('a live service next to a filtered one is the one reported', async () => {
  const stub = upstreams({ resolver: () => xml(CTO_FILTERED_AND_LIVE) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'entitled', collection: 'Nature', url: NATURE_URL });
});

test('a service filtered for a reason other than the date leaves the answer unknown, not refused', async () => {
  assert.deepEqual(parseResolverAnswer(CTO_RESTRICTED), { fullText: false, matched: true, services: [], restricted: true });
  const stub = upstreams({ resolver: () => xml(CTO_RESTRICTED) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'unknown', collection: null, url: null });
});


// Captured 2026-10-19 on eu03.alma.exlibrisgroup.com for Pavia's code
// (39UPV_INST), Nature 2020: the regional host knows the code but did not
// resolve the journal, so it lists nothing, while unipv.alma… lists five
// services for the same question. Keys the Worker does not read are left out.
const CTO_NO_MATCH = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="available_services">getit</key>
      <key id="institution">8486</key>
      <key id="rft.date">2020</key>
      <key id="rft.normalized_issn">0028-0836</key>
      <key id="full_text_indicator">false</key>
      <key id="rft.issn">0028-0836</key>
    </keys>
  </context_object>
  <context_services/>
</uresolver_content>`;

test('an answer that did not resolve the journal is read, but as unmatched', () => {
  assert.deepEqual(parseResolverAnswer(CTO_NO_MATCH), { fullText: false, matched: false, services: [], restricted: false });
  assert.equal(parseResolverAnswer(CTO_CELL)!.matched, true);
});

// Captured 2026-10-19 on na03 for Harvard (01HVD_INST), Nature 2020. The
// library sends readers straight to one service (`single_service`) and its
// answer carries no `full_text_indicator`; the services still carry Alma's
// filter marks. Cut to three services; keys the Worker does not read left out.
const HARVARD_NATURE_URL = 'https://hvd.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=126971641670003941&institutionId=3941&customerId=3940';
const CTO_SINGLE_SERVICE = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="rft.jtitle">Nature.</key>
      <key id="available_services">single_service</key>
      <key id="rft.issn">0028-0836</key>
      <key id="rft.mms_id">990001299870203941</key>
      <key id="rft.date">2020</key>
    </keys>
  </context_object>
  <context_services>
    <context_service service_type="getFullTxt" context_service_id="126971641670003941">
      <keys>
        <key id="package_public_name">Nature</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 1869 volume: 1 issue: 1.&lt;br></key>
      </keys>
      <resolution_url>${HARVARD_NATURE_URL.replace(/&/g, '&amp;')}</resolution_url>
    </context_service>
    <context_service service_type="getFullTxt" context_service_id="126971641640003941">
      <keys>
        <key id="package_public_name">ProQuest Central</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 01/07/1988 volume: 331.&lt;br>Most recent 1 year(s) not available.&lt;br></key>
      </keys>
      <resolution_url>https://hvd.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=126971641640003941&amp;institutionId=3941&amp;customerId=3940</resolution_url>
    </context_service>
    <context_service service_type="getFullTxt" context_service_id="126971641700003941">
      <keys>
        <key id="package_public_name">EBSCOhost Academic Search Premier</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 06/05/1997 until 11/30/2015.&lt;br></key>
        <key id="Filtered">true</key>
        <key id="Filter reason">Date Filter</key>
      </keys>
      <resolution_url>https://hvd.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=126971641700003941&amp;institutionId=3941&amp;customerId=3940</resolution_url>
    </context_service>
  </context_services>
</uresolver_content>`;

// The same answer with only the filtered service left: nothing live.
const CTO_SINGLE_SERVICE_FILTERED = CTO_SINGLE_SERVICE.replace(/<context_service service_type="getFullTxt" context_service_id="1269716416[47]0003941">[\s\S]*?<\/context_service>\n/g, '');

test('an answer without an indicator is read from what it lists unfiltered', async () => {
  const answer = parseResolverAnswer(CTO_SINGLE_SERVICE)!;
  assert.equal(answer.fullText, true);
  assert.equal(answer.matched, true);
  assert.deepEqual(answer.services.map(service => service.name), ['Nature', 'ProQuest Central']);
  const stub = upstreams({ resolver: () => xml(CTO_SINGLE_SERVICE) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'entitled', collection: 'Nature', url: HARVARD_NATURE_URL });
});

test('an answer without an indicator whose services are all filtered is a refusal', async () => {
  assert.deepEqual(parseResolverAnswer(CTO_SINGLE_SERVICE_FILTERED), { fullText: false, matched: true, services: [], restricted: false });
  const stub = upstreams({ resolver: () => xml(CTO_SINGLE_SERVICE_FILTERED) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
});

test('reports the subscription service rather than the free archive for an entitled journal', async () => {
  const stub = upstreams();
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, {
    status: 'entitled',
    collection: 'Elsevier ScienceDirect Journals Complete',
    url: ELSEVIER_URL,
  });
  const [call] = stub.resolverCalls();
  assert.equal(stub.resolverCalls().length, 1);
  assert.equal(call.url.pathname, '/view/uresolver/34BUC_USAL/openurl');
  assert.equal(call.url.searchParams.get('svc_dat'), 'CTO');
  assert.equal(call.url.searchParams.get('rft.issn')!, '1097-4172');
  assert.equal(call.url.searchParams.get('rft.date'), '2020');
  assert.equal(call.url.searchParams.has('u.ignore_date_coverage'), false);
});

// Without the article's locators Alma links to the journal's home page: the
// USAL resolver sent a Physical Review B reader to journals.aps.org/prb.
test('names the article to the resolver, so its link lands on the article', async () => {
  const stub = upstreams();
  await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  const [call] = stub.resolverCalls();
  assert.equal(call.url.searchParams.get('rft_id'), `info:doi/${DOI}`);
  assert.equal(call.url.searchParams.get('rft.volume'), '180');
  assert.equal(call.url.searchParams.get('rft.issue'), '1');
  assert.equal(call.url.searchParams.get('rft.spage'), '1');
});

test('sends only the locators Crossref has', async () => {
  const stub = upstreams({ crossref: () => jsonResponse({ message: { ISSN: ['0092-8674'], volume: 180 } }) });
  await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  const [call] = stub.resolverCalls();
  assert.equal(call.url.searchParams.get('rft_id'), `info:doi/${DOI}`);
  assert.equal(call.url.searchParams.get('rft.volume'), '180');
  assert.equal(call.url.searchParams.has('rft.issue'), false);
  assert.equal(call.url.searchParams.has('rft.spage'), false);
});

test('asks the electronic ISSN first and the print one when the first has no full text', async () => {
  const stub = upstreams({ resolver: (issn: string) => xml(issn === '0092-8674' ? CTO_CELL : CTO_CONTROL) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.equal(result.status, 'entitled');
  assert.deepEqual(stub.resolverCalls().map(call => call.url.searchParams.get('rft.issn')!), ['1097-4172', '0092-8674']);
});

test('is not entitled when every ISSN asked answers without full text', async () => {
  const stub = upstreams({ resolver: () => xml(CTO_CONTROL) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  assert.equal(stub.resolverCalls().length, 2);
});

test('a resolver answer that cannot be read is an outage, not an unknown to remember', async () => {
  const stub = upstreams({ resolver: () => xml('<uresolver_content/>') });
  await assert.rejects(
    lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl }),
    error => (error as Error & { code?: string; status?: number }).code === 'ACCESS_LOOKUP_UNAVAILABLE' && (error as Error & { code?: string; status?: number }).status === 502,
  );
});

// A single-service answer cut off after its context object: the journal
// resolved, the services never arrived. Read as it stands it would be a
// refusal; it is not an answer.
const CTO_TRUNCATED = '<uresolver_content><context_object><keys><key id="rft.mms_id">990001299870203941</key><key id="available_services">single_service</key></keys></context_object><context_services>';

test('an answer cut off before its services is no answer: an outage, not a refusal', async () => {
  assert.equal(parseResolverAnswer(CTO_TRUNCATED), null);
  assert.equal(parseResolverAnswer(CTO_SINGLE_SERVICE.slice(0, -40)), null);
  const stub = upstreams({ resolver: () => xml(CTO_TRUNCATED) });
  await assert.rejects(
    lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl }),
    error => (error as Error & { code?: string; status?: number }).code === 'ACCESS_LOOKUP_UNAVAILABLE' && (error as Error & { code?: string; status?: number }).status === 502,
  );
});

test('the cache key carries the institution ids only when GetFTR can receive them', async () => {
  const { upstreamParams } = await import('./institution-access.ts');
  const query = { doi: DOI, domain: 'usal.es', entityId: 'https://idp.usal.es/entity', rorId: 'https://ror.org/02f40zc51' };
  assert.deepEqual(upstreamParams(query, {}), { doi: DOI, library: '34BUC_USAL', host: USAL_HOST });
  assert.deepEqual(upstreamParams(query, { GETFTR_API_KEY: 'k' }), { doi: DOI, library: '34BUC_USAL', host: USAL_HOST, entityId: query.entityId, rorId: query.rorId });
  assert.deepEqual(upstreamParams({ doi: DOI, domain: 'usal.es', entityId: null, rorId: null }, { GETFTR_API_KEY: 'k' }), { doi: DOI, library: '34BUC_USAL', host: USAL_HOST });
});

test('the cache key names the host the code is asked on, so a row moved to another host is asked again', async () => {
  const { upstreamParams, findResolver } = await import('./institution-access.ts');
  // The same code answers differently on a regional host and on the library's
  // own (Pavia, 2026-10-19): a key without the host would serve the regional
  // host's empty answer for a week after the row was corrected.
  const resolver = findResolver({ domain: 'usal.es' })!;
  const key = upstreamParams({ doi: DOI, domain: 'usal.es' }, {});
  assert.deepEqual(key, { doi: DOI, library: resolver.institution, host: resolver.host });
  assert.notDeepEqual(key, { ...key, host: 'eu03.alma.exlibrisgroup.com' });
});

test('the cache key names the library asked, or the domain when there is none', async () => {
  const { upstreamParams } = await import('./institution-access.ts');
  // Every mail domain of a university reaches the same resolver, so its
  // answers are shared through the institution code, not split by domain.
  assert.deepEqual(upstreamParams({ doi: DOI, domain: 'alumni.usal.es', rorId: ROR_ID }, {}), { doi: DOI, library: '34BUC_USAL', host: USAL_HOST });
  assert.deepEqual(upstreamParams({ doi: DOI, domain: 'nowhere.example', rorId: OTHER_ROR_ID }, {}), { doi: DOI, domain: 'nowhere.example' });
});

test('the resolver is found by ROR id first, then by mail domain', async () => {
  const { findResolver } = await import('./institution-access.ts');
  const usal = { host: 'eu01.alma.exlibrisgroup.com', institution: '34BUC_USAL' };
  assert.deepEqual(findResolver({ domain: 'usal.es' }), usal);
  assert.deepEqual(findResolver({ domain: 'alumni.usal.es', rorId: ROR_ID }), usal);
  assert.equal(findResolver({ domain: 'nowhere.example', rorId: OTHER_ROR_ID }), null);
  assert.equal(findResolver({ domain: 'nowhere.example' }), null);
  // A ROR id the table lacks still reaches the library its mail domain names:
  // ROR registers a domain under one record, so the domain is the affiliation
  // the link flow verified, and a dependent institute reads through its university.
  assert.deepEqual(findResolver({ domain: 'usal.es', rorId: OTHER_ROR_ID }), usal);
});

test('ignores date coverage when Crossref gives no year', async () => {
  const stub = upstreams({ crossref: () => jsonResponse({ message: { ISSN: ['0092-8674'] } }) });
  await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  const [call] = stub.resolverCalls();
  assert.equal(call.url.searchParams.has('rft.date'), false);
  assert.equal(call.url.searchParams.get('u.ignore_date_coverage'), 'true');
});

test('is unknown, without asking the resolver, when Crossref has no ISSN or no record', async () => {
  for (const crossref of [
    () => jsonResponse({ message: { issued: { 'date-parts': [[2020]] } } }),
    () => jsonResponse({ status: 'error', message: 'Resource not found.' }, 404),
  ]) {
    const stub = upstreams({ crossref });
    const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, { status: 'unknown', collection: null, url: null });
    assert.equal(stub.resolverCalls().length, 0);
  }
});

test('is unavailable when Crossref or the resolver fails or times out', async () => {
  const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
  for (const stub of [
    upstreams({ crossref: () => jsonResponse({}, 500) }),
    upstreams({ crossref: timeout }),
    upstreams({ resolver: () => new Response('error', { status: 500 }) }),
    upstreams({ resolver: timeout }),
  ]) {
    await rejectsWith(
      lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl }),
      'ACCESS_LOOKUP_UNAVAILABLE',
      502,
    );
  }
});

test('refuses a domain no provider can answer for, without asking anyone', async () => {
  const stub = upstreams();
  await rejectsWith(
    lookupInstitutionAccess({ doi: DOI, domain: 'nowhere.example', entityId: ENTITY_ID }, { fetchImpl: stub.fetchImpl }),
    'INSTITUTION_NOT_SUPPORTED',
    404,
  );
  assert.equal(stub.calls.length, 0);
});

test('normalizes the query and refuses malformed parameters', () => {
  assert.deepEqual(query({ doi: ' 10.1016/J.Cell.2020.01.001 ', domain: 'USAL.es' }), {
    doi: '10.1016/j.cell.2020.01.001',
    domain: 'usal.es',
    entityId: null,
    rorId: null,
  });
  assert.deepEqual(query({ doi: DOI, domain: 'usal.es', entityId: ENTITY_ID, rorId: ROR_ID }), {
    doi: DOI,
    domain: 'usal.es',
    entityId: ENTITY_ID,
    rorId: ROR_ID,
  });
  for (const [params, code] of [
    [{ doi: 'cell-2020', domain: 'usal.es' }, 'INVALID_DOI'],
    [{ doi: `10.1016/${'x'.repeat(300)}`, domain: 'usal.es' }, 'INVALID_DOI'],
    [{ doi: DOI }, 'INVALID_DOMAIN'],
    [{ doi: DOI, domain: 'localhost' }, 'INVALID_DOMAIN'],
    [{ doi: DOI, domain: 'a@usal.es' }, 'INVALID_DOMAIN'],
    [{ doi: DOI, domain: 'usal.es', entityId: 'urn:mace:' }, 'INVALID_INSTITUTION_ID'],
    [{ doi: DOI, domain: 'usal.es', entityId: `https://idp.usal.es/${'x'.repeat(300)}` }, 'INVALID_INSTITUTION_ID'],
    [{ doi: DOI, domain: 'usal.es', rorId: '02f40zc51' }, 'INVALID_INSTITUTION_ID'],
  ]) {
    assert.throws(() => query(params), (error) => {
      assert.ok(error instanceof InstitutionAccessError);
      assert.equal(error.code, code);
      assert.equal(error.status, 400);
      return true;
    }, JSON.stringify(params));
  }
});

test('GetFTR entitled answers with its version-of-record link and skips Crossref', async () => {
  const stub = upstreams({
    getftr: () => jsonResponse({
      entitlements: [{
        doi: DOI,
        statusCode: 200,
        entitled: 'yes',
        accessType: 'paid',
        vor: [{ contentType: 'html', url: 'https://www.sciencedirect.com/science/article/pii/S0092867420300015' }],
        document: 'https://doi.org/10.1016/j.cell.2020.01.001',
      }],
    }),
  });
  const result = await lookupInstitutionAccess(
    { doi: DOI, domain: 'usal.es', entityId: ENTITY_ID },
    { fetchImpl: stub.fetchImpl, env: GETFTR_ENV },
  );
  assert.deepEqual(result, {
    status: 'entitled',
    collection: 'GetFTR',
    url: 'https://www.sciencedirect.com/science/article/pii/S0092867420300015',
  });
  assert.equal(stub.crossrefCalls().length, 0);
  const [call] = stub.getftrCalls();
  assert.equal(call.url.pathname, '/v2.1/entitlements');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers!['X-API-KEY'], 'getftr-test-key');
  assert.match(call.init.headers!['X-REQUEST-ID'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(call.init.body as string), { org: { entityID: ENTITY_ID }, dois: [DOI] });
});

test('a SAML URN is preserved in GetFTR requests and its cache identity', async () => {
  const entityId = 'urn:mace:incommon:usc.edu';
  const institution = query({ doi: DOI, domain: 'usc.edu', entityId, rorId: 'https://ror.org/03taz7m60' });
  const stub = upstreams({ getftr: () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 200, entitled: 'no' }] }) });
  const answer = await lookupInstitutionAccess(institution, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.equal(answer.status, 'not-entitled');
  assert.deepEqual(JSON.parse(stub.getftrCalls()[0].init.body as string).org, { entityID: entityId, rorID: 'https://ror.org/03taz7m60' });
  assert.equal(upstreamParams(institution, GETFTR_ENV).entityId, entityId);
});

test('GetFTR not entitled is the answer, even for a library with a resolver', async () => {
  const stub = upstreams({
    getftr: () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 200, entitled: 'no', document: 'https://doi.org/x' }] }),
  });
  const result = await lookupInstitutionAccess(
    { doi: DOI, domain: 'usal.es', entityId: ENTITY_ID, rorId: ROR_ID },
    { fetchImpl: stub.fetchImpl, env: GETFTR_ENV },
  );
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  assert.equal(stub.resolverCalls().length, 0);
  assert.deepEqual(JSON.parse(stub.getftrCalls()[0].init.body as string).org, { entityID: ENTITY_ID, rorID: ROR_ID });
});

test('GetFTR maybe, an unsupported publisher or an outage leave the question to the resolver', async () => {
  for (const getftr of [
    () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 200, entitled: 'maybe', document: 'https://doi.org/x' }] }),
    () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 200, entitled: 'no', source: 'publisher_not_supported' }] }),
    () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 404 }] }),
    () => jsonResponse({ message: 'internal error' }, 500),
  ]) {
    const stub = upstreams({ getftr });
    const result = await lookupInstitutionAccess(
      { doi: DOI, domain: 'usal.es', rorId: ROR_ID },
      { fetchImpl: stub.fetchImpl, env: GETFTR_ENV },
    );
    assert.deepEqual(result, {
      status: 'entitled',
      collection: 'Elsevier ScienceDirect Journals Complete',
      url: ELSEVIER_URL,
    });
    assert.equal(stub.getftrCalls().length, 1);
    assert.equal(stub.resolverCalls().length, 1);
  }
});

test('a GetFTR outage for a library without a resolver is unknown, not an error', async () => {
  const stub = upstreams({ getftr: () => jsonResponse({}, 503) });
  const result = await lookupInstitutionAccess(
    { doi: DOI, domain: 'nowhere.example', rorId: OTHER_ROR_ID },
    { fetchImpl: stub.fetchImpl, env: GETFTR_ENV },
  );
  assert.deepEqual(result, { status: 'unknown', collection: null, url: null });
  assert.equal(stub.crossrefCalls().length, 0);
});

test('GetFTR is not asked without a key or without an institution id', async () => {
  for (const [params, env] of [
    [{ doi: DOI, domain: 'usal.es', entityId: ENTITY_ID }, {}],
    [{ doi: DOI, domain: 'usal.es' }, GETFTR_ENV],
  ] as Array<[InstitutionQuery & { doi: string }, WorkerEnv]>) {
    const stub = upstreams();
    const result = await lookupInstitutionAccess(params, { fetchImpl: stub.fetchImpl, env });
    assert.equal(result.status, 'entitled');
    assert.equal(stub.getftrCalls().length, 0);
    assert.equal(stub.resolverCalls().length, 1);
  }
});

const PROJECT_ID = 'papertok-168df';
const TOKEN = fakeIdToken({ aud: PROJECT_ID });
const ROUTE_ENV = { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID };

/** The route through the Worker's own dispatch, with the edge cache recorded. */
async function requestAccess(search: string, { token = TOKEN, method = 'GET', resolver = () => xml(CTO_CELL) }: AccessOptions = {}) {
  const calls: string[] = [];
  const puts: Array<{ key: string; response: Response }> = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.host);
    if (url.pathname.endsWith('accounts:lookup')) return jsonResponse({ users: [{ localId: 'alice-uid' }] });
    if (url.host === 'api.crossref.org') return jsonResponse({ message: CELL_WORK });
    if (url.host === 'eu01.alma.exlibrisgroup.com' || url.host === 'na03.alma.exlibrisgroup.com') return resolver(url);
    throw new Error(`unexpected upstream ${url}`);
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (key, response): Promise<void> => { puts.push({ key: (key as Request).url, response }); },
    },
  };
  try {
    const response = await reportApi.fetch(new Request(`https://api.papertok.test/access?${search}`, {
      method,
      headers: { origin: 'https://papertok.app', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }), ROUTE_ENV);
    const accessPuts = puts.filter(put => put.key.startsWith('https://papertok.internal/cache/access'));
    return { response, body: await response.json(), calls, accessPuts };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

test('the route answers a signed-in reader and caches under the normalized DOI and the library', async () => {
  const { response, body, accessPuts } = await requestAccess(`doi=${encodeURIComponent('10.1016/J.CELL.2020.01.001')}&domain=USAL.es&ignored=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://papertok.app');
  assert.deepEqual(body, { status: 'entitled', collection: 'Elsevier ScienceDirect Journals Complete', url: ELSEVIER_URL });
  assert.equal(accessPuts.length, 1);
  const key = new URL(accessPuts[0].key);
  assert.deepEqual([...key.searchParams], [['doi', DOI], ['library', '34BUC_USAL'], ['host', USAL_HOST], ['citation', 'article'], ['reading', 'well-formed-answers']]);
  assert.match(accessPuts[0].response.headers.get('cache-control')!, /s-maxage=604800/);
});

test('the access route accepts USC\'s stored SAML URN and uses its Alma library', async () => {
  const search = new URLSearchParams({ doi: DOI, domain: 'usc.edu', rorId: 'https://ror.org/03taz7m60', entityId: 'urn:mace:incommon:usc.edu' }).toString();
  const articleUrl = 'https://libproxy.usc.edu/login?url=https://publisher.example/article';
  const { response, body, accessPuts } = await requestAccess(search, {
    resolver: target => {
      assert.equal(target.host, 'na03.alma.exlibrisgroup.com');
      assert.equal(target.pathname, '/view/uresolver/01USC_INST/openurl');
      return xml(`<uresolver_content><context_object><keys><key id="full_text_indicator">true</key></keys></context_object>
        <context_services><context_service service_type="getFullTxt"><keys><key id="package_public_name">USC subscription</key></keys>
        <resolution_url>${articleUrl}</resolution_url></context_service></context_services></uresolver_content>`);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'entitled', collection: 'USC subscription', url: articleUrl });
  assert.equal(accessPuts.length, 1);
  assert.equal(new URL(accessPuts[0].key).searchParams.get('library'), '01USC_INST');
  const anonymous = await requestAccess(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the access route rejects malformed URNs and unsafe schemes without provider work or caching', async () => {
  for (const entityId of ['urn:mace:', 'urn::usc.edu', 'urn:mace:incommon:usc edu', 'urn:mace:usc%ZZ', 'javascript:alert(1)', 'http://idp.usc.edu', `urn:mace:${'x'.repeat(300)}`]) {
    const { response, body, calls, accessPuts } = await requestAccess(new URLSearchParams({ doi: DOI, domain: 'usc.edu', entityId }).toString());
    assert.equal(response.status, 400, entityId);
    assert.deepEqual(body, { code: 'INVALID_INSTITUTION_ID' });
    assert.ok(calls.every(host => host === 'identitytoolkit.googleapis.com'));
    assert.equal(accessPuts.length, 0);
  }
});

test('the route refuses a request without a session before reaching any provider', async () => {
  const { response, body, calls } = await requestAccess(`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { token: null });
  assert.equal(response.status, 401);
  assert.deepEqual(body, { code: 'AUTH_REQUIRED' });
  assert.deepEqual(calls, []);
});

test('the route maps validation, unsupported institutions and outages to codes it does not cache', async () => {
  for (const [search, options, status, code] of [
    ['doi=nope&domain=usal.es', {}, 400, 'INVALID_DOI'],
    [`doi=${encodeURIComponent(DOI)}&domain=nowhere.example`, {}, 404, 'INSTITUTION_NOT_SUPPORTED'],
    [`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { resolver: () => new Response('down', { status: 503 }) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE'],
  ] as Array<[string, AccessOptions, number, string]>) {
    const { response, body, accessPuts } = await requestAccess(search, options);
    assert.equal(response.status, status, search);
    assert.deepEqual(body, { code });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(accessPuts.length, 0);
  }
  const { response } = await requestAccess(`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { method: 'POST' });
  assert.equal(response.status, 405);
});
