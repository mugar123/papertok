import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

export interface InstitutionQuery { domain: string; entityId?: string | null; rorId?: string | null }
export interface InstitutionResolver { host: string; institution: string }
type InstitutionIds = Pick<InstitutionQuery, 'entityId' | 'rorId'>;
export interface LookupOptions { fetchImpl?: typeof fetch; env?: WorkerEnv; now?: () => number }
interface GetFtrEntry {
  doi?: unknown; statusCode?: unknown; source?: unknown; entitled?: unknown;
  vor?: Array<{ url?: string }>; document?: string;
}
type CrossrefWork = Partial<Record<'issued' | 'published-online' | 'published-print', { 'date-parts'?: number[][] }>> & {
  'issn-type'?: Array<{ type?: string; value?: unknown }>; ISSN?: unknown[];
};


/**
 * Whether a reader's library gives access to a paper.
 *
 * Two providers answer the same question. GetFTR, the publishers' entitlement
 * service, is asked first when a key is configured and the caller named its
 * institution by entityID or ROR id; it answers per DOI. Otherwise, or when
 * GetFTR cannot say, the library's own Alma link resolver is asked about the
 * journal and year, which it only knows by ISSN, so Crossref supplies those.
 *
 * The answer belongs to the institution, not to the reader, so it can be
 * cached globally; the session is required only to keep the route from being
 * a free proxy to the resolvers.
 */

import { institutionDomainOf } from '../src/utils/institutionDomain.ts';
import { cacheResponse } from './provider-runtime.ts';

// A library's holdings change slowly; `unknown` (no ISSN, or GetFTR down with
// no resolver behind it) may be an outage, so it is asked again sooner.
export const ACCESS_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_UNKNOWN_CACHE_SECONDS = 6 * 60 * 60;

export async function handleInstitutionAccess(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  const query = readAccessQuery(url.searchParams);
  const ttl = (payload: { status: string }) => (payload.status === 'unknown' ? ACCESS_UNKNOWN_CACHE_SECONDS : ACCESS_CACHE_SECONDS);
  return cacheResponse(request, origin, env, ttl, () => lookupInstitutionAccess(query, { env }), {
    canonicalParams: upstreamParams(query, env),
  });
}

export const INSTITUTION_ACCESS_PATH = '/access';

// Two configuration strings per library; no public registry maps a ROR id to
// its Alma instance, so each institution is added here by hand.
export const INSTITUTION_RESOLVERS: Readonly<Partial<Record<string, InstitutionResolver>>> = Object.freeze({
  'usal.es': { host: 'eu01.alma.exlibrisgroup.com', institution: '34BUC_USAL' },
});

// One deadline for the whole lookup, not one per fetch: a Crossref call and
// two resolver calls at six seconds each would run past the browser's own
// wait, and an answer that lands after the browser has hung up is never
// cached by either side, so the next card pays for it all again.
const LOOKUP_DEADLINE_MS = 8000;
const MAX_ISSNS = 2;
const GETFTR_API = 'https://entitlements.prod.getft.io';
const DOI_PATTERN = /^10\.\d{4,9}\/.+/;
const ROR_ID_PATTERN = /^https:\/\/ror\.org\/0[a-z0-9]{6}\d{2}$/;
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
  if ((entityId && (entityId.length > 300 || !httpsUrl(entityId)))
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
 * The resolver's `svc_dat=CTO` answer. Null when it carries no
 * `full_text_indicator`, which is not an answer about the journal at all.
 */
export function parseResolverAnswer(xml: unknown) {
  const indicator = xmlKey(String(xml), 'full_text_indicator');
  if (indicator !== 'true' && indicator !== 'false') return null;
  const services = [];
  for (const [, attributes, body] of String(xml).matchAll(/<context_service\b([^>]*)>([\s\S]*?)<\/context_service>/g)) {
    if (!/\bservice_type="getFullTxt"/.test(attributes)) continue;
    const resolution = body.match(/<resolution_url>([^<]*)<\/resolution_url>/);
    services.push({
      name: xmlKey(body, 'package_public_name'),
      free: xmlKey(body, 'Is_free') === '1',
      url: resolution ? httpsUrl(unescapeXml(resolution[1].trim())) : null,
    });
  }
  return { fullText: indicator === 'true', services };
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

export async function askResolver(resolver: InstitutionResolver, issn: string, year: number | null | undefined, fetchImpl: typeof fetch, signal: AbortSignal) {
  const params = new URLSearchParams({ svc_dat: 'CTO', 'rft.genre': 'article', 'rft.issn': issn });
  if (year) params.set('rft.date', String(year));
  else params.set('u.ignore_date_coverage', 'true');
  const url = `https://${resolver.host}/view/uresolver/${resolver.institution}/openurl?${params}`;
  return parseResolverAnswer(await fetchText(url, { headers: { accept: 'text/xml' } }, fetchImpl, signal));
}

const UNKNOWN = Object.freeze({ status: 'unknown', collection: null, url: null });

/**
 * The parameters a lookup actually sends upstream, for the edge cache key:
 * the institution ids only reach GetFTR, so without a key they must not
 * split the cache, and the domain only picks a resolver.
 */
export function upstreamParams({ doi = null, domain, entityId = null, rorId = null }: InstitutionQuery & { doi?: string | null }, env: WorkerEnv = {}) {
  const getFtr = Boolean(env.GETFTR_API_KEY);
  return {
    ...(doi ? { doi } : {}),
    domain,
    ...(getFtr && entityId ? { entityId } : {}),
    ...(getFtr && rorId ? { rorId } : {}),
  };
}

export async function lookupInstitutionAccess(
  { doi, domain, entityId = null, rorId = null }: InstitutionQuery & { doi: string },
  { fetchImpl = (...args) => fetch(...args), env = {} }: LookupOptions = {},
) {
  const resolver = Object.hasOwn(INSTITUTION_RESOLVERS, domain) ? INSTITUTION_RESOLVERS[domain] : null;
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
  let refusals = 0;
  const issns = crossrefIssns(work);
  for (const issn of issns) {
    let answer;
    try {
      answer = await askResolver(resolver!, issn, year, fetchImpl, signal);
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
    if (!answer.fullText) refusals += 1;
  }
  return issns.length && refusals === issns.length
    ? { status: 'not-entitled', collection: null, url: null }
    : UNKNOWN;
}
