import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteFeedTitle, feedMovedAnnouncement, feedTabMoves, holdOutcome, tabAfterDelete } from './feed-tab-menu.ts';

const feeds = [
  { id: 'aaaaaaaa', name: 'Physics' },
  { id: 'bbbbbbbb', name: 'Oceans' },
  { id: 'cccccccc', name: 'Robots' },
];

test('the first feed cannot move left and the last cannot move right', () => {
  assert.deepEqual(feedTabMoves(feeds, 'aaaaaaaa'), { left: false, right: true });
  assert.deepEqual(feedTabMoves(feeds, 'bbbbbbbb'), { left: true, right: true });
  assert.deepEqual(feedTabMoves(feeds, 'cccccccc'), { left: true, right: false });
});

test('a lone feed and a feed that is gone offer no move', () => {
  assert.deepEqual(feedTabMoves([feeds[0]], 'aaaaaaaa'), { left: false, right: false });
  assert.deepEqual(feedTabMoves(feeds, 'zzzzzzzz'), { left: false, right: false });
});

test('a move is announced with the position the feed moves to', () => {
  assert.equal(feedMovedAnnouncement(feeds, 'bbbbbbbb', -1), 'Moved Oceans to position 1 of 3.');
  assert.equal(feedMovedAnnouncement(feeds, 'bbbbbbbb', 1), 'Moved Oceans to position 3 of 3.');
});

test('a move past an end, or of a feed that is gone, says nothing', () => {
  assert.equal(feedMovedAnnouncement(feeds, 'aaaaaaaa', -1), '');
  assert.equal(feedMovedAnnouncement(feeds, 'cccccccc', 1), '');
  assert.equal(feedMovedAnnouncement(feeds, 'zzzzzzzz', 1), '');
});

test('focus after a delete goes to the feed tab that takes its place, else the tab before, else For you', () => {
  const tabs = ['home', 'following', 'feed:aaaaaaaa', 'feed:bbbbbbbb', 'feed:cccccccc'];
  assert.equal(tabAfterDelete(tabs, 'feed:bbbbbbbb'), 'feed:cccccccc');
  assert.equal(tabAfterDelete(tabs, 'feed:cccccccc'), 'feed:bbbbbbbb', 'the last feed hands over to the one before');
  assert.equal(tabAfterDelete(['home', 'following', 'feed:aaaaaaaa'], 'feed:aaaaaaaa'), 'following', 'a lone feed hands over to Following');
  assert.equal(tabAfterDelete(tabs, 'feed:zzzzzzzz'), 'home', 'a tab already gone hands over to For you');
});

test('a menu opening on a tab a finger is pressing ends the press, whatever event opened it', () => {
  assert.equal(holdOutcome('feed:aaaaaaaa', 'feed:aaaaaaaa', () => true), 'held');
  assert.equal(holdOutcome('feed:aaaaaaaa', 'feed:aaaaaaaa', () => false), 'refused', 'the line moved under the finger');
});

test('a menu opening with no touch pressing that tab is a mouse or the keyboard', () => {
  let asked = false;
  assert.equal(holdOutcome(null, 'feed:aaaaaaaa', () => { asked = true; return false; }), 'none');
  assert.equal(holdOutcome('feed:bbbbbbbb', 'feed:aaaaaaaa', () => false), 'none');
  assert.equal(asked, false, 'the line is not asked about when no finger pressed this tab');
});

test('the confirmation names the feed inside quotes, isolated from the sentence', () => {
  assert.equal(deleteFeedTitle('Physics'), 'Delete “\u2068Physics\u2069”?');
  assert.equal(deleteFeedTitle('Physics').replace(/[\u2068\u2069]/g, ''), 'Delete “Physics”?');
});
