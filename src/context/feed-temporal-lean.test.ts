import type { InteractionEvent } from '../utils/interaction-profile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyInteractionProfile, readProfileSignals, recordInteractionEvent } from '../utils/interaction-profile.ts';
import { corpusOrder, sampleNotableEvery } from './feed-temporal-lean.ts';

const NOW = Date.parse('2026-10-24T00:00:00.000Z');

// Every notable card is years old by the feed's choice, so engaging with one
// says nothing about the age of the papers the reader wants next. A like, a
// save and a read of ten seconds or more move the lean, each by its own step.
test('liking, saving or reading notable cards keeps the next page newest first, unlike the same engagement with other old papers', () => {
  const orders: string[] = [];
  const engagements: Array<[string, Partial<InteractionEvent>, number]> = [
    ['like', { kind: 'like' }, 4], ['save', { kind: 'save' }, 3], ['read', { kind: 'viewTime', viewTime: 12 }, 7],
  ];
  for (const [engagement, event, times] of engagements) {
    for (const notable of [true, false]) {
      const profile = createEmptyInteractionProfile();
      for (let index = 0; index < times; index += 1) {
        recordInteractionEvent(profile, {
          kind: 'like', ...event, paperId: `paper-${index}`, category: 'cs.LG', notable, published: '2017-12-01T00:00:00.000Z',
        }, NOW);
      }
      orders.push(`${times} × ${engagement}, ${notable ? 'notable cards' : 'other papers from 2017'}: ${corpusOrder(readProfileSignals(profile, NOW).temporal.lean)}`);
    }
  }
  assert.deepEqual(orders, [
    '4 × like, notable cards: recent', '4 × like, other papers from 2017: relevance',
    '3 × save, notable cards: recent', '3 × save, other papers from 2017: relevance',
    '7 × read, notable cards: recent', '7 × read, other papers from 2017: relevance',
  ]);
});

// A seeded source, so the samples below are the same on every run.
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// The share of notable places on a page is one in `every`.
function sampledShares(likes: { notable: number; recent: number }, samples = 4000) {
  const profile = createEmptyInteractionProfile();
  for (let index = 0; index < likes.notable; index += 1) {
    recordInteractionEvent(profile, { paperId: `notable-${index}`, kind: 'like', category: 'cs.LG', notable: true, published: '2019-05-01T00:00:00.000Z' }, NOW);
  }
  for (let index = 0; index < likes.recent; index += 1) {
    recordInteractionEvent(profile, { paperId: `recent-${index}`, kind: 'like', category: 'cs.LG', notable: false, published: '2026-10-20T00:00:00.000Z' }, NOW);
  }
  const random = seededRandom(166);
  const { temporal } = readProfileSignals(profile, NOW);
  return Array.from({ length: samples }, () => 1 / sampleNotableEvery(temporal, random));
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

test('a page\'s share of notable places stays between one in fifteen and one in three', () => {
  for (const likes of [{ notable: 0, recent: 0 }, { notable: 400, recent: 0 }, { notable: 0, recent: 400 }, { notable: 3, recent: 5 }]) {
    const shares = sampledShares(likes);
    assert.ok(Math.min(...shares) >= 1 / 15, `no page below one in fifteen for ${JSON.stringify(likes)}`);
    assert.ok(Math.max(...shares) <= 1 / 3, `no page above one in three for ${JSON.stringify(likes)}`);
  }
});

test('likes of notable cards raise the expected share and likes of recent cards lower it to the floor, and neither kind disappears', () => {
  const none = mean(sampledShares({ notable: 0, recent: 0 }));
  const notable = sampledShares({ notable: 200, recent: 0 });
  const recent = sampledShares({ notable: 0, recent: 200 });
  // Without engagement the share is today's one in fifteen, with some exploration above it.
  assert.ok(none > 1 / 15 && none < 1 / 10, `share without engagement: ${none}`);
  assert.ok(mean(notable) > 0.3, `share after notable likes: ${mean(notable)}`);
  assert.ok(mean(recent) < none, `share after recent likes: ${mean(recent)}`);
  assert.ok(mean(recent) < 1 / 14, `share after recent likes: ${mean(recent)}`);
  // Recent cards keep at least two places in three, notable cards one in fifteen.
  assert.ok(Math.max(...notable) <= 1 / 3);
  assert.ok(Math.min(...recent) >= 1 / 15);
});

test('a lone skip or a lone dismissal of one card moves neither the share nor the lean', () => {
  const untouched = readProfileSignals(createEmptyInteractionProfile(), NOW).temporal;
  assert.deepEqual(untouched, { notable: 0, recent: 0, lean: 0 });
  for (const notable of [true, false]) {
    for (const event of [
      { kind: 'skip' }, { kind: 'notInterested' },
    ]) {
      const profile = createEmptyInteractionProfile();
      recordInteractionEvent(profile, { paperId: 'card', category: 'cs.LG', notable, published: notable ? '2018-03-01T00:00:00.000Z' : '2026-10-23T00:00:00.000Z', ...event }, NOW);
      assert.deepEqual(readProfileSignals(profile, NOW).temporal, untouched, `${event.kind} of a ${notable ? 'notable' : 'recent'} card`);
    }
  }
});
