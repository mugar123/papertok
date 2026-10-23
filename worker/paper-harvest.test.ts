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
// returns at once. `fail` names the steps that fail past their retries.
function workflowStep({ fail = (_name: string) => false } = {}) {
  const steps: string[] = [];
  const step = {
    async do(name: string, ...rest: unknown[]) {
      steps.push(name);
      if (fail(name)) throw new Error(`${name} failed past its retries`);
      return (rest.at(-1) as () => Promise<unknown>)();
    },
    async sleep() {},
  };
  return { step: step as unknown as WorkflowStep, steps };
}

const followRun = (lanes: string[]) => ({ payload: { lanes }, timestamp: new Date(), instanceId: 'follow-test' }) as unknown as WorkflowEvent<{ lanes?: string[] }>;

// OpenAlex through the Worker's relay, answering every list with `results`.
function providers(t: import('node:test').TestContext, results: (url: URL) => unknown[] = () => []) {
  const asked: URL[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url);
    return Response.json({ results: results(url) });
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
