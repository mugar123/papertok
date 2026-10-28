import type { InteractionEvent, InteractionProfile } from '../utils/interaction-profile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyInteractionProfile, leanAfterEvent, readProfileSignals, recordInteractionEvent } from '../utils/interaction-profile.ts';
import { corpusOrder, forYouCardNotable, sampleNotableEvery } from './feed-temporal-lean.ts';

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

// A guest's lean lives in the feed for the session (ENG-166, decision 8).
test('a guest\'s likes, saves and long reads of other old papers move their lean as an account\'s do, and notable cards leave it', () => {
  let lean = 0;
  for (const event of [{ kind: 'like' }, { kind: 'save' }, { kind: 'viewTime', viewTime: 12 }, { kind: 'viewTime', viewTime: 4 }, { kind: 'skip' }]) {
    lean = leanAfterEvent(lean, { paperId: 'old', ...event, published: '2017-12-01T00:00:00.000Z' }, NOW);
  }
  assert.equal(Math.round(lean * 100) / 100, -0.3);
  assert.equal(leanAfterEvent(0, { paperId: 'notable', kind: 'like', notable: true, published: '2017-12-01T00:00:00.000Z' }, NOW), 0);
  assert.equal(corpusOrder(leanAfterEvent(lean, { paperId: 'old-2', kind: 'like', published: '2016-01-01T00:00:00.000Z' }, NOW)), 'relevance');
});

test('a card counts as notable or recent only while it is a For You card, and a dismissed notable card stays notable', () => {
  const forYou = [{ id: 'regular', _notable: false }, { id: 'notable', _notable: true }, { id: 'plain' }];
  assert.equal(forYouCardNotable(forYou, { id: 'notable' }, 'feed'), true);
  assert.equal(forYouCardNotable(forYou, { id: 'regular' }, 'feed'), false);
  assert.equal(forYouCardNotable(forYou, { id: 'plain' }, 'feed'), false);
  // A notable card the reader dismissed has left the list.
  assert.equal(forYouCardNotable(forYou, { id: 'dismissed', _notable: true }, 'feed'), true);
  // The same papers on a Following card, a library row, a search result or a
  // card's Connections, or with no surface at all.
  for (const surface of ['following', 'lists', 'search', 'connections', 'similar', undefined]) {
    assert.deepEqual(['notable', 'regular', 'elsewhere'].map(id => forYouCardNotable(forYou, { id }, surface)), [undefined, undefined, undefined], String(surface));
  }
});

// The verifier's case on PR #419: For You holds an old notable paper the
// reader has not reached, and they read and like a copy of it from Search.
test('reading and liking from Search a paper For You holds as notable counts no notable card and moves the lean as any old paper does', () => {
  const forYou = [{ id: 'recent-card', _notable: false }, { id: 'old-classic', _notable: true }];
  const readAndLike = (surface: string) => {
    const profile = createEmptyInteractionProfile();
    for (const event of [{ kind: 'viewTime', viewTime: 12 }, { kind: 'like' }]) {
      recordInteractionEvent(profile, {
        paperId: 'old-classic', ...event, category: 'cs.LG', published: '2012-05-01T00:00:00.000Z',
        notable: forYouCardNotable(forYou, { id: 'old-classic' }, surface),
      }, NOW);
    }
    const { notable, recent, lean } = readProfileSignals(profile, NOW).temporal;
    return { notable, recent, lean: Math.round(lean * 100) / 100 };
  };
  assert.deepEqual(readAndLike('search'), { notable: { shown: 0, engaged: 0 }, recent: { shown: 0, engaged: 0 }, lean: -0.15 });
  assert.deepEqual(readAndLike('feed'), { notable: { shown: 1, engaged: 1 }, recent: { shown: 0, engaged: 0 }, lean: 0 });
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

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// The account's For You cards as the feed records them: each card a view, and
// `engaged` of each kind's cards liked too.
type Cards = { shown: number; engaged: number };
function recordCards(profile: InteractionProfile, notable: boolean, { shown, engaged }: Cards, prefix: string) {
  for (let index = 0; index < shown; index += 1) {
    const paperId = `${prefix}-${notable ? 'notable' : 'recent'}-${index}`;
    const published = notable ? '2019-05-01T00:00:00.000Z' : '2026-10-10T00:00:00.000Z';
    recordInteractionEvent(profile, { paperId, kind: 'viewTime', viewTime: 4, category: 'cs.LG', notable, published }, NOW);
    if (index < engaged) recordInteractionEvent(profile, { paperId, kind: 'like', category: 'cs.LG', notable, published }, NOW);
  }
}

function profileWith(notable: Cards, recent: Cards) {
  const profile = createEmptyInteractionProfile();
  recordCards(profile, true, notable, 'p');
  recordCards(profile, false, recent, 'p');
  return profile;
}

// The share of notable places on a page is one in `every`.
function sampledShares(profile: InteractionProfile, samples = 4000, seed = 166) {
  const random = seededRandom(seed);
  const { temporal } = readProfileSignals(profile, NOW);
  return Array.from({ length: samples }, () => 1 / sampleNotableEvery(temporal, random));
}

test('a page\'s share of notable places stays between one in fifteen and one in three', () => {
  for (const [notable, recent] of [
    [{ shown: 0, engaged: 0 }, { shown: 0, engaged: 0 }],
    [{ shown: 300, engaged: 300 }, { shown: 300, engaged: 0 }],
    [{ shown: 300, engaged: 0 }, { shown: 300, engaged: 300 }],
    [{ shown: 3, engaged: 3 }, { shown: 50, engaged: 5 }],
  ]) {
    const shares = sampledShares(profileWith(notable, recent));
    assert.ok(Math.min(...shares) >= 1 / 15, `no page below one in fifteen for ${JSON.stringify([notable, recent])}`);
    assert.ok(Math.max(...shares) <= 1 / 3, `no page above one in three for ${JSON.stringify([notable, recent])}`);
  }
});

// ENG-166, decisions 1 and 7.
test('a new account explores about one notable place in eleven, and a reader as taken with either kind per card settles at one in fifteen however many of each were shown', () => {
  const none = mean(sampledShares(createEmptyInteractionProfile()));
  assert.ok(none > 0.085 && none < 0.1, `share without engagement: ${none}`);
  // One card in five liked of each kind: recent cards shown 14 times as often
  // as notable ones, and twice as often.
  const fourteenToOne = mean(sampledShares(profileWith({ shown: 20, engaged: 4 }, { shown: 280, engaged: 56 })));
  const twoToOne = mean(sampledShares(profileWith({ shown: 100, engaged: 20 }, { shown: 200, engaged: 40 })));
  const longUse = mean(sampledShares(profileWith({ shown: 100, engaged: 10 }, { shown: 1400, engaged: 140 })));
  for (const share of [fourteenToOne, twoToOne, longUse]) {
    assert.ok(share >= 1 / 15 && share < 0.08, `share of an indifferent reader: ${share}`);
  }
  assert.ok(Math.abs(fourteenToOne - twoToOne) < 0.006, `${fourteenToOne} against ${twoToOne}`);
});

test('the share follows how much more each notable card is engaged with than each recent one', () => {
  const recent = { shown: 1400, engaged: 140 };
  const share = (notableEngaged: number) => mean(sampledShares(profileWith({ shown: 100, engaged: notableEngaged }, recent)));
  // Three times the rate: about three notable cards for every fourteen others,
  // a little fewer while a hundred notable cards are all the evidence.
  const threeTimes = share(30);
  assert.ok(threeTimes > 0.13 && threeTimes < 0.19, `three times the rate: ${threeTimes}`);
  // Ten times the rate: the ceiling.
  assert.ok(share(100) > 0.32, 'ten times the rate');
  // A reader who leaves notable cards alone: the floor.
  assert.ok(share(0) < 0.068, 'notable cards left alone');
});

// The share sets how many notable cards the reader is shown next, which must
// not feed itself: a reader who engages equally keeps today's share page
// after page, and one who prefers notable cards by half keeps about 1.5 in 15.5.
test('page after page, a reader\'s share stays where their per-card rates put it rather than drifting with what it showed', () => {
  for (const [ratio, low, high] of [[1, 1 / 15, 0.08], [1.5, 0.08, 0.11]] as const) {
    const profile = createEmptyInteractionProfile();
    const random = seededRandom(7);
    const shares: number[] = [];
    let card = 0;
    for (let page = 0; page < 150; page += 1) {
      const every = sampleNotableEvery(readProfileSignals(profile, NOW).temporal, random);
      shares.push(1 / every);
      for (let index = 1; index <= 30; index += 1) {
        const notable = index % every === 0;
        const engaged = random() < (notable ? 0.1 * ratio : 0.1) ? 1 : 0;
        recordCards(profile, notable, { shown: 1, engaged }, `c${card}`);
        card += 1;
      }
    }
    const late = mean(shares.slice(-75));
    assert.ok(late >= low && late < high, `ratio ${ratio}: late share ${late}`);
  }
});

// ENG-166, decision 4.
test('years of notable likes do not hold the share up once the reader turns to recent cards', () => {
  const profile = profileWith({ shown: 600, engaged: 300 }, { shown: 3000, engaged: 150 });
  assert.ok(mean(sampledShares(profile)) > 0.3, 'the long-held share');
  // Then, over the next 2,250 cards, one in three of them notable, the reader
  // likes recent cards and leaves notable ones.
  recordCards(profile, true, { shown: 750, engaged: 0 }, 'later');
  recordCards(profile, false, { shown: 1500, engaged: 300 }, 'later');
  const after = mean(sampledShares(profile));
  assert.ok(after < 0.08, `share after the turn: ${after}`);
});

test('a lone skip or a lone dismissal of one card moves neither the share\'s engagement nor the lean', () => {
  for (const notable of [true, false]) {
    for (const kind of ['skip', 'notInterested']) {
      const profile = createEmptyInteractionProfile();
      recordInteractionEvent(profile, { paperId: 'card', category: 'cs.LG', notable, published: notable ? '2018-03-01T00:00:00.000Z' : '2026-10-23T00:00:00.000Z', kind }, NOW);
      const { temporal } = readProfileSignals(profile, NOW);
      assert.equal(temporal.notable.engaged + temporal.recent.engaged, 0, `${kind} of a ${notable ? 'notable' : 'recent'} card`);
      assert.equal(temporal.lean, 0);
    }
  }
});
