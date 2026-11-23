import type { OpenAlexAuthor, OpenAlexPage } from '../src/services/adapters/open-alex-types.ts';
import type { WorkerEnv } from './env.ts';

import { handleHarvestOpenAlex, openAlexFilterBatches } from './openalex-api.ts';
import { CORPUS_DAYS, daysFromNow } from './paper-store.ts';

const AUTHOR_REFRESH_DAYS = 30;
const AUTHOR_RETENTION_DAYS = 365;
// Provisional until the post-harvest /health/openalex/budget reading. The newest week took 576 calls.
const AUTHOR_NIGHTLY_CALLS = 600;
export const AUTHOR_IMPACT_PART = { subject: 'openalex:harvest:author-impact', limit: AUTHOR_NIGHTLY_CALLS };
const AUTHORS_PER_CALL = 100;
const PAPERS_PER_PAGE = 500;
const AUTHOR_CAP = 0.035;
const HF_CAP = 0.025;
const H_INDEX_AT_CAP = 100;
const VOTES_AT_CAP = 100;
const QUALITY_CAP = 0.05;

export interface QualityCursor { published: string; id: number }
interface Candidate extends QualityCursor {
  author_ids: string | null;
  votes: number | null;
}

const positive = (value: number | null | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const bonus = (value: number | null, scale: number, cap: number) => cap * Math.min(1, Math.log1p(value ?? 0) / Math.log1p(scale));

function quality(h: number | null, votes: number | null) {
  const authorBonus = bonus(h, H_INDEX_AT_CAP, AUTHOR_CAP);
  const hfBonus = bonus(votes, VOTES_AT_CAP, HF_CAP);
  return { h, votes, authorBonus, hfBonus, score: Math.min(QUALITY_CAP, authorBonus + hfBonus) };
}

function authorId(value: unknown) {
  return typeof value === 'string' ? /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:authors\/)?)?(A\d+)$/i.exec(value.trim())?.[1].toUpperCase() : undefined;
}

async function fetchImpact(env: WorkerEnv, ids: string[]) {
  const url = new URL('https://papertok.internal/openalex/authors');
  url.searchParams.set('filter', 'openalex:' + ids.toSorted().join('|'));
  url.searchParams.set('select', 'id,summary_stats');
  url.searchParams.set('per_page', String(AUTHORS_PER_CALL));
  const response = await handleHarvestOpenAlex(new Request(url), env, { part: AUTHOR_IMPACT_PART });
  if (response.status === 429) return null;
  if (!response.ok) throw new Error(`OpenAlex author list returned HTTP ${response.status}`);
  const page = await response.json<OpenAlexPage<OpenAlexAuthor>>();
  if (!Array.isArray(page?.results)) throw new Error('OpenAlex author list is missing results');

  // Only a valid record says anything: an author the answer leaves out, or
  // returns malformed, is not known to have no h-index, so it gets no entry
  // and keeps whatever value the cache already holds (`storeAuthorBatches`).
  const requested = new Set(ids);
  const metrics = new Map<string, number | null>();
  for (const author of page.results) {
    const id = authorId(author?.id);
    if (!id || !requested.has(id)) continue;
    const h = author.summary_stats?.h_index;
    if (h != null && (!Number.isSafeInteger(h) || h < 0)) continue;
    metrics.set(id, h ?? null);
  }
  const unanswered = ids.filter(id => !metrics.has(id)).length;
  if (unanswered) console.warn(`OpenAlex author list gave no valid record for ${unanswered} of ${ids.length} authors`);
  return metrics;
}

interface CachedAuthor { author_id: string; h_index: number | null; fetched_at: string }

async function cachedImpact(db: D1Database, ids: string[]) {
  const metrics = new Map<string, CachedAuthor>();
  if (!ids.length) return metrics;
  const cached = await db.prepare(`SELECT author_id, h_index, fetched_at FROM openalex_author_impact
    WHERE author_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<CachedAuthor>();
  for (const row of cached.results) metrics.set(row.author_id, row);
  return metrics;
}

// Cap each delete transaction when many entries from the initial load expire together.
export async function prunePaperQuality(db: D1Database, now: number) {
  const limit = 2000;
  const results = await db.batch([
    db.prepare(`DELETE FROM openalex_author_impact WHERE author_id IN
      (SELECT author_id FROM openalex_author_impact WHERE fetched_at <= ? LIMIT ?)`).bind(daysFromNow(-AUTHOR_RETENTION_DAYS, now), limit),
    db.prepare(`DELETE FROM work_quality WHERE work_id IN
      (SELECT work_id FROM work_quality WHERE published <= ? LIMIT ?)`).bind(daysFromNow(-CORPUS_DAYS, now), limit),
  ]);
  return results.some(result => result.meta.changes === limit);
}

// An unknown count (absent or stored as zero with citationCountKnown false) stays eligible.
const QUALITY_CITATIONS = "(w.paper ->> 'citationCount' IS NULL OR w.paper ->> 'citationCount' < 5)";

async function qualityPage(db: D1Database, now: number, after: QualityCursor | null) {
  // Separate index seeks for the rest of a tied timestamp and for earlier dates.
  // The store can have thousands of papers published at the same UTC midnight.
  const pageQuery = after ? `SELECT published, id FROM works WHERE published = ? AND id > ?
    UNION ALL
    SELECT published, id FROM works WHERE published < ? AND published > ?`
    : 'SELECT published, id FROM works WHERE published > ?';
  const cursor = after ? [after.published, after.id, after.published] : [];
  const { results } = await db.prepare(`WITH page AS (
    ${pageQuery} ORDER BY published DESC, id ASC LIMIT ?
  ) SELECT p.id, p.published, w.paper ->> 'huggingFaceUpvotes' AS votes,
    CASE WHEN json_array_length(w.paper, '$.authors') > 30 THEN NULL
      ELSE json_extract(w.paper, '$.authors[0].id', '$.authors[#-3].id', '$.authors[#-2].id', '$.authors[#-1].id') END AS author_ids
    FROM page p LEFT JOIN works w ON w.id = p.id AND ${QUALITY_CITATIONS}
    ORDER BY p.published DESC, p.id ASC`)
    .bind(...cursor, daysFromNow(-CORPUS_DAYS, now), PAPERS_PER_PAGE).all<Candidate>();
  const papers = results.map(row => {
    const authors: unknown[] = row.author_ids ? JSON.parse(row.author_ids) as unknown[] : [];
    return { ...row, ids: authors.map(authorId).filter((id): id is string => Boolean(id)) };
  });
  const last = results.at(-1);
  const next = last && results.length === PAPERS_PER_PAGE ? { published: last.published, id: last.id } : null;
  return { papers, next };
}

export type AuthorProgress = { after: QualityCursor | null; pending: string[] } | 'refresh';

async function storeAuthorBatches(db: D1Database, env: WorkerEnv, batches: string[][]) {
  for (const batch of batches) {
    const fetched = await fetchImpact(env, batch);
    if (!fetched) return false;
    const fetchedAt = new Date().toISOString();
    const unanswered = batch.filter(id => !fetched.has(id));
    // Checkpoint each successful request. An answered author takes the new
    // value; one the answer left out stays unknown when new and keeps its
    // last known h-index otherwise, so a refresh never erases a known value.
    await db.batch([
      db.prepare(`INSERT INTO openalex_author_impact (author_id, h_index, fetched_at)
        SELECT key, value, ? FROM json_each(?) WHERE true
        ON CONFLICT (author_id) DO UPDATE SET h_index = excluded.h_index, fetched_at = excluded.fetched_at, refresh_requested_at = NULL
        WHERE fetched_at <= excluded.fetched_at`).bind(fetchedAt, JSON.stringify(Object.fromEntries(fetched))),
      db.prepare(`INSERT INTO openalex_author_impact (author_id, h_index, fetched_at)
        SELECT value, NULL, ? FROM json_each(?) WHERE true
        ON CONFLICT (author_id) DO UPDATE SET fetched_at = excluded.fetched_at, refresh_requested_at = NULL
        WHERE fetched_at <= excluded.fetched_at`).bind(fetchedAt, JSON.stringify(unanswered)),
    ]);
  }
  return true;
}

export async function loadPaperAuthorImpact(db: D1Database, env: WorkerEnv, now: number, progress: AuthorProgress): Promise<AuthorProgress | null> {
  const runDate = new Date(now).toISOString();
  if (progress === 'refresh') {
    const due = await db.prepare(`SELECT author_id FROM openalex_author_impact WHERE refresh_requested_at = ?
      ORDER BY fetched_at, author_id LIMIT ?`).bind(runDate, AUTHORS_PER_CALL).all<{ author_id: string }>();
    const batches = openAlexFilterBatches('openalex', due.results.map(row => row.author_id), AUTHORS_PER_CALL);
    const completed = await storeAuthorBatches(db, env, batches);
    return completed && due.results.length === AUTHORS_PER_CALL ? 'refresh' : null;
  }

  const { papers, next } = await qualityPage(db, now, progress.after);
  const ids = [...new Set([...progress.pending, ...papers.flatMap(paper => paper.ids)])];
  const cached = await cachedImpact(db, ids);
  const cutoff = daysFromNow(-AUTHOR_REFRESH_DAYS, now);
  const stale = [...cached.values()].filter(row => row.fetched_at <= cutoff).map(row => row.author_id);
  if (stale.length) {
    // Only refresh authors on eligible bylines this run, once all missing IDs have had a turn.
    await db.prepare(`UPDATE openalex_author_impact SET refresh_requested_at = ?
      WHERE author_id IN (SELECT value FROM json_each(?)) AND fetched_at <= ?
      AND (refresh_requested_at IS NULL OR refresh_requested_at < ?)`).bind(runDate, JSON.stringify(stale), cutoff, runDate).run();
  }
  const missing = ids.filter(id => !cached.has(id));
  const batches = openAlexFilterBatches('openalex', missing, AUTHORS_PER_CALL);
  const last = batches.at(-1);
  const pending = next && last && last.length < AUTHORS_PER_CALL ? last : [];
  if (pending.length) batches.pop();
  if (!await storeAuthorBatches(db, env, batches)) return null;
  return next ? { after: next, pending } : 'refresh';
}

export async function computePaperQuality(db: D1Database, now: number, after: QualityCursor | null): Promise<QualityCursor | null> {
  const { papers, next } = await qualityPage(db, now, after);
  const metrics = await cachedImpact(db, [...new Set(papers.flatMap(paper => paper.ids))]);
  const scores = papers.map(paper => {
    const known = paper.ids.map(id => metrics.get(id)?.h_index).filter(h => h != null);
    const h = known.length ? Math.max(...known) : null;
    return { id: paper.id, published: paper.published, ...quality(h, positive(paper.votes)) };
  });
  const writes = [];
  const neutral = scores.filter(row => !row.score).map(row => row.id);
  if (neutral.length) writes.push(db.prepare('DELETE FROM work_quality WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(neutral)));
  const scored = scores.filter(row => row.score > 0);
  if (scored.length) writes.push(db.prepare(`INSERT INTO work_quality
    (work_id, published, max_h_index, hf_upvotes, author_bonus, hf_bonus, score)
    SELECT w.id, w.published, j.value ->> 'h', j.value ->> 'votes', j.value ->> 'authorBonus', j.value ->> 'hfBonus', j.value ->> 'score'
    FROM json_each(?) j JOIN works w ON w.id = j.value ->> 'id'
    WHERE w.published = j.value ->> 'published' AND ${QUALITY_CITATIONS}
    ON CONFLICT (work_id) DO UPDATE SET published = excluded.published, max_h_index = excluded.max_h_index,
      hf_upvotes = excluded.hf_upvotes, author_bonus = excluded.author_bonus, hf_bonus = excluded.hf_bonus, score = excluded.score
    WHERE max_h_index IS NOT excluded.max_h_index OR hf_upvotes IS NOT excluded.hf_upvotes
      OR author_bonus != excluded.author_bonus OR hf_bonus != excluded.hf_bonus OR score != excluded.score`).bind(JSON.stringify(scored)));
  if (writes.length) await db.batch(writes);

  return next;
}
