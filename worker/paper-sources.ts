import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/open-alex-types.ts';
import type { WorkerEnv } from './env.ts';
import type { Harvested, StoreEnv } from './paper-store.ts';
import type { HarvestAsk } from './openalex-api.ts';
import type { UpstreamError } from './provider-runtime.ts';
import type { OpenAireProduct } from '../src/services/open-aire-records.ts';

import { XMLParser } from 'fast-xml-parser';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { ARXIV_FEED_AREAS, arxivPaper, isArxivCategory } from '../src/services/arxiv-records.ts';
import { pubmedCategoryQuery, readPubmedPayload } from '../src/services/adapters/pubmed-records.ts';
import { openAirePids, openAireProjectPublicationsUrl, readOpenAirePage } from '../src/services/open-aire-records.ts';
import {
  domainSourceRequests,
  getDomainSourcePlan,
  europePmcLabelQuery,
  getEligibleDomainSources,
  mapAdsPaper,
  mapBioRxivPaper,
  mapEuropePmcSearchResult,
} from '../src/services/domain-source-records.ts';
import { OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { openAlexNotableFilterForLeaf, openAlexTopicFilterForLeaf } from '../src/utils/area-accent.ts';
import { openAlexLabelFilterForArea } from '../src/data/open-alex-areas.ts';
import { OPENALEX_NOT_LISTED_SERIES_FILTER } from '../src/utils/publication-status.ts';
import { handleHarvestArxiv } from './arxiv-api.ts';
import { handleHarvestOpenAlex, handleOpenAlex } from './openalex-api.ts';
import { fetchAdsNotable, handlePhysicsLiterature } from './physics-api.ts';
import { SOURCE_MAX_PAGE, fetchJsonUpstream, fetchWithDeadline } from './provider-runtime.ts';
import { handleCore, handleEuropePmc, handleHuggingFacePapers, handleNasa, handleOpenReview, handleOsti, handlePubmed } from './source-api.ts';
import { AREA_LANE_AREAS, CORPUS_DAYS, FEED_CANDIDATE_LIMIT, NOTABLE_LANE_PREFIX, NOTABLE_YEARS, PaperStoreError, WORKING_PAPERS_LANE, areaLane, database, daysFromNow, findWorks, ingestPapers, keepLiked, publishedOf } from './paper-store.ts';
import { OPENALEX_LEAF_VENUES, OPENALEX_NOTABLE_VENUE_LEAVES } from './openalex-leaf-venues.generated.ts';
import { EUROPE_PMC_NOTABLE_LEAVES } from './europepmc-notable-leaves.generated.ts';
import { parseXmlDocument } from './xml-dom.ts';

// Every source the feed reads, asked once a day for what it added to each
// lane (a category, a followed entity, a series) since the last run, through
// the same Worker routes and the same request builders and mappers the
// browser used to call for every reader and page.

const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const text = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const day = (iso: string) => iso.slice(0, 10);

// ─── arXiv over OAI-PMH ───

const OAI_ENDPOINT = 'https://oaipmh.arxiv.org/oai';
const OAI_TIMEOUT_MS = 60_000;
// The arXiv areas the feed asks for (ARXIV_FEED_AREAS); `physics` covers its archives.
export const ARXIV_HARVEST_SETS = ['cs', 'math', 'physics', 'stat', 'eess', 'econ', 'q-fin'];

export interface ArxivRecord {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  doi: string | null;
  journalRef: string | null;
  comments: string | null;
  published: string;
  updated: string;
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  // Without it only XML's five named references are read; arXiv writes `&#39;`.
  htmlEntities: true,
  isArray: name => ['record', 'version', 'entry', 'author', 'category'].includes(name),
});

const optional = (value: unknown) => text(value) || null;
const isoDate = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};
const versionless = (value: unknown) => text(value).replace(/^.*\/abs\//, '').replace(/v\d+$/, '');

// arXivRaw writes names in TeX: Gon\c{c}alves, {\"O}zt{\"u}rk, \L{}ukasz. An
// accent command becomes its combining mark and a special letter its letter;
// braces that group letters go. A formula, and a command not converted here
// (`\textit{et al.}`), stay as written.
const TEX_ACCENTS: Record<string, string> = {
  '`': '\u0300', "'": '\u0301', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', '"': '\u0308',
  u: '\u0306', r: '\u030a', H: '\u030b', v: '\u030c', d: '\u0323', c: '\u0327', k: '\u0328', b: '\u0331',
};
const TEX_ACCENT = /\\(?:([`'^~=."])|([urHvdckb])(?![a-zA-Z]))\s*(?:\{\s*(\\[ij]|\p{L}\p{M}*)\s*\}|(\\[ij](?![a-zA-Z])|\p{L}\p{M}*))/gu;
const TEX_LETTERS: Record<string, string> = { i: 'ı', j: 'ȷ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ' };
// TeX would also take the space after `\l`, but names are written as read:
// "Pawe\l Kowalski" is two words.
const TEX_LETTER = /\\(ss|aa|AA|ae|AE|oe|OE|[ijoOlL])(?![a-zA-Z])(?:\{\})?/g;
const TEX_GROUP = /(?<!\\[a-zA-Z]+\s*)\{([^{}\\]*)\}/g;

function texNameText(value: string) {
  return value.split(/(\$[^$]*\$)/).map((part, index) => {
    if (index % 2) return part;
    // An accent over an accented letter, `\~{\^e}`, reads once the inner one
    // has. Each pass that changes the text removes a backslash or two braces.
    for (let previous = ''; part !== previous;) {
      previous = part;
      part = part
        .replace(TEX_ACCENT, (match, symbol, letter, braced, bare) => `${(braced || bare).replace('\\', '')}${TEX_ACCENTS[symbol || letter]}`)
        .replace(TEX_LETTER, (match, name) => TEX_LETTERS[name])
        .replace(TEX_GROUP, '$1');
    }
    return part;
  }).join('').normalize('NFC');
}

// arXivRaw lists authors as one string: "A, B (MIT) and C".
export function splitRawAuthors(value: unknown) {
  let names = text(value);
  while (/\([^()]*\)/.test(names)) names = names.replace(/\([^()]*\)/g, '');
  return texNameText(names).split(/,|\s+and\s+/).map(text).filter(Boolean);
}

/** The records of one OAI-PMH `ListRecords` page in arXivRaw, and the token for the next. */
export function parseOaiPage(xml: string) {
  const root = XML.parse(xml)?.['OAI-PMH'];
  const errorCode = root?.error?.['@_code'];
  if (errorCode === 'noRecordsMatch') return { papers: [], resumptionToken: '' };
  if (errorCode || !root?.ListRecords) throw new PaperStoreError('OAI_RESPONSE_INVALID', 502);
  const token = root.ListRecords.resumptionToken;
  const papers: ArxivRecord[] = [];
  for (const record of root.ListRecords.record || []) {
    const raw = record?.metadata?.arXivRaw;
    if (!raw || record.header?.['@_status'] === 'deleted') continue;
    const versions = (raw.version || []).map((version: { date?: unknown }) => isoDate(version?.date)).filter(Boolean);
    const paper = {
      arxivId: versionless(raw.id),
      title: text(raw.title),
      abstract: text(raw.abstract),
      authors: splitRawAuthors(raw.authors),
      categories: [...new Set(text(raw.categories).split(' ').filter(Boolean))],
      doi: optional(raw.doi),
      journalRef: optional(raw['journal-ref']),
      comments: optional(raw.comments),
      published: versions[0] || '',
      updated: versions.at(-1) || '',
    };
    if (paper.arxivId && paper.title && paper.abstract && paper.categories.length && paper.published) papers.push(paper);
  }
  return { papers, resumptionToken: text(typeof token === 'object' ? token?.['#text'] : token) };
}

interface AtomEntry {
  id?: unknown; title?: unknown; summary?: unknown; published?: unknown; updated?: unknown;
  doi?: unknown; journal_ref?: unknown; comment?: unknown;
  primary_category?: { '@_term'?: unknown };
  category?: Array<{ '@_term'?: unknown }>;
  author?: Array<{ name?: unknown }>;
}

/** Papers of an arXiv API Atom feed (a search or an `id_list` lookup). */
export function parseArxivAtom(xml: string) {
  const entries: AtomEntry[] = XML.parse(xml)?.feed?.entry || [];
  return entries.flatMap((entry): ArxivRecord[] => {
    const primary = text(entry.primary_category?.['@_term']);
    const categories = [...new Set([primary, ...(entry.category || []).map(category => text(category?.['@_term']))].filter(Boolean))];
    const paper = {
      arxivId: versionless(entry.id),
      title: text(entry.title),
      abstract: text(entry.summary),
      authors: (entry.author || []).map(author => text(author?.name)).filter(Boolean),
      categories,
      doi: optional(entry.doi),
      journalRef: optional(entry.journal_ref),
      comments: optional(entry.comment),
      published: isoDate(entry.published),
      updated: isoDate(entry.updated),
    };
    return paper.arxivId && paper.title && paper.abstract && categories.length && paper.published ? [paper] : [];
  });
}

/** An arXiv record as the paper the browser built from the same record. */
export function arxivRecordPaper(record: ArxivRecord): Paper {
  return arxivPaper({
    arxivId: record.arxivId,
    title: record.title,
    abstract: record.abstract,
    authors: record.authors,
    doi: record.doi || '',
    journalRef: record.journalRef || '',
    comment: record.comments || '',
    published: record.published,
    allCategories: record.categories,
    primaryCategory: record.categories[0],
  });
}

/**
 * One OAI-PMH page of an arXiv set, filed under its categories. Only papers
 * first submitted within CORPUS_DAYS are kept: the set also lists revisions of
 * old papers, and a new paper is announced days after its v1 date, so `from`
 * alone would drop it.
 */
export async function harvestArxivPage(env: StoreEnv, { set, from, resumptionToken }: { set: string; from: string; resumptionToken?: string }) {
  const url = new URL(OAI_ENDPOINT);
  url.searchParams.set('verb', 'ListRecords');
  if (resumptionToken) url.searchParams.set('resumptionToken', resumptionToken);
  else {
    url.searchParams.set('metadataPrefix', 'arXivRaw');
    url.searchParams.set('set', set);
    url.searchParams.set('from', from);
  }
  const response = await fetchWithDeadline(url, { headers: { 'user-agent': USER_AGENT } }, OAI_TIMEOUT_MS);
  if (response.status === 503) return { stored: 0, listed: 0, resumptionToken: resumptionToken || '', retryAfterSeconds: Number(response.headers.get('retry-after')) || 30 };
  if (!response.ok) throw new PaperStoreError(`OAI_HTTP_${response.status}`, 502);
  const page = parseOaiPage(await response.text());
  const since = daysFromNow(-CORPUS_DAYS);
  const recent = page.papers.filter(paper => paper.published >= since);
  const stored = await ingestPapers(env, recent.map(record => ({ paper: arxivRecordPaper(record), lanes: [] })));
  return { stored, listed: page.papers.length, resumptionToken: page.resumptionToken, retryAfterSeconds: 0 };
}

// ─── The other sources, by lane ───

type SourceEnv = StoreEnv & WorkerEnv;
type RouteHandler = (request: Request, env: WorkerEnv, identity?: null) => Promise<Response>;

/**
 * A route refused for now: its own minute ceiling, a pace beat, the day's
 * budget, or the quota ledger that keeps them, when it cannot answer.
 */
export class SourceRefused extends Error {
  retryAfterSeconds: number;
  constructor(path: string, retryAfterSeconds: number) {
    super(`${path} refused; retry in ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// A ledger that cannot answer, as a refusal longer than a lane waits out
// (LANE_WAIT_SECONDS): the relay refuses a spent day with the same 300.
const LEDGER_REFUSAL_SECONDS = 300;

// Asks a Worker route in-process, as the browser asked it over the network:
// the route's own validation, keys, cache, ceilings and deadlines apply.
async function askRoute(handler: RouteHandler, path: string, params: Record<string, string | number>, env: WorkerEnv) {
  const url = new URL(`https://papertok.internal${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const response = await handler(new Request(url), env, null);
  if (response.status === 429) throw new SourceRefused(path, Number(response.headers.get('retry-after')) || 60);
  // The route's ledger could not answer, so no provider was asked. Nothing
  // says when it is back: a refusal longer than a lane waits ends that lane.
  // Later lanes can ask the ledger; a followed lane keeps its turn
  // (paper-harvest.ts).
  if (response.status === 503) {
    const answer = await response.clone().json().catch(() => null) as { code?: unknown } | null;
    if (answer?.code === 'PROVIDER_QUOTA_NOT_CONFIGURED') throw new SourceRefused(path, LEDGER_REFUSAL_SECONDS);
  }
  if (!response.ok) throw answeredError(path, response.status);
  return response;
}

// The status travels on the error: a followed lane's harvest tells a request
// the provider rejected from a provider that failed (paper-harvest.ts).
function answeredError(name: string, status: number) {
  const error: UpstreamError = new Error(`${name} answered ${status}`);
  error.status = status;
  return error;
}

// A refusal that names a short wait is waited out, twice at most a page, and
// for LANE_WAIT_SECONDS at most a lane: one minute's ceiling (PubMed's, 60 s)
// and the pace beats around it. Two minutes a page would let a ten-page lane
// outlast the step it must finish in (paper-harvest.ts). A longer refusal
// (OpenAlex's spent day), or one past the lane's allowance, ends the lane for
// this run.
const LANE_WAIT_SECONDS = 90;

/** The seconds a lane may still spend waiting out refusals, shared by its pages. */
interface LaneWaits { seconds: number }

async function withShortWaits<T>(waits: LaneWaits, attempt: () => Promise<T>) {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SourceRefused) || error.retryAfterSeconds > waits.seconds || tries >= 2) throw error;
      waits.seconds -= error.retryAfterSeconds;
      await new Promise(resolve => setTimeout(resolve, error.retryAfterSeconds * 1000));
    }
  }
}

const LEAVES = getAllLeafCategories();
// The leaves the precision gate admitted to OpenAlex topic lanes.
const TOPIC_LEAVES = LEAVES.filter(leaf => openAlexTopicFilterForLeaf(leaf.id));
// The leaves with an OpenAlex notable lane: those, the leaves the notable
// sample admitted (ENG-129, part B), which get no topic lane, and the leaves
// the journal sample admitted (`openAlexNotableListingFilter`).
const NOTABLE_LEAVES = LEAVES.filter(leaf => openAlexNotableListingFilter(leaf.id, notableListedYear(1)) !== null);
// The leaves that are arXiv categories, whose notable lane also lists ADS's
// most-cited papers of the class (`ads-notable`). `isArxivCategory` matches a
// prefix, so it also takes the engineering leaves arXiv has no category for
// (eess.optics); these are arXiv's own codes.
const ARXIV_CODE = /^(?:(?:cs|math|eess|econ|q-fin|stat|q-bio|nlin|astro-ph)\.[A-Z]{2}|(?:cond-mat|physics)\.[a-z]+(?:-[a-z]+)*|astro-ph|cond-mat|gr-qc|hep-(?:ex|lat|ph|th)|nucl-(?:ex|th)|quant-ph|math-ph|nlin)$/;
const ADS_NOTABLE_LEAVES = LEAVES.filter(leaf => ARXIV_CODE.test(leaf.id));
// The medicine and biology leaves whose Europe PMC sample passed
// (scripts/README-europepmc-notable.md).
const EUROPE_PMC_LEAVES = LEAVES.filter(leaf => EUROPE_PMC_NOTABLE_LEAVES.includes(leaf.id));
// PubMed's records and the preprint servers' (not patents, theses or books),
// without retracted papers, which stay cited, retraction notices and errata,
// and, as the PubMed lane, editorials, letters and comments without an
// abstract: one with an abstract can be research.
const EUROPE_PMC_NOTABLE_RECORDS = '(SRC:MED OR SRC:PPR) NOT PUB_TYPE:"retracted publication" NOT PUB_TYPE:"retraction of publication" NOT PUB_TYPE:"published erratum" NOT ((PUB_TYPE:"editorial" OR PUB_TYPE:"letter" OR PUB_TYPE:"comment") AND HAS_ABSTRACT:n)';

// The engineering leaves arXiv has no category for, searched by label.
const ARXIV_LABEL_LEAVES = LEAVES.filter(leaf => ARXIV_FEED_AREAS.includes(leaf.area) && !isArxivCategory(leaf.id));
const PUBMED_LEAVES = LEAVES.filter(leaf => leaf.area === 'med' || leaf.area === 'bio');

// The series the feed shows for economics and finance, by OpenAlex source ID,
// each checked with a keyless OpenAlex request on 2026-10-19 (PAP-53). The
// review rule in publication-status.ts owns which sources are working-paper
// series; a test checks each ID here is on its list, or its articles would
// arrive as reviewed journal papers without the Working paper tag. OpenAlex
// types NBER, CESifo, Banco de España and the New York and Philadelphia Fed
// series as `report`, hence `type:article|report`. World Bank Policy Research
// Working Papers are not listed: OpenAlex files the recent ones under the
// bank's general eBooks source (S4306464317).
export const WORKING_PAPER_SERIES_IDS = [
  'S2809516038', // National Bureau of Economic Research
  'S4210171147', // IMF Working Papers
  'S7407053623', // CESifo Working Papers
  'S4393913881', // Banco de España, Documentos de Trabajo
  'S4393919745', // Federal Reserve Bank of New York, Staff Reports
  'S4306510381', // Federal Reserve Bank of San Francisco, Working Paper Series
  'S4210230366', // Federal Reserve Bank of Philadelphia, Working Papers
  'S4210212089', // Federal Reserve Board, Finance and Economics Discussion Series
];

// Subfields an area lane leaves out although the area's label covers them,
// because the area's arXiv readers do not read them: Biomedical Engineering
// was 60 of electrical engineering's 200 newest articles on 2026-10-23,
// sensor materials, biomass conversion and tissue scaffolds among them.
const AREA_LANE_LEFT_OUT: Readonly<Record<string, readonly string[]>> = { eess: ['2204'] };

/**
 * The works filter of a leaf's venue lane (PAP-104): the OpenAlex sources its
 * labelled sample found on target, sorted, and the types and topic or author
 * filter the sample asked with. Null when the leaf has no venue lane.
 */
export function openAlexVenueFilterForLeaf(leaf: string) {
  if (!Object.hasOwn(OPENALEX_LEAF_VENUES, leaf)) return null;
  const { sources, filters } = OPENALEX_LEAF_VENUES[leaf];
  return [`primary_location.source.id:${sources.join('|')}`, ...filters].join(',');
}

/**
 * The works filter of one year of a leaf's OpenAlex notable lane: the articles
 * of its topics from core sources (`openAlexNotableFilterForLeaf`), or, once
 * its journal sample passed, the articles of its venue lane's journals. Those
 * passed the venue gate already, and the core-source filter would drop the
 * reviewed ones OpenAlex does not call core (ICPP in cs.DC, ACM TOIS in
 * cs.IR). Null when no sample admitted the leaf.
 */
export function openAlexNotableListingFilter(leaf: string, year: number) {
  const window = [`from_publication_date:${year}-01-01`, `to_publication_date:${year}-12-31`, 'is_retracted:false'];
  const topics = openAlexNotableFilterForLeaf(leaf);
  if (topics) return [topics, ...window, 'primary_location.source.is_core:true'].join(',');
  return OPENALEX_NOTABLE_VENUE_LEAVES.includes(leaf) ? [openAlexVenueFilterForLeaf(leaf), ...window].join(',') : null;
}

export type SourceName =
  | 'arxiv-search' | 'pubmed' | 'openalex-topics' | 'openalex-venues' | 'openalex-notable' | 'openalex-areas' | 'openalex-series'
  | 'openalex-follows' | 'openaire' | 'biorxiv' | 'europepmc' | 'core' | 'osti' | 'nasa' | 'physics' | 'openreview' | 'huggingface'
  | 'ads-notable' | 'europepmc-notable';

// `newFollow`: a lane harvested by the run a new follow started (paper-feed.ts).
export interface LaneJob { source: SourceName; lane: string; newFollow?: boolean }

interface PageRequest { lane: string; page: number; since: string; waits: LaneWaits; newFollow?: boolean; until?: string }
interface SourcePage { items: Harvested[]; newest: string; full: boolean }
interface SourceSpec {
  // Pages on a lane's first run, and on later ones (a later run also stops
  // once a page reaches what the previous run had).
  firstPages: number;
  dailyPages: number;
  // Whether pages come newest first, so a later run can stop early.
  dated: boolean;
  // Days re-read before the last run: sources that list papers days after
  // their date (OpenAlex's indexing) need more.
  overlapDays: number;
  // Lanes whose papers stay whatever their date, while the source still lists
  // them: a followed entity's, and the specialist sources', whose first pages
  // the feed showed as they came (NASA's reports, CORE's repositories).
  keepsOld?: boolean;
  // Each page is a listing of its own, such as one year; a short page does not
  // end the lane.
  separateListings?: boolean;
  // Lanes whose listing is OpenAlex's current record of each paper it returns
  // (the notable lanes' weekly one): it brings their counts, so the
  // enrichment's refresh (paper-enrichment.ts REFRESH_DAYS) passes over the
  // papers a run filed, which a notable lane's rows record (`listed_until`).
  renewsEnrichment?: boolean;
  // A pause before each request, for a source that limits its pace rather
  // than its day (CORE allows a few requests every ten seconds).
  gapMs?: number;
  // Pages a run reads further back, for a source whose daily pages hold days
  // of the corpus window rather than all of it (backfillLane).
  backfillPages?: number;
  fetchPage: (env: SourceEnv, request: PageRequest) => Promise<SourcePage>;
}

// A page's newest date says whether the source has gone past the last run:
// its oldest says little where the order is the date a record was added
// (PubMed lists a paper printed last year beside this week's).
function pageOf(items: Harvested[], size: number): SourcePage {
  const dates = items.map(item => publishedOf(item.paper)).filter(Boolean).sort();
  return { items, newest: dates.at(-1) || '', full: items.length >= size };
}

const filed = (papers: Array<Partial<Paper> | null>, lane: string) => (papers.filter(Boolean) as Partial<Paper>[]).map(paper => ({ paper, lanes: [lane] }));

async function arxivSearch(env: SourceEnv, query: string, { page, lane, waits }: PageRequest) {
  const size = 50;
  const response = await withShortWaits(waits, () => askRoute(handleHarvestArxiv, '/arxiv', {
    search_query: query, start: (page - 1) * size, max_results: size, sortBy: 'submittedDate', sortOrder: 'descending',
  }, env));
  return pageOf(filed(parseArxivAtom(await response.text()).map(arxivRecordPaper), lane), size);
}

const quotedLabel = (leafId: string) => LEAVES.find(leaf => leaf.id === leafId)?.label || leafId.replace(/\./g, ' ');

// What the harvest's lanes spend of its own share of OpenAlex's day
// (`OPENALEX_HARVEST_DAILY_UNITS`, 4,000 units). The runs new follows start
// spend from 00:00 UTC and at any hour after, so they have 300 of it as a
// share of their own, which nothing in the nightly run spends
// (provider-runtime.ts). The nightly run has the other 3,700: a billed miss
// reserves that share and its lane's part in one ledger transaction, with the
// day's ceiling; enrichment spends the share alone. A spent share or part is
// a refusal that ends the current lane. Readers choose how many
// followed lanes there are, and 400 followed searches spent the whole share
// before a paper was enriched, so the nightly refresh of followed lanes has a
// part of 700. Category and notable lanes run before it every night, so they
// stop at 3,000 and leave it its 700; enrichment runs last and spends what is
// left.
type HarvestPart = 'categories' | 'nightly' | 'new';
const HARVEST_OPENALEX_PARTS: Record<HarvestPart, HarvestAsk> = {
  categories: { part: { subject: 'openalex:harvest:categories', limit: 3_000 } },
  nightly: { part: { subject: 'openalex:harvest:follows', limit: 700 } },
  new: { newFollow: true },
};

async function openAlexWorks(env: SourceEnv, filter: string, { page, perPage, search = '', sort = 'publication_date:desc', part }: {
  page: number; perPage: number; search?: string; sort?: string; part: HarvestPart;
}) {
  const params: Record<string, string | number> = {
    filter, sort, page, 'per-page': perPage, select: OPENALEX_WORK_SEARCH_FIELDS.join(','),
  };
  if (search) params.search = search;
  const harvest = (request: Request, routeEnv: WorkerEnv) => handleHarvestOpenAlex(request, routeEnv, HARVEST_OPENALEX_PARTS[part]);
  const response = await askRoute(harvest, '/openalex/works', params, env);
  return (await response.json<{ results?: OpenAlexWork[] }>()).results || [];
}

const windowFilter = (now = Date.now()) => `from_publication_date:${day(daysFromNow(-CORPUS_DAYS, now))},to_publication_date:${day(new Date(now).toISOString())}`;

async function openAlexLane(env: SourceEnv, filter: string, { page, lane, perPage, search = '', sort, part, map = (work: OpenAlexWork) => mapOpenAlexWork(work) }: {
  page: number; lane: string; perPage: number; search?: string; sort?: string; part: HarvestPart; map?: (work: OpenAlexWork) => Partial<Paper> | null;
}) {
  const works = await openAlexWorks(env, filter, { page, perPage, search, sort, part });
  return pageOf(filed(works.map(map), lane), perPage);
}

// Notable papers (Pablo, 2026-10-23; ENG-129): each admitted leaf's 100
// most-cited articles of each of the NOTABLE_YEARS completed years before the
// current UTC year, asked once a week, one list call a year, reserved from the
// harvest's OpenAlex share. The current year is left out: its papers are the
// 90-day lanes' too, `rankCandidates` (paper-store.ts) takes a notable lane's
// papers out of the regular ranks, and a reader without likes would be offered
// this year's notable cards first.
export const NOTABLE_PER_YEAR = 100;
const NOTABLE_LANE_DAYS = 7;
export const NOTABLE_LANES_PER_NIGHT = 8;

/**
 * How many due notable lanes a night re-lists: NOTABLE_LANES_PER_NIGHT, or a
 * seventh of the lanes when there are more than 56, so that every lane is
 * still re-listed about weekly and its papers' 14-day listing (KEPT_LISTING_DAYS)
 * never lapses while the lane waits its turn: the oldest harvest goes first,
 * so no lane waits more than six nights past its due date. The 39 lanes of the
 * first by-year night all listed in one run without reaching the CPU limit
 * (ENG-129, the run of 2026-10-25: 23 to 45 s wall-clock a lane step).
 */
export function notableLanesPerNight(laneCount: number) {
  return Math.max(NOTABLE_LANES_PER_NIGHT, Math.ceil(laneCount / NOTABLE_LANE_DAYS));
}

/** The year a notable lane's page lists: page 1 is the oldest of the NOTABLE_YEARS, page NOTABLE_YEARS the last completed one. */
export function notableListedYear(page: number, now = Date.now()): number {
  return new Date(now).getUTCFullYear() - NOTABLE_YEARS - 1 + page;
}

// Followed OpenAlex entities, by the filter that names their works.
const FOLLOW_FILTERS: Record<string, string> = { author: 'author.id', institution: 'institutions.id', topic: 'topics.id', concept: 'concepts.id', source: 'primary_location.source.id' };

async function openAireProjectDois(lane: string) {
  // An OpenAIRE project id holds `::` itself; a funder, when stored, comes first.
  const rest = lane.slice('project:'.length);
  const bar = rest.indexOf('|');
  const [funder, project] = bar >= 0 ? [rest.slice(0, bar), rest.slice(bar + 1)] : ['', rest];
  const url = openAireProjectPublicationsUrl(project, { funder, pageSize: 30 });
  const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 10_000);
  if (!response.ok) throw answeredError('OpenAIRE', response.status);
  const { results } = readOpenAirePage<OpenAireProduct>(await response.json());
  return results.flatMap(row => openAirePids(row, 'doi'))
    .map(doi => doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase())
    .filter(doi => /^10\.\d{4,9}\/[^,|]+$/.test(doi))
    .slice(0, 30);
}

const BIORXIV_PAGE = 30;

async function bioRxivPage(env: SourceEnv, { lane, page, since }: PageRequest) {
  const plan = getDomainSourcePlan([lane]);
  const url = `https://api.biorxiv.org/details/biorxiv/${day(since)}/${day(new Date().toISOString())}/${(page - 1) * BIORXIV_PAGE}/json?category=${encodeURIComponent(plan.biorxivCategory.replace(/\s+/g, '_'))}`;
  const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 20_000);
  if (!response.ok) throw new Error(`bioRxiv answered ${response.status}`);
  const { collection = [] } = await response.json<{ collection?: Parameters<typeof mapBioRxivPaper>[0][] }>();
  return pageOf(filed(collection.map(record => mapBioRxivPaper(record, [lane])), lane), BIORXIV_PAGE);
}

const DOMAIN_ROUTES: Record<string, RouteHandler> = {
  europepmc: handleEuropePmc,
  core: handleCore,
  osti: handleOsti,
  nasa: handleNasa,
  physics: handlePhysicsLiterature,
  openreview: handleOpenReview,
  huggingface: handleHuggingFacePapers,
};

// The page of one specialist source the browser asked for the same category.
function domainSource(source: string, perPage: number): SourceSpec['fetchPage'] {
  return async (env, { lane, page, waits }) => {
    const plan = getDomainSourcePlan([lane]);
    const eligible = getEligibleDomainSources(plan, { hasSession: true, scopusEnabled: false });
    const request = domainSourceRequests(plan, eligible, page, perPage, 'recent').find(candidate => candidate.source === source);
    if (!request) return { items: [], newest: '', full: false };
    const response = await withShortWaits(waits, () => askRoute(DOMAIN_ROUTES[source], request.path, request.params, env));
    return pageOf(filed(request.read(await response.json()), lane), Math.min(Number(request.params.limit) || perPage, perPage));
  };
}

export const SOURCES: Record<SourceName, SourceSpec> = {
  'arxiv-search': {
    firstPages: 4, dailyPages: 4, dated: true, overlapDays: 3, keepsOld: true,
    fetchPage: (env, request) => (request.lane.startsWith('author-name:')
      ? arxivSearch(env, `au:"${request.lane.slice('author-name:'.length).replace(/"/g, '')}"`, request)
      : arxivSearch(env, `all:"${quotedLabel(request.lane)}"`, request)),
  },
  pubmed: {
    // 2026-10-24: 40 pages went back 3 days for oncology and 4 years for zoology,
    // and two of nine 40-page steps ran out of the Worker's 30 s of CPU.
    firstPages: 10, dailyPages: 10, backfillPages: 5, dated: true, overlapDays: 3,
    fetchPage: async (env, { lane, page, waits, until }) => {
      // Newest added first; a backfill reads only what was added by its first day.
      const added = until ? ` AND 1800/01/01:${until.replace(/-/g, '/')}[edat]` : '';
      // With or without an abstract (ENG-129). PubMed lists editorials, letters
      // and comments as journal records; one with an abstract was always
      // admitted, as a letter, and one without is left out here. esearch has
      // no unary NOT (it drops the operator and warns), so the exclusion is a
      // binary NOT. The other non-research types (errata, retraction notices,
      // news, obituaries and the like) are dropped at ingestion by the type
      // `PUBTYPE_MAP` gives them.
      const response = await withShortWaits(waits, () => askRoute(handlePubmed, '/sources/pubmed', {
        q: `(${pubmedCategoryQuery([lane])}) NOT ((editorial[pt] OR letter[pt] OR comment[pt]) NOT hasabstract)${added}`,
        page, limit: 50,
      }, env));
      const payload = await response.json<Parameters<typeof readPubmedPayload>[0]>();
      const papers = readPubmedPayload(payload, { internalCategories: [lane], parseXml: parseXmlDocument });
      // Full by esearch's count: the category check drops papers off a page.
      return { ...pageOf(filed(papers, lane), 50), full: (payload?.esearchresult?.idlist?.length || 0) >= 50 };
    },
  },
  'openalex-topics': {
    firstPages: 5, dailyPages: 5, dated: true, overlapDays: 14,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      openAlexTopicFilterForLeaf(lane),
      windowFilter(),
      'is_retracted:false',
      'primary_location.source.is_core:true',
    ].join(','), { page, lane, perPage: 200, part: 'categories' }),
  },
  // The newest articles of the journals, and in computer science, statistics
  // and electrical engineering the proceedings, whose labelled sample stood
  // for a leaf (PAP-104), filed under the leaf as a topic lane's are. One
  // request a page names all the lane's sources. With or without an abstract,
  // as the area lanes take them; the sources are named, so neither `is_core`
  // nor the listed series' filter applies. In the 90 days to 2026-10-23 the
  // lanes' sources published 0.2 (stat.ML) to 22 (mech.thermo) articles a day.
  // OpenAlex dates every Physics of Fluids article of a month's issue, about
  // 390, by the issue's first day and lists a tied date oldest record first,
  // so one indexed late in the month comes after the rest of its issue. From
  // about the 16th, stopping at a page older than the last run would never
  // reach it, so a lane reads its pages whatever their dates: three a night
  // keep a whole issue.
  'openalex-venues': {
    firstPages: 5, dailyPages: 3, dated: false, overlapDays: 0,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      openAlexVenueFilterForLeaf(lane),
      windowFilter(),
      'is_retracted:false',
    ].join(','), { page, lane, perPage: 200, part: 'categories' }),
  },
  // Kept whatever their age (`keepsOld`): each week's listing renews them
  // before KEPT_LISTING_DAYS run out. One that drops out of the list leaves the
  // lane when they do, even when a like or its date keeps it in the corpus
  // (paper-store.ts `evictExpired`).
  'openalex-notable': {
    firstPages: NOTABLE_YEARS, dailyPages: NOTABLE_YEARS, dated: false, overlapDays: 0, keepsOld: true, renewsEnrichment: true, separateListings: true,
    // The lane's page picks the year; OpenAlex is asked the first page of it.
    fetchPage: async (env, { lane, page }) => {
      // A job saved by an earlier deployment can name a leaf this one no longer
      // admits; without a filter OpenAlex would list its most-cited works of all.
      const filter = openAlexNotableListingFilter(lane.slice(NOTABLE_LANE_PREFIX.length), notableListedYear(page));
      if (!filter) throw new Error(`${lane} has no notable listing`);
      return openAlexLane(env, filter, { page: 1, lane, perPage: NOTABLE_PER_YEAR, sort: 'cited_by_count:desc', part: 'categories' });
    },
  },
  // The arXiv side of an arXiv category's notable lane: ADS's 100 most-cited
  // papers of the class in each of the ten completed years, preprints and
  // published versions alike, filed under the same lane and kept as
  // OpenAlex's are. Its listing does not renew the enrichment
  // (`renewsEnrichment`), so the 14-day refresh asks OpenAlex for a paper only
  // ADS lists; a paper both list shows the higher count, as for any two
  // sources (`PaperBuilder.merge`).
  'ads-notable': {
    firstPages: NOTABLE_YEARS, dailyPages: NOTABLE_YEARS, dated: false, overlapDays: 0, keepsOld: true, separateListings: true,
    fetchPage: async (env, { lane, page }) => {
      // The physics route answers from INSPIRE without it; this listing has no other source.
      if (!env.NASA_ADS_API_TOKEN) throw new Error('The ADS notable listing needs NASA_ADS_API_TOKEN');
      const leaf = lane.slice(NOTABLE_LANE_PREFIX.length);
      let docs: unknown[];
      try {
        ({ docs } = await fetchAdsNotable(env, leaf, notableListedYear(page), NOTABLE_PER_YEAR));
      } catch (error) {
        // ADS answers a spent day with 429; the lane waits for the next night.
        // Any other failure, a rejected token among them, stays an error.
        if ((error as UpstreamError).status === 429) throw new SourceRefused('ads', LEDGER_REFUSAL_SECONDS);
        throw error;
      }
      return pageOf(filed(docs.map(doc => mapAdsPaper(doc as Parameters<typeof mapAdsPaper>[0], [leaf])), lane), NOTABLE_PER_YEAR);
    },
  },
  // The medicine and biology side of a notable lane: Europe PMC's 100
  // most-cited records of each of the ten years whose title, abstract or
  // keywords name the leaf, PubMed's articles and the preprint servers' alike,
  // filed and kept as OpenAlex's are. Europe PMC's counts are not OpenAlex's
  // either, so the listing does not renew the enrichment.
  'europepmc-notable': {
    firstPages: NOTABLE_YEARS, dailyPages: NOTABLE_YEARS, dated: false, overlapDays: 0, keepsOld: true, separateListings: true,
    fetchPage: async (env, { lane, page }) => {
      const leaf = lane.slice(NOTABLE_LANE_PREFIX.length);
      const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
      // By first publication, the date the store files and reads the paper by
      // (`published`); the issue year can be the next one.
      const year = notableListedYear(page);
      url.searchParams.set('query', `${europePmcLabelQuery([leaf])} AND FIRST_PDATE:[${year}-01-01 TO ${year}-12-31] AND ${EUROPE_PMC_NOTABLE_RECORDS} sort_cited:y`);
      url.searchParams.set('format', 'json');
      url.searchParams.set('resultType', 'core');
      url.searchParams.set('pageSize', String(NOTABLE_PER_YEAR));
      // A core page of 100 is about 1.4 MB: the enrichment's deadline, not a reader's.
      const data = await fetchJsonUpstream<{ resultList?: { result?: Array<Parameters<typeof mapEuropePmcSearchResult>[0]> } }>(url, {}, 15_000);
      return pageOf(filed((data.resultList?.result || []).map(record => mapEuropePmcSearchResult(record, [leaf])), lane), NOTABLE_PER_YEAR);
    },
  },
  // The newest journal articles of a whole area, filed under the area. On
  // 2026-10-23 a page of 200 with an abstract held the last one or two days of
  // each area but finance's nine: about 22 (finance) to 370 (electrical
  // engineering) a day. In the 90 days before, 23 % (statistics, economics) to
  // 39 % (mechanical engineering) of the articles had none. So a night reads
  // one page, the newest 200: one list call an area. The area lanes take an
  // article without an abstract (PAP-107), as the topic and notable lanes do
  // (ENG-129); its card says it has none. OpenAlex lists IMF, Federal Reserve
  // Board and Fed bank working papers as core journal articles; their cards
  // say Working paper, so the lane leaves out the review rule's series.
  'openalex-areas': {
    firstPages: 2, dailyPages: 1, dated: true, overlapDays: 14,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      openAlexLabelFilterForArea(lane.slice('area:'.length)),
      ...(AREA_LANE_LEFT_OUT[lane.slice('area:'.length)] || []).map(id => `primary_topic.subfield.id:!${id}`),
      windowFilter(),
      'type:article',
      'is_retracted:false',
      'primary_location.source.is_core:true',
      OPENALEX_NOT_LISTED_SERIES_FILTER,
    ].join(','), { page, lane, perPage: 200, part: 'categories' }),
  },
  'openalex-series': {
    firstPages: 4, dailyPages: 2, dated: true, overlapDays: 14,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      `primary_location.source.id:${WORKING_PAPER_SERIES_IDS.join('|')}`,
      // The window also held one dataset.
      'type:article|report',
      windowFilter(),
    ].join(','), {
      page, lane, perPage: 200, part: 'categories',
      // The area's own key, which the label and accent lookups read as
      // Economics: the series say a paper is economics, not which branch.
      map: work => {
        const paper = mapOpenAlexWork(work);
        return paper ? { ...paper, primaryCategory: 'econ' } : null;
      },
    }),
  },
  'openalex-follows': {
    firstPages: 2, dailyPages: 1, dated: true, overlapDays: 14, keepsOld: true,
    fetchPage: (env, { lane, page, newFollow }) => {
      const [kind, value] = [lane.slice(0, lane.indexOf(':')), lane.slice(lane.indexOf(':') + 1)];
      const part = newFollow ? 'new' : 'nightly';
      if (kind === 'query') return openAlexLane(env, `${windowFilter()},is_retracted:false`, { page, lane, perPage: 50, search: value, part });
      // None dated after today, which would sort first.
      const until = `to_publication_date:${day(new Date().toISOString())}`;
      // A followed journal (ENG-123, D4): its articles, without its errata and
      // paratext, 100 a page for the same list call. In the 90 days to
      // 2026-10-25 PLOS ONE published 39 articles a day and Nature 12.
      if (kind === 'source') return openAlexLane(env, `${FOLLOW_FILTERS.source}:${value},type:article,${until}`, { page, lane, perPage: 100, part });
      return openAlexLane(env, `${FOLLOW_FILTERS[kind]}:${value},${until}`, { page, lane, perPage: 50, part });
    },
  },
  openaire: {
    firstPages: 1, dailyPages: 1, dated: false, overlapDays: 0, keepsOld: true,
    fetchPage: async (env, { lane, newFollow }) => {
      const dois = await openAireProjectDois(lane);
      if (!dois.length) return { items: [], newest: '', full: false };
      return openAlexLane(env, `doi:${dois.join('|')}`, { page: 1, lane, perPage: 50, part: newFollow ? 'new' : 'nightly' });
    },
  },
  biorxiv: { firstPages: 20, dailyPages: 20, dated: false, overlapDays: 2, fetchPage: bioRxivPage },
  europepmc: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, keepsOld: true, fetchPage: domainSource('europepmc', 10) },
  core: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, keepsOld: true, gapMs: 3_000, fetchPage: domainSource('core', 10) },
  osti: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, keepsOld: true, fetchPage: domainSource('osti', 6) },
  nasa: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, keepsOld: true, fetchPage: domainSource('nasa', 6) },
  physics: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, keepsOld: true, fetchPage: domainSource('physics', 10) },
  openreview: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, keepsOld: true, fetchPage: domainSource('openreview', 10) },
  huggingface: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, keepsOld: true, fetchPage: domainSource('huggingface', 10) },
};

/** Every lane a source serves whatever readers follow: the app's categories it answers. */
export function categoryLaneJobs(): LaneJob[] {
  const jobs: LaneJob[] = [
    ...ARXIV_LABEL_LEAVES.map(leaf => ({ source: 'arxiv-search' as const, lane: leaf.id })),
    ...PUBMED_LEAVES.map(leaf => ({ source: 'pubmed' as const, lane: leaf.id })),
    ...TOPIC_LEAVES.map(leaf => ({ source: 'openalex-topics' as const, lane: leaf.id })),
    // Before the series: a journal article and its working paper listed the
    // same night merge into the journal's reviewed row, where the working
    // paper's row, stored first, would keep its own identity (PaperBuilder.merge).
    ...LEAVES.filter(leaf => openAlexVenueFilterForLeaf(leaf.id)).map(leaf => ({ source: 'openalex-venues' as const, lane: leaf.id })),
    { source: 'openalex-series', lane: WORKING_PAPERS_LANE },
    ...AREA_LANE_AREAS.map(area => ({ source: 'openalex-areas' as const, lane: areaLane(area) })),
  ];
  for (const leaf of LEAVES) {
    const plan = getDomainSourcePlan([leaf.id]);
    const eligible = getEligibleDomainSources(plan, { hasSession: true, scopusEnabled: false });
    if (eligible.biorxiv) jobs.push({ source: 'biorxiv', lane: leaf.id });
    for (const request of domainSourceRequests(plan, eligible, 1, 10, 'recent')) {
      if (request.source !== 'biorxiv') jobs.push({ source: request.source, lane: leaf.id });
    }
  }
  return jobs;
}

/**
 * The notable jobs a night lists: OpenAlex's listing of each leaf with a topic
 * lane or admitted by the topic or journal notable sample (`NOTABLE_LEAVES`),
 * ADS's of each arXiv category (`ADS_NOTABLE_LEAVES`), and Europe PMC's of
 * each medicine and biology leaf its sample admitted. Every job never
 * harvested, by source and lane id, then each source's at most
 * `notableLanesPerNight` of its own jobs not harvested in the last
 * NOTABLE_LANE_DAYS days, the oldest harvest first.
 * Every new job runs at once so that a lane's first listing does not wait
 * behind others' (the first cycle fills in one night). Re-listings are capped
 * because a lane re-ingests up to 1,000 rows a step and CPU accumulates across
 * an invocation (`wrangler.toml` `[limits]`). Counted in UTC days, so a lane
 * is due a week on even when this run reaches it earlier in the night than
 * last week's.
 */
export async function notableLaneJobs(db: D1Database, now = Date.now()): Promise<LaneJob[]> {
  const { results } = await db.prepare("SELECT source, lane, harvested_through FROM lane_state WHERE source IN ('openalex-notable', 'ads-notable', 'europepmc-notable')")
    .all<{ source: string; lane: string; harvested_through: string }>();
  const key = (job: LaneJob) => `${job.source} ${job.lane}`;
  const harvested = new Map(results.map(row => [`${row.source} ${row.lane}`, row.harvested_through]));
  const dueBefore = day(daysFromNow(1 - NOTABLE_LANE_DAYS, now));
  const lanesOf = (leaves: typeof LEAVES) => leaves.map(leaf => `${NOTABLE_LANE_PREFIX}${leaf.id}`).sort();
  const jobs: LaneJob[] = [
    ...lanesOf(NOTABLE_LEAVES).map(lane => ({ source: 'openalex-notable' as const, lane })),
    ...lanesOf(ADS_NOTABLE_LEAVES).map(lane => ({ source: 'ads-notable' as const, lane })),
    ...lanesOf(EUROPE_PMC_LEAVES).map(lane => ({ source: 'europepmc-notable' as const, lane })),
  ];
  const byThrough = (a: { through: string }, b: { through: string }) => (a.through < b.through ? -1 : a.through > b.through ? 1 : 0);
  const due = jobs.flatMap(job => {
    const through = harvested.get(key(job));
    return through !== undefined && through < dueBefore ? [{ job, through }] : [];
  }).sort(byThrough);
  // Each source has its own share, so a source whose listings keep failing
  // (its jobs stay due, the oldest) does not hold back another's re-listings.
  const shares = [...new Set(jobs.map(job => job.source))].flatMap(source => due.filter(({ job }) => job.source === source)
    .slice(0, notableLanesPerNight(jobs.filter(job => job.source === source).length)));
  return [...jobs.filter(job => !harvested.has(key(job))), ...shares.sort(byThrough).map(({ job }) => job)];
}

// The source that serves each kind of followed lane (`followLane` in src/utils/follow-lanes.ts).
const FOLLOWED_LANE_SOURCES: Array<[RegExp, SourceName]> = [
  [/^author-name:/, 'arxiv-search'],
  [/^project:/, 'openaire'],
  [/^(author|institution|topic|concept|source|query):/, 'openalex-follows'],
];

/** The sources followed lanes are harvested from, as `lane_state` names them. */
export const FOLLOWED_SOURCES = [...new Set(FOLLOWED_LANE_SOURCES.map(([, source]) => source))];

/** The source that serves a followed lane. */
export function followedLaneJob(lane: string): LaneJob | null {
  const source = FOLLOWED_LANE_SOURCES.find(([kind]) => kind.test(lane))?.[1];
  return source ? { source, lane } : null;
}

// How long a paper a lane kept whatever its date stays once its source no
// longer lists it on the pages the harvest reads.
const KEPT_LISTING_DAYS = 14;

/**
 * Harvests one lane of one source: pages until the source has nothing newer
 * than the last run reached, or the run's page allowance. Records the lane's
 * progress only once it completes.
 */
export async function harvestLane(env: SourceEnv, { source, lane, newFollow }: LaneJob, now = Date.now()) {
  const spec = SOURCES[source];
  const db = env.PAPER_STORE!;
  const state = await db.prepare('SELECT harvested_through FROM lane_state WHERE source = ? AND lane = ?').bind(source, lane)
    .first<{ harvested_through: string }>();
  const reached = state?.harvested_through || '';
  const since = reached ? daysFromNow(-spec.overlapDays, Date.parse(reached)) : daysFromNow(-CORPUS_DAYS, now);
  const keepUntil = spec.keepsOld ? daysFromNow(KEPT_LISTING_DAYS, now) : '';
  let stored = 0;
  const pages = reached ? spec.dailyPages : spec.firstPages;
  const waits = { seconds: LANE_WAIT_SECONDS };
  for (let page = 1; page <= pages; page += 1) {
    if (spec.gapMs) await new Promise(resolve => setTimeout(resolve, spec.gapMs));
    const result = await spec.fetchPage(env, { lane, page, since, waits, newFollow });
    stored += await ingestPapers(env, result.items, { keepUntil, now });
    if (!spec.separateListings && (!result.full || (spec.dated && result.newest && result.newest < since))) break;
  }
  // Only the papers this run's pages filed in the lane carry OpenAlex's counts
  // of today: their lane rows hold this run's keeping date (paper-store.ts
  // `listed_until`), under the work each was filed or merged into. A record
  // ingestPapers turned away (a placeholder title, a type the feed does not
  // show) filed nothing, and one the listing no longer returns keeps its
  // enrichment date however long the corpus keeps it (a recent paper, a liked
  // one), so the refresh still comes for both. One never enriched still gets
  // its first enrichment, which also asks Crossref its type. The listing does
  // not renew a paper without an abstract either (the placeholder is shorter
  // than the 40 characters of `isPlausibleAbstract`): the refresh is what asks
  // for its abstract again, at about one OpenAlex refresh call per 50 such
  // papers every 14 days.
  if (spec.renewsEnrichment) {
    await db.prepare(`UPDATE works SET enriched_at = ? WHERE enriched_at IS NOT NULL AND enrich_misses = 0
      AND LENGTH(COALESCE(paper ->> '$.abstract', '')) >= 40
      AND id IN (SELECT work_id FROM work_lanes WHERE lane = ? AND listed_until >= ?)`).bind(new Date(now).toISOString(), lane, keepUntil).run();
  }
  await db.prepare(`INSERT INTO lane_state (source, lane, harvested_through) VALUES (?, ?, ?)
    ON CONFLICT (source, lane) DO UPDATE SET harvested_through = excluded.harvested_through`).bind(source, lane, new Date(now).toISOString()).run();
  return stored;
}

// Between backfill pages: about 25 a minute, within PubMed's shared ceiling of
// 60 route misses (provider-runtime.ts) with room for readers and daily pages.
const BACKFILL_GAP_MS = 1_500;

/**
 * Reads a lane further back than its daily pages, up to backfillPages a step,
 * from the page the last step stopped at, saved after each page. The listing
 * ends at the day the backfill began, so new records do not move its pages.
 * It is done at the end of the listing or the corpus window or the route's
 * last page, or once the lane holds as many papers as the feed reads, beyond
 * which eviction drops the older ones. Its pages wait out short refusals as a
 * lane's daily pages do, within LANE_WAIT_SECONDS a step. A refusal past that,
 * a quota ledger that cannot answer, or a page that fails ends the step there;
 * the lane's next step or run goes on from the saved page. A lane whose daily
 * harvest has not run yet waits for it.
 */
export async function backfillLane(env: SourceEnv, { source, lane }: LaneJob, now = Date.now()) {
  const spec = SOURCES[source];
  const db = env.PAPER_STORE!;
  const state = await db.prepare('SELECT backfill_until, backfill_page FROM lane_state WHERE source = ? AND lane = ?').bind(source, lane)
    .first<{ backfill_until: string | null; backfill_page: number | null }>();
  if (!spec.backfillPages || !state || (state.backfill_until && state.backfill_page === null)) return 0;
  const until = state.backfill_until || new Date(now).toISOString().slice(0, 10);
  const since = daysFromNow(-CORPUS_DAYS, now);
  const held = await db.prepare('SELECT count(*) AS n FROM work_lanes WHERE lane = ?').bind(lane).first<{ n: number }>();
  // Saved after each page, so a step cut short goes on from the last one read.
  const save = (next: number | null) => db.prepare('UPDATE lane_state SET backfill_until = ?, backfill_page = ? WHERE source = ? AND lane = ?')
    .bind(until, next, source, lane).run();
  let page = state.backfill_page || 1;
  let stored = 0;
  if ((held?.n || 0) >= FEED_CANDIDATE_LIMIT) {
    await save(null);
    return stored;
  }
  const waits = { seconds: LANE_WAIT_SECONDS };
  for (let read = 0; read < spec.backfillPages; read += 1, page += 1) {
    if (read > 0) await new Promise(resolve => setTimeout(resolve, BACKFILL_GAP_MS));
    let result: SourcePage;
    try {
      result = await spec.fetchPage(env, { lane, page, since, waits, until });
    } catch (error) {
      if (!(error instanceof SourceRefused)) console.warn(`Backfill of ${source} ${lane} stopped at page ${page}`, error);
      break;
    }
    try {
      stored += await ingestPapers(env, result.items, { now });
    } catch (error) {
      throw new Error(`Backfill ${source} ${lane} page ${page} could not store ${result.items.length} records: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const done = !result.full || Boolean(result.newest && result.newest < since) || page >= SOURCE_MAX_PAGE;
    await save(done ? null : page + 1);
    if (done) break;
  }
  return stored;
}

// ─── Papers asked for by id ───

/** arXiv's records of these ids (at most 50), through the paced `/arxiv` route. */
export async function fetchArxivPapers(env: WorkerEnv, arxivIds: string[]) {
  const response = await askRoute(handleHarvestArxiv, '/arxiv', { id_list: arxivIds.slice(0, 50).join(','), max_results: Math.min(50, arxivIds.length) }, env);
  return parseArxivAtom(await response.text()).map(arxivRecordPaper);
}

const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Papers the app holds ids for but the corpus lacks (a reader's likes),
 * fetched and kept as liked papers whatever their date: one older than the
 * corpus window enters no lane (`recordLanes`).
 * arXiv ids ask arXiv; PubMed ids, DOIs and OpenAlex ids ask OpenAlex for the
 * single work, which it does not bill. An answer later than `deadlineMs` is
 * dropped: 2 s for a caller that answers a reader inline.
 */
export async function ingestPaperIds(env: SourceEnv, paperIds: string[], { keepUntil, now = Date.now(), deadlineMs = LOOKUP_TIMEOUT_MS }: { keepUntil: string; now?: number; deadlineMs?: number }) {
  const arxivIds: string[] = [];
  const openAlexPaths: string[] = [];
  for (const id of paperIds) {
    const arxivId = text(id).replace(/^arxiv:/i, '').replace(/v\d+$/, '');
    if (/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/.test(arxivId)) arxivIds.push(arxivId);
    else if (/^pmid:\d{1,12}$/i.test(id)) openAlexPaths.push(`/openalex/works/pmid:${id.slice(5)}`);
    else if (/^(?:openalex:)?W\d+$/i.test(id)) openAlexPaths.push(`/openalex/works/${id.replace(/^openalex:/i, '')}`);
    else if (/^(?:doi:)?10\.\d{4,9}\/\S+$/i.test(id)) openAlexPaths.push(`/openalex/works/doi:${id.replace(/^doi:/i, '')}`);
  }
  const lookups: Array<Promise<Harvested[]>> = openAlexPaths.map(async path => {
    const response = await askRoute(handleOpenAlex, path, {}, env);
    const paper = mapOpenAlexWork(await response.json<OpenAlexWork>());
    return paper ? [{ paper, lanes: [] }] : [];
  });
  if (arxivIds.length) {
    lookups.push(fetchArxivPapers(env, arxivIds).then(papers => papers.map(paper => ({ paper, lanes: [] }))));
  }
  const deadline = new Promise<'late'>(resolve => setTimeout(() => resolve('late'), deadlineMs));
  const settled = await Promise.all(lookups.map(lookup => Promise.race([lookup.catch(() => [] as Harvested[]), deadline])));
  const found = settled.flatMap(result => (result === 'late' ? [] : result));
  const stored = await ingestPapers(env, found, { keepUntil, now });
  if (found.length) {
    const db = database(env);
    await keepLiked(db, [...new Set((await findWorks(db, paperIds)).values())], now);
  }
  return stored;
}

