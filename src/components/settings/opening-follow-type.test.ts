import test from 'node:test';
import assert from 'node:assert/strict';
import { openingFollowType } from './opening-follow-type.ts';

const TYPES = ['author', 'topic', 'institution', 'project', 'journal'];
const follows = { author: [{}], journal: Array.from({ length: 10 }, () => ({})) };

// ENG-123: the Explorer's journal-limit toast opens the follows settings to
// unfollow a journal. Most readers who reach the limit follow authors too,
// whose tab comes first, so the toast asks for the Journals tab.
test('the follows settings open on the tab a link asks for', () => {
  assert.equal(openingFollowType(TYPES, 'journal', follows), 'journal');
  assert.equal(openingFollowType(TYPES, 'project', follows), 'project', 'even one the reader follows nothing in');
});

test('without a known tab asked for, the follows settings open on the first tab with follows', () => {
  assert.equal(openingFollowType(TYPES, undefined, follows), 'author');
  assert.equal(openingFollowType(TYPES, 'venue', { journal: [{}] }), 'journal');
  assert.equal(openingFollowType(TYPES, null, {}), 'author');
});
