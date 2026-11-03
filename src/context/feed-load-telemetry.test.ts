import assert from 'node:assert/strict';
import test from 'node:test';
import { startFeedLoad, type FeedLoadType, type FeedLoadAttempt } from './feed-load-telemetry.ts';
import { emptyFirstPageError } from './feed-load-failure.ts';
import { sanitizeProductEventParams, ANALYTICS_CONSENT } from '../services/analytics-service.ts';

function harness(loadType: FeedLoadType = 'initial', attempt: FeedLoadAttempt = 'original') {
  let now = 100;
  let current = true;
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const load = startFeedLoad({
    loadType, attempt, firstScreen: loadType === 'initial' && attempt !== 'automatic_retry',
    now: () => now, isCurrentAccount: () => current,
    track: async (event, properties) => { events.push({ event, properties: sanitizeProductEventParams(event, properties, ANALYTICS_CONSENT.ENABLED) }); },
  });
  return { load, events, advance: (ms: number) => { now += ms; }, changeAccount: () => { current = false; } };
}

test('an initial load measures token waiting and preparation once, before analytics completes', () => {
  const { load, events, advance } = harness();
  assert.deepEqual(events, [{ event: 'feed_load_started', properties: { load_type: 'initial', attempt: 'original', first_screen: true } }]);
  advance(1200); // Token acquisition.
  load.recordWorkerVersion('bc13c637-c9af-4b4e-92a2-c4b3e9380a57');
  advance(850.4); // Transfer and ranking.
  load.finish({ result: 'success', degraded: false });
  load.finish({ result: 'superseded' });
  assert.deepEqual(events[1], { event: 'feed_load_result', properties: {
    load_type: 'initial', attempt: 'original', first_screen: true, duration_ms: 2050,
    result: 'success', degraded: false, worker_version: 'bc13c637-c9af-4b4e-92a2-c4b3e9380a57',
  } });
  assert.equal(events.length, 2);
});

test('a timeout and its automatic retry are independent attempts with the same load type', () => {
  const first = harness();
  first.advance(10_000);
  first.load.finish({ result: 'error', error: new DOMException('private text', 'TimeoutError') });
  assert.deepEqual(first.events[1].properties, {
    load_type: 'initial', attempt: 'original', first_screen: true, duration_ms: 10_000, result: 'error', reason: 'timeout',
  });
  const retry = harness('initial', 'automatic_retry');
  retry.advance(500);
  retry.load.finish({ result: 'success', degraded: true });
  assert.deepEqual(retry.events[1].properties, {
    load_type: 'initial', attempt: 'automatic_retry', first_screen: false, duration_ms: 500, result: 'success', degraded: true,
  });
});

test('refresh refusals retain the server version and safe error fields', () => {
  const { load, events, advance } = harness('refresh');
  load.recordWorkerVersion('bc13c637-c9af-4b4e-92a2-c4b3e9380a57');
  advance(200);
  load.finish({ result: 'error', error: Object.assign(new Error('private details'), { status: 429, code: 'RATE_LIMITED' }) });
  assert.deepEqual(events[1].properties, {
    load_type: 'refresh', attempt: 'original', first_screen: false, duration_ms: 200, result: 'error',
    worker_version: 'bc13c637-c9af-4b4e-92a2-c4b3e9380a57', reason: 'rate_limited', status: 429, error_code: 'RATE_LIMITED',
  });
});

test('empty, continued and superseded attempts are distinct from errors and success', () => {
  const empty = harness();
  empty.load.finish({ result: 'error', error: emptyFirstPageError() });
  assert.equal(empty.events[1].properties.result, 'empty');
  assert.equal(empty.events[1].properties.reason, 'empty');
  for (const result of ['empty', 'continued', 'superseded'] as const) {
    const { load, events } = harness('load_more', 'continuation');
    load.finish({ result });
    assert.deepEqual(events[1].properties, {
      load_type: 'load_more', attempt: 'continuation', first_screen: false, duration_ms: 0, result,
    });
  }
});

test('a result belonging to a previous account is discarded, even if it later fails', () => {
  const { load, events, changeAccount } = harness();
  changeAccount();
  load.finish({ result: 'error', error: new Error('late answer') });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'feed_load_started');
});

test('an unavailable analytics transport does not reject a load or its result', async () => {
  const load = startFeedLoad({ loadType: 'initial', attempt: 'original', firstScreen: true, isCurrentAccount: () => true,
    track: async () => { throw new Error('analytics blocked'); },
  });
  assert.doesNotThrow(() => load.finish({ result: 'success' }));
  await new Promise(resolve => setTimeout(resolve, 0));
});
