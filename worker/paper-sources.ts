import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/open-alex-types.ts';
import type { WorkerEnv } from './env.ts';
import type { Harvested, StoreEnv } from './paper-store.ts';
import type { HarvestAsk } from './openalex-api.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { XMLParser } from 'fast-xml-parser';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { ARXIV_FEED_AREAS, arxivPaper, isArxivCategory } from '../src/services/arxiv-records.ts';
import { pubmedCategoryQuery, readPubmedPayload } from '../src/services/adapters/pubmed-records.ts';
import {
  domainSourceRequests,
  getDomainSourcePlan,
  getEligibleDomainSources,
  mapBioRxivPaper,
} from '../src/services/domain-source-records.ts';
import { OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { openAlexTopicFilterForLeaf } from '../src/utils/area-accent.ts';
import { openAlexLabelFilterForArea } from '../src/data/open-alex-areas.ts';
import { OPENALEX_NOT_LISTED_SERIES_FILTER } from '../src/utils/publication-status.ts';
import { handleArxiv } from './arxiv-api.ts';
import { handleHarvestOpenAlex, handleOpenAlex } from './openalex-api.ts';
import { handlePhysicsLiterature } from './physics-api.ts';
import { SOURCE_MAX_PAGE, fetchWithDeadline } from './provider-runtime.ts';
import { handleCore, handleEuropePmc, handleHuggingFacePapers, handleNasa, handleOpenReview, handleOsti, handlePubmed } from './source-api.ts';
import { AREA_LANE_AREAS, CORPUS_DAYS, FEED_CANDIDATE_LIMIT, NOTABLE_LANE_PREFIX, PaperStoreError, WORKING_PAPERS_LANE, areaLane, database, daysFromNow, findWorks, ingestPapers, keepLiked, notableSince, publishedOf } from './paper-store.ts';
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
  // says when it is back: a refusal longer than a lane waits ends the source
  // for the step rather than asking the ledger again for every lane, and a
  // followed lane keeps its turn (paper-harvest.ts).
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

export type SourceName =
  | 'arxiv-search' | 'pubmed' | 'openalex-topics' | 'openalex-notable' | 'openalex-areas' | 'openalex-series' | 'openalex-follows'
  | 'openaire' | 'biorxiv' | 'europepmc' | 'core' | 'osti' | 'nasa' | 'physics' | 'openreview' | 'huggingface';

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
  // Lanes whose listing is OpenAlex's current record of each paper it returns
  // (the notable lanes' weekly one): it brings their counts, so the
  // enrichment's refresh (paper-enrichment.ts REFRESH_DAYS) passes over the
  // papers a run returned.
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
  const response = await withShortWaits(waits, () => askRoute(handleArxiv, '/arxiv', {
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
// a refusal that ends the source for this step. Readers choose how many
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

// Notable papers (Pablo, 2026-10-23): each admitted leaf's most-cited articles
// of the notable window (paper-store.ts `notableSince`), asked once a week.
// One page of NOTABLE_PER_LANE is one list call a lane a week, reserved from
// the harvest's OpenAlex share.
const NOTABLE_PER_LANE = 100;
const NOTABLE_LANE_DAYS = 7;

const notableWindowFilter = (now = Date.now()) => `from_publication_date:${notableSince(now)},to_publication_date:${day(new Date(now).toISOString())}`;

// Followed OpenAlex entities, by the filter that names their works.
const FOLLOW_FILTERS: Record<string, string> = { author: 'author.id', institution: 'institutions.id', topic: 'topics.id', concept: 'concepts.id' };

async function openAireProjectDois(lane: string) {
  // An OpenAIRE project id holds `::` itself; a funder, when stored, comes first.
  const rest = lane.slice('project:'.length);
  const bar = rest.indexOf('|');
  const [funder, project] = bar >= 0 ? [rest.slice(0, bar), rest.slice(bar + 1)] : ['', rest];
  const url = new URL('https://api.openaire.eu/search/publications');
  url.searchParams.set('format', 'json');
  url.searchParams.set('size', '30');
  url.searchParams.set('page', '1');
  url.searchParams.set(project.includes('::') ? 'openaireProjectID' : 'projectID', project);
  if (funder && !project.includes('::')) url.searchParams.set('funder', funder);
  const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 10_000);
  if (!response.ok) throw answeredError('OpenAIRE', response.status);
  type Pid = { '@classname'?: string; $?: unknown };
  const payload = await response.json<{ response?: { results?: { result?: unknown } } }>();
  const rows = [payload?.response?.results?.result || []].flat() as Array<{ metadata?: { 'oaf:entity'?: { 'oaf:result'?: { pid?: Pid | Pid[] } } } }>;
  return rows.flatMap(row => [row?.metadata?.['oaf:entity']?.['oaf:result']?.pid || []].flat())
    .filter(pid => ['doi', 'digital object identifier'].includes(text(pid?.['@classname']).toLowerCase()))
    .map(pid => text(pid?.$).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase())
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
    firstPages: 10, dailyPages: 10, backfillPages: 20, dated: true, overlapDays: 3,
    fetchPage: async (env, { lane, page, waits, until }) => {
      // Newest added first; a backfill reads only what was added by its first day.
      const added = until ? ` AND 1800/01/01:${until.replace(/-/g, '/')}[edat]` : '';
      const response = await withShortWaits(waits, () => askRoute(handlePubmed, '/sources/pubmed', {
        q: `(${pubmedCategoryQuery([lane])}) AND hasabstract${added}`, page, limit: 50,
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
      'has_abstract:true',
      'is_retracted:false',
      'primary_location.source.is_core:true',
    ].join(','), { page, lane, perPage: 200, part: 'categories' }),
  },
  // Kept whatever their age (`keepsOld`): each week's listing renews them
  // before KEPT_LISTING_DAYS run out, and one that drops out of the list leaves.
  'openalex-notable': {
    firstPages: 1, dailyPages: 1, dated: false, overlapDays: 0, keepsOld: true, renewsEnrichment: true,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      openAlexTopicFilterForLeaf(lane.slice(NOTABLE_LANE_PREFIX.length)),
      notableWindowFilter(),
      'has_abstract:true',
      'is_retracted:false',
      'primary_location.source.is_core:true',
    ].join(','), { page, lane, perPage: NOTABLE_PER_LANE, sort: 'cited_by_count:desc', part: 'categories' }),
  },
  // The newest journal articles of a whole area, filed under the area. On
  // 2026-10-23 a page of 200 with an abstract held the last one or two days of
  // each area but finance's nine: about 22 (finance) to 370 (electrical
  // engineering) a day. In the 90 days before, 23 % (statistics, economics) to
  // 39 % (mechanical engineering) of the articles had none. So a night reads
  // one page, the newest 200: one list call an area. Unlike the topic lanes,
  // the area lanes take an article without an abstract (PAP-107); its card
  // says it has none. OpenAlex lists IMF, Federal Reserve Board and Fed bank
  // working papers as core journal articles; their cards say Working paper,
  // so the lane leaves out the review rule's series.
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
      return openAlexLane(env, `${FOLLOW_FILTERS[kind]}:${value},to_publication_date:${day(new Date().toISOString())}`, { page, lane, perPage: 50, part });
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
 * The notable lane of each leaf with a topic lane, unless it was harvested in
 * the last NOTABLE_LANE_DAYS days. Counted in UTC days, so a lane is due a
 * week on even when this run reaches it earlier in the night than last week's.
 */
export async function notableLaneJobs(db: D1Database, now = Date.now()): Promise<LaneJob[]> {
  const { results } = await db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-notable' AND harvested_through >= ?")
    .bind(day(daysFromNow(1 - NOTABLE_LANE_DAYS, now))).all<{ lane: string }>();
  const recent = new Set(results.map(row => row.lane));
  return TOPIC_LEAVES.map(leaf => ({ source: 'openalex-notable' as const, lane: `${NOTABLE_LANE_PREFIX}${leaf.id}` }))
    .filter(job => !recent.has(job.lane));
}

// The source that serves each kind of followed lane (paper-store.ts `followLane`).
const FOLLOWED_LANE_SOURCES: Array<[RegExp, SourceName]> = [
  [/^author-name:/, 'arxiv-search'],
  [/^project:/, 'openaire'],
  [/^(author|institution|topic|concept|query):/, 'openalex-follows'],
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
  const listed: string[] = [];
  const pages = reached ? spec.dailyPages : spec.firstPages;
  const waits = { seconds: LANE_WAIT_SECONDS };
  for (let page = 1; page <= pages; page += 1) {
    if (spec.gapMs) await new Promise(resolve => setTimeout(resolve, spec.gapMs));
    const result = await spec.fetchPage(env, { lane, page, since, waits, newFollow });
    stored += await ingestPapers(env, result.items, { keepUntil, now });
    listed.push(...result.items.flatMap(item => item.paper.id || []));
    if (!result.full || (spec.dated && result.newest && result.newest < since)) break;
  }
  // Only the lane's papers this run's pages returned carry OpenAlex's counts of
  // today: each is renewed under the work it was filed or merged into. One the
  // listing no longer returns keeps its enrichment date, however long the
  // corpus keeps it (a recent paper, a liked one), so the refresh still comes.
  // One never enriched still gets its first enrichment, which also asks
  // Crossref its type.
  if (spec.renewsEnrichment) {
    const workIds = [...new Set((await findWorks(db, listed)).values())];
    if (workIds.length) {
      await db.prepare(`UPDATE works SET enriched_at = ? WHERE enriched_at IS NOT NULL AND enrich_misses = 0
        AND id IN (SELECT value FROM json_each(?)) AND id IN (SELECT work_id FROM work_lanes WHERE lane = ?)`)
        .bind(new Date(now).toISOString(), JSON.stringify(workIds), lane).run();
    }
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
    stored += await ingestPapers(env, result.items, { now });
    const done = !result.full || Boolean(result.newest && result.newest < since) || page >= SOURCE_MAX_PAGE;
    await save(done ? null : page + 1);
    if (done) break;
  }
  return stored;
}

// ─── Papers asked for by id ───

/** arXiv's records of these ids (at most 50), through the paced `/arxiv` route. */
export async function fetchArxivPapers(env: WorkerEnv, arxivIds: string[]) {
  const response = await askRoute(handleArxiv, '/arxiv', { id_list: arxivIds.slice(0, 50).join(','), max_results: Math.min(50, arxivIds.length) }, env);
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

