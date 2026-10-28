import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceAttribution } from './source-attribution.ts';

const SEMANTIC_SCHOLAR_HOME = 'https://www.semanticscholar.org/?utm_source=api';

test('a record from Semantic Scholar links to its own page there', () => {
  const paper = {
    id: 'arxiv:2401.00003',
    semanticScholarId: '649def34f8be52c8b66281af98ae884c09aef38b',
    sources: { primary: 'semanticscholar', enrichedBy: [] },
  };
  assert.deepEqual(sourceAttribution(paper), {
    label: 'From',
    name: 'Semantic Scholar',
    href: 'https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b?utm_source=api',
  });
});

test('data merged in from Semantic Scholar without an id links to its home page', () => {
  const paper = { id: 'arxiv:2401.00001', sources: { primary: 'arxiv', enrichedBy: ['openalex', 'semanticscholar'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'With data from', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});

test('a Semantic Scholar record it also enriched is credited as the record', () => {
  const paper = { sources: { primary: 'semanticscholar', enrichedBy: ['semanticscholar'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'From', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});

test('a paper with no Semantic Scholar data and no recovered abstract has no attribution', () => {
  assert.equal(sourceAttribution({ sources: { primary: 'openalex', enrichedBy: ['crossref'] } }), null);
  assert.equal(sourceAttribution({ id: 'stored-copy' }), null);
});

test('no paper has no attribution', () => {
  assert.equal(sourceAttribution(null), null);
  assert.equal(sourceAttribution(undefined), null);
});

test('a record under the legacy hyphenated source name is still a Semantic Scholar record', () => {
  const paper = { id: 'arxiv:2401.00002', sources: { primary: 'semantic-scholar', enrichedBy: [] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'From', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});

test('a Semantic Scholar record filed under its own hash links to its page there', () => {
  const paper = { id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776', sources: { primary: 'semanticscholar', enrichedBy: [] } };
  assert.deepEqual(sourceAttribution(paper), {
    label: 'From',
    name: 'Semantic Scholar',
    href: 'https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776?utm_source=api',
  });
});

test('an enriched paper whose own id looks like a hash still links to the home page', () => {
  const paper = { id: '204e3073870fae3d05bcbc2f6a8e263d9b72e776', sources: { primary: 'openalex', enrichedBy: ['semanticscholar'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'With data from', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});

test('the hyphenated source spelling in enrichedBy is not Semantic Scholar enrichment', () => {
  assert.equal(sourceAttribution({ sources: { primary: 'arxiv', enrichedBy: ['semantic-scholar'] } }), null);
});

// ENG-109: an abstract recovered from Semantic Scholar or Crossref names its
// source (`abstractSource`), and the card says where the text it shows came from.
test('an abstract recovered from Semantic Scholar is credited as its abstract', () => {
  const paper = { id: 'openalex:W1', abstract: 'The abstract Semantic Scholar holds for this paper.', abstractSource: 'semanticscholar' as const, sources: { primary: 'openalex', enrichedBy: ['semanticscholar'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'Abstract:', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});

test('an abstract recovered from Crossref is credited to Crossref, without a link', () => {
  const paper = { id: 'openalex:W2', abstract: 'The abstract the publisher deposited with Crossref.', abstractSource: 'crossref' as const, sources: { primary: 'openalex', enrichedBy: ['crossref'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'Abstract:', name: 'Crossref' });
});

// Semantic Scholar's licence asks for its credit wherever its data shows; the
// card has one line, so other data of Semantic Scholar's outranks Crossref's text.
test("Semantic Scholar's other data keeps its credit beside an abstract from Crossref", () => {
  const paper = { id: 'openalex:W3', abstract: 'The abstract the publisher deposited with Crossref.', abstractSource: 'crossref' as const, sources: { primary: 'openalex', enrichedBy: ['crossref', 'semanticscholar'] } };
  assert.deepEqual(sourceAttribution(paper), { label: 'With data from', name: 'Semantic Scholar', href: SEMANTIC_SCHOLAR_HOME });
});
