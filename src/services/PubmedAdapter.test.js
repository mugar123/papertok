import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter, classifyPubmedCategory } from './adapters/PubmedAdapter.js';

test('classifies PubMed papers using title, abstract, and MeSH-style subjects', () => {
  const category = classifyPubmedCategory({
    title: 'Cardiac arrhythmia after myocardial infarction',
    abstract: 'A clinical study of cardiovascular outcomes.',
    categories: ['Heart Diseases', 'Cardiology'],
  }, ['med.onco', 'med.cardio', 'med.neuro']);

  assert.equal(category, 'med.cardio');
});

test('does not invent a random PubMed category for ambiguous papers', () => {
  const category = classifyPubmedCategory({
    title: 'A multicenter observational study',
    abstract: 'Results from several participating institutions.',
    categories: [],
  }, ['med.onco', 'med.cardio']);

  assert.equal(category, null);
});

test('trusts the query category when PubMed was searched for one subcategory', () => {
  const category = classifyPubmedCategory({ title: 'Sparse metadata record' }, ['bio.micro']);
  assert.equal(category, 'bio.micro');
});

test('maps PubMed access using the canonical openAccess field', () => {
  const adapter = new PubmedAdapter();
  const closedPaper = adapter.mapToStandard({ uid: '1', title: 'Closed', articleids: [] });
  const pmcPaper = adapter.mapToStandard({
    uid: '2',
    title: 'Open',
    articleids: [{ idtype: 'pmc', value: 'PMC2' }],
  });

  assert.equal(closedPaper.openAccess, false);
  assert.equal(pmcPaper.openAccess, true);
  assert.equal(closedPaper.isOpenAccess, undefined);
});
