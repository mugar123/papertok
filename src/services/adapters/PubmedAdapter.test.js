import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter } from './PubmedAdapter.js';
import { PaperBuilder } from '../PaperBuilder.js';
import { reviewStatusForPaper } from '../../utils/paperStatus.js';

const adapter = new PubmedAdapter();

test('a Journal Article from esummary is typed as an article with unknown citations', () => {
  // esummary carries `pubtype` and no citation data at all. The adapter read
  // neither: it hard-coded `citationsCount: 0` — which `PaperBuilder` reads as a
  // CONFIRMED zero — and left the type empty, which the builder defaulted to
  // `preprint`. Every peer-reviewed article in the feed arrived as a preprint
  // with zero citations.
  const paper = PaperBuilder.create(adapter.mapToStandard({
    uid: '1', title: 'T', pubtype: ['Journal Article'], pubdate: '2024 Jan', source: 'J',
  }));

  assert.equal(paper.publicationType, 'article');
  assert.equal(paper.citationCountKnown, false);
  assert.equal(reviewStatusForPaper(paper), 'verified');
});

test('a PubMed preprint stays a preprint', () => {
  assert.equal(adapter.mapToStandard({ uid: '2', title: 'T', pubtype: ['Preprint'] }).publicationType, 'preprint');
});

test('a pubtype nobody recognises leaves the type unknown rather than guessing preprint', () => {
  const raw = adapter.mapToStandard({ uid: '3', title: 'T', pubtype: ['Historical Article'], source: 'J' });
  assert.equal(raw.publicationType, undefined);
  assert.equal(PaperBuilder.create(raw).publicationType, undefined);
});

test('arXiv keeps the preprint default the builder used to hand everyone', () => {
  // arXiv is the one source whose silence really does mean preprint.
  const paper = PaperBuilder.create({ id: 'arxiv:1', sources: { primary: 'arxiv', enrichedBy: [] } });
  assert.equal(paper.publicationType, 'preprint');
});
