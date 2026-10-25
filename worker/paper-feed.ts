import type { Paper } from '../src/models/paper.ts';
import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FeedRequestBody, KeptRanking, RankingCache, StoreEnv } from './paper-store.ts';
import type { QuotaRequest } from './request-quota-ledger.ts';

import {
  FEED_LAST_PAGE, KEEP_LIKED_DAYS, PaperStoreError, RANKING_KEPT_MS, database, daysFromNow, embedWorks, findWorks, parseFeedRequest, readFeedPage,
  readPapersByIds, reserveFeedRequest,
} from './paper-store.ts';
import { followedLaneJob, ingestPaperIds } from './paper-sources.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_UPSTREAM_TIMEOUT_MS } from './arxiv-api.ts';
import { readBoundedJson } from './bounded-body.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

// The routes that read the paper corpus (paper-store.ts) for a reader.

type FeedEnv = StoreEnv & WorkerEnv;

const ENOUGH_STORED_POSITIVES = 3;
const LIKED_LOOKUP_MAX_PAPERS = 10;
// The lookup of liked papers goes on after the page has answered (More like
// this waits LIKES_WAIT_MS for it at most), so it waits as long as the arXiv
// route itself may: a seat on arXiv's beat, then arXiv, plus
// a second for the route's cache read and the beat's ledger round trips. With
// the 2 s an inline lookup has, an answer arXiv sends later spends an app-wide
// seat and files nothing.
const LIKED_LOOKUP_DEADLINE_MS = ARXIV_PACE_MAX_WAIT_MS + ARXIV_UPSTREAM_TIMEOUT_MS + 1_000;
// A known followed lane is written again only when it is asked for more than
// 7 days after its last write; every write counts in the reader's and the app's
// lanes for the day (below). Were it written again whenever asked a day after
// its last write, 4,000 lanes asked for each morning would spend the app's day
// every day, and a lane asked for after them would never be written again
// before the first nightly run more than 14 days after its last write drops
// it (paper-harvest.ts). Written once a week, lanes asked for daily spend the
// app's day only on the days they fall due, and a lane refused on its day can
// still be written by an ask in the 7 days before the drop.
const FOLLOW_REFRESH_MS = 7 * 86_400_000;
// New followed lanes a reader's runs may harvest at once a day, and the whole
// app's. Runs spend the new follows' shares of OpenAlex and Workers AI
// (paper-sources.ts, paper-store.ts), but an author known by name is searched
// on the arXiv beat the app's readers share, and a project asks OpenAIRE,
// without a share: counted by lane, since one request can bring 20, this is
// what bounds them in a day. Past it a new follow is still registered, and the
// nightly run harvests it.
const NEW_LANES_HARVESTED_PER_READER = 20;
const NEW_LANES_HARVESTED_PER_DAY = 2_000;
// Followed lanes a reader may write a day, new or asked for again, and the
// whole app's. Every live lane due before another reader's waits ahead of it
// in the nightly refresh (paper-harvest.ts), and a lane stays live for 14 days
// after it was last written, so this bounds the lanes one account keeps live,
// and the wait they add, to about 14 days' worth. A request reads at most 20
// follows and a lane asked for again is written once in FOLLOW_REFRESH_MS at
// most, so the follows a reader asks for again take at most 20 of their 40 on
// any day, and none on most days, leaving 20 for new ones. Past it a new
// follow is not added: of the lanes nobody follows, only an OpenAlex topic's
// holds papers (paper-store.ts `recordLanes`), so any other new follow has an
// empty lane until a later request writes it. A lane asked for again keeps its
// last write.
const LANES_WRITTEN_PER_READER = 40;
const LANES_WRITTEN_PER_DAY = 4_000;

/**
 * Liked papers the corpus cannot rank against yet, fetched and embedded: only
 * for a profile with fewer than ENOUGH_STORED_POSITIVES ranked likes, since a
 * reader with a few already gets a ranked page. Embedded within the reader's
 * own share of the day and the readers' combined share (`embedWorks`). Returns
 * whether it stored a paper or a vector, which changes the reader's ranking.
 * Failures leave the likes already stored, and count as a change: what they
 * stored is unknown.
 */
async function addMissingPositives(env: FeedEnv, uid: string, positiveIds: string[]) {
  try {
    const db = database(env);
    const workByPaperId = await findWorks(db, positiveIds);
    const workIds = [...new Set(workByPaperId.values())];
    const { results } = workIds.length
      ? await db.prepare('SELECT work_id FROM work_vectors WHERE work_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(workIds)).all<{ work_id: number }>()
      : { results: [] };
    if (results.length >= ENOUGH_STORED_POSITIVES) return false;
    const absent = positiveIds.filter(id => !workByPaperId.has(id)).slice(0, LIKED_LOOKUP_MAX_PAPERS);
    const stored = absent.length ? await ingestPaperIds(env, absent, { keepUntil: daysFromNow(KEEP_LIKED_DAYS), deadlineMs: LIKED_LOOKUP_DEADLINE_MS }) : 0;
    const found = await findWorks(db, positiveIds.slice(0, LIKED_LOOKUP_MAX_PAPERS));
    return stored + await embedWorks(env, [...new Set(found.values())], uid) > 0;
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
 * Reserves a unit a lane for as many of `lanes`, in order, as the allowance
 * has left. All of them in one reservation, or, when that is refused, the
 * number the refusal says is left, in a second one. The app sends every follow
 * with each page, so lanes refused together would come back with every request
 * that day and keep the reader's last units from being used.
 */
async function reserveLanes(env: FeedEnv, allowance: Omit<QuotaRequest, 'amount'>, lanes: string[]) {
  const ledger = env.REQUEST_QUOTA_LEDGER ?? null;
  const whole = await reserveRequestQuota(ledger, { ...allowance, amount: lanes.length });
  if (whole.accepted) return lanes;
  if (whole.subjectUsage === undefined || whole.globalUsage === undefined) return [];
  const left = Math.min(allowance.subjectLimit - whole.subjectUsage, allowance.globalLimit - whole.globalUsage);
  if (left <= 0) return [];
  return (await reserveRequestQuota(ledger, { ...allowance, amount: left })).accepted ? lanes.slice(0, left) : [];
}

/**
 * Notes the followed lanes a reader asked for, so the daily harvest keeps them
 * served, and starts a harvest of the ones nobody had asked for yet: their
 * papers arrive for the reader's next page rather than tomorrow's. Both stay
 * within the reader's lanes for the day. Returns whether one of them, whoever
 * asked for it first, has not finished its first harvest yet, or finished it
 * after the page read its candidates (`harvestedBefore` holds the lanes that
 * had finished then): its papers can still arrive, or arrived after the page
 * was ranked.
 *
 * It reads the lanes itself, after the page, rather than take the read the
 * request made before it: a reader's next page can arrive before the previous
 * page has registered a new lane, and that early read would register it
 * again, with a second unit of the allowance and a second harvest.
 */
async function registerFollowedLanes(env: FeedEnv, uid: string, lanes: string[], harvestedBefore: Set<string>, now = Date.now()) {
  if (lanes.length === 0 || !env.PAPER_STORE) return false;
  const db = env.PAPER_STORE;
  const followed = await readFollowedLanes(env, lanes);
  const known = new Map(followed.map(row => [row.lane, row.requested_at]));
  const waiting = followed.some(row => !row.harvested || !harvestedBefore.has(row.lane));
  const unwritten = lanes.filter(lane => !known.has(lane) || Date.parse(known.get(lane)!) < now - FOLLOW_REFRESH_MS);
  if (unwritten.length === 0) return waiting;
  const day = new Date(now).toISOString().slice(0, 10);
  const written = await reserveLanes(env, {
    periodKey: `followed-lanes:day:${day}`,
    subject: `uid:${uid}`,
    subjectLimit: LANES_WRITTEN_PER_READER,
    globalLimit: LANES_WRITTEN_PER_DAY,
  }, unwritten);
  if (written.length === 0) return waiting;
  const at = new Date(now).toISOString();
  await db.prepare(`INSERT INTO followed_lanes (lane, requested_at, registered_at) SELECT value, ?, ? FROM json_each(?) WHERE true
    ON CONFLICT (lane) DO UPDATE SET requested_at = excluded.requested_at`).bind(at, at, JSON.stringify(written)).run();
  const fresh = written.filter(lane => !known.has(lane));
  if (fresh.length === 0) return waiting;
  // A lane whose harvest does not start now waits for the daily one.
  const harvested = env.PAPER_HARVEST ? await reserveLanes(env, {
    periodKey: `follow-run-lanes:day:${day}`,
    subject: `uid:${uid}`,
    subjectLimit: NEW_LANES_HARVESTED_PER_READER,
    globalLimit: NEW_LANES_HARVESTED_PER_DAY,
  }, fresh) : [];
  if (harvested.length) {
    try {
      await env.PAPER_HARVEST?.create({ id: `follow-${day}-${crypto.randomUUID()}`, params: { lanes: harvested } });
    } catch (error) {
      console.warn('Followed lanes harvest did not start', error);
    }
  }
  return true;
}

/**
 * The reader's ranking in this location's cache, under a key built from the
 * verified uid and the request: one reader's order is never another's. Each
 * write keeps it for RANKING_KEPT_MS.
 *
 * The path names the entry's shape. Workers before KeptRanking keep a plain
 * list under `store-ranking/` and slice whatever they find there, so a
 * rollback reading this shape would throw; under its own path, neither
 * version reads the other's entries, and the next page is ranked again.
 * `store-ranking-v4/` holds the shape before `walked` and `rankedBy`.
 */
function rankingCache(uid: string): RankingCache | undefined {
  if (typeof caches === 'undefined') return undefined;
  const keyFor = async (key: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${uid}\n${key}`));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return new Request(`https://papertok.internal/cache/store-ranking-v5/${hex}`);
  };
  return {
    async get(key) {
      const cached = await caches.default.match(await keyFor(key));
      return cached ? cached.json<KeptRanking>() : null;
    },
    async put(key, ranking) {
      await caches.default.put(await keyFor(key), new Response(JSON.stringify(ranking), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${RANKING_KEPT_MS / 1_000}` },
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
// The app keeps a page's request under 16,000 bytes and sends the 20 follows
// the page reads. Bundles before that send every follow as stored, with no
// `seen` filter: this holds about 160 followed authors or 101 followed
// searches (worker/README.md), and past it a 413 leaves their feed without
// the follows' papers.
const MAX_BODY_BYTES = 20_480;

function readBody<T>(request: Request) {
  return readBoundedJson<T>(request, MAX_BODY_BYTES, {
    tooLarge: () => new PaperStoreError('PAYLOAD_TOO_LARGE', 413),
    invalid: () => new PaperStoreError('INVALID_JSON', 400),
  });
}

/**
 * `POST /store/papers`: a page of corpus papers for the reader's categories,
 * follows and likes, or with `ids`, the corpus's copies of those papers. A
 * page asked with `seen` and `skipsSeen` says `skipsSeen`: it passed over the
 * papers the filter holds, so the app has no later page to try for unseen
 * ones.
 */
export async function handleCorpusFeed(
  request: Request,
  env: FeedEnv,
  identity: Pick<VerifiedIdentity, 'uid'>,
  // Work the page does not wait for; awaited when nothing can outlive the response.
  later: (work: Promise<unknown>) => void | Promise<unknown> = work => work,
): Promise<{ papers: Paper[]; skipsSeen?: true }> {
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
  // Two follows can name one lane, such as two authors known by the same name.
  const lanes = [...new Set(query.follows.map(follow => follow.lane))];
  // The followed lanes that had finished their first harvest before the page
  // read its candidates. Read after the page only, a harvest that ended while
  // it ranked would look finished, though the page was ranked without its
  // papers. Read beside the reservation, so it adds no round trip.
  const [, followed] = await Promise.all([reserveFeedRequest(env, identity.uid), readFollowedLanes(env, lanes)]);
  const harvestedBefore = new Set(followed.filter(row => row.harvested).map(row => row.lane));
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
  let lookup = waitsForLikes ? addMissingPositives(env, identity.uid, query.positiveIds) : null;
  // Finished in time: the ranking below reads what it stored.
  if (lookup && await settlesWithin(lookup, LIKES_WAIT_MS)) lookup = null;
  const cache = rankingCache(identity.uid);
  let kept: [string, KeptRanking] | null = null;
  const papers = await readFeedPage(env, query, {
    cache: cache && {
      get: key => cache.get(key),
      // The ranks served and walked past, and the notable papers walked past,
      // at once, so that a next page asked before the work below ends goes on
      // after them.
      put: async (key, ranking) => {
        kept = [key, ranking];
        await cache.put(key, {
          ...ranking,
          ranks: ranking.ranks.slice(0, Math.max(ranking.served, ranking.walked)),
          notable: ranking.notable.slice(0, ranking.notableWalked),
          final: false,
        });
      },
      update: (key, ranking) => cache.put(key, ranking),
    },
  });
  // Otherwise after the page, not before it: a lookup can take seconds
  // (arXiv's pace), and the page is ranked by the likes the corpus has now.
  if (looksUp && !waitsForLikes) lookup = addMissingPositives(env, identity.uid, query.positiveIds);
  // The whole order serves the next pages only if this work leaves the
  // ranking as it was: a followed lane waiting for its first harvest, or
  // finishing it after the page read its candidates, or a like stored or
  // embedded, changes it.
  await later(Promise.all([
    registerFollowedLanes(env, identity.uid, lanes, harvestedBefore),
    lookup ?? false,
  ]).then(async ([waiting, added]) => {
    if (kept?.[1].final && cache && !waiting && !added) await cache.put(...kept);
  }).catch(error => console.warn('Paper store follow-up failed', error)));
  return { papers, ...(query.skipsSeen ? { skipsSeen: true as const } : {}) };
}
