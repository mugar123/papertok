import test from 'node:test';
import assert from 'node:assert/strict';
import { createArxivRequestQueue, DEFAULT_COOLDOWN_MS } from './arxivRequestQueue.js';

// A clock the tests move by hand, and a sleep that moves it instead of waiting.
function fakeClock(start = 0) {
  const clock = { value: start };
  clock.now = () => clock.value;
  clock.sleep = async ms => { clock.value += ms; };
  return clock;
}

test('runs tasks one after another with the gap between them', async () => {
  const clock = fakeClock(1_000);
  const queue = createArxivRequestQueue({ gapMs: 350, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  const startedAt = [];
  const task = (label) => async () => { startedAt.push([label, clock.value]); clock.value += 100; return label; };

  const results = await Promise.all([queue.run('a', task('a')), queue.run('b', task('b'))]);

  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(startedAt, [['a', 1_000], ['b', 1_450]]);
});

test('shares one run between identical requests in flight', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ now: clock.now, sleep: clock.sleep, maxQueueWaitMs: 6_000 });
  let runs = 0;
  const task = async () => { runs += 1; return 'same'; };

  const results = await Promise.all([queue.run('k', task), queue.run('k', task)]);

  assert.deepEqual(results, ['same', 'same']);
  assert.equal(runs, 1);
});

// A request that waited in the queue longer than anyone waits for the route
// has no listener left; sending it anyway spends an app-wide seat on the
// beat for an answer that is thrown away.
test('drops a request that has waited longer than the queue allows, without running it', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  let lateRan = false;
  const slow = queue.run('slow', async () => { clock.value += 7_000; return 'slow'; });
  const late = queue.run('late', async () => { lateRan = true; return 'late'; });

  assert.equal(await slow, 'slow');
  await assert.rejects(late, error => error.code === 'QUEUE_EXPIRED');
  assert.equal(lateRan, false);
});

test('after a 429 it refuses at once for the retry-after it was given, then resumes', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  const refused = Object.assign(new Error('PaperTok arXiv API error: 429'), { status: 429, retryAfterMs: 4_000 });

  await assert.rejects(queue.run('a', async () => { throw refused; }), error => error.status === 429);
  let ran = false;
  await assert.rejects(queue.run('b', async () => { ran = true; }), error => error.code === 'RATE_LIMITED');
  assert.equal(ran, false);

  clock.value += 4_000;
  assert.equal(await queue.run('c', async () => 'c'), 'c');
});

test('a 429 without retry-after cools down for the default', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  await assert.rejects(queue.run('a', async () => { throw Object.assign(new Error('429'), { status: 429 }); }));
  clock.value += DEFAULT_COOLDOWN_MS - 1;
  await assert.rejects(queue.run('b', async () => 'b'), error => error.code === 'RATE_LIMITED');
  clock.value += 1;
  assert.equal(await queue.run('c', async () => 'c'), 'c');
});
