import type { InteractionEvent } from '../utils/interaction-profile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyInteractionProfile,
  curatedIds,
  deserializeInteractionProfile,
  readProfileSignals,
  recordInteractionEvent,
  serializeInteractionProfile,
  viewedIds,
} from '../utils/interaction-profile.ts';
import { corpusOrder } from './feed-temporal-lean.ts';
import { holdProfileEvent, replayHeldEvents, type HeldProfileEvents } from './held-profile-events.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const TWO_YEARS_AGO = '2024-10-01';

// The aggregate as Firestore keeps it: one recent card viewed in an earlier
// session, nothing that moved the lean.
function storedProfile() {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'earlier', kind: 'viewTime', viewTime: 3, notable: false, published: '2026-10-29' }, NOW - 86_400_000);
  return deserializeInteractionProfile(serializeInteractionProfile(profile))!;
}

// What the feed does with an event while the profile loads: records it on the
// provisional profile and holds it. `undoes` is the held event of a refused
// change this event takes back on screen.
function recordWhileLoading(held: HeldProfileEvents | null, userId: string, provisional: ReturnType<typeof createEmptyInteractionProfile>, event: InteractionEvent, at: number, undoes?: InteractionEvent) {
  recordInteractionEvent(provisional, event, at);
  return holdProfileEvent(held, userId, event, at, undoes);
}

// The aggregate of an account that made `event` in an earlier session.
function storedProfileWith(event: InteractionEvent) {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, event, NOW - 86_400_000);
  return deserializeInteractionProfile(serializeInteractionProfile(profile))!;
}

test('likes and views recorded before a late profile arrives are kept on it', () => {
  const provisional = createEmptyInteractionProfile();
  let held: HeldProfileEvents | null = null;
  ['old-1', 'old-2', 'old-3', 'old-4'].forEach((paperId, index) => {
    held = recordWhileLoading(held, 'reader', provisional, { paperId, kind: 'like', notable: false, published: TWO_YEARS_AGO }, NOW + index);
  });
  held = recordWhileLoading(held, 'reader', provisional, { paperId: 'classic', kind: 'like', notable: true, published: null }, NOW + 4);
  held = recordWhileLoading(held, 'reader', provisional, { paperId: 'seen', kind: 'skip', notable: false }, NOW + 5);
  assert.equal(corpusOrder(readProfileSignals(provisional, NOW).temporal.lean), 'relevance', 'the provisional profile asks for relevance');

  const profile = storedProfile();
  assert.equal(replayHeldEvents(held, 'reader', profile), true);

  const { temporal } = readProfileSignals(profile, NOW);
  assert.ok(Math.abs(temporal.lean - -0.4) < 1e-9, `lean ${temporal.lean}`);
  assert.equal(corpusOrder(temporal.lean), 'relevance');
  assert.deepEqual(temporal.recent, { shown: 2, engaged: 4 });
  assert.deepEqual(temporal.notable, { shown: 0, engaged: 1 });
  assert.deepEqual(curatedIds(profile, 'liked').sort(), ['classic', 'old-1', 'old-2', 'old-3', 'old-4']);
  assert.ok(viewedIds(profile).includes('seen'));
  assert.ok(viewedIds(profile).includes('earlier'), 'the stored history stays');

  // The like is remembered once: an unlike after the load takes back one step.
  recordInteractionEvent(profile, { paperId: 'old-1', kind: 'unlike' }, NOW + 10);
  const after = readProfileSignals(profile, NOW).temporal;
  assert.ok(Math.abs(after.lean - -0.3) < 1e-9, `lean ${after.lean}`);
  assert.equal(after.recent.engaged, 3);
});

// Until the profile loads, a paper liked in an earlier session shows unliked.
// A like of it that Firestore refuses is taken back on screen, and storage
// still holds the earlier like.
for (const [card, fields] of [
  ['a notable For You card', { notable: true, published: null }],
  ['a recent For You card', { notable: false, published: '2026-10-28' }],
  ['a card off For You', { published: TWO_YEARS_AGO }],
] as const) {
  test(`a refused like of ${card} taken back before the load leaves the stored like`, () => {
    const like: InteractionEvent = { paperId: 'liked', kind: 'like', category: 'cs.LG', concepts: [{ id: 'C1', score: 0.9 }], ...fields };
    const stored = storedProfileWith(like);
    const before = readProfileSignals(stored, NOW).temporal;

    const provisional = createEmptyInteractionProfile();
    let held = recordWhileLoading(null, 'reader', provisional, { ...like }, NOW);
    const shown = held.events.at(-1)!.event;
    held = recordWhileLoading(held, 'reader', provisional, { ...like, kind: 'unlike' }, NOW + 1, shown);
    held = recordWhileLoading(held, 'reader', provisional, { paperId: 'next', kind: 'skip', notable: false }, NOW + 2);

    const profile = storedProfileWith(like);
    replayHeldEvents(held, 'reader', profile);
    assert.deepEqual(curatedIds(profile, 'liked'), ['liked']);
    const after = readProfileSignals(profile, NOW);
    assert.deepEqual(
      [after.temporal.notable.engaged, after.temporal.recent.engaged, after.temporal.lean],
      [before.notable.engaged, before.recent.engaged, before.lean],
    );
    assert.equal(after.conceptAffinities.C1, readProfileSignals(stored, NOW).conceptAffinities.C1);

    // Taken back alone, the pair leaves the profile as stored.
    const pairOnly = recordWhileLoading(null, 'reader', provisional, { ...like }, NOW);
    const pairShown = pairOnly.events.at(-1)!.event;
    recordWhileLoading(pairOnly, 'reader', provisional, { ...like, kind: 'unlike' }, NOW + 1, pairShown);
    const untouched = storedProfileWith(like);
    assert.equal(replayHeldEvents(pairOnly, 'reader', untouched), false);
    assert.equal(JSON.stringify(serializeInteractionProfile(untouched)), JSON.stringify(serializeInteractionProfile(stored)));
  });
}

test('an unlike the reader taps before the load still takes back a stored like', () => {
  const like: InteractionEvent = { paperId: 'liked', kind: 'like', notable: true, published: null };
  const provisional = createEmptyInteractionProfile();
  let held = recordWhileLoading(null, 'reader', provisional, { ...like }, NOW);
  held = recordWhileLoading(held, 'reader', provisional, { ...like, kind: 'unlike' }, NOW + 1);

  const profile = storedProfileWith(like);
  assert.equal(replayHeldEvents(held, 'reader', profile), true);
  assert.deepEqual(curatedIds(profile, 'liked'), []);
  assert.equal(readProfileSignals(profile, NOW).temporal.notable.engaged, 0);
});

test('a refused Read later taken back before the load leaves the stored mark', () => {
  const stored: InteractionEvent = { paperId: 'later', kind: 'readLater', value: true };
  const provisional = createEmptyInteractionProfile();
  let held = recordWhileLoading(null, 'reader', provisional, { ...stored }, NOW);
  const shown = held.events.at(-1)!.event;
  held = recordWhileLoading(held, 'reader', provisional, { ...stored, value: false }, NOW + 1, shown);
  held = recordWhileLoading(held, 'reader', provisional, { paperId: 'next', kind: 'skip', notable: false }, NOW + 2);

  const profile = storedProfileWith(stored);
  replayHeldEvents(held, 'reader', profile);
  assert.deepEqual(curatedIds(profile, 'readLater'), ['later']);
});

test('an account change before the load drops the held events', () => {
  const provisional = createEmptyInteractionProfile();
  let held = recordWhileLoading(null, 'first', provisional, { paperId: 'old-1', kind: 'like', notable: false, published: TWO_YEARS_AGO }, NOW);

  const other = storedProfile();
  const before = JSON.stringify(serializeInteractionProfile(other));
  assert.equal(replayHeldEvents(held, 'second', other), false);
  assert.equal(JSON.stringify(serializeInteractionProfile(other)), before);

  held = holdProfileEvent(held, 'second', { paperId: 'mine', kind: 'skip', notable: false }, NOW + 1);
  assert.deepEqual(held.events.map(({ event }) => event.paperId), ['mine']);
  assert.equal(replayHeldEvents(held, 'second', other), true);
  assert.deepEqual(curatedIds(other, 'liked'), []);
  assert.equal(readProfileSignals(other, NOW).temporal.lean, 0);
});

test('a load that never ends holds only the latest events', () => {
  let held: HeldProfileEvents | null = null;
  for (let index = 0; index < 10_000; index += 1) {
    held = holdProfileEvent(held, 'reader', { paperId: `card-${index}`, kind: 'skip', notable: false }, NOW + index);
  }
  const ids = held!.events.map(({ event }) => event.paperId);
  assert.ok(ids.length < 10_000, `${ids.length} events held`);
  assert.equal(ids.at(-1), 'card-9999');
  assert.ok(!ids.includes('card-0'));
});

test('a profile that arrives before any event is left as stored', () => {
  const profile = storedProfile();
  const before = JSON.stringify(serializeInteractionProfile(profile));
  assert.equal(replayHeldEvents(null, 'reader', profile), false);
  assert.equal(replayHeldEvents({ userId: 'reader', events: [] }, 'reader', profile), false);
  assert.equal(JSON.stringify(serializeInteractionProfile(profile)), before);
});
