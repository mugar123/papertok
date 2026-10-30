import type { BloomFilter } from 'bloomfilter';
import type { Paper, PaperFollowMatch } from '../src/models/paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/open-alex-types.ts';
import type { WorkerEnv } from './env.ts';
import type { QuotaPart } from './request-quota-ledger.ts';
import type { FeedTimings } from './feed-timings.ts';

import { PaperBuilder, isPublisherDoi } from '../src/services/paper-builder.ts';
import { isFeedPublication, isFeedPublicationType } from '../src/services/feed-publication-rules.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
import { opensAsFrontMatter } from '../src/utils/open-alex-abstract.ts';
import { normalizeDoi } from '../src/utils/public-navigation.ts';
import { openAlexIsJournalArticle } from '../src/utils/publication-status.ts';
import { isPlaceholderPaperTitle } from '../src/utils/paper-display-title.ts';
import { getAllLeafCategories, getArxivArchiveArea } from '../src/data/category-taxonomy.ts';
import { hasSeenPaper, readFeedSeenFilter } from '../src/utils/seen-paper-filter.ts';
import { FEED_MAX_FOLLOWS, entityLane, followLane } from '../src/utils/follow-lanes.ts';
import { ARXIV_FEED_AREAS } from '../src/services/arxiv-records.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

// The paper corpus: every source the feed reads, harvested once a day
// (paper-harvest.ts), merged into one row per paper, enriched and embedded
// once, and served from D1 instead of one request per reader, page and source.
// Ranking compares int8 vectors in the Worker over the asked lanes' recent rows;
// Vectorize's included allowance on Workers Paid (10M stored dimensions) holds
// fewer papers than one week.

export const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
export const EMBEDDING_DIMENSIONS = 1024;
// The leading dimensions kept of each vector. The model is trained so a prefix
// of its vector is an embedding of its own (Matryoshka), and a quarter of it
// is a quarter of what a page reads from D1 and compares.
export const STORED_DIMENSIONS = 256;
export type EmbeddingEnv = {
  // Optional so test doubles of the binding that only convert PDFs still type-check.
  AI?: { run?: (model: string, input: { text: string[] }) => Promise<{ data?: number[][] }> };
};

// Papers published longer ago than this leave the corpus, unless a reader's
// like keeps them (KEEP_LIKED_DAYS); the feed never ranks further back.
export const CORPUS_DAYS = 90;
// A liked paper the feed ranks by stays this long after a reader last did.
export const KEEP_LIKED_DAYS = 30;
export const FEED_CANDIDATE_LIMIT = 4_000;
// The feed's page of corpus cards (FeedContext's PAGE_SIZE), and a request's
// page when it names none.
const FEED_PAGE_SIZE = 15;
// Broad area candidates supplement the requested categories without taking
// their retrieval budget. This bounds work, not the composition of a page.
const AREA_CANDIDATE_LIMIT = 800;
const FEED_MAX_CATEGORIES = 12;
const FEED_MAX_POSITIVES = 24;
const FEED_MAX_EXCLUDED = 200;
const DIVERSITY_POOL = 500;
const DIVERSITY_RANKS = 150;
const DIVERSITY_WEIGHT = 0.3;
const NEGATIVE_SIMILARITY_THRESHOLD = 0.75;
const NEGATIVE_WEIGHT = 0.5;
const FEED_MAX_PAGE_SIZE = 30;
// Notable papers a page adds: the app's largest page asks for its three places and two spares.
const FEED_MAX_NOTABLE = 5;
const FEED_MAX_PAGE = 100;
const DEFAULT_FEED_USER_MINUTE_LIMIT = 60;
const DEFAULT_FEED_GLOBAL_MINUTE_LIMIT = 2_000;
const EMBED_BATCH = 32;
const EMBED_TEXT_CHARS = 2_000;
// A card names a few authors; a 2,000-author collaboration paper would be
// ~150K characters of them in every row and every response.
const STORED_AUTHORS = 50;
// Workers AI gives 10,000 neurons a day; this model costs 1,075 per million
// input tokens (pricing page, 2026-10-22), so 7.5M estimated tokens keeps the
// store inside the free allocation with room for the PDF conversions.
const DEFAULT_EMBEDDING_DAILY_TOKEN_LIMIT = 7_500_000;
const EMBEDDING_TOKENS_PER_UNIT = 1_000;
// Shares of the day's limit for what readers start, so the daily run keeps the
// rest. One reader's lookups of liked papers (paper-feed.ts): seven lookups of
// ten long papers; on the harvest's subject, a review estimated that one
// account's lookups could spend a 60M-token day (the ceiling while a backlog
// is embedded) in about 143 minutes. All
// readers together: accounts are free to make, so shares of 50,000 each add up
// to the whole day without a cap of their own. A fixed number rather than a
// fraction of the day keeps the daily run its share at the 7.5M the free
// allocation gives. The runs new follows start, together: no reader
// is recorded with them, and each of the 20 new lanes a reader's runs may
// harvest a day can bring a few hundred papers; what they leave waits for the
// daily run.
const READER_EMBEDDING_DAILY_TOKENS = 50_000;
const READERS_EMBEDDING_DAILY_TOKENS = 1_500_000;
const FOLLOW_RUNS_EMBEDDING_DAILY_TOKENS = 1_500_000;
// Similarity orders the page; recency only separates near ties, so a reader
// with likes still sees this week's papers ahead of last month's lookalikes.
// Relevance order is for a reader whose views lean older: no recency at all.
const RECENCY_WEIGHT = { recent: 0.15, relevance: 0 } as const;
const RECENCY_HALF_LIFE_DAYS = 7;
const DAY_MS = 86_400_000;

export class PaperStoreError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export type StoreEnv = Pick<WorkerEnv, 'PAPER_STORE' | 'REQUEST_QUOTA_LEDGER' | 'EMBEDDING_DAILY_TOKEN_LIMIT'> & EmbeddingEnv;

/** A paper a source returned, and the lanes that source listed it under. */
export interface Harvested { paper: Partial<Paper>; lanes: string[] }

const text = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const daysFromNow = (days: number, now = Date.now()) => new Date(now + days * DAY_MS).toISOString();

export function database(env: Pick<StoreEnv, 'PAPER_STORE'>) {
  if (!env.PAPER_STORE) throw new PaperStoreError('PAPER_STORE_UNAVAILABLE', 503);
  return env.PAPER_STORE;
}

/** The vector's leading STORED_DIMENSIONS as a unit vector of int8 components scaled by 127, the stored form. */
export function quantize(values: number[]) {
  const kept = values.slice(0, STORED_DIMENSIONS);
  const norm = Math.hypot(...kept) || 1;
  return Int8Array.from(kept, value => Math.round((value / norm) * 127));
}

// A hex digit's value: `0`-`9` keep their low four bits, and `A`-`F` and
// `a`-`f` (bit 6 set) add nine to theirs.
const hexDigit = (code: number) => (code & 15) + (code >> 6) * 9;

export function readVector(value: unknown) {
  // `hex(embedding)` (`readVectors`): two characters a byte, wrapped to int8
  // by the array as the unsigned bytes below are.
  if (typeof value === 'string') {
    const vector = new Int8Array(value.length >> 1);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (hexDigit(value.charCodeAt(2 * index)) << 4) | hexDigit(value.charCodeAt(2 * index + 1));
    }
    return vector;
  }
  if (value instanceof ArrayBuffer) return new Int8Array(value);
  if (ArrayBuffer.isView(value)) return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
  // D1 answers a BLOB as its unsigned bytes. The constructor wraps 128-255 to
  // -128 to -1, as a callback per byte would, at a twentieth of the CPU.
  return new Int8Array(value as number[]);
}

// Normalize once per ranking: MMR compares each candidate many times, and a
// vector cut by migration 0004 is no longer a unit vector. A loop gives the
// same quotients as `Float64Array.from` with a callback for about half the
// CPU, the largest part of ranking 4,000 candidates.
export function unitVector(vector: Int8Array) {
  const norm = Math.hypot(...vector) || 1;
  const unit = new Float64Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) unit[index] = vector[index] / norm;
  return unit;
}

export function cosine(a: Float64Array, b: Float64Array) {
  let dot = 0;
  const dimensions = Math.min(a.length, b.length);
  for (let index = 0; index < dimensions; index += 1) {
    dot += a[index] * b[index];
  }
  return Math.max(-1, Math.min(1, dot));
}

// ─── Identity ───

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/;

// An old-style id names its archive only: math.GT/0309136 is math/0309136.
export function arxivIdOf(value: unknown) {
  const id = text(value).replace(/^arxiv:/i, '').replace(/v\d+$/, '').replace(/^([a-z-]+)\.[A-Z]{2}\//, '$1/');
  return ARXIV_ID.test(id) ? id : '';
}

/**
 * The keys a paper id the app holds (a liked or saved card's) can be found by:
 * the id the corpus served it under, and the identifier inside it.
 */
export function keysForPaperId(value: unknown) {
  const id = text(value).slice(0, 300);
  if (!id) return [];
  const keys = new Set([`id:${id.toLowerCase()}`]);
  const arxivId = arxivIdOf(id);
  if (arxivId) keys.add(`arxiv:${arxivId.toLowerCase()}`);
  const openAlex = id.match(/^(?:openalex:|https:\/\/openalex\.org\/)?(W\d+)$/i)?.[1];
  if (openAlex) keys.add(`id:openalex:${openAlex.toLowerCase()}`);
  const pmid = id.match(/^pmid:(\d{1,12})$/i)?.[1];
  if (pmid) keys.add(`pmid:${pmid}`);
  const doi = id.replace(/^doi:/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (/^10\.\d{4,9}\//.test(doi)) keys.add(doi.toLowerCase());
  return [...keys];
}

// A title key (`<title>_<surname>`, `<title>~<token>`) is stored only for a
// title long enough to name one paper on its own. Stored keys join records for
// good, and a short or non-Latin title ("2024", "Editorial") would fold
// distinct papers together. Every other key holds a `:` or a DOI's `/`.
const TITLE_KEY = /^([a-z0-9]*)[_~][^:/]*$/;
const MIN_STORED_TITLE_KEY = 30;

function workKeys(paper: Paper) {
  const keys = PaperBuilder.identityKeys(paper).filter(key => (key.match(TITLE_KEY)?.[1].length ?? MIN_STORED_TITLE_KEY) >= MIN_STORED_TITLE_KEY);
  return [...new Set([`id:${paper.id.toLowerCase()}`, ...keys])];
}

// ─── Lanes ───

const LEAVES = getAllLeafCategories();
const LEAF_IDS = new Set(LEAVES.map(leaf => leaf.id));
// The economics working-paper series (paper-sources.ts), shown to a reader of
// any economics or finance category. Asked for alongside them, never as one:
// the series say a paper is economics, not which branch.
export const WORKING_PAPERS_LANE = 'series:working-papers';
const WORKING_PAPER_AREAS = new Set(['econ', 'q-fin']);
// The most-cited papers of a category published in each of the NOTABLE_YEARS
// years before the current UTC year (paper-sources.ts), filed under
// `notable:<category>`. A page that says what the reader has seen adds the
// ones the reader has not, for the app to give one card in every
// NOTABLE_EVERY (src/utils/feed-enrichment.ts) (Pablo, 2026-10-23).
export const NOTABLE_LANE_PREFIX = 'notable:';
export const NOTABLE_YEARS = 10;
/** The first day of the notable window: the listing asks from it, and a page reads none older. */
export const notableSince = (now = Date.now()) => `${new Date(now).getUTCFullYear() - NOTABLE_YEARS}-01-01`;
// A notable lane holds its weekly listing of 1,000, 100 of each of those ten
// years (NOTABLE_PER_YEAR in paper-sources.ts), or 2,000 for a leaf with two
// listings (OpenAlex's and ADS's or Europe PMC's), and, for 14 days, what
// dropped out of the two listings before it (`work_lanes.listed_until`), whatever else keeps the
// paper in the corpus (a like, its date, another lane). A page reads
// NOTABLE_READ_PER_YEAR of each of the ten years of each asked lane: a slice
// that moves on by that many rows each UTC day, taken modulo the year's own
// count n, so every row of a year is read within ceil(n / 25) days: four
// disjoint slices for a year of 100, eight for 200, overlapping ones for a
// year of 40 and every day for a year of two; a paper ADS listed waits for its
// enrichment first (`readNotableCandidates`). The candidates and vectors
// ranked per request are 250 a lane at most. Numbering the years reads every
// row of the lane's window from its index (about 1,000, or 2,000), once each,
// and the read returns each work id with whether the day's slice holds it, so
// that a paper of the lane outside the slice is not ranked from the reader's
// other lanes either. How many of them a reader sees is ENG-128's.
const NOTABLE_READ_PER_YEAR = 25;
// Journal articles of a whole area (paper-sources.ts `openalex-areas`), shown
// to a reader of any of its leaves, for the areas whose leaves the feed fills
// from arXiv, and for chemistry, whose leaves no source lists (its lane also
// holds ChemRxiv's preprints, `openalex-chemrxiv`): PubMed lists journal
// articles for every leaf of medicine and biology. A paper a leaf of
// its area holds leaves the area's lane (leaf-filing.ts), so it reaches that
// leaf's readers and no other's. Not statistics while its label covers
// OpenAlex's Decision Sciences (field 18): 147 of that field's 200 newest
// articles on 2026-10-23 were operations research and information systems,
// and most of the 44 in its statistics subfield bibliometrics and
// meta-analyses.
export const AREA_LANE_AREAS: readonly string[] = [...ARXIV_FEED_AREAS.filter(area => area !== 'stat'), 'chem'];
export const areaLane = (area: string) => `area:${area}`;
const AREA_LANES = new Set(AREA_LANE_AREAS.map(areaLane));
// The entities whose lanes hold papers only while a reader follows them: a
// paper names many, readers follow few, and no page reads the rest. Their
// unfollowed lanes held about 3.4M of the corpus's 4.2M lane rows (2026-10-24).
const PRUNED_ENTITY_LANE_KINDS = ['author', 'concept', 'institution'] as const;

// The OpenAlex authors, institutions, topics and concepts a paper names, as lanes.
function namedEntityLanes(paper: Partial<Paper>) {
  const lanes = new Set<string>();
  for (const author of paper.authors || []) {
    if (typeof author === 'object') lanes.add(entityLane(author?.id));
  }
  for (const institution of paper.institutions || []) lanes.add(entityLane(institution?.id));
  for (const subject of [paper.primaryTopic, ...(paper.topics || []), ...(paper.concepts || [])]) lanes.add(entityLane(subject?.id));
  lanes.delete('');
  return [...lanes];
}
const isFollowOnlyLane = (lane: string) => PRUNED_ENTITY_LANE_KINDS.some(kind => lane.startsWith(`${kind}:`));
/** The lanes a paper names that `recordLanes` files only while followed. */
const followOnlyLanes = (paper: Partial<Paper>) => namedEntityLanes(paper).filter(isFollowOnlyLane);

/**
 * Which of `lanes` readers follow, for `recordLanes`. Each write asks only for
 * the lanes its own papers name, not for the whole table: `followed_lanes`
 * holds every lane written in the last 14 days, up to about 60k rows at the
 * app's 4,000 writes a day, and every harvest page, follow run, like lookup
 * and enrichment step files papers.
 */
async function followedLanesAmong(db: D1Database, lanes: Iterable<string>) {
  const asked = [...new Set(lanes)];
  const followed = new Set<string>();
  for (let start = 0; start < asked.length; start += 500) {
    const { results } = await db.prepare('SELECT lane FROM followed_lanes WHERE lane IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(asked.slice(start, start + 500))).all<{ lane: string }>();
    results.forEach(row => followed.add(row.lane));
  }
  return followed;
}

/**
 * The lanes a paper belongs to by its own record, whichever source listed it:
 * its arXiv categories that are categories of the app, the OpenAlex topics it
 * names, and the OpenAlex authors, institutions and concepts it names that
 * are in `followed`. Every reader of them shares these lanes, so a paper is
 * filed under them only inside the corpus window: an older one a reader liked,
 * or a lane that keeps listings kept, stays in the lanes it was asked for.
 */
export function recordLanes(paper: Partial<Paper>, followed: ReadonlySet<string>) {
  const lanes = new Set<string>();
  if (paper.sources?.primary === 'arxiv' || paper.arxivId) {
    for (const category of [...(paper.allCategories || []), ...(paper.categories || [])]) {
      if (LEAF_IDS.has(category)) lanes.add(category);
    }
  }
  for (const lane of namedEntityLanes(paper)) lanes.add(lane);
  return [...lanes].filter(lane => followed.has(lane) || !isFollowOnlyLane(lane));
}

// ─── Writing ───

/**
 * The date a paper is windowed and ordered by, or '' when it has none. A date
 * past tomorrow is a print issue's, not the day the paper appeared (PubMed's
 * "2026 Dec", an OSTI report dated next year): it is no date at all, or it
 * would sort first in its lanes until it came.
 */
export function publishedOf(paper: Partial<Paper>, now = Date.now()) {
  for (const value of [paper.published, paper.publishedDate, paper.publicationDate]) {
    const time = Date.parse(text(value));
    if (Number.isFinite(time) && time <= now + DAY_MS) return new Date(time).toISOString();
  }
  return '';
}

// Transient fields describe one fetch or one reader, never the paper.
// `openAlex` is enrichment's copy of OpenAlex's answer, whose fields the app
// reads are already merged into the paper;
// `summary` repeats the abstract.
function storedPaper(paper: Paper): Paper {
  const stored = Object.fromEntries(Object.entries(paper).filter(([key]) => !key.startsWith('_') && key !== 'raw' && key !== 'openAlex' && key !== 'summary')) as Paper;
  if (stored.authors?.length > STORED_AUTHORS) stored.authors = stored.authors.slice(0, STORED_AUTHORS);
  return stored;
}

// Without an abstract, the title alone: the mappers' "No abstract available."
// would make every such paper alike.
const embeddingText = (paper: Partial<Paper>) => (hasUsableAIAbstract(paper.abstract)
  ? `${text(paper.title)}\n\n${text(paper.abstract)}`
  : text(paper.title)).slice(0, EMBED_TEXT_CHARS);

interface WorkRow { id: number; paper: string; kept_until: string }
interface Group { paper: Paper; lanes: Set<string>; keys: Set<string> }

// A new row's number comes from its paper id, so two writers filing the same
// paper at once (a like looked up by two requests, a followed lane's run beside
// the daily one) meet on one row instead of making two. 48 bits: exact as a
// JavaScript number, and unique among a few million rows.
async function workIdFor(paper: Paper) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`id:${paper.id.toLowerCase()}`)));
  return digest.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0);
}

// Which row keeps its id when a record shows two are one paper: the one under
// the most lasting identifier, so the id readers hold for it rarely changes.
const idRank = (paper: Paper) => (arxivIdOf(paper.id) ? 0 : /^pmid:/i.test(paper.id) ? 1 : /^openalex:/i.test(paper.id) ? 2 : 3);

// D1 counts every statement of a batch towards the invocation's query limit,
// so rows travel as one JSON parameter per chunk rather than one each.
const WRITE_CHUNK = 100;

async function lookUpKeys(db: D1Database, keys: string[]) {
  const found = new Map<string, number>();
  for (let start = 0; start < keys.length; start += 500) {
    const { results } = await db.prepare('SELECT k.key, k.work_id FROM json_each(?) j JOIN work_keys k ON k.key = j.value')
      .bind(JSON.stringify(keys.slice(start, start + 500))).all<{ key: string; work_id: number }>();
    results.forEach(row => found.set(row.key, row.work_id));
  }
  return found;
}

async function readWorks(db: D1Database, ids: number[]) {
  const works = new Map<number, WorkRow>();
  for (let start = 0; start < ids.length; start += 200) {
    const { results } = await db.prepare('SELECT w.id, w.paper, w.kept_until FROM json_each(?) j JOIN works w ON w.id = j.value')
      .bind(JSON.stringify(ids.slice(start, start + 200))).all<WorkRow>();
    results.forEach(row => works.set(row.id, row));
  }
  return works;
}

// ─── Working paper to journal article (ENG-133) ───

// A working paper says it was not reviewed and its journal article says it
// was; `merge` keeps the working paper's `false` whichever record it merges, so
// the upgrade is a step of its own over stored rows, after the batch is saved
// (Pablo, 2026-10-26). Only OpenAlex's working-paper row becomes the journal's,
// and only on OpenAlex's own record of the journal article. A row another
// source started, or a journal record from another source (PubMed, Europe PMC,
// an arXiv eprint naming its journal, a repository's copy), stays as `merge`
// left it (ENG-145).
const isWorkingPaperRow = (paper: Partial<Paper>) => paper.sources?.primary === 'openalex' && paper.workingPaper === true && paper.peerReviewed === false;

// The evidence is one listed record, never a merged row: OpenAlex's own record
// typed `article` in a `journal` that `openAlexPeerReviewed` calls reviewed,
// with a publisher's DOI. Without one, the reviewed row would keep the working
// paper's DOI and link to the unreviewed version.
function isJournalArticleRecord(paper: Paper, raw: unknown) {
  return paper.sources?.primary === 'openalex' && /^openalex:W\d+$/i.test(paper.id)
    && paper.peerReviewed === true && paper.workingPaper !== true && isPublisherDoi(normalizeDoi(paper.doi))
    && openAlexIsJournalArticle(raw as OpenAlexWork | undefined);
}

// The row as the article's record would make it with the row merged in: the
// article's DOI, landing page, title, abstract, venue and date, and what the
// row adds (the working paper's abstract fills a missing one). It keeps the id
// readers liked or saved it under and names the article's work in
// `openAlexId`, which enrichment and the row's own listing follow. Undefined
// when the row's evidence still denies review.
function asJournalRow(row: Paper, article: Paper): Paper | undefined {
  const merged = PaperBuilder.merge(article, row, row.provider || row.sources?.primary);
  if (merged.peerReviewed !== true || merged.workingPaper) return undefined;
  // The article is the merge base, so the row's own enrichments (an abstract
  // from Semantic Scholar) keep their credit only through this list.
  const enrichedBy = [...new Set([...(row.sources?.enrichedBy ?? []), ...merged.sources.enrichedBy])];
  return storedPaper({ ...merged, id: row.id, openAlexId: article.id.slice('openalex:'.length), sources: { ...merged.sources, enrichedBy } });
}

/**
 * Makes each stored OpenAlex working-paper row that an OpenAlex journal-article
 * record of `articles` was filed under (by the article's work id or DOI) the
 * journal's reviewed row, with its date in every lane it holds, and filed
 * under the lanes the article's record adds (`recordLanes`). An upgraded row
 * is no working paper, so the step applies once whatever the order of the
 * records and however often they are listed. Returns how many rows changed.
 */
async function upgradeWorkingPapers(db: D1Database, articles: Paper[], now: number) {
  if (articles.length === 0) return 0;
  const keysOf = (article: Paper) => [`id:${article.id.toLowerCase()}`, normalizeDoi(article.doi).toLowerCase()];
  const found = await lookUpKeys(db, [...new Set(articles.flatMap(keysOf))]);
  const works = await readWorks(db, [...new Set(found.values())]);
  const upgrades: Array<{ id: number; paper: string; published: string; keptUntil: string; textChanged: boolean; lanes: string[] }> = [];
  const since = daysFromNow(-CORPUS_DAYS, now);
  // In id order, so the same records upgrade a row the same way in any order.
  for (const [id, work] of [...works].sort(([a], [b]) => a - b)) {
    const row = JSON.parse(work.paper) as Paper;
    if (!isWorkingPaperRow(row)) continue;
    const upgraded = articles
      .filter(article => keysOf(article).some(key => found.get(key) === id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(article => asJournalRow(row, article))
      .find(Boolean);
    if (!upgraded) continue;
    const published = publishedOf(upgraded, now) || publishedOf(row, now);
    upgrades.push({
      id,
      paper: JSON.stringify(upgraded),
      published,
      keptUntil: [daysFromNow(CORPUS_DAYS, Date.parse(published)), work.kept_until].sort().at(-1)!,
      textChanged: embeddingText(upgraded) !== embeddingText(row),
      lanes: [],
    });
  }
  // The article can name entities the working paper did not (a coauthor it
  // added): the upgraded row is filed under its own record's lanes, as
  // `ingestPapers` files a merged row.
  const upgradedRows = upgrades.map(upgrade => ({ upgrade, paper: JSON.parse(upgrade.paper) as Paper }))
    .filter(({ upgrade, paper }) => upgrade.published >= since && isFeedPublication(paper));
  const followed = await followedLanesAmong(db, upgradedRows.flatMap(({ paper }) => followOnlyLanes(paper)));
  for (const { upgrade, paper } of upgradedRows) upgrade.lanes = recordLanes(paper, followed);
  // One batch a chunk: the row, its date in each of its lanes, its lanes,
  // keys and vector change together.
  for (let start = 0; start < upgrades.length; start += WRITE_CHUNK) {
    const slice = upgrades.slice(start, start + WRITE_CHUNK);
    const chunk = JSON.stringify(slice);
    await db.batch([
      db.prepare(`UPDATE works SET paper = j.value ->> 'paper', published = j.value ->> 'published',
        kept_until = max(works.kept_until, j.value ->> 'keptUntil') FROM json_each(?) j WHERE works.id = j.value ->> 'id'`).bind(chunk),
      db.prepare(`UPDATE work_lanes SET published = j.value ->> 'published' FROM json_each(?) j
        WHERE work_lanes.work_id = j.value ->> 'id' AND work_lanes.published != j.value ->> 'published'`).bind(chunk),
      db.prepare(`INSERT OR IGNORE INTO work_lanes (lane, work_id, published)
        SELECT l.value, j.value ->> 'id', j.value ->> 'published' FROM json_each(?) j, json_each(j.value -> 'lanes') l`).bind(chunk),
      db.prepare(`INSERT OR IGNORE INTO work_keys (key, work_id)
        SELECT k.value, j.value ->> 'id' FROM json_each(?) j, json_each(j.value -> 'keys') k`)
        .bind(JSON.stringify(slice.map(({ id, paper }) => ({ id, keys: workKeys(JSON.parse(paper) as Paper) })))),
      db.prepare(`DELETE FROM work_vectors WHERE work_id IN (SELECT value ->> 'id' FROM json_each(?) WHERE value ->> 'textChanged')`).bind(chunk),
    ]);
  }
  return upgrades.length;
}

const sourceRecordKey = (source: string | undefined, id: string) => `${source}|${id.toLowerCase()}`;

// Hugging Face lists arXiv papers with the title and abstract it copied from
// arXiv, so arXiv's listing carries a new version to a row Hugging Face
// started, and Hugging Face's copy never replaces it. An OpenAlex row that
// became its journal article keeps the working paper's id and follows the
// article's own listing (`openAlexId`), never the working paper's.
const ownListing = (row: Paper, listed: Map<string, Paper>) => (row.sources?.primary === 'huggingface' && row.arxivId
  ? listed.get(sourceRecordKey('arxiv', row.arxivId))
  : listed.get(sourceRecordKey(row.sources?.primary, row.sources?.primary === 'openalex' && row.openAlexId ? `openalex:${row.openAlexId}` : row.id)));

// A row's title and abstract are those of the source it was built from, and
// that source listing it again (a new arXiv version) replaces them, where
// `merge` only fills a gap. A listing without an abstract keeps the stored one,
// unless that opens as a funding note, thanks or a disclaimer: a row an earlier
// Worker filed with one (ENG-105) has no abstract once its source lists it.
// The source's own text credits no other source (`abstractSource`), and
// Semantic Scholar leaves the sources merged in with the text it replaces:
// a stored row takes nothing else from it (`semanticScholarAbstracts` in
// paper-enrichment.ts), so the card no longer says "With data from Semantic
// Scholar". Crossref stays, since its type can have marked the row too.
function withOwnText(row: Paper, own: Paper | undefined): Paper {
  if (!own) return row;
  return hasUsableAIAbstract(own.abstract) || opensAsFrontMatter(row.abstract)
    ? {
      ...row,
      title: own.title,
      abstract: own.abstract,
      abstractSource: undefined,
      sources: { ...row.sources, enrichedBy: row.sources.enrichedBy.filter(source => source !== 'semanticscholar') },
    }
    : { ...row, title: own.title };
}

/**
 * Files what sources returned: records of one paper merge (PaperBuilder.merge,
 * the rule the browser applied to every page) into the row any of their
 * identifiers already names, or start a new one. A record that bridges two
 * rows folds them into one (`idRank`). The row's own source listing it again
 * replaces its title and abstract (`withOwnText`). A merge that changes the
 * title or abstract drops the vector for the embedding pass. A notable lane's
 * row is kept until `keepUntil`, the listing's own keeping date
 * (`listed_until`). Once the batch is saved, OpenAlex's journal articles in it
 * upgrade the working-paper rows they were filed under
 * (`upgradeWorkingPapers`). Returns how many rows were written, by either.
 */
export async function ingestPapers(env: StoreEnv, items: Harvested[], { keepUntil = '', now = Date.now() } = {}) {
  const db = database(env);
  const since = daysFromNow(-CORPUS_DAYS, now);
  const groups: Group[] = [];
  const groupOfKey = new Map<string, Group>();
  const listed = new Map<string, Paper>();
  const articles: Paper[] = [];
  for (const item of items) {
    // A mapper stands "Untitled" in for a title its source left out.
    if (isPlaceholderPaperTitle(item?.paper?.title, item?.paper?.id) || !item.paper.id || !isFeedPublicationType(item.paper)) continue;
    const published = publishedOf(item.paper, now);
    if (!published || (published < since && !keepUntil)) continue;
    const paper = PaperBuilder.create(item.paper);
    listed.set(sourceRecordKey(paper.sources?.primary, paper.id), paper);
    const keys = workKeys(paper);
    const joined = [...new Set(keys.map(key => groupOfKey.get(key)).filter(Boolean) as Group[])];
    let group = joined[0];
    if (!group) {
      group = { paper, lanes: new Set(), keys: new Set() };
      groups.push(group);
    } else {
      for (const other of joined.slice(1)) {
        group.paper = PaperBuilder.merge(group.paper, other.paper, other.paper.provider || other.paper.sources?.primary);
        other.lanes.forEach(lane => group.lanes.add(lane));
        other.keys.forEach(key => group.keys.add(key));
        groups.splice(groups.indexOf(other), 1);
      }
      group.paper = PaperBuilder.merge(group.paper, paper, paper.provider || paper.sources?.primary);
    }
    if (isJournalArticleRecord(paper, item.paper.raw)) articles.push(paper);
    item.lanes.forEach(lane => group.lanes.add(lane));
    keys.forEach(key => group.keys.add(key));
    group.keys.forEach(key => groupOfKey.set(key, group));
  }
  if (groups.length === 0) return 0;

  const existingByKey = await lookUpKeys(db, [...new Set(groups.flatMap(group => [...group.keys]))]);
  const works = await readWorks(db, [...new Set(existingByKey.values())]);
  const rows: Array<{ id: number; paper: string; published: string; keptUntil: string }> = [];
  const keyRows: Array<{ key: string; id: number }> = [];
  const filings: Array<{ id: number; paper: Paper; published: string; lanes: Set<string> }> = [];
  const laneRows: Array<{ lane: string; id: number; published: string; listedUntil: string | null }> = [];
  const staleVectors: number[] = [];
  const folded: Array<{ from: number; into: number }> = [];
  const withdrawn: number[] = [];
  // The groups written as a working paper's row: only their articles can
  // upgrade one, and the step reads no other row.
  const workingPaperGroups = new Set<Group>();

  for (const group of groups) {
    const stored = [...new Set([...group.keys].map(key => existingByKey.get(key)).filter((id): id is number => id !== undefined && works.has(id)))]
      .map(id => ({ id, paper: JSON.parse(works.get(id)!.paper) as Paper }))
      .sort((a, b) => idRank(a.paper) - idRank(b.paper) || a.id - b.id);
    const ids = stored.map(work => work.id);
    let paper = group.paper;
    let id = ids[0];
    if (id === undefined) {
      id = await workIdFor(paper);
    } else {
      // The stored row is the base: its id is the one readers already hold.
      const base = withOwnText(stored[0].paper, ownListing(stored[0].paper, listed));
      paper = stored.slice(1).reduce((merged, other) => PaperBuilder.merge(merged, other.paper, other.paper.provider || other.paper.sources?.primary), base);
      paper = PaperBuilder.merge(paper, group.paper, group.paper.provider || group.paper.sources?.primary);
      if (embeddingText(paper) !== embeddingText(stored[0].paper)) staleVectors.push(id);
      for (const other of ids.slice(1)) folded.push({ from: other, into: id });
    }
    paper = storedPaper(paper);
    // The merged record can carry another source's print date; the incoming one had a usable date.
    const published = publishedOf(paper, now) || publishedOf(group.paper, now);
    const keptUntil = [daysFromNow(CORPUS_DAYS, Date.parse(published)), keepUntil, ...ids.map(other => works.get(other)!.kept_until)].sort().at(-1)!;
    const json = JSON.stringify(paper);
    // D1 bills rows written: a paper a source lists again unchanged is not rewritten.
    const before = ids.length === 1 ? works.get(id)! : null;
    if (!before || before.paper !== json || before.kept_until < keptUntil) rows.push({ id, paper: json, published, keptUntil });
    for (const key of new Set([...group.keys, ...workKeys(paper)])) keyRows.push({ key, id });
    // The merged row can be one the feed does not show: a retracted paper,
    // whether this record or the stored row says so. It is filed under no
    // lane, and leaves those it holds, a folded row's included.
    if (isFeedPublication(paper)) filings.push({ id, paper, published, lanes: group.lanes });
    else withdrawn.push(id);
    if (isWorkingPaperRow(paper)) workingPaperGroups.add(group);
  }
  // Asked once the records are merged: a stored row names entities, such as
  // the OpenAlex ids of arXiv's authors, that a new listing of it does not.
  const followed = await followedLanesAmong(db, filings.flatMap(({ paper, published }) => (published >= since ? followOnlyLanes(paper) : [])));
  for (const { id, paper, published, lanes } of filings) {
    for (const lane of new Set([...lanes, ...(published >= since ? recordLanes(paper, followed) : [])])) {
      laneRows.push({ lane, id, published, listedUntil: lane.startsWith(NOTABLE_LANE_PREFIX) ? keepUntil : null });
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const { from, into } of folded) {
    statements.push(
      db.prepare('UPDATE work_keys SET work_id = ? WHERE work_id = ?').bind(into, from),
      // A lane both rows are in keeps the later notable listing date.
      db.prepare(`INSERT INTO work_lanes (lane, work_id, published, listed_until)
        SELECT lane, ?, published, listed_until FROM work_lanes WHERE work_id = ?
        ON CONFLICT (lane, work_id) DO UPDATE SET listed_until = excluded.listed_until
          WHERE excluded.listed_until > work_lanes.listed_until`).bind(into, from),
      db.prepare('DELETE FROM work_lanes WHERE work_id = ?').bind(from),
      db.prepare('DELETE FROM work_vectors WHERE work_id IN (?, ?)').bind(from, into),
      db.prepare('DELETE FROM works WHERE id = ?').bind(from),
    );
  }
  for (let start = 0; start < withdrawn.length; start += WRITE_CHUNK) {
    statements.push(db.prepare('DELETE FROM work_lanes WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(withdrawn.slice(start, start + WRITE_CHUNK))));
  }
  for (let start = 0; start < staleVectors.length; start += WRITE_CHUNK) {
    statements.push(db.prepare('DELETE FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(staleVectors.slice(start, start + WRITE_CHUNK))));
  }
  for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
    statements.push(db.prepare(`INSERT INTO works (id, paper, published, kept_until)
      SELECT value ->> 'id', value ->> 'paper', value ->> 'published', value ->> 'keptUntil' FROM json_each(?) WHERE true
      ON CONFLICT (id) DO UPDATE SET paper = excluded.paper, published = excluded.published,
        kept_until = max(works.kept_until, excluded.kept_until)`).bind(JSON.stringify(rows.slice(start, start + WRITE_CHUNK))));
  }
  for (let start = 0; start < keyRows.length; start += WRITE_CHUNK * 4) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO work_keys (key, work_id)
      SELECT value ->> 'key', value ->> 'id' FROM json_each(?)`).bind(JSON.stringify(keyRows.slice(start, start + WRITE_CHUNK * 4))));
  }
  for (let start = 0; start < laneRows.length; start += WRITE_CHUNK * 4) {
    statements.push(db.prepare(`INSERT INTO work_lanes (lane, work_id, published, listed_until)
      SELECT value ->> 'lane', value ->> 'id', value ->> 'published', value ->> 'listedUntil' FROM json_each(?) WHERE true
      ON CONFLICT (lane, work_id) DO UPDATE SET published = excluded.published, listed_until = excluded.listed_until
        WHERE published != excluded.published OR listed_until IS NOT excluded.listed_until`).bind(JSON.stringify(laneRows.slice(start, start + WRITE_CHUNK * 4))));
  }
  for (let start = 0; start < statements.length; start += 50) await db.batch(statements.slice(start, start + 50));
  const candidates = articles.filter(article => workingPaperGroups.has(groupOfKey.get(`id:${article.id.toLowerCase()}`)!));
  return rows.length + await upgradeWorkingPapers(db, candidates, now);
}

/**
 * Rewrites stored papers after an enrichment merged into them. Same rules as
 * `ingestPapers` for the vector and the lanes; nothing else changes. A few
 * statements per chunk of papers: D1 counts each against the invocation.
 */
export async function rewriteWorks(env: StoreEnv, updates: Array<{ id: number; before: Paper; after: Paper }>, now = Date.now()) {
  const db = database(env);
  const since = daysFromNow(-CORPUS_DAYS, now);
  // Compared as stored: every OpenAlex merge adds back the payload a row drops.
  const updated = updates
    .map(({ id, before, after }) => ({ id, before, paper: storedPaper(after) }))
    .filter(({ before, paper }) => JSON.stringify(before) !== JSON.stringify(paper))
    .map(update => ({ ...update, published: publishedOf(update.paper, now) || publishedOf(update.before, now) }));
  const followed = await followedLanesAmong(db, updated.flatMap(({ paper, published }) => (published >= since ? followOnlyLanes(paper) : [])));
  const changed = updated.map(({ id, before, paper, published }) => ({
    text: { id, paper: JSON.stringify(paper) },
    filing: {
      id,
      published,
      textChanged: embeddingText(paper) !== embeddingText(before),
      // A book, an erratum or another type the feed does not show, or a
      // retracted paper, leaves every lane once the enrichment reveals it.
      offered: isFeedPublication(paper),
      keys: workKeys(paper),
      lanes: published >= since ? recordLanes(paper, followed) : [],
    },
  }));
  // A D1 call carries at most 32 MiB: each chunk is its own batch, and only
  // the first statement is sent the papers' text (2026-10-23: 500 enriched
  // papers bound five times over came to 33.6 MB).
  for (let start = 0; start < changed.length; start += WRITE_CHUNK) {
    const slice = changed.slice(start, start + WRITE_CHUNK);
    const chunk = JSON.stringify(slice.map(change => change.filing));
    await db.batch([
      db.prepare(`UPDATE works SET paper = j.value ->> 'paper' FROM json_each(?) j WHERE works.id = j.value ->> 'id'`)
        .bind(JSON.stringify(slice.map(change => change.text))),
      db.prepare(`DELETE FROM work_vectors WHERE work_id IN (SELECT value ->> 'id' FROM json_each(?) WHERE value ->> 'textChanged')`).bind(chunk),
      db.prepare(`INSERT OR IGNORE INTO work_keys (key, work_id)
        SELECT k.value, j.value ->> 'id' FROM json_each(?) j, json_each(j.value -> 'keys') k`).bind(chunk),
      db.prepare(`INSERT OR IGNORE INTO work_lanes (lane, work_id, published)
        SELECT l.value, j.value ->> 'id', j.value ->> 'published' FROM json_each(?) j, json_each(j.value -> 'lanes') l
        WHERE j.value ->> 'offered'`).bind(chunk),
      db.prepare(`DELETE FROM work_lanes WHERE work_id IN (SELECT value ->> 'id' FROM json_each(?) WHERE NOT (value ->> 'offered'))`).bind(chunk),
    ]);
  }
  return changed.length;
}

/**
 * What the corpus no longer needs leaves with its keys, lanes and vector:
 * - a lane keeps its newest FEED_CANDIDATE_LIMIT papers, the most a page can
 *   ever rank from an asked lane, so a busy category does not pile up papers
 *   no reader reaches. An area lane keeps as many though a page reads fewer:
 *   its older articles can still be filed under a leaf (leaf-filing.ts);
 * - a notable lane drops a paper once its `listed_until` has passed, 14 days
 *   after the listing that last returned it: the lane holds the leaf's most
 *   cited, whatever else keeps the paper (a like, its date, another lane);
 * - a paper leaves the lane of an author, concept or institution nobody
 *   follows: `recordLanes` files those for followed entities only, and the
 *   rows filed before it did go here. A later follow of that entity starts
 *   without those papers, until its own harvest lists them;
 * - a paper past its keeping date, or in no category, notable, working-paper,
 *   area or followed lane, goes, unless readers still rank their feed by it
 *   (`liked_until`). A topic lane nobody follows keeps nothing: nearly every
 *   enriched paper names a topic, so it would keep every paper its category
 *   trimmed. A retracted paper, which no lane holds, stays until its keeping
 *   date, which each listing of it renews: a later listing then finds it
 *   retracted instead of filing it again.
 */
// Each Workflow step scans at most 500 works. It reads the JSON only of a
// work no lane keeps, for its retraction.
// The cursor is a primary key, so retries and deletions do not shift a page.
export async function evictExpired(env: StoreEnv, now = Date.now(), after = 0): Promise<number | null> {
  const db = database(env);
  const cutoff = new Date(now).toISOString();
  const notableLanes = [...LEAF_IDS].map(leaf => `${NOTABLE_LANE_PREFIX}${leaf}`);
  if (after === 0) {
    await db.prepare('DELETE FROM work_lanes WHERE lane IN (SELECT value FROM json_each(?)) AND listed_until < ?')
      .bind(JSON.stringify(notableLanes), cutoff).run();
    const { results: crowded } = await db.prepare('SELECT lane FROM work_lanes GROUP BY lane HAVING COUNT(*) > ? LIMIT 10')
      .bind(FEED_CANDIDATE_LIMIT).all<{ lane: string }>();
    if (crowded.length) {
      for (const { lane } of crowded) {
        await db.prepare(`DELETE FROM work_lanes WHERE lane = ? AND work_id IN (
          SELECT work_id FROM work_lanes WHERE lane = ? ORDER BY published DESC LIMIT 500 OFFSET ?)`).bind(lane, lane, FEED_CANDIDATE_LIMIT).run();
      }
      return 0;
    }
  }
  const ahead = new Date(now + DAY_MS).toISOString();
  const keeping = JSON.stringify([...LEAF_IDS, ...notableLanes, WORKING_PAPERS_LANE, ...AREA_LANE_AREAS.map(areaLane)]);
  const { results: scanned } = await db.prepare('SELECT id FROM works WHERE id > ? ORDER BY id LIMIT 500')
    .bind(after).all<{ id: number }>();
  if (scanned.length) {
    const ids = JSON.stringify(scanned.map(row => row.id));
    // Recheck retention inside the transaction: a like or harvest can arrive
    // after the scan. Every scanned work leaves its unfollowed entity lanes;
    // other child rows go only for works actually deleted.
    await db.batch([
      db.prepare(`DELETE FROM work_lanes WHERE work_id IN (SELECT value FROM json_each(?))
        AND substr(lane, 1, instr(lane, ':') - 1) IN (SELECT value FROM json_each(?))
        AND lane NOT IN (SELECT lane FROM followed_lanes)`).bind(ids, JSON.stringify(PRUNED_ENTITY_LANE_KINDS)),
      db.prepare(`DELETE FROM works WHERE id IN (SELECT value FROM json_each(?))
        AND (liked_until IS NULL OR liked_until < ?) AND (kept_until < ? OR published > ?
          OR (NOT EXISTS (SELECT 1 FROM work_lanes l WHERE l.work_id = works.id
            AND (l.lane IN (SELECT value FROM json_each(?)) OR l.lane IN (SELECT lane FROM followed_lanes)))
            AND paper ->> '$.publicationStatus' IS NOT 'retracted'))`)
        .bind(ids, cutoff, cutoff, ahead, keeping),
      db.prepare(`DELETE FROM work_keys WHERE work_id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM works WHERE id = work_keys.work_id)`).bind(ids),
      db.prepare(`DELETE FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM works WHERE id = work_vectors.work_id)`).bind(ids),
      db.prepare(`DELETE FROM work_lanes WHERE work_id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM works WHERE id = work_lanes.work_id)`).bind(ids),
    ]);
  }
  return scanned.length === 500 ? scanned.at(-1)!.id : null;
}

// A leaf with fewer papers than this published in the last LEAF_FLOOR_DAYS is
// to be proposed to the OpenAlex topic-lane gate
// (scripts/README-openalex-leaf-topics.md) (Nicolás, 2026-10-24).
const LEAF_FLOOR = 300;
const LEAF_FLOOR_DAYS = 30;

/** The leaves under LEAF_FLOOR, fewest first, for the nightly run to report. */
export async function thinLeaves(db: D1Database, now: number): Promise<Array<{ leaf: string; recent: number }>> {
  const { results } = await db.prepare(`SELECT lane, COUNT(*) AS recent FROM work_lanes
    WHERE lane IN (SELECT value FROM json_each(?)) AND published >= ? GROUP BY lane`)
    .bind(JSON.stringify([...LEAF_IDS]), daysFromNow(-LEAF_FLOOR_DAYS, now)).all<{ lane: string; recent: number }>();
  const recent = new Map(results.map(row => [row.lane, row.recent]));
  return [...LEAF_IDS].map(leaf => ({ leaf, recent: recent.get(leaf) ?? 0 }))
    .filter(entry => entry.recent < LEAF_FLOOR)
    .sort((a, b) => a.recent - b.recent || a.leaf.localeCompare(b.leaf));
}

// The Workflows API keeps a step's output cut at about 1,000 characters, ending
// in `[truncated output]`, whatever `--truncate-output-limit` is passed to
// `wrangler workflows instances describe` (2026-10-25: a list of 140 leaves
// stopped at the fortieth). So the step returns the count and the thinnest
// THIN_LEAVES_SHOWN, and the whole list goes to the Worker's log.
const THIN_LEAVES_SHOWN = 30;

/** What the `thin leaves` step logs (every leaf) and returns (what `describe` can show). */
export function thinLeavesReport(thin: Array<{ leaf: string; recent: number }>) {
  const entry = ({ leaf, recent }: { leaf: string; recent: number }) => `${leaf}:${recent}`;
  return {
    line: `${thin.length} leaves under ${LEAF_FLOOR} papers in ${LEAF_FLOOR_DAYS} days: ${thin.map(entry).join(' ')}`,
    summary: { under: thin.length, thinnest: thin.slice(0, THIN_LEAVES_SHOWN).map(entry) },
  };
}

// ─── Embedding ───

const estimatedTokens = (texts: string[]) => texts.reduce((sum, value) => sum + Math.ceil(value.length / 3), 0);

/**
 * A share of the day's embedding limit: a ledger subject, and the most it may reserve.
 * `part` is a second subject that several shares count against together, with
 * its limit in ledger units (1,000 tokens).
 */
interface EmbeddingShare { subject: string; tokens: number; part?: QuotaPart }

/**
 * Reserves the embedding tokens for today before spending them, within
 * `share` when given and the day's limit always. Workers AI bills past the
 * free allocation, so a ledger that cannot answer refuses.
 */
async function reserveEmbeddingTokens(env: StoreEnv, tokens: number, share?: EmbeddingShare) {
  const limit = Math.floor((Number(env.EMBEDDING_DAILY_TOKEN_LIMIT) || DEFAULT_EMBEDDING_DAILY_TOKEN_LIMIT) / EMBEDDING_TOKENS_PER_UNIT);
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, {
    periodKey: `embedding:day:${new Date().toISOString().slice(0, 10)}`,
    subject: share?.subject ?? 'embedding:all',
    subjectLimit: share ? Math.min(limit, share.tokens / EMBEDDING_TOKENS_PER_UNIT) : limit,
    globalLimit: limit,
    amount: Math.max(1, Math.ceil(tokens / EMBEDDING_TOKENS_PER_UNIT)),
    part: share?.part,
  });
  if (reservation.code) console.error(`Embedding budget unavailable (${reservation.code}); nothing embedded`);
  return reservation.accepted === true;
}

async function embedBatch(env: StoreEnv, texts: string[]) {
  if (typeof env.AI?.run !== 'function') throw new PaperStoreError('EMBEDDINGS_UNAVAILABLE', 503);
  const { data } = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  if (!Array.isArray(data) || data.length !== texts.length || data.some(vector => vector?.length !== EMBEDDING_DIMENSIONS)) {
    throw new PaperStoreError('EMBEDDINGS_INVALID', 502);
  }
  return data.map(quantize);
}

// A batch Workers AI refuses is asked again a text at a time, so one paper it
// cannot embed is left without a vector instead of holding back the others.
async function embedTexts(env: StoreEnv, texts: string[]) {
  const vectors: Array<Int8Array | null> = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    try {
      vectors.push(...await embedBatch(env, batch));
    } catch (error) {
      if (error instanceof PaperStoreError && error.code === 'EMBEDDINGS_UNAVAILABLE') throw error;
      for (const text of batch) vectors.push(await embedBatch(env, [text]).then(([vector]) => vector, () => null));
    }
  }
  return vectors;
}

/**
 * Embeds the rows' title and abstract within today's budget, and `share` of it
 * when given, and stores the vectors. Returns how many were embedded: 0 when
 * the budget is spent.
 */
async function embedRows(env: StoreEnv, rows: Array<{ id: number; paper: string }>, share?: EmbeddingShare) {
  if (rows.length === 0) return 0;
  const db = database(env);
  const texts = rows.map(row => embeddingText(JSON.parse(row.paper) as Paper));
  if (!(await reserveEmbeddingTokens(env, estimatedTokens(texts), share))) {
    // Not embedded: another pass, or another reader with budget left, may.
    await db.prepare('UPDATE works SET embedding_claimed_until = NULL WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(rows.map(row => row.id))).run();
    return 0;
  }
  const vectors = await embedTexts(env, texts);
  const embedded = rows.flatMap((row, index) => (vectors[index] ? [{ id: row.id, vector: vectors[index] }] : []));
  // Two parameters a row, under D1's hundred per statement.
  const statements = [];
  for (let start = 0; start < embedded.length; start += 50) {
    const chunk = embedded.slice(start, start + 50);
    statements.push(db.prepare(`INSERT OR REPLACE INTO work_vectors (work_id, embedding) VALUES ${chunk.map(() => '(?, ?)').join(',')}`)
      .bind(...chunk.flatMap(row => [row.id, row.vector.buffer])));
  }
  if (statements.length) await db.batch(statements);
  return embedded.length;
}

// How long a pass holds the papers it embeds: longer than the harvest step that
// runs it may take (5 minutes), so no other pass embeds them meanwhile. A pass
// that failed leaves them to the next one after this.
const EMBEDDING_CLAIM_MS = 10 * 60_000;

/**
 * Claims the newest works `scope` names (a condition on `w`, and its
 * parameters) that have no vector and that no other pass holds, in one
 * statement: passes that overlap, such as the daily run beside a followed
 * lanes' run or a reader's lookup, get different works.
 */
async function claimUnembedded(db: D1Database, scope: string, params: unknown[], limit: number, now = Date.now()) {
  const { results } = await db.prepare(`UPDATE works SET embedding_claimed_until = ? WHERE id IN (
      SELECT w.id FROM works w WHERE ${scope}
        AND NOT EXISTS (SELECT 1 FROM work_vectors v WHERE v.work_id = w.id)
        AND (w.embedding_claimed_until IS NULL OR w.embedding_claimed_until < ?)
      ORDER BY w.published DESC LIMIT ?)
    RETURNING id, paper`)
    .bind(new Date(now + EMBEDDING_CLAIM_MS).toISOString(), ...params, new Date(now).toISOString(), limit)
    .all<{ id: number; paper: string }>();
  return results;
}

/**
 * The newest stored papers without a vector, embedded. 0 once none are left or
 * today's budget is spent. With `lanes`, a run for new follows: only those
 * lanes' papers, within the follow runs' share of the day.
 */
export async function embedPending(env: StoreEnv, limit: number, { lanes }: { lanes?: string[] } = {}) {
  if (!lanes) return embedRows(env, await claimUnembedded(database(env), 'true', [], limit));
  const rows = await claimUnembedded(database(env), 'w.id IN (SELECT work_id FROM work_lanes WHERE lane IN (SELECT value FROM json_each(?)))', [JSON.stringify(lanes)], limit);
  return embedRows(env, rows, { subject: 'embedding:follows', tokens: FOLLOW_RUNS_EMBEDDING_DAILY_TOKENS });
}

/** Embed these works within the daily budget; a reader's lookup also uses that reader's share and the readers' combined one. */
export async function embedWorks(env: StoreEnv, workIds: number[], uid: string | undefined) {
  if (workIds.length === 0) return 0;
  const rows = await claimUnembedded(database(env), 'w.id IN (SELECT value FROM json_each(?))', [JSON.stringify(workIds)], workIds.length);
  return embedRows(env, rows, uid === undefined ? undefined : {
    subject: `uid:${uid}`,
    tokens: READER_EMBEDDING_DAILY_TOKENS,
    part: { subject: 'embedding:readers', limit: READERS_EMBEDDING_DAILY_TOKENS / EMBEDDING_TOKENS_PER_UNIT },
  });
}

// ─── Reading ───

// The ranking's order: the higher score first, then the newer date. A sort
// keeps the candidates' order where both are equal.
const scoreOrder = (score: number, published: string, otherScore: number, otherPublished: string) => otherScore - score || otherPublished.localeCompare(published);

/**
 * How near a copy of the closest rejected paper a unit vector is: 0 up to
 * NEGATIVE_SIMILARITY_THRESHOLD, rising linearly to 1 at an identical vector.
 */
function rejection(embedding: Float64Array | null, rejectedVectors: Float64Array[]) {
  const rejectedSimilarity = embedding
    ? rejectedVectors.reduce((best, negative) => Math.max(best, cosine(embedding, negative)), 0) : 0;
  return Math.max(0, (rejectedSimilarity - NEGATIVE_SIMILARITY_THRESHOLD) / (1 - NEGATIVE_SIMILARITY_THRESHOLD));
}

/**
 * Semantic relevance with near-copy rejection and a bounded diversity pass.
 * Missing vectors retain recency so the feed remains usable during embedding.
 * Rows it cannot tell apart keep their order (`readCandidates`).
 * A request ranks through `rankByUnitVectors`; this entry, which normalizes
 * every vector it is given, is the one the ranking tests call.
 */
export function rankBySimilarity<T extends { embedding: Int8Array | null; published: string }>(rows: T[], positives: Int8Array[], { now = Date.now(), order = 'recent', negatives = [] }: { now?: number; order?: keyof typeof RECENCY_WEIGHT; negatives?: Int8Array[] } = {}) {
  return rankByUnitVectors(rows, row => (row.embedding ? unitVector(row.embedding) : null), positives.map(unitVector), negatives.map(unitVector), { now, order });
}

/**
 * `rankBySimilarity` over vectors already normalized (`unitVector`), so a
 * request normalizes each candidate and like once, however many interest
 * groups rank it.
 */
function rankByUnitVectors<T extends { published: string }>(rows: T[], unitOf: (row: T) => Float64Array | null, likedVectors: Float64Array[], rejectedVectors: Float64Array[], { now, order }: { now: number; order: keyof typeof RECENCY_WEIGHT }) {
  const scoreOf = scorer(likedVectors, rejectedVectors, { now, order });
  const ranked = rows
    .map(row => {
      const embedding = unitOf(row);
      const { score, semanticScore } = scoreOf(embedding, row.published);
      return { row, embedding, score, semanticScore };
    })
    .sort((a, b) => scoreOrder(a.score, a.row.published, b.score, b.row.published));
  if (!likedVectors.length && !rejectedVectors.length) return ranked;
  // Limit both the pool and selected prefix: a full 4,000 x 4,000 MMR pass
  // would dominate Worker CPU. The untouched tail remains available.
  const pool = ranked.slice(0, DIVERSITY_POOL);
  const selected = pool.every(candidate => Number.isFinite(candidate.score)) ? selectDiverse(pool) : selectDiverseEagerly(pool);
  const chosen = new Set(selected);
  return [...selected, ...ranked.filter(candidate => !chosen.has(candidate))];
}

/**
 * A candidate's score by these likes and rejections, from its unit vector
 * (null when it has none) and its date. Without a vector, or near no
 * rejection, a candidate without likes scores its recency alone, the most it
 * can score (`readDecidingVectors`).
 */
function scorer(likedVectors: Float64Array[], rejectedVectors: Float64Array[], { now, order }: { now: number; order: keyof typeof RECENCY_WEIGHT }) {
  const weight = RECENCY_WEIGHT[order] ?? RECENCY_WEIGHT.recent;
  const recency = (published: string) => 0.5 ** (Math.max(0, now - Date.parse(published)) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
  return (embedding: Float64Array | null, published: string) => {
    const similarity = likedVectors.length && embedding
      ? likedVectors.reduce((best, positive) => Math.max(best, cosine(embedding, positive)), -1) : 0;
    const negative = rejection(embedding, rejectedVectors);
    // A fixed scale keeps an uninformative page from stretching its best
    // match to 100%. The client's contribution is bounded independently.
    const semanticScore = Math.max(0, Math.min(1, (similarity - 0.4) / 0.4)) - negative;
    return { score: similarity - NEGATIVE_WEIGHT * negative + weight * recency(published), semanticScore };
  };
}

interface DiversityCandidate { embedding: Float64Array | null; score: number }

// How much a selected paper lowers a candidate's score: none below a cosine of
// 0.75, DIVERSITY_WEIGHT at a copy, of the closest one selected.
const redundancyTo = (selected: Float64Array, candidate: Float64Array) => Math.max(0, (cosine(selected, candidate) - 0.75) / 0.25);

/**
 * The first DIVERSITY_RANKS of `pool` (in score order), one at a time: the
 * candidate whose score less DIVERSITY_WEIGHT times its redundancy is highest,
 * the earliest in `pool` on a tie. A candidate's redundancy only grows as
 * papers are selected, so the value it had when last compared is an upper
 * bound: candidates wait in a heap by that bound, and only the one on top is
 * compared with the papers selected since. When it still leads, it is the one
 * comparing every candidate with every selected paper would pick. Typically a
 * fraction of the 150 x 500 comparisons.
 */
function selectDiverse<C extends DiversityCandidate>(pool: C[]): C[] {
  interface Entry { candidate: C; position: number; redundancy: number; adjusted: number; compared: number }
  const leads = (a: Entry, b: Entry) => a.adjusted > b.adjusted || (a.adjusted === b.adjusted && a.position < b.position);
  // Sorted by score, the pool is already a heap: no redundancy yet, and a tie
  // keeps the earlier position on top.
  const heap: Entry[] = pool.map((candidate, position) => ({ candidate, position, redundancy: 0, adjusted: candidate.score, compared: 0 }));
  const siftDown = (from: number) => {
    let index = from;
    for (;;) {
      const left = 2 * index + 1;
      let top = index;
      if (left < heap.length && leads(heap[left], heap[top])) top = left;
      if (left + 1 < heap.length && leads(heap[left + 1], heap[top])) top = left + 1;
      if (top === index) return;
      [heap[index], heap[top]] = [heap[top], heap[index]];
      index = top;
    }
  };
  const take = () => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      siftDown(0);
    }
    return first;
  };
  const selected: C[] = [];
  // The selected papers' vectors, in the order they were selected.
  const selectedVectors: Float64Array[] = [];
  while (heap.length && selected.length < DIVERSITY_RANKS) {
    const top = heap[0];
    const embedding = top.candidate.embedding;
    if (embedding && top.compared < selectedVectors.length) {
      for (; top.compared < selectedVectors.length; top.compared += 1) {
        top.redundancy = Math.max(top.redundancy, redundancyTo(selectedVectors[top.compared], embedding));
      }
      top.adjusted = top.candidate.score - DIVERSITY_WEIGHT * top.redundancy;
      siftDown(0);
      continue;
    }
    const { candidate } = take();
    selected.push(candidate);
    if (candidate.embedding) selectedVectors.push(candidate.embedding);
  }
  return selected;
}

// What `selectDiverse` does, comparing every candidate on every turn: for a
// pool with a score that is not a number (a date that does not parse), which
// no order ranks consistently.
function selectDiverseEagerly<C extends DiversityCandidate>(candidates: C[]): C[] {
  const pool = candidates.map(candidate => ({ candidate, redundancy: 0 }));
  const selected: C[] = [];
  while (pool.length && selected.length < DIVERSITY_RANKS) {
    let best = 0;
    for (let index = 1; index < pool.length; index += 1) {
      if (pool[index].candidate.score - DIVERSITY_WEIGHT * pool[index].redundancy > pool[best].candidate.score - DIVERSITY_WEIGHT * pool[best].redundancy) best = index;
    }
    const [{ candidate }] = pool.splice(best, 1);
    selected.push(candidate);
    const embedding = candidate.embedding;
    if (embedding) {
      for (const entry of pool) {
        if (entry.candidate.embedding) entry.redundancy = Math.max(entry.redundancy, redundancyTo(embedding, entry.candidate.embedding));
      }
    }
  }
  return selected;
}

export async function reserveFeedRequest(env: StoreEnv & Pick<WorkerEnv, 'PROVIDER_USER_MINUTE_LIMIT' | 'PROVIDER_GLOBAL_MINUTE_LIMIT'>, uid: string) {
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, {
    periodKey: `store-feed:${new Date().toISOString().slice(0, 16)}`,
    subject: `uid:${uid}`,
    subjectLimit: Math.floor(Number(env.PROVIDER_USER_MINUTE_LIMIT)) || DEFAULT_FEED_USER_MINUTE_LIMIT,
    globalLimit: Math.floor(Number(env.PROVIDER_GLOBAL_MINUTE_LIMIT)) || DEFAULT_FEED_GLOBAL_MINUTE_LIMIT,
  });
  // The ceiling guards a D1 read, not a paid provider: a ledger that cannot
  // answer lets the page through rather than taking the feed down with it.
  if (!reservation.accepted && !reservation.code) throw new PaperStoreError('RATE_LIMITED', 429);
}

/** Work ids of the papers these app ids name, with whether each has a vector. */
export async function findWorks(db: D1Database, paperIds: string[]) {
  const keysById = new Map(paperIds.map(id => [id, keysForPaperId(id)]));
  const found = await lookUpKeys(db, [...new Set([...keysById.values()].flat())]);
  const workByPaperId = new Map<string, number>();
  for (const [id, keys] of keysById) {
    const workId = keys.map(key => found.get(key)).find(value => value !== undefined);
    if (workId !== undefined) workByPaperId.set(id, workId);
  }
  return workByPaperId;
}

/** Keeps these liked works for KEEP_LIKED_DAYS, past their keeping date and outside every lane (`evictExpired`). */
export async function keepLiked(db: D1Database, workIds: number[], now = Date.now()) {
  if (workIds.length === 0) return;
  await db.prepare(`UPDATE works SET liked_until = ? FROM json_each(?) j WHERE works.id = j.value
    AND (works.liked_until IS NULL OR works.liked_until < ?)`)
    .bind(daysFromNow(KEEP_LIKED_DAYS, now), JSON.stringify(workIds), daysFromNow(KEEP_LIKED_DAYS - 1, now)).run();
}

interface Candidate { workId: number; published: string; lanes: string[] }

// One statement per lane, in one batch: D1 refuses a compound SELECT of more
// than a few terms ("too many terms in compound SELECT"), and a reader asks
// for up to a dozen categories and twenty follows. The candidates come in
// turns across the lanes, each lane's newest first, and the ranking keeps that
// order among papers it cannot tell apart: one night's articles of two areas
// share their date, and take turns between the areas instead of following the
// order the lanes were asked in.
async function readCandidates(db: D1Database, lanes: string[]): Promise<Candidate[]> {
  const areaLanes = lanes.filter(lane => AREA_LANES.has(lane)).length;
  const share = (lane: string) => (AREA_LANES.has(lane)
    ? Math.floor(AREA_CANDIDATE_LIMIT / areaLanes)
    : Math.ceil(FEED_CANDIDATE_LIMIT / (lanes.length - areaLanes)));
  const perLane = await db.batch<{ work_id: number; published: string }>(lanes.map(lane => db.prepare(
    'SELECT work_id, published FROM work_lanes WHERE lane = ? ORDER BY published DESC LIMIT ?',
  ).bind(lane, share(lane))));
  return mergeLaneRows(lanes, perLane);
}

/**
 * The notable lanes at `now`, in two round trips: `candidates` are, of each
 * year of the window, the NOTABLE_READ_PER_YEAR rows of the day's slice,
 * newest first; `inLanes` is every work the lanes hold in the window, slice
 * or not. A notable lane keeps a paper two weeks past its last listing; from
 * 1 January, the year that left the window is not read, and a row of the
 * current year (a listing before the by-year one, a merge dated this year) is
 * not read until that year is over.
 */
export async function readNotableCandidates(db: D1Database, lanes: string[], now: number, timings?: FeedTimings): Promise<{ candidates: Candidate[]; inLanes: Set<number> }> {
  // Each lane's window in the order of `work_lanes_recent`, whose entries end
  // with the primary key's work id, so D1 reads each row once: numbering the
  // years in SQL with window functions sorted the rows into temporary tables,
  // about eight rows read a row (ENG-150).
  const perLane = await db.batch<{ work_id: number; published: string }>(lanes.map(lane => db.prepare(
    'SELECT work_id, published FROM work_lanes WHERE lane = ? AND published >= ? AND published < ? ORDER BY published DESC, work_id',
  ).bind(lane, notableSince(now), `${new Date(now).getUTCFullYear()}-01-01`)));
  const slices = perLane.map(({ results }) => daySlice(results, Math.floor(now / DAY_MS) * NOTABLE_READ_PER_YEAR));
  // OpenAlex's listing leaves out what OpenAlex marks retracted and Europe
  // PMC's what PubMed types as retracted; ADS's cannot, so a paper ADS listed
  // is offered once the enrichment has looked it up in OpenAlex (`enriched_at`),
  // which is what learns a retraction (README step 5). Asked only for the day's
  // slice. The enrichment can rewrite a paper between the two round trips, and
  // a retracted paper or an erratum leaves every lane: a slice row is offered
  // only if its lane still holds it.
  const offered = lanes.map(() => new Set<number>());
  const asked = slices.flatMap((slice, index) => (slice.length === 0 ? [] : [index]));
  if (asked.length) {
    const started = Date.now();
    const answers = await db.batch<{ id: number }>(asked.map(index => db.prepare(`SELECT w.id FROM json_each(?) j JOIN works w ON w.id = j.value
      WHERE (w.enriched_at IS NOT NULL OR w.paper ->> '$.adsBibcode' IS NULL)
        AND EXISTS (SELECT 1 FROM work_lanes l WHERE l.lane = ? AND l.work_id = w.id)`)
      .bind(JSON.stringify(slices[index].map(row => row.work_id)), lanes[index])));
    timings?.since('notableCheck', started);
    answers.forEach(({ results }, answer) => results.forEach(row => offered[asked[answer]].add(row.id)));
  }
  return {
    candidates: mergeLaneRows(lanes, slices.map((slice, index) => ({ results: slice.filter(row => offered[index].has(row.work_id)) }))),
    inLanes: new Set(perLane.flatMap(({ results }) => results.map(row => row.work_id))),
  };
}

/**
 * The rows of the day's slice, in their order: the rows of each year are
 * numbered from 0 in the order given, and the slice holds those whose number
 * plus `offset`, modulo the year's count, is under NOTABLE_READ_PER_YEAR.
 */
function daySlice<T extends { published: string }>(rows: T[], offset: number) {
  const year = (row: T) => row.published.slice(0, 4);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(year(row), (counts.get(year(row)) ?? 0) + 1);
  const numbered = new Map<string, number>();
  return rows.filter(row => {
    const number = numbered.get(year(row)) ?? 0;
    numbered.set(year(row), number + 1);
    return (number + offset) % counts.get(year(row))! < NOTABLE_READ_PER_YEAR;
  });
}

// The lanes' rows in turns, each lane's in its own order: a work listed by
// several lanes comes once, at its first turn, with every lane and its newest date.
function mergeLaneRows(lanes: string[], perLane: Array<{ results: Array<{ work_id: number; published: string }> }>): Candidate[] {
  const byWork = new Map<number, { published: string; lanes: string[] }>();
  const longest = Math.max(...perLane.map(({ results }) => results.length));
  for (let position = 0; position < longest; position += 1) {
    perLane.forEach(({ results }, index) => {
      const row = results[position];
      if (!row) return;
      const candidate = byWork.get(row.work_id);
      if (!candidate) byWork.set(row.work_id, { published: row.published, lanes: [lanes[index]] });
      else {
        candidate.lanes.push(lanes[index]);
        if (row.published > candidate.published) candidate.published = row.published;
      }
    });
  }
  return [...byWork].map(([workId, candidate]) => ({ workId, ...candidate }));
}

// The works' vectors, a statement for each 2,000 of them, in one round trip.
// As hex text: D1 answers a BLOB as a JSON array of its bytes, about 840
// bytes and 256 numbers to parse for a vector of 256, where its hex is one
// string of 512 characters.
async function readVectors(db: D1Database, workIds: number[], vectors = new Map<number, Int8Array>()) {
  const chunks: D1PreparedStatement[] = [];
  for (let start = 0; start < workIds.length; start += 2_000) {
    chunks.push(db.prepare('SELECT v.work_id, hex(v.embedding) AS embedding FROM json_each(?) j JOIN work_vectors v ON v.work_id = j.value')
      .bind(JSON.stringify(workIds.slice(start, start + 2_000))));
  }
  if (chunks.length === 0) return vectors;
  for (const { results } of await db.batch<{ work_id: number; embedding: string }>(chunks)) {
    results.forEach(row => vectors.set(row.work_id, readVector(row.embedding)));
  }
  return vectors;
}

export interface FeedFollow { type: PaperFollowMatch['type']; canonicalId: string; displayName?: string; lane: string }

/**
 * Categories ranked apart by their own likes (ENG-137), and their share of the
 * page by weight. `exampleCategories` claim the request's likes that no group
 * names: those whose stored paper is in one of them.
 */
export interface FeedGroup { categories: string[]; exampleCategories: string[]; positiveIds: string[]; weight: number }

export interface FeedQuery {
  // Every group's, for the lanes, notable papers and `_fetchedFor`.
  categories: string[];
  follows: FeedFollow[];
  // Every group's and the likes no group names, for exclusion, lookups and notable papers.
  positiveIds: string[];
  groups: FeedGroup[];
  negativeIds: string[];
  excludedIds: string[];
  page: number;
  pageSize: number;
  order: keyof typeof RECENCY_WEIGHT;
  // The papers the reader has seen (`feedSeenFilter`). Without it, no notable
  // papers come.
  seen: BloomFilter | null;
  // The page passes over the papers `seen` holds (PAP-103). Without it, `page`
  // names the page: apps that send `seen` only for notable papers page by number.
  skipsSeen: boolean;
  // A page that skips seen papers, asked for past the last page (`page` then
  // holds the last): when its walk finds no unseen paper, it has no papers.
  pastLastPage: boolean;
  // A first page that skips seen papers and goes on with the walk of the
  // order kept under its key, as a later page does, rather than start a new
  // one: the app asks for it after a change of follows (ENG-103).
  continues: boolean;
  // How many unseen notable papers the page adds after its own, at most.
  notable: number;
  // Whether the page also reads the area lanes of the asked categories' areas.
  areaLanes: boolean;
}

/**
 * A page of corpus papers in the asked categories and followed entities,
 * ordered by the closest of the reader's liked or saved papers, or newest
 * first without any. Each paper says which asked categories it was found in
 * (`_fetchedFor`) and which follows (`_followedEntityMatches`).
 */
/**
 * A reader's ranked candidates, kept for the pages after the first. `paperId`
 * is the app's id of the paper once a page with `seen` has read it from its
 * row to check it against the filter, '' when the corpus no longer holds the
 * work: the next pages check it against theirs without reading it again.
 */
export interface RankedCandidate { workId: number; lanes: string[]; semanticScore?: number; paperId?: string }
/**
 * The order a reader's pages were served from, in an entry of the reader's
 * alone, kept from the last page that changed it for WALK_KEPT_MS when its
 * pages skip seen papers, RANKING_KEPT_MS otherwise. `served`
 * counts the ranks of the pages served by their numbers, including the empty
 * ones of a page the order ran out on, which `ranks` holds as null.
 *
 * A page that skips seen papers walks the order from `walked`, the rank of the
 * first paper the last walk sent: that walk's filter held every rank before
 * it, or the corpus had dropped the work. A filter holds only the reader's
 * 2,000 most recent papers, so a walk from the top would send again the ones
 * seen before those; one that a page sent and the app never got is sent again.
 * `notable` is the asked categories' notable papers, which no rank holds,
 * walked the same way from `notableWalked`: closest first with a liked
 * vector, otherwise the years in turns (`notableYearsInTurns`), near copies of
 * rejected papers last.
 *
 * A `final` order ranked less than 15 minutes ago (`rankedAt`) by the same
 * lanes in the same order, `order`, likes, rejections and interest groups
 * (`rankedBy`, a digest, so the entry holds no liked paper's id) serves the
 * next pages as it is. Otherwise a next page keeps the ranks served and the
 * ones walked past, less the papers liked or rejected since, and the notable
 * papers walked past, and ranks the rest again; a page that skips seen papers
 * keeps of those the ones `keptPassed` keeps. With the ids the walks read
 * (`paperId`), the entry tells which ranks at the top of the reader's
 * ranking their filter held.
 *
 * An order ranked without likes from the vectors that decide its first ranks
 * alone (`readDecidingVectors`) is not final, and says how many ranks it
 * decided (`decided`): within 15 minutes, by the same inputs, it serves the
 * pages that end within those ranks as they are. Worker versions before
 * `decided` see an order that is not final, and rank again.
 */
export interface KeptRanking {
  ranks: Array<RankedCandidate | null>;
  served: number;
  final: boolean;
  decided?: number;
  notable: RankedCandidate[];
  walked: number;
  notableWalked: number;
  rankedAt: number;
  rankedBy: string;
}
/** Keeps each order for `keptMs` from its last write. */
export interface RankingCache {
  get(key: string): Promise<KeptRanking | null>;
  /** An order just ranked. */
  put(key: string, ranking: KeptRanking, keptMs: number): Promise<void>;
  /** An order read from the cache, with what its page changed: the pages served, the ids read, where the walks stopped. */
  update?(key: string, ranking: KeptRanking, keptMs: number): Promise<void>;
}

// How long an order serves the pages after the first as it was ranked
// (`rankedAt`); after that a page ranks it again after the ranks already
// passed, so papers filed since come next. An order paged by number is kept
// as long from the last page that changed it.
const RANKING_KEPT_MS = 15 * 60_000;
// How long a walk's order (pages that skip seen papers) is kept from the last
// page that changed it. A walk whose order is gone starts again from the top
// of the ranking and sends again, 15 a page, every paper the session was shown
// that the reader's filter no longer holds: past about 65 loads, for about as
// many loads as the session had. Two hours cover breaks of 20, 45 and 90
// minutes (ENG-103); privacy.html states this lifetime.
const WALK_KEPT_MS = 2 * 60 * 60_000;

/**
 * The lanes in their order, `order`, the likes, the rejections and the
 * interest groups an order is ranked by, as a digest (`rankedBy`).
 */
async function rankingInputs(lanes: string[], query: FeedQuery) {
  // The groups in their order, which decides the group an area's article goes to.
  const groups = query.groups.map(group => ({
    categories: [...group.categories].sort(),
    examples: [...group.exampleCategories].sort(),
    positives: [...group.positiveIds].sort(),
    weight: Math.round(group.weight * 100) / 100,
  }));
  const inputs = JSON.stringify({ lanes, order: query.order, positives: [...query.positiveIds].sort(), negatives: [...query.negativeIds].sort(), groups });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inputs));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A page of corpus papers in the asked categories and followed entities,
 * ordered by the closest of the reader's liked or saved papers, or newest
 * first without any. Each paper says which asked categories it was found in
 * (`_fetchedFor`) and which follows (`_followedEntityMatches`).
 *
 * The first page ranks every candidate and leaves the order in `cache`; a
 * later page of the same request reads only its own papers from a final
 * order. Otherwise it ranks again, after the ranks already served or walked
 * past (KeptRanking): a paper that arrived since starts on this page, and
 * none served comes back. An order with nothing left to serve is not final:
 * the lanes may be about to fill. Nor is one ranked without likes from the
 * vectors that decide its first ranks alone (`readDecidingVectors`): it
 * serves the next pages that end within those ranks (`decided`), and a page
 * past them ranks again, from the vectors that decide it.
 *
 * With `skipsSeen`, the page is the first papers of the order the filter does
 * not hold, whatever `page` says, so a reload needs one request however many
 * pages the reader saw before (PAP-103); a false positive passes over a paper
 * the reader has not seen. A later page walks on from the first paper the
 * last walk sent, not from the top, and so does a first page that `continues`
 * when the reader's order is kept. When the order holds none, the page is
 * the one `page` names, papers the reader has seen, rather than none; it goes
 * on past the works the corpus has dropped, as a walk does. It still starts
 * at the rank `page` names, so it can send again the papers that the page
 * before it reached past dropped works; the app lists none twice and asks for
 * the next page. Past the last page it is none, as for a page asked by number
 * there. The paper ids the walk reads stay in the kept order, so a later page
 * reads only the ones no page has read.
 */
export async function readFeedPage(env: StoreEnv, query: FeedQuery, { now = Date.now(), cache, timings }: { now?: number; cache?: RankingCache; timings?: FeedTimings } = {}) {
  const db = database(env);
  const areas = new Set(LEAVES.filter(leaf => query.categories.includes(leaf.id)).map(leaf => leaf.area));
  const readsEconomics = [...areas].some(area => WORKING_PAPER_AREAS.has(area));
  const lanes = [...new Set([
    ...query.categories,
    ...(readsEconomics ? [WORKING_PAPERS_LANE] : []),
    ...(query.areaLanes ? AREA_LANE_AREAS.filter(area => areas.has(area)).map(areaLane) : []),
    ...query.follows.map(follow => follow.lane),
  ])];
  if (lanes.length === 0) return [];
  timings?.count('lanes', lanes.length);
  timings?.count('groups', query.groups.length);
  // A page that skips seen papers goes on with its session's walk whatever
  // categories, interest groups and `order` it asks for: the app asks for the
  // reader's first ten categories by their interests, plans the groups again
  // with each first page, and asks for older papers past a lean toward them, all of
  // which a session changes. Those, the order of the lanes, the likes and the
  // rejections change the ranking (`rankedBy`), not the walk, so a change
  // ranks again after the ranks the session passed rather than from the top.
  // Other pages keep an order per set of lanes and `order`.
  const cacheKey = JSON.stringify({
    ...(query.skipsSeen ? { follows: [...new Set(query.follows.map(follow => follow.lane))].sort() } : { lanes: [...lanes].sort(), order: query.order }),
    excluded: [...query.excludedIds].sort(),
    pageSize: query.pageSize,
    notable: query.notable > 0,
  });
  const rankedBy = await rankingInputs(lanes, query);
  const goesOn = query.page > 0 || query.continues;
  let step = Date.now();
  const kept = goesOn && cache ? await cache.get(cacheKey).catch(() => null) : null;
  if (goesOn && cache) {
    timings?.since('cacheRead', step);
    timings?.keptOrder(kept !== null);
  }
  // Counted in Workers Logs, without the reader or a paper: a page that goes
  // on with a walk (one past the first, or a first one that continues) whose
  // order this location does not hold, so the walk starts again from the top.
  // Another location answered, the cache evicted the entry early, or the
  // reader was away longer than WALK_KEPT_MS.
  if (!kept && goesOn && cache && query.skipsSeen) console.log('Feed walk has no kept order to go on with');
  const keptMs = query.skipsSeen ? WALK_KEPT_MS : RANKING_KEPT_MS;
  // A final order serves any page; one that decided its first ranks only, the pages within them.
  const rankedAgain = !kept || !(kept.final || (kept.decided !== undefined && (query.page + 1) * query.pageSize <= kept.decided))
    || kept.rankedBy !== rankedBy || now - kept.rankedAt >= RANKING_KEPT_MS;
  let ranking = kept?.ranks ?? [];
  let notable = kept?.notable ?? [];
  let walked = kept?.walked ?? 0;
  let notableWalked = kept?.notableWalked ?? 0;
  let decided: number | undefined;
  if (rankedAgain) {
    const ranked = await rankCandidates(db, lanes, query, now, timings);
    ({ decided } = ranked);
    const passed = kept ? Math.max(Math.min(kept.served, query.page * query.pageSize), walked) : 0;
    // A page asked by number needs every rank served, empty ones included, at
    // its place. A paper liked or rejected since leaves its rank empty: a page
    // that finds nothing unseen falls back on these ranks, and would send it
    // again. A walk drops empty ranks, and the others past the limit it carries
    // (`keptPassed`), so its fallback page is counted over the ranks that remain
    // and starts further down by the ranks dropped before its first paper.
    let served = Array.from({ length: passed }, (_, index) => {
      const candidate = kept!.ranks[index] ?? null;
      return candidate && !ranked.excluded.has(candidate.workId) ? candidate : null;
    });
    if (query.skipsSeen) ({ ranks: served, walked } = keptPassed(served, walked, ranked.ranks, FEED_CANDIDATE_LIMIT + AREA_CANDIDATE_LIMIT));
    const shown = new Set(served.map(candidate => candidate?.workId));
    const notablePassed = keptPassed(notable.slice(0, notableWalked), notableWalked, ranked.notable, NOTABLE_READ_PER_YEAR * NOTABLE_YEARS * FEED_MAX_CATEGORIES);
    notableWalked = notablePassed.walked;
    const notableShown = new Set(notablePassed.ranks.map(candidate => candidate.workId));
    ranking = [...served, ...ranked.ranks.filter(candidate => !shown.has(candidate.workId))];
    notable = [...notablePassed.ranks, ...ranked.notable.filter(candidate => !notableShown.has(candidate.workId))];
  }
  const named = ranking.slice(query.page * query.pageSize, (query.page + 1) * query.pageSize).filter(candidate => candidate !== null);
  step = Date.now();
  const [own, unseen] = await Promise.all([
    query.skipsSeen && query.seen ? unseenRanks(db, ranking, query.seen, query.pageSize, { from: walked }) : null,
    // After the page's own papers, for the app to place: one it leaves out is
    // still unseen, so a later page offers it again. Read beside the walk; a
    // page that can have no paper of its own reads none.
    query.seen && query.notable > 0 && (query.skipsSeen ? ranking.some(candidate => candidate !== null) : named.length > 0)
      ? unseenRanks(db, notable, query.seen, query.notable, { from: notableWalked })
      : null,
  ]);
  // A walk with no unseen paper to send falls back on the page `page` names,
  // walked from its first rank as if the reader had seen nothing, so that page
  // too goes on past the works the corpus dropped.
  const walkNamed = () => unseenRanks(db, ranking, null, query.pageSize, { from: query.page * query.pageSize });
  let fallback = own && !own.unseen.length && !query.pastLastPage ? await walkNamed() : null;
  if (own || unseen) timings?.since('walk', step);
  step = Date.now();
  const works = await readWorks(db, [...(own ? (fallback ?? own).unseen : named), ...(unseen?.unseen ?? [])].map(candidate => candidate.workId));
  timings?.since('works', step);
  step = Date.now();
  // A walk trusts the ids pages left on the kept order, and a work the corpus
  // has dropped since (merged into another, evicted) has no row: the walk
  // goes on past it, and the order loses its id.
  if (own?.unseen.length && query.seen) {
    await walkPastDropped(db, own, ranking, query.seen, query.pageSize, works);
    // Every unseen paper of the order is gone: the named page, as when it holds none.
    if (own.unseen.length === 0 && !query.pastLastPage) {
      fallback = await walkNamed();
      (await readWorks(db, fallback.unseen.map(candidate => candidate.workId))).forEach((row, workId) => works.set(workId, row));
    }
  }
  if (fallback?.unseen.length) await walkPastDropped(db, fallback, ranking, null, query.pageSize, works);
  if (unseen?.unseen.length && query.seen) await walkPastDropped(db, unseen, notable, query.seen, query.notable, works);
  // The walks past works the corpus dropped, which a page rarely needs.
  if (own || unseen) timings?.since('walk', step);
  const sent = fallback ?? own;
  const ranked = sent ? sent.unseen : named;
  const walks = {
    walked: own ? passedFirst(ranking, walked, own) : walked,
    notableWalked: unseen ? passedFirst(notable, notableWalked, unseen) : notableWalked,
  };
  const through = sent?.unseen.length ? sent.end : (query.page + 1) * query.pageSize;
  step = Date.now();
  if (rankedAgain && cache) {
    const left = ranking.length > through;
    await cache.put(cacheKey, {
      ranks: ranking,
      served: (query.page + 1) * query.pageSize,
      final: decided === undefined && left,
      ...(decided !== undefined && left ? { decided } : {}),
      notable,
      ...walks,
      rankedAt: now,
      rankedBy,
    }, keptMs)
      .catch(error => console.warn('Feed ranking not cached', error));
    timings?.since('cacheWrite', step);
  } else if (kept && cache?.update) {
    const served = Math.max(kept.served, (query.page + 1) * query.pageSize);
    if (own?.read || fallback?.read || unseen?.read || served !== kept.served || walks.walked !== kept.walked || walks.notableWalked !== kept.notableWalked) {
      await cache.update(cacheKey, { ...kept, ranks: ranking, notable, served, ...walks }, keptMs)
        .catch(error => console.warn('Feed ranking not cached', error));
      timings?.since('cacheWrite', step);
    }
  }
  if (ranked.length === 0) return [];
  const notableIds = new Set(unseen?.unseen.map(candidate => candidate.workId));
  const candidates = [...ranked, ...(unseen?.unseen ?? [])];
  const categories = new Set(query.categories);
  return candidates.flatMap(candidate => {
    const row = works.get(candidate.workId);
    if (!row) return [];
    const paper = JSON.parse(row.paper) as Paper;
    const fetchedFor = candidate.lanes.filter(lane => categories.has(lane));
    const follows = query.follows.filter(follow => candidate.lanes.includes(follow.lane));
    return [{
      ...paper,
      _semanticScore: candidate.semanticScore,
      ...(fetchedFor.length ? { _fetchedFor: fetchedFor } : {}),
      ...(follows.length ? { _followedEntityMatches: follows.map(({ type, canonicalId, displayName }) => ({ type, canonicalId, displayName: displayName || canonicalId })) } : {}),
      ...(notableIds.has(candidate.workId) ? { _notable: true } : {}),
    }];
  });
}

/**
 * Of the ranks an order passed (`ranks`, walked up to `walked`), the ones a
 * ranking again keeps ahead of its new ranks, and where its walk then starts.
 * It keeps every paper still among the `candidates`, so none comes back once
 * the filter no longer holds it. Of the others (a category the app no longer
 * asks for, a work the corpus dropped), it keeps the first `others` passed,
 * which the filter is the least likely to still hold when their category
 * comes back. It keeps no empty rank. Without this bound, a filter that holds
 * every paper, with another category on each page, would keep every earlier
 * ranking whole.
 */
function keptPassed(ranks: Array<RankedCandidate | null>, walked: number, candidates: RankedCandidate[], others: number) {
  const current = new Set(candidates.map(candidate => candidate.workId));
  let room = others;
  const keeps = ranks.map(candidate => {
    if (candidate === null) return false;
    if (current.has(candidate.workId)) return true;
    room -= 1;
    return room >= 0;
  });
  return {
    ranks: ranks.filter((candidate, index): candidate is RankedCandidate => keeps[index]),
    walked: keeps.slice(0, walked).filter(Boolean).length,
  };
}

/**
 * Moves the ranks a walk from `from` passed over ahead of the papers it found,
 * and returns where the next walk starts: past every rank the walk's filter
 * held (or that names a work the corpus dropped, or none), and at the papers
 * found, so one the app never got or did not place is found again. A later
 * filter that no longer holds the passed ones does not bring them back, and a
 * paper that a ranking after this one puts first stays ahead of the found
 * ones without holding the next walk back.
 */
function passedFirst(ranks: Array<RankedCandidate | null>, from: number, walk: Awaited<ReturnType<typeof unseenRanks>>) {
  const found = new Set(walk.unseen);
  const passed = ranks.slice(from, walk.end).filter(candidate => !candidate || !found.has(candidate));
  ranks.splice(from, walk.end - from, ...passed, ...walk.unseen);
  return from + passed.length;
}

/**
 * The first `wanted` of `ranks` from `from` whose papers the reader has not
 * seen, in order, how many ranks the walk took to find them (`end`), and
 * whether it read paper ids (`read`). The filter holds the ids the app was
 * served, so a candidate's is read from its row, unless a walk already left
 * it on the candidate (`paperId`) and the walk trusts it (not `recheck`): up
 * to rank 200, then 600, 1,400, 3,000 and so on, wherever the walk starts, so
 * a reader who has seen a few thousand papers costs a few reads, a whole
 * ranking of up to 12,600 ranks at most six, and pages that each walk on from
 * the last read each id once. Without `seen`, the reader has seen none.
 */
async function unseenRanks(db: D1Database, ranks: Array<RankedCandidate | null>, seen: BloomFilter | null, wanted: number, { from = 0, recheck = false } = {}) {
  const unseen: RankedCandidate[] = [];
  let end = from;
  let read = false;
  for (let bound = 200; end < ranks.length && unseen.length < wanted; bound = 2 * bound + 200) {
    if (bound <= end) continue;
    const chunk = ranks.slice(end, bound);
    const unread = chunk.filter((candidate): candidate is RankedCandidate => candidate !== null && (recheck ? candidate.paperId !== '' : candidate.paperId === undefined));
    if (unread.length) {
      const { results } = await db.prepare("SELECT w.id, w.paper ->> '$.id' AS paper_id FROM json_each(?) j JOIN works w ON w.id = j.value")
        .bind(JSON.stringify(unread.map(candidate => candidate.workId))).all<{ id: number; paper_id: string | null }>();
      const paperIds = new Map(results.map(row => [row.id, row.paper_id]));
      for (const candidate of unread) candidate.paperId = paperIds.get(candidate.workId) ?? '';
      read = true;
    }
    for (const candidate of chunk) {
      if (unseen.length === wanted) break;
      end += 1;
      if (candidate?.paperId && !(seen && hasSeenPaper(seen, candidate.paperId))) unseen.push(candidate);
    }
  }
  return { unseen, end, read };
}

/**
 * Takes out of `walk` the candidates whose work `works` lacks, and walks
 * `ranks` on for as many, reading their rows into `works`. A page left those
 * ids on the kept order before the corpus dropped the work; each loses its
 * id, so no later page reads it again or counts it as a paper. The ids left
 * on the ranks after them can name dropped works too, so the walk on reads
 * them again rather than trust them: one more walk however many works the
 * corpus dropped, not one per page of them. A work dropped between that walk
 * and the read of its row leaves the page one paper short.
 */
async function walkPastDropped(db: D1Database, walk: Awaited<ReturnType<typeof unseenRanks>>, ranks: Array<RankedCandidate | null>, seen: BloomFilter | null, wanted: number, works: Map<number, WorkRow>) {
  const found = walk.unseen.filter(candidate => works.has(candidate.workId));
  if (found.length === walk.unseen.length) return;
  const more = await unseenRanks(db, ranks, seen, wanted - found.length, { from: walk.end, recheck: true });
  (await readWorks(db, more.unseen.map(candidate => candidate.workId))).forEach((row, workId) => works.set(workId, row));
  for (const candidate of [...walk.unseen, ...more.unseen]) if (!works.has(candidate.workId)) candidate.paperId = '';
  walk.unseen = [...found, ...more.unseen.filter(candidate => works.has(candidate.workId))];
  walk.end = more.end;
  walk.read = true;
}

/**
 * The groups' ranks in one order, by smooth weighted round-robin: each turn
 * goes to the group most owed one, so a group of twice the weight takes every
 * other place of the other's, spread over the page rather than in a run. A
 * paper an earlier turn placed is passed over, and a group with no papers
 * left gives up its turns.
 */
export function interleaveByWeight(lists: RankedCandidate[][], weights: number[]) {
  const positions = lists.map(() => 0);
  const owed = lists.map(() => 0);
  const placed = new Set<number>();
  const merged: RankedCandidate[] = [];
  const next = (index: number) => {
    while (positions[index] < lists[index].length && placed.has(lists[index][positions[index]].workId)) positions[index] += 1;
    return lists[index][positions[index]];
  };
  for (;;) {
    const open = lists.flatMap((_, index) => (next(index) ? [index] : []));
    if (open.length === 0) return merged;
    open.forEach(index => { owed[index] += weights[index]; });
    const turn = open.reduce((best, index) => (owed[index] > owed[best] ? index : best));
    owed[turn] -= open.reduce((total, index) => total + weights[index], 0);
    const candidate = next(turn);
    positions[turn] += 1;
    placed.add(candidate.workId);
    merged.push(candidate);
  }
}

const AREAS = new Set(LEAVES.map(leaf => leaf.area));
const areasOfLeaves = (categories: readonly string[]) => new Set(LEAVES.filter(leaf => categories.includes(leaf.id)).map(leaf => leaf.area));

/**
 * The groups that rank a candidate: those of the categories it was found
 * under. One found only in an area's journal lane or the working-paper series
 * goes to the group asking for most of that area's leaves (an area's group
 * rather than its new subarea's, in whichever order the app lists them; the
 * first on a tie), and one found only by a follow to the first group.
 */
function groupsOfCandidate(groups: FeedGroup[]) {
  const ownerOf = (areas: ReadonlySet<string>) => {
    const leaves = groups.map(group => LEAVES.filter(leaf => areas.has(leaf.area) && group.categories.includes(leaf.id)).length);
    const owner = leaves.reduce((best, count, index) => (count > leaves[best] ? index : best), 0);
    return leaves[owner] > 0 ? owner : undefined;
  };
  const areaOwners = new Map<string, number>();
  for (const [lane, areas] of [...[...AREAS].map(area => [areaLane(area), new Set([area])] as const), [WORKING_PAPERS_LANE, WORKING_PAPER_AREAS] as const]) {
    const owner = ownerOf(areas);
    if (owner !== undefined) areaOwners.set(lane, owner);
  }
  return (candidate: Candidate) => {
    const byCategory = groups.flatMap((group, index) => (candidate.lanes.some(lane => group.categories.includes(lane)) ? [index] : []));
    if (byCategory.length) return byCategory;
    const byArea = [...new Set(candidate.lanes.flatMap(lane => (areaOwners.has(lane) ? [areaOwners.get(lane)!] : [])))];
    return byArea.length ? byArea : [0];
  };
}

/**
 * The groups a like no group names ranks, by the first evidence of its area:
 * the app's leaves its stored paper names, matched against each group's
 * `exampleCategories`; else the area its primary category or arXiv archive
 * names, or else the areas whose journal lanes list it, matched
 * against the areas of those categories. A like of a known area no group
 * holds ranks none. The app's established group holds every leaf but the
 * ones the reader removed, so that is a like of a removed subarea, or of an
 * area the reader never picked when every group is an added one. Only a like
 * with no evidence ranks every group.
 */
function groupsOfLike(groups: FeedGroup[]) {
  const exampleAreas = groups.map(group => areasOfLeaves(group.exampleCategories));
  return (paper: Partial<Paper> | undefined, laneAreas: string[]) => {
    const leaves = [paper?.primaryCategory, ...(paper?.categories ?? [])].filter((category): category is string => !!category && LEAF_IDS.has(category));
    if (leaves.length) return groups.flatMap((group, index) => (leaves.some(leaf => group.exampleCategories.includes(leaf)) ? [index] : []));
    const primaryArea = paper?.primaryCategory && AREAS.has(paper.primaryCategory)
      ? paper.primaryCategory : getArxivArchiveArea(paper?.primaryCategory);
    const areas = primaryArea ? [primaryArea] : laneAreas;
    if (areas.length) return groups.flatMap((_, index) => (areas.some(area => exampleAreas[index].has(area)) ? [index] : []));
    return groups.map((_, index) => index);
  };
}

// The areas whose journal lanes list each of these works, in one statement:
// the likes no group names, at most FEED_MAX_POSITIVES.
async function readAreaLanes(db: D1Database, workIds: number[]) {
  const areas = new Map<number, string[]>();
  if (workIds.length === 0) return areas;
  const { results } = await db.prepare("SELECT l.work_id, l.lane FROM json_each(?) j JOIN work_lanes l ON l.work_id = j.value WHERE l.lane LIKE 'area:%'")
    .bind(JSON.stringify(workIds)).all<{ work_id: number; lane: string }>();
  for (const row of results) areas.set(row.work_id, [...(areas.get(row.work_id) ?? []), row.lane.slice(areaLane('').length)]);
  return areas;
}

// `decided`: how many first ranks are the ones a read of every vector gives,
// when the others may not be (`readDecidingVectors`).
async function rankCandidates(db: D1Database, lanes: string[], query: FeedQuery, now: number, timings?: FeedTimings): Promise<{ ranks: RankedCandidate[]; notable: RankedCandidate[]; excluded: Set<number>; decided?: number }> {
  let step = Date.now();
  const works = await findWorks(db, [...query.positiveIds, ...query.negativeIds, ...query.excludedIds]);
  timings?.since('keys', step);
  step = Date.now();
  const workIdsOf = (ids: string[]) => [...new Set(ids.flatMap(id => works.has(id) ? [works.get(id)!] : []))];
  const positiveIds = workIdsOf(query.positiveIds);
  const negativeIds = workIdsOf(query.negativeIds);
  // The likes no group names: a profile stored before its examples had a category.
  const grouped = new Set(workIdsOf(query.groups.flatMap(group => group.positiveIds)));
  const ungrouped = positiveIds.filter(id => !grouped.has(id));
  const notableLanes = query.notable > 0 ? query.categories.map(category => `${NOTABLE_LANE_PREFIX}${category}`) : [];
  const [candidates, notableRead, signals, ungroupedWorks, ungroupedAreaLanes] = await Promise.all([
    // Each lane contributes its newest share of the candidates through its own
    // index range, which stops at the share: one query over the whole window
    // read every row of it (146k rows for five busy cs categories, 2026-10-22),
    // and D1 bills rows read. A quiet lane keeps its share instead of being
    // crowded out by a busy one; the area lanes share AREA_CANDIDATE_LIMIT.
    // The window is the corpus's own: what is past it has been evicted.
    readCandidates(db, lanes),
    notableLanes.length ? readNotableCandidates(db, notableLanes, now, timings) : Promise.resolve({ candidates: [], inLanes: new Set<number>() }),
    readVectors(db, [...new Set([...positiveIds, ...negativeIds])]),
    readWorks(db, ungrouped),
    readAreaLanes(db, ungrouped),
  ]);
  // The notable check runs inside this wave, and is counted in both.
  timings?.since('wave1', step);
  timings?.count('candidates', candidates.length);
  if (notableLanes.length) timings?.count('notable', notableRead.candidates.length);
  const signalUnit = unitVectors(signals);
  const vectorsOf = (ids: number[]) => ids.flatMap(id => {
    const unit = signalUnit(id);
    return unit ? [unit] : [];
  });
  const likes = vectorsOf(positiveIds);
  const negatives = vectorsOf(negativeIds);
  const groupedLikes = query.groups.map(group => workIdsOf(group.positiveIds));
  const likeGroups = groupsOfLike(query.groups);
  for (const id of ungrouped) {
    // A row evicted since `findWorks` gives no evidence of its area.
    const row = ungroupedWorks.get(id);
    const paper = row ? JSON.parse(row.paper) as Partial<Paper> : undefined;
    likeGroups(paper, ungroupedAreaLanes.get(id) ?? []).forEach(index => groupedLikes[index].push(id));
  }
  const groupLikes = groupedLikes.map(vectorsOf);
  // A liked paper is not offered again, and keeps its vector in the corpus. A
  // liked, rejected or excluded paper comes neither as a rank nor as a notable card.
  const excluded = new Set([...positiveIds, ...negativeIds, ...query.excludedIds.flatMap(id => works.has(id) ? [works.get(id)!] : [])]);
  // A paper of the reader's notable lanes comes only as a notable card.
  const offered = candidates.filter(candidate => !excluded.has(candidate.workId) && !notableRead.inLanes.has(candidate.workId));
  const offeredNotable = notableRead.candidates.filter(candidate => !excluded.has(candidate.workId));
  const members: Candidate[][] = query.groups.map(() => []);
  const groupsOf = groupsOfCandidate(query.groups);
  for (const candidate of offered) groupsOf(candidate).forEach(index => members[index].push(candidate));
  const vectors = new Map<number, Int8Array>();
  const candidateUnit = unitVectors(vectors);
  const unitOf = (candidate: Candidate) => candidateUnit(candidate.workId);
  // The ranks a page without likes decides: the diversity pool, and the page.
  const decidedRanks = Math.max(DIVERSITY_POOL, (query.page + 1) * query.pageSize);
  // Each D1 round trip for candidate vectors: a page without likes may need
  // several, one after the other.
  let vectorRounds = 0;
  const readRound = (workIds: number[]) => {
    if (workIds.length) vectorRounds += 1;
    return readVectors(db, workIds, vectors);
  };
  step = Date.now();
  const [everyRank] = await Promise.all([
    // Without a positive or negative vector, recency needs no candidate vectors.
    // With rejections alone, a page asked by number needs only the vectors
    // that decide its ranks; a walk past seen papers can reach any rank.
    !likes.length && !negatives.length ? true
      : !likes.length && !query.skipsSeen && !offeredNotable.length
        ? readDecidingVectors(readRound, offered, members, unitOf, scorer([], negatives, { now, order: query.order }), decidedRanks)
        : readRound([...offered, ...offeredNotable].map(candidate => candidate.workId)).then(() => true),
    keepLiked(db, positiveIds, now),
  ]);
  // A page without likes scores the candidates it read between its rounds,
  // so on Workers that CPU is in this step, not in `rankCpu`.
  timings?.since('vectors', step);
  timings?.count('vectors', vectors.size);
  if (vectorRounds) timings?.count('vectorRounds', vectorRounds);
  step = Date.now();
  // Each group ranked by its own likes, then the page shared by weight.
  const ranks = interleaveByWeight(members.map((rows, index) => rankByUnitVectors(rows, unitOf, groupLikes[index], negatives, { now, order: query.order })
    .map(({ row, semanticScore }) => ({ workId: row.workId, lanes: row.lanes, semanticScore }))), query.groups.map(group => group.weight));
  // The closest notable papers first, without recency: they are years old by
  // design. A reader without likes gets them with the years in turns; a
  // rejection says nothing about the years they want, so it only moves near
  // copies of the rejected papers after the others, the nearest last. The
  // turns are taken before the excluded papers leave, as turns already passed:
  // on every fresh load the app excludes the latest cards it showed, notable
  // ones included, which would otherwise start the turns again from the first
  // year; the seen filter holds the ones before (ENG-166).
  const notable = likes.length
    ? rankByUnitVectors(offeredNotable, unitOf, likes, negatives, { now, order: 'relevance' })
    : notableYearsInTurns(notableRead.candidates, notableLanes)
      .filter(candidate => !excluded.has(candidate.workId))
      .map(row => ({ row, semanticScore: -rejection(unitOf(row), negatives) }))
      .sort((a, b) => b.semanticScore - a.semanticScore);
  timings?.since('rankCpu', step);
  return {
    ranks,
    notable: notable.map(({ row, semanticScore }) => ({ workId: row.workId, lanes: row.lanes.map(lane => lane.slice(NOTABLE_LANE_PREFIX.length)), semanticScore })),
    excluded,
    ...(everyRank ? {} : { decided: decidedRanks }),
  };
}

// How many candidates past the ranks it decides a page without likes reads
// first, for the ones a rejection moves down.
const DECIDING_MARGIN = 100;

/**
 * Reads, a round trip each `readRound`, the vectors of a ranking without likes,
 * `offered` newest first, until the first `ranks` of each group's ranking are decided,
 * and returns whether it read every candidate's. Without likes a candidate
 * scores at most its recency, what it scores without a vector (`scorer`): once
 * `ranks` candidates read come before the first unread one of their group
 * even at that one's most, no unread candidate can reach those ranks, which
 * hold the diversity pool. The ranks past them place the unread candidates
 * as if no rejection were near them.
 */
async function readDecidingVectors(
  readRound: (workIds: number[]) => Promise<unknown>,
  offered: Candidate[],
  members: Candidate[][],
  unitOf: (candidate: Candidate) => Float64Array | null,
  scoreOf: ReturnType<typeof scorer>,
  ranks: number,
) {
  const position = new Map(offered.map((candidate, index) => [candidate.workId, index]));
  const most = new Map(offered.map(candidate => [candidate.workId, scoreOf(null, candidate.published).score]));
  // A date that does not parse has no score to order by.
  if (![...most.values()].every(Number.isFinite)) {
    await readRound(offered.map(candidate => candidate.workId));
    return true;
  }
  // The ranking's order, and where it ties the candidates' own (a stable sort).
  const compare = (score: number, candidate: Candidate, otherScore: number, other: Candidate) => scoreOrder(score, candidate.published, otherScore, other.published)
    || position.get(candidate.workId)! - position.get(other.workId)!;
  const newest = [...offered].sort((a, b) => compare(most.get(a.workId)!, a, most.get(b.workId)!, b));
  const readAt = new Map(newest.map((candidate, index) => [candidate.workId, index]));
  const scores = new Map<number, number>();
  const scoreRead = (candidate: Candidate) => {
    let score = scores.get(candidate.workId);
    if (score === undefined) scores.set(candidate.workId, (score = scoreOf(unitOf(candidate), candidate.published).score));
    return score;
  };
  const decided = (group: Candidate[], read: number) => {
    // The group's first candidate not read: the others not read come after it.
    let edge: Candidate | undefined;
    for (const candidate of group) {
      if (readAt.get(candidate.workId)! >= read && (!edge || readAt.get(candidate.workId)! < readAt.get(edge.workId)!)) edge = candidate;
    }
    if (!edge) return true;
    const edgeMost = most.get(edge.workId)!;
    let before = 0;
    for (const candidate of group) {
      if (readAt.get(candidate.workId)! < read && compare(scoreRead(candidate), candidate, edgeMost, edge) < 0) before += 1;
    }
    return before >= ranks;
  };
  // Each round reads on to twice as far as the last, so a page deep in the
  // order, or a group few of the newest candidates are in, costs a few round
  // trips, not one per candidate it needs.
  for (let read = 0, upTo = ranks + DECIDING_MARGIN; ; upTo *= 2) {
    await readRound(newest.slice(read, upTo).map(candidate => candidate.workId));
    read = Math.min(upTo, newest.length);
    if (read === newest.length) return true;
    if (members.every(group => decided(group, read))) return false;
  }
}

// Each work's vector normalized the first time a ranking asks for it: a
// candidate several interest groups rank, or a like several groups rank by,
// is normalized once a request.
function unitVectors(vectors: Map<number, Int8Array>) {
  const units = new Map<number, Float64Array>();
  return (workId: number) => {
    const vector = vectors.get(workId);
    if (!vector) return null;
    let unit = units.get(workId);
    if (!unit) units.set(workId, (unit = unitVector(vector)));
    return unit;
  };
}

/**
 * The notable candidates with the years in turns, newest first, and the asked
 * lanes in turns within each year, each lane's rows newest first. A reader
 * without likes has nothing to rank them by and gets them in this order: one
 * paper of each year in turn, rather than every paper of the newest year first
 * (ENG-166). The lanes take their turns in the order the request asks them
 * in: the app sends the reader's established interests in its ranking of
 * them, then the areas they added since and the app has not learned yet,
 * whatever their weight. The years start their turns from
 * successive lanes, so consecutive papers often come from different lanes
 * too. Not with one lane;
 * not from the last year of a round to the first of the next when the lane
 * count divides the years' count less two (2, 4 or 8 lanes over ten years);
 * and not where a year lacks papers of a lane, which shifts its turns. A
 * request that asks the lanes in another order, or a different set of lanes,
 * changes each year's first paper, so the turns can start again from the
 * newest year: a reader whose order swaps on every load moves through the
 * years at half the pace. The app's order moves with skips and view times.
 */
function notableYearsInTurns(candidates: Candidate[], lanes: string[]): Candidate[] {
  const byYear = new Map<string, Candidate[][]>();
  for (const candidate of candidates) {
    const year = candidate.published.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, lanes.map(() => []));
    // A paper listed by several lanes belongs to the first of them, in the
    // order the request asks, among the lanes whose day's slice offers it
    // (`candidate.lanes`, `readNotableCandidates`).
    byYear.get(year)![lanes.findIndex(lane => candidate.lanes.includes(lane))].push(candidate);
  }
  // A lane's rows newest first, as its read gives them (`readNotableCandidates`):
  // a paper several lanes list takes its place among its lane's rows by date,
  // not at the turn the merge of the lanes reached it.
  const newestFirst = (a: Candidate, b: Candidate) => (a.published === b.published ? a.workId - b.workId : a.published < b.published ? 1 : -1);
  const years = [...byYear.keys()].sort().reverse().map((year, index) => {
    const perLane = byYear.get(year)!.map(rows => rows.sort(newestFirst));
    return inTurns(perLane.map((_, lane) => perLane[(lane + index) % perLane.length]));
  });
  return inTurns(years);
}

// The lists' items in turns: the first of each list, then the second of each.
function inTurns<T>(lists: T[][]): T[] {
  const turns: T[] = [];
  const longest = Math.max(0, ...lists.map(list => list.length));
  for (let position = 0; position < longest; position += 1) {
    for (const list of lists) if (position < list.length) turns.push(list[position]);
  }
  return turns;
}

// ─── Requests ───

const CATEGORY_ID = /^[\w.-]{1,32}$/;

export interface FeedRequestBody {
  categories?: unknown; follows?: unknown; positiveIds?: unknown; negativeIds?: unknown; excludedIds?: unknown; page?: unknown; pageSize?: unknown; order?: unknown;
  seen?: unknown; skipsSeen?: unknown; continues?: unknown; notable?: unknown; waitForLikes?: unknown; groups?: unknown;
}

const categoryIds = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(category => CATEGORY_ID.test(category)))];
const paperIds = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(id => text(id).slice(0, 300)).filter(Boolean))];

// A group asks for at least one lane: no more groups than a request has lanes.
const FEED_MAX_GROUPS = FEED_MAX_CATEGORIES;
const FEED_MAX_GROUP_WEIGHT = 10;

function parseFeedGroups(value: unknown): FeedGroup[] {
  return (Array.isArray(value) ? value : []).flatMap((group: Partial<Record<keyof FeedGroup, unknown>> | null) => {
    const categories = categoryIds(group?.categories).slice(0, FEED_MAX_CATEGORIES);
    const weight = group?.weight;
    if (categories.length === 0 || typeof weight !== 'number' || !(weight > 0 && weight <= FEED_MAX_GROUP_WEIGHT)) return [];
    return [{
      categories,
      exampleCategories: categoryIds(group?.exampleCategories).slice(0, LEAF_IDS.size),
      positiveIds: paperIds(group?.positiveIds).slice(0, FEED_MAX_POSITIVES),
      weight,
    }];
  }).slice(0, FEED_MAX_GROUPS);
}

export function parseFeedRequest(body: FeedRequestBody | null): FeedQuery {
  const asked = parseFeedGroups(body?.groups);
  // A request without groups, from a bundle published before them, is one group.
  const categories = (asked.length ? [...new Set(asked.flatMap(group => group.categories))] : categoryIds(body?.categories)).slice(0, FEED_MAX_CATEGORIES);
  const follows = (Array.isArray(body?.follows) ? body.follows : [])
    .map(follow => ({ follow, lane: followLane(follow) }))
    .filter(({ lane }) => lane)
    .slice(0, FEED_MAX_FOLLOWS)
    .map(({ follow, lane }) => ({
      type: text(follow.type) as PaperFollowMatch['type'],
      canonicalId: text(follow.canonicalId).slice(0, 200),
      displayName: text(follow.displayName).slice(0, 200),
      lane,
    }));
  const positiveIds = [...new Set([...asked.flatMap(group => group.positiveIds), ...paperIds(body?.positiveIds)])].slice(0, FEED_MAX_POSITIVES);
  // Each group keeps what the union kept, and a group left without a lane goes.
  const groups = asked.length
    ? asked
      .map(group => ({ ...group, categories: group.categories.filter(category => categories.includes(category)), positiveIds: group.positiveIds.filter(id => positiveIds.includes(id)) }))
      .filter(group => group.categories.length > 0)
    : [{ categories, exampleCategories: categories, positiveIds, weight: 1 }];
  const negativeIds = [...new Set((Array.isArray(body?.negativeIds) ? body.negativeIds : []).filter((id): id is string => typeof id === 'string').map(id => id.trim().slice(0, 300)).filter(Boolean))].slice(0, FEED_MAX_POSITIVES);
  const excludedIds = [...new Set((Array.isArray(body?.excludedIds) ? body.excludedIds : []).filter((id): id is string => typeof id === 'string').map(id => id.trim().slice(0, 300)).filter(Boolean))].slice(0, FEED_MAX_EXCLUDED);
  const seen = body?.seen === undefined ? null : readFeedSeenFilter(body.seen);
  if (body?.seen !== undefined && !seen) throw new PaperStoreError('SEEN_INVALID', 400);
  const skipsSeen = seen !== null && body?.skipsSeen === true;
  const page = Math.max(0, Math.floor(Number(body?.page) || 0));
  return {
    categories,
    follows,
    positiveIds,
    groups,
    negativeIds,
    excludedIds,
    // A page that skips seen papers walks on whatever its number, which the
    // app raises on every load; past the last page, it counts as the last.
    page: skipsSeen ? Math.min(page, FEED_MAX_PAGE) : page,
    pageSize: Math.min(Math.max(1, Math.floor(Number(body?.pageSize) || FEED_PAGE_SIZE)), FEED_MAX_PAGE_SIZE),
    order: body?.order === 'relevance' ? 'relevance' : 'recent',
    seen,
    skipsSeen,
    pastLastPage: skipsSeen && page > FEED_MAX_PAGE,
    continues: skipsSeen && body?.continues === true,
    notable: seen ? Math.min(Math.max(0, Math.floor(Number(body?.notable) || 0)), FEED_MAX_NOTABLE) : 0,
    // Not for the follows' request, even when no follow has a lane of its own
    // (a category topic): there the categories stand for followed topics
    // (FeedContext), matched by `_fetchedFor`, which an area-level article lacks.
    areaLanes: !(Array.isArray(body?.follows) && body.follows.length > 0),
  };
}

/** The stored papers these app ids name, in the order asked; ids the corpus lacks are left out. */
export async function readPapersByIds(env: StoreEnv, paperIds: string[]) {
  const db = database(env);
  const workByPaperId = await findWorks(db, paperIds);
  const works = await readWorks(db, [...new Set(workByPaperId.values())]);
  return paperIds.flatMap(id => {
    const row = works.get(workByPaperId.get(id)!);
    return row ? [JSON.parse(row.paper) as Paper] : [];
  });
}

export const FEED_LAST_PAGE = FEED_MAX_PAGE;
