import type { Paper } from '../src/models/Paper.ts';
import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FeedRequestBody, KeptRanking, RankingCache, StoreEnv } from './paper-store.ts';

import {
  FEED_LAST_PAGE, KEEP_LIKED_DAYS, PaperStoreError, database, daysFromNow, embedWorks, findWorks, parseFeedRequest, readFeedPage,
  readPapersByIds, reserveFeedRequest,
} from './paper-store.ts';
import { ARXIV_HARVEST_SETS, followedLaneJob, ingestPaperIds } from './paper-sources.ts';
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
 * Liked papers the corpus cannot rank against yet, fetched and embedded: only
 * for a profile with fewer than ENOUGH_STORED_POSITIVES ranked likes, since a
 * reader with a few already gets a ranked page. Returns whether it stored a
 * paper or a vector, which changes the reader's ranking. Failures leave the
 * likes already stored, and count as a change: what they stored is unknown.
 */
async function addMissingPositives(env: FeedEnv, positiveIds: string[]) {
  try {
    const db = database(env);
    const workByPaperId = await findWorks(db, positiveIds);
    const workIds = [...new Set(workByPaperId.values())];
    const { results } = workIds.length
      ? await db.prepare('SELECT work_id FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(workIds)).all<{ work_id: number }>()
      : { results: [] };
    if (results.length >= ENOUGH_STORED_POSITIVES) return false;
    const absent = positiveIds.filter(id => !workByPaperId.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
    const stored = absent.length ? await ingestPaperIds(env, absent, { keepUntil: daysFromNow(KEEP_LIKED_DAYS) }) : 0;
    const found = await findWorks(db, positiveIds.slice(0, LIKED_LOOKUP_MAX_PAPERS));
    return stored + await embedWorks(env, [...new Set(found.values())]) > 0;
  } catch (error) {
    console.warn('Paper store could not add liked papers', error);
    return true;
  }
}

interface FollowedLane { lane: string; requested_at: string; harvested: number }

/**
 * The asked lanes some reader already follows, and whether each has finished
 * its first harvest: a lane's harvest records how far it got (`lane_state`)
 * once it has filed its papers.
 */
async function readFollowedLanes(env: FeedEnv, lanes: string[]): Promise<FollowedLane[]> {
  if (lanes.length === 0) return [];
  const { results } = await database(env).prepare(`SELECT f.lane, f.requested_at, s.lane IS NOT NULL AS harvested FROM json_each(?) j
    JOIN followed_lanes f ON f.lane = json_extract(j.value, '$[0]')
    LEFT JOIN lane_state s ON s.source = json_extract(j.value, '$[1]') AND s.lane = f.lane`)
    .bind(JSON.stringify(lanes.map(lane => [lane, followedLaneJob(lane)?.source ?? null])))
    .all<FollowedLane>();
  return results;
}

/**
 * Notes the followed lanes a reader asked for, so the daily harvest keeps them
 * served, and starts a harvest of the ones nobody had asked for yet: their
 * papers arrive for the reader's next page rather than tomorrow's. `followed`
 * is what readFollowedLanes found before the page read its candidates.
 * Returns whether one of the lanes, whoever asked for it first, had not
 * finished its first harvest then: its papers can have arrived since.
 */
async function registerFollowedLanes(env: FeedEnv, uid: string, lanes: string[], followed: FollowedLane[], now = Date.now()) {
  if (lanes.length === 0) return false;
  const known = new Map(followed.map(row => [row.lane, row.requested_at]));
  const waiting = followed.some(row => !row.harvested);
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
  if (written.length === 0) return waiting;
  await database(env).prepare(`INSERT INTO followed_lanes (lane, requested_at) SELECT value, ? FROM json_each(?) WHERE true
    ON CONFLICT (lane) DO UPDATE SET requested_at = excluded.requested_at`).bind(new Date(now).toISOString(), JSON.stringify(written)).run();
  if (fresh.length === 0) return waiting;
  // A lane whose harvest does not start now waits for the daily one.
  try {
    await env.PAPER_HARVEST?.create({ id: `follow-${new Date(now).toISOString().slice(0, 10)}-${crypto.randomUUID()}`, params: { lanes: fresh } });
  } catch (error) {
    console.warn('Followed lanes harvest did not start', error);
  }
  return true;
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
      return cached ? cached.json<KeptRanking>() : null;
    },
    async put(key, ranking) {
      await caches.default.put(await keyFor(key), new Response(JSON.stringify(ranking), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${RANKING_CACHE_SECONDS}` },
      }));
    },
  };
}

// How long More like this waits for the lookup of the paper just liked. The
// app gives up on the request at 3.5 s (STORE_TIMEOUT_MS), and the page is
// ranked after the wait.
const LIKES_WAIT_MS = 1_500;

/** Whether `work` settles within `ms`. It goes on either way. */
async function settlesWithin(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(resolve, ms, false); }),
    ]);
  } finally {
    clearTimeout(timer!);
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
  const lanes = query.follows.map(follow => follow.lane);
  // Read before the page reads its candidates: read after, a first harvest
  // that ended in between would look finished, though the page was ranked
  // without its papers. Beside the reservation, so it adds no round trip.
  const [, followed] = await Promise.all([reserveFeedRequest(env, identity.uid), readFollowedLanes(env, lanes)]);
  if (query.page > FEED_LAST_PAGE) return { papers: [] };
  // Only a first page of categories looks up liked papers: the follows asked
  // beside it, and later pages, would repeat the same lookup.
  const looksUp = query.page === 0 && query.follows.length === 0 && query.positiveIds.length > 0;
  // More like this ranks by the paper just liked, which the corpus may not
  // have embedded yet: ranked before the lookup, its page would be newest
  // first. That request is not the feed's first paint and says so
  // (`waitForLikes`), so it waits for the lookup, up to LIKES_WAIT_MS; a
  // lookup still running then goes on after the answer. A reader's first
  // page never waits, one like or many.
  const waitsForLikes = looksUp && body?.waitForLikes === true;
  let lookup = waitsForLikes ? addMissingPositives(env, query.positiveIds) : null;
  // Finished in time: the ranking below reads what it stored.
  if (lookup && await settlesWithin(lookup, LIKES_WAIT_MS)) lookup = null;
  const cache = rankingCache(identity.uid);
  let kept: [string, KeptRanking] | null = null;
  const papers = await readFeedPage(env, query, {
    cache: cache && {
      get: key => cache.get(key),
      // The ranks served, at once, so that a next page asked before the work
      // below ends goes on after them.
      put: async (key, ranking) => {
        kept = [key, ranking];
        await cache.put(key, { ranks: ranking.ranks.slice(0, ranking.served), served: ranking.served, final: false });
      },
    },
  });
  // Otherwise after the page, not before it: a lookup can take seconds
  // (arXiv's pace), and the page is ranked by the likes the corpus has now.
  if (looksUp && !waitsForLikes) lookup = addMissingPositives(env, query.positiveIds);
  // The whole order serves the next pages only if this work leaves the
  // ranking as it was: a followed lane that was waiting for its first harvest
  // when the page began, or a like stored or embedded, changes it.
  await later(Promise.all([
    registerFollowedLanes(env, identity.uid, lanes, followed),
    lookup ?? false,
  ]).then(async ([waiting, added]) => {
    if (kept?.[1].final && cache && !waiting && !added) await cache.put(...kept);
  }).catch(error => console.warn('Paper store follow-up failed', error)));
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
