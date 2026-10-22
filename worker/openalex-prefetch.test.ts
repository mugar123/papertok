import type { TestCache, TestGlobals } from './test-types.ts';
import type { QuotaReading } from './request-quota-ledger.ts';
import type { WorkerEnv } from './env.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import worker from './index.ts';
import { openAlexTopicLaneUrl, openAlexWorkingPapersUrl } from '../src/utils/openAlexFeedLanes.ts';

// PAP-88: once a day, just after the budget resets at 00:00 UTC, the Worker
// fetches the first pages of the feed's topic lane and working-paper series
// into the shared OpenAlex store, so those pages are served all day without a
// reservation, also after the feed tier closes.

const PREFETCH_CRON = '5 0 * * *';
const PREFETCHED_AT = Date.parse('2026-10-22T00:05:00Z');

/** The KV namespace the relay shares answers through. */
function sharedStore() {
  const entries = new Map<string, { value: string; metadata: unknown }>();
  return {
    entries,
    getWithMetadata: async (key: string) => {
      const stored = entries.get(key);
      return stored ? { value: stored.value, metadata: stored.metadata } : { value: null, metadata: null };
    },
    put: async (key: string, value: string, options?: { metadata?: unknown }) => {
      entries.set(key, { value, metadata: options?.metadata });
    },
  } as unknown as KVNamespace & { entries: Map<string, unknown> };
}

/** One location's edge cache. */
function edgeCache(): { default: TestCache } {
  const stored = new Map<string, Response>();
  return {
    default: {
      match: async request => stored.get(new Request(request).url)?.clone(),
      put: async (request, response) => { stored.set(new Request(request).url, response.clone()); },
    },
  };
}

function ledger(answer: () => QuotaReading = () => ({ accepted: true })) {
  const calls: Array<{ periodKey: string; tally?: string }> = [];
  return {
    calls,
    binding: {
      idFromName: (name: string): unknown => name,
      get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => ({
        fetch: async (_url, init) => {
          calls.push({ periodKey: String(name), tally: JSON.parse(String(init!.body)).tally });
          return Response.json(answer());
        },
      }),
    } as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'],
  };
}

// Each test swaps the network and the edge cache several times; the real ones
// are put back once, when it ends.
function isolate(t: TestContext) {
  const globals = globalThis as TestGlobals;
  const realFetch = globalThis.fetch;
  const realCaches = globals.caches;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete globals.caches;
    else globals.caches = realCaches;
  });
}

function withNetwork(handler: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  globalThis.fetch = async input => {
    asked.push(String(input));
    return handler(String(input));
  };
  return asked;
}

// Another location: an edge cache of its own.
function inLocation() {
  (globalThis as TestGlobals).caches = edgeCache();
}

async function runPrefetch(env: Partial<WorkerEnv>) {
  const jobs: Promise<unknown>[] = [];
  await worker.scheduled({ cron: PREFETCH_CRON, scheduledTime: PREFETCHED_AT }, env as WorkerEnv, { waitUntil: job => { jobs.push(job); } });
  await Promise.all(jobs);
}

test("the nightly prefetch stores the lanes where a reader's request finds them", async t => {
  t.mock.method(console, 'info', () => {});
  isolate(t);
  // A reader's clock is not UTC; the lanes are dated by the UTC day.
  const realZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (realZone === undefined) delete process.env.TZ;
    else process.env.TZ = realZone;
  });
  t.mock.timers.enable({ apis: ['Date'], now: PREFETCHED_AT });
  const store = sharedStore();
  const quota = ledger();
  const env = { OPENALEX_API_KEY: 'worker-key', NOTIFICATION_STORE: store, REQUEST_QUOTA_LEDGER: quota.binding };

  inLocation();
  const prefetched = withNetwork(() => Response.json({ results: [{ id: 'https://openalex.org/W1' }] }));
  await runPrefetch(env);
  assert.ok(prefetched.length > 0, 'the prefetch asked OpenAlex');
  assert.equal(store.entries.size, prefetched.length, 'every page it fetched is in the shared store');
  assert.ok(quota.calls.every(call => call.tally === 'feed.list'), JSON.stringify(quota.calls));

  // Mid-afternoon in another location: no edge entry, and OpenAlex must not
  // be asked.
  t.mock.timers.setTime(Date.parse('2026-10-22T15:00:00Z'));
  inLocation();
  quota.calls.length = 0;
  const later = withNetwork(() => { throw new Error('a prefetched page asks OpenAlex nothing'); });
  const readerUrls = [
    openAlexTopicLaneUrl(['cs.LG', 'bio.mol', 'med.gen'], 1, Date.now())!,
    openAlexTopicLaneUrl(['mech.aero'], 3, Date.now())!,
    openAlexWorkingPapersUrl(2, Date.now()),
  ];
  for (const url of readerUrls) {
    const response = await worker.fetch(new Request(`https://api.papertok.test/openalex${url.pathname}${url.search}`, {
      headers: { origin: 'https://papertok.app' },
    }), env as WorkerEnv);
    assert.equal(response.status, 200, url.toString());
    assert.deepEqual(await response.json(), { results: [{ id: 'https://openalex.org/W1' }] });
  }
  assert.deepEqual(later, []);
  assert.deepEqual(quota.calls, [], 'nothing reserved');
});

test('the prefetch makes no retry, skips keys already stored and stops at the first refusal', async t => {
  t.mock.method(console, 'info', () => {});
  isolate(t);
  t.mock.timers.enable({ apis: ['Date'], now: PREFETCHED_AT });
  const env = (store: KVNamespace, quota: ReturnType<typeof ledger>) => ({
    OPENALEX_API_KEY: 'worker-key',
    NOTIFICATION_STORE: store,
    REQUEST_QUOTA_LEDGER: quota.binding,
  });

  // The feed tier refused: nothing is fetched and nothing more is asked.
  const refusing = ledger(() => ({ accepted: false, scope: 'global' }));
  inLocation();
  const refusedAsked = withNetwork(() => Response.json({ results: [] }));
  await runPrefetch(env(sharedStore(), refusing));
  assert.equal(refusing.calls.length, 1);
  assert.deepEqual(refusedAsked, []);

  // OpenAlex failing: one call, not asked again, and the run stops.
  const failing = ledger();
  inLocation();
  const failingAsked = withNetwork(() => new Response('{}', { status: 503 }));
  await runPrefetch(env(sharedStore(), failing));
  assert.equal(failingAsked.length, 1);
  assert.equal(failing.calls.length, 1);

  // A second run the same day, in another location, finds every page stored.
  const store = sharedStore();
  inLocation();
  withNetwork(() => Response.json({ results: [] }));
  await runPrefetch(env(store, ledger()));
  const again = ledger(() => ({ accepted: false, scope: 'global' }));
  inLocation();
  const againAsked = withNetwork(() => Response.json({ results: [] }));
  await runPrefetch(env(store, again));
  assert.deepEqual(againAsked, []);
  assert.deepEqual(again.calls, []);
});
