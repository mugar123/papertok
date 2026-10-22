import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkerEnv } from './env.ts';

import { CORPUS_DAYS, embedPending, harvestArxivPage } from './paper-store.ts';

// The arXiv areas the feed asks for (ARXIV_FEED_AREAS); `physics` covers its archives.
export const ARXIV_HARVEST_SETS = ['cs', 'math', 'physics', 'stat', 'eess', 'econ', 'q-fin'];
// arXiv announces at 20:00 US Eastern; by 02:30 UTC the day's records are listed.
export const PAPER_HARVEST_CRON = '30 2 * * *';
// arXiv asks harvesters to pause between requests; a 503 carries its own wait.
const PAGE_GAP = '5 seconds';
const EMBED_STEP_PAPERS = 256;
const PAGE_STEP = { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' } as const;

/** Where a set's harvest starts: the last day it was harvested to the end, else the corpus window. */
export async function harvestStart(db: D1Database, set: string, now = Date.now()) {
  const row = await db.prepare('SELECT harvested_through FROM harvest_state WHERE set_spec = ?').bind(set).first<{ harvested_through: string }>();
  return row?.harvested_through || new Date(now - CORPUS_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One run a day, as `PaperHarvestWorkflow` (instrumentation.ts): every set
 * harvested from where it last finished, then the newest papers without a
 * vector embedded until today's budget is spent. The first run backfills
 * CORPUS_DAYS; later runs pick up the rest of the backlog.
 */
export async function runPaperHarvest(env: WorkerEnv, event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
  if (!env.PAPER_STORE) throw new Error('PAPER_STORE is not bound');
  const db = env.PAPER_STORE;
  // The day the run started, so a run that crosses midnight records the day it covered.
  const today = event.timestamp.toISOString().slice(0, 10);
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
      await db.prepare(`INSERT INTO harvest_state (set_spec, harvested_through) VALUES (?, ?)
        ON CONFLICT (set_spec) DO UPDATE SET harvested_through = excluded.harvested_through`).bind(set, today).run();
    });
  }
  for (let batch = 0; ; batch += 1) {
    const embedded = await step.do(`embed ${batch}`, PAGE_STEP, () => embedPending(env, EMBED_STEP_PAPERS));
    if (embedded === 0) break;
  }
}
