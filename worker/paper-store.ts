import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';

import { XMLParser } from 'fast-xml-parser';
import { readBoundedJson } from './bounded-body.ts';
import { fetchWithDeadline } from './provider-runtime.ts';
import { ARXIV_PACE_PERIOD_MS } from './arxiv-api.ts';
import { awaitUpstreamSlot } from './upstream-pace.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

// The paper store: arXiv harvested once a day over OAI-PMH (paper-harvest.ts),
// each paper embedded once, and the feed's arXiv leg served from D1 instead of
// one arXiv query per reader and page. Ranking compares int8 vectors in the
// Worker over the categories' recent rows; Vectorize's included allowance on
// Workers Paid (10M stored dimensions) holds fewer papers than one week.

export const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
export const EMBEDDING_DIMENSIONS = 1024;
export type EmbeddingEnv = {
  // Optional so test doubles of the binding that only convert PDFs still type-check.
  AI?: { run?: (model: string, input: { text: string[] }) => Promise<{ data?: number[][] }> };
};

const OAI_ENDPOINT = 'https://oaipmh.arxiv.org/oai';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const OAI_TIMEOUT_MS = 60_000;
// Papers first submitted longer ago than this are not harvested; the feed never
// ranks further back than FEED_WINDOW_DAYS.
export const CORPUS_DAYS = 90;
const FEED_WINDOW_DAYS = 90;
const FEED_CANDIDATE_LIMIT = 4_000;
const FEED_MAX_CATEGORIES = 10;
const FEED_MAX_POSITIVES = 24;
const FEED_MAX_PAGE_SIZE = 30;
const FEED_MAX_PAGE = 100;
const DEFAULT_FEED_USER_MINUTE_LIMIT = 60;
const DEFAULT_FEED_GLOBAL_MINUTE_LIMIT = 2_000;
const LIKED_LOOKUP_PACE_WAIT_MS = 1_000;
const LIKED_LOOKUP_TIMEOUT_MS = 2_000;
const ENOUGH_STORED_POSITIVES = 3;
const LIKED_LOOKUP_MAX_PAPERS = 10;
const EMBED_BATCH = 32;
const EMBED_TEXT_CHARS = 2_000;
// Workers AI gives 10,000 neurons a day; this model costs 1,075 per million
// input tokens (pricing page, 2026-10-22), so 7.5M estimated tokens keeps the
// store inside the free allocation with room for the PDF conversions.
const DEFAULT_EMBEDDING_DAILY_TOKEN_LIMIT = 7_500_000;
const EMBEDDING_TOKENS_PER_UNIT = 1_000;
// Similarity orders the page; recency only separates near ties, so a reader
// with likes still sees this week's papers ahead of last month's lookalikes.
const RECENCY_WEIGHT = 0.15;
const RECENCY_HALF_LIFE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface StoredPaper {
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

export class PaperStoreError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: name => ['record', 'version', 'entry', 'author', 'category'].includes(name),
});

const text = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const optional = (value: unknown) => text(value) || null;
const isoDate = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};
const versionless = (value: unknown) => text(value).replace(/^.*\/abs\//, '').replace(/v\d+$/, '');
const daysAgo = (days: number, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

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
  const papers: StoredPaper[] = [];
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

/** Papers of an arXiv API Atom feed (an `id_list` lookup). */
export function parseArxivAtom(xml: string) {
  const entries: AtomEntry[] = XML.parse(xml)?.feed?.entry || [];
  return entries.flatMap((entry): StoredPaper[] => {
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

/** The unit vector as int8 components scaled by 127, the stored form. */
export function quantize(values: number[]) {
  const norm = Math.hypot(...values) || 1;
  return Int8Array.from(values, value => Math.round((value / norm) * 127));
}

export function readVector(value: unknown) {
  if (value instanceof ArrayBuffer) return new Int8Array(value);
  if (ArrayBuffer.isView(value)) return new Int8Array(value.buffer, value.byteOffset, value.byteLength);
  return Int8Array.from(value as number[], byte => (byte > 127 ? byte - 256 : byte));
}

function cosine(a: Int8Array, b: Int8Array) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot / (127 * 127);
}

type StoreEnv = Pick<WorkerEnv, 'PAPER_STORE' | 'REQUEST_QUOTA_LEDGER' | 'EMBEDDING_DAILY_TOKEN_LIMIT'> & EmbeddingEnv;

function database(env: StoreEnv) {
  if (!env.PAPER_STORE) throw new PaperStoreError('PAPER_STORE_UNAVAILABLE', 503);
  return env.PAPER_STORE;
}

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(',');

async function storedVersions(db: D1Database, arxivIds: string[]) {
  const found = new Map<string, string>();
  for (let start = 0; start < arxivIds.length; start += 90) {
    const ids = arxivIds.slice(start, start + 90);
    const { results } = await db.prepare(`SELECT arxiv_id, updated FROM papers WHERE arxiv_id IN (${placeholders(ids.length)})`)
      .bind(...ids).all<{ arxiv_id: string; updated: string }>();
    results.forEach(row => found.set(row.arxiv_id, row.updated));
  }
  return found;
}

// D1 counts every statement of a batch towards the invocation's query limit,
// so papers travel as one JSON parameter per chunk rather than one row each.
const WRITE_CHUNK = 200;

/**
 * Writes the papers not already stored at their latest version. A changed
 * title or abstract drops the paper's vector, which the next embedding pass
 * recomputes; a new version with the same text keeps it.
 */
export async function storePapers(env: StoreEnv, papers: StoredPaper[]) {
  const db = database(env);
  const known = await storedVersions(db, papers.map(paper => paper.arxivId));
  const fresh = papers.filter(paper => known.get(paper.arxivId) !== paper.updated);
  for (let start = 0; start < fresh.length; start += WRITE_CHUNK) {
    const rows = JSON.stringify(fresh.slice(start, start + WRITE_CHUNK));
    await db.batch([
      db.prepare(`DELETE FROM paper_vectors WHERE arxiv_id IN (
        SELECT p.arxiv_id FROM json_each(?) j JOIN papers p ON p.arxiv_id = j.value ->> 'arxivId'
        WHERE p.title != j.value ->> 'title' OR p.abstract != j.value ->> 'abstract')`).bind(rows),
      db.prepare(`INSERT INTO papers (arxiv_id, title, abstract, authors, categories, doi, journal_ref, comments, published, updated)
        SELECT value ->> 'arxivId', value ->> 'title', value ->> 'abstract', value -> 'authors', value -> 'categories',
          value ->> 'doi', value ->> 'journalRef', value ->> 'comments', value ->> 'published', value ->> 'updated'
        FROM json_each(?) WHERE true
        ON CONFLICT (arxiv_id) DO UPDATE SET title = excluded.title, abstract = excluded.abstract, authors = excluded.authors,
          categories = excluded.categories, doi = excluded.doi, journal_ref = excluded.journal_ref, comments = excluded.comments,
          published = excluded.published, updated = excluded.updated`).bind(rows),
      db.prepare(`DELETE FROM paper_categories WHERE arxiv_id IN (SELECT value ->> 'arxivId' FROM json_each(?))`).bind(rows),
      db.prepare(`INSERT INTO paper_categories (category, arxiv_id, published)
        SELECT c.value, p.value ->> 'arxivId', p.value ->> 'published' FROM json_each(?) p, json_each(p.value -> 'categories') c`).bind(rows),
    ]);
  }
  return fresh.length;
}

const estimatedTokens = (texts: string[]) => texts.reduce((sum, value) => sum + Math.ceil(value.length / 3), 0);

/**
 * Reserves the embedding tokens for today before spending them. Workers AI
 * bills past the free allocation, so a ledger that cannot answer refuses.
 */
async function reserveEmbeddingTokens(env: StoreEnv, tokens: number) {
  const limit = Math.floor((Number(env.EMBEDDING_DAILY_TOKEN_LIMIT) || DEFAULT_EMBEDDING_DAILY_TOKEN_LIMIT) / EMBEDDING_TOKENS_PER_UNIT);
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, {
    periodKey: `embedding:day:${new Date().toISOString().slice(0, 10)}`,
    subject: 'embedding:all',
    subjectLimit: limit,
    globalLimit: limit,
    amount: Math.max(1, Math.ceil(tokens / EMBEDDING_TOKENS_PER_UNIT)),
  });
  if (reservation.code) console.error(`Embedding budget unavailable (${reservation.code}); nothing embedded`);
  return reservation.accepted === true;
}

async function embedTexts(env: StoreEnv, texts: string[]) {
  if (typeof env.AI?.run !== 'function') throw new PaperStoreError('EMBEDDINGS_UNAVAILABLE', 503);
  const vectors: Int8Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const { data } = await env.AI.run(EMBEDDING_MODEL, { text: batch });
    if (!Array.isArray(data) || data.length !== batch.length || data.some(vector => vector?.length !== EMBEDDING_DIMENSIONS)) {
      throw new PaperStoreError('EMBEDDINGS_INVALID', 502);
    }
    vectors.push(...data.map(quantize));
  }
  return vectors;
}

/**
 * Embeds `rows` within today's budget and stores their vectors. Returns how
 * many were embedded: 0 when the budget is spent.
 */
async function embedRows(env: StoreEnv, rows: Array<{ arxiv_id: string; title: string; abstract: string }>) {
  if (rows.length === 0) return 0;
  const texts = rows.map(row => `${row.title}\n\n${row.abstract}`.slice(0, EMBED_TEXT_CHARS));
  if (!(await reserveEmbeddingTokens(env, estimatedTokens(texts)))) return 0;
  const vectors = await embedTexts(env, texts);
  const db = database(env);
  // Two parameters a row, under D1's hundred per statement.
  const statements = [];
  for (let start = 0; start < rows.length; start += 50) {
    const chunk = rows.slice(start, start + 50);
    statements.push(db.prepare(`INSERT OR REPLACE INTO paper_vectors (arxiv_id, embedding) VALUES ${chunk.map(() => '(?, ?)').join(',')}`)
      .bind(...chunk.flatMap((row, index) => [row.arxiv_id, vectors[start + index].buffer])));
  }
  await db.batch(statements);
  return rows.length;
}

/** The newest stored papers without a vector, embedded. 0 once none are left or today's budget is spent. */
export async function embedPending(env: StoreEnv, limit: number) {
  const { results } = await database(env).prepare(`SELECT p.arxiv_id, p.title, p.abstract FROM papers p
    WHERE NOT EXISTS (SELECT 1 FROM paper_vectors v WHERE v.arxiv_id = p.arxiv_id)
    ORDER BY p.published DESC LIMIT ?`).bind(limit).all<{ arxiv_id: string; title: string; abstract: string }>();
  return embedRows(env, results);
}

/**
 * One OAI-PMH page of an arXiv set, stored without vectors. Only papers first
 * submitted within CORPUS_DAYS are kept: the set also lists revisions of old
 * papers, and a new paper is announced days after its v1 date, so `from`
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
  const since = daysAgo(CORPUS_DAYS);
  const recent = page.papers.filter(paper => paper.published >= since);
  return { stored: await storePapers(env, recent), listed: page.papers.length, resumptionToken: page.resumptionToken, retryAfterSeconds: 0 };
}

/**
 * Liked arXiv papers the harvest did not cover, fetched, stored and embedded.
 * Bounded well inside the client's deadline: a slow arXiv or a spent budget
 * leaves the page ranked by the likes already stored.
 */
async function storeMissingPositives(env: StoreEnv, arxivIds: string[]) {
  const db = database(env);
  const { results } = await db.prepare(`SELECT arxiv_id FROM paper_vectors WHERE arxiv_id IN (${placeholders(arxivIds.length)})`)
    .bind(...arxivIds).all<{ arxiv_id: string }>();
  const embedded = new Set(results.map(row => row.arxiv_id));
  // A reader with a few likes stored already gets a ranked page; the lookup is
  // for a profile the store cannot rank yet, and it delays the page it serves.
  if (embedded.size >= ENOUGH_STORED_POSITIVES) return;
  const missing = arxivIds.filter(id => !embedded.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
  if (missing.length === 0) return;
  try {
    const known = await storedVersions(db, missing);
    const unknown = missing.filter(id => !known.has(id));
    if (unknown.length) {
      const seat = env.REQUEST_QUOTA_LEDGER
        ? await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, { namespace: 'arxiv', periodMs: ARXIV_PACE_PERIOD_MS, maxWaitMs: LIKED_LOOKUP_PACE_WAIT_MS })
        : { accepted: false };
      if (seat.accepted) {
        const url = new URL(ARXIV_API);
        url.searchParams.set('id_list', unknown.join(','));
        url.searchParams.set('max_results', String(unknown.length));
        const response = await fetchWithDeadline(url, { headers: { 'user-agent': USER_AGENT } }, LIKED_LOOKUP_TIMEOUT_MS);
        if (response.ok) await storePapers(env, parseArxivAtom(await response.text()));
      }
    }
    const { results: rows } = await db.prepare(`SELECT arxiv_id, title, abstract FROM papers WHERE arxiv_id IN (${placeholders(missing.length)})`)
      .bind(...missing).all<{ arxiv_id: string; title: string; abstract: string }>();
    await embedRows(env, rows);
  } catch (error) {
    console.warn('Paper store could not add liked papers', error);
  }
}

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})$/;

// An old-style id names its archive only: math.GT/0309136 is math/0309136.
export function arxivIdOf(value: unknown) {
  const id = text(value).replace(/^arxiv:/i, '').replace(/v\d+$/, '').replace(/^([a-z-]+)\.[A-Z]{2}\//, '$1/');
  return ARXIV_ID.test(id) ? id : '';
}

/**
 * Closest liked paper first, recency as the tie-breaker. A paper not yet
 * embedded ranks by recency alone, below the ones that are, so a reader is
 * never left without papers while the store catches up.
 */
export function rankBySimilarity<T extends { embedding: Int8Array | null; published: string }>(rows: T[], positives: Int8Array[], now = Date.now()) {
  const recency = (published: string) => 0.5 ** (Math.max(0, now - Date.parse(published)) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
  return rows
    .map(row => {
      const similarity = positives.length && row.embedding
        ? positives.reduce((best, positive) => Math.max(best, cosine(row.embedding as Int8Array, positive)), -1)
        : 0;
      return { row, score: similarity + RECENCY_WEIGHT * recency(row.published) };
    })
    .sort((a, b) => b.score - a.score || b.row.published.localeCompare(a.row.published));
}

async function reserveFeedRequest(env: StoreEnv & Pick<WorkerEnv, 'PROVIDER_USER_MINUTE_LIMIT' | 'PROVIDER_GLOBAL_MINUTE_LIMIT'>, uid: string) {
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

interface CandidateRow { arxiv_id: string; published: string; embedding: unknown }
interface PaperRow {
  arxiv_id: string; title: string; abstract: string; authors: string; categories: string;
  doi: string | null; journal_ref: string | null; comments: string | null; published: string;
}
interface FeedRequest { categories?: unknown; positiveIds?: unknown; page?: unknown; pageSize?: unknown }

/**
 * A page of stored papers in the reader's categories, ordered by the closest
 * of their liked or saved papers, or newest first without any.
 */
export async function handleStoreFeed(request: Request, env: StoreEnv & WorkerEnv, identity: Pick<VerifiedIdentity, 'uid'>) {
  const body = await readBoundedJson<FeedRequest>(request, 16_384, {
    tooLarge: () => new PaperStoreError('PAYLOAD_TOO_LARGE', 413),
    invalid: () => new PaperStoreError('INVALID_JSON', 400),
  });
  const categories = [...new Set((Array.isArray(body?.categories) ? body.categories : []).map(text).filter(category => /^[\w.-]{1,32}$/.test(category)))]
    .slice(0, FEED_MAX_CATEGORIES);
  const positiveIds = [...new Set((Array.isArray(body?.positiveIds) ? body.positiveIds : []).map(arxivIdOf).filter(Boolean))]
    .slice(0, FEED_MAX_POSITIVES);
  const page = Math.max(0, Math.floor(Number(body?.page) || 0));
  const pageSize = Math.min(Math.max(1, Math.floor(Number(body?.pageSize) || 15)), FEED_MAX_PAGE_SIZE);
  if (categories.length === 0) throw new PaperStoreError('CATEGORIES_REQUIRED', 400);
  if (page > FEED_MAX_PAGE) return { papers: [] };
  await reserveFeedRequest(env, identity.uid);

  const db = database(env);
  if (positiveIds.length) await storeMissingPositives(env, positiveIds);
  const since = daysAgo(FEED_WINDOW_DAYS);
  const [candidates, positives] = await Promise.all([
    // Each category contributes its newest share of the candidates through its
    // own index range, which stops at the share: one query over the whole window
    // read every row of it (146k rows for five busy cs categories, 2026-10-22),
    // and D1 bills rows read. A quiet category keeps its share instead of being
    // crowded out by a busy one. Only the candidates' vectors are read.
    db.prepare(`SELECT c.arxiv_id, c.published, v.embedding FROM (
        SELECT arxiv_id, MAX(published) AS published FROM (${categories.map(() => `SELECT * FROM (
          SELECT arxiv_id, published FROM paper_categories WHERE category = ? AND published >= ? ORDER BY published DESC LIMIT ?)`).join(' UNION ALL ')})
        GROUP BY arxiv_id
      ) c LEFT JOIN paper_vectors v ON v.arxiv_id = c.arxiv_id`)
      .bind(...categories.flatMap(category => [category, since, Math.ceil(FEED_CANDIDATE_LIMIT / categories.length)])).all<CandidateRow>(),
    positiveIds.length
      ? db.prepare(`SELECT embedding FROM paper_vectors WHERE arxiv_id IN (${placeholders(positiveIds.length)})`).bind(...positiveIds).all<{ embedding: unknown }>()
      : Promise.resolve({ results: [] as Array<{ embedding: unknown }> }),
  ]);
  const liked = new Set(positiveIds);
  const rows = candidates.results
    .filter(row => !liked.has(row.arxiv_id))
    .map(row => ({ arxivId: row.arxiv_id, published: row.published, embedding: row.embedding == null ? null : readVector(row.embedding) }));
  const pageIds = rankBySimilarity(rows, positives.results.map(row => readVector(row.embedding)))
    .slice(page * pageSize, (page + 1) * pageSize)
    .map(({ row }) => row.arxivId);
  if (pageIds.length === 0) return { papers: [] };
  const { results } = await db.prepare(`SELECT arxiv_id, title, abstract, authors, categories, doi, journal_ref, comments, published
    FROM papers WHERE arxiv_id IN (${placeholders(pageIds.length)})`).bind(...pageIds).all<PaperRow>();
  const byId = new Map(results.map(row => [row.arxiv_id, row]));
  return {
    papers: pageIds.flatMap(id => {
      const row = byId.get(id);
      return row ? [{
        arxivId: row.arxiv_id,
        title: row.title,
        abstract: row.abstract,
        authors: JSON.parse(row.authors) as string[],
        categories: JSON.parse(row.categories) as string[],
        doi: row.doi,
        journalRef: row.journal_ref,
        comments: row.comments,
        published: row.published,
      }] : [];
    }),
  };
}
