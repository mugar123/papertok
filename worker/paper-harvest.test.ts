import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { runPaperHarvest } from './paper-harvest.ts';
import { ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';

// The Workflow's steps run in place: a step's callback is called once, a sleep
// is recorded and returns at once. `fail` names the steps that fail past their
// retries; `skipLanes` answers the category lanes' steps as if every lane were
// done, for a daily run whose lanes the test does not exercise.
function workflowStep({ fail = (_name: string) => false, skipLanes = false } = {}) {
  const steps: string[] = [];
  const sleeps: Array<number | string> = [];
  const step = {
    async do(name: string, ...rest: unknown[]) {
      steps.push(name);
      if (fail(name)) throw new Error(`${name} failed past its retries`);
      if (skipLanes && /^categories: lanes \d+$/.test(name)) return Number.MAX_SAFE_INTEGER;
      return (rest.at(-1) as () => Promise<unknown>)();
    },
    async sleep(_name: string, duration: number | string) {
      sleeps.push(duration);
    },
  };
  return { step: step as unknown as WorkflowStep, steps, sleeps };
}

const followRun = (lanes: string[]) => ({ payload: { lanes }, timestamp: new Date(), instanceId: 'follow-test' }) as unknown as WorkflowEvent<{ lanes?: string[] }>;
const dailyRun = () => ({ payload: undefined, timestamp: new Date(), instanceId: 'daily-test' }) as unknown as WorkflowEvent<undefined>;

// The providers: `answer` when it has a response for the URL, otherwise an
// empty OpenAlex list (through the Worker's relay).
function providers(t: import('node:test').TestContext, answer: (url: URL) => Response | undefined = () => undefined) {
  const asked: URL[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url);
    return answer(url) ?? Response.json({ results: [] });
  }) as typeof fetch;
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  return asked;
}

function corpus() {
  const { binding, db } = testD1();
  const texts: string[] = [];
  const env = {
    PAPER_STORE: binding,
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
    OPENALEX_API_KEY: 'test-key',
    AI: {
      run: async (_model: string, { text }: { text: string[] }) => {
        texts.push(...text);
        return { data: text.map(() => Array.from({ length: 1024 }, (_, dimension) => Math.cos(dimension))) };
      },
    },
  } as unknown as WorkerEnv;
  return { env, db, texts };
}

// Synthetic, in the shape the arXiv harvest stores.
const paper = (id: string, title: string) => arxivRecordPaper({
  arxivId: id, title, abstract: `${title}, in short.`, authors: ['Ana Pérez'], categories: [], doi: null, journalRef: null, comments: null,
  published: new Date(Date.now() - 86_400_000).toISOString(), updated: '',
});

test("a followed lanes' run embeds its own lanes' papers and leaves the rest to the daily run", async t => {
  providers(t);
  const { env, db, texts } = corpus();
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'A paper by the followed author'), lanes: ['author:A1'] },
    { paper: paper('2610.30002', 'Another paper by the followed author'), lanes: ['author:A1', 'cs.LG'] },
    { paper: paper('2610.30003', 'A machine learning paper nobody followed'), lanes: ['cs.LG'] },
    { paper: paper('2610.30004', 'A paper of an author someone else follows'), lanes: ['author:A2'] },
  ]);
  const { step } = workflowStep();
  await runPaperHarvest(env, followRun(['author:A1']), step);
  assert.deepEqual(texts.map(text => text.split('\n')[0]).sort(), ['A paper by the followed author', 'Another paper by the followed author']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_vectors').get() as { n: number }).n, 2);
});

test('a lane step that fails past its retries passes over its lanes, not the rest of the run', async t => {
  providers(t);
  const { env, db } = corpus();
  const lanes = Array.from({ length: 7 }, (_, index) => `author:A${index + 1}`);
  // The first step, five lanes, times out every time.
  const { step, steps } = workflowStep({ fail: name => name === 'followed: lanes 0' });
  await runPaperHarvest(env, followRun(lanes), step);
  const harvested = db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-follows' ORDER BY lane").all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(harvested, ['author:A6', 'author:A7']);
  assert.ok(steps.includes('embed 0'), 'the run goes on to embed');
});

test("arXiv's 503 is waited out as asked, but a long pause or one 503 after another ends the set, not the run", async t => {
  let retryAfter = '';
  providers(t, url => (url.hostname === 'oaipmh.arxiv.org'
    ? new Response('Retry later', { status: 503, headers: { 'retry-after': retryAfter } })
    : undefined));
  for (retryAfter of ['86400', '30']) {
    const { env } = corpus();
    // Ten requests of one set is a run that would never end.
    const { step, steps, sleeps } = workflowStep({ skipLanes: true, fail: name => Number(name.match(/^cs: request (\d+)$/)?.[1]) >= 10 });
    await runPaperHarvest(env, dailyRun(), step);
    const requests = steps.filter(name => /: request \d+$/.test(name));
    assert.ok(requests.length <= 4 && requests.every(name => name.startsWith('cs:')), `${retryAfter}: ${requests.join(', ')}`);
    assert.ok(sleeps.every(duration => Number(duration) <= 300_000), `${retryAfter}: slept ${sleeps.join(', ')}`);
    assert.ok(steps.includes('embed 0'), `${retryAfter}: the run goes on`);
  }
});
