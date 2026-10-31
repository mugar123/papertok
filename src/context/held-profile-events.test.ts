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
import { adoptHeldEvents, holdProfileEvent, refuseHeldEvent, replayHeldEvents, type HeldProfileEvents } from './held-profile-events.ts';
import { unmarkRead } from './unmark-read.ts';
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
// profile and is held. The load adopts the held events as FeedProvider does
// (adoptHeldEvents), counting the writes it schedules in `feed.flushes`, then
// draws the liked set from the profile and empties the library until it is
// read again from the interaction records.
function signedInFeed(userId = 'reader') {
  const feed = {
    hydrated: false,
    profile: createEmptyInteractionProfile(),
    held: null as HeldProfileEvents | null,
    liked: new Set<string>(),
    readLater: new Set<string>(),
    read: new Set<string>(),
    saved: new Set<string>(),
    dismissed: new Set<string>(),
    changes: markChanges(),
    flushes: 0,
  };
  const record = (event: InteractionEvent, undoes?: InteractionEvent | null) => {
    recordInteractionEvent(feed.profile, event, NOW);
    if (!feed.hydrated) feed.held = holdProfileEvent(feed.held, userId, event, NOW, undoes);
    return event;
  };
  // FeedProvider's `refusing`.
  const refusing = async (write: () => Promise<void>, held: InteractionEvent | null) => {
    try {
      await write();
    } catch (error) {
      if (held) refuseHeldEvent(feed.held, held);
      throw error;
    }
  };
  // `eventFor(on, restores)`: `restores` on the undo of a refused change.
  const toggle = (set: 'liked' | 'readLater', paperId: string, eventFor: (on: boolean, restores: boolean) => InteractionEvent, write: () => Promise<void>, undoable: boolean) => {
    const from = feed[set].has(paperId);
    let shown: InteractionEvent | null = null;
    const showOn = (on: boolean, undoes?: InteractionEvent | null) => {
      const recorded = record(eventFor(on, Boolean(undoes)), undoes);
      feed[set] = new Set(feed[set]);
      if (on) feed[set].add(paperId);
      else feed[set].delete(paperId);
      return recorded;
    };
    return writeMark({
      show: () => { shown = showOn(!from); },
      undo: undoable ? () => { showOn(from, shown); } : undefined,
      write: () => refusing(write, shown),
      failure: 'refused',
      stillSignedIn: () => true,
      changes: feed.changes,
      markKey: markKey(userId, set === 'liked' ? 'like' : 'readLater', paperId),
      from,
      to: !from,
      isOn: () => feed[set].has(paperId),
    });
  };
  // FeedProvider's markSaved, unmarkSaved, markNotInterested and
  // undoNotInterested: the screen changes, the event is recorded, and the
  // write follows. A refused write throws only when `throwOnError` asks.
  const setMark = async (set: 'saved' | 'dismissed', paperId: string, on: boolean, kind: string, write: () => Promise<void>, throwOnError = false, fields: Partial<InteractionEvent> = {}) => {
    if (feed[set].has(paperId) === on) return;
    feed[set] = new Set(feed[set]);
    if (on) feed[set].add(paperId);
    else feed[set].delete(paperId);
    const recorded = record({ ...likeOf(paperId), kind, ...fields });
    try {
      await refusing(write, recorded);
    } catch (error) {
      if (throwOnError) throw error;
    }
  };
  const unsave = (paperId: string, write: () => Promise<void>, throwOnError = false) => setMark('saved', paperId, false, 'unsave', write, throwOnError);
  return {
    feed,
    // useQuickSave's save (markThenConfirm): a refused save is taken back by
    // an unsave, which writes `saved: false` of its own.
    async quickSave(paperId: string, write: () => Promise<void>, rollback: () => Promise<void>) {
      const alreadySaved = feed.saved.has(paperId);
      try {
        await setMark('saved', paperId, true, 'save', write, true);
      } catch {
        if (!alreadySaved) await unsave(paperId, rollback);
      }
    },
    // useQuickSave's removal (unmarkThenConfirm): a refused unsave is put back
    // by a save that restores what it took. `card` as for `like`.
    async quickRemove(paperId: string, write: () => Promise<void>, restore: () => Promise<void>, card?: Pick<InteractionEvent, 'notable' | 'published'>) {
      try {
        await setMark('saved', paperId, false, 'unsave', write, true, card);
      } catch {
        await setMark('saved', paperId, true, 'save', restore, false, { ...card, restores: true });
      }
    },
    save: (paperId: string, write: () => Promise<void>) => setMark('saved', paperId, true, 'save', write),
    unsave,
    dismiss: (paperId: string, write: () => Promise<void>) => setMark('dismissed', paperId, true, 'notInterested', write),
    undoDismiss: (paperId: string, write: () => Promise<void>) => setMark('dismissed', paperId, false, 'undoNotInterested', write),
    // `card`: the tapped card's kind and date, a notable For You card's by default.
    like: (paperId: string, write: () => Promise<void>, card?: Pick<InteractionEvent, 'notable' | 'published'>) => toggle(
      'liked', paperId, (on, restores) => ({ ...likeOf(paperId, on ? 'like' : 'unlike'), ...card, restores }), write, true,
    ),
    // The quick save takes a refused change back; the list picker keeps it.
    readLater: (paperId: string, write: () => Promise<void>, undoable = true) => toggle('readLater', paperId, (value) => ({ paperId, kind: 'readLater', value }), write, undoable),
    // A removal from Reading history (FeedProvider's unmarkAsRead).
    unmarkRead(paperId: string, write: () => Promise<void>) {
      let unmarked: InteractionEvent | null = null;
      return unmarkRead<{ readAt?: string | null }>(paperId, {
        setReadIds: (update) => { feed.read = update(feed.read); },
        setLibrary: () => {},
        write: () => refusing(write, unmarked),
        onUnmarked: () => { unmarked = record({ paperId, kind: 'unread' }); },
        onRestored: () => { record({ paperId, kind: 'read' }, unmarked); },
        throwOnError: true,
        stillSignedIn: () => true,
        changes: feed.changes,
        markKey: markKey(userId, 'read', paperId),
        isRead: () => feed.read.has(paperId),
      });
    },
    load(profile: InteractionProfile) {
      adoptHeldEvents(feed.held, userId, profile, { changes: feed.changes, flush: () => { feed.flushes += 1; } });
      feed.held = null;
      feed.profile = profile;
      feed.hydrated = true;
      feed.liked = new Set(curatedIds(profile, 'liked'));
      feed.read = new Set(curatedIds(profile, 'read'));
      feed.saved = new Set(curatedIds(profile, 'saved'));
      feed.dismissed = new Set(curatedIds(profile, 'notInterested'));
      feed.readLater = new Set();
    },
    readLibrary(readLater: string[]) {
      feed.readLater = new Set(readLater);
    },
    // FeedProvider's account effect when the same account signs out and back
    // in before any profile loaded: it drops the held events, and the
    // provisional profile, the marks on screen and the writes still waiting
    // stay.
    signOutAndBackIn() {
      feed.held = null;
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
  assert.equal(JSON.stringify(serializeInteractionProfile(reader.feed.profile)), JSON.stringify(serializeInteractionProfile(storedProfileWith(likeOf('liked')))));
});

// Until the profile loads, these papers show without the mark storage gives
// them, and the reader taps it on again; Firestore accepts each write.
test('a like, a save or a dismissal made while the profile loads, of a paper it already holds so, counts once', () => {
  const marks: InteractionEvent[] = [
    likeOf('liked'),
    { ...likeOf('saved'), kind: 'save' },
    { paperId: 'dismissed', kind: 'notInterested', category: 'cs.LG', concepts: [{ id: 'C2', score: 0.8 }] },
  ];
  const stored = () => {
    const profile = createEmptyInteractionProfile();
    marks.forEach((event) => recordInteractionEvent(profile, event, NOW - 86_400_000));
    return deserializeInteractionProfile(serializeInteractionProfile(profile))!;
  };
  const provisional = createEmptyInteractionProfile();
  let held: HeldProfileEvents | null = null;
  marks.forEach((event, index) => { held = recordWhileLoading(held, 'reader', provisional, { ...event }, NOW + index); });

  const profile = stored();
  assert.equal(replayHeldEvents(held, 'reader', profile), false);
  assert.equal(JSON.stringify(serializeInteractionProfile(profile)), JSON.stringify(serializeInteractionProfile(stored())));
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

// The unlike is sent before the like is answered. The like's refusal moves
// nothing while the unlike stands, and the unlike's refusal finds the screen
// unliked already: neither undo runs.
test('a like and the unlike after it, both refused before the profile arrives, leave a like stored in an earlier session', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = signedInFeed();
  const writes = [pendingWrite(), pendingWrite()];
  const pressed = writes.map((write) => reader.like('liked', write.write));
  writes.forEach((write) => write.answer(false));
  await Promise.all(pressed);
  assert.ok(!reader.feed.liked.has('liked'));
  reader.load(storedProfileWith(likeOf('liked')));

  assert.ok(reader.feed.liked.has('liked'));
  assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), ['liked']);
  assert.equal(readProfileSignals(reader.feed.profile, NOW).temporal.notable.engaged, 1);
});

test('a Read later change the list picker keeps on screen after a refusal before the profile arrives is not replayed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = signedInFeed();
  const write = pendingWrite();
  const pressed = reader.readLater('later', write.write, false);
  write.answer(false);
  await pressed;
  assert.ok(reader.feed.readLater.has('later'), 'the picker keeps what it showed');
  reader.load(storedProfile());

  assert.deepEqual(curatedIds(reader.feed.profile, 'readLater'), []);
});

// Until the profile loads, a paper read in an earlier session is not in the
// read set. A removal from Reading history then starts from unread and moves
// nothing back when refused.
test('a Reading history removal refused before the profile arrives leaves the paper read where storage has it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const stored = () => {
    const profile = createEmptyInteractionProfile();
    recordInteractionEvent(profile, { paperId: 'first', kind: 'read' }, NOW - 2 * 86_400_000);
    recordInteractionEvent(profile, { paperId: 'second', kind: 'read' }, NOW - 86_400_000);
    return deserializeInteractionProfile(serializeInteractionProfile(profile))!;
  };
  const reader = signedInFeed();
  const write = pendingWrite();
  const removed = reader.unmarkRead('first', write.write);
  write.answer(false);
  await assert.rejects(removed, /permission-denied/);
  reader.load(stored());

  assert.deepEqual(curatedIds(reader.feed.profile, 'read'), curatedIds(stored(), 'read'));
  assert.ok(reader.feed.read.has('first'));
});

const refused = async () => { throw new Error('permission-denied'); };
const accepted = async () => {};

// Until the profile loads, a paper saved in an earlier session shows unsaved.
// The quick save's write is refused, so it takes the save back with an
// unsave, whose write is refused too: storage keeps `saved: true`.
test('a quick save refused while the profile loads, and its refused rollback, leave a save stored in an earlier session', async () => {
  const stored = () => storedProfileWith({ ...likeOf('saved'), kind: 'save' });
  const reader = signedInFeed();
  await reader.quickSave('saved', refused, refused);
  assert.ok(!reader.feed.saved.has('saved'));
  reader.load(stored());

  assert.ok(reader.feed.saved.has('saved'), 'the Save button shows the stored save');
  assert.equal(JSON.stringify(serializeInteractionProfile(reader.feed.profile)), JSON.stringify(serializeInteractionProfile(stored())));
});

// The rollback's `saved: false` is accepted, so storage no longer holds the
// save and neither does the profile.
test('a quick save refused while the profile loads, and its accepted rollback, take back a save stored in an earlier session', async () => {
  const reader = signedInFeed();
  await reader.quickSave('saved', refused, accepted);
  reader.load(storedProfileWith({ ...likeOf('saved'), kind: 'save' }));

  assert.ok(!reader.feed.saved.has('saved'));
  assert.deepEqual(curatedIds(reader.feed.profile, 'saved'), []);
  assert.equal(readProfileSignals(reader.feed.profile, NOW).temporal.notable.engaged, 0);
});

test('a save or a dismissal refused while the profile loads, on a paper storage never marked so, is not replayed', async () => {
  const reader = signedInFeed();
  await reader.save('new', refused);
  await reader.dismiss('other', refused);
  reader.load(storedProfile());

  assert.deepEqual([curatedIds(reader.feed.profile, 'saved'), curatedIds(reader.feed.profile, 'notInterested')], [[], []]);
  assert.equal(JSON.stringify(serializeInteractionProfile(reader.feed.profile)), JSON.stringify(serializeInteractionProfile(storedProfile())));
});

// What the held events add reaches storage when the profile arrives, without
// waiting for the reader's next event.
test('the events held while the profile loads are written back when it arrives, and a load they add nothing to writes nothing', async () => {
  const reader = signedInFeed();
  await reader.like('new', accepted);
  reader.load(storedProfile());
  assert.equal(reader.feed.flushes, 1);
  assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), ['new']);

  const idle = signedInFeed();
  idle.load(storedProfile());
  // A like storage already holds, and a save storage refused.
  const known = signedInFeed();
  await known.like('liked', accepted);
  await known.save('other', refused);
  known.load(storedProfileWith(likeOf('liked')));
  assert.deepEqual([idle.feed.flushes, known.feed.flushes], [0, 0]);
});

// Until the profile loads, a paper dismissed in an earlier session shows
// without the dismissal. The reader dismisses it and takes that back, and the
// write of the take-back is refused: storage keeps the dismissal.
test('a dismissal taken back while the profile loads, refused, leaves a dismissal stored in an earlier session', async () => {
  const stored = () => storedProfileWith({ paperId: 'dismissed', kind: 'notInterested', category: 'cs.LG' });
  const reader = signedInFeed();
  await reader.dismiss('dismissed', accepted);
  await reader.undoDismiss('dismissed', refused);
  reader.load(stored());

  assert.ok(reader.feed.dismissed.has('dismissed'));
  assert.equal(JSON.stringify(serializeInteractionProfile(reader.feed.profile)), JSON.stringify(serializeInteractionProfile(stored())));
});

// The paper was liked or saved from a recent For You card in an earlier
// session. A Lists card reports no kind, a notable For You card the other one.
const RECENT_FOR_YOU = { notable: false, published: '2026-10-28' };
const REVERSE_TAPS = [
  ['a card off For You', { notable: undefined, published: '2026-10-28' }],
  ['a notable For You card', { notable: true, published: null }],
] as const;

for (const [card, tapped] of REVERSE_TAPS) {
  test(`an unlike refused after the profile arrives, tapped on ${card}, leaves the stored like's counts`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const stored = () => storedProfileWith({ ...likeOf('liked'), ...RECENT_FOR_YOU });
    const reader = signedInFeed();
    reader.load(stored());
    await reader.like('liked', refused, tapped);

    assert.ok(reader.feed.liked.has('liked'));
    assert.deepEqual(curatedIds(reader.feed.profile, 'liked'), ['liked']);
    assert.deepEqual(readProfileSignals(reader.feed.profile, NOW).temporal, readProfileSignals(stored(), NOW).temporal);
  });

  test(`a quick save removal refused after the profile arrives, tapped on ${card}, leaves the stored save's counts`, async () => {
    const stored = () => storedProfileWith({ ...likeOf('saved'), kind: 'save', ...RECENT_FOR_YOU });
    const reader = signedInFeed();
    reader.load(stored());
    await reader.quickRemove('saved', refused, accepted, tapped);

    assert.ok(reader.feed.saved.has('saved'));
    assert.deepEqual(readProfileSignals(reader.feed.profile, NOW).temporal, readProfileSignals(stored(), NOW).temporal);
  });
}

// Until the profile loads, a paper marked in an earlier session shows
// unmarked. The reader marks it, and the change is dropped from the held
// events before Firestore refuses it: its undo, which puts back the unmarked
// screen, must not take the stored mark back.
const STORED_MARKS: Array<{ mark: string; set: 'liked' | 'readLater'; stored: InteractionEvent; tap: (reader: ReturnType<typeof signedInFeed>, write: () => Promise<void>) => Promise<void> }> = [
  { mark: 'like', set: 'liked', stored: likeOf('marked'), tap: (reader, write) => reader.like('marked', write) },
  { mark: 'Read later', set: 'readLater', stored: { paperId: 'marked', kind: 'readLater', value: true }, tap: (reader, write) => reader.readLater('marked', write) },
];

for (const { mark, set, stored, tap } of STORED_MARKS) {
  test(`a ${mark} tapped while the profile loads and refused after the same account signs out and back in leaves the ${mark} stored in an earlier session`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const reader = signedInFeed();
    const write = pendingWrite();
    const pressed = tap(reader, write.write);
    reader.signOutAndBackIn();
    write.answer(false);
    await pressed;
    reader.load(storedProfileWith(stored));

    assert.deepEqual(curatedIds(reader.feed.profile, set), ['marked']);
    assert.equal(JSON.stringify(serializeInteractionProfile(reader.feed.profile)), JSON.stringify(serializeInteractionProfile(storedProfileWith(stored))));
  });

  test(`a ${mark} tapped while the profile loads, pushed out of a long wait's held events and refused, leaves the ${mark} stored in an earlier session`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const reader = signedInFeed();
    const write = pendingWrite();
    const pressed = tap(reader, write.write);
    for (let index = 0; index < 10_000; index += 1) {
      reader.feed.held = holdProfileEvent(reader.feed.held, 'reader', { paperId: `card-${index}`, kind: 'skip', notable: false }, NOW);
    }
    write.answer(false);
    await pressed;
    reader.load(storedProfileWith(stored));

    assert.deepEqual(curatedIds(reader.feed.profile, set), ['marked']);
  });
}

// Until the profile loads, a paper liked in an earlier session shows unliked:
// the reader likes it, which storage already holds, then unlikes it. The
// profile arrives while the unlike waits, its replay takes the stored like
// back, and Firestore refuses the unlike.
test('an unlike tapped while the profile loads and refused after it arrives leaves the stored like\'s counts', async (t) => {
  t.mock.method(console, 'error', () => {});
  const stored = () => storedProfileWith({ ...likeOf('liked'), ...RECENT_FOR_YOU });
  const [card] = REVERSE_TAPS;
  const reader = signedInFeed();
  await reader.like('liked', accepted, card[1]);
  const write = pendingWrite();
  const pressed = reader.like('liked', write.write, card[1]);
  reader.load(stored());
  assert.ok(!reader.feed.liked.has('liked'), 'the profile that arrives keeps the waiting unlike');
  write.answer(false);
  await pressed;

  assert.ok(reader.feed.liked.has('liked'));
  assert.deepEqual(readProfileSignals(reader.feed.profile, NOW).temporal, readProfileSignals(stored(), NOW).temporal);
});
