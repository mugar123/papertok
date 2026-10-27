import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMark } from './write-mark.ts';

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

test('a refused unlike shows the like again, and the caller that asked hears of it', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await silenced(() => assert.rejects(writeMark({
    show, undo, failure: 'refused', throwOnError: true, stillSignedIn: () => true,
    write: () => Promise.reject(new Error('permission-denied')),
  }), /permission-denied/));
  assert.equal(screen.liked, true);
});

test('a refusal that lands after the account changed puts nothing back on the new account', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await silenced(() => writeMark({
    show, undo, failure: 'refused', stillSignedIn: () => false,
    write: () => Promise.reject(new Error('permission-denied')),
  }));
  assert.equal(screen.liked, false);
});

test('with afterWrite an accepted change shows once the write is in, and only for the same account', async () => {
  const { screen, show, undo } = likeOnScreen(true);
  await writeMark({ show, undo, failure: 'refused', afterWrite: true, stillSignedIn: () => false, write: async () => {} });
  assert.equal(screen.liked, true, 'nothing painted over another account');
  await writeMark({ show, undo, failure: 'refused', afterWrite: true, stillSignedIn: () => true, write: async () => {} });
  assert.equal(screen.liked, false);
});
