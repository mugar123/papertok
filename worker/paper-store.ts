import type { BloomFilter } from 'bloomfilter';
import type { Paper, PaperFollowMatch } from '../src/models/paper.ts';
import type { WorkerEnv } from './env.ts';

import { PaperBuilder } from '../src/services/paper-builder.ts';
import { isFeedPublication } from '../src/services/feed-publication-rules.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
import { isPlaceholderPaperTitle } from '../src/utils/paper-display-title.ts';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { hasSeenPaper, readFeedSeenFilter } from '../src/utils/seen-paper-filter.ts';
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
// At least this many of each page of the feed are articles of an area's
// journal lane while the area lanes hold any, and more where the ranking
// puts more (PAP-107). OpenAlex dates an article by its day alone, mostly the
// day before the harvest, and that day sorts as its midnight, so newest first
// the night's articles ranked behind a busy reader's whole day of arXiv
// preprints.
const JOURNAL_FLOOR = 3;
// The area lanes a page reads share at most this many candidates, beside the
// asked lanes' FEED_CANDIDATE_LIMIT rather than out of it: counted as one of
// the asked lanes, a single area lane would leave a one-category reader the
// newest half of their own candidates. It is the floor's 3 ranks in 15 of a
// ranking as long as the asked lanes'.
const AREA_CANDIDATE_LIMIT = FEED_CANDIDATE_LIMIT * JOURNAL_FLOOR / FEED_PAGE_SIZE;
const FEED_MAX_CATEGORIES = 12;
const FEED_MAX_FOLLOWS = 20;
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
// account's lookups could spend the 60M-token day in about 143 minutes. The
// runs new follows start, together: no reader
// is recorded with them, and each of the 20 new lanes a reader's runs may
// harvest a day can bring a few hundred papers; what they leave waits for the
// daily run.
const READER_EMBEDDING_DAILY_TOKENS = 50_000;
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

export function readVector(value: unknown) {
  if (value instanceof ArrayBuffer) return new Int8Array(value);
  if (ArrayBuffer.isView(value)) return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
  // D1 answers a BLOB as its unsigned bytes. The constructor wraps 128-255 to
  // -128 to -1, as a callback per byte would, at a twentieth of the CPU.
  return new Int8Array(value as number[]);
}

// Normalize once per ranking: MMR compares each candidate many times, and a
// vector cut by migration 0004 is no longer a unit vector.
export function unitVector(vector: Int8Array) {
  const norm = Math.hypot(...vector) || 1;
  return Float64Array.from(vector, value => value / norm);
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
// The most-cited papers of a category published from 1 January NOTABLE_YEARS
// years before the current UTC year (paper-sources.ts), filed under
// `notable:<category>`. A page that says what the reader has seen adds the
// ones the reader has not, for the app to give one card in every
// NOTABLE_EVERY (src/utils/feed-enrichment.ts) (Pablo, 2026-10-23).
export const NOTABLE_LANE_PREFIX = 'notable:';
const NOTABLE_YEARS = 10;
/** The first day of the notable window: the listing asks from it, and a page reads none older. */
export const notableSince = (now = Date.now()) => `${new Date(now).getUTCFullYear() - NOTABLE_YEARS}-01-01`;
// A notable lane holds its weekly listing of 100 (NOTABLE_PER_LANE in
// paper-sources.ts) and, for 14 days, what dropped out of the two listings
// before it (`work_lanes.listed_until`), whatever else keeps the paper in the
// corpus (a like, its date, another lane). A page reads three listings' worth
// of each asked lane, newest first, so the newer papers that dropped out do
// not cut the listing's oldest, most-cited ones.
const NOTABLE_READ_PER_LANE = 300;
// Journal articles of a whole area (paper-sources.ts `openalex-areas`), shown
// to a reader of any of its leaves, for the areas whose leaves the feed fills
// from arXiv: PubMed lists journal articles for every leaf of medicine and
// biology. A paper a leaf of its area holds leaves the area's lane
// (leaf-filing.ts), so it reaches that leaf's readers and no other's. Not
// statistics while its label covers OpenAlex's Decision Sciences (field 18):
// 147 of that field's 200 newest articles on 2026-10-23 were operations
// research and information systems, and most of the 44 in its statistics
// subfield bibliometrics and meta-analyses.
export const AREA_LANE_AREAS: readonly string[] = ARXIV_FEED_AREAS.filter(area => area !== 'stat');
export const areaLane = (area: string) => `area:${area}`;
const AREA_LANES = new Set(AREA_LANE_AREAS.map(areaLane));
const OPENALEX_ENTITY = /^https?:\/\/openalex\.org\/([AITC]\d+)$|^([AITC]\d+)$/i;
const ENTITY_LANE_KINDS: Record<string, string> = { A: 'author', I: 'institution', T: 'topic', C: 'concept' };

function entityLane(value: unknown) {
  const match = text(value).match(OPENALEX_ENTITY);
  const id = (match?.[1] || match?.[2] || '').toUpperCase();
  return id ? `${ENTITY_LANE_KINDS[id[0]]}:${id}` : '';
}

/**
 * The lanes a paper belongs to by its own record, whichever source listed it:
 * its arXiv categories that are categories of the app, and the OpenAlex
 * authors, institutions, topics and concepts it names (what a reader follows).
 * Every reader of them shares these lanes, so a paper is filed under them only
 * inside the corpus window: an older one a reader liked, or a lane that keeps
 * listings kept, stays in the lanes it was asked for.
 */
export function recordLanes(paper: Partial<Paper>) {
  const lanes = new Set<string>();
  if (paper.sources?.primary === 'arxiv' || paper.arxivId) {
    for (const category of [...(paper.allCategories || []), ...(paper.categories || [])]) {
      if (LEAF_IDS.has(category)) lanes.add(category);
    }
  }
  for (const author of paper.authors || []) {
    if (typeof author === 'object') lanes.add(entityLane(author?.id));
  }
  for (const institution of paper.institutions || []) lanes.add(entityLane(institution?.id));
  for (const subject of [paper.primaryTopic, ...(paper.topics || []), ...(paper.concepts || [])]) lanes.add(entityLane(subject?.id));
  lanes.delete('');
  return [...lanes];
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
function storedPaper(paper: Paper): Paper {
  const stored = Object.fromEntries(Object.entries(paper).filter(([key]) => !key.startsWith('_') && key !== 'raw')) as Paper;
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
    const { results } = await db.prepare('SELECT key, work_id FROM work_keys WHERE key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(keys.slice(start, start + 500))).all<{ key: string; work_id: number }>();
    results.forEach(row => found.set(row.key, row.work_id));
  }
  return found;
}

async function readWorks(db: D1Database, ids: number[]) {
  const works = new Map<number, WorkRow>();
  for (let start = 0; start < ids.length; start += 200) {
    const { results } = await db.prepare('SELECT id, paper, kept_until FROM works WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids.slice(start, start + 200))).all<WorkRow>();
    results.forEach(row => works.set(row.id, row));
  }
  return works;
}

const sourceRecordKey = (source: string | undefined, id: string) => `${source}|${id.toLowerCase()}`;

// Hugging Face lists arXiv papers with the title and abstract it copied from
// arXiv, so arXiv's listing carries a new version to a row Hugging Face
// started, and Hugging Face's copy never replaces it.
const ownListing = (row: Paper, listed: Map<string, Paper>) => (row.sources?.primary === 'huggingface' && row.arxivId
  ? listed.get(sourceRecordKey('arxiv', row.arxivId))
  : listed.get(sourceRecordKey(row.sources?.primary, row.id)));

// A row's title and abstract are those of the source it was built from, and
// that source listing it again (a new arXiv version) replaces them, where
// `merge` only fills a gap. A listing without an abstract keeps the stored one.
function withOwnText(row: Paper, own: Paper | undefined): Paper {
  if (!own) return row;
  return hasUsableAIAbstract(own.abstract)
    ? { ...row, title: own.title, abstract: own.abstract, summary: own.summary }
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
 * (`listed_until`). Returns how many rows were written.
 */
export async function ingestPapers(env: StoreEnv, items: Harvested[], { keepUntil = '', now = Date.now() } = {}) {
  const db = database(env);
  const since = daysFromNow(-CORPUS_DAYS, now);
  const groups: Group[] = [];
  const groupOfKey = new Map<string, Group>();
  const listed = new Map<string, Paper>();
  for (const item of items) {
    // A mapper stands "Untitled" in for a title its source left out.
    if (isPlaceholderPaperTitle(item?.paper?.title, item?.paper?.id) || !item.paper.id || !isFeedPublication(item.paper)) continue;
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
    item.lanes.forEach(lane => group.lanes.add(lane));
    keys.forEach(key => group.keys.add(key));
    group.keys.forEach(key => groupOfKey.set(key, group));
  }
  if (groups.length === 0) return 0;

  const existingByKey = await lookUpKeys(db, [...new Set(groups.flatMap(group => [...group.keys]))]);
  const works = await readWorks(db, [...new Set(existingByKey.values())]);
  const rows: Array<{ id: number; paper: string; published: string; keptUntil: string }> = [];
  const keyRows: Array<{ key: string; id: number }> = [];
  const laneRows: Array<{ lane: string; id: number; published: string; listedUntil: string | null }> = [];
  const staleVectors: number[] = [];
  const folded: Array<{ from: number; into: number }> = [];

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
    for (const lane of new Set([...group.lanes, ...(published >= since ? recordLanes(paper) : [])])) {
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
  return rows.length;
}

/**
 * Rewrites stored papers after an enrichment merged into them. Same rules as
 * `ingestPapers` for the vector and the lanes; nothing else changes. A few
 * statements per chunk of papers: D1 counts each against the invocation.
 */
export async function rewriteWorks(env: StoreEnv, updates: Array<{ id: number; before: Paper; after: Paper }>, now = Date.now()) {
  const db = database(env);
  const since = daysFromNow(-CORPUS_DAYS, now);
  const changed = updates
    .filter(update => JSON.stringify(update.before) !== JSON.stringify(update.after))
    .map(({ id, before, after }) => {
      const paper = storedPaper(after);
      const published = publishedOf(paper, now) || publishedOf(before, now);
      return {
        text: { id, paper: JSON.stringify(paper) },
        filing: {
          id,
          published,
          textChanged: embeddingText(paper) !== embeddingText(before),
          // A book or book review the enrichment revealed leaves every lane.
          offered: isFeedPublication(paper),
          keys: workKeys(paper),
          lanes: published >= since ? recordLanes(paper) : [],
        },
      };
    });
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
 * - a paper past its keeping date, or in no category, notable, working-paper,
 *   area or followed lane, goes, unless readers still rank their feed by it
 *   (`liked_until`). The lane of an OpenAlex entity nobody follows keeps
 *   nothing: nearly every enriched paper names an author, so it would keep
 *   every paper its category trimmed. A later follow of that entity starts
 *   without those papers, until its own harvest lists them.
 */
export async function evictExpired(env: StoreEnv, now = Date.now()) {
  const db = database(env);
  const cutoff = new Date(now).toISOString();
  const { results: crowded } = await db.prepare('SELECT lane FROM work_lanes GROUP BY lane HAVING COUNT(*) > ?')
    .bind(FEED_CANDIDATE_LIMIT).all<{ lane: string }>();
  const notableLanes = [...LEAF_IDS].map(leaf => `${NOTABLE_LANE_PREFIX}${leaf}`);
  const trims = [
    db.prepare('DELETE FROM work_lanes WHERE lane IN (SELECT value FROM json_each(?)) AND listed_until < ?').bind(JSON.stringify(notableLanes), cutoff),
    ...crowded.map(({ lane }) => db.prepare(`DELETE FROM work_lanes WHERE lane = ? AND work_id IN (
      SELECT work_id FROM work_lanes WHERE lane = ? ORDER BY published DESC LIMIT -1 OFFSET ?)`).bind(lane, lane, FEED_CANDIDATE_LIMIT)),
  ];
  for (let start = 0; start < trims.length; start += 50) await db.batch(trims.slice(start, start + 50));
  // Rows filed before publishedOf refused dates ahead leave too.
  const ahead = new Date(now + DAY_MS).toISOString();
  const keeping = JSON.stringify([...LEAF_IDS, ...notableLanes, WORKING_PAPERS_LANE, ...AREA_LANE_AREAS.map(areaLane)]);
  const leaving = `(SELECT id FROM works w WHERE (w.liked_until IS NULL OR w.liked_until < ?)
    AND (w.kept_until < ? OR w.published > ? OR NOT EXISTS (SELECT 1 FROM work_lanes l WHERE l.work_id = w.id
      AND (l.lane IN (SELECT value FROM json_each(?)) OR l.lane IN (SELECT lane FROM followed_lanes)))))`;
  await db.batch([
    db.prepare(`DELETE FROM work_keys WHERE work_id IN ${leaving}`).bind(cutoff, cutoff, ahead, keeping),
    db.prepare(`DELETE FROM work_vectors WHERE work_id IN ${leaving}`).bind(cutoff, cutoff, ahead, keeping),
    db.prepare(`DELETE FROM work_lanes WHERE work_id IN ${leaving}`).bind(cutoff, cutoff, ahead, keeping),
    db.prepare(`DELETE FROM works WHERE id IN ${leaving}`).bind(cutoff, cutoff, ahead, keeping),
  ]);
}

// ─── Embedding ───

const estimatedTokens = (texts: string[]) => texts.reduce((sum, value) => sum + Math.ceil(value.length / 3), 0);

/** A share of the day's embedding limit: a ledger subject, and the most it may reserve. */
interface EmbeddingShare { subject: string; tokens: number }

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

/** The given works that have no vector yet, embedded within the reader's share of today's budget. */
export async function embedWorks(env: StoreEnv, workIds: number[], uid: string) {
  if (workIds.length === 0) return 0;
  const rows = await claimUnembedded(database(env), 'w.id IN (SELECT value FROM json_each(?))', [JSON.stringify(workIds)], workIds.length);
  return embedRows(env, rows, { subject: `uid:${uid}`, tokens: READER_EMBEDDING_DAILY_TOKENS });
}

// ─── Reading ───

/**
 * Semantic relevance with near-copy rejection and a bounded diversity pass.
 * Missing vectors retain recency so the feed remains usable during embedding.
 * Rows it cannot tell apart keep their order (`readCandidates`).
 */
export function rankBySimilarity<T extends { embedding: Int8Array | null; published: string }>(rows: T[], positives: Int8Array[], { now = Date.now(), order = 'recent', negatives = [] }: { now?: number; order?: keyof typeof RECENCY_WEIGHT; negatives?: Int8Array[] } = {}) {
  const weight = RECENCY_WEIGHT[order] ?? RECENCY_WEIGHT.recent;
  const likedVectors = positives.map(unitVector);
  const rejectedVectors = negatives.map(unitVector);
  const recency = (published: string) => 0.5 ** (Math.max(0, now - Date.parse(published)) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
  const ranked = rows
    .map(row => {
      const embedding = row.embedding ? unitVector(row.embedding) : null;
      const similarity = positives.length && embedding
        ? likedVectors.reduce((best, positive) => Math.max(best, cosine(embedding, positive)), -1) : 0;
      const rejectedSimilarity = embedding
        ? rejectedVectors.reduce((best, negative) => Math.max(best, cosine(embedding, negative)), 0) : 0;
      const negative = Math.max(0, (rejectedSimilarity - NEGATIVE_SIMILARITY_THRESHOLD) / (1 - NEGATIVE_SIMILARITY_THRESHOLD));
      // A fixed scale keeps an uninformative page from stretching its best
      // match to 100%. The client's contribution is bounded independently.
      const semanticScore = Math.max(0, Math.min(1, (similarity - 0.4) / 0.4)) - negative;
      return { row, embedding, score: similarity - NEGATIVE_WEIGHT * negative + weight * recency(row.published), semanticScore };
    })
    .sort((a, b) => b.score - a.score || b.row.published.localeCompare(a.row.published));
  if (!positives.length && !negatives.length) return ranked;
  // Limit both the pool and selected prefix: a full 4,000 x 4,000 MMR pass
  // would dominate Worker CPU. The untouched tail remains available.
  const pool = ranked.slice(0, DIVERSITY_POOL).map(candidate => ({ candidate, redundancy: 0 }));
  const selected: typeof ranked = [];
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
        if (entry.candidate.embedding) entry.redundancy = Math.max(entry.redundancy, Math.max(0, (cosine(embedding, entry.candidate.embedding) - 0.75) / 0.25));
      }
    }
  }
  const chosen = new Set(selected);
  return [...selected, ...ranked.filter(candidate => !chosen.has(candidate))];
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
  await db.prepare(`UPDATE works SET liked_until = ? WHERE id IN (SELECT value FROM json_each(?))
    AND (liked_until IS NULL OR liked_until < ?)`)
    .bind(daysFromNow(KEEP_LIKED_DAYS, now), JSON.stringify(workIds), daysFromNow(KEEP_LIKED_DAYS - 1, now)).run();
}

interface Candidate { workId: number; published: string; lanes: string[] }

// One statement per lane, in one batch: D1 refuses a compound SELECT of more
// than a few terms ("too many terms in compound SELECT"), and a reader asks
// for up to a dozen categories and twenty follows. The candidates come in
// turns across the lanes, each lane's newest first, and the ranking keeps that
// order among papers it cannot tell apart: one night's articles of two areas
// share their date, and take turns between the areas instead of following the
// order the lanes were asked in. The notable read passes its own `share` and
// `since` (NOTABLE_READ_PER_LANE, notableSince).
async function readCandidates(db: D1Database, lanes: string[], { share: fixedShare, since = '' }: { share?: number; since?: string } = {}): Promise<Candidate[]> {
  const areaLanes = lanes.filter(lane => AREA_LANES.has(lane)).length;
  const share = (lane: string) => fixedShare ?? (AREA_LANES.has(lane)
    ? Math.floor(AREA_CANDIDATE_LIMIT / areaLanes)
    : Math.ceil(FEED_CANDIDATE_LIMIT / (lanes.length - areaLanes)));
  const perLane = await db.batch<{ work_id: number; published: string }>(lanes.map(lane => db.prepare(
    'SELECT work_id, published FROM work_lanes WHERE lane = ? AND published >= ? ORDER BY published DESC LIMIT ?',
  ).bind(lane, since, share(lane))));
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
async function readVectors(db: D1Database, workIds: number[]) {
  const vectors = new Map<number, Int8Array>();
  const chunks: D1PreparedStatement[] = [];
  for (let start = 0; start < workIds.length; start += 2_000) {
    chunks.push(db.prepare('SELECT work_id, embedding FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(workIds.slice(start, start + 2_000))));
  }
  if (chunks.length === 0) return vectors;
  for (const { results } of await db.batch<{ work_id: number; embedding: unknown }>(chunks)) {
    results.forEach(row => vectors.set(row.work_id, readVector(row.embedding)));
  }
  return vectors;
}

export interface FeedFollow { type: PaperFollowMatch['type']; canonicalId: string; displayName?: string; lane: string }

export interface FeedQuery {
  categories: string[];
  follows: FeedFollow[];
  positiveIds: string[];
  negativeIds: string[];
  excludedIds: string[];
  page: number;
  pageSize: number;
  order: keyof typeof RECENCY_WEIGHT;
  // The papers the reader has seen (`feedSeenFilter`); without it, no notable papers.
  seen: BloomFilter | null;
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
/** A reader's ranked candidates, kept for the pages after the first. */
export interface RankedCandidate { workId: number; lanes: string[]; semanticScore?: number }
/**
 * The order a reader's pages were served from. `served` counts the ranks
 * pages have covered, including the empty ones of a page the order ran out
 * on, which `ranks` holds as null. A `final` order serves the next pages as
 * it is; otherwise a next page keeps only the ranks served and ranks the rest
 * again. `notable` is the asked categories' notable papers, closest first,
 * which no rank holds: each page reads the ones its reader has not seen.
 */
export interface KeptRanking { ranks: Array<RankedCandidate | null>; served: number; final: boolean; notable?: RankedCandidate[] }
export interface RankingCache {
  get(key: string): Promise<KeptRanking | null>;
  put(key: string, ranking: KeptRanking): Promise<void>;
}

/**
 * A page of corpus papers in the asked categories and followed entities,
 * ordered by the closest of the reader's liked or saved papers, or newest
 * first without any. Each paper says which asked categories it was found in
 * (`_fetchedFor`) and which follows (`_followedEntityMatches`).
 *
 * The first page ranks every candidate and leaves the order in `cache`; a
 * later page of the same request reads only its own papers from a final
 * order. Otherwise it ranks again, after the ranks already served: a paper
 * that arrived since starts on this page, and none served comes back. An
 * order with nothing left to serve is not final: the lanes may be about to
 * fill.
 */
export async function readFeedPage(env: StoreEnv, query: FeedQuery, { now = Date.now(), cache }: { now?: number; cache?: RankingCache } = {}) {
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
  const cacheKey = JSON.stringify({ lanes, positives: [...query.positiveIds].sort(), negatives: [...query.negativeIds].sort(), excluded: [...query.excludedIds].sort(), order: query.order, pageSize: query.pageSize, notable: query.notable > 0 });
  const kept = query.page > 0 && cache ? await cache.get(cacheKey).catch(() => null) : null;
  let ranking = kept?.final ? kept.ranks : null;
  let notable = kept?.notable ?? [];
  if (!ranking) {
    const served = Array.from({ length: Math.min(kept?.served ?? 0, query.page * query.pageSize) }, (_, index) => kept!.ranks[index] ?? null);
    const shown = new Set(served.map(candidate => candidate?.workId));
    const ranked = await rankCandidates(db, lanes, query, now);
    const fresh = ranked.ranks.filter(candidate => !shown.has(candidate.workId));
    // Floored after the ranks served, so its windows start where a page does,
    // and only for the feed's page: the app's exploration asks 2 to 8 cards of
    // nearby categories, whose area lanes are the feed's own, and floored they
    // would repeat the articles the feed's pages have placed.
    ranking = [...served, ...(query.pageSize === FEED_PAGE_SIZE ? withJournalFloor(fresh) : fresh)];
    notable = ranked.notable;
    const through = (query.page + 1) * query.pageSize;
    await cache?.put(cacheKey, { ranks: ranking, served: through, final: ranking.length > through, notable })
      .catch(error => console.warn('Feed ranking not cached', error));
  }
  const ranked = ranking.slice(query.page * query.pageSize, (query.page + 1) * query.pageSize).filter(candidate => candidate !== null);
  if (ranked.length === 0) return [];
  // After the page's own papers, for the app to place: one it leaves out is
  // still unseen, so a later page offers it again.
  const unseen = query.seen && query.notable > 0 ? await unseenNotable(db, notable, query.seen, query.notable) : [];
  const notableIds = new Set(unseen.map(candidate => candidate.workId));
  const candidates = [...ranked, ...unseen];
  const works = await readWorks(db, candidates.map(candidate => candidate.workId));
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
 * The notable papers in `ranked` the reader has not seen, in order, until
 * `wanted` are found. The filter holds the ids the app was served, so each
 * candidate's is read from its row.
 */
async function unseenNotable(db: D1Database, ranked: RankedCandidate[], seen: BloomFilter, wanted: number) {
  const unseen: RankedCandidate[] = [];
  for (let start = 0; start < ranked.length && unseen.length < wanted; start += 200) {
    const chunk = ranked.slice(start, start + 200);
    const { results } = await db.prepare("SELECT id, paper ->> '$.id' AS paper_id FROM works WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(chunk.map(candidate => candidate.workId))).all<{ id: number; paper_id: string }>();
    const paperIds = new Map(results.map(row => [row.id, row.paper_id]));
    unseen.push(...chunk.filter(candidate => paperIds.has(candidate.workId) && !hasSeenPaper(seen, paperIds.get(candidate.workId))));
  }
  return unseen.slice(0, wanted);
}

async function rankCandidates(db: D1Database, lanes: string[], query: FeedQuery, now: number): Promise<{ ranks: RankedCandidate[]; notable: RankedCandidate[] }> {
  const works = await findWorks(db, [...query.positiveIds, ...query.negativeIds, ...query.excludedIds]);
  const positiveIds = [...new Set(query.positiveIds.flatMap(id => works.has(id) ? [works.get(id)!] : []))];
  const negativeIds = [...new Set(query.negativeIds.flatMap(id => works.has(id) ? [works.get(id)!] : []))];
  const notableLanes = query.notable > 0 ? query.categories.map(category => `${NOTABLE_LANE_PREFIX}${category}`) : [];
  const [candidates, notableCandidates, signals] = await Promise.all([
    // Each lane contributes its newest share of the candidates through its own
    // index range, which stops at the share: one query over the whole window
    // read every row of it (146k rows for five busy cs categories, 2026-10-22),
    // and D1 bills rows read. A quiet lane keeps its share instead of being
    // crowded out by a busy one; the area lanes share AREA_CANDIDATE_LIMIT.
    // The window is the corpus's own: what is past it has been evicted.
    readCandidates(db, lanes),
    // A notable lane keeps a paper two weeks past its last listing; from
    // 1 January, the year that left the window is not read.
    notableLanes.length ? readCandidates(db, notableLanes, { share: NOTABLE_READ_PER_LANE, since: notableSince(now) }) : Promise.resolve([]),
    readVectors(db, [...new Set([...positiveIds, ...negativeIds])]),
  ]);
  const likes = positiveIds.flatMap(id => signals.has(id) ? [signals.get(id)!] : []);
  const negatives = negativeIds.flatMap(id => signals.has(id) ? [signals.get(id)!] : []);
  // A liked paper is not offered again, and keeps its vector in the corpus. A
  // liked, rejected or excluded paper comes neither as a rank nor as a notable card.
  const excluded = new Set([...positiveIds, ...negativeIds, ...query.excludedIds.flatMap(id => works.has(id) ? [works.get(id)!] : [])]);
  // A paper of the reader's notable lanes comes only as a notable card.
  const inNotableLanes = new Set(notableCandidates.map(candidate => candidate.workId));
  const offered = candidates.filter(candidate => !excluded.has(candidate.workId) && !inNotableLanes.has(candidate.workId));
  const offeredNotable = notableCandidates.filter(candidate => !excluded.has(candidate.workId));
  const [vectors] = await Promise.all([
    // Without a positive or negative vector, recency needs no candidate vectors.
    likes.length || negatives.length ? readVectors(db, [...offered, ...offeredNotable].map(candidate => candidate.workId)) : new Map<number, Int8Array>(),
    keepLiked(db, positiveIds, now),
  ]);
  const withVector = (candidate: Candidate) => ({ ...candidate, embedding: vectors.get(candidate.workId) ?? null });
  return {
    ranks: rankBySimilarity(offered.map(withVector), likes, { now, order: query.order, negatives })
      .map(({ row, semanticScore }) => ({ workId: row.workId, lanes: row.lanes, semanticScore })),
    // The closest notable papers first, without recency: they are years old by design.
    notable: rankBySimilarity(offeredNotable.map(withVector), likes, { now, order: 'relevance', negatives })
      .map(({ row, semanticScore }) => ({ workId: row.workId, lanes: row.lanes.map(lane => lane.slice(NOTABLE_LANE_PREFIX.length)), semanticScore })),
  };
}

/**
 * The order with at least JOURNAL_FLOOR area-lane articles in each page of
 * FEED_PAGE_SIZE ranks while any are left. The articles a page is owed take
 * its last ranks; every other candidate keeps its order. A journal article
 * filed under a leaf (a topic lane, PubMed) shares the leaf's lane with its
 * preprints, so only the area lanes' articles count here.
 */
function withJournalFloor(ranked: RankedCandidate[]) {
  const articles: number[] = [];
  const others: number[] = [];
  ranked.forEach((candidate, index) => (candidate.lanes.some(lane => AREA_LANES.has(lane)) ? articles : others).push(index));
  if (articles.length === 0) return ranked;
  const floored: RankedCandidate[] = [];
  let [article, other, inWindow] = [0, 0, 0];
  while (floored.length < ranked.length) {
    const slot = floored.length % FEED_PAGE_SIZE;
    if (slot === 0) inWindow = 0;
    const owed = Math.min(JOURNAL_FLOOR - inWindow, articles.length - article);
    const takesArticle = article < articles.length
      && (other === others.length || owed >= FEED_PAGE_SIZE - slot || articles[article] < others[other]);
    if (takesArticle) inWindow += 1;
    floored.push(ranked[takesArticle ? articles[article++] : others[other++]]);
  }
  return floored;
}

// ─── Requests ───

const CATEGORY_ID = /^[\w.-]{1,32}$/;
const FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project']);

/**
 * The lane a followed entity is served from: the OpenAlex entity a paper
 * names, a search for a followed query or an author known by name only, or
 * a funded project. A topic that is one of the app's categories is asked for
 * as that category instead, and gets no lane here.
 */
export function followLane(follow: { type?: unknown; canonicalId?: unknown; displayName?: unknown; metadata?: { query?: unknown; funder?: unknown } | null }) {
  const type = text(follow?.type);
  const canonicalId = text(follow?.canonicalId).split('/').pop()!.slice(0, 200);
  if (!FOLLOW_TYPES.has(type) || !canonicalId) return '';
  if (type === 'project') {
    const funder = text(follow.metadata?.funder).slice(0, 80);
    return `project:${funder ? `${funder}|` : ''}${canonicalId}`;
  }
  const entity = entityLane(canonicalId);
  if (entity && (type === 'topic' ? /^(topic|concept):/.test(entity) : entity.startsWith(`${type}:`))) return entity;
  if (LEAF_IDS.has(canonicalId)) return '';
  const query = text(type === 'topic' ? follow.metadata?.query || follow.displayName : follow.displayName).toLowerCase().slice(0, 120);
  if (!query) return '';
  return type === 'author' ? `author-name:${query}` : type === 'topic' ? `query:${query}` : '';
}

export interface FeedRequestBody {
  categories?: unknown; follows?: unknown; positiveIds?: unknown; negativeIds?: unknown; excludedIds?: unknown; page?: unknown; pageSize?: unknown; order?: unknown;
  seen?: unknown; notable?: unknown; waitForLikes?: unknown;
}

export function parseFeedRequest(body: FeedRequestBody | null): FeedQuery {
  const categories = [...new Set((Array.isArray(body?.categories) ? body.categories : []).map(text).filter(category => CATEGORY_ID.test(category)))]
    .slice(0, FEED_MAX_CATEGORIES);
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
  const positiveIds = [...new Set((Array.isArray(body?.positiveIds) ? body.positiveIds : []).map(id => text(id).slice(0, 300)).filter(Boolean))]
    .slice(0, FEED_MAX_POSITIVES);
  const negativeIds = [...new Set((Array.isArray(body?.negativeIds) ? body.negativeIds : []).filter((id): id is string => typeof id === 'string').map(id => id.trim().slice(0, 300)).filter(Boolean))].slice(0, FEED_MAX_POSITIVES);
  const excludedIds = [...new Set((Array.isArray(body?.excludedIds) ? body.excludedIds : []).filter((id): id is string => typeof id === 'string').map(id => id.trim().slice(0, 300)).filter(Boolean))].slice(0, FEED_MAX_EXCLUDED);
  const seen = body?.seen === undefined ? null : readFeedSeenFilter(body.seen);
  if (body?.seen !== undefined && !seen) throw new PaperStoreError('SEEN_INVALID', 400);
  return {
    categories,
    follows,
    positiveIds,
    negativeIds,
    excludedIds,
    page: Math.max(0, Math.floor(Number(body?.page) || 0)),
    pageSize: Math.min(Math.max(1, Math.floor(Number(body?.pageSize) || FEED_PAGE_SIZE)), FEED_MAX_PAGE_SIZE),
    order: body?.order === 'relevance' ? 'relevance' : 'recent',
    seen,
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
