import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenReviewNote } from './open-review-service.ts';

test('maps an accepted OpenReview submission as a reviewed conference paper', () => {
  const paper = mapOpenReviewNote({
    id: 'note-1',
    forum: 'forum-1',
    domain: 'ICLR.cc/2026/Conference',
    pdate: Date.parse('2026-04-01T00:00:00Z'),
    content: {
      title: { value: 'A reviewed learning result' },
      abstract: { value: 'A useful abstract.' },
      authors: { value: ['Ada Researcher', 'Grace Scientist'] },
      venue: { value: 'ICLR 2026 Oral' },
      venueid: { value: 'ICLR.cc/2026/Conference' },
      pdf: { value: '/pdf?id=forum-1' },
      keywords: { value: ['representation learning'] },
    },
  }, ['cs.LG']);

  assert.equal(paper!.sources.primary, 'openreview');
  assert.equal(paper!.id, 'openreview:forum-1');
  // OpenReview gives keywords, not a category; cs.LG is what was searched.
  assert.equal(paper!.primaryCategory, '');
  assert.deepEqual(paper!._fetchedFor, ['cs.LG']);
  assert.equal(paper!.publicationStatus, 'published');
  assert.equal(paper!.publicationType, 'conference');
  assert.equal(paper!.peerReviewed, true);
  assert.match(paper!.pdfUrl!, /openreview\.net\/pdf/);
  assert.match(paper!.landingPageUrl!, /forum\?id=forum-1/);
});

test('does not present a submitted OpenReview manuscript as peer reviewed', () => {
  const paper = mapOpenReviewNote({
    id: 'note-2',
    forum: 'forum-2',
    domain: 'ICLR.cc/2027/Conference/Submission1',
    content: {
      title: { value: 'A pending result' },
      abstract: { value: 'Under review.' },
      authors: { value: ['Ada Researcher'] },
      venue: { value: 'Submitted to ICLR 2027' },
    },
  }, ['cs.AI']);

  assert.equal(paper!.publicationStatus, 'preprint');
  assert.equal(paper!.publicationType, 'preprint');
  assert.equal(paper!.peerReviewed, false);
});

test('an OpenReview note without a timestamp has no year', () => {
  const content = { title: { value: 'An undated note' }, abstract: { value: 'No date.' }, authors: { value: ['Ada Researcher'] } };
  const undated = mapOpenReviewNote({ id: 'note-3', forum: 'forum-3', content });
  assert.equal(undated!.year, undefined);
  assert.equal(undated!.published, '');

  const dated = mapOpenReviewNote({ id: 'note-4', forum: 'forum-4', cdate: Date.parse('2025-02-03T00:00:00Z'), content });
  assert.equal(dated!.year, 2025);
});
