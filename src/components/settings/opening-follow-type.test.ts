import test from 'node:test';
import assert from 'node:assert/strict';
import { openingFollowType } from './opening-follow-type.ts';

const TYPES = ['author', 'topic', 'institution', 'project'];

test('the follows settings open on the first tab with follows', () => {
  assert.equal(openingFollowType(TYPES, { institution: [{}], project: [{}] }), 'institution');
  assert.equal(openingFollowType(TYPES, { author: [], topic: [{}] }), 'topic');
});

test('with nothing followed, the follows settings open on the first tab', () => {
  assert.equal(openingFollowType(TYPES, {}), 'author');
});
