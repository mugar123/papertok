import type { InteractionEvent, InteractionProfile } from '../utils/interaction-profile.ts';
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
import { heldMarkStarts, holdProfileEvent, replayHeldEvents, type HeldProfileEvents } from './held-profile-events.ts';
import { markChanges, markKey, writeMark } from './write-mark.ts';

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

// A write the test answers: accepted with `answer(true)`, refused with
// `answer(false)`.
function pendingWrite() {
  let answer!: (accepted: boolean) => void;
  const accepted = new Promise<boolean>((resolve) => { answer = resolve; });
  return {
    answer,
    write: async () => {
      if (!(await accepted)) throw new Error('permission-denied');
    },
  };
}

const likeOf = (paperId: string, kind = 'like'): InteractionEvent => ({
  paperId, kind, category: 'cs.LG', concepts: [{ id: 'C1', score: 0.9 }], notable: true, published: null,
});

// FeedProvider's like and Read later toggles and its profile load, with the
// real mark log. Until the profile arrives, each event moves the provisional
// profile and is held. The load reads what the profile stores of the marks
// the held events moved, replays them, then draws the liked set from the
// profile and empties the library until it is read again from the
// interaction records.
function signedInFeed(userId = 'reader') {
  const feed = {
    hydrated: false,
    profile: createEmptyInteractionProfile(),
    held: null as HeldProfileEvents | null,
    liked: new Set<string>(),
    readLater: new Set<string>(),
    changes: markChanges(),
  };
  const record = (event: InteractionEvent, undoes?: InteractionEvent | null) => {
    recordInteractionEvent(feed.profile, event, NOW);
    if (!feed.hydrated) feed.held = holdProfileEvent(feed.held, userId, event, NOW, undoes);
    return event;
  };
  const toggle = (set: 'liked' | 'readLater', paperId: string, eventFor: (on: boolean) => InteractionEvent, write: () => Promise<void>, undoable: boolean) => {
    const from = feed[set].has(paperId);
    let shown: InteractionEvent | null = null;
    const showOn = (on: boolean, undoes?: InteractionEvent | null) => {
      const recorded = record(eventFor(on), undoes);
      feed[set] = new Set(feed[set]);
      if (on) feed[set].add(paperId);
      else feed[set].delete(paperId);
      return recorded;
    };
    return writeMark({
      show: () => { shown = showOn(!from); },
      undo: undoable ? () => { showOn(from, shown); } : undefined,
      write,
      failure: 'refused',
      stillSignedIn: () => true,
      changes: feed.changes,
      markKey: markKey(userId, set === 'liked' ? 'like' : 'readLater', paperId),
      from,
      to: !from,
      isOn: () => feed[set].has(paperId),
    });
  };
  return {
    feed,
    like: (paperId: string, write: () => Promise<void>) => toggle('liked', paperId, (on) => likeOf(paperId, on ? 'like' : 'unlike'), write, true),
    // The quick save takes a refused change back; the list picker keeps it.
    readLater: (paperId: string, write: () => Promise<void>, undoable = true) => toggle('readLater', paperId, (value) => ({ paperId, kind: 'readLater', value }), write, undoable),
    load(profile: InteractionProfile) {
      const starts = heldMarkStarts(feed.held, userId, profile);
      replayHeldEvents(feed.held, userId, profile);
      feed.held = null;
      feed.profile = profile;
      feed.hydrated = true;
      feed.changes.screenReplaced(starts);
      feed.liked = new Set(curatedIds(profile, 'liked'));
      feed.readLater = new Set();
    },
    readLibrary(readLater: string[]) {
      feed.readLater = new Set(readLater);
    },
  };
}

// Until the profile loads, a paper liked in an earlier session shows unliked.
// The reader likes it, the profile arrives while the write waits, and
// Firestore refuses the like: storage still holds the earlier like.
test('a like tapped while the profile loads and refused after it arrives leaves a like stored in an earlier session', async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = readProfileSignals(storedProfileWith(likeOf('liked')), NOW).temporal;
  const reader = signedInFeed();
  const write = pendingWrite();
  const pressed = reader.like('liked', write.write);
  assert.ok(reader.feed.liked.has('liked'), 'the tap shows the like');
  reader.load(storedProfileWith(likeOf('liked')));
  write.answer(false);
  await pressed;

  assert.ok(reader.feed.liked.has('liked'), 'the screen keeps the stored like');
  assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), ['liked']);
  const after = readProfileSignals(reader.feed.profile, NOW).temporal;
  assert.deepEqual([after.notable.engaged, after.lean], [before.notable.engaged, before.lean]);
});

test('a like tapped while the profile loads and refused after it arrives is taken back when storage never had it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = signedInFeed();
  const write = pendingWrite();
  const pressed = reader.like('new', write.write);
  reader.load(storedProfile());
  assert.ok(reader.feed.liked.has('new'), 'the profile that arrives keeps the waiting like');
  write.answer(false);
  await pressed;

  assert.ok(!reader.feed.liked.has('new'));
  assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), []);
  assert.equal(readProfileSignals(reader.feed.profile, NOW).temporal.notable.engaged, 0);
});

// The like and the unlike before it were accepted, so storage no longer holds
// the earlier like when the last like is refused.
test('a like refused after the profile arrives, after an unlike accepted while it loaded, leaves the paper unliked', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = signedInFeed();
  for (const accepted of [true, true]) {
    const write = pendingWrite();
    const pressed = reader.like('liked', write.write);
    write.answer(accepted);
    await pressed;
  }
  assert.ok(!reader.feed.liked.has('liked'));
  const write = pendingWrite();
  const pressed = reader.like('liked', write.write);
  reader.load(storedProfileWith(likeOf('liked')));
  write.answer(false);
  await pressed;

  assert.ok(!reader.feed.liked.has('liked'));
  assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), []);
});

test('a quick save to Read later tapped while the profile loads and refused after it arrives leaves the stored mark', async (t) => {
  t.mock.method(console, 'error', () => {});
  const stored = () => storedProfileWith({ paperId: 'later', kind: 'readLater', value: true });
  const reader = signedInFeed();
  const write = pendingWrite();
  const pressed = reader.readLater('later', write.write);
  reader.load(stored());
  reader.readLibrary(['later']);
  write.answer(false);
  await pressed;

  assert.ok(reader.feed.readLater.has('later'));
  assert.deepEqual(curatedIds(reader.feed.profile, 'readLater'), ['later']);
});
