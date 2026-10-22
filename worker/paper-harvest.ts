import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkerEnv } from './env.ts';
import type { LaneJob } from './paper-sources.ts';

import { CORPUS_DAYS, daysFromNow, embedPending, evictExpired } from './paper-store.ts';
import { ARXIV_HARVEST_SETS, SourceRefused, categoryLaneJobs, followedLaneJob, harvestArxivPage, harvestLane } from './paper-sources.ts';
import { enrichPending } from './paper-enrichment.ts';

// arXiv announces at 20:00 US Eastern; by 02:30 UTC the day's records are listed.
export const PAPER_HARVEST_CRON = '30 2 * * *';
// arXiv asks harvesters to pause between requests; a 503 carries its own wait.
const PAGE_GAP = '5 seconds';
const EMBED_STEP_PAPERS = 256;
// 25 to 50 papers per OpenAlex call: a step of 500 is about 20 calls, and a
// run's ENRICH_STEPS about 3,000 of the day's 8,000-call ledger, the rest left
// to readers' searches. A larger backlog drains over the next runs.
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
// A followed lane nobody asked for in this long is no longer harvested.
const FOLLOWED_LANE_DAYS = 14;
const PAGE_STEP = { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;
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
 * One run a day, as `PaperHarvestWorkflow` (instrumentation.ts): every arXiv
 * set harvested from where it last finished, every other source's lanes, the
 * lanes readers follow, then enrichment and embedding of what arrived within
 * the day's budgets, and the papers past the corpus window removed. A run for
 * newly followed lanes (`payload.lanes`) harvests and embeds only those.
 */
export async function runPaperHarvest(env: WorkerEnv, event: Readonly<WorkflowEvent<{ lanes?: string[] } | undefined>>, step: WorkflowStep) {
  if (!env.PAPER_STORE) throw new Error('PAPER_STORE is not bound');
  const db = env.PAPER_STORE;
  const started = event.timestamp.getTime();

  const followed = event.payload?.lanes;
  if (followed?.length) {
    await runLaneJobs(env, step, 'followed', followed.map(followedLaneJob).filter(Boolean) as LaneJob[]);
    await embedAll(env, step);
    return;
  }

  // The day the run started, so a run that crosses midnight records the day it covered.
  const today = event.timestamp.toISOString();
  for (const set of ARXIV_HARVEST_SETS) {
    const from = await step.do(`${set}: start`, () => harvestStart(db, set));
    let resumptionToken = '';
    // Step names are the replay keys, so each request gets its own number.
    for (let request = 0, done = false; !done; request += 1) {
      const page = await step.do(`${set}: request ${request}`, PAGE_STEP, () => harvestArxivPage(env, { set, from, resumptionToken }));
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
  }
  await step.do('carry arXiv vectors', carryArxivVectors(db));

  await runLaneJobs(env, step, 'categories', categoryLaneJobs());
  await runLaneJobs(env, step, 'followed', await step.do('followed lanes', () => followedJobs(db, started)));

  for (let batch = 0; batch < ENRICH_STEPS; batch += 1) {
    const enriched = await step.do(`enrich ${batch}`, PAGE_STEP, () => enrichPending(env, ENRICH_STEP_PAPERS));
    if (enriched === 0) break;
  }
  await embedAll(env, step);
  await step.do('evict', async () => {
    await evictExpired(env, started);
    await db.prepare('DELETE FROM followed_lanes WHERE requested_at < ?').bind(daysFromNow(-FOLLOWED_LANE_DAYS, started)).run();
  });
}

/**
 * The arXiv-only store of 0001 embedded its papers already: their vectors move
 * to the corpus rows the same papers now have, rather than being bought again.
 * A no-op once migration 0003 has dropped the old tables.
 */
function carryArxivVectors(db: D1Database) {
  return async () => {
    try {
      const result = await db.prepare(`INSERT OR IGNORE INTO work_vectors (work_id, embedding)
        SELECT k.work_id, v.embedding FROM paper_vectors v JOIN work_keys k ON k.key = 'arxiv:' || lower(v.arxiv_id)`).run();
      return result.meta.changes;
    } catch (error) {
      if (/no such table/i.test(String((error as Error)?.message))) return 0;
      throw error;
    }
  };
}
