import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listNeedsPublicSync,
  publicListSyncKey,
  toEpochMillis,
} from './publicListFreshness.js';

const SHARE_ID = '07070707070707070707070707070707';

/** What a Firestore `Timestamp` looks like to code that only reads it. */
function timestamp(millis) {
  return {
    seconds: Math.floor(millis / 1000),
    nanoseconds: (millis % 1000) * 1e6,
    toMillis: () => millis,
  };
}

test('the three shapes a stamp arrives in all compare on the same scale', () => {
  assert.equal(toEpochMillis(timestamp(1_700_000_000_000)), 1_700_000_000_000);
  assert.equal(toEpochMillis(new Date(1_700_000_000_000)), 1_700_000_000_000);
  assert.equal(toEpochMillis('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
  assert.equal(toEpochMillis(1_700_000_000_000), 1_700_000_000_000);
  // A server-side timestamp read back before the server resolved it.
  assert.equal(toEpochMillis({ seconds: 1_700_000_000, nanoseconds: 0 }), 1_700_000_000_000);
});

test('an unreadable stamp counts as zero, never as the future', () => {
  // Reading it as "later than everything" would mute the very indicator this
  // exists to raise, and the list would never be reconciled.
  assert.equal(toEpochMillis(null), 0);
  assert.equal(toEpochMillis(undefined), 0);
  assert.equal(toEpochMillis(''), 0);
  assert.equal(toEpochMillis('not a date'), 0);
  assert.equal(toEpochMillis(Number.NaN), 0);
  assert.equal(toEpochMillis(new Date('nope')), 0);
  assert.equal(toEpochMillis({ toMillis() { throw new Error('detached'); } }), 0);
});

test('an edit newer than the last sync is what "stale" means', () => {
  assert.equal(listNeedsPublicSync({
    publicShareId: SHARE_ID,
    updatedAt: timestamp(2_000),
    publicSyncedAt: timestamp(1_000),
  }), true);
});

test('a list synced after its last edit is not stale', () => {
  assert.equal(listNeedsPublicSync({
    publicShareId: SHARE_ID,
    updatedAt: timestamp(1_000),
    publicSyncedAt: timestamp(2_000),
  }), false);
  assert.equal(listNeedsPublicSync({
    publicShareId: SHARE_ID,
    updatedAt: timestamp(1_000),
    publicSyncedAt: timestamp(1_000),
  }), false);
});

test('an edit with no sync behind it at all is stale', () => {
  // Published before P25 and edited after: no `publicSyncedAt` to compare
  // against, and the public copy really is behind.
  assert.equal(listNeedsPublicSync({
    publicShareId: SHARE_ID,
    updatedAt: timestamp(1_000),
  }), true);
});

test('a list nobody has edited is left alone', () => {
  // The opposite trap: treating a missing `updatedAt` as "unknown, so sync"
  // would re-publish every list in the account the first time it is opened,
  // spending the daily quota on nothing.
  assert.equal(listNeedsPublicSync({
    publicShareId: SHARE_ID,
    publicSyncedAt: timestamp(1_000),
  }), false);
  assert.equal(listNeedsPublicSync({ publicShareId: SHARE_ID }), false);
});

test('a private list has no public copy to be behind', () => {
  assert.equal(listNeedsPublicSync({ updatedAt: timestamp(9_000) }), false);
  assert.equal(listNeedsPublicSync(null), false);
  assert.equal(listNeedsPublicSync(undefined), false);
});

test('the queue key is scoped to the account, not just the list', () => {
  // The engine outlives a sign-out; two accounts on one device must not
  // coalesce onto one job and publish each other's edits.
  assert.notEqual(publicListSyncKey('uid-a', 'list_1'), publicListSyncKey('uid-b', 'list_1'));
  assert.equal(publicListSyncKey('uid-a', 'list_1'), 'uid-a:list_1');
});
