import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkerEnv } from './env.ts';
import type { LaneJob } from './paper-sources.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { CORPUS_DAYS, daysFromNow, embedPending, evictExpired } from './paper-store.ts';
import { ARXIV_HARVEST_SETS, FOLLOWED_SOURCES, SourceRefused, categoryLaneJobs, followedLaneJob, harvestArxivPage, harvestLane } from './paper-sources.ts';
import { enrichPending } from './paper-enrichment.ts';

// arXiv announces at 20:00 US Eastern; by 02:30 UTC the day's records are listed.
export const PAPER_HARVEST_CRON = '30 2 * * *';
// arXiv asks harvesters to pause between requests; a 503 carries its own wait.
const PAGE_GAP = '5 seconds';
const EMBED_STEP_PAPERS = 256;
// 25 to 50 papers per OpenAlex call: a step of 500 is about 20 calls, and a
// run's ENRICH_STEPS about 3,000 units of the nightly run's 3,700 of the
// harvest's share of the day (provider-runtime.ts). A larger backlog drains
// over the next runs.
const ENRICH_STEP_PAPERS = 500;
const ENRICH_STEPS = 150;
// Followed lanes harvested a run, the longest due first: a lane is due from
// its last harvest or, never harvested, from when it was first followed, and
// the most recently written comes first among lanes due from the same time. A
// followed search costs ten units, an entity one, of the 700 a day the
// nightly refresh of followed lanes may spend (paper-sources.ts); once they
// are spent, the run's other OpenAlex followed lanes wait and keep their turn.
// A harvest that fails otherwise is the lane's turn too (`harvestFollowedLane`).
// Neither asking for a lane again nor following new ones moves a lane ahead of
// one due earlier, so lanes one account follows after another reader's lane
// was refreshed, however many, wait behind it.
const FOLLOWED_LANES_PER_RUN = 400;
// The nights a followed lane waits after its provider rejected its request
// the first, second, third and later times in a row. A lane that keeps being
// rejected, such as a search OpenAlex answers with a 400, which still spends
// its ten units, is asked less and less often: from its fourth rejection, no
// sooner than 7 nights later, then behind every lane harvested before that date.
const FAILED_TURN_NIGHTS = [1, 2, 4, 7];
// Lanes a step works through before handing the rest to the next one, well
// inside its timeout and D1's 1,000 queries per invocation (a lane is at most
// about 125): a lane that has started finishes within the step.
const LANE_STEP_BUDGET_MS = 3 * 60_000;
const LANES_PER_STEP = 5;
// A followed lane no request has written in this long (paper-feed.ts) is no
// longer harvested.
const FOLLOWED_LANE_DAYS = 14;
const PAGE_STEP = { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;
// An arXiv OAI page that fails three times is an outage, not a blip (2026-10-22:
// no answer within 90 s for an hour); the run moves on instead of waiting on it.
const OAI_STEP = { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;
// arXiv's OAI asks for a pause with a 503 and its Retry-After. A pause longer
// than this, or a fourth 503 in a row, is an outage too: the set ends there
// rather than holding the run for hours, and is harvested from the same day
// next time.
const OAI_MAX_WAIT_SECONDS = 300;
const OAI_MAX_WAITS = 3;
const LANE_STEP = { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '10 minutes' } as const;

/** Where a set's harvest starts: the last day it was harvested to the end, else the corpus window. */
export async function harvestStart(db: D1Database, set: string, now = Date.now()) {
  const row = await db.prepare("SELECT harvested_through FROM lane_state WHERE source = 'arxiv-oai' AND lane = ?").bind(set)
    .first<{ harvested_through: string }>();
  return (row?.harvested_through || daysFromNow(-CORPUS_DAYS, now)).slice(0, 10);
}

// From the start of the UTC day `nights` from now, so that day's nightly run finds the lane due.
const dueAfter = (nights: number) => `${daysFromNow(nights).slice(0, 10)}T00:00:00.000Z`;

// The statuses that reject a lane's own request, as OpenAlex answers a search
// it cannot parse with a 400. A followed lane's text and ids travel in the
// query of a path every lane shares, so any other 4xx (a 401 or 403 refusing
// our key or client, a 404 for a path gone, a 429) answers every lane alike.
const LANE_REJECTIONS = new Set([400, 414, 422]);

function rejectsLane(error: unknown) {
  return LANE_REJECTIONS.has(Number((error as UpstreamError)?.status));
}

/**
 * A followed lane's turn in the run that started at `run`. The turn is
 * recorded before the harvest starts, as a lane due again from the start of
 * the next UTC day: a lane whose step stops mid-lane past its timeout has had
 * it too, and the step's retry passes the lane over, so a lane has one turn a
 * run. A harvest clears the record. A refusal (`SourceRefused`: a spent share,
 * part or day, a pace beat, or a ledger that cannot answer) puts back what was
 * there, so the lane keeps its turn. A 5xx, a timeout, a provider's own 429 or
 * another 4xx that is not about the lane's request says nothing about the
 * lane, so it costs the turn and no more, and an outage of any length leaves
 * no wait behind it. A rejected request (`rejectsLane`) adds a wait for each
 * rejection in a row (`FAILED_TURN_NIGHTS`).
 */
async function harvestFollowedLane(env: WorkerEnv, job: LaneJob, run: number) {
  const db = env.PAPER_STORE!;
  const turns = await db.prepare('SELECT failed_turns, retry_at FROM followed_lanes WHERE lane = ?').bind(job.lane)
    .first<{ failed_turns: number; retry_at: string | null }>();
  if (!turns) return harvestLane(env, job);
  if (turns.retry_at && Date.parse(turns.retry_at) > run) return 0;
  const record = (failed: number, retryAt: string | null) => db.prepare('UPDATE followed_lanes SET failed_turns = ?, retry_at = ? WHERE lane = ?')
    .bind(failed, retryAt, job.lane).run();
  await record(turns.failed_turns, dueAfter(1));
  try {
    const stored = await harvestLane(env, job);
    await record(0, null);
    return stored;
  } catch (error) {
    if (error instanceof SourceRefused) await record(turns.failed_turns, turns.retry_at);
    else if (rejectsLane(error)) {
      const failed = turns.failed_turns + 1;
      await record(failed, dueAfter(FAILED_TURN_NIGHTS[Math.min(failed, FAILED_TURN_NIGHTS.length) - 1]));
    }
    throw error;
  }
}

/**
 * Harvests lanes in order until the step's budget is spent, and returns how
 * many it went through. A lane that fails is logged and passed over: the
 * other lanes, and every other source, stay served. A source that refuses
 * for longer than a lane may wait (a spent daily budget, a minute's ceiling
 * still full after the lane waited one out) is passed over for the rest of
 * the step. Followed lanes, harvested by the run that started at
 * `followedRun`, each take their turn (`harvestFollowedLane`).
 */
export async function harvestLanes(env: WorkerEnv, jobs: LaneJob[], followedRun?: number, budgetMs = LANE_STEP_BUDGET_MS, started = Date.now()) {
  const refused = new Set<string>();
  let processed = 0;
  for (const job of jobs) {
    if (processed >= LANES_PER_STEP || (processed > 0 && Date.now() - started > budgetMs)) break;
    processed += 1;
    if (refused.has(job.source)) continue;
    try {
      await (followedRun === undefined ? harvestLane(env, job) : harvestFollowedLane(env, job, followedRun));
    } catch (error) {
      if (error instanceof SourceRefused) refused.add(job.source);
      console.warn(`Harvest of ${job.source} ${job.lane} failed`, error);
    }
  }
  return processed;
}

async function runLaneJobs(env: WorkerEnv, step: WorkflowStep, label: string, jobs: LaneJob[], followedRun?: number) {
  let remaining = jobs;
  // Step names are the replay keys, so each round gets its own number.
  for (let round = 0; remaining.length > 0; round += 1) {
    let processed = LANES_PER_STEP;
    try {
      processed = await step.do(`${label}: lanes ${round}`, LANE_STEP, () => harvestLanes(env, remaining, followedRun));
    } catch (error) {
      // Past its retries (a lane that keeps timing out): the lanes the step
      // may have reached are passed over, and harvested again tomorrow. A
      // followed lane that timed out has had its turn, and the retries pass
      // it over rather than time out on it again.
      console.error(`Harvest of ${label} lanes ${round} failed; passing over ${LANES_PER_STEP} lanes`, error);
    }
    remaining = remaining.slice(processed);
  }
}

async function followedJobs(db: D1Database, now: number) {
  // lane_state's key starts with the source: naming the followed lanes'
  // sources lets each lane's row be read by key. A lane whose last turn
  // failed is due from when it may be asked again, behind the lanes
  // harvested before then.
  const { results } = await db.prepare(`SELECT f.lane FROM followed_lanes f
    LEFT JOIN lane_state s ON s.source IN (SELECT value FROM json_each(?)) AND s.lane = f.lane
    WHERE f.requested_at >= ? AND (f.retry_at IS NULL OR f.retry_at <= ?)
    ORDER BY COALESCE(f.retry_at, s.harvested_through, f.registered_at), f.requested_at DESC LIMIT ?`)
    .bind(JSON.stringify(FOLLOWED_SOURCES), daysFromNow(-FOLLOWED_LANE_DAYS, now), new Date(now).toISOString(), FOLLOWED_LANES_PER_RUN)
    .all<{ lane: string }>();
  return results.map(row => followedLaneJob(row.lane)).filter(Boolean) as LaneJob[];
}

async function embedAll(env: WorkerEnv, step: WorkflowStep, lanes?: string[]) {
  for (let batch = 0; ; batch += 1) {
    const embedded = await step.do(`embed ${batch}`, PAGE_STEP, () => embedPending(env, EMBED_STEP_PAPERS, { lanes }));
    if (embedded === 0) break;
  }
}

/**
 * A phase that failed past its step's retries is logged and passed over: the
 * corpus is the feed's only source, so one provider's outage must not cost the
 * others their day.
 */
async function phase(name: string, work: () => Promise<unknown>) {
  try {
    await work();
    return true;
  } catch (error) {
    console.error(`Paper harvest phase failed: ${name}`, error);
    return false;
  }
}

/**
 * The lanes no request has written in FOLLOWED_LANE_DAYS leave the harvest,
 * and the corpus forgets which papers they named and how far they got: a
 * followed search's text is gone with them.
 */
async function forgetFollowedLanes(db: D1Database, now: number) {
  const before = daysFromNow(-FOLLOWED_LANE_DAYS, now);
  const dropped = 'SELECT lane FROM followed_lanes WHERE requested_at < ?';
  await db.batch([
    db.prepare(`DELETE FROM work_lanes WHERE lane IN (${dropped})`).bind(before),
    db.prepare(`DELETE FROM lane_state WHERE lane IN (${dropped})`).bind(before),
    db.prepare('DELETE FROM followed_lanes WHERE requested_at < ?').bind(before),
  ]);
}

/**
 * One run a day, as `PaperHarvestWorkflow` (instrumentation.ts): every arXiv
 * set harvested from where it last finished, every other source's lanes, the
 * lanes readers follow, the papers past their keeping date removed, then
 * enrichment and embedding of what arrived within the day's budgets. A run for
 * newly followed lanes (`payload.lanes`) harvests those within the new
 * follows' share of OpenAlex and embeds only their papers: the rest of the
 * corpus is the daily run's to embed.
 */
export async function runPaperHarvest(env: WorkerEnv, event: Readonly<WorkflowEvent<{ lanes?: string[] } | undefined>>, step: WorkflowStep) {
  if (!env.PAPER_STORE) throw new Error('PAPER_STORE is not bound');
  const db = env.PAPER_STORE;
  const started = event.timestamp.getTime();

  const followed = event.payload?.lanes;
  if (followed?.length) {
    const jobs = followed.map(followedLaneJob).filter(Boolean) as LaneJob[];
    await runLaneJobs(env, step, 'followed', jobs.map(job => ({ ...job, newFollow: true })), started);
    await phase('embed', () => embedAll(env, step, followed));
    return;
  }

  // The day the run started, so a run that crosses midnight records the day it covered.
  const today = event.timestamp.toISOString();
  for (const set of ARXIV_HARVEST_SETS) {
    // A set that fails is harvested from the same day on the next run, and so
    // are the ones after it: arXiv is down, and each would wait out its retries.
    const harvested = await phase(`arXiv ${set}`, async () => {
      const from = await step.do(`${set}: start`, () => harvestStart(db, set));
      let resumptionToken = '';
      // Step names are the replay keys, so each request gets its own number.
      for (let request = 0, waits = 0, done = false; !done; request += 1) {
        const page = await step.do(`${set}: request ${request}`, OAI_STEP, () => harvestArxivPage(env, { set, from, resumptionToken }));
        if (page.retryAfterSeconds) {
          waits += 1;
          if (waits > OAI_MAX_WAITS || page.retryAfterSeconds > OAI_MAX_WAIT_SECONDS) {
            throw new Error(`arXiv OAI asked for ${page.retryAfterSeconds} s, 503 number ${waits} in a row`);
          }
          await step.sleep(`${set}: wait ${request}`, page.retryAfterSeconds * 1000);
          continue;
        }
        waits = 0;
        resumptionToken = page.resumptionToken;
        done = !resumptionToken;
        if (!done) await step.sleep(`${set}: gap ${request}`, PAGE_GAP);
      }
      await step.do(`${set}: finish`, async () => {
        await db.prepare(`INSERT INTO lane_state (source, lane, harvested_through) VALUES ('arxiv-oai', ?, ?)
          ON CONFLICT (source, lane) DO UPDATE SET harvested_through = excluded.harvested_through`).bind(set, today).run();
      });
    });
    if (!harvested) break;
  }
  await phase('carry arXiv vectors', () => step.do('carry arXiv vectors', carryArxivVectors(db)));

  await phase('category lanes', () => runLaneJobs(env, step, 'categories', categoryLaneJobs()));
  await phase('followed lanes', async () => runLaneJobs(env, step, 'followed', await step.do('followed lanes', () => followedJobs(db, started)), started));
  await phase('evict', () => step.do('evict', async () => {
    await evictExpired(env, started);
    await forgetFollowedLanes(db, started);
  }));

  await phase('enrich', async () => {
    for (let batch = 0; batch < ENRICH_STEPS; batch += 1) {
      const enriched = await step.do(`enrich ${batch}`, PAGE_STEP, () => enrichPending(env, ENRICH_STEP_PAPERS));
      if (enriched === 0) break;
    }
  });
  await phase('embed', () => embedAll(env, step));
}

/**
 * The arXiv-only store of 0001 embedded its papers already: their vectors move
 * to the corpus rows the same papers now have, rather than being bought again.
 * Only while a row keeps the text that was embedded: a new version drops the
 * row's vector, and the old one must not come back. A no-op once a later
 * migration drops the old tables.
 */
export function carryArxivVectors(db: D1Database) {
  return async () => {
    try {
      const result = await db.prepare(`INSERT OR IGNORE INTO work_vectors (work_id, embedding)
        SELECT k.work_id, substr(v.embedding, 1, 256) FROM paper_vectors v
        JOIN papers p ON p.arxiv_id = v.arxiv_id
        JOIN work_keys k ON k.key = 'arxiv:' || lower(v.arxiv_id)
        JOIN works w ON w.id = k.work_id
        WHERE w.paper ->> 'title' = p.title AND w.paper ->> 'abstract' = p.abstract`).run();
      return result.meta.changes;
    } catch (error) {
      if (/no such table/i.test(String((error as Error)?.message))) return 0;
      throw error;
    }
  };
}
