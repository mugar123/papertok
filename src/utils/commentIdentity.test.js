import test from 'node:test';
import assert from 'node:assert/strict';
import { commentIsDissociated, DISSOCIATED_COMMENT_FIELDS } from './commentIdentity.js';

test('a dissociated comment is the explicit flag, not an empty handle alone', () => {
  assert.equal(commentIsDissociated({ ...DISSOCIATED_COMMENT_FIELDS, text: 'Hi' }), true);
  assert.equal(commentIsDissociated({ authorUid: '', authorHandle: '', text: 'Hi' }), false);
  assert.equal(commentIsDissociated({ authorUid: 'u1', authorHandle: 'ada', text: 'Hi' }), false);
});
