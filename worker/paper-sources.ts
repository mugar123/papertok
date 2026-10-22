import type { Paper } from '../src/models/Paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/openAlexTypes.ts';
import type { WorkerEnv } from './env.ts';
import type { Harvested, StoreEnv } from './paper-store.ts';

import { XMLParser } from 'fast-xml-parser';
import { getAllLeafCategories } from '../src/data/categoryTaxonomy.ts';
import { ARXIV_FEED_AREAS, arxivPaper, isArxivCategory } from '../src/services/arxivRecords.ts';
import { pubmedCategoryQuery, readPubmedPayload } from '../src/services/adapters/pubmedRecords.ts';
import {
  domainSourceRequests,
  getDomainSourcePlan,
  getEligibleDomainSources,
  mapBioRxivPaper,
} from '../src/services/domainSourceRecords.ts';
import { OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../src/utils/openAlexWork.ts';
import { openAlexTopicFilterForLeaves } from '../src/utils/areaAccent.ts';
import { handleArxiv } from './arxiv-api.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { handlePhysicsLiterature } from './physics-api.ts';
import { fetchWithDeadline } from './provider-runtime.ts';
import { handleCore, handleEuropePmc, handleHuggingFacePapers, handleNasa, handleOpenReview, handleOsti, handlePubmed } from './source-api.ts';
import { CORPUS_DAYS, PaperStoreError, daysFromNow, ingestPapers, publishedOf } from './paper-store.ts';
import { parseXmlDocument } from './xml-dom.ts';

// Every source the feed reads, asked once a day for what it added to each
// lane (a category, a followed entity, a series) since the last run, through
// the same Worker routes and the same request builders and mappers the
// browser used to call for every reader and page.

const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const DAY_MS = 86_400_000;
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
  isArray: name => ['record', 'version', 'entry', 'author', 'category'].includes(name),
});

const optional = (value: unknown) => text(value) || null;
const isoDate = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};
const versionless = (value: unknown) => text(value).replace(/^.*\/abs\//, '').replace(/v\d+$/, '');

// arXivRaw lists authors as one string: "A, B (MIT) and C".
export function splitRawAuthors(value: unknown) {
  let names = text(value);
  while (/\([^()]*\)/.test(names)) names = names.replace(/\([^()]*\)/g, '');
  return names.split(/,|\s+and\s+/).map(text).filter(Boolean);
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

/** A route refused for now: its own minute ceiling, a pace beat or the day's budget. */
export class SourceRefused extends Error {
  retryAfterSeconds: number;
  constructor(path: string, retryAfterSeconds: number) {
    super(`${path} refused; retry in ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Asks a Worker route in-process, as the browser asked it over the network:
// the route's own validation, keys, cache, ceilings and deadlines apply.
async function askRoute(handler: RouteHandler, path: string, params: Record<string, string | number>, env: WorkerEnv) {
  const url = new URL(`https://papertok.internal${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const response = await handler(new Request(url), env, null);
  if (response.status === 429) throw new SourceRefused(path, Number(response.headers.get('retry-after')) || 60);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response;
}

// A refusal that names a short wait is waited out, twice at most; a longer
// one (OpenAlex's spent day) ends the lane for this run.
async function withShortWaits<T>(attempt: () => Promise<T>) {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SourceRefused) || error.retryAfterSeconds > 30 || tries >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, error.retryAfterSeconds * 1000));
    }
  }
}

const LEAVES = getAllLeafCategories();

// The engineering leaves arXiv has no category for, searched by label.
const ARXIV_LABEL_LEAVES = LEAVES.filter(leaf => ARXIV_FEED_AREAS.includes(leaf.area) && !isArxivCategory(leaf.id));
const PUBMED_LEAVES = LEAVES.filter(leaf => leaf.area === 'med' || leaf.area === 'bio');

// The series the feed shows for economics and finance, by OpenAlex source ID,
// each checked with a keyless OpenAlex request on 2026-10-19 (PAP-53). The
// review rule in publicationStatus.ts owns which sources are working-paper
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
export const WORKING_PAPERS_LANE = 'series:working-papers';

export type SourceName =
  | 'arxiv-search' | 'pubmed' | 'openalex-topics' | 'openalex-series' | 'openalex-follows' | 'openaire' | 'biorxiv'
  | 'europepmc' | 'core' | 'osti' | 'nasa' | 'physics' | 'openreview' | 'huggingface';

export interface LaneJob { source: SourceName; lane: string }

interface PageRequest { lane: string; page: number; since: string }
interface SourcePage { items: Harvested[]; oldest: string; full: boolean }
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
  // Followed lanes keep their papers whatever their date.
  followed?: boolean;
  fetchPage: (env: SourceEnv, request: PageRequest) => Promise<SourcePage>;
}

function pageOf(items: Harvested[], size: number): SourcePage {
  const dates = items.map(item => publishedOf(item.paper)).filter(Boolean).sort();
  return { items, oldest: dates[0] || '', full: items.length >= size };
}

const filed = (papers: Array<Partial<Paper> | null>, lane: string) => (papers.filter(Boolean) as Partial<Paper>[]).map(paper => ({ paper, lanes: [lane] }));

async function arxivSearch(env: SourceEnv, query: string, page: number, lane: string) {
  const size = 50;
  const response = await withShortWaits(() => askRoute(handleArxiv, '/arxiv', {
    search_query: query, start: (page - 1) * size, max_results: size, sortBy: 'submittedDate', sortOrder: 'descending',
  }, env));
  return pageOf(filed(parseArxivAtom(await response.text()).map(arxivRecordPaper), lane), size);
}

const quotedLabel = (leafId: string) => LEAVES.find(leaf => leaf.id === leafId)?.label || leafId.replace(/\./g, ' ');

async function openAlexWorks(env: SourceEnv, filter: string, { page, perPage, search = '' }: { page: number; perPage: number; search?: string }) {
  const params: Record<string, string | number> = {
    filter, sort: 'publication_date:desc', page, 'per-page': perPage, select: OPENALEX_WORK_SEARCH_FIELDS.join(','),
  };
  if (search) params.search = search;
  const response = await askRoute(handleOpenAlex, '/openalex/works', params, env);
  return ((await response.json()) as { results?: OpenAlexWork[] }).results || [];
}

const windowFilter = (now = Date.now()) => `from_publication_date:${day(daysFromNow(-CORPUS_DAYS, now))},to_publication_date:${day(new Date(now).toISOString())}`;

async function openAlexLane(env: SourceEnv, filter: string, { page, lane, perPage, search = '', map = (work: OpenAlexWork) => mapOpenAlexWork(work) as Partial<Paper> | null }: {
  page: number; lane: string; perPage: number; search?: string; map?: (work: OpenAlexWork) => Partial<Paper> | null;
}) {
  const works = await openAlexWorks(env, filter, { page, perPage, search });
  return pageOf(filed(works.map(map), lane), perPage);
}

// Followed OpenAlex entities, by the filter that names their works.
const FOLLOW_FILTERS: Record<string, string> = { author: 'author.id', institution: 'institutions.id', topic: 'topics.id', concept: 'concepts.id' };

async function openAireProjectDois(lane: string) {
  const [, rest] = lane.split(':');
  const [funder, project] = rest.includes('|') ? rest.split('|') : ['', rest];
  const url = new URL('https://api.openaire.eu/search/publications');
  url.searchParams.set('format', 'json');
  url.searchParams.set('size', '30');
  url.searchParams.set('page', '1');
  url.searchParams.set(project.includes('::') ? 'openaireProjectID' : 'projectID', project);
  if (funder && !project.includes('::')) url.searchParams.set('funder', funder);
  const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 10_000);
  if (!response.ok) throw new Error(`OpenAIRE answered ${response.status}`);
  type Pid = { '@classname'?: string; $?: unknown };
  const payload = await response.json() as { response?: { results?: { result?: unknown } } };
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
  const { collection = [] } = await response.json() as { collection?: Parameters<typeof mapBioRxivPaper>[0][] };
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
  return async (env, { lane, page }) => {
    const plan = getDomainSourcePlan([lane]);
    const eligible = getEligibleDomainSources(plan, { hasSession: true, scopusEnabled: false });
    const request = domainSourceRequests(plan, eligible, page, perPage, 'recent').find(candidate => candidate.source === source);
    if (!request) return { items: [], oldest: '', full: false };
    const response = await withShortWaits(() => askRoute(DOMAIN_ROUTES[source], request.path, request.params, env));
    return pageOf(filed(request.read(await response.json()), lane), Math.min(Number(request.params.limit) || perPage, perPage));
  };
}

export const SOURCES: Record<SourceName, SourceSpec> = {
  'arxiv-search': {
    firstPages: 4, dailyPages: 4, dated: true, overlapDays: 3,
    fetchPage: (env, { lane, page }) => (lane.startsWith('author-name:')
      ? arxivSearch(env, `au:"${lane.slice('author-name:'.length).replace(/"/g, '')}"`, page, lane)
      : arxivSearch(env, `all:"${quotedLabel(lane)}"`, page, lane)),
  },
  pubmed: {
    firstPages: 10, dailyPages: 10, dated: true, overlapDays: 3,
    fetchPage: async (env, { lane, page }) => {
      const response = await withShortWaits(() => askRoute(handlePubmed, '/sources/pubmed', {
        q: `(${pubmedCategoryQuery([lane])}) AND hasabstract`, page, limit: 50,
      }, env));
      const payload = await response.json() as Parameters<typeof readPubmedPayload>[0];
      const papers = readPubmedPayload(payload, { internalCategories: [lane], parseXml: parseXmlDocument });
      // Full by esearch's count: the category check drops papers off a page.
      return { ...pageOf(filed(papers, lane), 50), full: (payload?.esearchresult?.idlist?.length || 0) >= 50 };
    },
  },
  'openalex-topics': {
    firstPages: 5, dailyPages: 5, dated: true, overlapDays: 14,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      openAlexTopicFilterForLeaves([lane]),
      windowFilter(),
      'has_abstract:true',
      'is_retracted:false',
      'primary_location.source.is_core:true',
    ].join(','), { page, lane, perPage: 200 }),
  },
  'openalex-series': {
    firstPages: 4, dailyPages: 2, dated: true, overlapDays: 14,
    fetchPage: (env, { lane, page }) => openAlexLane(env, [
      `primary_location.source.id:${WORKING_PAPER_SERIES_IDS.join('|')}`,
      // The window also held one dataset.
      'type:article|report',
      windowFilter(),
    ].join(','), {
      page, lane, perPage: 200,
      // The area's own key, which the label and accent lookups read as
      // Economics: the series say a paper is economics, not which branch.
      map: work => {
        const paper = mapOpenAlexWork(work);
        return paper ? { ...paper, primaryCategory: 'econ' } : null;
      },
    }),
  },
  'openalex-follows': {
    firstPages: 2, dailyPages: 1, dated: true, overlapDays: 14, followed: true,
    fetchPage: (env, { lane, page }) => {
      const [kind, value] = [lane.slice(0, lane.indexOf(':')), lane.slice(lane.indexOf(':') + 1)];
      if (kind === 'query') return openAlexLane(env, `${windowFilter()},is_retracted:false`, { page, lane, perPage: 50, search: value });
      return openAlexLane(env, `${FOLLOW_FILTERS[kind]}:${value}`, { page, lane, perPage: 50 });
    },
  },
  openaire: {
    firstPages: 1, dailyPages: 1, dated: false, overlapDays: 0, followed: true,
    fetchPage: async (env, { lane }) => {
      const dois = await openAireProjectDois(lane);
      if (!dois.length) return { items: [], oldest: '', full: false };
      return openAlexLane(env, `doi:${dois.join('|')}`, { page: 1, lane, perPage: 50 });
    },
  },
  biorxiv: { firstPages: 20, dailyPages: 20, dated: false, overlapDays: 2, fetchPage: bioRxivPage },
  europepmc: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, fetchPage: domainSource('europepmc', 10) },
  core: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, fetchPage: domainSource('core', 10) },
  osti: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, fetchPage: domainSource('osti', 6) },
  nasa: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, fetchPage: domainSource('nasa', 6) },
  physics: { firstPages: 5, dailyPages: 3, dated: true, overlapDays: 3, fetchPage: domainSource('physics', 10) },
  openreview: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, fetchPage: domainSource('openreview', 10) },
  huggingface: { firstPages: 2, dailyPages: 2, dated: false, overlapDays: 0, fetchPage: domainSource('huggingface', 10) },
};

/** Every lane a source serves whatever readers follow: the app's categories it answers. */
export function categoryLaneJobs(): LaneJob[] {
  const jobs: LaneJob[] = [
    ...ARXIV_LABEL_LEAVES.map(leaf => ({ source: 'arxiv-search' as const, lane: leaf.id })),
    ...PUBMED_LEAVES.map(leaf => ({ source: 'pubmed' as const, lane: leaf.id })),
    ...LEAVES.filter(leaf => openAlexTopicFilterForLeaves([leaf.id])).map(leaf => ({ source: 'openalex-topics' as const, lane: leaf.id })),
    { source: 'openalex-series', lane: WORKING_PAPERS_LANE },
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

/** The source that serves a followed lane (paper-store.ts `followLane`). */
export function followedLaneJob(lane: string): LaneJob | null {
  if (lane.startsWith('author-name:')) return { source: 'arxiv-search', lane };
  if (lane.startsWith('project:')) return { source: 'openaire', lane };
  if (/^(author|institution|topic|concept|query):/.test(lane)) return { source: 'openalex-follows', lane };
  return null;
}

const FOLLOWED_KEEP_DAYS = 14;

/**
 * Harvests one lane of one source: pages until the source has nothing newer
 * than the last run reached, or the run's page allowance. A followed lane's
 * papers stay whatever their date, for as long as readers follow it.
 * Records the lane's progress only once it completes.
 */
export async function harvestLane(env: SourceEnv, { source, lane }: LaneJob, now = Date.now()) {
  const spec = SOURCES[source];
  const db = env.PAPER_STORE!;
  const state = await db.prepare('SELECT harvested_through FROM lane_state WHERE source = ? AND lane = ?').bind(source, lane)
    .first<{ harvested_through: string }>();
  const reached = state?.harvested_through || '';
  const since = reached ? daysFromNow(-spec.overlapDays, Date.parse(reached)) : daysFromNow(-CORPUS_DAYS, now);
  const keepUntil = spec.followed ? daysFromNow(FOLLOWED_KEEP_DAYS, now) : '';
  let stored = 0;
  const pages = reached ? spec.dailyPages : spec.firstPages;
  for (let page = 1; page <= pages; page += 1) {
    const result = await spec.fetchPage(env, { lane, page, since });
    stored += await ingestPapers(env, result.items, { keepUntil, now });
    if (!result.full || (spec.dated && result.oldest && result.oldest < since)) break;
  }
  await db.prepare(`INSERT INTO lane_state (source, lane, harvested_through) VALUES (?, ?, ?)
    ON CONFLICT (source, lane) DO UPDATE SET harvested_through = excluded.harvested_through`).bind(source, lane, new Date(now).toISOString()).run();
  return stored;
}

// ─── Papers asked for by id ───

const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Papers the app holds ids for but the corpus lacks (a reader's likes),
 * fetched and filed with no lane, kept for KEEP days whatever their date.
 * arXiv ids ask arXiv; PubMed ids, DOIs and OpenAlex ids ask OpenAlex for the
 * single work, which it does not bill. Bounded by the caller's deadline.
 */
export async function ingestPaperIds(env: SourceEnv, paperIds: string[], { keepUntil, now = Date.now() }: { keepUntil: string; now?: number }) {
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
    const paper = mapOpenAlexWork(await response.json() as OpenAlexWork);
    return paper ? [{ paper, lanes: [] }] : [];
  });
  if (arxivIds.length) {
    lookups.push(askRoute(handleArxiv, '/arxiv', { id_list: arxivIds.join(','), max_results: arxivIds.length }, env)
      .then(async response => parseArxivAtom(await response.text()).map(record => ({ paper: arxivRecordPaper(record), lanes: [] }))));
  }
  const deadline = new Promise<'late'>(resolve => setTimeout(() => resolve('late'), LOOKUP_TIMEOUT_MS));
  const settled = await Promise.all(lookups.map(lookup => Promise.race([lookup.catch(() => [] as Harvested[]), deadline])));
  const found = settled.flatMap(result => (result === 'late' ? [] : result));
  return ingestPapers(env, found, { keepUntil, now });
}

export { DAY_MS };
