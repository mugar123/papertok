import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { captureWorkerException, captureWorkerResponseFailure, trackErrors } from './error-tracking.ts';

type SentEvent = { event: string; distinct_id: string; properties: Record<string, unknown> };

// Runs each callback as its own invocation, all at the same time.
async function reportsFrom(env: { POSTHOG_PROJECT_TOKEN?: string }, ...runs: (() => Promise<unknown>)[]) {
  const originalFetch = globalThis.fetch;
  const bodies: Promise<ArrayBuffer>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(new Response(init?.body).arrayBuffer());
    return new Response('{}');
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  let thrown: unknown;
  try {
    await Promise.all(runs.map(run => trackErrors(env, { waitUntil: promise => pending.push(promise) }, 'http', run)
      .catch((error: unknown) => { thrown = error; })));
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const batches = await Promise.all(bodies.map(async body => JSON.parse(gunzipSync(Buffer.from(await body)).toString()) as { batch: SentEvent[] }));
  return { thrown, events: batches.flatMap(({ batch }) => batch) };
}

test('an error that escapes a request is reported without its message and still thrown', async () => {
  const error = new TypeError('Cannot summarize W2741809807 for private@example.com');
  const { thrown, events } = await reportsFrom({ POSTHOG_PROJECT_TOKEN: 'phc_test' }, async () => { throw error; });

  assert.equal(thrown, error);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, '$exception');
  assert.equal(events[0].properties.operation, 'http');
  assert.equal(events[0].properties.$process_person_profile, false);
  const [exception] = events[0].properties.$exception_list as { type: string; value: string; stacktrace: { frames: { lineno?: number }[] } }[];
  assert.equal(exception.type, 'TypeError');
  assert.equal(exception.value, 'Application error (message redacted)');
  assert.ok(exception.stacktrace.frames.length > 0 && exception.stacktrace.frames.every(frame => frame.lineno! > 0), 'code locations survive');
  assert.doesNotMatch(JSON.stringify(events), /W2741809807|private@example\.com/);
});

test('a caught failure and the 5xx answer it causes are one report, and a 4xx is none', async () => {
  const { events } = await reportsFrom({ POSTHOG_PROJECT_TOKEN: 'phc_test' }, async () => {
    captureWorkerException(Object.assign(new Error('Not allowed'), { status: 403 }));
    captureWorkerException(new Error('Provider failed'), 'rewrite');
    captureWorkerResponseFailure(502);
  });
  assert.deepEqual(events.map(event => event.properties.operation), ['rewrite']);

  const { events: unexplained } = await reportsFrom({ POSTHOG_PROJECT_TOKEN: 'phc_test' }, async () => captureWorkerResponseFailure(503));
  assert.deepEqual(unexplained.map(event => [event.properties.operation, event.properties.http_status]), [['http', 503]]);
});

test('a report in one request does not silence the 5xx of another running at the same time', async () => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const { events } = await reportsFrom({ POSTHOG_PROJECT_TOKEN: 'phc_test' }, async () => {
    await held;
    captureWorkerResponseFailure(503);
  }, async () => {
    captureWorkerException(new Error('Provider failed'), 'rewrite');
    release();
  });
  assert.deepEqual(events.map(event => event.properties.operation).sort(), ['http', 'rewrite']);
});

test('without a project token nothing is sent', async () => {
  const { thrown, events } = await reportsFrom({}, async () => { throw new Error('Provider failed'); });
  assert.ok(thrown instanceof Error);
  assert.deepEqual(events, []);
});
