import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { missingAbstractNotice } from './missing-abstract.ts';

// Synthetic records shaped like the corpus rows that reach the empty state:
// a journal article OpenAlex listed without an abstract.
const withoutAbstract = (fields: Partial<Paper> = {}): Partial<Paper> => ({ abstract: 'No abstract available.', ...fields });

test('a paper with a DOI gets a control for the publisher page, through doi.org', () => {
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: '10.1016/j.synthetic.2026.101234' })), {
    title: 'No abstract to show',
    body: "PaperTok found none in open sources. Try the publisher's page.",
    publisher: { label: "Publisher's page", short: 'Publisher', url: 'https://doi.org/10.1016/j.synthetic.2026.101234' },
  });
  // OpenAlex writes the DOI as a resolver URL; the link is the same.
  assert.equal(
    missingAbstractNotice(withoutAbstract({ doi: 'https://doi.org/10.1007/s00000-026-0001-x' })).publisher?.url,
    'https://doi.org/10.1007/s00000-026-0001-x',
  );
});

test('the sentence names the control, and the phone shows a word of its name', () => {
  const { body, publisher } = missingAbstractNotice(withoutAbstract({ doi: '10.1016/j.synthetic.2026.101234' }));
  assert.ok(publisher);
  // The sentence is plain text in the panel and the control is in the action
  // row: the reader finds the control by the words the sentence uses.
  assert.ok(body.toLowerCase().includes(publisher.label.toLowerCase()), `"${body}" names "${publisher.label}"`);
  // The control's accessible name starts with the full label, so the word a
  // phone shows has to be the start of the full one (WCAG 2.5.3).
  assert.ok(publisher.label.startsWith(publisher.short), `"${publisher.label}" starts with "${publisher.short}"`);
});

test('a paper without a usable DOI gets words that point at no control', () => {
  const noLink = { title: 'No abstract to show', body: 'PaperTok found none in open sources.', publisher: null };
  assert.deepEqual(missingAbstractNotice(withoutAbstract()), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: null })), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ doi: 'not a doi' })), noLink);
  // A landing page is not taken for the publisher's: for these records it is
  // an index's own page.
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ landingPageUrl: 'https://openalex.org/W4400000001' })), noLink);
  assert.deepEqual(missingAbstractNotice(withoutAbstract({ landingPageUrl: 'https://pubmed.ncbi.nlm.nih.gov/39000001/' })), noLink);
});
