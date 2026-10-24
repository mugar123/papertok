import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusOrder, leanAfterEngaging } from './feedTemporalLean.ts';

const NOW = Date.parse('2026-10-24T00:00:00.000Z');

// Every notable card is years old by the feed's choice, so engaging with one
// says nothing about the age of the papers the reader wants next. A like, a
// save and a long read move the lean by the steps FeedContext gives them.
test('liking, saving or reading notable cards keeps the next page newest first, unlike the same engagement with other old papers', () => {
  const orders: string[] = [];
  for (const [engagement, step, times] of [['like', 0.1, 4], ['save', 0.15, 3], ['read', 0.05, 7]] as const) {
    for (const notable of [true, false]) {
      const paper = { published: '2017-12-01T00:00:00.000Z', _notable: notable };
      let lean = 0;
      for (let index = 0; index < times; index += 1) lean = leanAfterEngaging(lean, paper, step, NOW);
      orders.push(`${times} × ${engagement}, ${notable ? 'notable cards' : 'other papers from 2017'}: ${corpusOrder(lean)}`);
    }
  }
  assert.deepEqual(orders, [
    '4 × like, notable cards: recent', '4 × like, other papers from 2017: relevance',
    '3 × save, notable cards: recent', '3 × save, other papers from 2017: relevance',
    '7 × read, notable cards: recent', '7 × read, other papers from 2017: relevance',
  ]);
});
