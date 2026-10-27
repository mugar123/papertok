import test from 'node:test';
import assert from 'node:assert/strict';
import { markChanges, writeMark } from './write-mark.ts';

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
  };
}

const newest = () => true;

test('a refused unlike shows the like again, and the caller that asked hears of it', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await silenced(() => assert.rejects(writeMark({
    show, undo, failure: 'refused', throwOnError: true, stillSignedIn: () => true, stillNewest: newest,
    write: () => Promise.reject(new Error('permission-denied')),
  }), /permission-denied/));
  assert.equal(screen.liked, true);
});

test('a refusal that lands after the account changed puts nothing back on the new account', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await silenced(() => writeMark({
    show, undo, failure: 'refused', stillSignedIn: () => false, stillNewest: newest,
    write: () => Promise.reject(new Error('permission-denied')),
  }));
  assert.equal(screen.liked, false);
});

test('with afterWrite an accepted change shows once the write is in, and only for the same account', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await writeMark({ show, undo, failure: 'refused', afterWrite: true, stillSignedIn: () => false, stillNewest: newest, write: async () => {} });
  assert.equal(screen.liked, true, 'nothing painted over another account');
  await writeMark({ show, undo, failure: 'refused', afterWrite: true, stillSignedIn: () => true, stillNewest: newest, write: async () => {} });
  assert.equal(screen.liked, false);
});

// A liked paper's heart the way FeedContext toggles it: each press numbers its
// change, flips the like the screen shows and tells the reading profile. The
// test answers the writes, in the order they were sent, as Firestore does.
function likedPaper() {
  const startChange = markChanges();
  const screen = { liked: true };
  const profile: string[] = [];
  const answers: Array<() => void> = [];
  const press = (options: { afterWrite?: boolean } = {}) => {
    const wasLiked = screen.liked;
    const showLiked = (liked: boolean) => {
      screen.liked = liked;
      profile.push(liked ? 'like' : 'unlike');
    };
    return writeMark({
      show: () => showLiked(!wasLiked),
      undo: () => showLiked(wasLiked),
      write: () => new Promise<void>((accept) => { answers.push(accept); }),
      failure: 'refused',
      ...options,
      stillSignedIn: () => true,
      stillNewest: startChange('like:p1'),
    });
  };
  const acceptAll = () => answers.forEach((accept) => accept());
  return { startChange, screen, profile, press, acceptAll };
}

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
  paper.startChange('read:p1');
  paper.startChange('like:p2');
  paper.acceptAll();
  await removal;
  assert.equal(paper.screen.liked, false);
  assert.deepEqual(paper.profile, ['unlike']);
});
