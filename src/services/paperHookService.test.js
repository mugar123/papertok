import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canHaveHook,
  peekPaperHook,
  prefetchPaperHooks,
  resetPaperHookCache,
} from './paperHookService.js';

const ENDPOINT = 'https://worker.example/ai/hooks';
const ABSTRACT = 'A'.repeat(260);

function paper(id, overrides = {}) {
  return { id, title: `Paper ${id}`, abstract: ABSTRACT, ...overrides };
}

function answering(hooks, log = []) {
  return async (url, options) => {
    log.push(JSON.parse(options.body).papers.map(item => item.id));
    return new Response(JSON.stringify({ hooks }), { status: 200 });
  };
}

test('only papers with a title and a real abstract can have a line', () => {
  assert.equal(canHaveHook(paper('a')), true);
  assert.equal(canHaveHook(paper('b', { abstract: 'short' })), false);
  assert.equal(canHaveHook(paper('c', { title: '' })), false);
  assert.equal(canHaveHook(paper('', { doi: '', arxivId: '' })), false);
});

test('a card reads nothing until the answer is in, then the answer, and no one asks twice', async () => {
  resetPaperHookCache();
  const log = [];
  const fetchImpl = answering({ a: 'It matters because.' }, log);
  assert.equal(peekPaperHook(paper('a')), null);

  await prefetchPaperHooks([paper('a'), paper('b'), paper('a')], { endpoint: ENDPOINT, fetchImpl });
  assert.equal(peekPaperHook(paper('a')), 'It matters because.');
  // Declined by the Worker: known to have none, so not asked about again.
  assert.equal(peekPaperHook(paper('b')), '');
  assert.deepEqual(log, [['a', 'b']]);

  await prefetchPaperHooks([paper('a'), paper('b')], { endpoint: ENDPOINT, fetchImpl });
  assert.equal(log.length, 1);
});

test('papers go in batches of six', async () => {
  resetPaperHookCache();
  const log = [];
  const papers = Array.from({ length: 8 }, (_, index) => paper(`p${index}`));
  await prefetchPaperHooks(papers, { endpoint: ENDPOINT, fetchImpl: answering({}, log) });
  assert.deepEqual(log.map(batch => batch.length), [6, 2]);
});

test('a failed request is forgotten, so a later prefetch asks again', async () => {
  resetPaperHookCache();
  await prefetchPaperHooks([paper('a')], {
    endpoint: ENDPOINT,
    fetchImpl: async () => { throw new TypeError('offline'); },
  });
  assert.equal(peekPaperHook(paper('a')), null);
  await prefetchPaperHooks([paper('a')], { endpoint: ENDPOINT, fetchImpl: answering({ a: 'Back.' }) });
  assert.equal(peekPaperHook(paper('a')), 'Back.');

  resetPaperHookCache();
  await prefetchPaperHooks([paper('a')], {
    endpoint: ENDPOINT,
    fetchImpl: async () => new Response('{}', { status: 502 }),
  });
  assert.equal(peekPaperHook(paper('a')), null);
});

test('with no Worker configured nothing is asked', async () => {
  resetPaperHookCache();
  let called = false;
  await prefetchPaperHooks([paper('a')], { fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
});

test('subscribers hear about every batch that lands', async () => {
  resetPaperHookCache();
  const { subscribePaperHooks } = await import('./paperHookService.js');
  let heard = 0;
  const unsubscribe = subscribePaperHooks(() => { heard += 1; });
  await prefetchPaperHooks([paper('a')], { endpoint: ENDPOINT, fetchImpl: answering({ a: 'Yes.' }) });
  unsubscribe();
  await prefetchPaperHooks([paper('b')], { endpoint: ENDPOINT, fetchImpl: answering({ b: 'Also.' }) });
  assert.equal(heard, 1);
});

test('asking for a paper already in flight waits for that answer instead of returning at once', async () => {
  resetPaperHookCache();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ hooks: { a: 'Late but here.' } }), { status: 200 });
  };
  const first = prefetchPaperHooks([paper('a'), paper('b')], { endpoint: ENDPOINT, fetchImpl });
  let secondDone = false;
  const second = prefetchPaperHooks([paper('a')], { endpoint: ENDPOINT, fetchImpl }).then(() => { secondDone = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(secondDone, false, 'still waiting on the batch that carries it');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1, 'no second request for the same paper');
  assert.equal(peekPaperHook(paper('a')), 'Late but here.');
});
