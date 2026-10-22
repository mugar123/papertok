import type { Paper } from '../src/models/Paper.ts';
import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FeedRequestBody, StoreEnv } from './paper-store.ts';

import {
  FEED_LAST_PAGE, KEEP_LIKED_DAYS, PaperStoreError, database, daysFromNow, embedWorks, findWorks, parseFeedRequest, readFeedPage,
  readPapersByIds, reserveFeedRequest,
} from './paper-store.ts';
import { ingestPaperIds } from './paper-sources.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

// The routes that read the paper corpus (paper-store.ts) for a reader.

type FeedEnv = StoreEnv & WorkerEnv;

const ENOUGH_STORED_POSITIVES = 3;
const LIKED_LOOKUP_MAX_PAPERS = 10;
// A followed lane asked for again within a day is not written again.
const FOLLOW_REFRESH_MS = 86_400_000;
// New followed lanes a reader may add to the harvest a day, and the whole app.
// A new lane costs a Workflow run and OpenAlex calls (ten for a search), so
// one account cannot spend the day's budget on lanes nobody reads.
const NEW_FOLLOWED_LANES_PER_READER = 20;
const NEW_FOLLOWED_LANES_PER_DAY = 2_000;

/**
 * Liked papers the corpus cannot rank against yet, fetched and embedded. Only
 * for a profile with fewer than ENOUGH_STORED_POSITIVES ranked likes: a reader
 * with a few already gets a ranked page, and the lookup delays the page it
 * serves. Failures leave the page ranked by the likes already stored.
 */
function embedMissingPositives(env: FeedEnv, positiveIds: string[]) {
  return async (db: D1Database, workByPaperId: Map<string, number>) => {
    try {
      const workIds = [...new Set(workByPaperId.values())];
      const { results } = workIds.length
        ? await db.prepare('SELECT work_id FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(workIds)).all<{ work_id: number }>()
        : { results: [] };
      if (results.length >= ENOUGH_STORED_POSITIVES) return;
      const absent = positiveIds.filter(id => !workByPaperId.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
      if (absent.length) await ingestPaperIds(env, absent, { keepUntil: daysFromNow(KEEP_LIKED_DAYS) });
      const found = await findWorks(db, positiveIds.slice(0, LIKED_LOOKUP_MAX_PAPERS));
      await embedWorks(env, [...new Set(found.values())]);
    } catch (error) {
      console.warn('Paper store could not add liked papers', error);
    }
  };
}

/**
 * Notes the followed lanes a reader asked for, so the daily harvest keeps them
 * served, and starts a harvest of the ones nobody had asked for yet: their
 * papers arrive for the reader's next page rather than tomorrow's.
 */
async function registerFollowedLanes(env: FeedEnv, uid: string, lanes: string[], now = Date.now()) {
  if (lanes.length === 0 || !env.PAPER_STORE) return;
  const db = env.PAPER_STORE;
  const { results } = await db.prepare('SELECT lane, requested_at FROM followed_lanes WHERE lane IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(lanes)).all<{ lane: string; requested_at: string }>();
  const known = new Map(results.map(row => [row.lane, row.requested_at]));
  const due = lanes.filter(lane => known.has(lane) && Date.parse(known.get(lane)!) < now - FOLLOW_REFRESH_MS);
  let fresh = lanes.filter(lane => !known.has(lane));
  if (fresh.length) {
    const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER ?? null, {
      periodKey: `followed-lanes:day:${new Date(now).toISOString().slice(0, 10)}`,
      subject: `uid:${uid}`,
      subjectLimit: NEW_FOLLOWED_LANES_PER_READER,
      globalLimit: NEW_FOLLOWED_LANES_PER_DAY,
      amount: fresh.length,
    });
    // Past the allowance the follow is still served from what the corpus has.
    if (!reservation.accepted) fresh = [];
  }
  const written = [...due, ...fresh];
  if (written.length === 0) return;
  await db.prepare(`INSERT INTO followed_lanes (lane, requested_at) SELECT value, ? FROM json_each(?) WHERE true
    ON CONFLICT (lane) DO UPDATE SET requested_at = excluded.requested_at`).bind(new Date(now).toISOString(), JSON.stringify(written)).run();
  if (fresh.length && env.PAPER_HARVEST) {
    try {
      await env.PAPER_HARVEST.create({ id: `follow-${new Date(now).toISOString().slice(0, 10)}-${crypto.randomUUID()}`, params: { lanes: fresh } });
    } catch (error) {
      console.warn('Followed lanes harvest did not start', error);
    }
  }
}

const LOOKUP_MAX_IDS = 30;

function readBody<T>(request: Request) {
  return readBoundedJson<T>(request, 16_384, {
    tooLarge: () => new PaperStoreError('PAYLOAD_TOO_LARGE', 413),
    invalid: () => new PaperStoreError('INVALID_JSON', 400),
  });
}

/**
 * `POST /store/papers`: a page of corpus papers for the reader's categories,
 * follows and likes, or with `ids`, the corpus's copies of those papers.
 */
export async function handleCorpusFeed(request: Request, env: FeedEnv, identity: Pick<VerifiedIdentity, 'uid'>): Promise<{ papers: Paper[] }> {
  const body = await readBody<FeedRequestBody & { ids?: unknown }>(request);
  if (Array.isArray(body?.ids)) {
    const ids = [...new Set(body.ids.map(id => String(id ?? '').trim().slice(0, 300)).filter(Boolean))].slice(0, LOOKUP_MAX_IDS);
    if (ids.length === 0) throw new PaperStoreError('IDS_REQUIRED', 400);
    await reserveFeedRequest(env, identity.uid);
    const found = await findWorks(database(env), ids);
    const absent = ids.filter(id => !found.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
    if (absent.length) {
      await ingestPaperIds(env, absent, { keepUntil: daysFromNow(KEEP_LIKED_DAYS) }).catch(error => console.warn('Paper store could not add asked papers', error));
    }
    return { papers: await readPapersByIds(env, ids) };
  }
  const query = parseFeedRequest(body);
  if (query.categories.length === 0 && query.follows.length === 0) {
    // Follows that are all categories, or name nothing a lane serves, have no papers of their own.
    if (Array.isArray(body?.follows) && body.follows.length > 0) return { papers: [] };
    throw new PaperStoreError('LANES_REQUIRED', 400);
  }
  await reserveFeedRequest(env, identity.uid);
  if (query.page > FEED_LAST_PAGE) return { papers: [] };
  await registerFollowedLanes(env, identity.uid, query.follows.map(follow => follow.lane));
  // Only a first page of categories looks liked papers up: the follows asked
  // beside it, and later pages, would repeat the same lookup.
  const looksUp = query.page === 0 && query.follows.length === 0;
  return { papers: await readFeedPage(env, query, looksUp ? { embedMissing: embedMissingPositives(env, query.positiveIds) } : {}) };
}

/**
 * `POST /store/feed`, the arXiv-only contract of the bundles published before
 * the corpus (2026-10-22): the same page in its old shape, arXiv papers only.
 * Remove once those bundles have updated themselves.
 */
export async function handleStoreFeed(request: Request, env: FeedEnv, identity: Pick<VerifiedIdentity, 'uid'>) {
  const body = await readBody<FeedRequestBody>(request);
  const query = parseFeedRequest({ categories: body?.categories, positiveIds: body?.positiveIds, page: body?.page, pageSize: body?.pageSize });
  if (query.categories.length === 0) throw new PaperStoreError('CATEGORIES_REQUIRED', 400);
  if (query.page > FEED_LAST_PAGE) return { papers: [] };
  await reserveFeedRequest(env, identity.uid);
  const papers = await readFeedPage(env, query);
  return {
    papers: papers.filter(paper => paper.arxivId && paper.sources?.primary === 'arxiv').map(paper => ({
      arxivId: paper.arxivId,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors.map(author => (typeof author === 'string' ? author : author.name)),
      categories: paper.allCategories || paper.categories || [],
      doi: paper.doi || null,
      journalRef: paper.journal || null,
      comments: null,
      published: paper.published,
    })),
  };
}
