import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenReviewNote } from './openReviewService.ts';

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
  assert.equal(paper!.primaryCategory, 'cs.LG');
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
