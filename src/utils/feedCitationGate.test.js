import test from 'node:test';
import assert from 'node:assert/strict';
import { CITATION_GATE_MAX_WAIT_MS, awaitWithinGate } from './feedCitationGate.js';

const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });

test('the cap is a ceiling on the veil, not the enrichment budget', () => {
  // OpenAlex itself is allowed 6500ms (OPENALEX_FEED_REQUEST_TIMEOUT_MS). The
  // gate must be far under that: it decides how long the reader stares at the
  // atom, not how long the request may live.
  assert.ok(CITATION_GATE_MAX_WAIT_MS < 6500, 'a gate at the request budget is six seconds of veil');
  assert.ok(CITATION_GATE_MAX_WAIT_MS >= 600, 'too short and it never catches a normal response');
});

test('everything that lands in time comes back', async () => {
  const values = await awaitWithinGate([after(5, { a: 1 }), after(10, 'two')], { maxWaitMs: 200 });
  assert.deepEqual(values, [{ a: 1 }, 'two']);
});

test('a request that never answers does not hold the feed', async () => {
  const startedAt = Date.now();
  const values = await awaitWithinGate([never()], { maxWaitMs: 40 });
  assert.deepEqual(values, [null]);
  assert.ok(Date.now() - startedAt < 400, 'the cap fired instead of waiting on the promise');
});

test('the slow one is dropped and the fast one is kept', async () => {
  const values = await awaitWithinGate([after(5, 'fast'), never()], { maxWaitMs: 40 });
  assert.deepEqual(values, ['fast', null]);
});

test('a rejection is a miss, never a throw', async () => {
  const values = await awaitWithinGate([Promise.reject(new Error('OpenAlex down')), after(5, 'ok')], { maxWaitMs: 100 });
  assert.deepEqual(values, [null, 'ok']);
});

test('nothing to wait for resolves at once, and does not sit on the cap', async () => {
  const startedAt = Date.now();
  assert.deepEqual(await awaitWithinGate([], { maxWaitMs: 5000 }), []);
  assert.ok(Date.now() - startedAt < 300, 'an empty gate must not wait out its own timer');
});

test('a value that arrives after the cap is not written into the result', async () => {
  const values = await awaitWithinGate([after(120, 'late')], { maxWaitMs: 20 });
  assert.deepEqual(values, [null]);
  // The late value still resolves; the caller merges it through the existing
  // late `.then` in FeedContext. What must not happen is the gate mutating
  // what it already handed back.
  await after(160);
  assert.deepEqual(values, [null], 'the result the caller painted with is frozen');
});
