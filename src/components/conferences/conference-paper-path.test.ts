import assert from 'node:assert/strict';
import test from 'node:test';
import { conferencePaperPath } from './conference-paper-path.ts';

test('the paper title leads to the public page for its OpenReview forum', () => {
  assert.equal(conferencePaperPath({ openReviewId: '5pShDP8LSm' }), '/paper/b3BlbnJldmlldzo1cFNoRFA4TFNt');
  assert.equal(conferencePaperPath({ openReviewId: '../venue' }), null);
  assert.equal(conferencePaperPath({}), null);
});
