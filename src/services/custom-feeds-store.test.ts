import test from 'node:test';
import assert from 'node:assert/strict';
import { terminate } from 'firebase/firestore';
import { db } from './firebase.ts';
import { changeCustomFeeds, createAnswerTracker, newFeedId, type TransactFeeds } from './custom-feeds-store.ts';
import { CustomFeedError, MAX_ACCOUNT_KEYWORDS, MAX_CUSTOM_FEEDS, withFeedAdded, withFeedChanged, type CustomFeed } from '../utils/custom-feeds.ts';

// The store imports the app's Firestore client; these tests never reach it
// (every write goes through the injected `transact`), but it must be closed.
test.after(() => terminate(db));

/** A stand-in for the transaction: `apply` reads what is stored and its result becomes what is stored. */
function storeHolding(initial: unknown) {
  const held = { stored: initial, writes: 0 };
  const transact: TransactFeeds = async (apply) => {
    const next = apply(held.stored);
    held.stored = next;
    held.writes += 1;
    return next;
  };
  return { held, transact };
}

test('a change is applied to the stored list, not to the list the page held', async () => {
  const { transact } = storeHolding([{ id: 'abcd1234', name: 'From another device', order: 'newest', ingredients: [{ kind: 'category', id: 'quant-ph' }] }]);
  const feeds = await changeCustomFeeds('uid-1', current => withFeedAdded(current, { name: 'Thesis', order: 'best', ingredients: [{ kind: 'category', id: 'cs.LG' }] }, 'wxyz9876'), { transact });
  assert.deepEqual(feeds.map(feed => feed.name), ['From another device', 'Thesis']);
});

test('a write that does not settle is a failure the form can show', async () => {
  const never: TransactFeeds = () => new Promise(() => {});
  await assert.rejects(changeCustomFeeds('uid-1', feeds => feeds, { transact: never, timeoutMs: 20 }));
});

test('the change sees the stored list as the app shows it, with malformed feeds left out', async () => {
  const { transact } = storeHolding([
    { id: 'abcd1234', name: 'Kept', order: 'newest', ingredients: [] },
    { id: 'BAD ID', name: 'Dropped', order: 'newest', ingredients: [] },
  ]);
  let seen: CustomFeed[] = [];
  await changeCustomFeeds('uid-1', (current) => { seen = current; return current; }, { transact });
  assert.deepEqual(seen.map(feed => feed.id), ['abcd1234']);
});

test('a ninth feed is refused with the change\'s own error and nothing is written', async () => {
  const eight = Array.from({ length: MAX_CUSTOM_FEEDS }, (_, index) => ({ id: `feed000${index}`, name: `Feed ${index}`, order: 'newest', ingredients: [] }));
  const { held, transact } = storeHolding(eight);
  await assert.rejects(
    changeCustomFeeds('uid-1', current => withFeedAdded(current, { name: 'Ninth', order: 'best', ingredients: [] }, 'ninth0000'), { transact }),
    (error: unknown) => error instanceof CustomFeedError && error.code === 'feed-limit',
  );
  assert.equal(held.stored, eight);
  assert.equal(held.writes, 0);
});

test('a feed the model would not read back is refused before anything is written', async () => {
  const { held, transact } = storeHolding([]);
  await assert.rejects(
    changeCustomFeeds('uid-1', current => withFeedAdded(current, { name: '   ', order: 'best', ingredients: [] }, 'blank0000'), { transact }),
    (error: unknown) => error instanceof CustomFeedError && error.code === 'invalid',
  );
  assert.equal(held.writes, 0);
});

test('a change past the account\'s keyword ceiling is refused, not written trimmed', async () => {
  const keywords = Array.from({ length: MAX_ACCOUNT_KEYWORDS }, (_, index) => ({ kind: 'keyword', query: `keyword ${index}` }));
  const stored = [
    { id: 'abcd1234', name: 'Full of keywords', order: 'newest', ingredients: keywords },
    { id: 'efgh5678', name: 'Other', order: 'best', ingredients: [{ kind: 'category', id: 'cs.LG' }] },
  ];
  const { held, transact } = storeHolding(stored);
  await assert.rejects(
    changeCustomFeeds('uid-1', current => withFeedChanged(current, 'efgh5678', {
      name: 'Other',
      order: 'best',
      ingredients: [{ kind: 'category', id: 'cs.LG' }, { kind: 'keyword', query: 'one too many' }],
    }), { transact }),
    (error: unknown) => error instanceof CustomFeedError && error.code === 'invalid',
  );
  assert.equal(held.stored, stored);
  assert.equal(held.writes, 0);
});

test('an ingredient written with its keys in another order is the same ingredient', async () => {
  const { held, transact } = storeHolding([]);
  await changeCustomFeeds('uid-1', current => withFeedAdded(current, { name: 'Authors', order: 'best', ingredients: [{ label: 'Ada Lovelace', id: 'A1', kind: 'author' }] }, 'wxyz9876'), { transact });
  assert.equal(held.writes, 1);
});

test('a write\'s own list stands only while the listener has not answered since it began', () => {
  const tracker = createAnswerTracker();
  tracker.answered();
  const quiet = tracker.beginWrite();
  assert.equal(quiet(), true);
  const overtaken = tracker.beginWrite();
  tracker.answered();
  assert.equal(overtaken(), false);
  assert.equal(quiet(), false);
});

test('a refused write reaches the caller unchanged', async () => {
  const refusal = new Error('permission-denied');
  const refused: TransactFeeds = () => Promise.reject(refusal);
  await assert.rejects(changeCustomFeeds('uid-1', feeds => feeds, { transact: refused }), error => error === refusal);
});

test('a new feed id is twelve lowercase letters and digits', () => {
  assert.match(newFeedId(), /^[a-z0-9]{12}$/);
  assert.notEqual(newFeedId(), newFeedId());
  assert.equal(newFeedId(() => 0), 'aaaaaaaaaaaa');
  assert.equal(newFeedId(() => 0.999999), '999999999999');
});
