import type { Paper } from '../src/models/Paper.ts';
import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FeedRequestBody, RankedCandidate, RankingCache, StoreEnv } from './paper-store.ts';

import {
  FEED_LAST_PAGE, KEEP_LIKED_DAYS, PaperStoreError, database, daysFromNow, embedWorks, findWorks, parseFeedRequest, readFeedPage,
  readPapersByIds, reserveFeedRequest,
} from './paper-store.ts';
import { ARXIV_HARVEST_SETS, ingestPaperIds } from './paper-sources.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_UPSTREAM_TIMEOUT_MS } from './arxiv-api.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

// The routes that read the paper corpus (paper-store.ts) for a reader.

type FeedEnv = StoreEnv & WorkerEnv;

const ENOUGH_STORED_POSITIVES = 3;
const LIKED_LOOKUP_MAX_PAPERS = 10;
// The lookup of liked papers runs after the page has answered, so it waits as
// long as the arXiv route itself may: a seat on arXiv's beat, then arXiv, plus
// a second for the route's cache read and the beat's ledger round trips. With
// the 2 s an inline lookup has, an answer arXiv sends later spends an app-wide
// seat and files nothing.
const LIKED_LOOKUP_DEADLINE_MS = ARXIV_PACE_MAX_WAIT_MS + ARXIV_UPSTREAM_TIMEOUT_MS + 1_000;
// A followed lane asked for again within a day is not written again.
const FOLLOW_REFRESH_MS = 86_400_000;
// New followed lanes a reader may add to the harvest a day, and the whole app.
// A new lane costs a Workflow run and OpenAlex calls (ten for a search), so
// one account cannot spend the day's budget on lanes nobody reads.
const NEW_FOLLOWED_LANES_PER_READER = 20;
const NEW_FOLLOWED_LANES_PER_DAY = 2_000;

/**
 * Liked papers the corpus cannot rank against yet, fetched and embedded, for
 * the reader's next page: only for a profile with fewer than
 * ENOUGH_STORED_POSITIVES ranked likes, since a reader with a few already gets
 * a ranked page. Embedded within the reader's own share of the day. Failures
 * leave the likes already stored.
 */
async function addMissingPositives(env: FeedEnv, uid: string, positiveIds: string[]) {
  try {
    const db = database(env);
    const workByPaperId = await findWorks(db, positiveIds);
    const workIds = [...new Set(workByPaperId.values())];
    const { results } = workIds.length
      ? await db.prepare('SELECT work_id FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(workIds)).all<{ work_id: number }>()
      : { results: [] };
    if (results.length >= ENOUGH_STORED_POSITIVES) return;
    const absent = positiveIds.filter(id => !workByPaperId.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
    if (absent.length) await ingestPaperIds(env, absent, { keepUntil: daysFromNow(KEEP_LIKED_DAYS), deadlineMs: LIKED_LOOKUP_DEADLINE_MS });
    const found = await findWorks(db, positiveIds.slice(0, LIKED_LOOKUP_MAX_PAPERS));
    await embedWorks(env, [...new Set(found.values())], uid);
  } catch (error) {
    console.warn('Paper store could not add liked papers', error);
  }
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

// How long a reader's ranked candidates serve the pages after the first: about
// a reading session. A like changes the request, and so the ranking.
const RANKING_CACHE_SECONDS = 15 * 60;

/**
 * The reader's ranking in this location's cache, under a key built from the
 * verified uid and the request: one reader's order is never another's.
 */
function rankingCache(uid: string): RankingCache | undefined {
  if (typeof caches === 'undefined') return undefined;
  const keyFor = async (key: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${uid}\n${key}`));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return new Request(`https://papertok.internal/cache/store-ranking/${hex}`);
  };
  return {
    async get(key) {
      const cached = await caches.default.match(await keyFor(key));
      return cached ? cached.json<RankedCandidate[]>() : null;
    },
    async put(key, ranking) {
      await caches.default.put(await keyFor(key), new Response(JSON.stringify(ranking), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${RANKING_CACHE_SECONDS}` },
      }));
    },
  };
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
export async function handleCorpusFeed(
  request: Request,
  env: FeedEnv,
  identity: Pick<VerifiedIdentity, 'uid'>,
  // Work the page does not wait for; awaited when nothing can outlive the response.
  later: (work: Promise<unknown>) => void | Promise<unknown> = work => work,
): Promise<{ papers: Paper[] }> {
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
  const papers = await readFeedPage(env, query, { cache: rankingCache(identity.uid) });
  // After the page, not before it: a lookup of liked papers can take seconds
  // (arXiv's pace), and the page is ranked by the likes the corpus has now.
  // Only a first page of categories looks them up: the follows asked beside
  // it, and later pages, would repeat the same lookup.
  await later(Promise.all([
    registerFollowedLanes(env, identity.uid, query.follows.map(follow => follow.lane)),
    query.page === 0 && query.follows.length === 0 && query.positiveIds.length ? addMissingPositives(env, identity.uid, query.positiveIds) : null,
  ]).catch(error => console.warn('Paper store follow-up failed', error)));
  return { papers };
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
  // Until the first harvest has finished every arXiv set the corpus holds its
  // oldest papers first; those bundles ask arXiv itself when this is empty.
  const harvested = await database(env).prepare("SELECT COUNT(*) AS sets FROM lane_state WHERE source = 'arxiv-oai'").first<{ sets: number }>();
  if ((harvested?.sets || 0) < ARXIV_HARVEST_SETS.length) return { papers: [] };
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
