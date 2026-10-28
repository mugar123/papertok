import test from 'node:test';
import assert from 'node:assert/strict';
import { markChanges, markStartsOn, writeMark } from './write-mark.ts';
import { readLaterStamp, restoreReadLater } from './read-later-rollback.ts';

const silenced = async (run: () => Promise<unknown>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

// One paper's like, as the screen shows it.
function likeOnScreen(initial: boolean) {
  const screen = { liked: initial };
  return {
    screen,
    show: () => { screen.liked = !initial; },
    undo: () => { screen.liked = initial; },
    changes: markChanges(),
    markKey: 'u1:like:p1',
    from: initial,
    to: !initial,
    isOn: () => screen.liked,
  };
}

test('a refused unlike shows the like again, and the caller that asked hears of it', async () => {
  const like = likeOnScreen(true);
  await silenced(() => assert.rejects(writeMark({
    ...like, failure: 'refused', throwOnError: true, stillSignedIn: () => true,
    write: () => Promise.reject(new Error('permission-denied')),
  }), /permission-denied/));
  assert.equal(like.screen.liked, true);
});

test('a refusal that lands after the account changed puts nothing back on the new account', async () => {
  const like = likeOnScreen(true);
  await silenced(() => writeMark({
    ...like, failure: 'refused', stillSignedIn: () => false,
    write: () => Promise.reject(new Error('permission-denied')),
  }));
  assert.equal(like.screen.liked, false);
});

test('with afterWrite an accepted change shows once the write is in, and only for the same account', async () => {
  const like = likeOnScreen(true);
  await writeMark({ ...like, failure: 'refused', afterWrite: true, stillSignedIn: () => false, write: async () => {} });
  assert.equal(like.screen.liked, true, 'nothing painted over another account');
  await writeMark({ ...like, failure: 'refused', afterWrite: true, stillSignedIn: () => true, write: async () => {} });
  assert.equal(like.screen.liked, false);
});

// A liked paper's heart the way FeedContext toggles it: each press starts a
// change from the like the screen shows, flips it and tells the reading
// profile. A removal (`afterWrite`) starts from a liked paper. The test answers
// each write, by default in the order they were sent, as Firestore does.
function likedPaper() {
  const changes = markChanges();
  const screen = { liked: true };
  const profile: string[] = [];
  const answers: Array<{ accept: () => void; refuse: () => void }> = [];
  // The presses whose caller was told of a refusal, which the Lists page toasts.
  const reported: string[] = [];
  const press = (options: { afterWrite?: boolean; throwOnError?: boolean } = {}) => {
    const wasLiked = markStartsOn(options, screen.liked);
    const showLiked = (liked: boolean) => {
      screen.liked = liked;
      profile.push(liked ? 'like' : 'unlike');
    };
    return writeMark({
      show: () => showLiked(!wasLiked),
      undo: () => showLiked(wasLiked),
      write: () => new Promise<void>((accept, refuse) => {
        answers.push({ accept, refuse: () => refuse(new Error('permission-denied')) });
      }),
      failure: 'refused',
      ...options,
      stillSignedIn: () => true,
      changes,
      markKey: 'u1:like:p1',
      from: wasLiked,
      to: !wasLiked,
      isOn: () => screen.liked,
    }).catch(() => { reported.push(options.afterWrite ? 'removal' : 'heart'); });
  };
  const acceptAll = () => answers.splice(0).forEach(({ accept }) => accept());
  return { changes, screen, profile, answers, reported, press, acceptAll };
}

// From the Lists page: Remove from Favorites waits for its write; the card,
// opened meanwhile, still shows the like and its heart asks to hear a refusal.
const removal = { afterWrite: true, throwOnError: true };
const cardHeart = { throwOnError: true };

test('a Favorites removal asked for after the first was accepted sends nothing and leaves the paper unliked', async () => {
  const paper = likedPaper();
  const first = paper.press({ afterWrite: true });
  paper.acceptAll();
  await first;
  // A phone sheet opened while the first removal was pending still offers Remove.
  const second = paper.press({ afterWrite: true });
  assert.equal(paper.answers.length, 0, 'no write is sent, so nothing can like the paper again');
  await second;
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});

test('a Favorites removal asked for after the card took the like off sends nothing', async () => {
  const paper = likedPaper();
  const unlike = paper.press();
  // The row stays until it is rerendered; its Remove is pressed meanwhile.
  const removal = paper.press({ afterWrite: true });
  assert.equal(paper.answers.length, 1, 'only the card\'s unlike is sent');
  paper.acceptAll();
  await Promise.all([unlike, removal]);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});

test('a Favorites removal answered after the card unliked the paper tells the reading profile once', async () => {
  const paper = likedPaper();
  const removal = paper.press({ afterWrite: true });
  // The open card still shows the like, and its heart takes it off.
  const unlike = paper.press();
  paper.acceptAll();
  await Promise.all([removal, unlike]);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike'], 'the card\'s unlike only');
});

test('a Favorites removal answered after something else took the like off adds no second unlike', async () => {
  const paper = likedPaper();
  const removal = paper.press({ afterWrite: true });
  // A profile reload, which starts no change, brings the like back off.
  paper.screen.liked = false;
  paper.acceptAll();
  await removal;
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, [], 'the reading profile hears no unlike from the removal');
});

test('a Favorites removal answered after the heart was pressed twice leaves the last press on screen', async () => {
  const paper = likedPaper();
  const removal = paper.press({ afterWrite: true });
  // The open card still shows the like, so it is unliked and liked again.
  const unlike = paper.press();
  const like = paper.press();
  paper.acceptAll();
  await Promise.all([removal, unlike, like]);
  assert.equal(paper.screen.liked, true, 'liked, as the last write leaves the server');
  assert.deepEqual(paper.profile, ['unlike', 'like'], 'the removal adds no unlike of its own');
});

test('a removal sent again before the first was answered tells the reading profile once', async () => {
  const paper = likedPaper();
  // The Lists page, opened again while the first removal was pending, shows the row and its Remove.
  const first = paper.press({ afterWrite: true });
  const second = paper.press({ afterWrite: true });
  paper.acceptAll();
  await Promise.all([first, second]);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});

test('a change to another mark or another paper does not hold a removal back', async () => {
  const paper = likedPaper();
  const removal = paper.press({ afterWrite: true });
  paper.changes.start('u1:read:p1', { isOn: true, to: false, shown: true, keptIfRefused: false });
  paper.changes.start('u1:like:p2', { isOn: false, to: true, shown: true, keptIfRefused: false });
  paper.acceptAll();
  await removal;
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});

test('an accepted Favorites removal stays when the card\'s unlike sent meanwhile is refused', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  const unliked = paper.press(cardHeart);
  paper.answers[0].accept();
  await removed;
  paper.answers[1].refuse();
  await silenced(() => unliked);
  assert.equal(paper.screen.liked, false, 'Firestore holds the removal');
  assert.deepEqual(paper.profile, ['unlike'], 'the profile hears the card\'s unlike only');
  assert.deepEqual(paper.reported, [], 'the like is gone, so the card reports no failure to remove it');
});

test('a refused Favorites removal is not reported while the card\'s pending unlike keeps the paper unliked', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  const unliked = paper.press(cardHeart);
  paper.answers[0].refuse();
  await silenced(() => removed);
  assert.equal(paper.screen.liked, false, 'the row has left with the card\'s unlike');
  assert.deepEqual(paper.reported, []);
  paper.answers[1].accept();
  await unliked;
  assert.equal(paper.screen.liked, false);
});

test('a refused Favorites removal is not reported once something else took the like off', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  // A profile reload, which starts no change, already shows the paper unliked.
  paper.screen.liked = false;
  paper.answers[0].refuse();
  await silenced(() => removed);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.reported, []);
});

test('a card unlike refused before the Favorites removal is accepted ends with the paper unliked', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  const unliked = paper.press(cardHeart);
  paper.answers[1].refuse();
  await silenced(() => unliked);
  assert.equal(paper.screen.liked, true, 'nothing else has been accepted yet');
  paper.answers[0].accept();
  await removed;
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike', 'like', 'unlike'], 'one event for each change on screen');
  assert.deepEqual(paper.reported, ['heart'], 'the like was back on screen when the heart\'s refusal landed');
});

test('an accepted Favorites removal stays when the heart pressed twice meanwhile has its second press refused', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  const unliked = paper.press(cardHeart);
  const liked = paper.press(cardHeart);
  paper.answers[0].accept();
  paper.answers[1].accept();
  await Promise.all([removed, unliked]);
  paper.answers[2].refuse();
  await silenced(() => liked);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike', 'like', 'unlike']);
  assert.deepEqual(paper.reported, ['heart'], 'the second press, a like, did not stand');
});

test('a refused Favorites removal leaves the newer accepted press on screen', async () => {
  const paper = likedPaper();
  const removed = paper.press(removal);
  const unliked = paper.press(cardHeart);
  const liked = paper.press(cardHeart);
  paper.answers[0].refuse();
  await silenced(() => removed);
  paper.answers[1].accept();
  paper.answers[2].accept();
  await Promise.all([unliked, liked]);
  assert.equal(paper.screen.liked, true, 'the last press stands');
  assert.deepEqual(paper.profile, ['unlike', 'like']);
  assert.deepEqual(paper.reported, ['removal'], 'the paper stays liked, so the removal is reported');
});

// Like FeedContext: `isOn` reads a ref React updates only after it has drawn
// the state, so two answers in one tick both find the old value.
function likedPaperBehindRender() {
  const changes = markChanges();
  const drawn = { liked: true };
  const ref = { liked: true };
  const profile: string[] = [];
  const answers: Array<() => void> = [];
  const press = (options: { afterWrite?: boolean; throwOnError?: boolean } = {}) => {
    const wasLiked = markStartsOn(options, ref.liked);
    const showLiked = (liked: boolean) => {
      drawn.liked = liked;
      profile.push(liked ? 'like' : 'unlike');
    };
    return writeMark({
      show: () => showLiked(!wasLiked),
      undo: () => showLiked(wasLiked),
      write: () => new Promise<void>((accept) => { answers.push(accept); }),
      failure: 'refused',
      ...options,
      stillSignedIn: () => true,
      changes,
      markKey: 'u1:like:p1',
      from: wasLiked,
      to: !wasLiked,
      isOn: () => ref.liked,
    });
  };
  return { drawn, profile, answers, press };
}

test('a Favorites removal asked for again from a reopened Lists page is sent and counted once', async () => {
  const paper = likedPaperBehindRender();
  const first = paper.press(removal);
  // Lists, left and opened again, shows the row with its Remove.
  const second = paper.press(removal);
  assert.equal(paper.answers.length, 1, 'one write, so one like_change event');
  paper.answers.forEach((accept) => accept());
  await Promise.all([first, second]);
  assert.equal(paper.drawn.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});

test('a Remove pressed again after the card changed the like meanwhile is still sent', async () => {
  const paper = likedPaper();
  const first = paper.press(removal);
  // The card's heart takes the like off and puts it back.
  const unliked = paper.press(cardHeart);
  const liked = paper.press(cardHeart);
  const second = paper.press(removal);
  assert.equal(paper.answers.length, 4, 'the like on screen came after the first removal was sent');
  paper.acceptAll();
  await Promise.all([first, unliked, liked, second]);
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike', 'like', 'unlike']);
});

// A paper in Read later, changed the way FeedContext's toggleReadLater changes
// it: each change stamps the entry with its own edit time, and a refusal the
// caller asked about restores the entry with restoreReadLater.
function readLaterPaper() {
  const changes = markChanges();
  type Entry = { paperId: string; paper: { title: string; primaryTopic?: string }; readLater?: boolean; note?: string; updatedAt?: string };
  const state = { library: { p1: { paperId: 'p1', paper: { title: 'One' }, readLater: true, updatedAt: 'T0' } } as Record<string, Entry> };
  const answers: Array<{ accept: () => void; refuse: () => void }> = [];
  const reported: string[] = [];
  let clock = 0;
  const toggle = (value: boolean | undefined, options: { afterWrite?: boolean; throwOnError: boolean }) => {
    const previous = state.library.p1;
    const nextValue = value ?? !previous?.readLater;
    clock += 1;
    const updatedAt = `T${clock}`;
    const storedPaper = { title: 'One' };
    return writeMark({
      show: () => {
        const stamp = readLaterStamp(state.library.p1, previous, { paper: storedPaper, updatedAt }, { late: Boolean(options.afterWrite) });
        state.library = { ...state.library, p1: { ...state.library.p1, ...stamp, readLater: nextValue } };
      },
      undo: () => {
        state.library = restoreReadLater(state.library, 'p1', previous, { paper: storedPaper, updatedAt });
      },
      write: () => new Promise<void>((accept, refuse) => {
        answers.push({ accept, refuse: () => refuse(new Error('permission-denied')) });
      }),
      failure: 'refused',
      ...options,
      stillSignedIn: () => true,
      changes,
      markKey: 'u1:readLater:p1',
      from: markStartsOn(options, Boolean(previous?.readLater)),
      to: nextValue,
      isOn: () => Boolean(state.library.p1?.readLater),
    }).catch(() => { reported.push(options.afterWrite ? 'removal' : 'save'); });
  };
  return { state, answers, reported, toggle };
}

const readLaterRemoval = { afterWrite: true, throwOnError: true };
const saveButton = { throwOnError: true };

test('an accepted Read later removal stays when a Save tap sent meanwhile is refused', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  const tapped = paper.toggle(false, saveButton);
  paper.answers[0].accept();
  await removed;
  paper.answers[1].refuse();
  await silenced(() => tapped);
  assert.equal(paper.state.library.p1.readLater, false, 'Firestore holds the removal');
  assert.deepEqual(paper.reported, [], 'the paper is out of Read later, as the tap asked');
});

test('an accepted Read later removal keeps the topic and the note\'s edit time written while it waited', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  // keepLateTopics completes the copy, then a note is saved from the row's Edit.
  const { p1 } = paper.state.library;
  paper.state.library = { p1: { ...p1, paper: { ...p1.paper, primaryTopic: 'Galaxies' } } };
  paper.state.library = { p1: { ...paper.state.library.p1, note: 'read the appendix', updatedAt: 'T9' } };
  paper.answers[0].accept();
  await removed;
  assert.equal(paper.state.library.p1.readLater, false);
  assert.equal(paper.state.library.p1.paper.primaryTopic, 'Galaxies');
  assert.equal(paper.state.library.p1.updatedAt, 'T9');
  assert.equal(paper.state.library.p1.note, 'read the appendix');
});

test('an accepted Read later removal stamps its edit time when only the paper copy changed while it waited', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  const { p1 } = paper.state.library;
  paper.state.library = { p1: { ...p1, paper: { ...p1.paper, primaryTopic: 'Galaxies' } } };
  paper.answers[0].accept();
  await removed;
  assert.equal(paper.state.library.p1.paper.primaryTopic, 'Galaxies');
  assert.equal(paper.state.library.p1.updatedAt, 'T1');
});

test('a Save tap refused before the Read later removal is accepted ends with the paper out of Read later', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  const tapped = paper.toggle(false, saveButton);
  paper.answers[1].refuse();
  await silenced(() => tapped);
  assert.equal(paper.state.library.p1.readLater, true, 'nothing else has been accepted yet');
  paper.answers[0].accept();
  await removed;
  assert.equal(paper.state.library.p1.readLater, false);
});

test('an accepted Read later removal stays when the second of two later changes is refused', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  const off = paper.toggle(false, saveButton);
  const on = paper.toggle(true, saveButton);
  paper.answers[0].accept();
  paper.answers[1].accept();
  await Promise.all([removed, off]);
  paper.answers[2].refuse();
  await silenced(() => on);
  assert.equal(paper.state.library.p1.readLater, false);
});

test('a refused Read later removal leaves the newer accepted change on screen', async () => {
  const paper = readLaterPaper();
  const removed = paper.toggle(false, readLaterRemoval);
  const off = paper.toggle(false, saveButton);
  const on = paper.toggle(true, saveButton);
  paper.answers[0].refuse();
  await silenced(() => removed);
  paper.answers[1].accept();
  paper.answers[2].accept();
  await Promise.all([off, on]);
  assert.equal(paper.state.library.p1.readLater, true);
  assert.equal(paper.state.library.p1.updatedAt, 'T3', 'stamped by the last change');
});

test('a like accepted before React draws it is shown once', async () => {
  // A guest's like writes nothing, so it is accepted at once, while the
  // screen FeedContext reads still holds the value from before the press.
  let shows = 0;
  await writeMark({
    show: () => { shows += 1; },
    write: async () => {},
    failure: 'refused',
    stillSignedIn: () => true,
    changes: markChanges(),
    markKey: ':like:p1',
    from: false,
    to: true,
    isOn: () => false,
  });
  assert.equal(shows, 1);
});

test('a feed toggle without an undo keeps what it showed after a refusal', async () => {
  const changes = markChanges();
  const screen = { read: true };
  await silenced(() => writeMark({
    show: () => { screen.read = false; },
    failure: 'refused',
    stillSignedIn: () => true,
    changes,
    markKey: 'u1:read:p1',
    from: true,
    to: false,
    isOn: () => screen.read,
    write: () => Promise.reject(new Error('permission-denied')),
  }));
  assert.equal(screen.read, false);
});
