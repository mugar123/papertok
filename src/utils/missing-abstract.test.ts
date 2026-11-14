import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { missingAbstractNotice } from './missing-abstract.ts';

// Synthetic records shaped like the corpus rows that reach the empty state:
// a journal article OpenAlex listed without an abstract.
const withoutAbstract = (fields: Partial<Paper> = {}): Partial<Paper> => ({ abstract: 'No abstract available.', ...fields });
const explanation = 'The open sources PaperTok reads had none.';

test('a paper with a DOI links the publisher page through doi.org', () => {
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: '10.1016/j.synthetic.2026.101234' })), {
    title: 'No abstract to show',
    body: explanation,
    publisherUrl: 'https://doi.org/10.1016/j.synthetic.2026.101234',
  });
  // OpenAlex writes the DOI as a resolver URL; the link is the same.
  assert.equal(
    missingAbstractNotice(withoutAbstract({ doi: 'https://doi.org/10.1007/s00000-026-0001-x' })).publisherUrl,
    'https://doi.org/10.1007/s00000-026-0001-x',
  );
});

test('a paper without a usable DOI gets the same words and no link', () => {
  const noLink = { title: 'No abstract to show', body: explanation, publisherUrl: null };
  assert.deepEqual(missingAbstractNotice(withoutAbstract()), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: null })), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: 'not a doi' })), noLink);
  // A landing page is not taken for the publisher's: for these records it is
  // an index's own page.
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ landingPageUrl: 'https://openalex.org/W4400000001' })), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ landingPageUrl: 'https://pubmed.ncbi.nlm.nih.gov/39000001/' })), noLink);
});
