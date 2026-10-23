import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';
import type { CrossrefLicense } from '../src/utils/crossrefLicense.ts';

export interface InstitutionQuery { domain: string; entityId?: string | null; rorId?: string | null }
/**
 * An Alma resolver (`institution` is its code), or an SFX instance
 * (`product: 'sfx'`, `institution` its path) with the remote-access login its
 * library documents (`proxy`) and the hosts whose links start the library's
 * sign-in by themselves (`signsIn`).
 */
export interface InstitutionResolver { host: string; institution: string; product?: 'sfx'; proxy?: string; signsIn?: readonly string[] }
type InstitutionIds = Pick<InstitutionQuery, 'entityId' | 'rorId'>;
export interface LookupOptions { fetchImpl?: typeof fetch; env?: WorkerEnv; now?: () => number }
interface GetFtrEntry {
  doi?: unknown; statusCode?: unknown; source?: unknown; entitled?: unknown;
  vor?: Array<{ url?: string }>; document?: string;
}
type CrossrefWork = Partial<Record<'issued' | 'published-online' | 'published-print', { 'date-parts'?: number[][] }>> & {
  'issn-type'?: Array<{ type?: string; value?: unknown }>; ISSN?: unknown[];
  volume?: unknown; issue?: unknown; page?: unknown; license?: CrossrefLicense[];
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

import { openLicenseFromCrossref } from '../src/utils/crossrefLicense.ts';
import { institutionDomainOf } from '../src/utils/institutionDomain.ts';
import { INSTITUTION_RESOLVERS } from './institution-resolvers.ts';
import { unpaywallUrl } from './open-access.ts';
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
// refusal; then a complete answer that was not well-formed XML was not read;
// then a key left open, or one whose tag was written another way, was read as
// absent, so a service Alma had filtered out for the date could count as
// access again, cached for seven days.
export const RESOLVER_READING = 'balanced-tags-cdata';

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
  return {
    host: entry.host,
    institution: entry.institution,
    ...(entry.product ? { product: entry.product } : {}),
    ...(entry.proxy ? { proxy: entry.proxy } : {}),
    ...(entry.signsIn ? { signsIn: entry.signsIn } : {}),
  };
}

/**
 * The link a reader follows for one of the library's services. An SFX link
 * goes straight to the publisher, where a reader off campus meets the
 * paywall, so it goes through the remote-access login the library documents,
 * encoded as `qurl` (EZproxy at TUM and LMU kept such targets whole,
 * 2026-10-20). A link already on that login's host, or one whose host starts
 * the library's sign-in itself (Gale's links for LMU go on to LMU's
 * Shibboleth), is left as it is; so is every link of a library without a
 * documented login, Alma's included, whose own links apply its proxy.
 */
export function libraryLink(resolver: InstitutionResolver, url: string) {
  if (!resolver.proxy) return url;
  const { hostname } = new URL(url);
  const login = new URL(resolver.proxy).hostname;
  if (hostname === login || hostname.endsWith(`.${login}`) || resolver.signsIn?.includes(hostname)) return url;
  return `${resolver.proxy}${encodeURIComponent(url)}`;
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
const ENTITY_ID_MAX_LENGTH = 300;
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

/**
 * Whether a value is a SAML entityID this Worker takes: a URN assigned name
 * or an HTTP(S) URI, up to 300 characters. One rule for what a query may
 * name and for what `/institution/link` may store, so a link never saves an
 * identifier that the access routes then refuse on every request
 * (SeamlessAccess listed `https.//idp.seha.ae/openathens`, PAP-68).
 */
export function isEntityId(value: string) {
  if (value.length > ENTITY_ID_MAX_LENGTH) return false;
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
  if ((entityId && !isEntityId(entityId)) || (rorId && !ROR_ID_PATTERN.test(rorId))) {
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

// A closing tag; an opening tag, with the rest of the element when it is
// empty or holds only text (most keys, so most elements take one match); a
// CDATA section; an XML declaration; or a `<` that starts none of them.
// Tags match only as Alma writes them: an element name with no namespace
// prefix, each attribute after one space, its value in double quotes with no
// `<`, `>` or `&`, and no space before `>`, `/>` or a closing tag's `>`. A
// quote left open runs into the next `<` or `>`, so the tag does not match.
const MARKUP = /<(?:\/([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*)((?: [\w.:-]+="[^"<>&]*")*)(\/|>[^<]*<\/\2)?|!\[CDATA\[[\s\S]*?\]\]|\?xml\s[^>]*\?)>|</g;

/**
 * Whether an answer's markup holds together the way `parseResolverAnswer`
 * reads it, checked in one pass over its tags: every `<` starts a tag, a
 * CDATA section or, at the very start, an XML declaration, every element
 * closes inside the element it opened in, the root element,
 * `uresolver_content`, closes at the end, a key holds no element, and no
 * service opens inside another. The reader matches tags as Alma writes
 * them, not every spelling XML allows: `<key id="…">`, `</key>`,
 * `service_type="getFullTxt"`, `<resolution_url>` and `</context_service>`,
 * reading a service up to the next `</context_service>`. So a tag written
 * another way fails (a namespace prefix, a space before `>` or around `=`,
 * single quotes, a key with a value opened other than as `<key id="…">`, a
 * link with an attribute), and so does a service closed in its own opening
 * tag: read anyway, a `Filtered` key would count as absent, a full-text
 * service would be skipped or lose its link, or a service would be read
 * with the next one's keys. Every saved answer writes its tags this way.
 * Text is not checked, so an unescaped `&` does not stop an answer from
 * being read. `parseResolverAnswer` reads CDATA as literal text, so a
 * `Filtered` value in CDATA still excludes its service. Outside CDATA,
 * `unescapeXml` decodes only `&lt;`, `&gt;`, `&quot;`, `&#39;` and `&amp;`;
 * any other reference stays as written, so a `Filtered` value written
 * `&#116;rue` would not exclude its service. The 42 saved answers use only
 * `&lt;` and `&amp;` outside CDATA. No saved answer starts with an XML
 * declaration, but XML allows one at the start, and refusing it would make
 * every answer an outage if Alma began to send one.
 */
function markupHolds(text: string) {
  const open: string[] = [];
  let services = 0;
  for (const { 0: tag, 1: closing, 2: name, 3: attributes, 4: closed, index } of text.matchAll(MARKUP)) {
    if (tag === '<' || (tag.startsWith('<?') && index !== 0)) return false;
    if (closing) {
      if (open.pop() !== closing) return false;
      if (closing === 'context_service') services -= 1;
      if (!open.length) return closing === 'uresolver_content' && !text.slice(index + tag.length).trim();
    } else if (name) {
      if (open.at(-1) === 'key' || (name === 'context_service' && (closed === '/' || services > 0))) return false;
      const unmatched = name === 'key' ? !/^ id="[^"]*"$/.test(attributes) : name === 'resolution_url' && attributes !== '';
      if (closed !== '/' && unmatched) return false;
      if (!closed) {
        open.push(name);
        if (name === 'context_service') services += 1;
      }
    }
  }
  return false;
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
  let text = String(xml);
  // The expressions below read keys and services, not a document tree, so
  // damaged markup misleads them: a single-service answer cut off before
  // its services would read as a refusal, and a `Filtered` key that never
  // closes would not be read, so a service Alma filtered out would count as
  // access. Only an answer whose markup holds is read. Validating the whole
  // answer as XML took about a millisecond per answer in Node, and one
  // services page reads up to 36 answers within the 10 ms CPU limit of
  // Workers Free; reading an answer with the tag check took about a sixth
  // of that time. Only one with a context object is an answer about the
  // journal at all. A library set to send readers straight to one service
  // answers with `available_services` = single_service and no indicator
  // (Harvard, Helsinki, Amsterdam, 2026-10-19); its services still carry
  // Alma's filter marks, so what is left unfiltered is the answer.
  if (!markupHolds(text)) return null;
  // CDATA is text, including when it contains something that looks like a
  // key or service. Escape it before the shared reader extracts any values.
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_section, value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  if (!/<context_object>/.test(text)) return null;
  const indicator = xmlKey(text, 'full_text_indicator');
  const matched = xmlKey(text, 'rft.mms_id') !== null;
  const services = [];
  let restricted = false;
  for (const [, attributes, body] of text.matchAll(/<context_service\b([^>]*)>([\s\S]*?)<\/context_service>/g)) {
    // The tag check let each attribute through after exactly one space, so
    // the space keeps `data-service_type="getFullTxt"` from matching.
    if (!/ service_type="getFullTxt"/.test(attributes)) continue;
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
const NOT_ENTITLED = Object.freeze({ status: 'not-entitled', collection: null, url: null });

// Unpaywall's `oa_status` for a version of record anyone can read at the
// publisher (in an open journal, openly licensed, or free to read there), and
// for one behind its paywall, where a repository copy (`green`) changes nothing.
const FREE_AT_PUBLISHER = new Set(['gold', 'hybrid', 'bronze']);
const PAYWALLED_AT_PUBLISHER = new Set(['green', 'closed']);

/**
 * Whether Unpaywall, the `/oa` route's source, says the article's version of
 * record is free at the publisher: true, false, or null when it has no record
 * of the DOI or does not say. Throws when Unpaywall did not answer.
 */
async function freeAtPublisher(doi: string, env: WorkerEnv, fetchImpl: typeof fetch, signal: AbortSignal) {
  let record: { oa_status?: unknown } | null;
  try {
    record = JSON.parse(await fetchText(unpaywallUrl(doi, env), { headers: { accept: 'application/json' } }, fetchImpl, signal));
  } catch (error) {
    if ((error as UpstreamError)?.status === 404) return null;
    throw error;
  }
  const status = String(record?.oa_status);
  if (FREE_AT_PUBLISHER.has(status)) return true;
  return PAYWALLED_AT_PUBLISHER.has(status) ? false : null;
}

/**
 * The parameters a lookup actually sends upstream, for the edge cache key:
 * the library asked (its institution code and the host it is asked on,
 * since every mail domain of a university reaches the same resolver, and a
 * regional host may answer for a code without the library's data, plus the
 * product when it is not Alma, since each is asked and read its own way, and
 * the login and the self-signing hosts its links are built with), or the
 * domain when there is none, and the institution ids only with a GetFTR key,
 * since only GetFTR gets them.
 */
export function upstreamParams(query: InstitutionQuery & { doi?: string | null }, env: WorkerEnv = {}) {
  const { doi = null, domain, entityId = null, rorId = null } = query;
  const getFtr = Boolean(env.GETFTR_API_KEY);
  const resolver = findResolver(query);
  return {
    ...(doi ? { doi } : {}),
    ...(resolver
      ? {
        library: resolver.institution,
        host: resolver.host,
        ...(resolver.product ? { product: resolver.product } : {}),
        ...(resolver.proxy ? { proxy: resolver.proxy } : {}),
        ...(resolver.signsIn ? { signsIn: resolver.signsIn.join(',') } : {}),
      }
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

  // An SFX menu has no free flag and lists an open article's own platform the
  // way it lists a subscription: TUM listed MDPI's for an Entropy article and
  // SpringerLink for a Scientific Reports one (2026-10-20). An article whose
  // version of record Crossref says is openly licensed, by the rule `/oa`
  // reads, is open access, so no SFX service for it is the library's
  // subscription. Alma marks its free services itself.
  if (resolver!.product === 'sfx' && openLicenseFromCrossref(work)) return NOT_ENTITLED;
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
      // Nor does a licence missing from Crossref make an SFX service the
      // library's: TUM listed MDPI's for Entropy 19(2):87, which Crossref
      // gives none (2026-10-20). It is the library's only for an article whose
      // published version Unpaywall has behind the publisher's paywall;
      // without Unpaywall's word, the answer stays unknown.
      if (resolver!.product === 'sfx') {
        let free;
        try {
          free = await freeAtPublisher(doi, env, fetchImpl, signal);
        } catch {
          throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
        }
        if (free === null) return UNKNOWN;
        if (free) return NOT_ENTITLED;
      }
      return { status: 'entitled', collection: best.name, url: libraryLink(resolver!, best.url!) };
    }
    // A service hidden by an IP or group filter may be the library's own
    // subscription: no answer, rather than a refusal.
    if (answer.restricted) continue;
    if (!answer.fullText) refusals += 1;
  }
  return issns.length && refusals === issns.length ? NOT_ENTITLED : UNKNOWN;
}
