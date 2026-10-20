import type { TestGlobals } from './test-types.ts';
import test from 'node:test';
import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery } from './institution-access.ts';
type AccessOptions = { token?: string | null; method?: string; resolver?: (target: URL) => Response | Promise<Response>; crossref?: () => Response };
type Resolver = (issn: string, target?: URL) => Response | Promise<Response>;

import assert from 'node:assert/strict';
import {
  InstitutionAccessError,
  findResolver,
  lookupInstitutionAccess,
  parseResolverAnswer,
  parseSfxAnswer,
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

// The SFX pilot: TUM, LMU and FAU each have an instance on the Bavarian
// library network's SFX server. The answers below were captured there on
// 2026-10-20 (`sfx.response_type=multi_obj_detailed_xml`) and cut to the
// attributes and target fields the Worker reads; the nested `_stash` hash
// stays, as SFX sends it.
const SFX_HOST = 'sfx.bib-bvb.de';
const TUM_ROR = 'https://ror.org/02kkvpp62';
const LMU_ROR = 'https://ror.org/05591te55';
const FAU_ROR = 'https://ror.org/00f7hpc57';
const NATURE_DOI = '10.1038/s41586-020-2782-y';
const NATURE_LINK = 'https://doi.org/10.1038/s41586-020-2782-y?nosfx=y';
// Crossref's record for the article, as it answered the same day.
const NATURE_WORK = {
  DOI: NATURE_DOI,
  'issn-type': [{ value: '0028-0836', type: 'print' }, { value: '1476-4687', type: 'electronic' }],
  issued: { 'date-parts': [[2020, 10, 14]] },
  volume: '586',
  issue: '7829',
  page: '378-384',
  // Springer Nature's own terms on the version of record: not an open licence.
  license: [
    { URL: 'https://www.springernature.com/gp/researchers/text-and-data-mining', start: { 'date-time': '2020-10-14T00:00:00Z' }, 'content-version': 'tdm', 'delay-in-days': 0 },
    { URL: 'https://www.springernature.com/gp/researchers/text-and-data-mining', start: { 'date-time': '2020-10-14T00:00:00Z' }, 'content-version': 'vor', 'delay-in-days': 0 },
  ],
};
// Crossref's records for the two open-access articles, licences as deposited.
const ENTROPY_DOI = '10.3390/e23010001';
const ENTROPY_WORK = {
  DOI: ENTROPY_DOI,
  'issn-type': [{ value: '1099-4300', type: 'electronic' }],
  issued: { 'date-parts': [[2020, 12, 22]] },
  volume: '23',
  issue: '1',
  page: '1',
  license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/', start: { 'date-time': '2020-12-22T00:00:00Z' }, 'content-version': 'vor', 'delay-in-days': 0 }],
};
const SCIREP_DOI = '10.1038/s41598-021-86323-x';
const SCIREP_WORK = {
  DOI: SCIREP_DOI,
  'issn-type': [{ value: '2045-2322', type: 'electronic' }],
  issued: { 'date-parts': [[2021, 3, 26]] },
  volume: '11',
  issue: '1',
  license: [
    { URL: 'https://creativecommons.org/licenses/by/4.0', start: { 'date-time': '2021-03-26T00:00:00Z' }, 'content-version': 'tdm', 'delay-in-days': 0 },
    { URL: 'https://creativecommons.org/licenses/by/4.0', start: { 'date-time': '2021-03-26T00:00:00Z' }, 'content-version': 'vor', 'delay-in-days': 0 },
  ],
};
// Crossref's records for an open article with no licence deposited and a
// closed one with none either (captured 2026-10-20, cut to what is read).
const ENTROPY_2017_DOI = '10.3390/e19020087';
const ENTROPY_2017_WORK = {
  DOI: ENTROPY_2017_DOI,
  'issn-type': [{ value: '1099-4300', type: 'electronic' }],
  issued: { 'date-parts': [[2017, 2, 23]] },
  volume: '19',
  issue: '2',
  page: '87',
};
const SCIENCE_DOI = '10.1126/science.abd8911';
const SCIENCE_WORK = {
  DOI: SCIENCE_DOI,
  'issn-type': [{ value: '0036-8075', type: 'print' }, { value: '1095-9203', type: 'electronic' }],
  issued: { 'date-parts': [[2020, 11, 27]] },
  volume: '370',
  issue: '6520',
  page: '1066-1071',
};
// Unpaywall's records for them and for the Nature article (captured
// 2026-10-20, cut to the status read and what explains it).
const UNPAYWALL_RECORDS: Record<string, object> = {
  [ENTROPY_2017_DOI]: { doi: ENTROPY_2017_DOI, is_oa: true, oa_status: 'gold', journal_is_oa: true, best_oa_location: { host_type: 'publisher', version: 'publishedVersion', license: 'cc-by' } },
  [SCIENCE_DOI]: { doi: SCIENCE_DOI, is_oa: false, oa_status: 'closed', journal_is_oa: false, best_oa_location: null },
  [NATURE_DOI]: { doi: NATURE_DOI, is_oa: false, oa_status: 'closed', journal_is_oa: false, best_oa_location: null },
};
/** Unpaywall answering from the records above by the DOI in the path, and 404 for any other. */
const unpaywallRecord = (target: URL) => {
  const record = UNPAYWALL_RECORDS[decodeURIComponent(target.pathname.replace(/^\/v2\//, ''))];
  return record ? jsonResponse(record) : jsonResponse({ HTTP_status_code: 404, error: true }, 404);
};
// The remote-access logins TUM and LMU document for their readers.
const TUM_LOGIN = 'https://tum-eaccess.de/login?qurl=';
const LMU_LOGIN = 'https://emedien.ub.uni-muenchen.de/login?qurl=';

// sfx_tum, Nature 1476-4687, 2020, with the article's DOI, volume, issue and
// first page, full-text services only: the journal's own package and
// Springer's, both linking to the article.
const SFX_TUM_NATURE = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.eissn"&gt;1476-4687&lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.1038/s41586-020-2782-y&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Nature&lt;/item&gt;
  &lt;item key="rft.year"&gt;2020&lt;/item&gt;
  &lt;item key="rft.issn"&gt;0028-0836&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>SPRINGER_LINK_JOURNALS_AUTOLOAD</target_name>
    <target_public_name>SpringerLink Journals - AutoHoldings</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41586-020-2782-y?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>NATURE</target_name>
    <target_public_name>Nature</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41586-020-2782-y?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_uben, PLOS ONE 1932-6203, 2020, for 10.1371/journal.pone.0234574,
// full-text services only: four free collections and nothing licensed. The
// knowledge-base names are the only sign that they are free; FAU and TUM
// answered alike.
const SFX_FAU_PLOS = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1932-6203&lt;/item&gt;
  &lt;item key="rft.year"&gt;2020&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;1000000000277859&lt;/item&gt;
  &lt;item key="rft.issn"&gt;1932-6203&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Plos One&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>DOAJ_DIRECTORY_OPEN_ACCESS_JOURNALS</target_name>
    <target_public_name>DOAJ Directory of Open Access Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1371/journal.pone.0234574?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>FREE_FULL_TEXT_JOURNALS_IN_CHEMISTRY</target_name>
    <target_public_name>Free Full-Text Journals in Chemistry</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>http://www.plosone.org/home.action</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>PUBLIC_LIBRARY_OF_SCIENCE_PLOS_JOURNALS_OPEN_ACCESS</target_name>
    <target_public_name>Public Library of Science (PLoS) Journals Open Access</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1371/journal.pone.0234574?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>PUBMED_CENTRAL_JOURNALS</target_name>
    <target_public_name>PubMed Central</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://www.ncbi.nlm.nih.gov/pmc/ivip/1932-6203/15/6/e0234574</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_tum, Journal of the American Mathematical Society 0894-0347, 2021,
// full-text services only: the AMS opens its articles after five years, and
// TUM lists that free collection and the EZB's.
const SFX_TUM_JAMS = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.object_id"&gt;954925558506&lt;/item&gt;
  &lt;item key="rft.year"&gt;2021&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Journal of the American Mathematical Society&lt;/item&gt;
  &lt;item key="rft.issn"&gt;0894-0347&lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1088-6834&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>AMERICAN_MATHEMATICAL_SOCIETY_PUBLICATIONS_FREELY_ACCESSIBLE</target_name>
    <target_public_name>American Mathematical Society Publications (Freely Accessible)</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://www.ams.org/journals/jams/all_issues.html</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>EZB-FREE-00999_FREELY_AVAILABLE_EZB_JOURNALS</target_name>
    <target_public_name>EZB-FREE-00999 freely available EZB journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://pubs.ams.org/JAMS?active=all</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_tum, Nature 0028-0836, 1800, without the full-text filter: the journal
// resolves, no full text covers the year, and the menu still offers the
// union catalogue, interlibrary loan, document delivery and a feedback form,
// some with https links. Their long query strings are shortened.
const SFX_TUM_NATURE_1800 = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.eissn"&gt;1476-4687&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Nature&lt;/item&gt;
  &lt;item key="rft.year"&gt;1800&lt;/item&gt;
  &lt;item key="rft.issn"&gt;0028-0836&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>BVB_GUEST_LCL</target_name>
    <target_public_name>Bibliotheksverbundes Bayern</target_public_name>
    <service_type>getHolding</service_type>
    <proxy>no</proxy>
    <target_url>https://sfx.bib-bvb.de/bvb-cgi/pick_bvb_container.cgi?options=BV002529932-BV002534890&amp;Jahr=1800&amp;SigelNB=EXT&amp;lang=de&amp;svc=HOLO</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>FRENCH_UNION_CATALOGUE_SUDOC</target_name>
    <target_public_name>Catalogue SUDOC</target_public_name>
    <service_type>getHolding</service_type>
    <proxy>no</proxy>
    <target_url>http://corail.sudoc.abes.fr/DB=2.1/SET=1/TTL=1/NXT/CMD?sfx%24char_set=latin1&amp;ACT=SRCHA&amp;SRT=RLV&amp;IKT=8&amp;TRM=0028-0836</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>ISI_JOURNAL_CITATION_REPORTS_SCIENCE_EDITION</target_name>
    <target_public_name>ISI's Journal Citation Report (JCR) Science Edition</target_public_name>
    <service_type>getCitedJournal</service_type>
    <proxy>no</proxy>
    <target_url>http://gateway.webofknowledge.com/gateway/Gateway.cgi?GWVersion=2&amp;SrcAuth=ExLibris&amp;SrcApp=SFX&amp;KeyISSN=0028-0836&amp;DestApp=IC2JCR&amp;edition=SCIE</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>DOKUMENTUM_LCL</target_name>
    <target_public_name>Fernleihe oder dokumenTUM (Papier/Kapitel-Scans)</target_public_name>
    <service_type>getDocumentDelivery</service_type>
    <proxy>no</proxy>
    <target_url>https://sfx.bib-bvb.de/bvb-cgi/pick_bvb_container.cgi?jahr=1800&amp;options=-BV002529932-BV002534890&amp;svc=GUDD&amp;lang=de</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>DOCDEL_SUBITO</target_name>
    <target_public_name>Subito</target_public_name>
    <service_type>getDocumentDelivery</service_type>
    <proxy>no</proxy>
    <target_url>http://www.subito-doc.de/order/po.php?APY=1800&amp;SS=0028-0836&amp;JT=Nature&amp;BI=BVB&amp;CO=NATUAS</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>LOCAL_FEEDBACK</target_name>
    <target_public_name>Nachricht</target_public_name>
    <service_type>getWebService</service_type>
    <proxy>no</proxy>
    <target_url>http://sfx.bib-bvb.de/sfx_tum/cgi/public/feedback.cgi?em=support.emedien%40ub.tum.de&amp;year=1800&amp;issn=0028-0836&amp;journal=Nature</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_tum asked about 1234-5678, an ISSN no journal has: SFX resolved it to
// another journal of its knowledge base, with a free service.
const SFX_TUM_OTHER_JOURNAL = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;4550000000000100&lt;/item&gt;
  &lt;item key="rft.year"&gt;2020&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Bisanzio e l&amp;apos;Occidente&lt;/item&gt;
  &lt;item key="rft.issn"&gt;2345-6789&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>MISCELLANEOUS_FREE_EJOURNALS</target_name>
    <target_public_name>Free E- Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://riviste.unimi.it/index.php/BEO</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_tum and sfx_ubm, asked on 2026-10-20 the way the Worker asks about two
// open-access articles: Entropy (MDPI) and Scientific Reports, both CC BY in
// Crossref. Besides free collections, TUM lists MDPI's own platform for one and
// SpringerLink's package for the other, and LMU lists EBSCO, with no word that
// they are free. The Scientific Reports answer is cut to three of its seven
// targets; the others are free collections too.
const SFX_TUM_ENTROPY = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.year"&gt;2021&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Entropy&lt;/item&gt;
  &lt;item key="rft.issn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;39095494300041&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.3390/e23010001&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>DOAJ_DIRECTORY_OPEN_ACCESS_JOURNALS</target_name>
    <target_public_name>DOAJ Directory of Open Access Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e23010001?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>EZB-FREE-00999_FREELY_AVAILABLE_EZB_JOURNALS</target_name>
    <target_public_name>EZB-FREE-00999 freely available EZB journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>http://www.mdpi.com/journal/entropy</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>MDPI_MULTIDISCIPLINARY_DIGITAL_PUBLISHING_INSTITUTE</target_name>
    <target_public_name>MDPI - Multidisciplinary Digital Publishing Institute</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e23010001</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>PUBMED_CENTRAL_JOURNALS</target_name>
    <target_public_name>PubMed Central</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://www.ncbi.nlm.nih.gov/pmc/ivip/1099-4300/23/1/1</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

const SFX_TUM_SCIREP = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.jtitle"&gt;Scientific Reports&lt;/item&gt;
  &lt;item key="rft.year"&gt;2021&lt;/item&gt;
  &lt;item key="rft.issn"&gt;2045-2322&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;3130000000000245&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.1038/s41598-021-86323-x&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.eissn"&gt;2045-2322&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>SPRINGER_NATURE_OA_FREE_JOURNALS</target_name>
    <target_public_name>Springer Nature OA Free Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41598-021-86323-x?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>SPRINGER_LINK_JOURNALS_AUTOLOAD</target_name>
    <target_public_name>SpringerLink Journals - AutoHoldings</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41598-021-86323-x?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>SPRINGER_NATURE_NATURE_COM_JOURNALS_FULLY_OPEN_ACCESS</target_name>
    <target_public_name>Springer Nature - nature.com Journals - Fully Open Access</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41598-021-86323-x?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// TUM's answers for those two articles (captured 2026-10-20, cut to what the
// Worker reads): Entropy's lists MDPI's platform beside two free collections.
const SFX_TUM_ENTROPY_2017 = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="rft.eissn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.3390/e19020087&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Entropy&lt;/item&gt;
  &lt;item key="rft.year"&gt;2017&lt;/item&gt;
  &lt;item key="rft.issn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;39095494300041&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>DOAJ_DIRECTORY_OPEN_ACCESS_JOURNALS</target_name>
    <target_public_name>DOAJ Directory of Open Access Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e19020087?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>EZB-FREE-00999_FREELY_AVAILABLE_EZB_JOURNALS</target_name>
    <target_public_name>EZB-FREE-00999 freely available EZB journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>http://www.mdpi.com/journal/entropy</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>MDPI_MULTIDISCIPLINARY_DIGITAL_PUBLISHING_INSTITUTE</target_name>
    <target_public_name>MDPI - Multidisciplinary Digital Publishing Institute</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e19020087</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

const SFX_TUM_SCIENCE = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.1126/science.abd8911&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1095-9203&lt;/item&gt;
  &lt;item key="rft.year"&gt;2020&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Science&lt;/item&gt;
  &lt;item key="rft.issn"&gt;0036-8075&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;954925443632&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>JSTOR_COMPLETE_LEGACY</target_name>
    <target_public_name>Jstor Complete Legacy</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://www.jstor.org/openurl?volume=370&amp;issue=6520&amp;spage=1066&amp;issn=00368075&amp;date=2020&amp;aulast=Zani&amp;aufirst=Deborah&amp;sid=primo</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>AMERICAN_ASSOCIATION_FOR_THE_ADVANCEMENT_OF_SCIENCE</target_name>
    <target_public_name>American Association for the Advancement of Science</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1126/science.abd8911?locatt=mode:legacy</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

const SFX_LMU_ENTROPY = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.year"&gt;2021&lt;/item&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.3390/e23010001&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="rft.issn"&gt;1099-4300&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;39095494300041&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Entropy&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>DOAJ_DIRECTORY_OPEN_ACCESS_JOURNALS</target_name>
    <target_public_name>DOAJ Directory of Open Access Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e23010001?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>EBSCOHOST_ACADEMIC_SEARCH_COMPLETE</target_name>
    <target_public_name>EBSCOhost Academic Search Complete</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://openurl.ebsco.com/linksvc/linking.aspx?issn=1099-4300&amp;sid=Primo&amp;doi=10.3390%2Fe23010001&amp;issue=1&amp;genre=article&amp;title=Entropy&amp;spage=1&amp;date=2021-1&amp;volume=23&amp;custid=s5865125&amp;authtype=ip%2Cuid</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>MISCELLANEOUS_FREE_EJOURNALS</target_name>
    <target_public_name>Free E- Journals</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>http://www.mdpi.com/journal/entropy</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>MDPI_MULTIDISCIPLINARY_DIGITAL_PUBLISHING_INSTITUTE</target_name>
    <target_public_name>MDPI - Multidisciplinary Digital Publishing Institute</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.3390/e23010001</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>PUBMED_CENTRAL_JOURNALS</target_name>
    <target_public_name>PubMed Central</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://www.ncbi.nlm.nih.gov/pmc/ivip/1099-4300/23/1/1</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

// sfx_ubm, Nature 1476-4687, 2020, with the article's locators: Springer's and
// Nature's packages and two Gale databases, whose links carry LMU's Gale
// location and go on to LMU's Shibboleth sign-in.
const SFX_LMU_NATURE = `<?xml version="1.0" encoding="utf-8"?>

<ctx_obj_set>
 <ctx_obj identifier="">
  <ctx_obj_attributes>&lt;perldata&gt;
 &lt;hash&gt;
  &lt;item key="_stash"&gt;
   &lt;hash&gt;
    &lt;item key="@rft_id"&gt;
     &lt;array&gt;
      &lt;item key="0"&gt;info:doi/10.1038/s41586-020-2782-y&lt;/item&gt;
     &lt;/array&gt;
    &lt;/item&gt;
   &lt;/hash&gt;
  &lt;/item&gt;
  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;
  &lt;item key="rft.year"&gt;2020&lt;/item&gt;
  &lt;item key="rft.jtitle"&gt;Nature&lt;/item&gt;
  &lt;item key="rft.issn"&gt;0028-0836&lt;/item&gt;
  &lt;item key="rft.eissn"&gt;1476-4687&lt;/item&gt;
  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;
</ctx_obj_attributes>
  <ctx_obj_targets>
   <target>
    <target_name>SPRINGER_LINK_JOURNALS_AUTOLOAD</target_name>
    <target_public_name>SpringerLink Journals - AutoHoldings</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41586-020-2782-y?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>GALE_ACADEMIC_ONEFILE</target_name>
    <target_public_name>Gale Academic OneFile</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://find.gale.com/openurl/openurl?ctx_enc=info%3Aofi%3Aenc%3AUTF-8&amp;rft.spage=378&amp;rft.volume=586&amp;rft.issue=7829&amp;rft.date=2020&amp;url_ctx_fmt=info%3Aofi%2Ffmt%3Akev%3Amtx%3Actx&amp;res_id=info%3Asid%2Fgale%3AAONE&amp;url_ver=Z39.88-2004&amp;req_dat=info%3Asid%2Fgale%3Augnid%3Almum&amp;rft.jtitle=Nature&amp;rft_val_fmt=info%3Aofi%2Ffmt%3Akev%3Amtx%3Ajournal&amp;rft.issn=0028-0836&amp;rft.eissn=1476-4687&amp;rft.atitle=A+system+hierarchy+for+brain-inspired+computing</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>GALE_GENERAL_ONEFILE</target_name>
    <target_public_name>Gale General OneFile</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://find.gale.com/openurl/openurl?rft_val_fmt=info%3Aofi%2Ffmt%3Akev%3Amtx%3Ajournal&amp;rft.eissn=1476-4687&amp;rft.issn=0028-0836&amp;rft.atitle=A+system+hierarchy+for+brain-inspired+computing&amp;ctx_enc=info%3Aofi%3Aenc%3AUTF-8&amp;rft.volume=586&amp;rft.spage=378&amp;rft.date=2020&amp;rft.issue=7829&amp;url_ctx_fmt=info%3Aofi%2Ffmt%3Akev%3Amtx%3Actx&amp;res_id=info%3Asid%2Fgale%3AITOF&amp;url_ver=Z39.88-2004&amp;req_dat=info%3Asid%2Fgale%3Augnid%3Almum&amp;rft.jtitle=Nature</target_url>
    <is_related>no</is_related>
   </target>
   <target>
    <target_name>NATURE</target_name>
    <target_public_name>Nature</target_public_name>
    <service_type>getFullTxt</service_type>
    <proxy>no</proxy>
    <target_url>https://doi.org/10.1038/s41586-020-2782-y?nosfx=y</target_url>
    <is_related>no</is_related>
   </target>
  </ctx_obj_targets>
 </ctx_obj>
</ctx_obj_set>`;

/**
 * Crossref, the resolver, GetFTR and Unpaywall, each answering per call. `resolver`
 * receives the ISSN asked about so a test can answer per journal; `sfx`
 * answers for the Bavarian SFX instances the same way.
 */
function upstreams({
  crossref = () => jsonResponse({ message: CELL_WORK }),
  resolver = () => xml(CTO_CELL),
  sfx = () => xml(SFX_TUM_NATURE),
  getftr = () => jsonResponse({ entitlements: [] }),
  unpaywall = unpaywallRecord,
}: { crossref?: (target: URL) => Response | Promise<Response>; resolver?: Resolver; sfx?: Resolver; getftr?: (body: unknown, init: RequestInit) => Response | Promise<Response>; unpaywall?: (target: URL) => Response | Promise<Response> } = {}) {
  const calls: Array<{ url: URL; init: RequestInit & { headers?: Record<string, string> } }> = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target, init: init as RequestInit & { headers?: Record<string, string> } });
    if (target.host === 'api.crossref.org') return crossref(target);
    if (target.host === 'eu01.alma.exlibrisgroup.com') return resolver(target.searchParams.get('rft.issn')!, target);
    if (target.host === SFX_HOST) return sfx(target.searchParams.get('rft.issn')!, target);
    if (target.host === 'entitlements.prod.getft.io') return getftr(JSON.parse(init.body as string), init);
    if (target.host === 'api.unpaywall.org') return unpaywall(target);
    throw new Error(`unexpected fetch ${target}`);
  };
  const of = (host: string) => calls.filter(call => call.url.host === host);
  return {
    fetchImpl,
    calls,
    crossrefCalls: () => of('api.crossref.org'),
    resolverCalls: () => of('eu01.alma.exlibrisgroup.com'),
    sfxCalls: () => of(SFX_HOST),
    getftrCalls: () => of('entitlements.prod.getft.io'),
    unpaywallCalls: () => of('api.unpaywall.org'),
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
  // Nor is a page that wraps one: only Alma's own root closes an answer.
  assert.equal(parseResolverAnswer(`<html><body>${CTO_CELL}</body></html>`), null);
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
  // Complete, but with no context object: an answer about no journal, which
  // must not be cached for a week as a refusal.
  const stub = upstreams({ resolver: () => xml('<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u"><context_services/></uresolver_content>') });
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
  // Nor is a whole answer with a cut-off one after it: the root closes the answer.
  assert.equal(parseResolverAnswer(CTO_SINGLE_SERVICE + CTO_TRUNCATED), null);
  const stub = upstreams({ resolver: () => xml(CTO_TRUNCATED) });
  await assert.rejects(
    lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl }),
    error => (error as Error & { code?: string; status?: number }).code === 'ACCESS_LOOKUP_UNAVAILABLE' && (error as Error & { code?: string; status?: number }).status === 502,
  );
});

// Complete, but not well-formed XML: a package name with its ampersand left
// unescaped. Nothing the reader needs is missing.
const CTO_NOT_WELL_FORMED = CTO_SINGLE_SERVICE.replace('>ProQuest Central<', '>Earth, Atmospheric & Aquatic Science Collection<');
// Complete, but the filtered Pau service never closes: read as it stands, it
// would swallow the live service after it, which would then count as
// filtered too.
const CTO_SERVICE_LEFT_OPEN = CTO_FILTERED_AND_LIVE.replace('</resolution_url>\n    </context_service>', '</resolution_url>');

test('a complete answer is read even when it is not well-formed XML, but not one with a service left open', async () => {
  assert.deepEqual(parseResolverAnswer(CTO_NOT_WELL_FORMED)?.services.map(service => service.name), ['Nature', 'Earth, Atmospheric & Aquatic Science Collection']);
  const stub = upstreams({ resolver: () => xml(CTO_NOT_WELL_FORMED) });
  const result = await lookupInstitutionAccess({ doi: DOI, domain: 'usal.es' }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'entitled', collection: 'Nature', url: HARVARD_NATURE_URL });
  assert.equal(parseResolverAnswer(CTO_SERVICE_LEFT_OPEN), null);
});

// Captured 2026-10-19 on julac-hkpu for the Hong Kong Polytechnic University
// (852JULAC_HKPU), Nature 2020: two of its 24 services, the second filtered
// for the date. Alma wraps a value holding `&` or HTML in a CDATA section, as
// in that service's parser parameters and note. Keys the Worker does not read
// are left out, except those two.
const HKPU_NATURE_URL = 'https://julac-hkpu.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&package_service_id=103567352960003411&institutionId=3411&customerId=3405';
const CTO_CDATA = `<uresolver_content xmlns="http://com/exlibris/urm/uresolver/xmlbeans/u" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <context_object>
    <keys>
      <key id="available_services">viewit</key>
      <key id="available_services">getit</key>
      <key id="user_ip" xsi:nil="true"/>
      <key id="full_text_indicator">true</key>
      <key id="rft.issn">0028-0836</key>
      <key id="rft.mms_id">991021913441903411</key>
    </keys>
  </context_object>
  <context_services>
    <context_service service_type="getFullTxt" context_service_id="103567352960003411">
      <keys>
        <key id="package_public_name">Nature Publishing Group Journals (Springer Nature)</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 1869 volume: 1 issue: 1.&lt;br></key>
      </keys>
      <resolution_url>${HKPU_NATURE_URL.replace(/&/g, '&amp;')}</resolution_url>
    </context_service>
    <context_service service_type="getFullTxt" context_service_id="103567352990003411">
      <keys>
        <key id="package_public_name">Academic Search Premier (via EbscoHost)</key>
        <key id="Is_free">0</key>
        <key id="Availability">Available from 05/06/1997 until 30/11/2015.&lt;br></key>
        <key id="parse_parameters"><![CDATA[db_host=aph & url=https://search.ebscohost.com & url1=https://openurl.ebscohost.com/linksvc/linking.aspx & url2=https://openurl.ebsco.com & shib= & customer_id= & sso= & ipauth= & opid=&jkey=NAE]]></key>
        <key id="public_note"><![CDATA[In case of link problem, please try to access the <a target=’_blank’ href='http://ezproxy.lb.polyu.edu.hk/login?url=https://search.ebscohost.com/login.aspx?authtype=ip,uid&groupid=main&profile=ehost&defaultdb=aph'>database</a> directly.<br/>]]></key>
        <key id="Filtered">true</key>
        <key id="Filter reason">Date Filter</key>
      </keys>
      <resolution_url>https://julac-hkpu.alma.exlibrisgroup.com/view/action/uresolver.do?operation=resolveService&amp;package_service_id=103567352990003411&amp;institutionId=3411&amp;customerId=3405</resolution_url>
    </context_service>
  </context_services>
  <performance_counters>
    <performance_counter name="TOTAL" duration="0.0"/>
    <performance_counter name="MMS_LOOKUP" duration="0.337"/>
  </performance_counters>
</uresolver_content>`;

/** `text` with the first `find` after each of `anchors` in turn replaced. */
function replaceAfter(text: string, anchors: string[], find: string, replacement: string) {
  let at = 0;
  for (const anchor of anchors) {
    at = text.indexOf(anchor, at);
    assert.ok(at >= 0, `no ${anchor}`);
  }
  const start = text.indexOf(find, at);
  assert.ok(start >= 0, `no ${find}`);
  return text.slice(0, start) + replacement + text.slice(start + find.length);
}

// Damage the reader's expressions would read past, and markup they do not
// match though XML allows it (the last eight), each made once to each answer
// in the test below, all of more than one service. Read by its keys alone,
// such an answer can count a filtered service as live, a live one as
// filtered or missing, or lose a service's link.
const MARKUP_DAMAGE: Array<[string, (answer: string) => string]> = [
  ['a key left open in the context object', answer => replaceAfter(answer, ['<context_object>'], '</key>', '')],
  ['a key left open in a service', answer => replaceAfter(answer, ['<context_service '], '</key>', '')],
  ['a key opened inside another', answer => replaceAfter(replaceAfter(answer, ['<context_service '], '</key>', ''), ['<context_service '], '</key>', '</key></key>')],
  ['a key closed by a misspelt tag', answer => replaceAfter(answer, ['<context_service '], '</key>', '</kye>')],
  ['a < left unescaped in a key', answer => replaceAfter(answer, ['<context_service '], '</key>', '<</key>')],
  ['a quote left open in a key', answer => replaceAfter(answer, ['<context_service ', '<key '], '">', '>')],
  ['a quote left open in a service', answer => replaceAfter(answer, ['<context_service '], '">', '>')],
  ['a link left open', answer => replaceAfter(answer, [], '</resolution_url>', '')],
  ['the context object left open', answer => replaceAfter(answer, [], '</context_object>', '')],
  ['a service closed by the next one', answer => replaceAfter(answer, [], '</context_service>', '')],
  ['a service opened inside another', answer => replaceAfter(replaceAfter(answer, [], '</context_service>', ''), [], '</context_services>', '</context_service></context_services>')],
  ['a self-closing service before the first', answer => replaceAfter(answer, [], '<context_service ', '<context_service service_type="getHolding"/>\n    <context_service ')],
  ['a service closed with a space before >', answer => replaceAfter(answer, [], '</context_service>', '</context_service >')],
  ['a key opened with a space before >', answer => replaceAfter(answer, ['<context_service ', '<key '], '">', '" >')],
  ['a key opened with a second attribute', answer => replaceAfter(answer, ['<context_service ', '<key '], '">', '" lang="en">')],
  ['a service type in single quotes', answer => replaceAfter(answer, [], 'service_type="getFullTxt"', "service_type='getFullTxt'")],
  ['a service type with a character reference', answer => replaceAfter(answer, [], 'service_type="getFullTxt"', 'service_type="getFull&#84;xt"')],
  ['a service type with spaces around =', answer => replaceAfter(answer, [], 'service_type="getFullTxt"', 'service_type = "getFullTxt"')],
  ['a link opened with an attribute', answer => replaceAfter(answer, [], '<resolution_url>', '<resolution_url lang="en">')],
];

test('an answer with damaged markup is no answer, whatever its keys would read as', async () => {
  assert.deepEqual(parseResolverAnswer(CTO_CDATA), {
    fullText: true,
    matched: true,
    services: [{ name: 'Nature Publishing Group Journals (Springer Nature)', free: false, url: HKPU_NATURE_URL }],
    restricted: false,
  });
  const outcome = (answer: string) => lookupInstitutionAccess(
    { doi: DOI, domain: 'usal.es' },
    { fetchImpl: upstreams({ resolver: () => xml(answer) }).fetchImpl },
  ).then(result => result.status, error => (error as InstitutionAccessError).code);
  const answers = { Pau: CTO_FILTERED_AND_LIVE, USAL: CTO_CELL, Harvard: CTO_SINGLE_SERVICE, HKPU: CTO_CDATA };
  for (const [library, answer] of Object.entries(answers)) {
    assert.equal(await outcome(answer), 'entitled', library);
    const ampersand = answer.replace('<key id="package_public_name">', '<key id="package_public_name">A & ');
    assert.equal(await outcome(ampersand), 'entitled', `${library}: an unescaped &`);
    const declared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${answer}`;
    assert.equal(await outcome(declared), 'entitled', `${library}: an XML declaration`);
    for (const [damage, apply] of MARKUP_DAMAGE) {
      const damaged = apply(answer);
      assert.notEqual(damaged, answer);
      assert.equal(await outcome(damaged), 'ACCESS_LOOKUP_UNAVAILABLE', `${library}: ${damage}`);
    }
  }
});

test('CDATA is literal text, including split values and markup in public notes', () => {
  const answer = CTO_CDATA
    .replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[tr]]>u<![CDATA[e]]></key>')
    .replace('<key id="Filter reason">Date Filter</key>', '<key id="Filter reason"><![CDATA[Date Filter]]></key>')
    .replace('Nature Publishing Group Journals (Springer Nature)', '<![CDATA[Nature & <Archive> &amp;]]>')
    .replace(HKPU_NATURE_URL.replace(/&/g, '&amp;'), `<![CDATA[${HKPU_NATURE_URL}]]>`)
    .replace('<key id="Is_free">0</key>', '<key id="public_note"><![CDATA[<key id="Filtered">true</key>]]></key><key id="Is_free">0</key>');
  assert.deepEqual(parseResolverAnswer(answer), {
    fullText: true,
    matched: true,
    services: [{ name: 'Nature & <Archive> &amp;', free: false, url: HKPU_NATURE_URL }],
    restricted: false,
  });
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

// The University of Hawaiʻi gives one @hawaii.edu address to the students and
// staff of all ten campuses, and the only resolver the census found for the
// system is the Mānoa library's (01UHAWAII_MANOA, verified then withdrawn on
// 2026-10-20). A hawaii.edu reader may be at Hilo or a community college, so
// the system's domain and ROR id select nothing until the campus is known.
const HAWAII_SYSTEM_ROR = 'https://ror.org/03tzaeb71';

test('the Hawaiʻi system\'s mail domain and ROR id select no resolver, so Mānoa\'s holdings are not the system\'s answer', async () => {
  const { findResolver } = await import('./institution-access.ts');
  const { INSTITUTION_RESOLVERS } = await import('./institution-resolvers.ts');
  assert.equal(findResolver({ domain: 'hawaii.edu' }), null);
  assert.equal(findResolver({ domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR }), null);
  assert.equal(findResolver({ domain: 'hilo.hawaii.edu', rorId: HAWAII_SYSTEM_ROR }), null);
  assert.ok(!INSTITUTION_RESOLVERS.some(row => row.institution === '01UHAWAII_MANOA' || row.domains.includes('hawaii.edu') || row.rorId === HAWAII_SYSTEM_ROR));
  // Shipped, the row answered Nature 2020 with Mānoa's link; the stub only
  // knows USAL's host, so any resolver call would surface as an unexpected fetch.
  const stub = upstreams();
  await rejectsWith(
    lookupInstitutionAccess({ doi: DOI, domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR }, { fetchImpl: stub.fetchImpl }),
    'INSTITUTION_NOT_SUPPORTED',
    404,
  );
  assert.equal(stub.calls.length, 0);
});

test('rows deployed from main keep their resolvers: UVic-UCC, PUC Chile and JKU Linz, each once', async () => {
  const { findResolver } = await import('./institution-access.ts');
  const { INSTITUTION_RESOLVERS } = await import('./institution-resolvers.ts');
  const uvic = { host: 'csuc-uvic.alma.exlibrisgroup.com', institution: '34CSUC_UVIC' };
  const puc = { host: 'puc.alma.exlibrisgroup.com', institution: '56PUC_INST' };
  assert.deepEqual(findResolver({ domain: 'uvic-ucc.cat' }), uvic);
  assert.deepEqual(findResolver({ domain: 'alumnes.uvic-ucc.cat', rorId: 'https://ror.org/006zjws59' }), uvic);
  assert.deepEqual(findResolver({ domain: 'uc.cl' }), puc);
  assert.deepEqual(findResolver({ domain: 'estudiante.uc.cl', rorId: 'https://ror.org/04teye511' }), puc);
  assert.deepEqual(findResolver({ domain: 'jku.at' }), { host: 'obv-at-ubl.alma.exlibrisgroup.com', institution: '43ACC_UBL' });
  assert.equal(INSTITUTION_RESOLVERS.filter(row => row.rorId === 'https://ror.org/052r2xn60').length, 1);
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

test('an HTTP SAML identifier is preserved in GetFTR requests and its cache identity', async () => {
  const entityId = 'http://CAF.AD.UMANITOBA.CA/adfs/services/trust';
  const institution = query({ doi: DOI, domain: 'myumanitoba.ca', entityId, rorId: 'https://ror.org/02gfys938' });
  const stub = upstreams({ getftr: () => jsonResponse({ entitlements: [{ doi: DOI, statusCode: 200, entitled: 'no' }] }) });
  const answer = await lookupInstitutionAccess(institution, { fetchImpl: stub.fetchImpl, env: GETFTR_ENV });
  assert.equal(answer.status, 'not-entitled');
  assert.deepEqual(JSON.parse(stub.getftrCalls()[0].init.body as string).org, { entityID: entityId, rorID: 'https://ror.org/02gfys938' });
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
async function requestAccess(search: string, { token = TOKEN, method = 'GET', resolver = () => xml(CTO_CELL), crossref = () => jsonResponse({ message: CELL_WORK }) }: AccessOptions = {}) {
  const calls: string[] = [];
  const puts: Array<{ key: string; response: Response }> = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.host);
    if (url.pathname.endsWith('accounts:lookup')) return jsonResponse({ users: [{ localId: 'alice-uid' }] });
    if (url.host === 'api.crossref.org') return crossref();
    if (url.host === 'eu01.alma.exlibrisgroup.com' || url.host === 'na03.alma.exlibrisgroup.com' || url.host === 'ca01.alma.exlibrisgroup.com' || url.host === SFX_HOST) return resolver(url);
    if (url.host === 'api.unpaywall.org') return unpaywallRecord(url);
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
  assert.deepEqual([...key.searchParams], [['doi', DOI], ['library', '34BUC_USAL'], ['host', USAL_HOST], ['citation', 'article'], ['reading', 'balanced-tags-cdata']]);
  assert.match(accessPuts[0].response.headers.get('cache-control')!, /s-maxage=604800/);
});

test('the access route reads CDATA filters before caching its verdict', async () => {
  const date = CTO_FILTERED_BY_DATE
    .replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>')
    .replace('<key id="Filter reason">Date Filter</key>', '<key id="Filter reason"><![CDATA[Date Filter]]></key>');
  const cases = [
    [date, 'not-entitled'],
    [date.replace('Date Filter', 'IP Filter'), 'unknown'],
    [CTO_FILTERED_AND_LIVE.replace('<key id="Filtered">true</key>', '<key id="Filtered"><![CDATA[true]]></key>'), 'entitled'],
  ] as const;
  for (const [answer, status] of cases) {
    const { response, body, accessPuts } = await requestAccess(`doi=${encodeURIComponent(DOI)}&domain=usal.es`, {
      resolver: () => xml(answer),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body, status === 'entitled'
      ? { status, collection: 'Nature', url: NATURE_URL }
      : { status, collection: null, url: null });
    assert.equal(accessPuts.length, 1);
    assert.deepEqual(await accessPuts[0].response.clone().json(), body);
  }
  const broken = await requestAccess(`doi=${encodeURIComponent(DOI)}&domain=usal.es`, {
    resolver: () => xml(date.replace('Date Filter]]>', 'Date Filter')),
  });
  assert.equal(broken.response.status, 502);
  assert.equal(broken.accessPuts.length, 0);
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

test('the access route accepts Manitoba\'s HTTP SAML identifier and uses its Alma library', async () => {
  const search = new URLSearchParams({ doi: DOI, domain: 'umanitoba.ca', rorId: 'https://ror.org/02gfys938', entityId: 'http://CAF.AD.UMANITOBA.CA/adfs/services/trust' }).toString();
  const articleUrl = 'https://libproxy.umanitoba.ca/login?url=https://publisher.example/article';
  const { response, body, accessPuts } = await requestAccess(search, {
    resolver: target => {
      assert.equal(target.host, 'ca01.alma.exlibrisgroup.com');
      assert.equal(target.pathname, '/view/uresolver/01UMB_INST/openurl');
      return xml(`<uresolver_content><context_object><keys><key id="full_text_indicator">true</key></keys></context_object>
        <context_services><context_service service_type="getFullTxt"><keys><key id="package_public_name">Manitoba subscription</key></keys>
        <resolution_url>${articleUrl}</resolution_url></context_service></context_services></uresolver_content>`);
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'entitled', collection: 'Manitoba subscription', url: articleUrl });
  assert.equal(accessPuts.length, 1);
  assert.equal(new URL(accessPuts[0].key).searchParams.get('library'), '01UMB_INST');
  const anonymous = await requestAccess(search, { token: null });
  assert.equal(anonymous.response.status, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('the access route rejects malformed URNs and unsafe schemes without provider work or caching', async () => {
  for (const entityId of ['urn:mace:', 'urn::usc.edu', 'urn:mace:incommon:usc edu', 'urn:mace:usc%ZZ', 'javascript:alert(1)', 'http://', 'http://bad host/idp', 'ftp://idp.example.edu', `urn:mace:${'x'.repeat(300)}`]) {
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
    // The Pau answer with only the `</key>` of `Filtered` lost, or the key
    // written `</key >` or `<key id="Filtered" >`: read by its keys, the
    // service filtered out for the date counts as access.
    [`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { resolver: () => xml(CTO_FILTERED_BY_DATE.replace('<key id="Filtered">true</key>', '<key id="Filtered">true')) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE'],
    [`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { resolver: () => xml(CTO_FILTERED_BY_DATE.replace('<key id="Filtered">true</key>', '<key id="Filtered">true</key >')) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE'],
    [`doi=${encodeURIComponent(DOI)}&domain=usal.es`, { resolver: () => xml(CTO_FILTERED_BY_DATE.replace('<key id="Filtered">true</key>', '<key id="Filtered" >true</key>')) }, 502, 'ACCESS_LOOKUP_UNAVAILABLE'],
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


test('accepting HTTP entity identifiers does not allow HTTP reading links', () => {
  const answer = parseResolverAnswer(CTO_CELL.replaceAll('https://', 'http://'));
  assert.ok(answer);
  assert.ok(answer.services.length > 0);
  assert.ok(answer.services.every(service => service.url === null));
});

test('the access route refuses the Hawaiʻi system instead of answering with Mānoa\'s subscriptions', async () => {
  const search = new URLSearchParams({ doi: DOI, domain: 'hawaii.edu', rorId: HAWAII_SYSTEM_ROR }).toString();
  const { response, body, calls, accessPuts } = await requestAccess(search);
  assert.equal(response.status, 404);
  assert.deepEqual(body, { code: 'INSTITUTION_NOT_SUPPORTED' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(accessPuts.length, 0);
  assert.ok(calls.every(host => !host.endsWith('.alma.exlibrisgroup.com')), `asked a resolver: ${calls.join(', ')}`);
});

const PLOS_DOI = '10.1371/journal.pone.0234574';
const PLOS_WORK = {
  DOI: PLOS_DOI,
  'issn-type': [{ value: '1932-6203', type: 'electronic' }],
  issued: { 'date-parts': [[2020, 6, 25]] },
  volume: '15',
  issue: '6',
  page: 'e0234574',
};
const askedAbout = (work: object) => () => jsonResponse({ message: work });

test('an SFX answer is read from the full-text services of the journal asked about', () => {
  const services = [
    { name: 'SpringerLink Journals - AutoHoldings', free: false, url: NATURE_LINK },
    { name: 'Nature', free: false, url: NATURE_LINK },
  ];
  for (const issn of ['1476-4687', '0028-0836']) {
    assert.deepEqual(parseSfxAnswer(SFX_TUM_NATURE, issn), { fullText: true, matched: true, services, restricted: false });
  }
});

// SFX's simplexml answer to the same question nests a related journal in
// the attributes (Nature Physical Science, eISSN 2058-1106); added here to
// the full answer, its items must not stand in for the object's own.
const SFX_NESTED_RELATED = SFX_TUM_NATURE.replace(' &lt;/hash&gt;\n&lt;/perldata&gt;', `  &lt;item key="@sfx.related_objects"&gt;
   &lt;array&gt;
    &lt;item key="0"&gt;
     &lt;hash&gt;
      &lt;item key="rft.object_id"&gt;954927601631&lt;/item&gt;
      &lt;item key="rft.eissn"&gt;2058-1106&lt;/item&gt;
     &lt;/hash&gt;
    &lt;/item&gt;
   &lt;/array&gt;
  &lt;/item&gt;
 &lt;/hash&gt;
&lt;/perldata&gt;`);

test('a related journal nested in an SFX answer\'s attributes does not stand in for the journal asked about', () => {
  assert.ok(SFX_NESTED_RELATED.includes('2058-1106'));
  assert.deepEqual(parseSfxAnswer(SFX_NESTED_RELATED, '1476-4687'), parseSfxAnswer(SFX_TUM_NATURE, '1476-4687'));
  assert.equal(parseSfxAnswer(SFX_NESTED_RELATED, '2058-1106')!.matched, false);
});

test('a subscription in an SFX library is entitled, its article link through the library\'s login', async () => {
  const stub = upstreams({ crossref: askedAbout(NATURE_WORK) });
  const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'entitled', collection: 'SpringerLink Journals - AutoHoldings', url: `${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}` });
  // The login keeps the article whole, its own query included.
  assert.equal(new URL(result.url!).searchParams.get('qurl'), NATURE_LINK);
  const [call, ...more] = stub.sfxCalls();
  assert.equal(more.length, 0);
  assert.equal(call.url.pathname, '/sfx_tum');
  // The article's own locators, as for Alma, and only full-text services.
  for (const [key, value] of [
    ['rft.issn', '1476-4687'], ['rft.date', '2020'], ['rft_id', `info:doi/${NATURE_DOI}`],
    ['rft.volume', '586'], ['rft.issue', '7829'], ['rft.spage', '378'],
    ['svc.fulltext', 'yes'], ['sfx.response_type', 'multi_obj_detailed_xml'],
  ]) {
    assert.equal(call.url.searchParams.get(key), value, key);
  }
  assert.equal(stub.resolverCalls().length, 0);
});

test('free collections in an SFX answer are open access, not the library\'s subscription', async () => {
  assert.deepEqual(parseSfxAnswer(SFX_FAU_PLOS, '1932-6203'), { fullText: false, matched: true, services: [], restricted: false });
  assert.deepEqual(parseSfxAnswer(SFX_TUM_JAMS, '0894-0347'), { fullText: false, matched: true, services: [], restricted: false });
  const stub = upstreams({ crossref: askedAbout(PLOS_WORK), sfx: () => xml(SFX_FAU_PLOS) });
  const result = await lookupInstitutionAccess({ doi: PLOS_DOI, domain: 'fau.de', rorId: FAU_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  assert.equal(stub.sfxCalls()[0].url.pathname, '/sfx_uben');
  assert.equal(stub.unpaywallCalls().length, 0);
  // Only a whole word marks a collection free: Elsevier's licensed Freedom
  // Collection is a subscription.
  const freedom = SFX_TUM_NATURE.replace('<target_name>NATURE</target_name>', '<target_name>ELSEVIER_SD_FREEDOM_COLLECTION</target_name>');
  assert.equal(parseSfxAnswer(freedom, '1476-4687')!.services.length, 2);
});

test('an SFX answer without full text is a refusal: holdings, loans and delivery are not full text', async () => {
  assert.deepEqual(parseSfxAnswer(SFX_TUM_NATURE_1800, '0028-0836'), { fullText: false, matched: true, services: [], restricted: false });
  const stub = upstreams({ crossref: askedAbout(NATURE_WORK), sfx: () => xml(SFX_TUM_NATURE_1800) });
  const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  assert.deepEqual(stub.sfxCalls().map(call => call.url.searchParams.get('rft.issn')), ['1476-4687', '0028-0836']);
  assert.equal(stub.unpaywallCalls().length, 0);
});

// No captured answer had an object without a record; this one is the 1800
// answer without its `rft.object_id`.
const SFX_UNRESOLVED = SFX_TUM_NATURE_1800.replace('  &lt;item key="rft.object_id"&gt;954925427238&lt;/item&gt;\n', '');

test('an SFX answer about another journal, or without a record, is no answer about this one: unknown, not refused', async () => {
  assert.deepEqual(parseSfxAnswer(SFX_TUM_OTHER_JOURNAL, '1234-5678'), { fullText: false, matched: false, services: [], restricted: true });
  assert.ok(!SFX_UNRESOLVED.includes('rft.object_id'));
  assert.deepEqual(parseSfxAnswer(SFX_UNRESOLVED, '0028-0836'), { fullText: false, matched: false, services: [], restricted: true });
  const work = { 'issn-type': [{ value: '1234-5678', type: 'print' }], issued: { 'date-parts': [[2020]] } };
  const stub = upstreams({ crossref: askedAbout(work), sfx: () => xml(SFX_TUM_OTHER_JOURNAL) });
  const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'unknown', collection: null, url: null });
});

// What the pilot's answers did not show, built on the TUM answer: Ex Libris
// documents `is_related` as no, close or remote, and full text of selected
// articles as a service type of its own (without `sfx.has_full_text`, so
// that rule is tested alone). The third claims full text and lists none; the
// fourth links its subscriptions over plain http, which the reader cannot follow.
const SFX_RELATED = SFX_TUM_NATURE.replaceAll('<is_related>no</is_related>', '<is_related>close</is_related>');
const SFX_SELECTED = SFX_TUM_NATURE
  .replaceAll('<service_type>getFullTxt</service_type>', '<service_type>getSelectedFullTxt</service_type>')
  .replace('  &lt;item key="sfx.has_full_text"&gt;yes&lt;/item&gt;\n', '');
const SFX_UNLISTED = SFX_TUM_NATURE.replace(/<ctx_obj_targets>[\s\S]*<\/ctx_obj_targets>/, '<ctx_obj_targets/>');
const SFX_PLAIN_HTTP = SFX_TUM_NATURE.replaceAll('<target_url>https://', '<target_url>http://');

test('related, selective, unlisted or unlinkable full text leaves an SFX answer unknown, not refused', async () => {
  assert.ok(!SFX_SELECTED.includes('sfx.has_full_text'));
  for (const answer of [SFX_RELATED, SFX_SELECTED, SFX_UNLISTED, SFX_PLAIN_HTTP]) {
    assert.deepEqual(parseSfxAnswer(answer, '1476-4687'), { fullText: false, matched: true, services: [], restricted: true });
    const stub = upstreams({ crossref: askedAbout(NATURE_WORK), sfx: () => xml(answer) });
    const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, { status: 'unknown', collection: null, url: null });
  }
});

// The TUM answer twice over, as SFX answers an ambiguous question.
const SFX_TWO_OBJECTS = SFX_TUM_NATURE.replace('</ctx_obj_set>', `${SFX_TUM_NATURE.match(/<ctx_obj [\s\S]*<\/ctx_obj>/)![0]}\n</ctx_obj_set>`);

test('an incomplete SFX answer, or an SFX failure, is an outage rather than a refusal', async () => {
  const broken = [
    SFX_TUM_NATURE.slice(0, -60),
    // Cut inside its second object, or between the two: the first one alone
    // must not be read. An object left open would swallow the next.
    SFX_TWO_OBJECTS.slice(0, SFX_TWO_OBJECTS.lastIndexOf('<ctx_obj_targets>')),
    SFX_TWO_OBJECTS.slice(0, SFX_TWO_OBJECTS.indexOf('</ctx_obj>') + '</ctx_obj>'.length),
    SFX_TWO_OBJECTS.replace('</ctx_obj>', ''),
    SFX_TUM_NATURE.replace('</ctx_obj>', ''),
    SFX_TUM_NATURE.replace('</target>', ''),
    '<html><body>SFX ist vorübergehend nicht erreichbar</body></html>',
    '',
    '<ctx_obj_set/>',
    '<ctx_obj_set></ctx_obj_set>',
    SFX_TUM_NATURE.replace(/<ctx_obj_attributes>[\s\S]*<\/ctx_obj_attributes>/, '<ctx_obj_attributes></ctx_obj_attributes>'),
    SFX_TUM_NATURE.replace('&lt;/hash&gt;\n&lt;/perldata&gt;', '&lt;/perldata&gt;'),
  ];
  assert.deepEqual(parseSfxAnswer(SFX_TWO_OBJECTS, '1476-4687')!.services.length, 4);
  for (const text of broken) assert.equal(parseSfxAnswer(text, '1476-4687'), null, text.slice(0, 40));
  const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
  for (const sfx of [
    () => xml(broken[0]),
    () => new Response(broken[1], { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response('error', { status: 500 }),
    timeout,
  ]) {
    const stub = upstreams({ crossref: askedAbout(NATURE_WORK), sfx });
    await rejectsWith(lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl }), 'ACCESS_LOOKUP_UNAVAILABLE', 502);
  }
});

test('TUM, LMU and FAU each reach their own SFX instance, and their answers are cached apart', async () => {
  const libraries = [
    { domain: 'tum.de', student: 'mytum.de', rorId: TUM_ROR, instance: 'sfx_tum' },
    { domain: 'lmu.de', student: 'campus.lmu.de', rorId: LMU_ROR, instance: 'sfx_ubm' },
    { domain: 'fau.de', student: 'fau.de', rorId: FAU_ROR, instance: 'sfx_uben' },
  ];
  const keys = new Set();
  const links: Record<string, Record<string, string>> = {
    sfx_tum: { proxy: TUM_LOGIN },
    sfx_ubm: { proxy: LMU_LOGIN, signsIn: 'find.gale.com,link.gale.com' },
    sfx_uben: {},
  };
  for (const { domain, student, rorId, instance } of libraries) {
    const { proxy, signsIn } = links[instance];
    const resolver = { host: SFX_HOST, institution: instance, product: 'sfx', ...(proxy ? { proxy } : {}), ...(signsIn ? { signsIn: signsIn.split(',') } : {}) };
    assert.deepEqual(findResolver({ domain }), resolver);
    // A student domain is not a row's; the link stores the ROR id that reaches it.
    assert.deepEqual(findResolver({ domain: student, rorId }), resolver);
    const key = upstreamParams({ doi: NATURE_DOI, domain: student, rorId }, {});
    assert.deepEqual(key, { doi: NATURE_DOI, library: instance, host: SFX_HOST, product: 'sfx', ...links[instance] });
    keys.add(JSON.stringify(key));
    const stub = upstreams({ crossref: askedAbout(NATURE_WORK) });
    await lookupInstitutionAccess({ doi: NATURE_DOI, domain: student, rorId }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(stub.sfxCalls().map(call => call.url.pathname), [`/${instance}`]);
  }
  assert.equal(keys.size, 3);
  // An Alma library's key is what it was before the SFX rows.
  assert.deepEqual(upstreamParams({ doi: DOI, domain: 'usal.es' }, {}), { doi: DOI, library: '34BUC_USAL', host: USAL_HOST });
});

test('the access route answers for an SFX library and caches under its instance, the product and the login', async () => {
  for (const [domain, rorId, instance, url, linkParams] of [
    ['mytum.de', TUM_ROR, 'sfx_tum', `${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}`, [['proxy', TUM_LOGIN]]],
    ['campus.lmu.de', LMU_ROR, 'sfx_ubm', `${LMU_LOGIN}${encodeURIComponent(NATURE_LINK)}`, [['proxy', LMU_LOGIN], ['signsIn', 'find.gale.com,link.gale.com']]],
    ['fau.de', FAU_ROR, 'sfx_uben', NATURE_LINK, []],
  ] as Array<[string, string, string, string, string[][]]>) {
    const { response, body, accessPuts } = await requestAccess(new URLSearchParams({ doi: NATURE_DOI, domain, rorId }).toString(), {
      crossref: askedAbout(NATURE_WORK),
      resolver: target => xml(target.pathname === `/${instance}` ? SFX_TUM_NATURE : '<html>wrong instance</html>'),
    });
    assert.equal(response.status, 200, domain);
    assert.deepEqual(body, { status: 'entitled', collection: 'SpringerLink Journals - AutoHoldings', url });
    assert.equal(accessPuts.length, 1);
    assert.deepEqual([...new URL(accessPuts[0].key).searchParams], [
      ['doi', NATURE_DOI], ['library', instance], ['host', SFX_HOST], ['product', 'sfx'], ...linkParams, ['citation', 'article'], ['reading', 'balanced-tags-cdata'],
    ]);
  }
  const outage = await requestAccess(new URLSearchParams({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }).toString(), {
    crossref: askedAbout(NATURE_WORK),
    resolver: () => new Response('<html>Wartungsarbeiten</html>', { status: 503 }),
  });
  assert.equal(outage.response.status, 502);
  assert.deepEqual(outage.body, { code: 'ACCESS_LOOKUP_UNAVAILABLE' });
  assert.equal(outage.response.headers.get('cache-control'), 'no-store');
  assert.equal(outage.accessPuts.length, 0);
});

test('an article Crossref says is openly licensed is open access, whatever an SFX menu lists for it', async () => {
  // Read alone, these menus would make each article a subscription: MDPI's and
  // Springer's platforms and EBSCO carry no word that they are free.
  assert.deepEqual(parseSfxAnswer(SFX_TUM_ENTROPY, '1099-4300')!.services.map(service => service.name), ['MDPI - Multidisciplinary Digital Publishing Institute']);
  assert.deepEqual(parseSfxAnswer(SFX_TUM_SCIREP, '2045-2322')!.services.map(service => service.name), ['SpringerLink Journals - AutoHoldings']);
  assert.deepEqual(parseSfxAnswer(SFX_LMU_ENTROPY, '1099-4300')!.services.map(service => service.name), ['EBSCOhost Academic Search Complete', 'MDPI - Multidisciplinary Digital Publishing Institute']);
  for (const [doi, work, domain, rorId, answer] of [
    [ENTROPY_DOI, ENTROPY_WORK, 'tum.de', TUM_ROR, SFX_TUM_ENTROPY],
    [SCIREP_DOI, SCIREP_WORK, 'tum.de', TUM_ROR, SFX_TUM_SCIREP],
    [ENTROPY_DOI, ENTROPY_WORK, 'campus.lmu.de', LMU_ROR, SFX_LMU_ENTROPY],
  ] as Array<[string, object, string, string, string]>) {
    const stub = upstreams({ crossref: askedAbout(work), sfx: () => xml(answer) });
    const result = await lookupInstitutionAccess({ doi, domain, rorId }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null }, `${domain} ${doi}`);
    // The licence decides it; neither the library nor Unpaywall is asked.
    assert.equal(stub.sfxCalls().length, 0);
    assert.equal(stub.unpaywallCalls().length, 0);
  }
});

// The closed Nature answer with the free collections TUM listed for an open
// article added after the licensed ones.
const SFX_TUM_NATURE_WITH_FREE = SFX_TUM_NATURE.replace('  </ctx_obj_targets>', `${SFX_TUM_ENTROPY.match(/ {3}<target>\n {4}<target_name>DOAJ[\s\S]*?\n {3}<\/target>/)![0]}
${SFX_TUM_ENTROPY.match(/ {3}<target>\n {4}<target_name>PUBMED_CENTRAL[\s\S]*?\n {3}<\/target>/)![0]}
  </ctx_obj_targets>`);

test('a closed article keeps its subscription, beside free collections and whatever Crossref leaves unsaid', async () => {
  assert.equal((SFX_TUM_NATURE_WITH_FREE.match(/<target>/g) || []).length, 4);
  const expected = { status: 'entitled', collection: 'SpringerLink Journals - AutoHoldings', url: `${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}` };
  // Springer Nature's own terms; none at all, as for most closed articles in the
  // catalogue; an open licence on the accepted manuscript only; and one that
  // starts tomorrow. None opens the version of record today, and Unpaywall has
  // the article as closed.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const cc = 'https://creativecommons.org/licenses/by/4.0/';
  for (const license of [
    NATURE_WORK.license,
    [],
    [{ URL: cc, start: { 'date-time': '2020-10-14T00:00:00Z' }, 'content-version': 'am', 'delay-in-days': 0 }],
    [{ URL: cc, start: { 'date-time': tomorrow }, 'content-version': 'vor', 'delay-in-days': 0 }],
  ]) {
    const stub = upstreams({ crossref: askedAbout({ ...NATURE_WORK, license }), sfx: () => xml(SFX_TUM_NATURE_WITH_FREE) });
    const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, expected, JSON.stringify(license));
  }
});

test('an open article Crossref gives no licence for is not the library\'s: Unpaywall has it as gold', async () => {
  // Read alone, TUM's answer would make MDPI's platform a subscription.
  assert.deepEqual(parseSfxAnswer(SFX_TUM_ENTROPY_2017, '1099-4300')!.services.map(service => service.name), ['MDPI - Multidisciplinary Digital Publishing Institute']);
  const stub = upstreams({ crossref: askedAbout(ENTROPY_2017_WORK), sfx: () => xml(SFX_TUM_ENTROPY_2017) });
  const result = await lookupInstitutionAccess({ doi: ENTROPY_2017_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'not-entitled', collection: null, url: null });
  const [call, ...more] = stub.unpaywallCalls();
  assert.equal(more.length, 0);
  assert.equal(decodeURIComponent(call.url.pathname), `/v2/${ENTROPY_2017_DOI}`);
  assert.equal(call.url.searchParams.get('email'), 'app@papertok.io');
  // Asked with the contact `/oa` uses when one is configured.
  const configured = upstreams({ crossref: askedAbout(ENTROPY_2017_WORK), sfx: () => xml(SFX_TUM_ENTROPY_2017) });
  await lookupInstitutionAccess({ doi: ENTROPY_2017_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: configured.fetchImpl, env: { UNPAYWALL_EMAIL: 'library@papertok.test' } });
  assert.equal(configured.unpaywallCalls()[0].url.searchParams.get('email'), 'library@papertok.test');
});

test('a closed article without a licence keeps its subscription once Unpaywall has its published version behind the paywall', async () => {
  const jstor = parseSfxAnswer(SFX_TUM_SCIENCE, '1095-9203')!.services[0];
  assert.equal(jstor.name, 'Jstor Complete Legacy');
  // As captured (closed), and with a repository copy (green, synthetic): a
  // copy elsewhere does not open the published version.
  for (const oaStatus of ['closed', 'green']) {
    const stub = upstreams({
      crossref: askedAbout(SCIENCE_WORK),
      sfx: () => xml(SFX_TUM_SCIENCE),
      unpaywall: () => jsonResponse({ ...UNPAYWALL_RECORDS[SCIENCE_DOI], oa_status: oaStatus }),
    });
    const result = await lookupInstitutionAccess({ doi: SCIENCE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, { status: 'entitled', collection: 'Jstor Complete Legacy', url: `${TUM_LOGIN}${encodeURIComponent(jstor.url!)}` }, oaStatus);
  }
});

test('beside free collections, the article\'s own access decides: a published version open at the publisher is not the library\'s', async () => {
  // The closed Nature answer with DOAJ and PubMed Central, for the article as
  // Unpaywall could have it (synthetic statuses on the captured record).
  for (const [oaStatus, expected] of [
    ['closed', { status: 'entitled', collection: 'SpringerLink Journals - AutoHoldings', url: `${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}` }],
    ['green', { status: 'entitled', collection: 'SpringerLink Journals - AutoHoldings', url: `${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}` }],
    ['hybrid', { status: 'not-entitled', collection: null, url: null }],
    ['bronze', { status: 'not-entitled', collection: null, url: null }],
    ['gold', { status: 'not-entitled', collection: null, url: null }],
  ] as Array<[string, object]>) {
    const stub = upstreams({
      crossref: askedAbout(NATURE_WORK),
      sfx: () => xml(SFX_TUM_NATURE_WITH_FREE),
      unpaywall: () => jsonResponse({ ...UNPAYWALL_RECORDS[NATURE_DOI], oa_status: oaStatus }),
    });
    const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
    assert.deepEqual(result, expected, oaStatus);
  }
});

test('without Unpaywall\'s word an SFX service not named free proves nothing: unknown, and an Unpaywall outage is a 502', async () => {
  const lookup = (unpaywall: (target: URL) => Response | Promise<Response>) => lookupInstitutionAccess(
    { doi: ENTROPY_2017_DOI, domain: 'tum.de', rorId: TUM_ROR },
    { fetchImpl: upstreams({ crossref: askedAbout(ENTROPY_2017_WORK), sfx: () => xml(SFX_TUM_ENTROPY_2017), unpaywall }).fetchImpl },
  );
  // Not indexed, or no status Unpaywall gives.
  for (const unpaywall of [
    () => jsonResponse({ HTTP_status_code: 404, error: true }, 404),
    () => jsonResponse({ doi: ENTROPY_2017_DOI, is_oa: null, oa_status: null }),
  ]) {
    assert.deepEqual(await lookup(unpaywall), { status: 'unknown', collection: null, url: null });
  }
  // Down, not JSON, or cut off by the deadline: nothing is claimed either way.
  for (const unpaywall of [
    () => jsonResponse({}, 503),
    () => new Response('<html>Service Unavailable</html>', { status: 200 }),
    () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
  ]) {
    await rejectsWith(lookup(unpaywall), 'ACCESS_LOOKUP_UNAVAILABLE', 502);
  }
});

test('LMU\'s Gale links start LMU\'s sign-in and are not wrapped again; its EBSCO links go through E-Medien whole', async () => {
  // Gale only: the Springer and Nature packages taken out of LMU's answer.
  const galeOnly = SFX_LMU_NATURE.replace(/ {3}<target>\n {4}<target_name>(?:SPRINGER_LINK_JOURNALS_AUTOLOAD|NATURE)<[\s\S]*?\n {3}<\/target>\n?/g, '');
  const gale = parseSfxAnswer(galeOnly, '1476-4687')!.services[0].url!;
  assert.match(gale, /^https:\/\/find\.gale\.com\/openurl\/openurl\?/);
  let stub = upstreams({ crossref: askedAbout(NATURE_WORK), sfx: () => xml(galeOnly) });
  let result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl: stub.fetchImpl });
  assert.deepEqual(result, { status: 'entitled', collection: 'Gale Academic OneFile', url: gale });
  // EBSCO's link, from LMU's Entropy answer, for a closed article in the same
  // journal (licence and Unpaywall status synthetic): its own query and the %2F
  // inside it reach EBSCO unchanged.
  const ebsco = parseSfxAnswer(SFX_LMU_ENTROPY, '1099-4300')!.services[0].url!;
  stub = upstreams({
    crossref: askedAbout({ ...ENTROPY_WORK, license: [] }),
    sfx: () => xml(SFX_LMU_ENTROPY),
    unpaywall: () => jsonResponse({ doi: ENTROPY_DOI, is_oa: false, oa_status: 'closed' }),
  });
  result = await lookupInstitutionAccess({ doi: ENTROPY_DOI, domain: 'campus.lmu.de', rorId: LMU_ROR }, { fetchImpl: stub.fetchImpl });
  assert.equal(result.collection, 'EBSCOhost Academic Search Complete');
  assert.ok(result.url!.startsWith(LMU_LOGIN));
  assert.equal(new URL(result.url!).searchParams.get('qurl'), ebsco);
  assert.match(ebsco, /doi=10\.3390%2Fe23010001&.*authtype=ip%2Cuid/);
});

test('a link already on the library\'s login stays as it is, and FAU\'s go to the article directly', async () => {
  for (const already of [`${TUM_LOGIN}${encodeURIComponent(NATURE_LINK)}`, 'https://login.tum-eaccess.de/connect?session=s1&qurl=https%3a%2f%2fdoi.org%2f10.1038%2fs41586-020-2782-y']) {
    const answer = SFX_TUM_NATURE.replaceAll(`<target_url>${NATURE_LINK}</target_url>`, `<target_url>${already.replace(/&/g, '&amp;')}</target_url>`);
    const stub = upstreams({ crossref: askedAbout(NATURE_WORK), sfx: () => xml(answer) });
    const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'tum.de', rorId: TUM_ROR }, { fetchImpl: stub.fetchImpl });
    assert.equal(result.url, already);
  }
  // FAU documents eduVPN and Shibboleth per database, and no login to send a link through.
  const stub = upstreams({ crossref: askedAbout(NATURE_WORK) });
  const result = await lookupInstitutionAccess({ doi: NATURE_DOI, domain: 'fau.de', rorId: FAU_ROR }, { fetchImpl: stub.fetchImpl });
  assert.equal(result.url, NATURE_LINK);
});
