import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkerEnv } from './env.ts';
import type { LaneJob } from './paper-sources.ts';

import { CORPUS_DAYS, daysFromNow, embedPending, evictExpired } from './paper-store.ts';
import { ARXIV_HARVEST_SETS, SOURCES, SourceRefused, backfillLane, categoryLaneJobs, followedLaneJob, harvestArxivPage, harvestLane } from './paper-sources.ts';
import { enrichPending } from './paper-enrichment.ts';
import { fileAreaPapers, storeLeafCentroids } from './leaf-filing.ts';

// arXiv announces at 20:00 US Eastern; by 02:30 UTC the day's records are listed.
export const PAPER_HARVEST_CRON = '30 2 * * *';
// arXiv asks harvesters to pause between requests; a 503 carries its own wait.
const PAGE_GAP = '5 seconds';
const EMBED_STEP_PAPERS = 256;
// 25 to 50 papers per OpenAlex call: a step of 500 is about 20 calls, and a
// run's ENRICH_STEPS about 3,000 units of the harvest's 4,000-unit share of the
// day (OPENALEX_HARVEST_DAILY_UNITS). A larger backlog drains over the next runs.
const ENRICH_STEP_PAPERS = 500;
const ENRICH_STEPS = 150;
// Followed lanes harvested a run, most recently asked first. A followed search
// costs ten calls, an entity one.
const FOLLOWED_LANES_PER_RUN = 400;
// Lanes a step works through before handing the rest to the next one, well
// inside its timeout and D1's 1,000 queries per invocation (a lane is at most
// about 125): a lane that has started finishes within the step.
const LANE_STEP_BUDGET_MS = 3 * 60_000;
const LANES_PER_STEP = 5;
// Backfill steps a lane gets a run; one that is done answers its later ones at once.
const BACKFILL_STEPS = 3;
// A followed lane nobody asked for in this long is no longer harvested.
const FOLLOWED_LANE_DAYS = 14;
const PAGE_STEP = { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;
// An arXiv OAI page that fails three times is an outage, not a blip (2026-10-22:
// no answer within 90 s for an hour); the run moves on instead of waiting on it.
const OAI_STEP = { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;
const LANE_STEP = { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '10 minutes' } as const;

/** Where a set's harvest starts: the last day it was harvested to the end, else the corpus window. */
export async function harvestStart(db: D1Database, set: string, now = Date.now()) {
  const row = await db.prepare("SELECT harvested_through FROM lane_state WHERE source = 'arxiv-oai' AND lane = ?").bind(set)
    .first<{ harvested_through: string }>();
  return (row?.harvested_through || daysFromNow(-CORPUS_DAYS, now)).slice(0, 10);
}

/**
 * Harvests lanes in order until the step's budget is spent, and returns how
 * many it went through. A lane that fails is logged and passed over: the
 * other lanes, and every other source, stay served. A source that refuses
 * for longer than a short wait (a spent daily budget) is passed over for the
 * rest of the run.
 */
export async function harvestLanes(env: WorkerEnv, jobs: LaneJob[], budgetMs = LANE_STEP_BUDGET_MS, started = Date.now()) {
  const refused = new Set<string>();
  let processed = 0;
  for (const job of jobs) {
    if (processed >= LANES_PER_STEP || (processed > 0 && Date.now() - started > budgetMs)) break;
    processed += 1;
    if (refused.has(job.source)) continue;
    try {
      await harvestLane(env, job);
    } catch (error) {
      if (error instanceof SourceRefused) refused.add(job.source);
      console.warn(`Harvest of ${job.source} ${job.lane} failed`, error);
    }
  }
  return processed;
}

async function runLaneJobs(env: WorkerEnv, step: WorkflowStep, label: string, jobs: LaneJob[]) {
  let remaining = jobs;
  // Step names are the replay keys, so each round gets its own number.
  for (let round = 0; remaining.length > 0; round += 1) {
    const processed = await step.do(`${label}: lanes ${round}`, LANE_STEP, () => harvestLanes(env, remaining));
    remaining = remaining.slice(processed);
  }
}

async function followedJobs(db: D1Database, now: number) {
  const { results } = await db.prepare('SELECT lane FROM followed_lanes WHERE requested_at >= ? ORDER BY requested_at DESC LIMIT ?')
    .bind(daysFromNow(-FOLLOWED_LANE_DAYS, now), FOLLOWED_LANES_PER_RUN).all<{ lane: string }>();
  return results.map(row => followedLaneJob(row.lane)).filter(Boolean) as LaneJob[];
}

async function embedAll(env: WorkerEnv, step: WorkflowStep, label = 'embed') {
  for (let batch = 0; ; batch += 1) {
    const embedded = await step.do(`${label} ${batch}`, PAGE_STEP, () => embedPending(env, EMBED_STEP_PAPERS));
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
 * The lanes no reader has asked for in FOLLOWED_LANE_DAYS leave the harvest,
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
 * enrichment and embedding of what arrived within the day's budgets, and last
 * the filing of the areas' journal articles under leaves, which reads the
 * vectors. A run for newly followed lanes (`payload.lanes`) harvests and
 * embeds only those.
 */
export async function runPaperHarvest(env: WorkerEnv, event: Readonly<WorkflowEvent<{ lanes?: string[] } | undefined>>, step: WorkflowStep) {
  if (!env.PAPER_STORE) throw new Error('PAPER_STORE is not bound');
  const db = env.PAPER_STORE;
  const started = event.timestamp.getTime();

  const followed = event.payload?.lanes;
  if (followed?.length) {
    await runLaneJobs(env, step, 'followed', followed.map(followedLaneJob).filter(Boolean) as LaneJob[]);
    await phase('embed', () => embedAll(env, step));
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
      for (let request = 0, done = false; !done; request += 1) {
        const page = await step.do(`${set}: request ${request}`, OAI_STEP, () => harvestArxivPage(env, { set, from, resumptionToken }));
        if (page.retryAfterSeconds) {
          await step.sleep(`${set}: wait ${request}`, page.retryAfterSeconds * 1000);
          continue;
        }
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
  // Steps of a lane's backfillPages each, within an invocation's CPU and D1 queries.
  for (const job of categoryLaneJobs().filter(job => SOURCES[job.source].backfillPages)) {
    for (let round = 0; round < BACKFILL_STEPS; round += 1) {
      const name = `backfill ${job.source} ${job.lane}${round ? ` ${round}` : ''}`;
      if (!await phase(name, () => step.do(name, LANE_STEP, () => backfillLane(env, job)))) break;
    }
  }
  await phase('followed lanes', async () => runLaneJobs(env, step, 'followed', await step.do('followed lanes', () => followedJobs(db, started))));
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
  // Apart, so a failed recomputation still files by the last run's centroids.
  await phase('leaf centroids', () => step.do('leaf centroids', () => storeLeafCentroids(env, started)));
  await phase('file area papers', () => step.do('file area papers', () => fileAreaPapers(env)));
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
