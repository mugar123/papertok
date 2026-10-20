import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

export interface InstitutionQuery { domain: string; entityId?: string | null; rorId?: string | null }
/** An Alma resolver (`institution` is its code), or an SFX instance (`product: 'sfx'`, `institution` its path). */
export interface InstitutionResolver { host: string; institution: string; product?: 'sfx' }
type InstitutionIds = Pick<InstitutionQuery, 'entityId' | 'rorId'>;
export interface LookupOptions { fetchImpl?: typeof fetch; env?: WorkerEnv; now?: () => number }
interface GetFtrEntry {
  doi?: unknown; statusCode?: unknown; source?: unknown; entitled?: unknown;
  vor?: Array<{ url?: string }>; document?: string;
}
type CrossrefWork = Partial<Record<'issued' | 'published-online' | 'published-print', { 'date-parts'?: number[][] }>> & {
  'issn-type'?: Array<{ type?: string; value?: unknown }>; ISSN?: unknown[];
  volume?: unknown; issue?: unknown; page?: unknown;
};

/** What the resolver is asked about: a journal and year, or one article in it. */
export interface ResolverCitation {
  issn: string;
  year: number | null | undefined;
  doi?: string;
  volume?: string;
  issue?: string;
  spage?: string;
}


/**
 * Whether a reader's library gives access to a paper.
 *
 * Two providers answer the same question. GetFTR, the publishers' entitlement
 * service, is asked first when a key is configured and the caller named its
 * institution by entityID or ROR id; it answers per DOI. Otherwise, or when
 * GetFTR cannot say, the library's own link resolver (Alma, or SFX for the
 * rows that say so) is asked about the journal and year, which it only knows
 * by ISSN, so Crossref supplies those.
 *
 * The answer belongs to the institution, not to the reader, so it can be
 * cached globally; the session is required only to keep the route from being
 * a free proxy to the resolvers.
 */

import { institutionDomainOf } from '../src/utils/institutionDomain.ts';
import { INSTITUTION_RESOLVERS } from './institution-resolvers.ts';
import { cacheResponse } from './provider-runtime.ts';

// A library's holdings change slowly; `unknown` (no ISSN, or GetFTR down with
// no resolver behind it) may be an outage, so it is asked again sooner.
export const ACCESS_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_UNKNOWN_CACHE_SECONDS = 6 * 60 * 60;
// What the resolver is asked about, in the cache key: until 2026-10-17 it was
// asked about the journal and year alone, and its link went to the journal's
// home page. Those answers would otherwise be served for a week more.
const RESOLVER_CITATION = 'article';
// How the resolver's answer is read, in the cache keys of both routes that
// read one, so that results read an older way are not served on. Until
// 2026-10-19 a service Alma had filtered out for the date counted as access;
// then a single-service answer cut off before its services read as a
// refusal; then a complete answer that was not well-formed XML was not read.
export const RESOLVER_READING = 'complete-answers';

export async function handleInstitutionAccess(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  const query = readAccessQuery(url.searchParams);
  const ttl = (payload: { status: string }) => (payload.status === 'unknown' ? ACCESS_UNKNOWN_CACHE_SECONDS : ACCESS_CACHE_SECONDS);
  return cacheResponse(request, origin, env, ttl, () => lookupInstitutionAccess(query, { env }), {
    canonicalParams: { ...upstreamParams(query, env), citation: RESOLVER_CITATION, reading: RESOLVER_READING },
  });
}

export const INSTITUTION_ACCESS_PATH = '/access';

/**
 * The library's link resolver for an institution, or null. The ROR id
 * comes first: one university answers to several mail domains, and the link
 * flow records the id with the domain. No public registry maps a university
 * to its resolver, so the table is a census (`INSTITUTION_RESOLVERS`),
 * grown by running `scripts/diagnostics/alma-resolver-census.mjs`.
 */
export function findResolver({ domain, rorId = null }: Pick<InstitutionQuery, 'domain' | 'rorId'>): InstitutionResolver | null {
  const entry = (rorId && INSTITUTION_RESOLVERS.find(row => row.rorId === rorId))
    || INSTITUTION_RESOLVERS.find(row => row.domains.includes(domain));
  if (!entry) return null;
  return { host: entry.host, institution: entry.institution, ...(entry.product ? { product: entry.product } : {}) };
}

// One deadline for the whole lookup, not one per fetch: a Crossref call and
// two resolver calls at six seconds each would run past the browser's own
// wait, and an answer that lands after the browser has hung up is never
// cached by either side, so the next card pays for it all again.
const LOOKUP_DEADLINE_MS = 8000;
const MAX_ISSNS = 2;
const GETFTR_API = 'https://entitlements.prod.getft.io';
const DOI_PATTERN = /^10\.\d{4,9}\/.+/;
const ROR_ID_PATTERN = /^https:\/\/ror\.org\/0[a-z0-9]{6}\d{2}$/;
// SAML entity IDs include URN assigned names (USC) and HTTP URIs (Manitoba).
// These are opaque identifiers, never URLs to fetch or reading links.
const ENTITY_URN_PATTERN = /^urn:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]:(?!\/)(?:[a-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-f]{2})+$/i;
const ISSN_PATTERN = /^\d{4}-\d{3}[\dX]$/;

export class InstitutionAccessError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'InstitutionAccessError';
    this.code = code;
    this.status = status;
  }
}

function httpsUrl(value: string | null | undefined) {
  try {
    return new URL(value!).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function isEntityId(value: string) {
  if (ENTITY_URN_PATTERN.test(value)) return true;
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The normalized query, or a 400 naming the first malformed parameter. */
export function readAccessQuery(searchParams: URLSearchParams) {
  const doi = (searchParams.get('doi') || '').trim().toLowerCase();
  if (!DOI_PATTERN.test(doi) || doi.length > 300) throw new InstitutionAccessError('INVALID_DOI', 400);
  return { doi, ...readInstitutionQuery(searchParams) };
}

/** The institution half of the query, shared with `/institution/services`. */
export function readInstitutionQuery(searchParams: URLSearchParams) {
  const domain = institutionDomainOf(`x@${searchParams.get('domain') || ''}`);
  if (!domain) throw new InstitutionAccessError('INVALID_DOMAIN', 400);
  const entityId = (searchParams.get('entityId') || '').trim();
  const rorId = (searchParams.get('rorId') || '').trim().toLowerCase();
  if ((entityId && (entityId.length > 300 || !isEntityId(entityId)))
    || (rorId && !ROR_ID_PATTERN.test(rorId))) {
    throw new InstitutionAccessError('INVALID_INSTITUTION_ID', 400);
  }
  return { domain, entityId: entityId || null, rorId: rorId || null };
}

/**
 * Reads the body inside the deadline as well: a resolver that sends its
 * headers and then stalls is as unavailable as one that never answered.
 */
async function fetchText(url: string, init: RequestInit, fetchImpl: typeof fetch, signal: AbortSignal) {
  const response = await fetchImpl(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${new URL(url).host} returned ${response.status}`), { status: response.status });
  return text;
}

function unescapeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlKey(xml: string, id: string) {
  const match = xml.match(new RegExp(`<key id="${id}">([^<]*)</key>`));
  return match ? unescapeXml(match[1]) : null;
}

/**
 * The resolver's `svc_dat=CTO` answer. Null when it carries no context
 * object, which is not an answer about the journal at all.
 *
 * Alma lists every full-text service it knows and marks the ones it ruled
 * out for this request (`Filtered`, with a `Filter reason`), link included.
 * A service filtered for the date is a collection whose coverage ends before
 * the year asked about (Pau, Nature 2020: one package until 2012, answered
 * `entitled` until 2026-10-19), so it is left out. A filter for any other
 * reason (an IP range, a user group) hides a service the Worker cannot judge
 * from outside, so `restricted` says the answer may be incomplete.
 * `matched` says whether Alma resolved the journal to a record of its own
 * (`rft.mms_id`): an answer without one lists nothing because the journal,
 * or the library's data, is not where it was asked for, not because the
 * library lacks it.
 */
export function parseResolverAnswer(xml: unknown) {
  const text = String(xml);
  // An answer cut off by the resolver or the network parses as far as it
  // goes: a single-service answer cut before its services would read as a
  // refusal. Only a complete answer is read: its root element closes, and
  // every service that opens also closes, so no service is read with
  // another's keys. Validating the whole answer as XML took about a
  // millisecond per answer in Node, and one services page reads up to 36
  // answers within the 10 ms CPU limit of Workers Free; the expressions
  // below read keys, not a document tree, so a complete answer is enough.
  // Only one with a context object is an answer about the journal at all.
  // A library set to send readers straight to one service answers with
  // `available_services` = single_service and no indicator (Harvard,
  // Helsinki, Amsterdam, 2026-10-19); its services still carry Alma's
  // filter marks, so what is left unfiltered is the answer.
  const opened = text.match(/<context_service\b/g)?.length ?? 0;
  const closed = text.match(/<\/context_service>/g)?.length ?? 0;
  if (!text.trimEnd().endsWith('</uresolver_content>') || opened !== closed || !/<context_object>/.test(text)) return null;
  const indicator = xmlKey(text, 'full_text_indicator');
  const matched = xmlKey(text, 'rft.mms_id') !== null;
  const services = [];
  let restricted = false;
  for (const [, attributes, body] of String(xml).matchAll(/<context_service\b([^>]*)>([\s\S]*?)<\/context_service>/g)) {
    if (!/\bservice_type="getFullTxt"/.test(attributes)) continue;
    if (xmlKey(body, 'Filtered') === 'true') {
      if (!/date/i.test(xmlKey(body, 'Filter reason') || '')) restricted = true;
      continue;
    }
    const resolution = body.match(/<resolution_url>([^<]*)<\/resolution_url>/);
    services.push({
      name: xmlKey(body, 'package_public_name'),
      free: xmlKey(body, 'Is_free') === '1',
      url: resolution ? httpsUrl(unescapeXml(resolution[1].trim())) : null,
    });
  }
  const fullText = indicator === 'true' || indicator === 'false' ? indicator === 'true' : services.length > 0;
  return { fullText, matched, services, restricted };
}

/** The most DOIs one GetFTR request may carry (Entitlement API v2.7). */
export const GETFTR_BATCH_SIZE = 20;

/**
 * GetFTR's verdict on each DOI of one request, as a Map; a DOI it has no
 * verdict for maps to null: `maybe`, a publisher outside GetFTR or a per-DOI
 * error leave the question to the resolver rather than becoming an answer.
 * The service being down throws, so that a caller can tell an outage from a
 * question nobody could answer. One request, whatever the count: a Worker
 * invocation has a subrequest budget, and the services list asks about
 * every catalogue platform at once.
 */
export async function askGetFtrBatch({ dois, entityId, rorId }: InstitutionIds & { dois: string[] }, env: WorkerEnv, fetchImpl: typeof fetch, signal: AbortSignal) {
  if (dois.length > GETFTR_BATCH_SIZE) throw new RangeError(`GetFTR takes at most ${GETFTR_BATCH_SIZE} DOIs per request`);
  const org: { entityID?: string; rorID?: string } = {};
  if (entityId) org.entityID = entityId;
  if (rorId) org.rorID = rorId;
  const text = await fetchText(`${env.GETFTR_API_URL || GETFTR_API}/v2.1/entitlements`, {
    method: 'POST',
    headers: {
      'X-API-KEY': env.GETFTR_API_KEY!,
      'X-REQUEST-ID': crypto.randomUUID(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ org, dois }),
  }, fetchImpl, signal);
  const payload: { entitlements?: GetFtrEntry[] } = JSON.parse(text);
  const entries = Array.isArray(payload?.entitlements) ? payload.entitlements : [];
  const verdicts = new Map<string, ReturnType<typeof verdictOf>>();
  for (const doi of dois) {
    const entry = entries.find(item => String(item?.doi || '').toLowerCase() === doi);
    verdicts.set(doi, verdictOf(entry));
  }
  return verdicts;
}

function verdictOf(entry: GetFtrEntry | undefined) {
  if (!entry || entry.statusCode !== 200 || entry.source === 'publisher_not_supported') return null;
  if (entry.entitled === 'no') return { status: 'not-entitled', collection: null, url: null };
  if (entry.entitled !== 'yes') return null;
  const url = httpsUrl(entry.vor?.[0]?.url) || httpsUrl(entry.document);
  return url ? { status: 'entitled', collection: 'GetFTR', url } : null;
}

/** GetFTR's verdict on one DOI, or null (see `askGetFtrBatch`). */
export async function askGetFtr({ doi, entityId, rorId }: InstitutionIds & { doi: string }, env: WorkerEnv, fetchImpl: typeof fetch, signal: AbortSignal) {
  const verdicts = await askGetFtrBatch({ dois: [doi], entityId, rorId }, env, fetchImpl, signal);
  return verdicts.get(doi) ?? null;
}

function crossrefYear(work: CrossrefWork | null) {
  for (const field of ['issued', 'published-online', 'published-print'] as const) {
    const year = work?.[field]?.['date-parts']?.[0]?.[0];
    if (Number.isInteger(year)) return year;
  }
  return null;
}

/** Electronic before print: Alma's portfolios are electronic holdings. */
function crossrefIssns(work: CrossrefWork | null) {
  const typed = Array.isArray(work?.['issn-type']) ? work['issn-type'] : [];
  const ordered = [
    ...typed.filter(entry => entry?.type === 'electronic').map(entry => entry.value),
    ...typed.filter(entry => entry?.type === 'print').map(entry => entry.value),
    ...(Array.isArray(work?.ISSN) ? work.ISSN : []),
  ].map(value => String(value || '').trim().toUpperCase()).filter(value => ISSN_PATTERN.test(value));
  return [...new Set(ordered)].slice(0, MAX_ISSNS);
}

/**
 * The article's own locators, for the resolver: Alma's link to a publisher is
 * built from the OpenURL, and each publisher's parser reads a different field
 * (APS the DOI, ScienceDirect volume and first page). Asked about the journal
 * alone, the resolver answers with a link to the journal's home page.
 */
function crossrefArticle(work: CrossrefWork | null): Pick<ResolverCitation, 'volume' | 'issue' | 'spage'> {
  const text = (value: unknown) => (typeof value === 'string' && value.trim()) || (Number.isInteger(value) ? String(value) : '');
  const [spage] = text(work?.page).split(/[-\u2013]/);
  return { volume: text(work?.volume), issue: text(work?.issue), spage: spage.trim() };
}

/**
 * The resolver's answer about `citation`: `{ issn, year }` for the journal,
 * plus `doi`, `volume`, `issue` and `spage` when the question is one article.
 */
export async function askResolver(resolver: InstitutionResolver, citation: ResolverCitation, fetchImpl: typeof fetch, signal: AbortSignal) {
  if (resolver.product === 'sfx') {
    const text = await fetchText(sfxRequestUrl(resolver, citation), { headers: { accept: 'text/xml' } }, fetchImpl, signal);
    return parseSfxAnswer(text, citation.issn);
  }
  const { issn, year, doi, volume, issue, spage } = citation;
  const params = new URLSearchParams({ svc_dat: 'CTO', 'rft.genre': 'article', 'rft.issn': issn });
  if (year) params.set('rft.date', String(year));
  else params.set('u.ignore_date_coverage', 'true');
  if (doi) params.set('rft_id', `info:doi/${doi}`);
  for (const [key, value] of [['rft.volume', volume], ['rft.issue', issue], ['rft.spage', spage]] as const) {
    if (value) params.set(key, value);
  }
  const url = `https://${resolver.host}/view/uresolver/${resolver.institution}/openurl?${params}`;
  return parseResolverAnswer(await fetchText(url, { headers: { accept: 'text/xml' } }, fetchImpl, signal));
}

/**
 * The OpenURL an SFX instance (`https://<host>/<instance>`) is asked, for
 * its XML answer. Only full-text services are requested: unfiltered, the
 * Bavarian instances also looked up print holdings and loan options and took
 * 5 to 10 s, against 0.4 to 1.8 s for full text alone (2026-10-20).
 */
export function sfxRequestUrl(resolver: InstitutionResolver, { issn, year, doi, volume, issue, spage }: ResolverCitation) {
  const params = new URLSearchParams({
    url_ver: 'Z39.88-2004',
    ctx_ver: 'Z39.88-2004',
    rft_val_fmt: 'info:ofi/fmt:kev:mtx:journal',
    'rft.genre': 'article',
    'rft.issn': issn,
    svc_val_fmt: 'info:ofi/fmt:kev:mtx:sch_svc',
    'svc.fulltext': 'yes',
    'sfx.response_type': 'multi_obj_detailed_xml',
  });
  if (year) params.set('rft.date', String(year));
  if (doi) params.set('rft_id', `info:doi/${doi}`);
  for (const [key, value] of [['rft.volume', volume], ['rft.issue', issue], ['rft.spage', spage]] as const) {
    if (value) params.set(key, value);
  }
  return `https://${resolver.host}/${resolver.institution}?${params}`;
}

// SFX's answer has no free flag: the knowledge base names its free
// collections (DOAJ_DIRECTORY_OPEN_ACCESS_JOURNALS, MISCELLANEOUS_FREE_EJOURNALS,
// EZB-FREE-00999_FREELY_AVAILABLE_EZB_JOURNALS, PUBMED_CENTRAL_JOURNALS,
// AMERICAN_MATHEMATICAL_SOCIETY_PUBLICATIONS_FREELY_ACCESSIBLE, 2026-10-20),
// and that name is the only evidence. Whole words, so that Elsevier's
// licensed Freedom Collection stays licensed.
const SFX_FREE_TARGET = /\b(?:free|freely|open access|doaj|pubmed central)\b/i;
const SFX_TARGET_FIELD = /<(target_name|target_public_name|service_type|target_url|is_related)>([^<]*)<\/\1>/g;
// Perldata nests hashes and arrays (`_stash` repeats `@rft_id`); only the
// scalar items of the outer hash describe the context object.
const PERLDATA_TOKEN = /<(\/?)(?:hash|array)>|<item key="([^"]*)">([^<]*)<\/item>/g;

/**
 * The top-level scalar attributes of an SFX context object, which SFX sends
 * as escaped perldata, or null when that perldata does not close.
 */
function sfxAttributes(escaped: string) {
  const perldata = unescapeXml(escaped);
  const attributes = new Map<string, string>();
  let depth = 0;
  for (const [, closing, key, value] of perldata.matchAll(PERLDATA_TOKEN)) {
    if (key === undefined) depth += closing ? -1 : 1;
    else if (depth === 1) attributes.set(key, value);
    if (depth < 0) return null;
  }
  return depth === 0 && /<\/perldata>\s*$/.test(perldata) ? attributes : null;
}

/**
 * An SFX answer about the journal `issn`, in `parseResolverAnswer`'s shape,
 * or null when it is not a complete answer (cut off, an HTML page).
 *
 * SFX resolves the ISSN to a journal of its knowledge base (`rft.object_id`),
 * and not always the one asked about: 1234-5678 came back as "Bisanzio e
 * l'Occidente", 2345-6789, with a free service (2026-10-20). Only an object
 * SFX resolved to the ISSN asked about is read. Any other object, another
 * journal's or one without a record (which no captured answer had), is
 * `restricted`: an answer the Worker cannot judge, not a refusal.
 *
 * Only `getFullTxt` services of the journal itself count. Holdings, loans
 * and document delivery are not full text. A related journal's service
 * (`is_related` other than `no`), full text of selected articles only, a
 * licensed service without an https link, or an answer that says it has full
 * text (`sfx.has_full_text`) without listing it leave the answer `restricted`
 * rather than refused. A free collection is open access, not the library's:
 * it is left out, so an answer that lists only free collections has no full
 * text from the library.
 *
 * Read with patterns, like Alma's answer, once it is complete: its root
 * closes, and every object and service that opens also closes. A general XML
 * parser read the perldata twice and cost about 10 ms of CPU for a 36-title
 * services page, the Worker's whole allowance on the Free plan (2026-10-20).
 */
export function parseSfxAnswer(xml: unknown, issn: string) {
  const text = String(xml);
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  if (!/<ctx_obj_set>/.test(text) || !text.trimEnd().endsWith('</ctx_obj_set>')
    || count(/<ctx_obj\b/g) !== count(/<\/ctx_obj>/g) || count(/<target>/g) !== count(/<\/target>/g)) return null;
  const objects = [...text.matchAll(/<ctx_obj\b[^>]*>([\s\S]*?)<\/ctx_obj>/g)].map(([, body]) => body);
  if (!objects.length) return null;
  const services = [];
  let matched = false;
  let restricted = false;
  for (const object of objects) {
    const escaped = object.match(/<ctx_obj_attributes>([\s\S]*?)<\/ctx_obj_attributes>/);
    const attributes = escaped && sfxAttributes(escaped[1]);
    if (!attributes) return null;
    const targets = [...object.matchAll(/<target>([\s\S]*?)<\/target>/g)]
      .map(([, body]) => Object.fromEntries([...body.matchAll(SFX_TARGET_FIELD)].map(([, field, value]) => [field, unescapeXml(value.trim())])))
      .filter(target => target.service_type === 'getFullTxt' || target.service_type === 'getSelectedFullTxt');
    if (!attributes.has('rft.object_id') || ![attributes.get('rft.issn'), attributes.get('rft.eissn')].includes(issn)) {
      restricted = true;
      continue;
    }
    matched = true;
    if (attributes.get('sfx.has_full_text') === 'yes' && !targets.length) restricted = true;
    for (const target of targets) {
      if (target.service_type !== 'getFullTxt' || target.is_related !== 'no') {
        restricted = true;
        continue;
      }
      if (SFX_FREE_TARGET.test((target.target_name || '').replace(/[_-]+/g, ' '))) continue;
      const url = httpsUrl(target.target_url);
      if (!url) {
        restricted = true;
        continue;
      }
      services.push({ name: target.target_public_name || target.target_name || null, free: false, url });
    }
  }
  return { fullText: services.length > 0, matched, services, restricted };
}

const UNKNOWN = Object.freeze({ status: 'unknown', collection: null, url: null });

/**
 * The parameters a lookup actually sends upstream, for the edge cache key:
 * the library asked (its institution code and the host it is asked on,
 * since every mail domain of a university reaches the same resolver, and a
 * regional host may answer for a code without the library's data, plus the
 * product when it is not Alma, since each is asked and read its own way), or
 * the domain when there is none, and the institution ids only with a GetFTR
 * key, since only GetFTR gets them.
 */
export function upstreamParams(query: InstitutionQuery & { doi?: string | null }, env: WorkerEnv = {}) {
  const { doi = null, domain, entityId = null, rorId = null } = query;
  const getFtr = Boolean(env.GETFTR_API_KEY);
  const resolver = findResolver(query);
  return {
    ...(doi ? { doi } : {}),
    ...(resolver
      ? { library: resolver.institution, host: resolver.host, ...(resolver.product ? { product: resolver.product } : {}) }
      : { domain }),
    ...(getFtr && entityId ? { entityId } : {}),
    ...(getFtr && rorId ? { rorId } : {}),
  };
}

export async function lookupInstitutionAccess(
  { doi, domain, entityId = null, rorId = null }: InstitutionQuery & { doi: string },
  { fetchImpl = (...args) => fetch(...args), env = {} }: LookupOptions = {},
) {
  const resolver = findResolver({ domain, rorId });
  const getFtr = Boolean(env.GETFTR_API_KEY) && Boolean(entityId || rorId);
  if (!resolver && !getFtr) throw new InstitutionAccessError('INSTITUTION_NOT_SUPPORTED', 404);
  const signal = AbortSignal.timeout(LOOKUP_DEADLINE_MS);

  if (getFtr) {
    let verdict = null;
    try {
      verdict = await askGetFtr({ doi, entityId, rorId }, env, fetchImpl, signal);
    } catch (error) {
      console.warn('GetFTR unavailable', (error as UpstreamError)?.message);
    }
    if (verdict) return verdict;
    if (!resolver) return UNKNOWN;
  }

  let work: CrossrefWork | null;
  try {
    const text = await fetchText(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=app@papertok.io`, {
      headers: { accept: 'application/json' },
    }, fetchImpl, signal);
    work = JSON.parse(text)?.message || null;
  } catch (error) {
    // A DOI registered with DataCite or mEDRA is simply not in Crossref.
    if ((error as UpstreamError)?.status === 404) return UNKNOWN;
    throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
  }

  const year = crossrefYear(work);
  const article = crossrefArticle(work);
  let refusals = 0;
  const issns = crossrefIssns(work);
  for (const issn of issns) {
    let answer;
    try {
      answer = await askResolver(resolver!, { issn, year, doi, ...article }, fetchImpl, signal);
    } catch {
      throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
    }
    // An answer that is not the resolver's XML (a maintenance page, say) is
    // the resolver being down, which must not be remembered as "unknown".
    if (!answer) throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
    const usable = answer.services.filter(service => service.url);
    if (usable.length) {
      // A subscription is what the reader cannot get elsewhere; a free
      // service is open access that the `/oa` route already reports.
      const best = usable.find(service => !service.free) || usable[0];
      return { status: 'entitled', collection: best.name, url: best.url };
    }
    // A service hidden by an IP or group filter may be the library's own
    // subscription: no answer, rather than a refusal.
    if (answer.restricted) continue;
    if (!answer.fullText) refusals += 1;
  }
  return issns.length && refusals === issns.length
    ? { status: 'not-entitled', collection: null, url: null }
    : UNKNOWN;
}
